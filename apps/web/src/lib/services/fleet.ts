/**
 * services/fleet.ts — the incident surface's one data seam.
 *
 * ===========================================================================
 * TWO OUTCOMES HERE, FOUR ON THE PAGE
 * ===========================================================================
 *
 *   ok      the scan ran. The report may still contain zero correlations, and
 *           may still be incomplete — which of the four non-answers the page
 *           shows is decided by `isFleetHealthScanComplete` and the verdict,
 *           NOT by this status.
 *   error   the scan failed. We know nothing. Never rendered as "nothing
 *           found" — see `serviceResult.ts` for why that conflation is the
 *           worst failure mode this product has.
 *
 * `serviceResult.ts`'s `empty` is deliberately NOT used. On this surface
 * "there is nothing" is not an absence of data, it is a FINDING with a scope
 * attached, and the scope is what makes it safe. So it comes back as `ok` with
 * an empty `correlations` list plus a populated `scan`, and the page states a
 * scoped answer rather than the generic "nothing here yet" copy.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DATA COMES FROM TODAY, AND WHY THAT IS STATED IN THE REPORT
 * ---------------------------------------------------------------------------
 *
 * No Convex fleet query is registered yet (`convex/helpers/fleet.ts` is a pure
 * engine with no `query()` wrapper) and `GET /api/v1/fleet/health` does not
 * exist. So this reads `failure_patterns`, which is registered and carries
 * genuine cross-agent facts, and `@/lib/fleet/adapt` turns every limitation of
 * that source into an `UnansweredFleetQuestion` rather than absorbing it.
 *
 * The consequence is deliberate: `agentsSkippedForBudget` is non-zero whenever
 * the org has an agent with no recorded failure, so
 * `isFleetHealthScanComplete` is false and `computeFleetHealthVerdict` CANNOT
 * return `healthy` from this path. A source that cannot see health must not be
 * able to certify it.
 *
 * TODO(team-a-fleet-engine): when the query is registered, replace the body of
 * `getFleetHealth` with a single call plus a field mapping and delete
 * `@/lib/fleet/adapt`. No component changes — they are written against the
 * contract types already.
 */

import type { ResolvedFleetWindow } from '@/lib/fleet/window'
import type { FailurePatternDetail, FleetHealthReport } from '@agent-flight-recorder/contracts'

import { buildInterimFleetReport } from '@/lib/fleet/adapt'
import { listAgentsByOrg } from '@/lib/services/agents'
import { getFailurePatternDetail, listFailurePatterns } from '@/lib/services/failurePatterns'
import { unavailableError, type ServiceUnavailable } from '@/lib/services/serviceResult'

/** Bound on the pattern walk. Reaching it is reported as scan truncation. */
const SCAN_LIMIT = 200

/**
 * Bound on detail fetches. Each correlation costs one query for its citations,
 * and a page that issues eighty of them during an incident is a page that
 * times out during an incident. Patterns beyond this become an
 * `engine_limit` unanswered question rather than a silent omission.
 */
const MAX_DETAILED_CORRELATIONS = 8

/** Default coincidence width. Echoed into the scan so the UI can display it. */
const BURST_WINDOW_MS = 60 * 60_000

export type FleetHealthResult =
  | { readonly status: 'ok'; readonly report: FleetHealthReport }
  | (ServiceUnavailable & { status: 'error' })

export async function getFleetHealth(window: ResolvedFleetWindow): Promise<FleetHealthResult> {
  try {
    const [patterns, agents] = await Promise.all([
      listFailurePatterns(SCAN_LIMIT),
      // Roster size is best-effort: a fleet page that fails because it could
      // not count agents would be a worse outage than one that reports the
      // count as zero and says the roster is incomplete.
      listAgentsByOrg().catch(() => []),
    ])

    const inWindow = patterns.filter(
      (p) => p.lastSeenAt >= window.startedAt && p.lastSeenAt <= window.endedAt,
    )
    // Broadest clusters first, so the detail budget is spent on the
    // correlations most likely to be nearest whatever changed — the same
    // breadth-first rule `rankFleetCorrelations` applies to the render order.
    const multiAgent = inWindow
      .filter((p) => (p.affectedAgentIds ?? []).length >= 2)
      .sort((a, b) => (b.affectedAgentIds ?? []).length - (a.affectedAgentIds ?? []).length)

    const toDetail = multiAgent.slice(0, MAX_DETAILED_CORRELATIONS)
    const settled = await Promise.all(
      toDetail.map(async (p) => {
        try {
          return [p.fingerprintHash, await getFailurePatternDetail(p.fingerprintHash)] as const
        } catch {
          // One unreadable pattern must not take the incident page down. It
          // becomes an uncitable cluster, which the adapter reports as an
          // unanswered question.
          return [p.fingerprintHash, null] as const
        }
      }),
    )

    const details = new Map<string, FailurePatternDetail>()
    for (const [hash, detail] of settled) {
      if (detail !== null) details.set(hash, detail)
    }

    return {
      status: 'ok',
      report: buildInterimFleetReport({
        patterns,
        details,
        patternsNotDetailed: Math.max(0, multiAgent.length - toDetail.length),
        window,
        burstWindowMs: BURST_WINDOW_MS,
        agentsInRoster: agents.length,
        listTruncated: patterns.length >= SCAN_LIMIT,
        listCeiling: SCAN_LIMIT,
      }),
    }
  } catch (err) {
    return unavailableError('the fleet health scan', err, {
      service: 'fleet',
      windowId: window.option.id,
    }) as ServiceUnavailable & { status: 'error' }
  }
}
