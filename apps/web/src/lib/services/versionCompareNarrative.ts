/**
 * versionCompareNarrative.ts — service layer (I/O) backing
 * `GET /api/agents/[agentId]/versions/compare?a=&b=&explain=1`
 * (Team C, Explainability Layer cycle 2).
 *
 * Unlike `services/agent_versions.ts`'s existing `compareVersions` (which
 * swallows every failure into `{ available: false }` for its "quiet" UI
 * picker use case), `fetchVersionComparisonRaw` here THROWS on failure so
 * the route's `mapApiError` can produce a real 401/403/404/422 instead of a
 * silent empty state — matching the brief's "route's auth + error mapping"
 * requirement.
 *
 * This file intentionally contains ONLY the Convex I/O — the narrative
 * adaptation logic it feeds (`narrativeInputFromComparison` /
 * `narrateVersionComparison`) lives in the dependency-free
 * `@/lib/versionNarrative` so that module stays importable from a plain
 * vitest run with no Next.js/Clerk/Convex-client resolution required (see
 * tests/unit/version_narrative.test.ts). This file is re-exported here
 * purely for the route's convenience (one import instead of two).
 */
import type { RawVersionComparison as NarrativeRawVersionComparison } from '@/lib/versionNarrative'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId } from '@/lib/convexServer'

export { narrateVersionComparison, narrativeInputFromComparison } from '@/lib/versionNarrative'
export { resolveConvexOrgId }

// ---------------------------------------------------------------------------
// Full passthrough shape — a superset of versionNarrative.ts's
// `RawVersionComparison` (which only declares the fields it actually reads).
// Team E's UI gets the full cohort stats (countsByStatus, scanned/truncated/
// exact, all the CohortComparison metric deltas); the narrative adapter only
// reads the subset it needs.
// ---------------------------------------------------------------------------

export interface RawVersionCohort {
  id: string
  version: string
  sampleSize: number
  scanned: number
  truncated: boolean
  exact: boolean
  countsByStatus: Record<string, number>
  /**
   * Team B's cycle-3 addition to `VersionCohortSummary` (`convex/insights.ts`)
   * — per-version `HeuristicFailureClass` counts, sourced from
   * `run_explanations.failureClass`. Optional (a cohort with no classified
   * failures, or a response from before this field existed, omits it) — see
   * `@/lib/versionNarrative`'s `RawVersionCohort` for the same optionality
   * and the grounding contract this feeds.
   */
  failureClassCounts?: Record<string, number>
  /** Optional per-class representative detail (e.g. a tool name). */
  failureClassExamples?: Record<string, string>
}

export interface RawCohortComparison {
  cohortASize: number
  cohortBSize: number
  failureRate: { a: number | null; b: number | null; absoluteChange: number | null; relativeChange: number | null }
  failureRateSignificance: NarrativeRawVersionComparison['comparison']['failureRateSignificance']
  failureRateSignificanceExplanation: string
  [key: string]: unknown
}

export interface RawVersionComparison {
  agentId: string
  versionA: RawVersionCohort
  versionB: RawVersionCohort
  comparison: RawCohortComparison
}

/**
 * Fetches `convex/insights.ts` `compareVersions` for the given version pair,
 * scoped to the caller's (already-resolved) Convex `orgId`. Throws whatever
 * Convex throws (afrError `CODE: message` strings — NOT_FOUND for an
 * unknown/cross-org version, INVALID_ARGUMENT if the two versions don't
 * share an agent, FORBIDDEN/UNAUTHORIZED from `requireOrgMembership`) — the
 * caller (the route) maps these via `mapApiError`.
 */
export async function fetchVersionComparisonRaw(
  convexOrgId: string,
  agentVersionIdA: string,
  agentVersionIdB: string,
): Promise<RawVersionComparison> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.insights.compareVersions, {
    orgId: convexOrgId,
    agentVersionIdA,
    agentVersionIdB,
  })
  return result as RawVersionComparison
}
