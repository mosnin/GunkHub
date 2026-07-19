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
// than hidden. Following the honest-empty-state precedent already
// established in this codebase (lib/services/usage.ts): any failure to reach
// this query returns `{ available: false }` rather than fabricated numbers.

import { auth } from '@clerk/nextjs/server'

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

export interface DashboardStatsAvailable {
  available: true
  range: DashboardRange
  totals: DashboardTotals
  /** Oldest first. */
  series: DashboardSeriesPoint[]
}

export interface DashboardStatsUnavailable {
  available: false
}

export type DashboardStats = DashboardStatsAvailable | DashboardStatsUnavailable

export async function getDashboardStats(range: DashboardRange = '7d', agentId?: string): Promise<DashboardStats> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return { available: false }

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return { available: false }
    const orgDoc = org as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.getDashboardStats, {
      orgId: orgDoc._id,
      range,
      ...(agentId !== undefined && { agentId }),
    })
    if (!result) return { available: false }

    const r = result as { totals: DashboardTotals; series: DashboardSeriesPoint[] }
    return {
      available: true,
      range,
      totals: r.totals,
      series: r.series ?? [],
    }
  } catch {
    // Insights query unreachable (transient failure, or not yet deployed) —
    // the honest empty state, not a page-breaking error.
    return { available: false }
  }
}

export interface AgentDashboardRow {
  agentId: string
  agentName: string
  totals: DashboardTotals
}

/**
 * Per-agent breakdown table. Uses Team B's single org-wide rollup
 * (`insights:getPerAgentDashboardStats`, added this cycle) instead of the
 * previous N-calls-per-agent approach. Falls back to the old per-agent-call
 * strategy if the new query throws (e.g. not yet deployed in this
 * environment) — same honest-empty-state precedent as `getDashboardStats`,
 * but never simply returns nothing when a slower path can still work.
 */
export async function getPerAgentDashboardStats(range: DashboardRange = '7d'): Promise<AgentDashboardRow[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return []

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return []
    const orgDoc = org as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.getPerAgentDashboardStats, {
      orgId: orgDoc._id,
      range,
    })
    const r = result as { rows: AgentDashboardRow[] } | AgentDashboardRow[] | null
    if (!r) return []
    const rows = Array.isArray(r) ? r : r.rows
    return rows ?? []
  } catch {
    return getPerAgentDashboardStatsFallback(range)
  }
}

/**
 * Previous-cycle strategy: one getDashboardStats call per agent. Kept only as
 * a fallback for environments where the new single-query rollup isn't
 * deployed yet.
 */
async function getPerAgentDashboardStatsFallback(range: DashboardRange): Promise<AgentDashboardRow[]> {
  let agents
  try {
    agents = await listAgentsByOrg()
  } catch {
    return []
  }

  const rows = await Promise.all(
    agents.map(async (agent) => {
      const stats = await getDashboardStats(range, agent.id)
      if (!stats.available) return null
      return { agentId: agent.id, agentName: agent.name, totals: stats.totals }
    }),
  )
  return rows.filter((r): r is AgentDashboardRow => r !== null)
}
