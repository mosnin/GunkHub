/**
 * `afr_triage` — BUDGET, RANKING, POINTER AND HONESTY GUARDS.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `afr_triage` is the MCP surface's entry point: one call, no required
 * arguments, "what is wrong right now and what should I look at first?". It
 * only earns that position if four properties hold, and NOT ONE OF THEM is
 * protected by the type system:
 *
 * 1. IT IS CHEAPER THAN DOING IT YOURSELF. Tier 1 + tier 2 is ~707 tokens. If
 *    triage cost more than that it would be a fifth tier pretending to be a
 *    shortcut. The budget is tier 2's, 450 tokens, and it is asserted here
 *    against contract-maximal input rather than hoped for. A future
 *    "just also return the resolution note, it's one field" is a one-line
 *    change that type-checks, passes every other test, and destroys the reason
 *    the tool exists.
 *
 * 2. EVERY ITEM CARRIES AN EXECUTABLE NEXT HOP. `next` must name a real tool
 *    and arguments that tool actually accepts. A pointer to a misspelled tool
 *    is worse than no pointer: an agent will call it and get an error it
 *    cannot attribute.
 *
 * 3. THE RANKING IS THE DOCUMENTED ONE. Specifically the tiering property:
 *    recency and volume order WITHIN a signal class and can never promote an
 *    item across one. That is what makes the ordering explainable in one
 *    sentence, and it holds only while the tie-breakers stay under the
 *    signal-weight gap — an invariant no type can express.
 *
 * 4. EMPTY AND UNEVALUATED ARE DIFFERENT ANSWERS. `verdict: 'clear'` must be
 *    unreachable whenever anything prevented a whole look. This repo has
 *    shipped "nothing is broken" when it meant "I could not evaluate" before.
 *
 * TOKEN ESTIMATE — STATED ASSUMPTION
 * ----------------------------------
 * `estimateTokens(x) = ceil(utf8ByteLength(JSON.stringify(x)) / 4)` — the same
 * estimator and the same fat-input discipline as
 * `tests/unit/mcp_progressive_disclosure.test.ts`, so the numbers here are
 * comparable to the tier budgets published there. It matches what the server
 * actually emits: `tools/shared.ts` serializes with no indentation, so these
 * are the bytes a caller pays for.
 */
import { describe, expect, it } from 'vitest'

import type { FailurePattern } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Module seam
// ---------------------------------------------------------------------------

/**
 * `packages/mcp` is not a workspace dependency of `@agent-flight-recorder/tests`
 * and has no alias in tests/vitest.config.ts, so a bare-specifier import is
 * unresolvable from here. A NON-LITERAL relative specifier is opaque to both
 * TypeScript's resolver and vite's static analysis, which lets this suite bind
 * to the real module without editing files this team does not own. Same seam,
 * and the same follow-up, as `mcp_progressive_disclosure.test.ts`.
 */
const TRIAGE_SPEC = '../../packages/mcp/src/triage.ts'

type TriageSignal = 'regressed' | 'spiking' | 'open' | 'acknowledged' | 'resolved'

interface TriagePointer {
  tool: string
  args: Record<string, string | number>
}

interface TriageItem {
  fingerprintHash: string
  class: string
  label: string
  count: number
  lastSeenAt: number
  signal: TriageSignal
  score: number
  muted?: true
  next: TriagePointer
}

interface TriageResult {
  verdict: 'issues' | 'clear' | 'unknown'
  complete: boolean
  scanned: number
  items: TriageItem[]
  caveats?: string[]
  unevaluated?: { count: number; sample: string[] }
  scanTruncated?: true
  next?: TriagePointer
}

interface TriageModule {
  toTriageResult(
    patterns: FailurePattern[],
    envelope: unknown,
    nextCursor: string | undefined,
    now: number,
    scan?: { scanTruncated?: boolean }
  ): TriageResult
  classifySignal(pattern: FailurePattern, confidence?: unknown): TriageSignal
  scorePattern(pattern: FailurePattern, signal: TriageSignal, now: number): number
  choosePointer(pattern: FailurePattern, signal: TriageSignal): TriagePointer
  SIGNAL_WEIGHT: Record<TriageSignal, number>
  MAX_TIEBREAK: number
  MAX_ITEMS: number
  SCAN_LIMIT: number
  LABEL_BYTE_CAP: number
  MUTE_DEMOTION: number
  TRIAGE_REQUEST_FIELDS: readonly string[]
  TRIAGE_FIELDS: readonly string[]
}

