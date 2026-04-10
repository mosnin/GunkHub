'use client'

import { useState, useTransition } from 'react'

import type { Event, ListEventsResponse } from '@agent-flight-recorder/contracts'

import { CodeBlock } from '@/components/ui/CodeBlock'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'

interface EventInspectorProps {
  runId: string
  events?: Event[]
  initialNextCursor?: string
  loading?: boolean
}

/**
 * Rendered when an event's payload was externalized because it exceeded
 * the 10 KB threshold. Shows artifact metadata and avoids dumping raw
 * pointer JSON at the user.
 */
function ExternalizedPayloadView({ payload }: { payload: {
  type: '_externalized'
  originalType: string
  _artifact: {
    artifactId: string
    storageKey: string
    storageBucket: string
    checksum: string
    size: number
  }
}}) {
  const { originalType, _artifact } = payload
  const sizeKb = (_artifact.size / 1024).toFixed(1)
  const keyPreview = _artifact.storageKey.length > 40
    ? `…${_artifact.storageKey.slice(-37)}`
    : _artifact.storageKey

  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border bg-amber-900/40 text-amber-400 border-amber-700/60">
          externalized
        </span>
        <span className="text-xs text-neutral-500">
          original type:{' '}
          <span className="font-mono text-neutral-400">{originalType}</span>
        </span>
      </div>

      {/* Artifact metadata */}
      <dl className="flex flex-col gap-2 text-xs">
        <div className="flex items-start justify-between gap-4">
          <dt className="text-neutral-600 shrink-0 w-24">Artifact ID</dt>
          <dd className="font-mono text-neutral-400 truncate text-right">{_artifact.artifactId}</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-neutral-600 shrink-0 w-24">Storage key</dt>
          <dd className="font-mono text-neutral-500 text-right">{keyPreview}</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-neutral-600 shrink-0 w-24">Size</dt>
          <dd className="font-mono text-neutral-400">{sizeKb} KB</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-neutral-600 shrink-0 w-24">Checksum</dt>
          <dd className="font-mono text-neutral-500 text-right" title={_artifact.checksum}>
            {_artifact.checksum.slice(0, 16)}…
          </dd>
        </div>
      </dl>

      {/* Note */}
      <p className="text-xs text-neutral-600 border-t border-neutral-800 pt-3 mt-1">
        Full payload stored as artifact. View it in the{' '}
        <span className="text-neutral-500">Artifacts</span> tab.
      </p>
    </div>
  )
}

export function EventInspector({ runId, events, initialNextCursor, loading }: EventInspectorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [extraEvents, setExtraEvents] = useState<Event[]>([])
  const [cursor, setCursor] = useState<string | undefined>(initialNextCursor)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleLoadMore() {
    if (!cursor) return
    setLoadError(null)
    startTransition(async () => {
      try {
        const params = new URLSearchParams({ cursor, limit: '200' })
        const res = await fetch(`/api/runs/${runId}/events?${params.toString()}`)
        if (!res.ok) throw new Error(`Failed to load events (${res.status})`)
        const data = (await res.json()) as ListEventsResponse
        setExtraEvents((prev) => [...prev, ...data.events])
        setCursor(data.nextCursor)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load more events')
      }
    })
  }

  if (loading) {
    return <LoadingState message="Loading events..." />
  }

  const allEvents = [...(events ?? []), ...extraEvents]

  if (allEvents.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No events" description="No events have been recorded for this run yet." />
      </div>
    )
  }

  const selectedEvent = allEvents.find((e) => e.id === selectedId) ?? allEvents[0] ?? null

  return (
    <div className="flex h-full min-h-[400px]">
      {/* Left panel — event list */}
      <div className="w-1/3 border-r border-neutral-800 overflow-y-auto">
        <div className="px-3 py-2 border-b border-neutral-800">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Events</p>
        </div>
        <ul className="divide-y divide-neutral-800/60">
          {allEvents.map((evt) => (
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
              {(evt.payload as { type: string }).type === '_externalized' && (
                <span className="text-amber-700 text-[10px] font-mono ml-1" title="Payload externalized">↗</span>
              )}
              <span className="text-xs font-mono text-neutral-600">#{evt.sequenceNumber}</span>
            </li>
          ))}
        </ul>

        {/* Load more */}
        {(cursor !== undefined || loadError !== null) && (
          <div className="px-3 py-2 border-t border-neutral-800 flex flex-col gap-1">
            {loadError && (
              <p className="text-xs text-red-400">{loadError}</p>
            )}
            {cursor && (
              <button
                onClick={handleLoadMore}
                disabled={isPending}
                className="text-xs font-mono text-neutral-500 hover:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-100"
              >
                {isPending ? 'Loading…' : 'Load more…'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right panel — event payload */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 border-b border-neutral-800 shrink-0">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Payload</p>
        </div>
        {selectedEvent ? (
          <div className="flex-1 overflow-y-auto">
            {(selectedEvent.payload as { type: string }).type === '_externalized' ? (
              <ExternalizedPayloadView payload={selectedEvent.payload as {
                type: '_externalized'
                originalType: string
                _artifact: {
                  artifactId: string
                  storageKey: string
                  storageBucket: string
                  checksum: string
                  size: number
                }
              }} />
            ) : (
              <div className="p-4">
                <CodeBlock
                  content={JSON.stringify(selectedEvent.payload, null, 2)}
                  language="json"
                />
              </div>
            )}
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
