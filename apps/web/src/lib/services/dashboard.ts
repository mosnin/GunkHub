// Analytics dashboard service — org-wide failure-rate trend + per-agent
// breakdown, built on Team B's convex/insights.ts `getDashboardStats`.
//
// Real request:  { orgId, range: '7d' | '30d', agentId? }
// Real response: {
//   range, agentId,
//   totals: { <counts by status>, failureRate, tokensIn, tokensOut },
//   series: Array<{
//     date, runsTotal, runsFailed, runsCompleted, runsCancelled, runsTimedOut,
//     tokensIn, tokensOut, failureRate, source: 'rollup' | 'fallback', truncated,
//   }>,
// }
//
// `source: 'fallback'` on a series point means the nightly rollup hadn't
// computed that day yet and insights.ts derived it live instead — still real
// data, just computed on demand; surfaced in the UI as a subtle note rather
// than hidden. No failure to reach this query ever fabricates numbers — but
// note that a failure is reported as `status: 'error'`, distinctly from
// `status: 'empty'`. See serviceResult.ts for why those must never collapse.

import { auth } from '@clerk/nextjs/server'

import {
  unavailableEmpty,
  unavailableError,
  unavailableNoOrg,
  unavailableOrgUnresolved,
} from './serviceResult'

import type { ServiceResult } from './serviceResult'


import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'
import { listAgentsByOrg } from '@/lib/services/agents'

export type DashboardRange = '7d' | '30d'

export interface DashboardSeriesPoint {
  date: string
  runsTotal: number
  runsFailed: number
  runsCompleted: number
  runsCancelled: number
  runsTimedOut: number
  tokensIn: number
  tokensOut: number
  failureRate: number
  source: 'rollup' | 'fallback'
  truncated: boolean
}

export interface DashboardTotals {
  runsTotal: number
  runsFailed: number
  runsCompleted: number
  runsCancelled: number
  runsTimedOut: number
  failureRate: number
  tokensIn: number
  tokensOut: number
}

export interface DashboardStatsData {
  range: DashboardRange
  totals: DashboardTotals
  /** Oldest first. */
  series: DashboardSeriesPoint[]
}

export type DashboardStats = ServiceResult<DashboardStatsData>

const SUBJECT = 'dashboard stats'

export async function getDashboardStats(range: DashboardRange = '7d', agentId?: string): Promise<DashboardStats> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return unavailableNoOrg(SUBJECT)

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return unavailableOrgUnresolved(SUBJECT)
    const orgDoc = org as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.getDashboardStats, {
      orgId: orgDoc._id,
      range,
      ...(agentId !== undefined && { agentId }),
    })
    // Query returned nothing: no runs have been recorded in this range.
    if (!result) {
      return unavailableEmpty('No runs recorded in this range yet.')
    }

    const r = result as { totals: DashboardTotals; series: DashboardSeriesPoint[] }
    return {
      status: 'ok',
      range,
      totals: r.totals,
      series: r.series ?? [],
    }
  } catch (err) {
    // Insights query unreachable (transient failure, or not yet deployed).
    // This is NOT an empty state — we did not learn that there are no runs,
    // we failed to ask. The page stays up, but it must say which happened.
    return unavailableError(SUBJECT, err, { service: 'dashboard', range, agentId })
  }
}

export interface AgentDashboardRow {
  agentId: string
  agentName: string
  totals: DashboardTotals
}

export interface PerAgentDashboardData {
  rows: AgentDashboardRow[]
  /**
   * True when the fast org-wide rollup failed and these rows came from the
   * slower per-agent fallback. The rows are real, but the path is degraded —
   * worth a quiet note in the UI so a persistent fallback is noticed rather
   * than silently tolerated.
   */
  degraded: boolean
  /**
   * How many agents are MISSING from `rows` because their per-agent stats
   * query threw. Non-zero means this table is incomplete in a way the reader
   * cannot see: the absent agents look identical to agents that do not exist.
   * A table that quietly drops the agents it failed to load is the same
   * fabricate-from-failure defect at row granularity, so the count is
   * reported rather than swallowed.
   */
  omittedAgentCount: number
}

