import { auth } from '@clerk/nextjs/server'

import {
  unavailableEmpty,
  unavailableError,
  unavailableNoOrg,
  unavailableOrgUnresolved,
} from './serviceResult'

import type { DashboardRange } from './dashboard'
import type { ServiceResult } from './serviceResult'
import type { Eval, EvalKind } from '@agent-flight-recorder/contracts'


import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

const ROLLUP_SUBJECT = 'eval results for this version'
const RUN_SUMMARY_SUBJECT = 'eval results for this run'


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

export interface EvalVersionRollupData {
  agentVersionId: string
  range: DashboardRange
  sampleSize: number
  passed: number
  failed: number
  passRate: number
  recentFailures: EvalRecentFailure[]
  truncated: boolean
}

export type EvalVersionRollup = ServiceResult<EvalVersionRollupData>

// ---------------------------------------------------------------------------
// Run-level eval summary — Team B's convex/insights.ts `getRunEvalSummary`
// (added this cycle). Bound by path in convexFunctions.ts since it may not
// yet be present in convex/_generated/api at the time this UI cycle was
// written; falls back to summarizing the run's own eval list (already
// fetched by the run-detail page via listEvalsForRun) if the query throws.
// ---------------------------------------------------------------------------

export interface RunEvalSummaryData {
  total: number
  passed: number
  failed: number
  /** 0-100, one decimal. Null when total === 0. */
  passRatePct: number | null
  /** Mean of recorded eval `score` values, when any evals carried a score. */
  avgScore?: number
}

export type RunEvalSummary = ServiceResult<RunEvalSummaryData>

const NO_EVALS_MESSAGE = 'No evals recorded for this run.'

export async function getRunEvalSummary(runId: string): Promise<RunEvalSummary> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return unavailableNoOrg(RUN_SUMMARY_SUBJECT)

  try {
    const client = await getAuthedClient()

    // `insights:getRunEvalSummary` requires { orgId, runId }. This call omitted
    // orgId, so every invocation threw ArgumentValidationError and the catch
    // below silently served the fallback summary — the panel header has never
    // once used this query since it shipped. Found by scripts/check-convex-refs.ts
    // on its first run; TypeScript cannot see it, because the args cross a
    // hand-maintained makeFunctionReference string ref. Resolve the org first,
    // exactly as listEvalsForVersion below already does.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return unavailableOrgUnresolved(RUN_SUMMARY_SUBJECT)
    const orgDoc = org as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.getRunEvalSummary, {
      orgId: orgDoc._id,
      runId,
    })
    // Query returned. Nothing there means nothing was recorded — legitimately
    // empty, and the only branch in this function entitled to claim that.
    if (!result) return unavailableEmpty(NO_EVALS_MESSAGE)
    const r = result as Partial<RunEvalSummaryData>
    if ((r.total ?? 0) === 0) return unavailableEmpty(NO_EVALS_MESSAGE)
    return {
      status: 'ok',
      total: r.total ?? 0,
      passed: r.passed ?? 0,
      failed: r.failed ?? 0,
      passRatePct: r.passRatePct ?? null,
      ...(r.avgScore !== undefined && { avgScore: r.avgScore }),
    }
  } catch (primaryErr) {
    // Fall back to summarizing the run's own eval list rather than showing
    // nothing — same list the Evals tab already renders. This is a legitimate
    // recovery, not a swallow: if it succeeds we have real data and can
    // honestly report 'ok'/'empty'; if it also fails we report 'error'.
    try {
      const evals = await listEvalsForRun(runId)
      if (evals.length === 0) return unavailableEmpty(NO_EVALS_MESSAGE)
      const summary = summarizeEvalPassRate(evals)
      const scored = evals.filter((e) => e.score !== undefined)
      const avgScore = scored.length > 0
        ? scored.reduce((sum, e) => sum + (e.score ?? 0), 0) / scored.length
        : undefined
      return {
        status: 'ok',
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        passRatePct: summary.passRatePct,
        ...(avgScore !== undefined && { avgScore }),
      }
    } catch (fallbackErr) {
      // Both paths failed. We know nothing about this run's evals.
      return unavailableError(RUN_SUMMARY_SUBJECT, fallbackErr, {
        service: 'evals',
        fn: 'getRunEvalSummary',
        runId,
        primaryErr,
      })
    }
  }
}

export async function getEvalRollupForVersion(
  agentVersionId: string,
  range: DashboardRange = '7d',
): Promise<EvalVersionRollup> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return unavailableNoOrg(ROLLUP_SUBJECT)

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return unavailableOrgUnresolved(ROLLUP_SUBJECT)
    const orgDoc = org as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.listEvalsForVersion, {
      orgId: orgDoc._id,
      agentVersionId,
      range,
    })
    // Query succeeded with no rollup: nothing has been recorded for this
    // version and range. This is the only honest "fills in once evals have
    // been recorded" branch.
    if (!result) {
      return unavailableEmpty('No evals recorded for this version in this range yet.')
    }

    const r = result as Omit<EvalVersionRollupData, 'range'>
    return { status: 'ok', range, ...r }
  } catch (err) {
    return unavailableError(ROLLUP_SUBJECT, err, {
      service: 'evals',
      fn: 'getEvalRollupForVersion',
      agentVersionId,
      range,
    })
  }
}
