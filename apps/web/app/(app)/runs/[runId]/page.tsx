import { notFound } from 'next/navigation'
import { Suspense } from 'react'

import type { Artifact, Comment, FailureSummary } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { ArtifactList } from '@/components/runs/ArtifactList'
import { CommentThread } from '@/components/runs/CommentThread'
import { EventInspector } from '@/components/runs/EventInspector'
import { FailureSummary as FailureSummaryPanel } from '@/components/runs/FailureSummary'
import { RunBreadcrumb } from '@/components/runs/RunBreadcrumb'
import { RunHeader } from '@/components/runs/RunHeader'
import { Timeline } from '@/components/runs/Timeline'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { getAgent } from '@/lib/services/agents'
import { listArtifacts } from '@/lib/services/artifacts'
import { listComments } from '@/lib/services/comments'
import { listEvents } from '@/lib/services/events'
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

  try {
    runData = await getRun(runId)
    eventsData = await listEvents({ runId, limit: 200 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.toLowerCase().includes('not found')) notFound()
    fetchError = msg
  }

  // Resolve agent version label for display in RunHeader
  let agentVersionLabel: string | undefined
  if (runData?.run.agentVersionId) {
    try {
      const { getAgentVersion } = await import('@/lib/services/agent_versions')
      const v = await getAgentVersion(runData.run.agentVersionId)
      agentVersionLabel = v?.version
    } catch {
      // Non-fatal
    }
  }

  // Failure summary is additive — a failed fetch does not block the rest of the page.
  try {
    const replayData = await getReplayProjection(runId)
    failureSummary = replayData.failureSummary
  } catch {
    // Non-fatal: skip the failure panel if the projection cannot be built.
  }

  try {
    artifactsData = await listArtifacts(runId)
  } catch {
    // Non-fatal: show empty artifact list if fetch fails
  }

  try {
    commentsData = await listComments(runId, 'run')
  } catch {
    // Non-fatal: show empty comment thread if fetch fails
  }

  // Resolve parent context for breadcrumb — non-fatal if either fails
  let breadcrumbProjectName: string | undefined
  let breadcrumbAgentName: string | undefined

  if (runData) {
    try {
      const project = await getProject(runData.run.projectId)
      breadcrumbProjectName = project.name
    } catch {
      // Non-fatal: fall back to showing project ID in breadcrumb
    }

    try {
      const agent = await getAgent(runData.run.agentId)
      breadcrumbAgentName = agent?.name
    } catch {
      // Non-fatal: fall back to showing agent ID in breadcrumb
    }
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
        agentName={run.agentId}
        agentVersionLabel={agentVersionLabel}
        startedAt={run.startedAt}
        endedAt={run.endedAt}
        triggeredBy={run.triggeredBy}
        tags={run.tags}
        metadata={run.metadata}
      />

      {/* Failure summary panel — additive, shown only when there is a failure or incomplete run */}
      {failureSummary && (
        <FailureSummaryPanel summary={failureSummary} />
      )}

      {/* Tab bar */}
      <div className="border-b border-neutral-800 px-6 mt-3">
        <nav className="-mb-px flex gap-6" role="tablist">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab
            // Replay tab links to the dedicated replay page instead of a tab panel
            const href =
              tab.id === 'replay'
                ? `/runs/${runId}/replay`
                : `/runs/${runId}?tab=${tab.id}`
            return (
              <a
                key={tab.id}
                href={href}
                role="tab"
                aria-selected={isActive}
                className={[
                  'pb-3 text-sm font-medium border-b-2 transition-colors duration-100 whitespace-nowrap',
                  isActive
                    ? 'border-primary-500 text-neutral-100'
                    : 'border-transparent text-neutral-500 hover:text-neutral-300 hover:border-neutral-600',
                ].join(' ')}
              >
                {tab.label}
              </a>
            )
          })}
        </nav>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'timeline' && (
          <Suspense fallback={<LoadingState message="Loading timeline..." />}>
            <Timeline runId={runId} events={events} initialNextCursor={initialNextCursor} />
          </Suspense>
        )}
        {activeTab === 'events' && (
          <Suspense fallback={<LoadingState message="Loading events..." />}>
            <EventInspector runId={runId} events={events} initialNextCursor={initialNextCursor} initialEventSeq={initialEventSeq} />
          </Suspense>
        )}
        {activeTab === 'artifacts' && (
          <Suspense fallback={<LoadingState message="Loading artifacts..." />}>
            <ArtifactList artifacts={artifactsData.artifacts} />
          </Suspense>
        )}
        {activeTab === 'comments' && (
          <Suspense fallback={<LoadingState message="Loading comments..." />}>
            <CommentThread targetId={runId} targetType="run" initialComments={commentsData} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
