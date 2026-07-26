/**
 * CONTRACT-SURFACE test for `apiListFailurePatterns`' filter/pagination
 * ordering (convex/read_api.ts).
 *
 * The BEHAVIORAL tests live in `convex/read_api.test.ts`, where the real
 * mutation runs under the convex-test harness and is fed data whose matches
 * sit past the first scan window. This file guards the STRUCTURE those tests
 * depend on, because the defect being prevented has a uniquely bad property:
 *
 *   FILTERING AN ALREADY-PAGINATED PAGE PRODUCES A WELL-FORMED RESPONSE.
 *
 * `.paginate({ numItems: limit })` followed by `page.page.filter(...)` returns
 * a valid, correctly-typed, correctly-cursored, EMPTY page whenever the first
 * `limit` rows happen not to match. No error, no warning, no type change. It
 * shipped that way for `--spiking` and `--muted` and went unnoticed for weeks,
 * and it is the same shape as the bug the `state` filter would have inherited
 * — where it matters most, because `afr patterns --state regressed` is a CI
 * gate. A gate that answers "all clear" because it only looked at the first
 * page turns a red build green, which is strictly worse than having no gate.
 *
 * Source-level assertions are the right tool here specifically because the
 * regression is INVISIBLE to any test that seeds fewer rows than a page. Every
 * pre-existing test in this repo seeds two or three patterns; all of them pass
 * against the broken implementation. So this file pins the shape, and
 * `convex/read_api.test.ts` pins the behavior, and neither alone is enough.
 *
 * Sibling reads on this surface (`apiListRuns`, `apiGetRunEvents`) are asserted
 * NOT to have the defect for the reason recorded below — their secondary
 * filters are `q.filter()` predicates that Convex applies DURING pagination, so
 * `numItems` already counts matches. That distinction is easy to lose in a
 * refactor, which is why it is written down as a test rather than a comment.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const READ_API_PATH = path.resolve(__dirname, '../../convex/read_api.ts')
const RAW_SOURCE = readFileSync(READ_API_PATH, 'utf8')

/**
 * Comments stripped. Every assertion in this file is about CODE, and
 * `convex/read_api.ts` is a heavily commented module whose comments quote the
 * very constructs being asserted against — the header above
 * `apiListFailurePatterns` spells out `.paginate({ numItems: limit })` and
 * `page.page.filter(...)` precisely to explain why they are wrong. Matching
 * the raw text would fail on the explanation of the bug rather than on the
 * bug, which is the least useful red test imaginable. (The file contains no
 * string literal with a `//` in it, so the naive strip is exact here.)
 */
const SOURCE = RAW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * The code of one exported mutation, from its declaration to the next
 * top-level `export const`. Note that the comment block preceding a function
 * belongs, by this slicing, to the function BEFORE it — another reason the
 * comment strip above is load-bearing rather than cosmetic.
 */
function bodyOf(fnName: string): string {
  const start = SOURCE.indexOf(`export const ${fnName} = mutation({`)
  expect(start, `${fnName} not found in convex/read_api.ts`).toBeGreaterThan(-1)
  const next = SOURCE.indexOf('\nexport const ', start + 1)
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next)
}

