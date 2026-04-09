'use client'

import { LoadingState } from '@/components/ui/LoadingState'
import { CodeBlock } from '@/components/ui/CodeBlock'

interface EventInspectorProps {
  runId: string
  loading?: boolean
}

const PLACEHOLDER_EVENTS = [
  { type: 'run.started', seq: 1 },
  { type: 'llm.request', seq: 2 },
  { type: 'llm.response', seq: 3 },
  { type: 'tool.call', seq: 4 },
  { type: 'tool.result', seq: 5 },
]

export function EventInspector({ runId: _runId, loading }: EventInspectorProps) {
  if (loading) {
    return <LoadingState message="Loading events..." />
  }

  return (
    <div className="flex h-full min-h-[400px]">
      {/* Left panel — event list */}
      <div className="w-1/3 border-r border-neutral-800 overflow-y-auto">
        <div className="px-3 py-2 border-b border-neutral-800">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Events</p>
        </div>
        <ul className="divide-y divide-neutral-800/60">
          {PLACEHOLDER_EVENTS.map((evt) => (
            <li
              key={evt.seq}
              className="px-3 py-2.5 flex items-center justify-between hover:bg-neutral-900/60 cursor-default opacity-50"
            >
              <span className="text-xs font-mono text-neutral-400">{evt.type}</span>
              <span className="text-xs font-mono text-neutral-600">#{evt.seq}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Right panel — event detail */}
      <div className="flex-1 flex flex-col">
        <div className="px-4 py-2 border-b border-neutral-800">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Payload</p>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <p className="text-sm text-neutral-500 mb-4">Select an event to inspect its payload</p>
          <div className="w-full max-w-sm opacity-30">
            <CodeBlock content="{}" language="json" />
          </div>
        </div>
      </div>
    </div>
  )
}
