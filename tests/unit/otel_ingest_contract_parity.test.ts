/**
 * STRUCTURAL PARITY for the OTLP span shape across the three places it lives.
 *
 * The shape sits on the UNTRUSTED-INPUT path, and it is mirrored:
 *
 *   1. `packages/contracts/src/otel.ts`      — CANONICAL. `OtelSpanInput`, plus
 *                                              `OTEL_SPAN_INPUT_FIELDS`, a
 *                                              compile-time-complete runtime
 *                                              list of its field names.
 *   2. `convex/otel_ingest.ts`               — `spanValidator`, the Convex
 *                                              argument validator that actually
 *                                              admits or refuses a wire span.
 *   3. `convex/helpers/otel_mapping.ts`      — `OtelSpanInput`, what the pure
 *                                              mapper reads.
 *
 * Copies 2 and 3 cannot import copy 1: `convex/package.json` depends only on
 * `convex`, deliberately, and every other Convex helper mirrors contracts the
 * same way. So the mirror is unavoidable. What is avoidable is the mirror being
 * unchecked.
 *
 * WHY DRIFT HERE IS WORSE THAN A COMPILE ERROR. If the validator has a field the
 * mapper does not read, we accept input we silently discard. If the mapper reads
 * a field the validator does not admit, Convex strips it before the handler runs
 * and the mapper reads `undefined` forever — with no error at any layer. Both
 * are silent, and both live on the path an untrusted caller controls.
 *
 * This file is the cross-boundary half that neither package can express alone.
 * It compares the CANONICAL RUNTIME LIST — not a regex over prose — against
 * field names extracted from the two Convex sources, IN BOTH DIRECTIONS. The
 * contracts side is exhaustive by construction (`otel.ts` fails to compile if a
 * field is missing from the array or invented in it), so a green run here means
 * all three agree, rather than meaning two regexes happened to match.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { OTEL_SPAN_INPUT_FIELDS, OTEL_SPAN_INPUT_REQUIRED_FIELDS } from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

function readRepoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
}

/** Extract a balanced `{ ... }` body starting at the first `{` after `marker`. */
function extractBlock(source: string, marker: string): string {
  const start = source.indexOf(marker)
  expect(start, `marker ${JSON.stringify(marker)} must exist`).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced block for ${marker}`)
}

/** Strip comments so a field name mentioned in prose is never mistaken for a declaration. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * Top-level `key:` names in a block, ignoring anything nested inside braces.
 *
 * Depth is evaluated BEFORE each line rather than after it, because a
 * multi-line value (`kind: v.optional(\n  v.union(...)\n)`) opens a bracket on
 * the very line that declares the key — measuring depth at end-of-line would
 * silently skip exactly those fields, which is the subtle way a parity test
 * passes while checking half of what it claims.
 */
function topLevelKeys(block: string): string[] {
  const keys: string[] = []
  let depth = 0
  for (const rawLine of stripComments(block).split('\n')) {
    if (depth === 0) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/.exec(rawLine)
      if (match) keys.push(match[1]!)
    }
    for (const char of rawLine) {
      if (char === '{' || char === '[' || char === '(') depth += 1
      else if (char === '}' || char === ']' || char === ')') depth -= 1
    }
  }
  return [...new Set(keys)]
}

const CANONICAL = [...OTEL_SPAN_INPUT_FIELDS].sort()

describe('OtelSpanInput parity — contracts <-> convex', () => {
  it('the canonical field list is non-trivial and matches its required subset', () => {
    // Guards against the whole suite passing vacuously if an extractor breaks.
    expect(CANONICAL.length).toBeGreaterThanOrEqual(10)
    for (const field of OTEL_SPAN_INPUT_REQUIRED_FIELDS) {
      expect(CANONICAL).toContain(field)
    }
  })

  it("convex/otel_ingest.ts spanValidator admits EXACTLY the canonical fields", () => {
    const source = readRepoFile('convex/otel_ingest.ts')
    const keys = topLevelKeys(extractBlock(source, 'const spanValidator = v.object(')).sort()

    // BOTH DIRECTIONS. A validator field with no contract field means we admit
    // input nothing describes; a contract field the validator omits means
    // Convex strips it before the handler runs and the mapper reads undefined
    // forever, with no error anywhere.
    expect(keys).toEqual(CANONICAL)
  })

  it("convex/helpers/otel_mapping.ts OtelSpanInput declares EXACTLY the canonical fields", () => {
    const source = readRepoFile('convex/helpers/otel_mapping.ts')
    const keys = topLevelKeys(extractBlock(source, 'export interface OtelSpanInput')).sort()
    expect(keys).toEqual(CANONICAL)
  })

  it('the required fields are the ones the validator declares non-optional', () => {
    const source = readRepoFile('convex/otel_ingest.ts')
    const block = stripComments(extractBlock(source, 'const spanValidator = v.object('))
    for (const field of CANONICAL) {
      const declared = new RegExp(`\\b${field}\\s*:\\s*v\\.optional\\(`).test(block)
      const shouldBeRequired = (OTEL_SPAN_INPUT_REQUIRED_FIELDS as readonly string[]).includes(field)
      expect(
        declared,
        `${field} should be ${shouldBeRequired ? 'REQUIRED' : 'OPTIONAL'} in spanValidator`,
      ).toBe(!shouldBeRequired)
    }
  })
})

describe('rejection-reason parity — contracts <-> mapper', () => {
  /**
   * `OtelSpanRejectionReason` is what a caller switches on to build an OTLP
   * partial-success response. A reason the mapper or the mutation can emit but
   * the contract does not name is a reason that reaches the wire as an
   * unhandled string, which is how a lost span passes for a recorded one.
   */
  it('every reason the convex side can emit is named in the contract union', () => {
    const contractSource = readRepoFile('packages/contracts/src/api.ts')
    const union = extractUnionMembers(contractSource, 'export type OtelSpanRejectionReason')

    const emitted = new Set<string>()
    for (const relative of ['convex/helpers/otel_mapping.ts', 'convex/otel_ingest.ts']) {
      const source = stripComments(readRepoFile(relative))
      // Scoped to `rejected.push({...})` bodies. A bare `reason:` search also
      // matches `OtelUnmappedReason` values inside classifySpan, which are a
      // DIFFERENT vocabulary — an unmapped span was recorded, a rejected one
      // was not, and the whole design depends on not conflating them.
      for (const match of source.matchAll(/rejected\.push\(\s*\{([\s\S]{0,400}?)\}\s*\)/g)) {
        for (const literal of match[1]!.matchAll(/"([a-z-]+)"/g)) emitted.add(literal[1]!)
      }
    }
    expect(emitted.size).toBeGreaterThan(0)
    for (const reason of emitted) {
      expect(union, `reason "${reason}" is emitted but not in OtelSpanRejectionReason`).toContain(reason)
    }
  })
})

function extractUnionMembers(source: string, marker: string): string[] {
  const start = source.indexOf(marker)
  expect(start, `marker ${JSON.stringify(marker)} must exist`).toBeGreaterThan(-1)
  const end = source.indexOf(';', start)
  const body = stripComments(source.slice(start, end))
  return [...body.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!)
}
