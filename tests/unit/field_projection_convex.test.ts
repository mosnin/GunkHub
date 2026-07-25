/**
 * CONTRACT-SURFACE test for `convex/read_api.ts`'s server-side field
 * projection (`fields`).
 *
 * The BEHAVIORAL tests live in `convex/read_api.test.ts`, where the real
 * Convex functions run under the convex-test harness. This file guards the
 * things that harness cannot see, because they are properties of the API
 * SURFACE rather than of any one call:
 *
 *   1. WHICH functions accept `fields`. Three other teams (web, sdk, mcp)
 *      build against a fixed set. A refactor that quietly drops the arg from
 *      one endpoint would not fail a behavioral test for the others, and the
 *      symptom in production is the worst one this contract exists to
 *      prevent: an accept-and-ignore server, which returns a full document to
 *      a caller who asked for four fields and looks, from the outside, like a
 *      server that simply has a lot of data.
 *
 *   2. That the arg is declared with the AGREED validator
 *      (`v.optional(v.array(v.string()))`) on every one of them — not, say,
 *      `v.array(v.string())` (which would make it required and break every
 *      existing caller) or a union of literals (which would move field-name
 *      validation into Convex's arg validator, where it produces a DIFFERENT,
 *      non-`INVALID_ARGUMENT` error message and, worse, one that this file's
 *      sibling tenancy tests do not cover).
 *
 *   3. That the endpoints deliberately EXCLUDED from projection stay
 *      excluded, so adding `fields` to one is a conscious act with a contract
 *      update rather than a drive-by.
 *
 * These are source-level assertions on purpose: the failure mode being
 * guarded is "the declaration disappeared", which is invisible to any test
 * that calls the function with `fields` omitted — i.e. to every pre-existing
 * test in the repo.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const READ_API_PATH = path.resolve(__dirname, '../../convex/read_api.ts')
const SOURCE = readFileSync(READ_API_PATH, 'utf8')

/** Extracts the `args: { ... }` block of an exported mutation by name. */
function argsBlockOf(fnName: string): string {
  const start = SOURCE.indexOf(`export const ${fnName} = mutation({`)
  expect(start, `${fnName} not found in convex/read_api.ts`).toBeGreaterThan(-1)
  const handlerAt = SOURCE.indexOf('handler:', start)
  expect(handlerAt, `${fnName} has no handler`).toBeGreaterThan(start)
  return SOURCE.slice(start, handlerAt)
}

/** Every document-returning read that MUST accept `fields`, with the resource it projects. */
const PROJECTING = [
  ['apiListRuns', 'runs'],
  ['apiGetRun', 'runs'],
  ['apiGetRunEvents', 'events'],
  ['apiListFailurePatterns', 'failure_patterns'],
  ['apiGetFailurePatternEvidence', 'failure_patterns'],
] as const

/**
 * Reads this surface owns that deliberately do NOT take `fields`, and why.
 * Listed explicitly so the exclusion is a decision on the record.
 */
const NOT_PROJECTING = [
  // Returns a computed replay projection (contracts' ReplayProjection), not
  // stored documents. There is no table whose field set could be validated
  // against, so `fields` would have no meaning here.
  'apiGetReplay',
  // Returns a `run_explanations` document. Excluded because it would
  // introduce a FOURTH resource vocabulary (its own valid-field set and its
  // own identity field) that no consumer has been specified against; the
  // agreed contract enumerates identity fields for runs, events and failure
  // patterns only. Adding it is a contract change, not an implementation
  // detail.
  'apiGetExplanation',
] as const

