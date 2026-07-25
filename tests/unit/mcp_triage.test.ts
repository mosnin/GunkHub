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
 * 1. IT IS CHEAPER THAN DOING IT YOURSELF. Calling tier 1 and tier 2 yourself
 *    is budgeted at 300 + 450 tokens. If triage cost more than that it would be
 *    a fifth tier pretending to be a shortcut. Its own budget is the stricter
 *    line — tier 2's alone — and both are asserted here against
 *    contract-maximal input rather than hoped for. (The bar used to be the
 *    frozen MEASUREMENTS `284 + 423`, which drifted leniently and silently
 *    every time tier 1 or tier 2 got cheaper; see `DIY_TOKEN_BUDGET` in
 *    `./mcp_budgets.ts`.) A future
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
 * BUDGET AND ESTIMATOR ARE NOT DECLARED HERE
 * ------------------------------------------
 * Both come from `./mcp_budgets.ts`. `TRIAGE_TOKEN_BUDGET` is defined THERE as
 * `TIER2_TOKEN_BUDGET`, because that is what it is — tier 2's budget, by
 * derivation, not a coincidentally equal `450`. It used to be a third
 * independent literal `450` (this file, `mcp_triage_measure.test.ts`, and tier
 * 2's own budget), which is three chances for the derivation to quietly stop
 * being true.
 */
import {
  LABEL_BYTE_CAP,
  MAX_ITEMS,
  MAX_TIEBREAK,
  SCAN_LIMIT,
  SIGNAL_WEIGHT,
  TRIAGE_FIELDS,
  TRIAGE_REQUEST_FIELDS,
  choosePointer,
  classifySignal,
  scorePattern,
  toTriageResult,
} from '@agent-flight-recorder/mcp'
import { describe, expect, it } from 'vitest'

import {
  DAY,
  DIY_TOKEN_BUDGET,
  FROZEN_NOW as NOW,
  HOUR,
  TRIAGE_TOKEN_BUDGET,
  attributeRowBytes,
  byteLength,
  estimateTokens,
  fatPattern,
} from './mcp_budgets.js'

import type { FailurePattern } from '@agent-flight-recorder/contracts'
import type { V1ListFixConfidenceEnvelope } from '@agent-flight-recorder/sdk'

// ---------------------------------------------------------------------------
// Module seam
// ---------------------------------------------------------------------------

/**
 * A REAL, TYPE-CHECKED IMPORT. See the seam note in
 * `mcp_progressive_disclosure.test.ts`: the non-literal dynamic specifier and
 * the hand-written `TriageModule` shadow that used to stand here were justified
 * by a claim ("not a workspace dependency, no alias") that both
 * `tests/package.json` and `tests/vitest.config.ts` have since falsified.
 */

// ---------------------------------------------------------------------------
// FAT inputs — SHARED, not re-declared here
// ---------------------------------------------------------------------------
//
// `fatPattern` and its clock (`FROZEN_NOW`, `HOUR`, `DAY`) come from
// `./mcp_budgets.js`, the single declaration of the contract-maximal fixture
// family and the only copy `checkMaximality` proves saturated. The local copy
// this replaces was already two fields short of the contract
// (`lastFixConfidence`, `fixConfidenceRefreshAt`) and the OTel iteration would
// have widened that gap silently, because nothing ever checked it.
//
// `NOW` is `FROZEN_NOW` under its old name: every recency assertion below is
// written as an offset from it, and the shared fixtures use the same instant.

/** The `fixConfidence` envelope a modern deployment returns for a page. */
function envelopeFor(patterns: readonly FailurePattern[], unevaluated: string[] = []): V1ListFixConfidenceEnvelope {
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
    const patterns = Array.from({ length: SCAN_LIMIT }, (_, i) => fatPattern(i, { muted: true }))
    const unevaluated = patterns.slice(0, 6).map((p) => p.fingerprintHash)
    const result = toTriageResult(patterns, envelopeFor(patterns, unevaluated), 'cursor_abc123', NOW, {
      scanTruncated: true,
    })

    const tokens = estimateTokens(result)
    expect(
      tokens,
      `afr_triage worst case is ~${String(tokens)} tokens, over the ${String(TRIAGE_TOKEN_BUDGET)} budget.\n` +
        `  items: ${String(result.items.length)}\n${attributeRowBytes(result.items as unknown as Record<string, unknown>[])}\n` +
        `  caveats: ~${String(estimateTokens(result.caveats))} tok`,
    ).toBeLessThanOrEqual(TRIAGE_TOKEN_BUDGET)
  })

  it('is cheaper than calling tier 1 and tier 2 yourself — otherwise it is a fifth tier, not a shortcut', () => {
    const patterns = Array.from({ length: SCAN_LIMIT }, (_, i) => fatPattern(i))
    const result = toTriageResult(patterns, envelopeFor(patterns), undefined, NOW)
    expect(estimateTokens(result)).toBeLessThan(DIY_TOKEN_BUDGET)
  })

  it('cost does not scale with how many patterns were scanned', () => {
    // The whole premise: a caller pays for the HEADLINE, not the scan. A
    // 10-pattern org and a 500-pattern org must cost the same to 
    const small = toTriageResult(
      Array.from({ length: 10 }, (_, i) => fatPattern(i)),
      envelopeFor([]),
      undefined,
      NOW,
    )
    const large = toTriageResult(
      Array.from({ length: 500 }, (_, i) => fatPattern(i)),
      envelopeFor([]),
      'more',
      NOW,
    )
    expect(large.items).toHaveLength(MAX_ITEMS)
    // Large carries extra caveats/next by design; the ITEMS must not grow.
    expect(estimateTokens(large.items)).toBeLessThan(estimateTokens(small.items) * 1.5)
  })

  it('caps a runaway label with an explicit in-band marker rather than silently', () => {
    const long = 'x'.repeat(4000)
    const result = toTriageResult([fatPattern(0, { label: long })], envelopeFor([]), undefined, NOW)
    const label = result.items[0]!.label
    expect(label.length).toBeLessThan(long.length)
    expect(label).toContain('…[truncated,')
    // Tied to the SHIPPED cap, not merely to "shorter than the input". Without
    // this the test passes at any cap at all, including one an order of
    // magnitude over budget, as long as something was cut.
    expect(
      byteLength(label.split('…[truncated,')[0] ?? ''),
      `the kept part of a capped label is over LABEL_BYTE_CAP (${String(LABEL_BYTE_CAP)} B)`,
    ).toBeLessThanOrEqual(LABEL_BYTE_CAP)
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
  // ADR-008. Not reachable from a triage `next` pointer — a failure pattern and
  // a version divergence are different questions — but listed so this set stays
  // the real tool inventory rather than the subset triage happens to point at.
  'afr_assess_version',
  'afr_get_run_divergence',
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
    const result = toTriageResult(patterns, envelopeFor(patterns), 'c', NOW)
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
    expect(choosePointer(p, 'regressed')).toEqual({
      tool: 'afr_get_pattern_evidence',
      args: { fingerprintHash: p.fingerprintHash },
    })
  })

  it('points an unresolved pattern at a concrete run, not at more pattern metadata', () => {
    const p = fatPattern(1, { status: 'open', resolvedAt: undefined, regressedAt: undefined })
    // `run_10` is `fatPattern(1).representativeRunIds[0]` in the shared family
    // (`run_${i}${r}`); the local copy this suite used to carry named it `run_1a`.
    expect(choosePointer(p, 'open')).toEqual({ tool: 'afr_explain_run', args: { runId: 'run_10' } })
  })

  it('falls back to the evidence tier rather than emitting no pointer at all', () => {
    const p = fatPattern(1, { status: 'open', resolvedAt: undefined, regressedAt: undefined, representativeRunIds: [] })
    expect(choosePointer(p, 'open').tool).toBe('afr_get_pattern_evidence')
  })

  it('forwards the scan cursor verbatim so continuing is mechanical, not a guess', () => {
    const patterns = Array.from({ length: 10 }, (_, i) => fatPattern(i))
    const result = toTriageResult(patterns, envelopeFor(patterns), 'cursor_xyz', NOW)
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
    const weights = Object.values(SIGNAL_WEIGHT).sort((a, b) => a - b)
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]! - weights[i - 1]!).toBeGreaterThan(MAX_TIEBREAK)
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
    const result = toTriageResult([loudOpen, regressed], undefined, undefined, NOW)
    expect(result.items.map((i) => i.fingerprintHash)).toEqual(['aa_regressed', 'bb_open'])
    expect(result.items[0]!.signal).toBe('regressed')
  })

  it('detects a regression from regressedAt when the deployment serves no fix confidence', () => {
    const p = fatPattern(0, { status: 'resolved', resolvedAt: NOW - 2 * DAY, regressedAt: NOW - DAY })
    expect(classifySignal(p)).toBe('regressed')
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
    expect(classifySignal(p)).toBe('resolved')
  })

  it('prefers the fix-confidence verdict over the rollup fallback when one is served', () => {
    const p = fatPattern(0, { status: 'open', resolvedAt: undefined, regressedAt: undefined })
    // A COMPLETE `FixConfidenceEntry`. The seam's old `confidence?: unknown`
    // shadow accepted a three-field stub, so this case was silently asserting
    // that `classifySignal` reads `state` and tolerates a malformed entry —
    // a weaker claim than the one it is written to make.
    expect(
      classifySignal(p, {
        fingerprintHash: p.fingerprintHash,
        state: 'regressed',
        score: 0.12,
        computedAt: NOW - 2 * HOUR,
        ageMs: 2 * HOUR,
        stale: false,
        basis: 'snapshot',
      }),
    ).toBe('regressed')
  })

  it('orders by recency within a class, and decays rather than cliff-edges', () => {
    const fresh = scorePattern(fatPattern(0, { count: 10, lastSeenAt: NOW }), 'open', NOW)
    const day = scorePattern(fatPattern(0, { count: 10, lastSeenAt: NOW - DAY }), 'open', NOW)
    const week = scorePattern(fatPattern(0, { count: 10, lastSeenAt: NOW - 7 * DAY }), 'open', NOW)
    expect(fresh).toBeGreaterThan(day)
    expect(day).toBeGreaterThan(week)
  })

  it('log-scales volume so one huge pattern cannot drown the list', () => {
    const ten = scorePattern(fatPattern(0, { count: 10, lastSeenAt: NOW }), 'open', NOW)
    const hundred = scorePattern(fatPattern(0, { count: 100, lastSeenAt: NOW }), 'open', NOW)
    const million = scorePattern(fatPattern(0, { count: 1_000_000, lastSeenAt: NOW }), 'open', NOW)
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
    const result = toTriageResult([muted, quiet], undefined, undefined, NOW)
    expect(result.items.map((i) => i.fingerprintHash)).toEqual(['bb_quiet', 'aa_muted'])
    expect(result.items[1]!.muted).toBe(true)
  })

  it('is a total order — equal scores break deterministically, so two calls do not shuffle', () => {
    const a = fatPattern(0, { fingerprintHash: 'aaa', count: 10, lastSeenAt: NOW, status: 'open', resolvedAt: undefined, regressedAt: undefined, lastSpikeAssessment: undefined })
    const b = fatPattern(0, { fingerprintHash: 'bbb', count: 10, lastSeenAt: NOW, status: 'open', resolvedAt: undefined, regressedAt: undefined, lastSpikeAssessment: undefined })
    expect(toTriageResult([a, b], undefined, undefined, NOW).items.map((i) => i.fingerprintHash)).toEqual(['aaa', 'bbb'])
    expect(toTriageResult([b, a], undefined, undefined, NOW).items.map((i) => i.fingerprintHash)).toEqual(['aaa', 'bbb'])
  })

  it('emits the score, so the ordering is auditable and not merely asserted', () => {
    const patterns = Array.from({ length: 5 }, (_, i) => fatPattern(i))
    const result = toTriageResult(patterns, envelopeFor(patterns), undefined, NOW)
    const scores = result.items.map((i) => i.score)
    expect(scores).toEqual([...scores].sort((x, y) => y - x))
  })
})

