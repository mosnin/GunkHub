/**
 * versionNarrative.ts — "what changed between versions" plain-English
 * narrative, Explainability Layer cycle 2 (Team C).
 *
 * Backs `GET /api/agents/[agentId]/versions/compare?a=&b=&explain=1`
 * (apps/web/app/api/agents/[agentId]/versions/compare/route.ts), which wraps
 * Team B's `convex/insights.ts` `compareVersions` query. This module is a
 * PURE, deterministic, dependency-free function of that query's numbers —
 * no Next.js, no Clerk, no Convex client, no network — so it is unit-testable
 * in isolation (see tests/unit/version_narrative.test.ts).
 *
 * GROUNDING GUARANTEE: every sentence this module produces is built ONLY from
 * numbers present on `VersionNarrativeInput`. It never invents a tool name, a
 * count, or a cause. Two consequences of that:
 *
 *   1. `insufficient_data` / `inconclusive` verdicts get an honest "not
 *      enough data" / "not statistically significant" narrative — never a
 *      fabricated regression story.
 *   2. The "most common new failure class" clause (the `tool_timeout on
 *      search_docs` part of the brief's example narrative) is INCLUDED ONLY
 *      IF the caller supplies `failureClassCounts` (and, for the "on X" tool
 *      detail, `failureClassExamples`) on BOTH cohorts.
 *
 * Cycle 3 update: `narrativeInputFromComparison` (below) now reads
 * `raw.versionA.failureClassCounts` / `raw.versionB.failureClassCounts`
 * (plus the parallel `failureClassExamples` map) directly off each cohort,
 * per Team B's cycle-3 addition to `compareVersions`'s `VersionCohortSummary`
 * (`convex/insights.ts`) — a per-version breakdown of `HeuristicFailureClass`
 * counts sourced from `run_explanations.failureClass`, grouped by
 * `agentVersionId`. The fields are OPTIONAL on `RawVersionCohort` precisely
 * because they are optional at the Convex layer too (an older cached
 * `compareVersions` response, or a cohort with zero failed runs to classify,
 * may omit them) — this module still produces a complete, honest narrative
 * without the failure-class clause whenever either side is missing.
 */

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export type VersionNarrativeSignificance =
  | 'likely_regression'
  | 'likely_improvement'
  | 'inconclusive'
  | 'insufficient_data'

/**
 * One cohort's (one agent version's) numbers, as needed for the narrative.
 * `failureRate` mirrors `CohortComparison.failureRate.a` / `.b`
 * (convex/helpers/analytics.ts) — a 0..1 fraction over TERMINAL runs, or
 * `null` when the cohort has zero terminal runs.
 */
export interface VersionNarrativeCohort {
  /** Human-readable version label, e.g. "1.4". Rendered as "v1.4". */
  version: string
  /** Terminal-run sample size this cohort's failureRate is computed over. */
  sampleSize: number
  failureRate: number | null
  /**
   * OPTIONAL, NOT YET AVAILABLE from `compareVersions` as of this cycle (see
   * file header) — per-version failure-class counts, e.g.
   * `{ tool_timeout: 12, tool_error: 3 }`. Keys are expected to be
   * `HeuristicFailureClass` values (convex/insights.ts) but are treated as
   * opaque strings here — this module does not validate the taxonomy, only
   * compares counts. Omit entirely (rather than passing `{}`) when the data
   * isn't available; `{}` is treated as "no failures classified", which is a
   * different (and misleading) claim than "we don't have this breakdown".
   */
  failureClassCounts?: Record<string, number>
  /**
   * OPTIONAL — a representative concrete detail per failure class (e.g. a
   * tool name: `{ tool_timeout: "search_docs" }`), used ONLY to append an
   * "on <detail>" clause to the failure-class sentence. Never fabricated by
   * this module — if a class has no entry here, the sentence omits the
   * "on X" clause for that class rather than guessing.
   */
  failureClassExamples?: Record<string, string>
}

export interface VersionNarrativeInput {
  versionA: VersionNarrativeCohort
  versionB: VersionNarrativeCohort
  significance: VersionNarrativeSignificance
}

