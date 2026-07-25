/**
 * THE HONESTY OF THE HOPS `afr_triage` HANDS OUT.
 *
 * `afr_triage` is the entry point, and for any pattern without a live
 * resolution its `next` is `afr_explain_run(runId)`. That makes tier 3 the
 * DEFAULT SECOND CALL for a cold agent — so a misleading answer there is now on
 * the default path, not in a corner someone reaches deliberately.
 *
 * THE DEFECT THIS FILE PINS. `afr_explain_run` returns a raw server
 * discriminant `status: 'not_eligible' | 'pending' | 'ready'`, and
 * `not_eligible` is TRUE-BUT-MISLEADING for a run that is still in flight. The
 * server means "not eligible right now"; the word reads as "not eligible ever".
 * An agent that reads it the second way concludes "nothing to see here" about a
 * run that is actively failing and will have an explanation in thirty seconds.
 *
 * The signal that distinguishes them — `runStatus` — was already on the
 * response, but requiring every caller to cross-reference two fields to avoid a
 * wrong conclusion is a defect, not an interface. `availability` is the derived
 * three-way answer, and these tests are what stop it regressing back into a
 * two-field puzzle.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE: the WIRE vocabulary is not widened.
 * `status` is validated against a hard-coded `not_eligible|pending|ready` in
 * both `packages/mcp/src/tools/explain-run.ts` and
 * `apps/web/src/lib/services/explanations.ts`, and both SILENTLY DOWNGRADE an
 * unrecognised value to `pending` — so a new server-side status would reach an
 * agent as `pending`, the exact un-actionable answer it would exist to remove.
 * `tests/unit/explanation_coverage.test.ts` pins that coupling on purpose.
 * Everything below is a client-side derivation over the two fields the server
 * already sends.
 */
import { describe, expect, it } from 'vitest'

import type { RunExplanation } from '@agent-flight-recorder/contracts'

// See the module-seam note in `mcp_triage.test.ts`.
const PROJECTIONS_SPEC = '../../packages/mcp/src/projections.ts'

type Availability = 'available' | 'not_yet' | 'never' | 'unknown'

interface ListPatternsResult {
  fields: string[]
  rows: unknown[][]
  nextCursor?: string
  scanTruncated?: true
}

interface ProjectionsModule {
  toListPatternsResult(
    patterns: unknown[],
    envelope: unknown,
    nextCursor: string | undefined,
    scan?: { scanTruncated?: boolean }
  ): ListPatternsResult
  deriveAvailability(status: 'not_eligible' | 'pending' | 'ready', runStatus: string | undefined): Availability
  toExplainRunResult(
    runId: string,
    status: 'not_eligible' | 'pending' | 'ready',
    explanation: RunExplanation | null,
    runStatus: string | undefined
  ): Record<string, unknown>
}

const projections = (await import(/* @vite-ignore */ PROJECTIONS_SPEC)) as ProjectionsModule

const READY_EXPLANATION: RunExplanation = {
  runId: 'run_1',
  summary: 'The agent called the search tool and the provider returned 429.',
  rootCause: 'Upstream rate limit with no backoff.',
  suggestedFix: 'Add exponential backoff with jitter.',
  failureClass: 'http_error',
  kind: 'heuristic',
  citedSequenceNumbers: [12, 13],
} as unknown as RunExplanation