const triage = (await import(/* @vite-ignore */ TRIAGE_SPEC)) as TriageModule

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 4)
}

/**
 * Per-key byte attribution across the emitted items, biggest first.
 *
 * A budget test whose failure message is "expected 512 to be <= 450" gets
 * deleted the first time it goes red. This one says which field to cut.
 */
function attribute(items: readonly Record<string, unknown>[]): string {
  const totals = new Map<string, number>()
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      const cost =
        Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8') + 1
      totals.set(key, (totals.get(key) ?? 0) + cost)
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, b]) => `    ${k.padEnd(18)} ${String(b).padStart(6)} B  (~${String(Math.ceil(b / 4))} tok)`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Tier 2's budget, and the ceiling triage must live under.
 *
 * DERIVED, and the derivation is the argument for the tool's existence: an
 * agent can already get "what is broken" plus "did the fix hold" by calling
 * tier 1 (~284) and tier 2 (~423) itself, for ~707. A shortcut that costs more
 * than the thing it shortcuts is not a shortcut. 450 is the stricter of the
 * two available lines — at or under the single most expensive tier it replaces
 * a call to.
 */
const TIER1_MEASURED = 284
const TIER2_MEASURED = 423
const TRIAGE_TOKEN_BUDGET = 450

/** What triage exists to be cheaper than. */
const DIY_TOKENS = TIER1_MEASURED + TIER2_MEASURED

const NOW = 1_753_500_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ---------------------------------------------------------------------------
// FAT inputs — every field the contract permits, so the projection is proven
// ---------------------------------------------------------------------------

const LABELS = [
  'Tool call failed',
  'LLM request timed out',
  'HTTP 429 from provider',
  'Retrieval returned no documents',
  'Tool "search" returned malformed JSON',
  'Model refused: content policy',
  'Context length exceeded',
  'Rate limited by upstream API',
  'Unhandled exception in agent loop',
  'Timed out waiting for tool result',
]
const CLASSES = ['tool_error', 'timeout', 'http_error', 'retrieval_error', 'llm_error']

/**
 * A MAXIMAL `FailurePattern` — every optional field populated, including the
 * bounded-but-large arrays and the nested spike assessment and confidence
 * snapshot. Serialized whole, one of these is ~1.5 KB; a triage item must be a
 * few dozen tokens. That gap is what is under test.
 */
/**
 * Overrides must permit an EXPLICIT `undefined` per key: under
 * `exactOptionalPropertyTypes` a `Partial<T>` rejects `{ lastSpikeAssessment:
 * undefined }`, and "this optional field is absent" is exactly what several
 * cases below need to say about a maximal fixture.
 */
type PatternOverrides = { [K in keyof FailurePattern]?: FailurePattern[K] | undefined }

function fatPattern(i: number, overrides: PatternOverrides = {}): FailurePattern {
  return {
    id: `fp_${String(i)}`,
    orgId: 'org_caller',
    fingerprintHash: String(i + 1).padStart(2, '0') + 'f3a9c1d4e7b2',
    class: CLASSES[i % CLASSES.length]!,
    label: LABELS[i % LABELS.length]!,
    salientKey: 'search',
    count: [128, 41, 7, 220, 3, 19, 66, 12, 5, 88][i % 10]!,
    firstSeenAt: NOW - 30 * DAY,
    lastSeenAt: NOW - (i % 7) * HOUR,
    representativeRunIds: [`run_${String(i)}a`, `run_${String(i)}b`, `run_${String(i)}c`, `run_${String(i)}d`, `run_${String(i)}e`],
    affectedAgentVersionIds: Array.from({ length: 20 }, (_, v) => `ver_${String(i)}_${String(v)}`),
    affectedAgentIds: ['agent_a1', 'agent_b2'],
    lastSpikeAssessment: { assessedAt: NOW - HOUR, isSpiking: i % 2 === 0, recentCount: 44, baselineMean: 6.25, z: 4.81 },
    lastPatternSpikeAlertFiredAt: NOW - 2 * HOUR,
    muted: false,
    mutedAt: NOW - 10 * DAY,
    status: (['open', 'acknowledged', 'resolved'] as const)[i % 3]!,
    acknowledgedAt: NOW - 5 * DAY,
    acknowledgedByUserId: 'user_2f9',
    resolvedAt: NOW - 4 * DAY,
    resolvedByUserId: 'user_2f9',
    resolutionNote:
      'Added retry with jitter on 429 from the provider, plus a circuit breaker after five consecutive failures.',
    resolutionRef: 'https://github.com/acme/agent/pull/812',
    regressedAt: NOW - 3 * DAY,
    resolvedInVersionId: 'ver_7c1',
    resolvedAtRunCount: 1204,
    resolvedAtOccurrenceCount: 41,
    ...overrides,
  } as FailurePattern
}

