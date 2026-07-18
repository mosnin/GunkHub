import Link from 'next/link'
import { notFound } from 'next/navigation'

import type { Artifact, Comment, FailureSummary } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { ArtifactList } from '@/components/runs/ArtifactList'
import { CommentThread } from '@/components/runs/CommentThread'
import { EventInspector } from '@/components/runs/EventInspector'
import { FailureSummary as FailureSummaryPanel } from '@/components/runs/FailureSummary'
import { RunBreadcrumb } from '@/components/runs/RunBreadcrumb'
import { RunHeader } from '@/components/runs/RunHeader'
import { Timeline } from '@/components/runs/Timeline'
import { VerificationPanel } from '@/components/runs/VerificationPanel'
import { ErrorState } from '@/components/ui/ErrorState'
import { InlineError } from '@/components/ui/InlineError'
import { getAgent } from '@/lib/services/agents'
import { listArtifacts } from '@/lib/services/artifacts'
import { listComments } from '@/lib/services/comments'
import { listEvents } from '@/lib/services/events'
import { getRunVerificationStatus, type VerificationStatus } from '@/lib/services/projection_verify'
import { getProject } from '@/lib/services/projects'
import { getReplayProjection } from '@/lib/services/replay'
import { getRun } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Run Detail' }

const TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'events', label: 'Events' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'comments', label: 'Comments' },
  { id: 'replay', label: 'Replay' },
] as const

type TabId = (typeof TABS)[number]['id']

interface RunDetailPageProps {
  params: { runId: string }
  searchParams: { tab?: string; event?: string }
}

