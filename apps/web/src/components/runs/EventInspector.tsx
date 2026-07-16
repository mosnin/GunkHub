'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import type { Event, ListEventsResponse } from '@agent-flight-recorder/contracts'

import { CodeBlock } from '@/components/ui/CodeBlock'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'

const WINDOW_SIZE = 100

interface EventInspectorProps {
  runId: string
  events?: Event[]
  initialNextCursor?: string
  loading?: boolean
  initialEventSeq?: number
  isLive?: boolean
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

type SeekState = 'idle' | 'seeking' | 'not-found'

export function EventInspector({ runId, events, initialNextCursor, loading, initialEventSeq, isLive = false }: EventInspectorProps) {
  const initialId = (initialEventSeq !== undefined && events)
    ? (events.find((e) => e.sequenceNumber === initialEventSeq)?.id ?? null)
    : null
  const [selectedId, setSelectedId] = useState<string | null>(initialId)
  const [focusedIdx, setFocusedIdx] = useState<number>(-1)
  const [windowStart, setWindowStart] = useState<number>(0)
  const [extraEvents, setExtraEvents] = useState<Event[]>([])
  const [cursor, setCursor] = useState<string | undefined>(initialNextCursor)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [seekState, setSeekState] = useState<SeekState>('idle')
  const [followTail, setFollowTail] = useState(isLive)
  const [unseenCount, setUnseenCount] = useState(0)

  // Keep a stable ref to followTail for use inside polling effect closures
  const followTailRef = useRef(isLive)
  useEffect(() => {
    followTailRef.current = followTail
  }, [followTail])

  const allEvents = [...(events ?? []), ...extraEvents]

  // Always-current set of known event IDs, for dedup inside polling closures.
  // The interval closure captures state at effect-setup time, so deduping against
  // the `allEvents` array (stale) re-classifies already-appended events as new and
  // appends them again every tick. A ref is read live, so dedup stays correct.
  const knownIdsRef = useRef<Set<string>>(new Set())
  // Highest known sequence number, for tail polling (fetch events after it).
  const maxSeqRef = useRef<number>(0)
  useEffect(() => {
    const ids = new Set<string>()
    let maxSeq = 0
    for (const e of allEvents) {
      ids.add(e.id)
      if (e.sequenceNumber > maxSeq) maxSeq = e.sequenceNumber
    }
    knownIdsRef.current = ids
    maxSeqRef.current = maxSeq
  }, [events, extraEvents])

  // Guards against overlapping fetches without depending on the stale `isPending`
  // captured by the interval closure.
  const inFlightRef = useRef(false)

  function handleLoadMore() {
    if (!cursor) return
    setLoadError(null)
    const prevTotal = (events?.length ?? 0) + extraEvents.length
    startTransition(async () => {
      try {
        const params = new URLSearchParams({ cursor, limit: '200' })
        const res = await fetch(`/api/runs/${runId}/events?${params.toString()}`)
        if (!res.ok) throw new Error(`Failed to load events (${res.status})`)
        const data = (await res.json()) as ListEventsResponse
        const newTotal = prevTotal + data.events.length
        setExtraEvents((prev) => [...prev, ...data.events])
        setCursor(data.nextCursor)
        // Auto-advance only when following tail; otherwise accumulate unseen count
        if (data.events.length > 0) {
          if (followTailRef.current) {
            setWindowStart(Math.max(0, newTotal - WINDOW_SIZE))
          } else {
            setUnseenCount((prev) => prev + data.events.length)
          }
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load more events')
      }
    })
  }

  async function pollFromStart() {
    try {
      // Tail from the highest known sequence number so new events are found
      // regardless of run size. Re-fetching page 1 would only ever return the
      // earliest events and never the newly-appended tail on runs > one page.
      const maxSeq = maxSeqRef.current
      const res = await fetch(`/api/runs/${runId}/events?limit=200&afterSeq=${maxSeq}`)
      if (!res.ok) return
      const data = (await res.json()) as ListEventsResponse
      // Dedup against the LIVE id set (ref), not the stale closure array.
      const known = knownIdsRef.current
      const brandNew = data.events.filter((e) => !known.has(e.id))
      if (brandNew.length > 0) {
        // Add immediately so a rapid follow-up poll (before re-render) won't
        // re-append the same events, and advance the tail cursor.
        for (const e of brandNew) {
          known.add(e.id)
          if (e.sequenceNumber > maxSeqRef.current) maxSeqRef.current = e.sequenceNumber
        }
        setExtraEvents((prev) => {
          const next = [...prev, ...brandNew]
          const newTotal = (events?.length ?? 0) + next.length
          if (followTailRef.current) {
            setWindowStart(Math.max(0, newTotal - WINDOW_SIZE))
          } else {
            setUnseenCount((u) => u + brandNew.length)
          }
          return next
        })
      }
      // NOTE: intentionally do NOT reset `cursor` here. When cursor is undefined
      // all pages are loaded and we are tailing; re-seeding it from page 1's cursor
      // restarts pagination and re-appends already-loaded pages every tick.
    } catch {
      // Non-fatal: ignore failed polls
    }
  }

  // On mount: check if initialEventSeq is already in the initial page or needs seeking
  useEffect(() => {
    if (initialEventSeq === undefined) return
    const found = allEvents.find((e) => e.sequenceNumber === initialEventSeq)
    if (found) {
      const idx = allEvents.indexOf(found)
      setSelectedId(found.id)
      setFocusedIdx(idx)
      setWindowStart(Math.max(0, idx - Math.floor(WINDOW_SIZE / 2)))
    } else if (cursor) {
      // Not in initial page but more pages exist — start seeking
      setSeekState('seeking')
    }
    // If not found and no cursor: leave as-is (initialId already null)
  }, []) // Only on mount — intentional empty dep array for mount-only effect

  // Continue seeking: check newly loaded events for the target sequence number
  useEffect(() => {
    if (seekState !== 'seeking') return
    const found = allEvents.find((e) => e.sequenceNumber === initialEventSeq)
    if (found) {
      const idx = allEvents.indexOf(found)
      setSelectedId(found.id)
      setFocusedIdx(idx)
      setWindowStart(Math.max(0, idx - Math.floor(WINDOW_SIZE / 2)))
      setSeekState('idle')
    } else if (!cursor) {
      // Exhausted all pages, event not found
      setSeekState('not-found')
    }
    // If cursor still exists and not found: the next effect triggers load
  }, [allEvents.length, seekState]) // intentional — cursor/initialEventSeq are stable references

  // Auto-trigger load-more while seeking and more pages exist
  useEffect(() => {
    if (seekState === 'seeking' && cursor && !isPending) {
      handleLoadMore()
    }
  }, [seekState, cursor, isPending])

  // Live polling: when isLive=true, poll every 5 seconds for new events
  useEffect(() => {
    if (!isLive) return
    const POLL_MS = 5000
    const timer = setInterval(() => {
      if (inFlightRef.current) return // skip if a fetch is already in flight
      inFlightRef.current = true
      void (async () => {
        try {
          if (cursor) {
            handleLoadMore()
          } else {
            await pollFromStart()
          }
        } finally {
          inFlightRef.current = false
        }
      })()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [isLive, cursor, runId])

  if (loading) {
    return <LoadingState message="Loading events..." />
  }

  if (allEvents.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No events" description="No events have been recorded for this run yet." />
      </div>
    )
  }

  const selectedEvent = allEvents.find((e) => e.id === selectedId) ?? allEvents[0] ?? null

  function handleResume() {
    setFollowTail(true)
    setUnseenCount(0)
    setWindowStart(Math.max(0, allEvents.length - WINDOW_SIZE))
  }

  function ensureSelectedVisible(absIdx: number) {
    if (absIdx < windowStart) {
      setWindowStart(Math.max(0, absIdx))
    } else if (absIdx >= windowStart + WINDOW_SIZE) {
      setWindowStart(Math.min(allEvents.length - WINDOW_SIZE, absIdx))
    }
  }

  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (allEvents.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFollowTail(false)
      const next = Math.min(allEvents.length - 1, focusedIdx < 0 ? windowStart : focusedIdx + 1)
      setFocusedIdx(next)
      setSelectedId(allEvents[next]?.id ?? null)
      if (next >= windowStart + WINDOW_SIZE) {
        setWindowStart(Math.min(allEvents.length - WINDOW_SIZE, next))
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFollowTail(false)
      const prev = Math.max(0, focusedIdx < 0 ? windowStart : focusedIdx - 1)
      setFocusedIdx(prev)
      setSelectedId(allEvents[prev]?.id ?? null)
      if (prev < windowStart) {
        setWindowStart(Math.max(0, prev))
      }
    }
  }

  return (
    <EventInspectorInner
      allEvents={allEvents}
      selectedEvent={selectedEvent}
      setSelectedId={setSelectedId}
      setFollowTail={setFollowTail}
      focusedIdx={focusedIdx}
      setFocusedIdx={setFocusedIdx}
      windowStart={windowStart}
      setWindowStart={setWindowStart}
      ensureSelectedVisible={ensureSelectedVisible}
      handleListKeyDown={handleListKeyDown}
      cursor={cursor}
      loadError={loadError}
      isPending={isPending}
      handleLoadMore={handleLoadMore}
      seekState={seekState}
      initialEventSeq={initialEventSeq}
      isLive={isLive}
      followTail={followTail}
      unseenCount={unseenCount}
      onResume={handleResume}
    />
  )
}

interface EventInspectorInnerProps {
  allEvents: Event[]
  selectedEvent: Event | null
  setSelectedId: (id: string | null) => void
  setFollowTail: (value: boolean) => void
  focusedIdx: number
  setFocusedIdx: (idx: number) => void
  windowStart: number
  setWindowStart: (start: number) => void
  ensureSelectedVisible: (absIdx: number) => void
  handleListKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  cursor: string | undefined
  loadError: string | null
  isPending: boolean
  handleLoadMore: () => void
  seekState?: SeekState
  initialEventSeq?: number
  isLive?: boolean
  followTail?: boolean
  unseenCount?: number
  onResume?: () => void
}

function EventInspectorInner({
  allEvents,
  selectedEvent,
  setSelectedId,
  setFollowTail,
  focusedIdx,
  setFocusedIdx,
  windowStart,
  setWindowStart,
  ensureSelectedVisible,
  handleListKeyDown,
  cursor,
  loadError,
  isPending,
  handleLoadMore,
  seekState,
  initialEventSeq,
  isLive,
  followTail = false,
  unseenCount = 0,
  onResume,
}: EventInspectorInnerProps) {
  // Sync ?event=<sequenceNumber> into the URL without navigation
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!selectedEvent) return
    const url = new URL(window.location.href)
    url.searchParams.set('event', String(selectedEvent.sequenceNumber))
    window.history.replaceState(null, '', url.toString())
  }, [selectedEvent?.sequenceNumber])

  const windowedEvents = allEvents.slice(windowStart, windowStart + WINDOW_SIZE)
  const aboveCount = windowStart
  const belowCount = allEvents.length - windowStart - WINDOW_SIZE

  return (
    <div className="flex h-full min-h-[400px]">
      {/* Left panel — event list */}
      <div className="w-1/3 border-r border-neutral-800 overflow-y-auto">
        <div className="px-3 py-2 border-b border-neutral-800 flex items-center justify-between">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Events</p>
          {isLive && (
            <div className="flex items-center gap-2">
              {!followTail && unseenCount > 0 && onResume && (
                <button
                  onClick={onResume}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-emerald-950 border border-emerald-800 text-emerald-400 hover:text-emerald-300 hover:border-emerald-700 transition-colors duration-100"
                >
                  ↓ {unseenCount} new — resume
                </button>
              )}
              <button
                onClick={followTail ? () => setFollowTail(false) : onResume}
                className={[
                  'flex items-center gap-1 text-xs font-mono transition-colors duration-100',
                  followTail ? 'text-neutral-600 hover:text-neutral-400' : 'text-neutral-600 hover:text-neutral-400',
                ].join(' ')}
                title={followTail ? 'Following tail — click to pause' : 'Tail paused — click to resume'}
              >
                {followTail && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
                )}
                <span>{followTail ? 'live' : 'paused'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Seek status */}
        {seekState === 'seeking' && (
          <p className="px-3 py-1.5 text-xs font-mono text-neutral-500 border-b border-neutral-800">
            Seeking event #{initialEventSeq}…
          </p>
        )}
        {seekState === 'not-found' && (
          <p className="px-3 py-1.5 text-xs font-mono text-amber-600 border-b border-neutral-800">
            Event #{initialEventSeq} not found in this run.
          </p>
        )}

        {/* Window navigation — above */}
        {aboveCount > 0 && (
          <button
            onClick={() => {
              setFollowTail(false)
              setWindowStart(Math.max(0, windowStart - WINDOW_SIZE))
            }}
            className="text-xs font-mono text-neutral-600 hover:text-neutral-400 px-3 py-1.5 border-b border-neutral-800 w-full text-left"
          >
            ↑ {aboveCount} above
          </button>
        )}

        <div
          tabIndex={0}
          className="outline-none"
          onFocus={() => { if (focusedIdx === -1) setFocusedIdx(0) }}
          onKeyDown={handleListKeyDown}
        >
          <ul className="divide-y divide-neutral-800/60">
            {windowedEvents.map((evt, relIdx) => {
              const absIdx = windowStart + relIdx
              return (
                <li
                  key={evt.id}
                  onClick={() => {
                    setFollowTail(false)
                    setSelectedId(evt.id)
                    setFocusedIdx(absIdx)
                    ensureSelectedVisible(absIdx)
                  }}
                  className={[
                    'px-3 py-2.5 flex items-center justify-between cursor-pointer transition-colors duration-75',
                    selectedEvent?.id === evt.id
                      ? 'bg-neutral-900 text-neutral-200'
                      : 'hover:bg-neutral-900/60 text-neutral-400',
                    focusedIdx === absIdx ? 'ring-1 ring-inset ring-neutral-600' : '',
                  ].join(' ')}
                >
                  <span className="text-xs font-mono">{evt.type}</span>
                  {(evt.payload as { type: string }).type === '_externalized' && (
                    <span className="text-amber-700 text-[10px] font-mono ml-1" title="Payload externalized">↗</span>
                  )}
                  <span className="text-xs font-mono text-neutral-600">#{evt.sequenceNumber}</span>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Window navigation — below */}
        {belowCount > 0 && (
          <button
            onClick={() => setWindowStart(Math.min(allEvents.length - WINDOW_SIZE, windowStart + WINDOW_SIZE))}
            className="text-xs font-mono text-neutral-600 hover:text-neutral-400 px-3 py-1.5 border-b border-neutral-800 w-full text-left"
          >
            ↓ {belowCount} below
          </button>
        )}

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
        <div className="px-4 py-2 border-b border-neutral-800 shrink-0 flex items-center justify-between">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Payload</p>
          {selectedEvent && (
            <button
              onClick={() => {
                void navigator.clipboard.writeText(window.location.href)
              }}
              title="Copy link to this event"
              className="text-xs font-mono text-neutral-600 hover:text-neutral-300 transition-colors duration-75 px-2 py-0.5 rounded hover:bg-neutral-800"
            >
              Copy link
            </button>
          )}
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