export interface VersionNarrativeResult {
  narrative: string
  significance: VersionNarrativeSignificance
  /** True iff a failure-class clause was included (both cohorts supplied `failureClassCounts`). */
  usedFailureClassBreakdown: boolean
  /** The failure class cited in the narrative, if any (only set when `usedFailureClassBreakdown` is true and a class could be identified). */
  citedFailureClass?: string
}

// ---------------------------------------------------------------------------
// Adapter: raw `convex/insights.ts` `compareVersions` result -> this
// module's input shape. Kept in this file (rather than
// services/versionCompareNarrative.ts, which does the actual Convex
// fetch) so it stays free of Next.js/Clerk/Convex-client imports and is
// directly unit-testable — services/versionCompareNarrative.ts imports
// THIS adapter, not the other way around.
// ---------------------------------------------------------------------------

/** Structural subset of `compareVersions`'s real return shape this module needs. */
export interface RawVersionCohort {
  version: string
  sampleSize: number
  /**
   * Team B's cycle-3 addition to `VersionCohortSummary` — per-version
   * `HeuristicFailureClass` counts. Optional: a cohort with zero classified
   * failures (or an older response predating this field) omits it. Treated
   * as opaque strings here, same as `VersionNarrativeCohort.failureClassCounts`.
   */
  failureClassCounts?: Record<string, number>
  /** Optional per-class representative detail (e.g. a tool name), same shape as `VersionNarrativeCohort.failureClassExamples`. */
  failureClassExamples?: Record<string, string>
}

export interface RawCohortComparison {
  failureRate: { a: number | null; b: number | null }
  failureRateSignificance: VersionNarrativeSignificance
}

export interface RawVersionComparison {
  agentId: string
  versionA: RawVersionCohort
  versionB: RawVersionCohort
  comparison: RawCohortComparison
}

/**
 * Adapts a raw `compareVersions` result into `VersionNarrativeInput`.
 * `failureClassCounts` / `failureClassExamples` are passed through verbatim
 * from each cohort — never synthesized, never defaulted to `{}` when the
 * source field is `undefined` (see `VersionNarrativeCohort.failureClassCounts`'s
 * doc: `{}` and `undefined` are different, non-interchangeable claims).
 * `buildVersionNarrative` only activates the failure-class clause when BOTH
 * cohorts carry a non-undefined map, so an older/partial `compareVersions`
 * response (one side missing the field) still yields a complete, honest
 * narrative without that clause.
 */
export function narrativeInputFromComparison(raw: RawVersionComparison): VersionNarrativeInput {
  return {
    versionA: {
      version: raw.versionA.version,
      sampleSize: raw.versionA.sampleSize,
      failureRate: raw.comparison.failureRate.a,
      ...(raw.versionA.failureClassCounts !== undefined && {
        failureClassCounts: raw.versionA.failureClassCounts,
      }),
      ...(raw.versionA.failureClassExamples !== undefined && {
        failureClassExamples: raw.versionA.failureClassExamples,
      }),
    },
    versionB: {
      version: raw.versionB.version,
      sampleSize: raw.versionB.sampleSize,
      failureRate: raw.comparison.failureRate.b,
      ...(raw.versionB.failureClassCounts !== undefined && {
        failureClassCounts: raw.versionB.failureClassCounts,
      }),
      ...(raw.versionB.failureClassExamples !== undefined && {
        failureClassExamples: raw.versionB.failureClassExamples,
      }),
    },
    significance: raw.comparison.failureRateSignificance,
  }
}

/** Convenience: adapt + build in one call. */
export function narrateVersionComparison(raw: RawVersionComparison): VersionNarrativeResult {
  return buildVersionNarrative(narrativeInputFromComparison(raw))
}

// ---------------------------------------------------------------------------
// Simplified verdict label — for consumers that want "regression" rather
// than "likely_regression". Team E's `VersionCompareNarrativeVerdict`
// (apps/web/src/lib/services/agent_versions.ts, written against a guessed
// contract ahead of this route shipping) uses this simplified 4-value set;
// the route echoes both this and the full `VersionNarrativeSignificance` so
// neither consumer has to be the "wrong" one.
// ---------------------------------------------------------------------------

export type SimpleVersionNarrativeVerdict = 'regression' | 'improvement' | 'inconclusive' | 'insufficient_data'