describe('apiListFailurePatterns — filters must not run over an already-paginated page', () => {
  const body = bodyOf('apiListFailurePatterns')

  it('paginates exactly once (Convex permits one .paginate() per execution)', () => {
    // Not a style rule — a runtime limit. "Only a single paginated query is
    // allowed per function execution" is enforced by the deployed backend and
    // by convex-test alike, so the obvious "loop until `limit` matches" fix
    // does not run at all. The bounded single-window read is the shape that
    // works; a second .paginate() here means someone rewrote it into something
    // that throws on the first filtered request in production.
    const paginateCalls = body.match(/\.paginate\(/g) ?? []
    expect(paginateCalls).toHaveLength(1)
  })

  it('sizes the scan window by matches needed, never by `limit` alone', () => {
    // `numItems: limit` IS the bug: it makes the database stop counting after
    // `limit` ROWS, which the in-memory filters below are then free to reduce
    // to zero.
    expect(body).toMatch(/numItems:\s*scanSize/)
    expect(body).not.toMatch(/numItems:\s*limit\b/)
    // ...and `scanSize` must actually widen when a filter is active. Pinning
    // only the variable NAME would let the defect return under a friendlier
    // spelling (`const scanSize = needed`), which is exactly what a naive
    // revert produces — verified by reintroducing it and watching this
    // assertion be the one that stayed green until it was added.
    expect(body).toMatch(/const scanSize = filtering \? PATTERN_SCAN_ROW_CEILING : needed;/)
    // And `filtering` must be derived from the arguments, not pinned to a
    // constant that would collapse the widening back to `limit`.
    expect(body).toMatch(/const filtering =[\s\S]{0,400}?args\.state !== undefined;/)
  })

  it('the scan window is bounded by an explicit numeric ceiling', () => {
    // "Read until you find something" is the other way to get this wrong: it
    // turns one request against a large org with a selective filter into a
    // full-table read.
    expect(SOURCE).toMatch(/const PATTERN_SCAN_ROW_CEILING = [\d_]+;/)
    expect(body).toContain('PATTERN_SCAN_ROW_CEILING')
  })

  it('never filters the paginated page in place', () => {
    // The literal shape of the original defect, in all its spellings.
    expect(body).not.toMatch(/page\.page\.filter\(/)
    expect(body).not.toMatch(/window\.page\.filter\(/)
    expect(body).not.toMatch(/patterns\s*=\s*patterns\.filter\(/)
  })

  it('reports a ceiling stop instead of hiding it behind a short page', () => {
    // A capped scan that does not say so is the original bug wearing a
    // different hat: the caller cannot tell "nothing matched" from "I stopped
    // looking". Same contract as `exposure.runCountTruncated`.
    expect(body).toMatch(/scanTruncated,/)
    // Derived, not a hardcoded reassurance.
    expect(body).toMatch(/const scanTruncated = !exhausted && matches\.length < needed;/)
  })

  it('a truncated or partially-consumed window always hands back a resumable cursor', () => {
    // Composite `{ underlyingCursor, skip }`, because surplus matches can sit
    // INSIDE the consumed window and a raw Convex cursor can only resume past
    // the whole of it — which would drop them.
    expect(body).toContain('encodePatternScanCursor(')
    expect(SOURCE).toMatch(/interface PatternScanCursor \{\s*underlyingCursor: string \| null;\s*skip: number;\s*\}/)
    // A legacy raw cursor must still resume rather than throw.
    expect(SOURCE).toMatch(/function decodePatternScanCursor/)
    expect(SOURCE).toMatch(/return \{ underlyingCursor: cursor, skip: 0 \};/)
  })

  it('the confidence envelope describes the RETURNED page, not the whole scan window', () => {
    // `entries` is documented as "one entry per RETURNED pattern, in the same
    // order". Computing it from the pre-window match list would silently
    // misalign it with `patterns` — an off-by-page join that renders one
    // pattern's verdict against another's row.
    expect(body).toMatch(/entries: windowed\.map\(/)
    expect(body).toMatch(/staleCount: windowed\.filter\(/)
    expect(body).toMatch(/patterns: projectDocs\(windowed, selection\)/)
  })
})

describe('sibling reads on this surface — which ones were already correct, and why', () => {
  /**
   * `apiListRuns` narrows by `status`/`environment` using `q.filter()`
   * predicates chained onto the query BEFORE `.paginate()`. Convex applies
   * those during pagination, so `numItems` counts rows that already satisfied
   * them: a request for 25 gets 25 matches if 25 exist anywhere down the
   * cursor, and an empty page genuinely means nothing matched. This was never
   * the bug, and the fix must not "helpfully" convert it into a scan.
   */
  it('apiListRuns filters inside the query, not over the finished page', () => {
    const body = bodyOf('apiListRuns')
    expect(body).toMatch(/\.filter\(\(q\) =>/)
    expect(body).not.toMatch(/page\.page\.filter\(/)
    // The chained predicates are built, THEN paginated — order is the whole point.
    expect(body.indexOf('const filtered = runsQuery')).toBeLessThan(body.indexOf('.paginate('))
  })

  /**
   * `apiGetRunEvents` has no post-pagination filter at all: its `fromSequence`
   * window is a RANGE on the `by_run: ["runId", "sequenceNumber"]` index, so
   * the floor is applied by the index itself and every row the page returns is
   * in-window by construction.
   */
  it('apiGetRunEvents applies its window as an index range, so there is nothing to filter after', () => {
    const body = bodyOf('apiGetRunEvents')
    expect(body).toMatch(/gte\("sequenceNumber", fromSequence\)/)
    expect(body).not.toMatch(/page\.page\.filter\(/)
  })

  /**
   * The remaining reads are single-record or whole-projection lookups with no
   * pagination, so the ordering defect cannot arise. Listed by name so that a
   * future read added to this file is a deliberate addition here too.
   */
  it('no other read on this surface paginates at all', () => {
    const paginating = [
      'apiListRuns',
      'apiGetRunEvents',
      'apiListFailurePatterns',
      // ADR-008 divergence reads. Both paginate and both are ordering-safe:
      //  - apiGetRunDivergence filters by event `type` INSIDE the query
      //    (`.filter(...).paginate(...)`), the same shape as apiListRuns, so
      //    Convex applies the predicate during pagination rather than to a
      //    finished page.
      //  - apiGetFleetDivergence paginates `runs` by
      //    `by_agent_version_started` with no query-level filter. It does carry
      //    a post-page `run.orgId !== apiKey.orgId` guard, which LOOKS like the
      //    defect this file exists to catch, but cannot shorten a page: the
      //    index is keyed on `agentVersionId`, and that version's org was
      //    already verified against the key before the scan, so every row is
      //    necessarily same-org. The guard is defense in depth, not a filter.
      'apiGetRunDivergence',
      'apiGetFleetDivergence',
    ]
    const nonPaginating = [
      'apiGetRun',
      'apiGetReplay',
      'apiGetExplanation',
      'apiGetFailurePatternEvidence',
      // Reads no runs and no events at all — that is the point of the tier.
      'apiCompareVersionConfigs',
    ]
    for (const fnName of nonPaginating) {
      expect(bodyOf(fnName), `${fnName} now paginates — it needs the same ordering audit`).not.toContain(
        '.paginate(',
      )
    }
    // Every exported mutation in the file is accounted for by one list or the
    // other, so a newly added read cannot slip past this audit unnoticed.
    const exported = [...SOURCE.matchAll(/export const (\w+) = mutation\(\{/g)].map((m) => m[1])
    expect(exported.sort()).toEqual([...paginating, ...nonPaginating].sort())
  })
})