const PER_AGENT_SUBJECT = 'the per-agent breakdown'

/**
 * Per-agent breakdown table. Uses Team B's single org-wide rollup
 * (`insights:getPerAgentDashboardStats`) instead of the previous
 * N-calls-per-agent approach, falling back to that older strategy if the new
 * query throws (e.g. not yet deployed in this environment).
 *
 * The fallback is a genuine recovery, not a swallow: if it produces rows we
 * report 'ok' (flagged `degraded`), and only a fallback that ALSO fails
 * reports 'error'. Previously every one of these paths returned `[]`, so an
 * outage rendered as "this org has no agents".
 */
export async function getPerAgentDashboardStats(
  range: DashboardRange = '7d',
): Promise<ServiceResult<PerAgentDashboardData>> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return unavailableNoOrg(PER_AGENT_SUBJECT)

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return unavailableOrgUnresolved(PER_AGENT_SUBJECT)
    const orgDoc = org as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.getPerAgentDashboardStats, {
      orgId: orgDoc._id,
      range,
    })
    const r = result as { rows: AgentDashboardRow[] } | AgentDashboardRow[] | null
    const rows = r === null ? [] : Array.isArray(r) ? r : (r.rows ?? [])
    if (rows.length === 0) {
      return unavailableEmpty('No agents have recorded runs in this range yet.')
    }
    return { status: 'ok', rows, degraded: false, omittedAgentCount: 0 }
  } catch (err) {
    return getPerAgentDashboardStatsFallback(range, err)
  }
}

/**
 * Previous-cycle strategy: one getDashboardStats call per agent. Kept only as
 * a fallback for environments where the new single-query rollup isn't
 * deployed yet.
 *
 * @param primaryErr The error that forced this path — preserved into the log
 *                   if the fallback fails too, so the original cause is not
 *                   hidden behind the symptom.
 */
async function getPerAgentDashboardStatsFallback(
  range: DashboardRange,
  primaryErr: unknown,
): Promise<ServiceResult<PerAgentDashboardData>> {
  let agents
  try {
    agents = await listAgentsByOrg()
  } catch (err) {
    // Both the rollup and the agent list failed. We know nothing.
    return unavailableError(PER_AGENT_SUBJECT, err, {
      service: 'dashboard',
      fn: 'getPerAgentDashboardStatsFallback',
      range,
      primaryErr,
    })
  }

  if (agents.length === 0) {
    return unavailableEmpty('No agents in this organization yet.')
  }

  // Per-agent stats are resolved individually. A row that errored is COUNTED,
  // not silently dropped — see `omittedAgentCount`. A row that came back
  // 'empty' is a different thing (that agent genuinely had no runs in range)
  // and is simply absent, which is what the table already meant.
  let omittedAgentCount = 0
  const settled = await Promise.all(
    agents.map(async (agent) => {
      const stats = await getDashboardStats(range, agent.id)
      if (stats.status === 'error') {
        omittedAgentCount++
        return null
      }
      if (stats.status !== 'ok') return null
      return { agentId: agent.id, agentName: agent.name, totals: stats.totals }
    }),
  )
  const rows = settled.filter((r): r is AgentDashboardRow => r !== null)

  // Every agent failed to load. Reporting 'empty' here would claim the org has
  // no activity when in fact nothing could be read.
  if (rows.length === 0 && omittedAgentCount > 0) {
    return unavailableError(PER_AGENT_SUBJECT, primaryErr, {
      service: 'dashboard',
      fn: 'getPerAgentDashboardStatsFallback',
      range,
      omittedAgentCount,
    })
  }
  if (rows.length === 0) {
    return unavailableEmpty('No agents have recorded runs in this range yet.')
  }

  return { status: 'ok', rows, degraded: true, omittedAgentCount }
}