/** The `fixConfidence` envelope a modern deployment returns for a page. */
function envelopeFor(patterns: readonly FailurePattern[], unevaluated: string[] = []): unknown {
  return {
    stalenessBoundMs: 6 * HOUR,
    entries: patterns.map((p, i) => ({
      fingerprintHash: p.fingerprintHash,
      state: (['unproven', 'proving', 'confirmed', 'regressed'] as const)[i % 4]!,
      score: 0.42,
      computedAt: NOW - 2 * HOUR,
      ageMs: 2 * HOUR,
      stale: i % 3 === 0,
      basis: 'snapshot' as const,
    })),
    staleCount: Math.ceil(patterns.length / 3),
    unevaluated,
  }
}

// ---------------------------------------------------------------------------
// 1. Budget
// ---------------------------------------------------------------------------

describe('afr_triage token budget', () => {
  it(`stays at or under ${String(TRIAGE_TOKEN_BUDGET)} tokens on a saturated, maximally caveated response`, () => {
    // The worst case a caller can actually receive: a full scan, every
    // optional item field present, every caveat that can fire together firing,
    // an unevaluated sample, and a top-level next hop.
    const patterns = Array.from({ length: triage.SCAN_LIMIT }, (_, i) => fatPattern(i, { muted: true }))
    const unevaluated = patterns.slice(0, 6).map((p) => p.fingerprintHash)
    const result = triage.toTriageResult(patterns, envelopeFor(patterns, unevaluated), 'cursor_abc123', NOW, {
      scanTruncated: true,
    })

    const tokens = estimateTokens(result)
    expect(
      tokens,
      `afr_triage worst case is ~${String(tokens)} tokens, over the ${String(TRIAGE_TOKEN_BUDGET)} budget.\n` +
        `  items: ${String(result.items.length)}\n${attribute(result.items as unknown as Record<string, unknown>[])}\n` +
        `  caveats: ~${String(estimateTokens(result.caveats))} tok`,
    ).toBeLessThanOrEqual(TRIAGE_TOKEN_BUDGET)
  })

  it('is cheaper than calling tier 1 and tier 2 yourself — otherwise it is a fifth tier, not a shortcut', () => {
    const patterns = Array.from({ length: triage.SCAN_LIMIT }, (_, i) => fatPattern(i))
    const result = triage.toTriageResult(patterns, envelopeFor(patterns), undefined, NOW)
    expect(estimateTokens(result)).toBeLessThan(DIY_TOKENS)
  })

  it('cost does not scale with how many patterns were scanned', () => {
    // The whole premise: a caller pays for the HEADLINE, not the scan. A
    // 10-pattern org and a 500-pattern org must cost the same to triage.
    const small = triage.toTriageResult(
      Array.from({ length: 10 }, (_, i) => fatPattern(i)),
      envelopeFor([]),
      undefined,
      NOW,
    )
    const large = triage.toTriageResult(
      Array.from({ length: 500 }, (_, i) => fatPattern(i)),
      envelopeFor([]),
      'more',
      NOW,
    )
    expect(large.items).toHaveLength(triage.MAX_ITEMS)
    // Large carries extra caveats/next by design; the ITEMS must not grow.
    expect(estimateTokens(large.items)).toBeLessThan(estimateTokens(small.items) * 1.5)
  })

  it('caps a runaway label with an explicit in-band marker rather than silently', () => {
    const long = 'x'.repeat(4000)
    const result = triage.toTriageResult([fatPattern(0, { label: long })], envelopeFor([]), undefined, NOW)
    const label = result.items[0]!.label
    expect(label.length).toBeLessThan(long.length)
    expect(label).toContain('…[truncated,')
    expect(estimateTokens(result)).toBeLessThanOrEqual(TRIAGE_TOKEN_BUDGET)
  })
})

// ---------------------------------------------------------------------------
// 2. Next-hop pointers
// ---------------------------------------------------------------------------

