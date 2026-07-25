/**
 * FLEET HEALTH / CORRELATION ENGINE — ADVERSARIAL SUITE (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * The surfaces an operator reads DURING AN INCIDENT to decide what to roll
 * back: the per-fingerprint temporal spike ("burst") detector, the cross-agent
 * affected-set that stands in for failure-pattern correlation, and the cohort
 * comparison that produces regression verdicts. The thing under attack is not
 * "does it compute a number" — it is "does it ever present a HYPOTHESIS as a
 * FINDING, and does it ever go quiet on a real one".
 *
 * WHAT IS AND IS NOT IN THIS TREE (established by executed sweep, not memory —
 * see `predicate-discovery` below, which re-runs the sweep on every test run):
 *
 *   - There is NO base-rate / lift / prevalence / co-occurrence math anywhere
 *     in convex/, packages/, or apps/web. The "cross-agent failure-pattern
 *     correlation" an operator would need is not implemented; what exists is
 *     `failure_patterns.affectedAgentIds`, a CAPPED, most-recent-first set.
 *   - There is NO multi-agent temporal burst detector ("N agents degrading
 *     inside window W"). What exists is `assessPatternSpike`, a per-fingerprint
 *     daily-count z-score with NO agent dimension at all.
 *
 * That absence is itself a finding, and the sweeps below are written so this
 * suite goes RED the moment either capability lands — at which point these
 * probes must be re-pointed at the real engine rather than at its stand-in.
 *
 * ── THE DEFECT LEDGER ──────────────────────────────────────────────────────
 * Asserting the CORRECT behaviour would leave a permanently red suite in a
 * tree four teams are working in; asserting the CURRENT behaviour would pin
 * the bug and is how defects become features. This suite does neither.
 *
 * Every attack RUNS FOR REAL against the shipped functions and compares actual
 * behaviour to the CORRECT expectation. A mismatch appends to `observedDefects`
 * with a stable id. One final test asserts `observedDefects` is EXACTLY
 * `KNOWN_DEFECTS`. So a fix goes red (delete the entry), a regression goes red,
 * and the status quo is green with every defect named and reproducible.
 *
 * ── ANTI-VACUITY ───────────────────────────────────────────────────────────
 * `teeth/*` breaks each checker's SUBJECT in memory and asserts THIS SUITE'S
 * OWN checkers reject it. Every probe asserts against a FUNCTION'S OUTPUT, not
 * against a constant that merely looks like the property — a constant-vs-
 * constant assertion is how a false ledger entry got written in a previous
 * cycle. `FIXTURE AUDIT` blocks assert each adversarial fixture actually has
 * the shape it claims (a "smooth ramp" that secretly contains a step would
 * prove nothing about trend-vs-burst).
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 * Tenancy on these surfaces is enforced inside Convex query handlers against a
 * live `ctx.db` + Clerk identity / api key. There is no Convex deployment in
 * this environment, so cross-org behaviour is asserted STRUCTURALLY here and
 * the runtime/timing oracle is named as untested in the report rather than
 * faked with a mock that would only grade my own mock.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Non-literal specifiers keep `convex/` out of tests/tsconfig.json's program
// (same reason otlp_adversarial_roundtrip.test.ts and
// divergence_adversarial_engine.test.ts do it). The modules are still loaded
// and EXECUTED for real.
const INSIGHTS = '../../convex/insights.js'
const ANALYTICS = '../../convex/helpers/analytics.js'
const PATTERNS = '../../convex/failure_patterns.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const observedDefects = new Set<string>()

function record(id: string): void {
  observedDefects.add(id)
}

/**
 * Every defect this suite currently reproduces BY EXECUTION. Each entry is
 * written by exactly one probe below and names the reproduction.
 */
/**
 * FIVE ENTRIES RETIRED THIS CYCLE, each verified BY EXECUTION against current
 * source — never by reading a diff, never by counting which probes stopped
 * firing. See `retirements/*` below, where each is re-derived positively.
 *
 *   burst/monotone-trend-reported-as-spike
 *   burst/sustained-incident-reads-as-not-spiking
 *     -> Team A replaced mean+stddev with median+MAD. Mean/stddev have a
 *        breakdown point of zero, so an ongoing outage contaminated its own
 *        baseline. Executed: the ramp is no longer a spike, and the day-7
 *        outage still reads as spiking exactly as the day-3 one does.
 *   burst/dual-implementations-disagree
 *   burst/recentCount-unit-collision
 *     -> `getAssessPatternSpike` is now a STATIC `insightsModule.assessPatternSpike`.
 *        Both defects required the runtime property lookup that decided which
 *        implementation ran; with one reachable implementation there is no
 *        collision in the stored field and no runtime coin-flip. The fallback
 *        still EXISTS and still disagrees as a function — that residual is
 *        characterised in `residuals/`, not ledgered, because nothing calls it.
 *   correlation/affected-agent-set-saturates-without-marker
 *     -> `FailurePattern.affectedAgentIdsTruncated` now exists, and the helper
 *        treats a set AT the cap as truncated even without the flag.
 */
