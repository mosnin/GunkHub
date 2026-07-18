'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'

import type { Event, ListEventsResponse } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'
import {
  isNavDownKey,
  isNavFirstKey,
  isNavLastKey,
  isNavUpKey,
  isPrimaryActionKey,
} from '@/lib/hooks/useKeyScope'

const WINDOW_SIZE = 100

interface TimelineProps {
  runId: string
  events?: Event[]
  initialNextCursor?: string
  loading?: boolean
  isLive?: boolean
}

/**
 * Timeline dot treatment. design.md sanctions only Neon Glow, the red alert, and
 * greys — event *types* are differentiated by the mono type label (already shown
 * next to each dot), not by hue. The dot therefore carries only lifecycle
 * meaning: the single Neon accent for run lifecycle, the red alert for failure,
 * neutral for every data event.
 */
function dotClass(type: string): string {
  if (type === 'run.failed') return 'border-destructive-700 bg-destructive-900'
  if (type.startsWith('run.')) return 'border-neon-muted bg-primary-900'
  return 'border-neutral-700 bg-neutral-800'
}

function payloadSummary(event: Event): string {
  const p = event.payload as unknown as Record<string, unknown>
  if (event.type === 'llm.request') {
    const model = typeof p.model === 'string' ? p.model : ''
    const msgs = Array.isArray(p.messages) ? p.messages.length : 0
    return model ? `${model} — ${msgs} message${msgs !== 1 ? 's' : ''}` : `${msgs} message${msgs !== 1 ? 's' : ''}`
  }
  if (event.type === 'llm.response') {
    const model = typeof p.model === 'string' ? p.model : ''
    const usage = p.usage as Record<string, number> | undefined
    const tokens = usage?.total_tokens
    return [model, tokens != null ? `${tokens} tokens` : ''].filter(Boolean).join(' — ')
  }
  if (event.type === 'tool.call') {
    return typeof p.name === 'string' ? p.name : ''
  }
  if (event.type === 'tool.result') {
    const ms = typeof p.duration_ms === 'number' ? `${p.duration_ms}ms` : ''
    return ms
  }
  if (event.type === 'http.request') {
    const method = typeof p.method === 'string' ? p.method : ''
    const url = typeof p.url === 'string' ? p.url.slice(0, 60) : ''
    return [method, url].filter(Boolean).join(' ')
  }
  if (event.type === 'http.response') {
    const status = typeof p.status === 'number' ? String(p.status) : ''
    const ms = typeof p.duration_ms === 'number' ? `${p.duration_ms}ms` : ''
    return [status, ms].filter(Boolean).join(' — ')
  }
  if (event.type === 'run.failed') {
    const err = p.error as Record<string, unknown> | undefined
    return typeof err?.message === 'string' ? err.message.slice(0, 80) : ''
  }
  return ''
}