/** The tool names that actually exist on this server. A pointer outside this set is a dead end. */
const REAL_TOOLS = new Set([
  'afr_triage',
  'afr_list_failure_patterns',
  'afr_get_pattern_evidence',
  'afr_explain_run',
  'afr_get_run_events',
  'afr_list_runs',
])

/** The argument names each pointed-at tool accepts. A pointer with a bogus arg is rejected at the schema. */
const TOOL_ARGS: Record<string, ReadonlySet<string>> = {
  afr_get_pattern_evidence: new Set(['fingerprintHash']),
  afr_explain_run: new Set(['runId']),
  afr_list_failure_patterns: new Set(['agentId', 'state', 'status', 'spiking', 'regressed', 'limit', 'cursor']),
  afr_list_runs: new Set(['status', 'agentId', 'environment', 'sessionId', 'limit', 'cursor']),
}

describe('afr_triage next-hop pointers', () => {
  it('gives every item exactly one executable next hop', () => {
    const patterns = Array.from({ length: 20 }, (_, i) => fatPattern(i))
    const result = triage.toTriageResult(patterns, envelopeFor(patterns), 'c', NOW)
    expect(result.items.length).toBeGreaterThan(0)
    for (const item of result.items) {
      expect(REAL_TOOLS.has(item.next.tool), `unknown tool in pointer: ${item.next.tool}`).toBe(true)
      const allowed = TOOL_ARGS[item.next.tool]!
      for (const key of Object.keys(item.next.args)) {
        expect(allowed.has(key), `${item.next.tool} does not accept argument "${key}"`).toBe(true)
      }
      expect(Object.keys(item.next.args).length).toBeGreaterThan(0)
    }
  })

  it('points a resolved or regressed pattern at the evidence tier — "did the fix hold?"', () => {
    const p = fatPattern(0, { status: 'resolved', resolvedAt: NOW - DAY, regressedAt: NOW - HOUR })
    expect(triage.choosePointer(p, 'regressed')).toEqual({
      tool: 'afr_get_pattern_evidence',
      args: { fingerprintHash: p.fingerprintHash },
    })
  })

  it('points an unresolved pattern at a concrete run, not at more pattern metadata', () => {
    const p = fatPattern(1, { status: 'open', resolvedAt: undefined, regressedAt: undefined })
    expect(triage.choosePointer(p, 'open')).toEqual({ tool: 'afr_explain_run', args: { runId: 'run_1a' } })
  })

  it('falls back to the evidence tier rather than emitting no pointer at all', () => {
    const p = fatPattern(1, { status: 'open', resolvedAt: undefined, regressedAt: undefined, representativeRunIds: [] })
    expect(triage.choosePointer(p, 'open').tool).toBe('afr_get_pattern_evidence')
  })

  it('forwards the scan cursor verbatim so continuing is mechanical, not a guess', () => {
    const patterns = Array.from({ length: 10 }, (_, i) => fatPattern(i))
    const result = triage.toTriageResult(patterns, envelopeFor(patterns), 'cursor_xyz', NOW)
    expect(result.next).toEqual({ tool: 'afr_list_failure_patterns', args: { cursor: 'cursor_xyz', limit: 100 } })
  })
})

// ---------------------------------------------------------------------------
// 3. Ranking
// ---------------------------------------------------------------------------

