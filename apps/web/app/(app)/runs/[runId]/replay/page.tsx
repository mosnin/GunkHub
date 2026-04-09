import { notFound } from 'next/navigation'

import type { Metadata } from 'next'

import { ReplayViewer } from '@/components/runs/ReplayViewer'
import { ErrorState } from '@/components/ui/ErrorState'
import { getReplayProjection } from '@/lib/services/replay'

export const metadata: Metadata = { title: 'Replay' }

interface ReplayPageProps {
  params: { runId: string }
}

export default async function ReplayPage({ params }: ReplayPageProps) {
  const { runId } = params

  let replayData: Awaited<ReturnType<typeof getReplayProjection>> | null = null
  let fetchError: string | null = null

  try {
    replayData = await getReplayProjection(runId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.toLowerCase().includes('not found')) notFound()
    fetchError = msg
  }

  if (fetchError) {
    return (
      <div className="p-6">
        <ErrorState title="Failed to load replay" message={fetchError} />
      </div>
    )
  }

  if (!replayData) return null

  return (
    <div className="flex flex-col h-full">
      <ReplayViewer
        projection={replayData.projection}
        failureSummary={replayData.failureSummary}
      />
    </div>
  )
}