// ---------------------------------------------------------------------------
// 4. Honesty about emptiness
// ---------------------------------------------------------------------------

describe('afr_triage honesty', () => {
  it('says "clear" only when the scan actually finished and found nothing', () => {
    const result = toTriageResult([], envelopeFor([]), undefined, NOW)
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
    const result = toTriageResult([], undefined, undefined, NOW)
    expect(result.verdict).toBe('unknown')
    expect(result.complete).toBe(false)
    expect(result.caveats?.length).toBeGreaterThan(0)
  })

  it('marks a truncated scan incomplete and says so in words, while still returning items', () => {
    const patterns = Array.from({ length: SCAN_LIMIT }, (_, i) => fatPattern(i))
    const result = toTriageResult(patterns, envelopeFor(patterns), 'cursor_more', NOW)
    expect(result.verdict).toBe('issues')
    expect(result.complete).toBe(false)
    expect(result.caveats?.some((c) => c.toLowerCase().includes('truncated'))).toBe(true)
    expect(result.scanned).toBe(SCAN_LIMIT)
  })

  it('names patterns whose fix state could not be evaluated instead of dropping them', () => {
    const patterns = Array.from({ length: 4 }, (_, i) => fatPattern(i))
    const hashes = patterns.map((p) => p.fingerprintHash)
    const result = toTriageResult(patterns, envelopeFor(patterns, hashes), undefined, NOW)
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
    const result = toTriageResult(patterns, envelopeFor(patterns), undefined, NOW, { scanTruncated: true })
    expect(result.scanTruncated).toBe(true)
    expect(result.complete).toBe(false)
    expect(result.caveats?.some((c) => c.includes('row ceiling'))).toBe(true)
  })

  it('does NOT report "clear" on an empty page the server could not finish scanning', () => {
    // THE REASSURING EMPTY STATE. An empty page under a truncated scan means
    // "nothing matched in the slice I could afford to look at", not "nothing
    // is broken", and an agent that reads it the second way stops looking.
    const result = toTriageResult([], envelopeFor([]), undefined, NOW, { scanTruncated: true })
    expect(result.items).toHaveLength(0)
    expect(result.verdict).toBe('unknown')
    expect(result.scanTruncated).toBe(true)
  })

  it('treats an undeclared marker as complete, matching the SDK’s single decision on absence', () => {
    // An older deployment never declares truncation. Treating absence as
    // incomplete would make every such request permanently inconclusive.
    const patterns = Array.from({ length: 3 }, (_, i) => fatPattern(i))
    expect(toTriageResult(patterns, envelopeFor(patterns), undefined, NOW, {}).scanTruncated).toBeUndefined()
    expect(toTriageResult(patterns, envelopeFor(patterns), undefined, NOW).complete).toBe(true)
  })

  it('keeps the two truncation kinds distinct — a window limit is not a server ceiling', () => {
    const patterns = Array.from({ length: SCAN_LIMIT }, (_, i) => fatPattern(i))
    // Cursor only: the ranking's window was partial, the scan itself was fine.
    const windowOnly = toTriageResult(patterns, envelopeFor(patterns), 'c', NOW, { scanTruncated: false })
    expect(windowOnly.scanTruncated).toBeUndefined()
    expect(windowOnly.complete).toBe(false)
    expect(windowOnly.caveats?.some((c) => c.includes('ranking covers only'))).toBe(true)
    // Both: the worse one is what the single caveat names.
    const both = toTriageResult(patterns, envelopeFor(patterns), 'c', NOW, { scanTruncated: true })
    expect(both.caveats?.some((c) => c.includes('row ceiling'))).toBe(true)
    expect(both.caveats?.some((c) => c.includes('ranking covers only'))).toBe(false)
  })

  it('reports complete:true only when nothing at all was degraded', () => {
    const patterns = Array.from({ length: 3 }, (_, i) => fatPattern(i))
    const result = toTriageResult(patterns, envelopeFor(patterns), undefined, NOW)
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
    const patterns = Array.from({ length: SCAN_LIMIT }, (_, i) => fatPattern(i))
    const serialized = JSON.stringify(toTriageResult(patterns, envelopeFor(patterns), 'c', NOW))
    for (const key of FORBIDDEN) {
      expect(serialized.includes(`"${key}"`), `triage leaked "${key}"`).toBe(false)
    }
  })

  it('never emits orgId — the tenancy boundary is the key’s, not a value to hand an agent', () => {
    const result = toTriageResult([fatPattern(0)], envelopeFor([]), undefined, NOW)
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
    for (const field of TRIAGE_REQUEST_FIELDS) {
      expect(declared.has(field), `"${field}" is not a failure_patterns field`).toBe(true)
    }
  })

  it('never requests the identity field — the read API returns it regardless', () => {
    expect(TRIAGE_REQUEST_FIELDS).not.toContain('fingerprintHash')
    expect(TRIAGE_FIELDS).toContain('fingerprintHash')
  })
})