describe('afr_triage ranking', () => {
  it('keeps signal classes strictly non-interleaving — the property the ranking is explained by', () => {
    // Recency and volume order WITHIN a class and must never promote across
    // one. That holds only while the tie-breakers stay under the gap between
    // adjacent signal weights. Asserted rather than left to arithmetic,
    // because widening a tie-breaker is the change that would silently kill it.
    const weights = Object.values(triage.SIGNAL_WEIGHT).sort((a, b) => a - b)
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]! - weights[i - 1]!).toBeGreaterThan(triage.MAX_TIEBREAK)
    }
  })

  it('ranks a regressed fix above a never-resolved pattern, even a much louder and fresher one', () => {
    const regressed = fatPattern(0, {
      fingerprintHash: 'aa_regressed',
      count: 3,
      lastSeenAt: NOW - 6 * DAY,
      status: 'resolved',
      resolvedAt: NOW - 5 * DAY,
      regressedAt: NOW - 4 * DAY,
      lastSpikeAssessment: undefined,
      muted: false,
    })
    const loudOpen = fatPattern(1, {
      fingerprintHash: 'bb_open',
      count: 99_999,
      lastSeenAt: NOW,
      status: 'open',
      resolvedAt: undefined,
      regressedAt: undefined,
      lastSpikeAssessment: undefined,
      muted: false,
    })
    const result = triage.toTriageResult([loudOpen, regressed], undefined, undefined, NOW)
    expect(result.items.map((i) => i.fingerprintHash)).toEqual(['aa_regressed', 'bb_open'])
    expect(result.items[0]!.signal).toBe('regressed')
  })

  it('detects a regression from regressedAt when the deployment serves no fix confidence', () => {
    const p = fatPattern(0, { status: 'resolved', resolvedAt: NOW - 2 * DAY, regressedAt: NOW - DAY })
    expect(triage.classifySignal(p)).toBe('regressed')
  })

  it('does NOT call a pattern regressed when the regression predates the current resolution', () => {
    // regressedAt is preserved as history across a re-resolve. A pattern that
    // regressed, was genuinely re-fixed and re-resolved is not currently broken,
    // and reporting it as such is the exact false positive `regressed: true`
    // suffers from and `state: 'regressed'` exists to avoid.
    const p = fatPattern(0, {
      status: 'resolved',
      regressedAt: NOW - 3 * DAY,
      resolvedAt: NOW - DAY,
      lastSpikeAssessment: undefined,
    })
    expect(triage.classifySignal(p)).toBe('resolved')
  })

  it('prefers the fix-confidence verdict over the rollup fallback when one is served', () => {
    const p = fatPattern(0, { status: 'open', resolvedAt: undefined, regressedAt: undefined })
    expect(triage.classifySignal(p, { fingerprintHash: p.fingerprintHash, state: 'regressed', stale: false })).toBe(
      'regressed',
    )
  })

  it('orders by recency within a class, and decays rather than cliff-edges', () => {
    const fresh = triage.scorePattern(fatPattern(0, { count: 10, lastSeenAt: NOW }), 'open', NOW)
    const day = triage.scorePattern(fatPattern(0, { count: 10, lastSeenAt: NOW - DAY }), 'open', NOW)
    const week = triage.scorePattern(fatPattern(0, { count: 10, lastSeenAt: NOW - 7 * DAY }), 'open', NOW)
    expect(fresh).toBeGreaterThan(day)
    expect(day).toBeGreaterThan(week)
  })

  it('log-scales volume so one huge pattern cannot drown the list', () => {
    const ten = triage.scorePattern(fatPattern(0, { count: 10, lastSeenAt: NOW }), 'open', NOW)
    const hundred = triage.scorePattern(fatPattern(0, { count: 100, lastSeenAt: NOW }), 'open', NOW)
    const million = triage.scorePattern(fatPattern(0, { count: 1_000_000, lastSeenAt: NOW }), 'open', NOW)
    expect(hundred).toBeGreaterThan(ten)
    // Saturated: four more orders of magnitude buy nothing.
    expect(million).toBe(hundred)
  })

  it('sorts muted patterns last and flags them, rather than hiding them', () => {
    const muted = fatPattern(0, {
      fingerprintHash: 'aa_muted',
      muted: true,
      status: 'resolved',
      resolvedAt: NOW - 2 * DAY,
      regressedAt: NOW - DAY,
      lastSeenAt: NOW,
      count: 5000,
    })
    const quiet = fatPattern(1, {
      fingerprintHash: 'bb_quiet',
      muted: false,
      status: 'resolved',
      resolvedAt: NOW - 20 * DAY,
      regressedAt: undefined,
      lastSpikeAssessment: undefined,
      lastSeenAt: NOW - 30 * DAY,
      count: 1,
    })
    const result = triage.toTriageResult([muted, quiet], undefined, undefined, NOW)
    expect(result.items.map((i) => i.fingerprintHash)).toEqual(['bb_quiet', 'aa_muted'])
    expect(result.items[1]!.muted).toBe(true)
  })

  it('is a total order — equal scores break deterministically, so two calls do not shuffle', () => {
    const a = fatPattern(0, { fingerprintHash: 'aaa', count: 10, lastSeenAt: NOW, status: 'open', resolvedAt: undefined, regressedAt: undefined, lastSpikeAssessment: undefined })
    const b = fatPattern(0, { fingerprintHash: 'bbb', count: 10, lastSeenAt: NOW, status: 'open', resolvedAt: undefined, regressedAt: undefined, lastSpikeAssessment: undefined })
    expect(triage.toTriageResult([a, b], undefined, undefined, NOW).items.map((i) => i.fingerprintHash)).toEqual(['aaa', 'bbb'])
    expect(triage.toTriageResult([b, a], undefined, undefined, NOW).items.map((i) => i.fingerprintHash)).toEqual(['aaa', 'bbb'])
  })

  it('emits the score, so the ordering is auditable and not merely asserted', () => {
    const patterns = Array.from({ length: 5 }, (_, i) => fatPattern(i))
    const result = triage.toTriageResult(patterns, envelopeFor(patterns), undefined, NOW)
    const scores = result.items.map((i) => i.score)
    expect(scores).toEqual([...scores].sort((x, y) => y - x))
  })
})

