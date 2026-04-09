import { notFound } from 'next/navigation'
import { Suspense } from 'react'

import type { FailureSummary } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { ArtifactList } from '@/components/runs/ArtifactList'
import { CommentThread } from '@/components/runs/CommentThread'
import { EventInspector } from '@/components/runs/EventInspector'
import { FailureSummary as FailureSummaryPanel } from '@/components/runs/FailureSummary'
import { RunHeader } from '@/components/runs/RunHeader'
import { Timeline } from '@/components/runs/Timeline'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { listEvents } from '@/lib/services/events'
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
  searchParams: { tab?: string }
}

export default async function RunDetailPage({ params, searchParams }: RunDetailPageProps) {
  const { runId } = params

  const activeTab: TabId =
    (searchParams.tab as TabId | undefined) && TABS.some((t) => t.id === searchParams.tab)
      ? (searchParams.tab as TabId)
      : 'timeline'

  // Fetch run and events server-side
  let runData: Awaited<ReturnType<typeof getRun>> | null = null
  let eventsData: Awaited<ReturnType<typeof listEvents>> | null = null
  let fetchError: string | null = null
  let failureSummary: FailureSummary | null = null

  try {
    runData = await getRun(runId)
    eventsData = await listEvents({ runId, limit: 500 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.toLowerCase().includes('not found')) notFound()
    fetchError = msg
  }

  // Failure summary is additive — a failed fetch does not block the rest of the page.
  try {
    const replayData = await getReplayProjection(runId)
    failureSummary = replayData.failureSummary
  } catch {
    // Non-fatal: skip the failure panel if the projection cannot be built.
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

  return (
    <div className="flex flex-col h-full">
      {/* Run header */}
      <RunHeader
        runId={runId}
        status={run.status}
        agentName={run.agentId}
        startedAt={run.startedAt}
        endedAt={run.endedAt}
        triggeredBy={run.triggeredBy}
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
            <Timeline runId={runId} events={events} />
          </Suspense>
        )}
        {activeTab === 'events' && (
          <Suspense fallback={<LoadingState message="Loading events..." />}>
            <EventInspector runId={runId} events={events} />
          </Suspense>
        )}
        {activeTab === 'artifacts' && (
          <Suspense fallback={<LoadingState message="Loading artifacts..." />}>
            <ArtifactList runId={runId} />
          </Suspense>
        )}
        {activeTab === 'comments' && (
          <Suspense fallback={<LoadingState message="Loading comments..." />}>
            <CommentThread targetId={runId} targetType="run" />
          </Suspense>
        )}
      </div>
    </div>
  )
}