describe('explanation availability — “never” vs “not yet”', () => {
  it('does NOT say never for a run that is still in flight', () => {
    // The whole defect. A running run reports not_eligible today and may fail
    // and get an explanation moments later.
    expect(projections.deriveAvailability('not_eligible', 'running')).toBe('not_yet')
    expect(projections.deriveAvailability('not_eligible', 'pending')).toBe('not_yet')
  })

  it('says never only for a run that finished WITHOUT failing', () => {
    expect(projections.deriveAvailability('not_eligible', 'completed')).toBe('never')
    expect(projections.deriveAvailability('not_eligible', 'cancelled')).toBe('never')
    expect(projections.deriveAvailability('not_eligible', 'timed_out')).toBe('never')
  })

  it('says unknown rather than guessing when runStatus was not served', () => {
    // An older deployment. Guessing 'never' here would tell a caller to stop
    // looking at something that may be broken — the more costly of the two
    // possible mistakes, so it is not made.
    expect(projections.deriveAvailability('not_eligible', undefined)).toBe('unknown')
  })

  it('says unknown when the two signals contradict each other', () => {
    // not_eligible on a run that DID fail. Neither answer is defensible.
    expect(projections.deriveAvailability('not_eligible', 'failed')).toBe('unknown')
  })

  it('treats pending as a bounded latency claim, not a permanent state', () => {
    expect(projections.deriveAvailability('pending', 'failed')).toBe('not_yet')
  })

  it('is emitted on every non-ready response, so no caller has to cross-reference two fields', () => {
    for (const runStatus of ['running', 'completed', 'failed', undefined]) {
      const result = projections.toExplainRunResult('run_1', 'not_eligible', null, runStatus)
      expect(result['availability'], `missing availability for runStatus=${String(runStatus)}`).toBeDefined()
    }
    expect(projections.toExplainRunResult('run_1', 'pending', null, 'failed')['availability']).toBe('not_yet')
  })

  it('is omitted on a ready response — the tier’s most expensive case pays nothing for it', () => {
    // A ready explanation is trivially available and the prose is right there.
    // Tier 3's contract-maximal budget is measured on exactly this case, so a
    // field with no information content must not land on it.
    const result = projections.toExplainRunResult('run_1', 'ready', READY_EXPLANATION, 'failed')
    expect(result['availability']).toBeUndefined()
    expect(result['status']).toBe('ready')
  })

  it('leaves the wire status untouched — the fix is a derivation, not a vocabulary change', () => {
    const result = projections.toExplainRunResult('run_1', 'not_eligible', null, 'running')
    expect(result['status']).toBe('not_eligible')
    expect(result['runStatus']).toBe('running')
    expect(result['availability']).toBe('not_yet')
  })

  it('surfaces kind, so a caller knows whether it is reading a derived or an analysed summary', () => {
    const result = projections.toExplainRunResult('run_1', 'ready', READY_EXPLANATION, 'failed')
    expect(result['kind']).toBe('heuristic')
  })
})

// ---------------------------------------------------------------------------
// Tier 1's truncation marker — the hop `afr_triage` forwards a caller to
// ---------------------------------------------------------------------------

/**
 * When triage's scan is truncated its own top-level `next` sends the caller to
 * `afr_list_failure_patterns`. So tier 1 is the tool that must NOT then hand
 * back a reassuring empty page.
 *
 * Convex computes `scanTruncated`, the v1 route forwards it, the SDK types it —
 * and tier 1's projection used to drop it at the last hop. A MARKER NOBODY
 * READS IS THE SAME AS NO MARKER, and the consequence lands on an agent: it
 * sees a short or empty list and concludes the system is healthy. That is the
 * reassuring-empty-state failure already removed from the dashboard, the
 * service layer and the CLI.
 */
const PATTERN = {
  id: 'fp_1',
  orgId: 'org_caller',
  fingerprintHash: '01f3a9c1d4e7b2',
  class: 'tool_error',
  label: 'Tool call failed',
  salientKey: 'search',
  count: 128,
  firstSeenAt: 1_750_000_000_000,
  lastSeenAt: 1_753_400_000_000,
  representativeRunIds: [],
  affectedAgentVersionIds: [],
  status: 'open',
}

describe('afr_list_failure_patterns truncation marker', () => {
  it('surfaces scanTruncated so an empty page is not read as "nothing is broken"', () => {
    const result = projections.toListPatternsResult([], undefined, undefined, { scanTruncated: true })
    expect(result.rows).toHaveLength(0)
    expect(result.scanTruncated).toBe(true)
  })

  it('omits it on a complete scan, so the common case costs zero bytes', () => {
    const result = projections.toListPatternsResult([PATTERN], undefined, undefined, { scanTruncated: false })
    expect(result.scanTruncated).toBeUndefined()
  })

  it('treats an undeclared marker as complete — one decision, made in the SDK', () => {
    // An older deployment never declares truncation. `isPatternScanComplete`
    // is the single place that decides what absence means; this projection
    // calls it rather than guessing a third time.
    expect(projections.toListPatternsResult([PATTERN], undefined, undefined, {}).scanTruncated).toBeUndefined()
    expect(projections.toListPatternsResult([PATTERN], undefined, undefined).scanTruncated).toBeUndefined()
  })

  it('costs a handful of tokens against tier 1’s tight 300-token budget', () => {
    // Tier 1 is the tightest budget in the package (measured 284 / 300), so
    // this is measured rather than assumed.
    const page = Array.from({ length: 10 }, (_, i) => ({ ...PATTERN, fingerprintHash: `0${String(i)}f3a9c1d4e7b2` }))
    const tok = (v: unknown): number => Math.ceil(Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8') / 4)
    const complete = tok(projections.toListPatternsResult(page, undefined, undefined, { scanTruncated: false }))
    const truncated = tok(projections.toListPatternsResult(page, undefined, undefined, { scanTruncated: true }))
    // eslint-disable-next-line no-console
    console.log(`\n  tier 1 with marker: ${String(complete)} tok complete -> ${String(truncated)} tok truncated (+${String(truncated - complete)})`)
    expect(truncated - complete).toBeLessThanOrEqual(8)
    expect(truncated).toBeLessThanOrEqual(300)
  })
})
