import Link from 'next/link'
import { notFound } from 'next/navigation'

import type { ResolvedAgentVersion, TopRunExplanationPreview } from '@/components/patterns/PatternDetail'
import type { ResolutionEvidenceState } from '@/components/patterns/ResolutionEvidencePanel'
import type { Metadata } from 'next'

import { adaptFailurePatternDetail, loadPatternResolutionEvidence } from '@/components/patterns/adapt'
import { PatternDetail } from '@/components/patterns/PatternDetail'
import { ErrorState } from '@/components/ui/ErrorState'
import { getCurrentAuth } from '@/lib/auth'
import { getRunExplanationSummaries, withAnalyzingGracePeriod } from '@/lib/services/explanations'
import { getFailurePatternDetail } from '@/lib/services/failurePatterns'
import { getRun } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Pattern Detail' }

interface PatternDetailPageProps {
  params: { fingerprint: string }
}

/**
 * "Failure Patterns" detail — one recurring failure fingerprint's full
 * rollup: trend, spike assessment, representative runs, and affected agent
 * versions. Stable, shareable URL: `/patterns/[fingerprint]`.
 *
 * `null` from the service (fingerprint doesn't resolve in this org — same
 * "never existed" outcome whether it truly never existed or belongs to a
 * different org, per the tenancy rule the API route's own comment
 * documents) renders Next's `notFound()`, not an error — a missing pattern
 * is an expected, honest outcome, distinct from a genuine fetch failure.
 */
export default async function PatternDetailPage({ params }: PatternDetailPageProps) {
  const { fingerprint } = params

  // Mirrors settings/alerts/page.tsx's isAdmin check — gates the mute/unmute
  // control (cycle 3). This page is only reachable from within the (app)
  // route group, which already requires an authenticated org context, so
  // this is safe to call unguarded here (same posture as the alerts page).
  const isAdmin = getCurrentAuth().orgRole === 'admin'

  let raw: Awaited<ReturnType<typeof getFailurePatternDetail>> | null = null
  let error: string | null = null

  try {
    raw = await getFailurePatternDetail(fingerprint)
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load this failure pattern'
  }

  if (error) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <ErrorState title="Failed to load pattern" message={error} />
      </div>
    )
  }

  const detail = adaptFailurePatternDetail(raw)
  if (!detail) notFound()

  // Resolve affected agent versions -> { agentId, version } so PatternDetail
  // can link each one to its owning agent's page. Non-fatal: a version that
  // fails to resolve (deleted, transient error) just renders as a truncated
  // ID instead of a link, same "additive, never blocks the page" posture as
  // the run-detail page's own agentVersionLabel lookup.
  //
  // `resolvedInVersionId` is resolved alongside them (deduped) so "resolved in
  // WHICH version" can be rendered as a real version string in the regression
  // banner, the resolution block, and the lifecycle timeline — a raw
  // agent_versions id answers nobody's question.
  const agentVersions: Record<string, ResolvedAgentVersion | undefined> = {}
  const versionIdsToResolve = Array.from(
    new Set([
      ...detail.pattern.affectedAgentVersionIds,
      ...(detail.pattern.resolvedInVersionId ? [detail.pattern.resolvedInVersionId] : []),
    ]),
  )
  if (versionIdsToResolve.length > 0) {
    const { getAgentVersion } = await import('@/lib/services/agent_versions')
    await Promise.all(
      versionIdsToResolve.map(async (versionId) => {
        try {
          const v = await getAgentVersion(versionId)
          if (v) agentVersions[versionId] = { agentId: v.agentId, version: v.version }
        } catch {
          // Non-fatal: this version renders as a truncated ID, not a link.
        }
      }),
    )
  }

  // "Why did this fail?" preview for the top (most-recent) representative
  // run — one bounded batch call, same helper the dashboard's Recent Runs
  // list uses, plus the same grace-period downgrade so a run that ended long
  // ago with no explanation reads as "not available" rather than an
  // indefinite "analyzing…". Non-fatal: any failure here just omits the
  // section (`topRunExplanation` stays null), the rest of the page still
  // renders.
  let topRunExplanation: TopRunExplanationPreview | null = null
  const topRunId = detail.pattern.hasRepresentativeRuns ? detail.pattern.representativeRunIds[0] : undefined
  if (topRunId) {
    try {
      const [summariesSettled, runSettled] = await Promise.allSettled([
        getRunExplanationSummaries([topRunId]),
        getRun(topRunId),
      ])
      const rawState =
        summariesSettled.status === 'fulfilled' ? summariesSettled.value[topRunId] : undefined
      const runEndedAt = runSettled.status === 'fulfilled' ? runSettled.value.run.endedAt : undefined
      const state = rawState ?? { status: 'unavailable' as const }
      const graced = withAnalyzingGracePeriod({ [topRunId]: state }, [{ id: topRunId, endedAt: runEndedAt }])
      topRunExplanation = { runId: topRunId, state: graced[topRunId] ?? state }
    } catch {
      // Non-fatal — section is simply omitted.
      topRunExplanation = null
    }
  }

  // "Did the fix hold?" evidence. Fetched through the guarded service lookup
  // in adapt.ts, which degrades to an explicit `unavailable`/`error` state
  // rather than throwing — a failure here must never make a resolved pattern
  // silently render as though its fix were proven.
  const evidenceFetch = await loadPatternResolutionEvidence(fingerprint)
  const resolvedInVersion =
    evidenceFetch.status === 'ready'
      ? (evidenceFetch.evidence.resolution?.resolvedInVersion ??
        (detail.pattern.resolvedInVersionId
          ? agentVersions[detail.pattern.resolvedInVersionId]?.version
          : undefined))
      : undefined
  const evidenceState: ResolutionEvidenceState =
    evidenceFetch.status === 'ready'
      ? {
          kind: 'ready',
          evidence: evidenceFetch.evidence,
          ...(resolvedInVersion !== undefined && { resolvedInVersion }),
        }
      : evidenceFetch.status === 'error'
        ? { kind: 'error', message: evidenceFetch.message }
        : { kind: 'unavailable' }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        href="/patterns"
        className="inline-flex items-center gap-1 text-xs font-mono text-pewter hover:text-cloud transition-colors duration-100 mb-4"
      >
        <span aria-hidden="true">←</span> All patterns
      </Link>
      <PatternDetail
        pattern={detail.pattern}
        recentOccurrences={detail.recentOccurrences}
        trend={detail.trend}
        agentVersions={agentVersions}
        topRunExplanation={topRunExplanation}
        isAdmin={isAdmin}
        evidenceState={evidenceState}
      />
    </div>
  )
}
