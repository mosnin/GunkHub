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
 * Per-agent breakdown table — insights.getDashboardStats only returns
 * totals for the org (or for one agentId when passed). There is no
 * dedicated "all agents at once" rollup yet, so this calls it once per
 * agent in the org and assembles the table client-side. Acceptable for the
 * typical org's agent count; if that stops being true, ask Team B for a
 * dedicated multi-agent rollup rather than optimizing this further.
 */
export async function getPerAgentDashboardStats(range: DashboardRange = '7d'): Promise<AgentDashboardRow[]> {
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