export function Timeline({ runId, events, initialNextCursor, loading, isLive = false }: TimelineProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [extraEvents, setExtraEvents] = useState<Event[]>([])
  const [cursor, setCursor] = useState<string | undefined>(initialNextCursor)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [focusedIndex, setFocusedIndex] = useState<number>(-1)
  const [windowStart, setWindowStart] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const [followTail, setFollowTail] = useState(isLive)
  const [unseenCount, setUnseenCount] = useState(0)
  // True when the most recent live poll failed — drives the "reconnecting…"
  // stale indicator; cleared on the next successful poll.
  const [pollFailed, setPollFailed] = useState(false)

  // Keep a stable ref to extraEvents for use inside the polling effect closure
  const extraEventsRef = useRef<Event[]>(extraEvents)
  useEffect(() => {
    extraEventsRef.current = extraEvents
  }, [extraEvents])

  // Guards overlapping fetches without depending on the stale `isPending` value
  // captured by the interval closure.
  const inFlightRef = useRef(false)

  // Keep a stable ref to followTail for use inside the polling effect closure
  const followTailRef = useRef(isLive)
  useEffect(() => {
    followTailRef.current = followTail
  }, [followTail])

  const handleLoadMore = useCallback(() => {
    if (!cursor) return
    setLoadError(null)
    startTransition(async () => {
      try {
        const params = new URLSearchParams({ cursor, limit: '200' })
        const res = await fetch(`/api/runs/${runId}/events?${params.toString()}`)
        if (!res.ok) throw new Error(`Failed to load events (${res.status})`)
        const data = (await res.json()) as ListEventsResponse
        setPollFailed(false)
        // Dedup against already-loaded events so a re-fetched page cannot append
        // duplicates (defence-in-depth alongside the cursor-reset fix below).
        const known = new Set([
          ...(events ?? []).map((e) => e.id),
          ...extraEventsRef.current.map((e) => e.id),
        ])
        const fresh = data.events.filter((e) => !known.has(e.id))
        const prevTotal = (events?.length ?? 0) + extraEventsRef.current.length
        const newTotal = prevTotal + fresh.length
        if (fresh.length > 0) setExtraEvents((prev) => [...prev, ...fresh])
        setCursor(data.nextCursor)
        // Auto-advance only when following tail; otherwise accumulate unseen count
        if (fresh.length > 0) {
          if (followTailRef.current) {
            setWindowStart(Math.max(0, newTotal - WINDOW_SIZE))
          } else {
            setUnseenCount((prev) => prev + fresh.length)
          }
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load more events')
        // When live-polling via the cursor path, a failure must also surface as
        // the stale/reconnecting indicator, not just an inline load error.
        if (isLive) setPollFailed(true)
      }
    })
  }, [cursor, runId, events, isLive])

  // Live polling effect — re-runs when cursor changes to pick up the right strategy
  useEffect(() => {
    if (!isLive) return

    const POLL_MS = 5000

    async function pollFromStart() {
      // Tail from the highest known sequence number so newly-appended events are
      // found on runs larger than one page (re-fetching page 1 never returns them).
      const currentExtra = extraEventsRef.current
      let maxSeq = 0
      for (const e of events ?? []) if (e.sequenceNumber > maxSeq) maxSeq = e.sequenceNumber
      for (const e of currentExtra) if (e.sequenceNumber > maxSeq) maxSeq = e.sequenceNumber
      const res = await fetch(`/api/runs/${runId}/events?limit=200&afterSeq=${maxSeq}`)
      if (!res.ok) {
        setPollFailed(true)
        return
      }
      const data = (await res.json()) as ListEventsResponse
      setPollFailed(false)
      const allIds = new Set([...(events ?? []).map((e) => e.id), ...currentExtra.map((e) => e.id)])
      const brandNew = data.events.filter((e) => !allIds.has(e.id))
      if (brandNew.length > 0) {
        const newTotal = (events?.length ?? 0) + currentExtra.length + brandNew.length
        setExtraEvents((prev) => [...prev, ...brandNew])
        if (followTailRef.current) {
          setWindowStart(Math.max(0, newTotal - WINDOW_SIZE))
        } else {
          setUnseenCount((prev) => prev + brandNew.length)
        }
      }
      // NOTE: intentionally do NOT re-seed `cursor` from page 1 here. Doing so
      // restarts pagination, and handleLoadMore then re-fetches and re-appends
      // pages every tick — the run-duplication loop. Once cursor is undefined we
      // stay in tail-poll mode.
    }

    const timer = setInterval(() => {
      if (inFlightRef.current) return // skip tick if a fetch is already in flight
      inFlightRef.current = true
      void (async () => {
        try {
          if (cursor) {
            handleLoadMore() // uses existing path, auto-advances window
          } else {
            await pollFromStart()
          }
        } catch {
          // Network failure mid-poll — surface as the stale indicator instead
          // of swallowing (and avoid an unhandled rejection).
          setPollFailed(true)
        } finally {
          inFlightRef.current = false
        }
      })()
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [isLive, cursor, runId]) // re-run when cursor changes so strategy updates

  if (loading) {
    return <LoadingState message="Loading timeline..." />
  }

  const allEvents = [...(events ?? []), ...extraEvents]

  if (allEvents.length === 0) {
    return (
      <div className="px-6 py-4">
        <EmptyState title="No events" description="No events have been recorded for this run yet." />
      </div>
    )
  }

  const windowEnd = Math.min(allEvents.length, windowStart + WINDOW_SIZE)
  const visibleEvents = allEvents.slice(windowStart, windowEnd)

  // Unified list-navigation model (shared with EventInspector/ReplayViewer):
  // Arrow keys and j/k both move the roving focus, g/Home and G/End jump to
  // the ends of the list, and Enter runs the row's primary action (here,
  // expand/collapse the payload). See src/lib/hooks/useKeyScope.ts.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (allEvents.length === 0) return
    if (isNavDownKey(e)) {
      e.preventDefault()
      setFollowTail(false)
      const next = Math.min(allEvents.length - 1, focusedIndex < 0 ? windowStart : focusedIndex + 1)
      setFocusedIndex(next)
      if (next >= windowStart + WINDOW_SIZE) {
        setWindowStart(Math.min(allEvents.length - WINDOW_SIZE, next))
      }
    } else if (isNavUpKey(e)) {
      e.preventDefault()
      setFollowTail(false)
      const prev = Math.max(0, focusedIndex < 0 ? windowStart : focusedIndex - 1)
      setFocusedIndex(prev)
      if (prev < windowStart) {
        setWindowStart(Math.max(0, prev))
      }
    } else if (isNavFirstKey(e)) {
      e.preventDefault()
      setFollowTail(false)
      setFocusedIndex(0)
      setWindowStart(0)
    } else if (isNavLastKey(e)) {
      e.preventDefault()
      setFollowTail(false)
      const lastIndex = allEvents.length - 1
      setFocusedIndex(lastIndex)
      setWindowStart(Math.max(0, allEvents.length - WINDOW_SIZE))
    } else if (isPrimaryActionKey(e)) {
      e.preventDefault()
      const focused = allEvents[focusedIndex]
      if (focused) {
        setExpandedId(expandedId === focused.id ? null : focused.id)
      }
    }
  }

  function handleResume() {
    setFollowTail(true)
    setUnseenCount(0)
    setWindowStart(Math.max(0, allEvents.length - WINDOW_SIZE))
  }

  return (
    <div className="px-6 py-4">
      {/* Live / follow-tail indicator — polite live region so screen readers are
          told about newly streamed events (the count, not every event). */}
      {isLive && (
        <div role="status" aria-live="polite" className="flex items-center justify-end gap-3 px-6 pb-1">
          {pollFailed && (
            <span className="flex items-center gap-1.5 text-xs font-mono text-pewter">
              <span className="w-1.5 h-1.5 rounded-full bg-destructive-500 shrink-0" aria-hidden="true" />
              reconnecting…
            </span>
          )}
          {!followTail && unseenCount > 0 && (
            <button
              onClick={handleResume}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-primary-900 border border-primary-800 text-neon-glow hover:text-primary-300 hover:border-primary-700 transition-colors duration-100"
            >
              ↓ {unseenCount} new — resume
            </button>
          )}
          <button
            onClick={followTail ? () => setFollowTail(false) : handleResume}
            className={[
              'flex items-center gap-1.5 text-xs font-mono transition-colors duration-100',
              followTail ? 'text-neutral-500 hover:text-neutral-400' : 'text-pewter hover:text-cloud',
            ].join(' ')}
            title={followTail ? 'Following tail — click to pause' : 'Tail paused — click to resume'}
          >
            {followTail && (
              <span className="w-1.5 h-1.5 rounded-full bg-neon-glow animate-neon-pulse" aria-hidden="true" />
            )}
            <span>{followTail ? 'live' : 'paused'}</span>
          </button>
        </div>
      )}

      <div className="relative">
        {/* Vertical rail */}
        <div className="absolute left-[11px] top-3 bottom-3 w-px bg-neutral-800" aria-hidden="true" />
        <div
          ref={listRef}
          tabIndex={0}
          /* role=group supports aria-activedescendant, exposing the roving
             focus position to AT while keeping the inner expand buttons real
             buttons (a listbox would flatten them). */
          role="group"
          aria-label="Event timeline"
          aria-activedescendant={
            focusedIndex >= windowStart && focusedIndex < windowEnd && allEvents[focusedIndex]
              ? `tlrow-${allEvents[focusedIndex].id}`
              : undefined
          }
          onKeyDown={handleKeyDown}
          onFocus={() => { if (focusedIndex === -1) setFocusedIndex(0) }}
          className="flex flex-col gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neon-glow"
        >
          {/* Earlier events navigation button */}
          {windowStart > 0 && (
            <div className="flex justify-center py-1">
              <button
                onClick={() => {
                  setFollowTail(false)
                  setWindowStart(Math.max(0, windowStart - WINDOW_SIZE))
                }}
                className="px-4 py-1.5 text-xs font-mono rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 transition-colors duration-100"
              >
                ↑ {windowStart} earlier events
              </button>
            </div>
          )}

          {visibleEvents.map((event, relIdx) => {
            const absIdx = windowStart + relIdx
            const isExpanded = expandedId === event.id
            const summary = payloadSummary(event)

            return (
              <div
                key={event.id}
                id={`tlrow-${event.id}`}
                className={[
                  'flex items-start gap-3 rounded',
                  focusedIndex === absIdx ? 'ring-1 ring-neon-glow' : '',
                ].join(' ')}
              >
                <div
                  className={[
                    'w-[23px] h-[23px] shrink-0 rounded-full border z-10 mt-0.5',
                    dotClass(event.type),
                  ].join(' ')}
                  aria-hidden="true"
                />
                <div className="flex-1 rounded bg-neutral-900 border border-neutral-800 overflow-hidden">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : event.id)}
                    className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-neutral-800/60 transition-colors duration-75 group"
                    aria-expanded={isExpanded}
                  >
                    <span className="text-xs font-mono text-neutral-300 min-w-[140px]">{event.type}</span>
                    <span className="text-xs font-mono text-pewter w-10 shrink-0">
                      #{event.sequenceNumber}
                    </span>
                    {summary && (
                      <span className="text-xs text-neutral-500 truncate flex-1">{summary}</span>
                    )}
                    <span className="ml-auto text-xs font-mono text-pewter shrink-0">
                      {new Date(event.timestamp).toISOString().slice(11, 23)}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                      className={[
                        'shrink-0 text-pewter transition-transform duration-100',
                        isExpanded ? 'rotate-180' : '',
                      ].join(' ')}
                    >
                      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-neutral-800 bg-neutral-950 overflow-auto max-h-[320px]">
                      <pre className="text-xs font-mono text-neutral-300 whitespace-pre-wrap break-words leading-relaxed p-3">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Later loaded events navigation button */}
          {windowEnd < allEvents.length && (
            <div className="flex justify-center py-1">
              <button
                onClick={() => setWindowStart(Math.min(allEvents.length - WINDOW_SIZE, windowStart + WINDOW_SIZE))}
                className="px-4 py-1.5 text-xs font-mono rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 transition-colors duration-100"
              >
                ↓ {allEvents.length - windowEnd} more loaded events
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Load more / error */}
      {(cursor !== undefined || loadError !== null) && (
        <div className="mt-4 flex flex-col items-center gap-2">
          {loadError && (
            <p className="text-xs text-destructive-400">{loadError}</p>
          )}
          {cursor && (
            <button
              onClick={handleLoadMore}
              disabled={isPending}
              className="px-4 py-1.5 text-xs font-mono rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-100"
            >
              {isPending ? 'Loading…' : 'Load more events'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
