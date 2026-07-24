// Agent cost stats service — token volume + ESTIMATED $ cost by model, built
// on Team B's convex/insights.ts `getAgentCostStats`.
//
// Real request:  { orgId, agentId, range: '7d' | '30d' }
// Real response: {
//   agentId, range, sampleSize, truncated, totalCostUsd,
//   byModel: Array<{ model, tokensIn, tokensOut, costUsd, matched }>,
//   tokensIn, tokensOut, unmatchedModels: string[],
// }
//
// `matched: false` on a byModel row means no pricing entry exists for that
// model — its `costUsd` is not billed truth, just $0/omitted for that row;
// `unmatchedModels` surfaces this explicitly so cost coverage is never
// silently partial. Every $ figure built on this service must be labeled
// "estimated" in the UI — never presented as billed/actual cost (task
// requirement). `truncated: true` means the underlying sample was capped —
// surfaced as "based on a sample" rather than hidden.

import { auth } from '@clerk/nextjs/server'

import {
  unavailableEmpty,
  unavailableError,
  unavailableNoOrg,
  unavailableOrgUnresolved,
} from './serviceResult'

import type { DashboardRange } from './dashboard'
import type { ServiceResult } from './serviceResult'


import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

const SUBJECT = 'cost stats'


export interface CostByModel {
  model: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** False when no pricing entry exists for this model — costUsd is not meaningful for this row. */
  matched: boolean
}

export interface AgentCostStatsData {
  range: DashboardRange
  sampleSize: number
  truncated: boolean
  totalCostUsd: number
  byModel: CostByModel[]
  tokensIn: number
  tokensOut: number
  /** Models with usage but no matching pricing entry — cost coverage is partial when non-empty. */
  unmatchedModels: string[]
}

export type AgentCostStats = ServiceResult<AgentCostStatsData>

export async function getAgentCostStats(
  agentId: string,
  range: DashboardRange = '7d',
): Promise<AgentCostStats> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return unavailableNoOrg(SUBJECT)

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return unavailableOrgUnresolved(SUBJECT)
    const orgDoc = org as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.getAgentCostStats, {
      orgId: orgDoc._id,
      agentId,
      range,
    })
    // The query returned. A null/absent result here genuinely means no cost
    // rollups have been computed for this agent and range — this is the one
    // branch entitled to say "nothing yet".
    if (!result) {
      return unavailableEmpty(
        'No cost data for this range yet. Cost is derived from token usage on recorded runs.',
      )
    }

    const r = result as {
      sampleSize: number
      truncated: boolean
      totalCostUsd: number
      byModel: CostByModel[]
      tokensIn: number
      tokensOut: number
      unmatchedModels: string[]
    }
    return {
      status: 'ok',
      range,
      sampleSize: r.sampleSize ?? 0,
      truncated: r.truncated ?? false,
      totalCostUsd: r.totalCostUsd ?? 0,
      byModel: r.byModel ?? [],
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      unmatchedModels: r.unmatchedModels ?? [],
    }
  } catch (err) {
    // We do not know whether cost data exists. Say so — do not render the
    // empty state over a swallowed exception.
    return unavailableError(SUBJECT, err, { service: 'cost', agentId, range })
  }
}