describe('convex/read_api.ts — field projection contract surface', () => {
  it.each(PROJECTING)('%s declares `fields` with the agreed optional-string-array validator', (fnName) => {
    const args = argsBlockOf(fnName)
    // FIELDS_ARG is the single shared declaration; requiring it by name (rather
    // than matching the validator expression) is what makes a divergent
    // per-endpoint validator impossible.
    expect(args).toMatch(/fields:\s*FIELDS_ARG/)
  })

  it('FIELDS_ARG is exactly `v.optional(v.array(v.string()))`', () => {
    // Optional => omitting it is legal => every pre-existing caller is
    // unaffected. Array-of-string (not a literal union) => an unknown field is
    // rejected by THIS module's INVALID_ARGUMENT path, with the message the
    // tenancy tests pin, rather than by Convex's arg validator.
    expect(SOURCE).toMatch(/const FIELDS_ARG = v\.optional\(v\.array\(v\.string\(\)\)\);/)
  })

  it.each(NOT_PROJECTING)('%s deliberately does NOT declare `fields`', (fnName) => {
    expect(argsBlockOf(fnName)).not.toMatch(/fields:/)
  })

  it('the identity field is pinned per resource and none of them is optional', () => {
    // `_id` for runs, `sequenceNumber` for events (an event is addressed by
    // its position in its run — Event Log Rule 4), `fingerprintHash` for
    // failure patterns (the key every pattern-scoped endpoint here takes).
    expect(SOURCE).toMatch(
      /const IDENTITY_FIELD: Record<ProjectableTable, string> = \{\s*runs: "_id",\s*events: "sequenceNumber",\s*failure_patterns: "fingerprintHash",\s*\}/,
    )
  })

  it('the valid-field set is DERIVED from the schema, never hand-listed', () => {
    // A hand-maintained list drifts the first time a column is added, and a
    // projection that rejects a field the table really has is, to the caller,
    // indistinguishable from a field that does not exist.
    expect(SOURCE).toMatch(/Object\.keys\(schema\.tables\[table\]\.validator\.fields\)/)
    expect(SOURCE).toMatch(/from "\.\/schema\.js"/)
  })

  it('the unknown-field error uses the agreed INVALID_ARGUMENT wording', () => {
    expect(SOURCE).toContain(
      'INVALID_ARGUMENT: unknown field "${name}" for ${table}; valid fields are: ${valid.join(", ")}',
    )
  })

  it('an empty `fields` array is rejected, not treated as "return nothing"', () => {
    expect(SOURCE).toMatch(/if \(fields\.length === 0\) \{\s*throw new Error\(/)
    expect(SOURCE).toContain('INVALID_ARGUMENT: fields must not be empty for ${table}')
  })

  it('every projecting handler validates `fields` BEFORE its first database read', () => {
    // The tenancy rule the whole ordering exists for: an unknown-field error
    // must be identical whether the referenced record is in the caller's org,
    // absent, or another org's. That holds only if validation happens before
    // any `ctx.db` access — otherwise the error is reachable only for records
    // that exist in the caller's org, which is an existence oracle.
    for (const [fnName] of PROJECTING) {
      const start = SOURCE.indexOf(`export const ${fnName} = mutation({`)
      const next = SOURCE.indexOf('export const ', start + 1)
      const body = SOURCE.slice(start, next === -1 ? SOURCE.length : next)

      const validateAt = body.indexOf('validateFieldSelection(')
      const firstDbReadAt = body.search(/ctx\.db\./)
      expect(validateAt, `${fnName} never calls validateFieldSelection`).toBeGreaterThan(-1)
      expect(firstDbReadAt, `${fnName} performs no database read?`).toBeGreaterThan(-1)
      expect(
        validateAt,
        `${fnName} validates \`fields\` AFTER touching the database — that makes the unknown-field error a cross-org existence oracle`,
      ).toBeLessThan(firstDbReadAt)
    }
  })

  it('projection is the LAST thing applied, so it cannot change which records return', () => {
    // `projectDoc`/`projectDocs` appear only in `return` position (or in each
    // other's definition), never wrapped around a value that is later
    // filtered, counted, or used to compute the response envelope.
    const callSites = SOURCE.split('\n')
      .map((line, i) => [line, i] as const)
      .filter(([line]) => /projectDocs?\(/.test(line))
      .filter(([line]) => !/^(function|\s*\*|\/\/|\s*if \(selection|\s*return docs\.map|\s*const projected)/.test(line))

    expect(callSites.length).toBeGreaterThanOrEqual(PROJECTING.length)
    for (const [line, i] of callSites) {
      expect(
        /return|:\s*project(Doc|Docs)\(/.test(line),
        `convex/read_api.ts:${i + 1} applies projection outside a return value: ${line.trim()}`,
      ).toBe(true)
    }
  })
})