const SIGNIFICANCE_TO_SIMPLE_VERDICT: Record<VersionNarrativeSignificance, SimpleVersionNarrativeVerdict> = {
  likely_regression: 'regression',
  likely_improvement: 'improvement',
  inconclusive: 'inconclusive',
  insufficient_data: 'insufficient_data',
}

export function toSimpleVerdict(significance: VersionNarrativeSignificance): SimpleVersionNarrativeVerdict {
  return SIGNIFICANCE_TO_SIMPLE_VERDICT[significance]
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure, no locale surprises — fixed en-US-ish output)
// ---------------------------------------------------------------------------

function formatPct(rate: number | null): string {
  if (rate === null) return 'n/a'
  return `${Math.round(rate * 100)}%`
}

function versionLabel(v: string): string {
  return v.startsWith('v') ? v : `v${v}`
}

// ---------------------------------------------------------------------------
// Failure-class clause — only built when BOTH cohorts supply the breakdown
// ---------------------------------------------------------------------------

interface FailureClassClause {
  sentence: string
  citedFailureClass: string
}

/**
 * Picks the failure class with the largest increase from A to B (a "new/
 * worsening" failure class), among classes with a positive count in B.
 * Falls back to B's single most common failure class (dropping the word
 * "new") if no class actually increased vs A — still grounded, just a
 * weaker claim. Returns `undefined` if B has no classified failures at all.
 */
function buildFailureClassClause(
  a: Record<string, number>,
  b: Record<string, number>,
  bExamples: Record<string, string> | undefined,
): FailureClassClause | undefined {
  const bClasses = Object.entries(b).filter(([, count]) => count > 0)
  if (bClasses.length === 0) return undefined

  let bestClass: string | undefined
  let bestDelta = -Infinity
  for (const [cls, countB] of bClasses) {
    const countA = a[cls] ?? 0
    const delta = countB - countA
    if (delta > bestDelta) {
      bestDelta = delta
      bestClass = cls
    }
  }
  if (!bestClass) return undefined

  const example = bExamples?.[bestClass]
  const onClause = example ? ` on ${example}` : ''
  const isNew = bestDelta > 0

  const sentence = isNew
    ? `The most common new failure class is ${bestClass}${onClause}.`
    : `The most common failure class is ${bestClass}${onClause}.`

  return { sentence, citedFailureClass: bestClass }
}

// ---------------------------------------------------------------------------
// buildVersionNarrative — the main entry point
// ---------------------------------------------------------------------------

export function buildVersionNarrative(input: VersionNarrativeInput): VersionNarrativeResult {
  const { versionA, versionB, significance } = input
  const labelA = versionLabel(versionA.version)
  const labelB = versionLabel(versionB.version)

  if (significance === 'insufficient_data') {
    return {
      narrative:
        `Not enough data to say whether ${labelB} is better or worse than ${labelA} yet ` +
        `(${labelA}: ${versionA.sampleSize} runs, ${labelB}: ${versionB.sampleSize} runs).`,
      significance,
      usedFailureClassBreakdown: false,
    }
  }

  if (significance === 'inconclusive') {
    return {
      narrative:
        `${labelB}'s failure rate (${formatPct(versionB.failureRate)}) vs ${labelA}'s ` +
        `(${formatPct(versionA.failureRate)}) is not statistically significant yet — could be noise.`,
      significance,
      usedFailureClassBreakdown: false,
    }
  }

  // likely_regression | likely_improvement
  const verdictLabel = significance === 'likely_regression' ? 'likely regression' : 'likely improvement'
  let narrative =
    `${labelB} fails ${formatPct(versionB.failureRate)} vs ${labelA}'s ${formatPct(versionA.failureRate)} ` +
    `(${verdictLabel}, p<0.05).`

  let usedFailureClassBreakdown = false
  let citedFailureClass: string | undefined

  if (versionA.failureClassCounts && versionB.failureClassCounts) {
    const clause = buildFailureClassClause(
      versionA.failureClassCounts,
      versionB.failureClassCounts,
      versionB.failureClassExamples,
    )
    if (clause) {
      narrative += ` ${clause.sentence}`
      usedFailureClassBreakdown = true
      citedFailureClass = clause.citedFailureClass
    }
  }

  return {
    narrative,
    significance,
    usedFailureClassBreakdown,
    ...(citedFailureClass !== undefined && { citedFailureClass }),
  }
}
