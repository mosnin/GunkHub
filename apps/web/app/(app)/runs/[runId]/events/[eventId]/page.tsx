import Link from 'next/link'
import { notFound } from 'next/navigation'

import type { Metadata } from 'next'

import { ErrorState } from '@/components/ui/ErrorState'
import { getEvent } from '@/lib/services/events'

export const metadata: Metadata = { title: 'Event Detail' }

interface EventDetailPageProps {
  params: { runId: string; eventId: string }
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const { runId, eventId } = params

  let event: Awaited<ReturnType<typeof getEvent>> | null = null
  let fetchError: string | null = null

  try {
    event = await getEvent(eventId)
  } catch (err) {
    // notFound() throws a NEXT_NOT_FOUND digest — if that were caught here it
    // would leak into the ErrorState below. Keep it out of the try entirely and
    // only translate genuine "not found" fetch errors into a 404.
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.toLowerCase().includes('not found')) notFound()
    fetchError = msg
  }

  // Outside the try: a valid event under the wrong run URL (or a missing event)
  // must 404, and notFound()'s thrown digest must propagate, not be swallowed.
  if (!fetchError && (!event || event.runId !== runId)) notFound()

  if (fetchError) {
    return (
      <div className="p-6">
        <ErrorState title="Failed to load event" message={fetchError} />
      </div>
    )
  }

  if (!event) return null

  const payloadJson = JSON.stringify(event.payload, null, 2)

  return (
    <div className="p-6 max-w-4xl">
      {/* Breadcrumb */}
      <nav className="mb-4 flex items-center gap-2 text-xs text-neutral-500">
        <Link href={`/runs/${runId}`} className="hover:text-neutral-300 transition-colors">
          Run
        </Link>
        <span>/</span>
        <Link href={`/runs/${runId}?tab=events`} className="hover:text-neutral-300 transition-colors">
          Events
        </Link>
        <span>/</span>
        <span className="font-mono text-neutral-400">{eventId.slice(-8)}</span>
      </nav>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="font-mono text-sm text-neutral-200 bg-neutral-800 px-2 py-1 rounded">
            {event.type}
          </span>
          <span className="text-xs text-neutral-500">
            seq #{event.sequenceNumber}
          </span>
          <span className="text-xs text-pewter tabular-nums">
            {new Date(event.timestamp).toISOString()}
          </span>
        </div>
        {event.parentEventId && (
          <div className="text-xs text-neutral-500">
            Parent:{' '}
            <Link
              href={`/runs/${runId}/events/${event.parentEventId}`}
              className="font-mono text-primary-400 hover:text-primary-300 transition-colors"
            >
              {event.parentEventId.slice(-8)}
            </Link>
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="mb-6 rounded-md border border-neutral-800 bg-neutral-900/40 p-4">
        <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">
          Metadata
        </h2>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <div>
            <dt className="text-neutral-500 text-xs">Event ID</dt>
            <dd className="font-mono text-neutral-300 text-xs mt-0.5">{event.id}</dd>
          </div>
          <div>
            <dt className="text-neutral-500 text-xs">Run ID</dt>
            <dd className="font-mono text-neutral-300 text-xs mt-0.5">{event.runId}</dd>
          </div>
          <div>
            <dt className="text-neutral-500 text-xs">Sequence Number</dt>
            <dd className="font-mono text-neutral-300 text-xs mt-0.5">{event.sequenceNumber}</dd>
          </div>
          <div>
            <dt className="text-neutral-500 text-xs">Timestamp</dt>
            <dd className="font-mono text-neutral-300 text-xs mt-0.5">{event.timestamp}</dd>
          </div>
        </dl>
      </div>

      {/* Payload */}
      <div>
        <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">
          Payload
        </h2>
        <div className="rounded-md border border-neutral-800 bg-neutral-950 overflow-auto max-h-[600px]">
          <pre className="p-4 text-xs font-mono text-neutral-300 leading-relaxed whitespace-pre">
            {payloadJson}
          </pre>
        </div>
      </div>
    </div>
  )
}
