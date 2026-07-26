/**
 * DRIFT GATE between the web OTLP layer and `convex/`.
 *
 * Three hand-maintained mirrors cross this boundary, none of them checked by
 * the compiler:
 *
 *   1. `NormalizedSpan` (apps/web/src/lib/otel/types.ts) vs the `spanValidator`
 *      in `convex/otel_ingest.ts`. The route decodes into the first and the
 *      mutation validates against the second. A field added on one side only
 *      is either silently dropped (mapper reads it as absent and records a
 *      loss reason on an append-only event) or rejected wholesale by Convex's
 *      validator at runtime.
 *   2. The route's `MAX_SPANS_PER_TRACE_CALL` vs
 *      `MAX_OTEL_SPANS_PER_BATCH` (convex/helpers/pagination.ts). If the
 *      Convex value drops below ours, every large trace group becomes a
 *      `BATCH_TOO_LARGE` in production instead of a local rejection with an
 *      actionable message.
 *   3. The mutation's `args` keys vs what
 *      `apps/web/src/lib/services/otel_ingest.ts` forwards.
 *
 * Checked by READING THE CONVEX SOURCE rather than by type-importing it.
 * `convex/tsconfig.json` deliberately disables `exactOptionalPropertyTypes`,
 * so a type import would have to be registered in
 * `tests/tsconfig.convex-seam.json` — and this suite's whole job is to be a
 * gate that can be added without touching shared config. Source-text checking
 * catches exactly the failure mode that matters here (a field appearing or
 * disappearing on one side) and is what `scripts/check-convex-refs.ts` does
 * for the same class of seam.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { NormalizedSpan } from '@/lib/otel/types'

const REPO = join(__dirname, '..', '..')
const OTEL_INGEST_SRC = readFileSync(join(REPO, 'convex', 'otel_ingest.ts'), 'utf8')
const PAGINATION_SRC = readFileSync(join(REPO, 'convex', 'helpers', 'pagination.ts'), 'utf8')
const ROUTE_SRC = readFileSync(
  join(REPO, 'apps', 'web', 'app', 'api', 'v1', 'traces', 'route.ts'),
  'utf8',
)

/** Extract `name: v.…` keys from a named `v.object({ … })` block. */
function validatorKeys(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration)
  expect(start, `could not find \`${declaration}\` in convex source`).toBeGreaterThan(-1)

  // Walk braces from the declaration to find the object literal's extent, so a
  // nested `v.object({...})` (e.g. `status`) does not terminate the scan early.
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(open + 1, end)

  // Top-level keys only: track nesting and record `key:` at depth 0.
  const keys: string[] = []
  let nest = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (nest === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed)
      if (m !== null) keys.push(m[1]!)
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(') nest++
      else if (ch === '}' || ch === ')') nest--
    }
  }
  return [...new Set(keys)].sort()
}

/**
 * Every field of `NormalizedSpan`, restated as a runtime value.
 *
 * `Record<keyof NormalizedSpan, true>` makes this exhaustive at COMPILE time:
 * adding a field to the interface without adding it here does not typecheck.
 * The test below then compares it against the Convex validator's key set, so
 * one edit is required on each side or a gate fails.
 */
const NORMALIZED_SPAN_FIELDS: Record<keyof NormalizedSpan, true> = {
  traceId: true,
  spanId: true,
  parentSpanId: true,
  name: true,
  kind: true,
  startTimeUnixNano: true,
  endTimeUnixNano: true,
  attributes: true,
  status: true,
  scopeName: true,
  schemaUrl: true,
  spanEventCount: true,
  spanLinkCount: true,
}

describe('span shape: web decoder vs Convex validator', () => {
  it('declares exactly the same fields on both sides', () => {
    const convexKeys = validatorKeys(OTEL_INGEST_SRC, 'const spanValidator = v.object(')
    const webKeys = Object.keys(NORMALIZED_SPAN_FIELDS).sort()

    // Both directions matter. A field only Convex knows is one the decoder
    // never populates (data the mapper will record as lost); a field only the
    // web side knows is one Convex's validator REJECTS, failing the whole
    // batch at runtime with an error that names the validator, not the
    // decoder.
    expect(convexKeys).toEqual(webKeys)
  })
})

describe('mutation args: web forwarder vs Convex validator', () => {
  it('the mutation accepts exactly what the service sends', () => {
    const start = OTEL_INGEST_SRC.indexOf('export const otelIngestSpans = mutation(')
    expect(start).toBeGreaterThan(-1)
    const argsKeys = validatorKeys(OTEL_INGEST_SRC.slice(start), 'args: {')

    // Mirrors the forwarding literal in
    // apps/web/src/lib/services/otel_ingest.ts, and is asserted key-for-key by
    // tests/unit/otlp_route_ingest_params.test.ts. If Convex adds a required
    // arg, this fails here rather than at the first production request.
    expect(argsKeys).toEqual(['agentId', 'agentVersion', 'apiKeyHash', 'spans', 'traceId'])
  })
})

describe('batch ceiling: route mirror vs Convex constant', () => {
  it('the route never forwards a group larger than the mutation accepts', () => {
    const m = /export const MAX_OTEL_SPANS_PER_BATCH\s*=\s*([\d_]+)/.exec(PAGINATION_SRC)
    expect(m, 'MAX_OTEL_SPANS_PER_BATCH not found in convex/helpers/pagination.ts').not.toBeNull()
    const convexLimit = Number(m![1]!.replace(/_/g, ''))

    const r = /const MAX_SPANS_PER_TRACE_CALL\s*=\s*([\d_]+)/.exec(ROUTE_SRC)
    expect(r, 'MAX_SPANS_PER_TRACE_CALL not found in the route').not.toBeNull()
    const routeLimit = Number(r![1]!.replace(/_/g, ''))

    expect(routeLimit).toBe(convexLimit)
  })
})