// ---------------------------------------------------------------------------
// 4. Honesty about emptiness
// ---------------------------------------------------------------------------

describe('afr_triage honesty', () => {
  it('says "clear" only when the scan actually finished and found nothing', () => {
    const result = triage.toTriageResult([], envelopeFor([]), undefined, NOW)
    expect(result.verdict).toBe('clear')
    expect(result.complete).toBe(true)
    expect(result.caveats).toBeUndefined()
    // Still hands back a rung: a failure that has not fingerprinted yet is
    // invisible to this tool, and raw failed runs are where to look.
    expect(result.next?.tool).toBe('afr_list_runs')
  })

  it('says "unknown", never "clear", when nothing was found but the look was not whole', () => {
    // No fix-confidence served: regressions could only be inferred from the
    // rollup. Reporting that as "nothing is broken" is the specific mistake
    // this assertion exists to prevent.
    const result = triage.toTriageResult([], undefined, undefined, NOW)
    expect(result.verdict).toBe('unknown')
    expect(result.complete).toBe(false)
    expect(result.caveats?.length).toBeGreaterThan(0)
  })

  it('marks a truncated scan incomplete and says so in words, while still returning items', () => {
    const patterns = Array.from({ length: triage.SCAN_LIMIT }, (_, i) => fatPattern(i))
    const result = triage.toTriageResult(patterns, envelopeFor(patterns), 'cursor_more', NOW)
    expect(result.verdict).toBe('issues')
    expect(result.complete).toBe(false)
    expect(result.caveats?.some((c) => c.toLowerCase().includes('truncated'))).toBe(true)
    expect(result.scanned).toBe(triage.SCAN_LIMIT)
  })

  it('names patterns whose fix state could not be evaluated instead of dropping them', () => {
    const patterns = Array.from({ length: 4 }, (_, i) => fatPattern(i))
    const hashes = patterns.map((p) => p.fingerprintHash)
    const result = triage.toTriageResult(patterns, envelopeFor(patterns, hashes), undefined, NOW)
    expect(result.unevaluated?.count).toBe(4)
    expect(result.unevaluated?.sample.length).toBeLessThanOrEqual(3)
    expect(result.complete).toBe(false)
    expect(result.caveats?.some((c) => c.includes('could not be graded'))).toBe(true)
  })

  it('surfaces the SERVER scan marker, not just the cursor proxy', () => {
    // Convex computes the marker, the route forwards it, the SDK types it —
    // and a projection that drops it at the last hop makes the whole chain
    // worthless. A marker nobody reads is the same as no marker.
    const patterns = Array.from({ length: 3 }, (_, i) => fatPattern(i))
    const result = triage.toTriageResult(patterns, envelopeFor(patterns), undefined, NOW, { scanTruncated: true })
    expect(result.scanTruncated).toBe(true)
    expect(result.complete).toBe(false)
    expect(result.caveats?.some((c) => c.includes('row ceiling'))).toBe(true)
  })

  it('does NOT report "clear" on an empty page the server could not finish scanning', () => {
    // THE REASSURING EMPTY STATE. An empty page under a truncated scan means
    // "nothing matched in the slice I could afford to look at", not "nothing
    // is broken", and an agent that reads it the second way stops looking.
    const result = triage.toTriageResult([], envelopeFor([]), undefined, NOW, { scanTruncated: true })
    expect(result.items).toHaveLength(0)
    expect(result.verdict).toBe('unknown')
    expect(result.scanTruncated).toBe(true)
  })

  it('treats an undeclared marker as complete, matching the SDK’s single decision on absence', () => {
    // An older deployment never declares truncation. Treating absence as
    // incomplete would make every such request permanently inconclusive.
    const patterns = Array.from({ length: 3 }, (_, i) => fatPattern(i))
    expect(triage.toTriageResult(patterns, envelopeFor(patterns), undefined, NOW, {}).scanTruncated).toBeUndefined()
    expect(triage.toTriageResult(patterns, envelopeFor(patterns), undefined, NOW).complete).toBe(true)
  })

  it('keeps the two truncation kinds distinct — a window limit is not a server ceiling', () => {
    const patterns = Array.from({ length: triage.SCAN_LIMIT }, (_, i) => fatPattern(i))
    // Cursor only: the ranking's window was partial, the scan itself was fine.
    const windowOnly = triage.toTriageResult(patterns, envelopeFor(patterns), 'c', NOW, { scanTruncated: false })
    expect(windowOnly.scanTruncated).toBeUndefined()
    expect(windowOnly.complete).toBe(false)
    expect(windowOnly.caveats?.some((c) => c.includes('ranking covers only'))).toBe(true)
    // Both: the worse one is what the single caveat names.
    const both = triage.toTriageResult(patterns, envelopeFor(patterns), 'c', NOW, { scanTruncated: true })
    expect(both.caveats?.some((c) => c.includes('row ceiling'))).toBe(true)
    expect(both.caveats?.some((c) => c.includes('ranking covers only'))).toBe(false)
  })

  it('reports complete:true only when nothing at all was degraded', () => {
    const patterns = Array.from({ length: 3 }, (_, i) => fatPattern(i))
    const result = triage.toTriageResult(patterns, envelopeFor(patterns), undefined, NOW)
    expect(result.complete).toBe(true)
    expect(result.verdict).toBe('issues')
    expect(result.caveats).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. Shape guard — the fields the tool is allowed to expose
// ---------------------------------------------------------------------------

describe('afr_triage shape', () => {
  /**
   * Triage is an ORIENTATION tool. Every field below belongs to a lower tier,
   * and every one of them is a plausible "it's only one field" addition that
   * type-checks. The forbidden list is what keeps the budget from being eroded
   * one reasonable-sounding field at a time.
   */
  const FORBIDDEN = [
    'representativeRunIds',
    'affectedAgentVersionIds',
    'affectedAgentIds',
    'resolutionNote',
    'resolutionRef',
    'lastSpikeAssessment',
    'lastFixConfidence',
    'payload',
    'transitions',
    'exposure',
    'orgId',
    'salientKey',
  ]

  it('never leaks a lower-tier field into a triage item', () => {
    const patterns = Array.from({ length: triage.SCAN_LIMIT }, (_, i) => fatPattern(i))
    const serialized = JSON.stringify(triage.toTriageResult(patterns, envelopeFor(patterns), 'c', NOW))
    for (const key of FORBIDDEN) {
      expect(serialized.includes(`"${key}"`), `triage leaked "${key}"`).toBe(false)
    }
  })

  it('never emits orgId — the tenancy boundary is the key’s, not a value to hand an agent', () => {
    const result = triage.toTriageResult([fatPattern(0)], envelopeFor([]), undefined, NOW)
    expect(JSON.stringify(result)).not.toContain('org_caller')
  })

  it('requests only real failure_patterns document fields', async () => {
    // The read API makes an unknown field name a HARD 422, so a stale entry in
    // the request list fails the whole call rather than one column. Checked
    // against the live schema, like tests/unit/mcp_fields.test.ts does for the
    // other tiers.
    const { readFile } = await import('node:fs/promises')
    const schema = await readFile(new URL('../../convex/schema.ts', import.meta.url), 'utf8')
    const table = /failure_patterns: defineTable\(\{([\s\S]*?)\n {2}\}\)/.exec(schema)?.[1] ?? ''
    expect(table.length).toBeGreaterThan(0)
    const declared = new Set([...table.matchAll(/^ {4}([a-zA-Z_][a-zA-Z0-9_]*):/gm)].map((m) => m[1]!))
    for (const field of triage.TRIAGE_REQUEST_FIELDS) {
      expect(declared.has(field), `"${field}" is not a failure_patterns field`).toBe(true)
    }
  })

  it('never requests the identity field — the read API returns it regardless', () => {
    expect(triage.TRIAGE_REQUEST_FIELDS).not.toContain('fingerprintHash')
    expect(triage.TRIAGE_FIELDS).toContain('fingerprintHash')
  })
})
