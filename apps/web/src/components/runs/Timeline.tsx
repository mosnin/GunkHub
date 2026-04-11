'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'

import type { Event, ListEventsResponse } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'

const WINDOW_SIZE = 100

interface TimelineProps {
  runId: string
  events?: Event[]
  initialNextCursor?: string
  loading?: boolean
  isLive?: boolean
}

/** Colour-code event type prefixes for quick visual scanning */
function dotClass(type: string): string {
  if (type.startsWith('llm.')) return 'border-violet-700 bg-violet-950'
  if (type.startsWith('tool.')) return 'border-amber-700 bg-amber-950'
  if (type.startsWith('http.')) return 'border-sky-700 bg-sky-950'
  if (type.startsWith('run.')) return 'border-emerald-700 bg-emerald-950'
  if (type.startsWith('memory.')) return 'border-pink-700 bg-pink-950'
  if (type.startsWith('retrieval.')) return 'border-cyan-700 bg-cyan-950'
  return 'border-neutral-700 bg-neutral-900'
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

  // Keep a stable ref to extraEvents for use inside the polling effect closure
  const extraEventsRef = useRef<Event[]>(extraEvents)
  useEffect(() => {
    extraEventsRef.current = extraEvents
  }, [extraEvents])

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
        const prevTotal = (events?.length ?? 0) + extraEventsRef.current.length
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
  }, [cursor, runId, events])

  // Live polling effect — re-runs when cursor changes to pick up the right strategy
  useEffect(() => {
    if (!isLive) return

    const POLL_MS = 5000

    async function pollFromStart() {
      const res = await fetch(`/api/runs/${runId}/events?limit=200`)
      if (!res.ok) return
      const data = (await res.json()) as ListEventsResponse
      const currentExtra = extraEventsRef.current
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
      // If a cursor appeared (run crossed page boundary), capture it
      if (data.nextCursor && !cursor) {
        setCursor(data.nextCursor)
      }
    }

    const timer = setInterval(() => {
      if (isPending) return // skip tick if a load is already in flight
      if (cursor) {
        handleLoadMore() // uses existing path, auto-advances window
      } else {
        void pollFromStart()
      }
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (allEvents.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFollowTail(false)
      const next = Math.min(allEvents.length - 1, focusedIndex < 0 ? windowStart : focusedIndex + 1)
      setFocusedIndex(next)
      if (next >= windowStart + WINDOW_SIZE) {
        setWindowStart(Math.min(allEvents.length - WINDOW_SIZE, next))
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFollowTail(false)
      const prev = Math.max(0, focusedIndex < 0 ? windowStart : focusedIndex - 1)
      setFocusedIndex(prev)
      if (prev < windowStart) {
        setWindowStart(Math.max(0, prev))
      }
    } else if (e.key === 'Enter') {
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
      {/* Live / follow-tail indicator */}
      {isLive && (
        <div className="flex items-center justify-end gap-3 px-6 pb-1">
          {!followTail && unseenCount > 0 && (
            <button
              onClick={handleResume}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-emerald-950 border border-emerald-800 text-emerald-400 hover:text-emerald-300 hover:border-emerald-700 transition-colors duration-100"
            >
              ↓ {unseenCount} new — resume
            </button>
          )}
          <button
            onClick={followTail ? () => setFollowTail(false) : handleResume}
            className={[
              'flex items-center gap-1.5 text-xs font-mono transition-colors duration-100',
              followTail ? 'text-neutral-500 hover:text-neutral-400' : 'text-neutral-600 hover:text-neutral-400',
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

      <div className="relative">
        {/* Vertical rail */}
        <div className="absolute left-[11px] top-3 bottom-3 w-px bg-neutral-800" aria-hidden="true" />
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (focusedIndex === -1) setFocusedIndex(0) }}
          className="flex flex-col gap-1.5 outline-none focus:outline-none"
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
                className={[
                  'flex items-start gap-3 rounded',
                  focusedIndex === absIdx ? 'ring-1 ring-neutral-600' : '',
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
                    <span className="text-xs font-mono text-neutral-600 w-10 shrink-0">
                      #{event.sequenceNumber}
                    </span>
                    {summary && (
                      <span className="text-xs text-neutral-500 truncate flex-1">{summary}</span>
                    )}
                    <span className="ml-auto text-xs font-mono text-neutral-600 shrink-0">
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
                        'shrink-0 text-neutral-600 transition-transform duration-100',
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
            <p className="text-xs text-red-400">{loadError}</p>
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
