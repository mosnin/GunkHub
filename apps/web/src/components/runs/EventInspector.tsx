'use client'

import { useState } from 'react'

import type { Event } from '@agent-flight-recorder/contracts'

import { CodeBlock } from '@/components/ui/CodeBlock'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'

interface EventInspectorProps {
  runId: string
  events?: Event[]
  loading?: boolean
}

export function EventInspector({ runId: _runId, events, loading }: EventInspectorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (loading) {
    return <LoadingState message="Loading events..." />
  }

  if (!events || events.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No events" description="No events have been recorded for this run yet." />
      </div>
    )
  }

  const selectedEvent = events.find((e) => e.id === selectedId) ?? events[0] ?? null

  return (
    <div className="flex h-full min-h-[400px]">
      {/* Left panel — event list */}
      <div className="w-1/3 border-r border-neutral-800 overflow-y-auto">
        <div className="px-3 py-2 border-b border-neutral-800">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Events</p>
        </div>
        <ul className="divide-y divide-neutral-800/60">
          {events.map((evt) => (
            <li
              key={evt.id}
              onClick={() => setSelectedId(evt.id)}
              className={[
                'px-3 py-2.5 flex items-center justify-between cursor-pointer transition-colors duration-75',
                selectedEvent?.id === evt.id
                  ? 'bg-neutral-900 text-neutral-200'
                  : 'hover:bg-neutral-900/60 text-neutral-400',
              ].join(' ')}
            >
              <span className="text-xs font-mono">{evt.type}</span>
              <span className="text-xs font-mono text-neutral-600">#{evt.sequenceNumber}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Right panel — event payload */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 border-b border-neutral-800 shrink-0">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Payload</p>
        </div>
        {selectedEvent ? (
          <div className="flex-1 p-4 overflow-y-auto">
            <CodeBlock
              content={JSON.stringify(selectedEvent.payload, null, 2)}
              language="json"
            />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-neutral-500">Select an event to inspect its payload</p>
          </div>
        )}
      </div>
    </div>
  )
}
