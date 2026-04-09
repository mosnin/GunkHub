'use client'

import { LoadingState } from '@/components/ui/LoadingState'

interface TimelineProps {
  runId: string
  loading?: boolean
}

const PLACEHOLDER_SLOTS = 5

export function Timeline({ runId: _runId, loading }: TimelineProps) {
  if (loading) {
    return <LoadingState message="Loading timeline..." />
  }

  return (
    <div className="px-6 py-4">
      <p className="text-xs text-neutral-600 mb-5">
        Timeline shows events in sequence order. Implement in prompt 2.
      </p>
      <div className="relative">
        {/* Left rail */}
        <div className="absolute left-[11px] top-3 bottom-3 w-px bg-neutral-800" aria-hidden="true" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: PLACEHOLDER_SLOTS }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-[23px] h-[23px] shrink-0 rounded-full border border-neutral-800 bg-neutral-900 z-10" />
              <div className="flex-1 h-7 rounded bg-neutral-900 border border-neutral-800 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
