import { auth } from '@clerk/nextjs/server'

import type { DashboardRange } from './dashboard'
import type { Eval, EvalKind } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'


function mapEval(doc: Record<string, unknown>): Eval {
  return {
    id: doc._id as string,
    orgId: doc.orgId as string,
    runId: doc.runId as string,
    name: doc.name as string,
    kind: doc.kind as Eval['kind'],
    passed: doc.passed as boolean,
    createdAt: doc.createdAt as number,
    createdBy: doc.createdBy as string,
    ...(doc.agentVersionId !== undefined && { agentVersionId: doc.agentVersionId as string }),
    ...(doc.score !== undefined && { score: doc.score as number }),
    ...(doc.details !== undefined && { details: doc.details as string }),
  }
}

/** All evals recorded against a run, newest first (convex/evals.ts `listEvalsForRun`). */
export async function listEvalsForRun(runId: string, limit = 50): Promise<Eval[]> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const docs = await client.query(convex.evals.listEvalsForRun, { runId, limit })
  return ((docs as Record<string, unknown>[]) ?? []).map(mapEval)
}

/**
 * Raw eval rows recorded against runs of a given agent version, newest first
 * (convex/evals.ts `listEvalsByAgentVersion`). Superseded for dashboard
 * display by `getEvalRollupForVersion` below (Team B's insights rollup), but
 * kept as a direct read for callers that want the underlying records.
 */
export async function listEvalsRawForVersion(
  orgId: string,
  agentVersionId: string,
  limit = 200,
): Promise<Eval[]> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const docs = await client.query(convex.evals.listEvalsByAgentVersion, {
    orgId,
    agentVersionId,
    limit,
  })
  return ((docs as Record<string, unknown>[]) ?? []).map(mapEval)
}

export interface EvalPassRateSummary {
  total: number
  passed: number
  failed: number
  /** 0-100, rounded to one decimal. Null when total === 0 (nothing recorded yet). */
  passRatePct: number | null
}

/** Summarize a list of evals into a pass-rate rollup for display. */
export function summarizeEvalPassRate(evals: Eval[]): EvalPassRateSummary {
  const total = evals.length
  const passed = evals.filter((e) => e.passed).length
  return {
    total,
    passed,
    failed: total - passed,
    passRatePct: total === 0 ? null : Math.round((passed / total) * 1000) / 10,
  }
}

// ---------------------------------------------------------------------------
// Eval pass-rate rollup — Team B's convex/insights.ts `listEvalsForVersion`.
// ---------------------------------------------------------------------------
//
// Real request:  { orgId, agentVersionId, range: '7d' | '30d' }
// Real response: {
//   agentVersionId, range, sampleSize, passed, failed, passRate,
//   recentFailures: Array<{ evalId, runId, name, kind, details, createdAt }>,
//   truncated,
// }

export interface EvalRecentFailure {
  evalId: string
  runId: string
  name: string
  kind: EvalKind
  details?: string
  createdAt: number
}

export interface EvalVersionRollupAvailable {
  available: true
  agentVersionId: string
  range: DashboardRange
  sampleSize: number
  passed: number
  failed: number
  passRate: number
  recentFailures: EvalRecentFailure[]
  truncated: boolean
}

export interface EvalVersionRollupUnavailable {
  available: false
}

export type EvalVersionRollup = EvalVersionRollupAvailable | EvalVersionRollupUnavailable

// ---------------------------------------------------------------------------
// Run-level eval summary — Team B's convex/insights.ts `getRunEvalSummary`
// (added this cycle). Bound by path in convexFunctions.ts since it may not
// yet be present in convex/_generated/api at the time this UI cycle was
// written; falls back to summarizing the run's own eval list (already
// fetched by the run-detail page via listEvalsForRun) if the query throws.
// ---------------------------------------------------------------------------

export interface RunEvalSummary {
  available: boolean
  total: number
  passed: number
  failed: number
  /** 0-100, one decimal. Null when total === 0. */
  passRatePct: number | null
  /** Mean of recorded eval `score` values, when any evals carried a score. */
  avgScore?: number
}

export async function getRunEvalSummary(runId: string): Promise<RunEvalSummary> {
  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.getRunEvalSummary, { runId })
    if (!result) return { available: false, total: 0, passed: 0, failed: 0, passRatePct: null }
    const r = result as Partial<RunEvalSummary>
    return {
      available: true,
      total: r.total ?? 0,
      passed: r.passed ?? 0,
      failed: r.failed ?? 0,
      passRatePct: r.passRatePct ?? null,
      ...(r.avgScore !== undefined && { avgScore: r.avgScore }),
    }
  } catch {
    // Fall back to summarizing the run's own eval list rather than showing
    // nothing — same list the Evals tab already renders.
    try {
      const evals = await listEvalsForRun(runId)
      const summary = summarizeEvalPassRate(evals)
      const scored = evals.filter((e) => e.score !== undefined)
      const avgScore = scored.length > 0
        ? scored.reduce((sum, e) => sum + (e.score ?? 0), 0) / scored.length
        : undefined
      return {
        available: true,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        passRatePct: summary.passRatePct,
        ...(avgScore !== undefined && { avgScore }),
      }
    } catch {
      return { available: false, total: 0, passed: 0, failed: 0, passRatePct: null }
    }
  }
}

export async function getEvalRollupForVersion(
  agentVersionId: string,
  range: DashboardRange = '7d',
): Promise<EvalVersionRollup> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return { available: false }

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return { available: false }
    const orgDoc = org as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.listEvalsForVersion, {
      orgId: orgDoc._id,
      agentVersionId,
      range,
    })
    if (!result) return { available: false }

    const r = result as Omit<EvalVersionRollupAvailable, 'available' | 'range'>
    return { available: true, range, ...r }
  } catch {
    return { available: false }
  }
}