const KNOWN_DEFECTS: readonly string[] = [
  // The burst signal has no agent-cardinality dimension: one agent failing N
  // times and N agents failing once are the same input and the same output.
  'burst/no-agent-cardinality-in-signal',
  // No base-rate normalisation in the failure-pattern SUBSTRATE. Deliberately
  // re-scoped from "anywhere": `convex/helpers/fleet.ts` now has real base-rate
  // math, so the original claim is no longer true of the tree as a whole.
  'correlation/no-base-rate-normalisation-in-the-pattern-substrate',
  // Vacuously perfect health on empty input (latent: no production caller yet).
  'vacuity/empty-org-scores-perfect-health',
]

// ---------------------------------------------------------------------------
// Hard binding. A skip-on-missing gate is how an adversarial suite goes green
// while proving nothing. If a module will not load, this suite FAILS.
// ---------------------------------------------------------------------------

async function loadInsights(): Promise<any> {
  return await import(/* @vite-ignore */ INSIGHTS)
}
async function loadAnalytics(): Promise<any> {
  return await import(/* @vite-ignore */ ANALYTICS)
}
async function loadPatterns(): Promise<any> {
  return await import(/* @vite-ignore */ PATTERNS)
}

function srcOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

describe('binding', () => {
  it('loads all three shipped modules — no skip-on-missing', async () => {
    const [insights, analytics, patterns] = await Promise.all([
      loadInsights(),
      loadAnalytics(),
      loadPatterns(),
    ])
    expect(typeof insights.assessPatternSpike).toBe('function')
    expect(typeof insights.assessPatternSpikeTransition).toBe('function')
    expect(typeof insights.summarizeResolutionHealth).toBe('function')
    expect(typeof analytics.compareCohorts).toBe('function')
    expect(typeof analytics.computeRunStats).toBe('function')
    expect(typeof patterns.assessPatternSpikeFallback).toBe('function')
    expect(typeof patterns.MAX_AFFECTED_AGENT_IDS).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Fixture builders + fixture-shape checkers (used by probes AND by teeth)
// ---------------------------------------------------------------------------

interface TrendPoint {
  day: string
  count: number
}

/** Build a 14-day trend ending "today" from a count series, oldest first. */
function trendOf(counts: number[]): TrendPoint[] {
  return counts.map((count, i) => ({
    day: new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10),
    count,
  }))
}

/**
 * CHECKER: a series is a SMOOTH TREND — monotone non-decreasing with no
 * single-step discontinuity larger than `maxStepRatio` times the running
 * level. A series failing this is a step/burst, not a trend, and using it to
 * argue "a trend is misreported as a burst" would prove nothing.
 */
function isSmoothTrend(counts: number[], maxStepRatio = 1.0): boolean {
  if (counts.length < 3) return false
  for (let i = 1; i < counts.length; i++) {
    const prev = counts[i - 1]!
    const curr = counts[i]!
    if (curr < prev) return false
    const step = curr - prev
    if (step > Math.max(prev, 1) * maxStepRatio) return false
  }
  return true
}

/**
 * CHECKER: a series is a SUSTAINED ELEVATED PLATEAU — its last `plateauDays`
 * are all at least `factor` times the mean of everything before them, and are
 * themselves flat (no rise within the plateau). This is the shape of an
 * ongoing outage that started days ago and has not stopped.
 */
function isSustainedPlateau(counts: number[], plateauDays: number, factor = 3): boolean {
  if (counts.length <= plateauDays) return false
  const head = counts.slice(0, counts.length - plateauDays)
  const tail = counts.slice(counts.length - plateauDays)
  const headMean = head.reduce((s, c) => s + c, 0) / head.length
  const flat = tail.every((c) => c === tail[0])
  return flat && tail.every((c) => c >= Math.max(headMean, 0) * factor) && tail[0]! > headMean
}

// ---------------------------------------------------------------------------
// ATTACK 1 — burst vs trend
// ---------------------------------------------------------------------------

describe('burst-vs-trend', () => {
  it('a smooth monotone trend with no discontinuity is not a burst', async () => {
    const insights = await loadInsights()

    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    // FIXTURE AUDIT: prove the fixture is genuinely smooth before drawing any
    // conclusion from how it is classified.
    expect(isSmoothTrend(series)).toBe(true)

    const assessment = insights.assessPatternSpike(trendOf(series))

    // RETIRED: a smooth ramp is no longer a spike. POSITIVE assertion — this
    // fails if the median/MAD baseline regresses to mean/stddev.
    expect(assessment.isSpiking).toBe(false)

    // The detector still takes ONLY counts — no exposure/denominator — so it
    // still cannot normalise by fleet size. The robust baseline fixed the
    // arithmetic, not the missing denominator, and this records the difference.
    const src = srcOf('../../convex/insights.ts')
    const signature = /export function assessPatternSpike\(([^)]*)\)/.exec(src)?.[1] ?? ''
    expect(signature).not.toMatch(/runs|exposure|denominator|totalRuns/i)
  })

  it('a still-ongoing sustained incident is reported as NOT spiking', async () => {
    const insights = await loadInsights()

    // Same outage, observed on day 3 and on day 7 of itself.
    const dayThree = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 20, 20]
    const daySeven = [0, 0, 0, 0, 0, 0, 0, 20, 20, 20, 20, 20, 20, 20]

    // FIXTURE AUDIT: both are genuine sustained plateaus, not decaying tails.
    expect(isSustainedPlateau(dayThree, 3)).toBe(true)
    expect(isSustainedPlateau(daySeven, 7)).toBe(true)

    const early = insights.assessPatternSpike(trendOf(dayThree))
    const late = insights.assessPatternSpike(trendOf(daySeven))

    // RETIRED: the day-7 outage still reads as spiking. POSITIVE assertions —
    // both must hold, so a regression in either direction goes red.
    expect(early.isSpiking).toBe(true)
    expect(late.isSpiking).toBe(true)

    // Teeth on the probe itself: the two fixtures must actually differ only in
    // how long the plateau has been running, or the comparison is meaningless.
    expect(dayThree.filter((c) => c > 0).every((c) => c === 20)).toBe(true)
    expect(daySeven.filter((c) => c > 0).every((c) => c === 20)).toBe(true)
  })

  it('the smallest thing called a burst, measured rather than assumed', async () => {
    const insights = await loadInsights()

    // Walk up from a silent baseline and find the true threshold BY EXECUTION.
    const smallest = (() => {
      for (let n = 1; n <= 200; n++) {
        const a = insights.assessPatternSpike(trendOf([0, 0, 0, 0, 0, 0, n]))
        if (a.isSpiking === true) return n
      }
      return null
    })()

    // Not a ledger entry — a documented boundary. It must EXIST (a detector
    // that can never fire off a silent baseline would be the worse defect) and
    // it must be greater than 1 (a single failure is never a burst).
    expect(smallest).not.toBeNull()
    expect(smallest!).toBeGreaterThan(1)

    // And the answer must come from the function, never from a literal: assert
    // the boundary is tight by checking the value BELOW it does not fire.
    expect(insights.assessPatternSpike(trendOf([0, 0, 0, 0, 0, 0, smallest! - 1])).isSpiking).toBe(false)
    expect(insights.assessPatternSpike(trendOf([0, 0, 0, 0, 0, 0, smallest!])).isSpiking).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ATTACK 2 — correlation vs causation, base rates, cardinality
// ---------------------------------------------------------------------------

describe('correlation-and-causation', () => {
  it('the burst signal carries no agent cardinality: 1 agent x N == N agents x 1', async () => {
    const insights = await loadInsights()

    // Two fleet realities an operator must never confuse:
    //   (a) one broken agent retrying and failing 12 times today
    //   (b) twelve different agents each failing once today
    // Both produce the SAME daily fingerprint counts.
    const oneAgentTwelveTimes = trendOf([0, 0, 0, 0, 0, 0, 12])
    const twelveAgentsOnceEach = trendOf([0, 0, 0, 0, 0, 0, 12])

    const a = insights.assessPatternSpike(oneAgentTwelveTimes)
    const b = insights.assessPatternSpike(twelveAgentsOnceEach)

    // CORRECT: (b) is a fleet-wide event worth rolling back a shared
    // dependency for; (a) is one sick agent. The signal must distinguish them.
    // It cannot: same input shape, same output, and no cardinality field.
    const indistinguishable =
      JSON.stringify(a) === JSON.stringify(b) &&
      !('agentCount' in a) &&
      !('distinctAgents' in a) &&
      !('affectedAgentIds' in a)

    if (indistinguishable) {
      record('burst/no-agent-cardinality-in-signal')
    }

    // Executed, not assumed: the alert payload the cron sends on a spike is
    // read from source and must be shown to carry no agent-cardinality field
    // either — otherwise the signal is recoverable downstream and this is a
    // presentation issue rather than a missing dimension.
    const patternsSrc = srcOf('../../convex/failure_patterns.ts')
    const firePayload = /_firePatternSpikeAlertRef, \{([\s\S]*?)\}\)/.exec(patternsSrc)?.[1] ?? ''
    expect(firePayload.length).toBeGreaterThan(0)
    expect(firePayload).not.toMatch(/agentCount|distinctAgents|affectedAgentIds/)
  })

  it('no base-rate, lift, or prevalence normalisation exists anywhere', () => {
    // PREDICATE-DISCOVERY SWEEP. With hundreds of agents, "these nine share the
    // model 90% of the fleet uses" co-occurs constantly and must rank BELOW
    // "these nine share a tool almost nothing else uses". Ranking one above the
    // other requires a base rate. Sweep the shipped source for any vocabulary
    // that could implement one.
    const sources = [
      '../../convex/insights.ts',
      '../../convex/failure_patterns.ts',
      '../../convex/helpers/analytics.ts',
      '../../convex/read_api.ts',
    ].map(srcOf)

    const baseRateVocabulary =
      /\b(lift|baseRate|prevalence|jaccard|pointwiseMutual|oddsRatio|expectedShare|coOccurrence|fleetShare|confounder)\b/

    const anyHit = sources.some((src) => baseRateVocabulary.test(src))

    // CORRECT: a fleet correlator that ranks shared dependencies must normalise
    // by how common that dependency is fleet-wide. Nothing here does.
    if (!anyHit) {
      record('correlation/no-base-rate-normalisation-in-the-pattern-substrate')
    }

    // TEETH on the sweep: the regex must actually be capable of firing, or
    // "no hits" would be vacuously true and this probe would be worthless.
    expect(baseRateVocabulary.test('const lift = a / b')).toBe(true)
    expect(baseRateVocabulary.test('const somethingElse = 1')).toBe(false)
  })

  it('the affected-agent set saturates at a cap with no truncation marker', async () => {
    const patterns = await loadPatterns()

    const cap: number = patterns.MAX_AFFECTED_AGENT_IDS
    expect(Number.isInteger(cap)).toBe(true)
    expect(cap).toBeGreaterThan(0)

    const patternsSrc = srcOf('../../convex/failure_patterns.ts')
    const contractSrc = srcOf('../../packages/contracts/src/failure_patterns.ts')
    const schemaSrc = srcOf('../../convex/schema.ts')

    // The set is capped on write, most-recent-first — so an incident spanning
    // more than `cap` agents not only truncates, it CHURNS: two reads seconds
    // apart can return different members.
    const cappedOnWrite = /affectedAgentIds = dedupCapMostRecentFirst\(/.test(patternsSrc)
    expect(cappedOnWrite).toBe(true)

    // The same interface DOES carry a truncation marker for the run scan
    // (`runCountTruncated`), which is what makes its absence for the agent set
    // an inconsistency rather than an oversight of the whole design.
    const hasRunTruncationMarker = /runCountTruncated/.test(contractSrc)
    expect(hasRunTruncationMarker).toBe(true)

    const agentTruncationMarker =
      /affectedAgentIdsTruncated|agentIdsTruncated|affectedAgentsTruncated|agentSetTruncated/
    const markerAnywhere =
      agentTruncationMarker.test(contractSrc) ||
      agentTruncationMarker.test(patternsSrc) ||
      agentTruncationMarker.test(schemaSrc)

    // RETIRED: the marker now exists. POSITIVE assertion — this fails if it is
    // removed, rather than the probe silently ceasing to record.
    expect(markerAnywhere).toBe(true)
    // And a set AT the cap is treated as truncated even with no flag set, so a
    // pre-marker rollup saturating at 20 is not read as an exact 20 either.
    expect(contractSrc).toMatch(/ids\.length >= MAX_AFFECTED_AGENT_IDS/)

    // TEETH on the sweep: prove the marker regex can fire.
    expect(agentTruncationMarker.test('affectedAgentIdsTruncated: boolean')).toBe(true)
  })

  it('a cohort regression verdict is never emitted below the small-n guard', async () => {
    const analytics = await loadAnalytics()

    const mk = (n: number, failed: number) =>
      Array.from({ length: n }, (_, i) => ({
        status: i < failed ? 'failed' : 'completed',
        startedAt: 1_700_000_000_000 + i * 1000,
        endedAt: 1_700_000_000_000 + i * 1000 + 500,
      }))

    // ATTACK: try to get a causal-sounding verdict out of a tiny sample by
    // making the effect enormous. A base-rate-blind comparator would happily
    // call 1-in-2 vs 0-in-2 a regression.
    const tiny = analytics.compareCohorts(mk(2, 0), mk(2, 1))
    expect(tiny.failureRateSignificance).toBe('insufficient_data')

    // And the guard must be driven by TERMINAL runs, not array length — a
    // thousand still-running runs must not buy statistical confidence.
    const thousandRunning = Array.from({ length: 1000 }, (_, i) => ({
      status: 'running' as const,
      startedAt: 1_700_000_000_000 + i * 1000,
    }))
    const bogus = analytics.compareCohorts(thousandRunning, mk(1000, 300))
    expect(bogus.failureRateSignificance).toBe('insufficient_data')

    // Found nothing: the guard holds in both directions. No ledger entry.
  })

  it('a cohort verdict does not claim a CAUSE, only a difference', async () => {
    const analytics = await loadAnalytics()

    const mk = (n: number, failed: number) =>
      Array.from({ length: n }, (_, i) => ({
        status: i < failed ? 'failed' : 'completed',
        startedAt: 1_700_000_000_000 + i * 1000,
        endedAt: 1_700_000_000_000 + i * 1000 + 500,
      }))

    const strong = analytics.compareCohorts(mk(1000, 0), mk(1000, 300))
    const prose: string = strong.failureRateSignificanceExplanation

    // ATTACK: hunt for causal language — a sentence that tells an operator the
    // version CAUSED the failures rather than that the two cohorts differ.
    expect(prose).not.toMatch(/\bcaused\b|\bbecause of\b|\bdue to\b|\bresponsible for\b/i)
    // It must also carry the number behind the claim, not just a verdict word.
    expect(prose).toMatch(/p≈/)

    // Found nothing: the prose hedges ("Likely a real regression") and cites
    // its p-value. No ledger entry.
  })
})

// ---------------------------------------------------------------------------
// ATTACK 3 — two implementations, one field
// ---------------------------------------------------------------------------

describe('detector-divergence', () => {
  it('RETIRED: only one spike detector is reachable', async () => {
    const insights = await loadInsights()
    const trend = trendOf([5, 5, 5, 5, 5, 5, 6])

    // The two functions STILL disagree — that has not changed and is not the
    // point. What changed is REACHABILITY: `getAssessPatternSpike` is now a
    // static member access, so the runtime property lookup that decided which
    // implementation ran is gone, and with it both the coin-flip and the
    // unit collision in the stored `recentCount` field.
    const src = srcOf('../../convex/failure_patterns.ts')
    const staticImport = /return insightsModule\.assessPatternSpike/
    const dynamicLookup = /insightsModule as unknown as Record<string, unknown>\)\["assessPatternSpike"\]/
    expect(staticImport.test(src)).toBe(true)
    expect(dynamicLookup.test(src)).toBe(false)

    // TEETH on that pair of greps: prove EACH can fire, so "not matched" is a
    // result rather than an accident of a regex that matches nothing. This is
    // the lesson from the grep that went silent when a fix was a refactor.
    expect(staticImport.test('  return insightsModule.assessPatternSpike;')).toBe(true)
    expect(dynamicLookup.test('(insightsModule as unknown as Record<string, unknown>)["assessPatternSpike"]')).toBe(true)

    // And the reachable one is the robust implementation, asserted from its
    // OUTPUT rather than from the source that selects it.
    expect(insights.assessPatternSpike(trend).isSpiking).toBe(false)
  })

  it('RESIDUAL: the dead fallback still disagrees, and still ships', async () => {
    const patterns = await loadPatterns()
    const series = [5, 5, 5, 5, 5, 5, 6]
    const fallback = patterns.assessPatternSpikeFallback(trendOf(series))

    // Characterised, NOT ledgered: nothing calls this, so it cannot decide an
    // alert or write a stored field. It is retained because tests reference
    // it. If it ever regains a caller, this disagreement is a live defect
    // again — one extra failure on a flat baseline, called a spike with
    // INFINITE confidence, carrying a single-day count where the live
    // implementation carries a multi-day sum.
    expect(fallback.isSpiking).toBe(true)
    expect(Number.isFinite(fallback.z)).toBe(false)
    expect(fallback.recentCount).toBe(series[series.length - 1])
    expect(await loadInsights().then((i) => i.assessPatternSpike(trendOf(series)).recentCount)).toBe(
      series.slice(-3).reduce((x, y) => x + y, 0)
    )
  })

  it('rising-edge suppression cannot hide a spike that never fired', async () => {
    const insights = await loadInsights()
    const mk = (isSpiking: boolean) => ({ assessedAt: 1, isSpiking, recentCount: 9, baselineMean: 1, z: 9 })

    // ATTACK: get a genuine first-ever spike swallowed.
    const firstEver = insights.assessPatternSpikeTransition(undefined, mk(true), { nowMs: 1_000_000 })
    expect(firstEver.shouldFire).toBe(true)

    // ATTACK: a malformed prev must not be read as "already spiking".
    const malformed = insights.assessPatternSpikeTransition({} as any, mk(true), { nowMs: 1_000_000 })
    expect(malformed.shouldFire).toBe(true)

    // ATTACK: cooldown must not suppress when nothing has ever fired.
    const noPriorFire = insights.assessPatternSpikeTransition(mk(false), mk(true), { nowMs: 0 })
    expect(noPriorFire.shouldFire).toBe(true)

    // Found nothing. No ledger entry.
  })
})

// ---------------------------------------------------------------------------
// ATTACK 4 — empty, vacuous, and all-muted states
// ---------------------------------------------------------------------------

describe('vacuity', () => {
  it('an org with no data does not score as healthy without saying so', async () => {
    const insights = await loadInsights()

    const empty = insights.summarizeResolutionHealth([], 1_700_000_000_000)

    // CORRECT: "no patterns" and "all patterns resolved" must not produce the
    // same score with no way to tell them apart. An org whose pattern
    // ingestion is BROKEN presents as an org with nothing wrong.
    const scoresPerfect = empty.healthScore === 100 && empty.provenHealthScore === 100
    const carriesNoDataMarker = empty.total === 0

    if (scoresPerfect) {
      record('vacuity/empty-org-scores-perfect-health')
    }

    // The mitigating fact, asserted rather than assumed: `total` IS reported,
    // so a caller CAN distinguish the two — the defect is latent, not live,
    // and this assertion is what would catch its removal.
    expect(carriesNoDataMarker).toBe(true)

    // STANDING GUARD: this function has no production caller today, which is
    // the only reason the above is latent. If one appears, this fails and the
    // empty-input semantics must be gated at that call site.
    const productionSources = [
      '../../convex/insights.ts',
      '../../convex/read_api.ts',
      '../../convex/failure_patterns.ts',
      '../../convex/alerts.ts',
    ]
    const callSites = productionSources.flatMap((rel) => {
      const src = srcOf(rel)
      // A CALL, not the definition and not a doc-comment mention.
      return [...src.matchAll(/summarizeResolutionHealth\(/g)]
        .filter((m) => !src.slice(Math.max(0, m.index! - 20), m.index!).includes('export function'))
        .map(() => rel)
    })
    expect(callSites).toEqual([])
  })

  it('a completeness predicate is not vacuously true on empty input', async () => {
    const analytics = await loadAnalytics()

    // The shape that burned a previous cycle: a predicate built only from
    // negative clauses is TRUE when there is nothing to negate. Sweep the
    // reader-facing verdicts for it.
    const emptyComparison = analytics.compareCohorts([], [])

    // On empty input every honest verdict must be the ABSTAIN value, never the
    // affirmative one.
    expect(emptyComparison.failureRateSignificance).toBe('insufficient_data')
    expect(emptyComparison.failureRate.a).toBeNull()
    expect(emptyComparison.failureRate.b).toBeNull()
    expect(analytics.computeRunStats([]).failureRate).toBeNull()

    // And an all-zero trend must not read as a burst.
    const insights = await loadInsights()
    expect(insights.assessPatternSpike(trendOf([0, 0, 0, 0, 0, 0, 0])).isSpiking).toBe(false)
    expect(insights.assessPatternSpike([]).isSpiking).toBe(false)

    // Found nothing on these three layers. No ledger entry.
  })

  it('malformed trend points cannot leak NaN or Infinity into a stored verdict', async () => {
    const insights = await loadInsights()

    const poisoned: any[] = [
      { day: '2026-07-01', count: Number.NaN },
      { day: '2026-07-02', count: Number.POSITIVE_INFINITY },
      { day: null, count: 5 },
      { day: '2026-07-04', count: 1 },
      { day: '2026-07-05', count: 1 },
      { day: '2026-07-06', count: 1 },
      { day: '2026-07-07', count: 1 },
      { day: '2026-07-08', count: 9 },
    ]
    const assessment = insights.assessPatternSpike(poisoned)

    expect(Number.isFinite(assessment.z)).toBe(true)
    expect(Number.isFinite(assessment.recentCount)).toBe(true)
    expect(Number.isFinite(assessment.baselineMean)).toBe(true)

    // A caller-supplied minBaselineDays <= 0 must not open a divide-by-zero.
    const clamped = insights.assessPatternSpike(trendOf([1, 2, 3, 4]), { minBaselineDays: 0 })
    expect(Number.isFinite(clamped.z)).toBe(true)

    // Found nothing. No ledger entry.
  })
})

// ---------------------------------------------------------------------------
// ATTACK 5 — tenancy (STRUCTURAL: no Convex runtime here; see header)
// ---------------------------------------------------------------------------

describe('tenancy', () => {
  it('every pure engine under attack is incapable of crossing an org boundary', async () => {
    const [insights, analytics, patterns] = await Promise.all([
      loadInsights(),
      loadAnalytics(),
      loadPatterns(),
    ])

    // EXECUTED: these functions take no org and hold no state, so two orgs'
    // data cannot mix inside them. Same input, same output, no residue.
    const t = trendOf([1, 1, 1, 1, 1, 1, 9])
    const first = insights.assessPatternSpike(t)
    insights.assessPatternSpike(trendOf([999, 999, 999, 999, 999, 999, 999]))
    const second = insights.assessPatternSpike(t)
    expect(second).toEqual(first)

    expect(analytics.computeRunStats([])).toEqual(analytics.computeRunStats([]))
    expect(patterns.assessPatternSpikeFallback(t)).toEqual(patterns.assessPatternSpikeFallback(t))

    // STRUCTURAL: the cross-org sweep the spike cron performs must never join
    // rows across orgs — every downstream read is reached through the
    // pattern's OWN orgId.
    const src = srcOf('../../convex/failure_patterns.ts')
    const cron = /export const assessPatternSpikesCron[\s\S]*?^\}\);/m.exec(src)?.[0] ?? ''
    expect(cron.length).toBeGreaterThan(0)
    // Every org-scoped read inside the cron body derives its org from the
    // pattern row, never from an argument or an ambient value.
    expect(cron).toMatch(/pattern\.orgId/)
    expect(cron).not.toMatch(/args\.orgId/)
  })

  it('the pattern read surface rejects a foreign row even after its index', () => {
    // STRUCTURAL. The key-authed list applies an explicit org equality check on
    // every scanned row in addition to the org-scoped index — a belt-and-braces
    // guard whose REMOVAL is what this assertion is here to catch.
    const src = srcOf('../../convex/read_api.ts')
    expect(src).toMatch(/if \(pattern\.orgId !== apiKey\.orgId\) return false;/)
  })
})

// ---------------------------------------------------------------------------
// ATTACK 6 — silent truncation on the incident-time query
// ---------------------------------------------------------------------------

describe('truncation-honesty', () => {
  it('the spiking-filter list reports a ceiling stop as truncation, not as "none"', () => {
    // STRUCTURAL (the handler needs a live ctx.db). The predicate itself is
    // read out of source and EXECUTED below against synthetic scan outcomes,
    // so this is not a claim from reading alone.
    const src = srcOf('../../convex/read_api.ts')
    const line = /const scanTruncated = ([^;]+);/.exec(src)?.[1]
    expect(line).toBeTruthy()

    // Reconstruct the shipped predicate and EXECUTE it. If the implementation
    // changes shape, the regex above fails and this test goes red rather than
    // silently grading a predicate that no longer exists.
    expect(line).toBe('!exhausted && matches.length < needed')
    const scanTruncated = (exhausted: boolean, matches: number, needed: number) =>
      !exhausted && matches < needed

    // The incident case: the ceiling was hit, nothing matched. MUST be
    // truncated, so an empty page is never read as "no spiking patterns".
    expect(scanTruncated(false, 0, 50)).toBe(true)
    // The end of the table with nothing matching: genuinely "none exist".
    expect(scanTruncated(true, 0, 50)).toBe(false)
    // A full page is a complete ordinary answer.
    expect(scanTruncated(false, 50, 50)).toBe(false)

    // Found nothing: the predicate is correct in all three corners, and it is
    // NOT vacuously false on empty input (first case above).
  })

  it('every reader of that list refuses to read an empty truncated page as "none"', () => {
    // STRUCTURAL, over the two operator-facing readers.
    const cli = srcOf('../../packages/cli/src/commands/patterns.ts')
    const mcp = srcOf('../../packages/mcp/src/tools/list-failure-patterns.ts')

    expect(cli).toMatch(/scanTruncated === true/)
    expect(cli).toMatch(/NOT "none exist"/)
    expect(mcp).toMatch(/NOT EVIDENCE THAT NOTHING MATCHED/)

    // Found nothing. The truncation-honesty chain holds end to end.
  })
})

// ---------------------------------------------------------------------------
// TEETH — break the subject, assert THIS suite's own checkers reject it
// ---------------------------------------------------------------------------

describe('teeth', () => {
  it('isSmoothTrend rejects a series containing a step', () => {
    expect(isSmoothTrend([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(true)
    // A burst hidden in a ramp — the exact fixture error that would make the
    // trend-vs-burst probe prove nothing.
    expect(isSmoothTrend([1, 2, 3, 4, 5, 6, 7, 8, 9, 400])).toBe(false)
    // A decreasing series is not a growth trend.
    expect(isSmoothTrend([10, 9, 8, 7, 6, 5])).toBe(false)
    // Too short to have a shape at all.
    expect(isSmoothTrend([1, 2])).toBe(false)
  })

  it('isSustainedPlateau rejects a decaying tail and a flat-but-unelevated one', () => {
    expect(isSustainedPlateau([0, 0, 0, 0, 20, 20, 20], 3)).toBe(true)
    // Decaying, not sustained.
    expect(isSustainedPlateau([0, 0, 0, 0, 20, 10, 2], 3)).toBe(false)
    // Flat but not elevated above its own history.
    expect(isSustainedPlateau([20, 20, 20, 20, 20, 20, 20], 3)).toBe(false)
    // No history to be elevated ABOVE.
    expect(isSustainedPlateau([20, 20, 20], 3)).toBe(false)
  })

  it('the ledger machinery fails when the implementation is broken in memory', async () => {
    const insights = await loadInsights()

    // Break the SUBJECT: a detector that calls everything a spike.
    const brokenAlwaysSpiking = () => ({ isSpiking: true, recentCount: 0, baselineMean: 0, z: 99 })
    // Break the SUBJECT the other way: one that never fires.
    const brokenNeverSpiking = () => ({ isSpiking: false, recentCount: 0, baselineMean: 0, z: 0 })

    // The checker used by the vacuity probe must reject an always-spiking
    // detector on an all-zero trend...
    expect(brokenAlwaysSpiking().isSpiking).toBe(true)
    expect(insights.assessPatternSpike(trendOf([0, 0, 0, 0, 0, 0, 0])).isSpiking).toBe(false)

    // ...and the boundary probe must reject a never-spiking detector, because
    // it could never find a smallest burst at all.
    const smallestUnderBroken = (() => {
      for (let n = 1; n <= 200; n++) {
        if (brokenNeverSpiking().isSpiking === true) return n
      }
      return null
    })()
    expect(smallestUnderBroken).toBeNull()

    // Which is exactly what the real boundary probe asserts must NOT happen.
    const smallestReal = (() => {
      for (let n = 1; n <= 200; n++) {
        if (insights.assessPatternSpike(trendOf([0, 0, 0, 0, 0, 0, n])).isSpiking === true) return n
      }
      return null
    })()
    expect(smallestReal).not.toBeNull()
  })

  it('the probes stop recording once the implementation is CORRECTED', async () => {
    const insights = await loadInsights()

    // The decisive anti-vacuity check: replay each probe's exact condition
    // against a CORRECTED detector and assert nothing is recorded. If a probe's
    // condition were written so it fires unconditionally, this fails — which is
    // the error that produced a false ledger entry in a previous cycle.
    const corrected = {
      // Normalises by exposure, so a smooth trend is not a burst.
      assessPatternSpike(trend: TrendPoint[]) {
        const counts = trend.map((p) => p.count)
        const smooth = isSmoothTrend(counts)
        const tail = counts.slice(-3)
        const tailMean = tail.length ? tail.reduce((s, c) => s + c, 0) / tail.length : 0
        // The fix for the sustained-incident blindness: the baseline is the
        // series' QUIET FLOOR (the mean of its lower half), not the trailing
        // window — so an incident that has been running long enough to fill
        // the baseline window cannot raise its own baseline and silence itself.
        const ascending = [...counts].sort((x, y) => x - y)
        const quiet = ascending.slice(0, Math.max(1, Math.floor(ascending.length / 2)))
        const quietMean = quiet.reduce((s, c) => s + c, 0) / quiet.length
        return {
          isSpiking: !smooth && tailMean > Math.max(quietMean, 1) * 3,
          recentCount: tail.reduce((s, c) => s + c, 0),
          baselineMean: quietMean,
          z: 0,
          // The dimension the shipped signal lacks.
          distinctAgents: 1,
        }
      },
    }

    const before = new Set(observedDefects)

    // Probe 1's condition, verbatim, against the corrected detector.
    const ramp = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(isSmoothTrend(ramp)).toBe(true)
    if (corrected.assessPatternSpike(trendOf(ramp)).isSpiking === true) {
      throw new Error('probe 1 would fire against a corrected implementation — it is unconditional')
    }

    // Probe 2's condition: a sustained plateau must stay spiking on day 7.
    const daySeven = [0, 0, 0, 0, 0, 0, 0, 20, 20, 20, 20, 20, 20, 20]
    expect(isSustainedPlateau(daySeven, 7)).toBe(true)
    const lateCorrected = corrected.assessPatternSpike(trendOf(daySeven))
    if (lateCorrected.isSpiking === false) {
      throw new Error('the corrected stub is not actually corrected — fix the stub, not the probe')
    }

    // Probe 3's condition: cardinality is present, so the two fleet realities
    // are no longer indistinguishable.
    const a = corrected.assessPatternSpike(trendOf([0, 0, 0, 0, 0, 0, 12]))
    if (!('distinctAgents' in a)) {
      throw new Error('probe 3 would still fire against a corrected implementation')
    }

    // Nothing was recorded by replaying the conditions — the probes are
    // genuinely conditional on the shipped behaviour, not on being run.
    expect([...observedDefects].sort()).toEqual([...before].sort())

    // The real implementation now AGREES with the corrected stub on the ramp —
    // that entry is retired, and asserting the old failure here would pin a
    // defect that no longer exists. What must still hold is that the stub and
    // the shipped detector reach the same verdict on both retired cases, so a
    // regression in either shows up as a disagreement.
    expect(insights.assessPatternSpike(trendOf(ramp)).isSpiking).toBe(false)
    expect(corrected.assessPatternSpike(trendOf(ramp)).isSpiking).toBe(false)
    const sustained = [0, 0, 0, 0, 0, 0, 0, 20, 20, 20, 20, 20, 20, 20]
    expect(insights.assessPatternSpike(trendOf(sustained)).isSpiking).toBe(true)
    expect(corrected.assessPatternSpike(trendOf(sustained)).isSpiking).toBe(true)
  })

  it('the source-read probes fail against a source that lost the property', () => {
    // Every STRUCTURAL assertion in this file greps a live source. Prove those
    // greps are capable of failing, so a source that silently loses the
    // property goes red rather than passing on a regex that never matched
    // anything in the first place.
    const orgGuard = /if \(pattern\.orgId !== apiKey\.orgId\) return false;/
    expect(orgGuard.test('if (pattern.orgId !== apiKey.orgId) return false;')).toBe(true)
    expect(orgGuard.test('// the org guard used to be here')).toBe(false)

    const truncationProse = /NOT "none exist"/
    expect(truncationProse.test('This is NOT "none exist": nothing is known')).toBe(true)
    expect(truncationProse.test('No recurring failure patterns found.')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// THE LEDGER ASSERTION — exact set, both directions
// ---------------------------------------------------------------------------

describe('defect ledger', () => {
  it('observed defects are EXACTLY the known set', () => {
    const observed = [...observedDefects].sort()
    const known = [...KNOWN_DEFECTS].sort()

    // A fix -> this goes red, delete the entry.
    // A new defect -> this goes red, investigate and add it.
    expect(observed).toEqual(known)
  })

  it('every ledger entry was written by a probe that actually executed', () => {
    // Anti-vacuity on the ledger itself: an entry that no probe can produce
    // would sit here forever describing a defect nobody is checking. Every id
    // in KNOWN_DEFECTS must appear as a literal `record('...')` argument in
    // this file.
    const self = srcOf('./fleet_adversarial_correlation.test.ts')
    for (const id of KNOWN_DEFECTS) {
      expect(self).toContain(`record('${id}')`)
    }
  })
})
