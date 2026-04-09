import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LoadingState } from '@/components/ui/LoadingState'
import { RunHeader } from '@/components/runs/RunHeader'
import { Timeline } from '@/components/runs/Timeline'
import { EventInspector } from '@/components/runs/EventInspector'
import { ArtifactList } from '@/components/runs/ArtifactList'
import { CommentThread } from '@/components/runs/CommentThread'

export const metadata: Metadata = { title: 'Run Detail' }

const TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'events', label: 'Events' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'comments', label: 'Comments' },
] as const

type TabId = (typeof TABS)[number]['id']

interface RunDetailPageProps {
  params: { runId: string }
  searchParams: { tab?: string }
}

export default function RunDetailPage({ params, searchParams }: RunDetailPageProps) {
  const { runId } = params
  const activeTab: TabId =
    (searchParams.tab as TabId | undefined) &&
    TABS.some((t) => t.id === searchParams.tab)
      ? (searchParams.tab as TabId)
      : 'timeline'

  return (
    <div className="flex flex-col h-full">
      {/* Run header */}
      <Suspense fallback={<LoadingState message="Loading run..." />}>
        <RunHeader
          runId={runId}
          status="pending"
          agentName="—"
          startedAt={Date.now()}
        />
      </Suspense>

      {/* Tab bar */}
      <div className="border-b border-neutral-800 px-6">
        <nav className="-mb-px flex gap-6" role="tablist">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab
            return (
              <a
                key={tab.id}
                href={`/runs/${runId}?tab=${tab.id}`}
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
            <Timeline runId={runId} />
          </Suspense>
        )}
        {activeTab === 'events' && (
          <Suspense fallback={<LoadingState message="Loading events..." />}>
            <EventInspector runId={runId} />
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