export default async function RunDetailPage({ params, searchParams }: RunDetailPageProps) {
  const { runId } = params

  const activeTab: TabId =
    (searchParams.tab as TabId | undefined) && TABS.some((t) => t.id === searchParams.tab)
      ? (searchParams.tab as TabId)
      : 'timeline'

  const initialEventSeq = searchParams.event !== undefined
    ? parseInt(searchParams.event, 10) || undefined
    : undefined

  // Fetch run and events server-side
  let runData: Awaited<ReturnType<typeof getRun>> | null = null
  let eventsData: Awaited<ReturnType<typeof listEvents>> | null = null
  let fetchError: string | null = null
  let failureSummary: FailureSummary | null = null
  let artifactsData: { artifacts: Artifact[] } = { artifacts: [] }
  let commentsData: Comment[] = []

  // Phase 1 — fetch everything that only depends on runId in parallel instead of
  // serially. run + events are the fatal group (drive notFound / ErrorState);
  // replay, artifacts and comments are additive (non-fatal). allSettled lets one
  // failure not reject the others.
  const [runSettled, eventsSettled, replaySettled, artifactsSettled, commentsSettled] =
    await Promise.allSettled([
      getRun(runId),
      listEvents({ runId, limit: 200 }),
      getReplayProjection(runId),
      listArtifacts(runId),
      listComments(runId, 'run'),
    ])

  if (runSettled.status === 'fulfilled') runData = runSettled.value
  if (eventsSettled.status === 'fulfilled') eventsData = eventsSettled.value

  // Fatal group error handling — preserve notFound() on "not found", else surface.
  const fatalRejection: unknown =
    runSettled.status === 'rejected'
      ? runSettled.reason
      : eventsSettled.status === 'rejected'
        ? eventsSettled.reason
        : null
  if (fatalRejection) {
    const msg = fatalRejection instanceof Error ? fatalRejection.message : 'Unknown error'
    if (msg.toLowerCase().includes('not found')) notFound()
    fetchError = msg
  }

  // Additive results — non-fatal, defaults retained on rejection, but track
  // per-section failure so the UI shows an inline error instead of a
  // misleading empty state.
  const replayFailed = replaySettled.status === 'rejected'
  const artifactsFailed = artifactsSettled.status === 'rejected'
  const commentsFailed = commentsSettled.status === 'rejected'
  if (replaySettled.status === 'fulfilled') failureSummary = replaySettled.value.failureSummary
  if (artifactsSettled.status === 'fulfilled') artifactsData = artifactsSettled.value
  if (commentsSettled.status === 'fulfilled') commentsData = commentsSettled.value

  const TERMINAL = ['completed', 'failed', 'cancelled', 'timed_out'] as const

  // Phase 2 — fetches that depend on runData, run in parallel with one another.
  let agentVersionLabel: string | undefined
  let verificationStatus: VerificationStatus | null = null
  let breadcrumbProjectName: string | undefined
  let breadcrumbAgentName: string | undefined

  if (runData) {
    const run = runData.run
    const isTerminal = TERMINAL.includes(run.status as typeof TERMINAL[number])
    const { getAgentVersion } = await import('@/lib/services/agent_versions')

    const [versionRes, verifyRes, projectRes, agentRes] = await Promise.all([
      run.agentVersionId
        ? getAgentVersion(run.agentVersionId).catch(() => null)
        : Promise.resolve(null),
      // Only terminal runs have verification results yet.
      isTerminal ? getRunVerificationStatus(runId).catch(() => null) : Promise.resolve(null),
      getProject(run.projectId).catch(() => null),
      getAgent(run.agentId).catch(() => null),
    ])

    agentVersionLabel = versionRes?.version
    verificationStatus = verifyRes
    breadcrumbProjectName = projectRes?.name
    breadcrumbAgentName = agentRes?.name
  }

  if (fetchError) {
    return (
      <div className="p-6">
        <ErrorState title="Failed to load run" message={fetchError} />
      </div>
    )
  }

  if (!runData) return null

  const { run } = runData
  const events = eventsData?.events ?? []
  const initialNextCursor = eventsData?.nextCursor

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb — project → agent → run context */}
      <RunBreadcrumb
        runId={runId}
        projectId={runData?.run.projectId}
        projectName={breadcrumbProjectName}
        agentId={runData?.run.agentId}
        agentName={breadcrumbAgentName}
      />

      {/* Run header */}
      <RunHeader
        runId={runId}
        status={run.status}
        agentName={breadcrumbAgentName ?? run.agentId}
        agentVersionLabel={agentVersionLabel}
        startedAt={run.startedAt}
        endedAt={run.endedAt}
        triggeredBy={run.triggeredBy}
        tags={run.tags}
        metadata={run.metadata}
        isLive={run.status === 'running'}
        verificationStatus={verificationStatus}
      />

      {/* Failure summary panel — additive, shown only when there is a failure or incomplete run */}
      {replayFailed ? (
        <div className="px-6 pt-3">
          <InlineError message="Couldn't load the failure analysis for this run — refresh to retry." />
        </div>
      ) : (
        failureSummary && <FailureSummaryPanel summary={failureSummary} />
      )}

      {/* Verification panel — shown only for terminal runs */}
      {runData && TERMINAL.includes(runData.run.status as typeof TERMINAL[number]) && (
        <VerificationPanel
          runId={runId}
          initialStatus={verificationStatus}
          isTerminal={true}
        />
      )}

      {/* Section navigation — these are links that change the URL, not a
          client-side tab switcher, so they carry nav/aria-current semantics
          rather than tablist/tab roles. */}
      <div className="border-b border-neutral-800 px-6 mt-3">
        <nav aria-label="Run sections" className="-mb-px flex gap-6">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab
            // Replay tab links to the dedicated replay page instead of a tab panel
            const href =
              tab.id === 'replay'
                ? `/runs/${runId}/replay`
                : `/runs/${runId}?tab=${tab.id}`
            return (
              <Link
                key={tab.id}
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'pb-3 text-sm font-medium border-b-2 transition-colors duration-100 whitespace-nowrap',
                  isActive
                    ? 'border-primary-500 text-neutral-100'
                    : 'border-transparent text-neutral-500 hover:text-neutral-300 hover:border-neutral-600',
                ].join(' ')}
              >
                {tab.label}
              </Link>
            )
          })}
        </nav>
      </div>

      {/* Tab content — data is already fetched above, so these render
          synchronously (no Suspense boundary needed). */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'timeline' && (
          <Timeline runId={runId} events={events} initialNextCursor={initialNextCursor} isLive={run.status === 'running'} />
        )}
        {activeTab === 'events' && (
          <EventInspector runId={runId} events={events} initialNextCursor={initialNextCursor} initialEventSeq={initialEventSeq} isLive={run.status === 'running'} />
        )}
        {activeTab === 'artifacts' && (
          artifactsFailed ? (
            <div className="p-6">
              <InlineError message="Couldn't load artifacts — refresh to retry." />
            </div>
          ) : (
            <ArtifactList artifacts={artifactsData.artifacts} />
          )
        )}
        {activeTab === 'comments' && (
          commentsFailed ? (
            <div className="p-6">
              <InlineError message="Couldn't load comments — refresh to retry." />
            </div>
          ) : (
            <CommentThread targetId={runId} targetType="run" initialComments={commentsData} />
          )
        )}
      </div>
    </div>
  )
}
