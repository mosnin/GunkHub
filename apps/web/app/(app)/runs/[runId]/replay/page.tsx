import type { Metadata } from 'next'
import { ReplayViewer } from '@/components/runs/ReplayViewer'

export const metadata: Metadata = { title: 'Replay' }

interface ReplayPageProps {
  params: { runId: string }
}

export default function ReplayPage({ params }: ReplayPageProps) {
  const { runId } = params

  return (
    <div className="flex flex-col h-full">
      {/* Informational banner */}
      <div className="px-6 py-2.5 bg-neutral-900 border-b border-neutral-800">
        <p className="text-xs text-neutral-500">
          Replay is a derived projection. It does not modify the underlying event log.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <ReplayViewer runId={runId} />
      </div>
    </div>
  )
}
