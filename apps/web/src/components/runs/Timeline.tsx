'use client'

import type { Event } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'

interface TimelineProps {
  runId: string
  events?: Event[]
  loading?: boolean
}

// Colour-code event type prefixes for quick visual scanning
function dotClass(type: string): string {
  if (type.startsWith('llm.')) return 'border-violet-700 bg-violet-950'
  if (type.startsWith('tool.')) return 'border-amber-700 bg-amber-950'
  if (type.startsWith('http.')) return 'border-sky-700 bg-sky-950'
  if (type.startsWith('run.')) return 'border-emerald-700 bg-emerald-950'
  return 'border-neutral-700 bg-neutral-900'
}

export function Timeline({ runId: _runId, events, loading }: TimelineProps) {
  if (loading) {
    return <LoadingState message="Loading timeline..." />
  }

  if (!events || events.length === 0) {
    return (
      <div className="px-6 py-4">
        <EmptyState title="No events" description="No events have been recorded for this run yet." />
      </div>
    )
  }

  return (
    <div className="px-6 py-4">
      <div className="relative">
        {/* Vertical rail */}
        <div className="absolute left-[11px] top-3 bottom-3 w-px bg-neutral-800" aria-hidden="true" />
        <div className="flex flex-col gap-2">
          {events.map((event) => (
            <div key={event.id} className="flex items-start gap-3">
              <div
                className={[
                  'w-[23px] h-[23px] shrink-0 rounded-full border z-10 mt-0.5',
                  dotClass(event.type),
                ].join(' ')}
                aria-hidden="true"
              />
              <div className="flex-1 rounded bg-neutral-900 border border-neutral-800 px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-neutral-300">{event.type}</span>
                  <span className="text-xs font-mono text-neutral-600">
                    #{event.sequenceNumber}
                  </span>
                  <span className="ml-auto text-xs font-mono text-neutral-600">
                    {new Date(event.timestamp).toISOString().slice(11, 23)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
