'use client'

import { analyzeRunOrdering, readEventTiming } from '@agent-flight-recorder/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'


import type { FailureSummary, ReplayFrame, ReplayProjection } from '@agent-flight-recorder/contracts'

import {
  EventTimingRows,
  InferredTimingMark,
  OrderingBasisNote,
} from '@/components/runs/TemporalOrderNote'
import { EmptyState } from '@/components/ui/EmptyState'
import { isEditableTarget, isNavFirstKey, isNavLastKey } from '@/lib/hooks/useKeyScope'

interface ReplayViewerProps {
  projection: ReplayProjection
  failureSummary: FailureSummary
}

// Windowed rendering (parity with Timeline/DiffViewer): only this many frames
// are mounted at once, with earlier/later expanders. Keeps the DOM bounded for
// 10k-frame replays.
const WINDOW_SIZE = 100

// Actor → left border treatment. design.md limits colour to Neon Glow, the red
// alert, and greys. The actor name is shown in the frame metadata, so hue only
// encodes lifecycle: red for an errored frame, the single Neon accent for the
// system/run lifecycle, neutral for every other actor.
function actorBorderClass(frame: ReplayFrame): string {
  if (frame.status === 'error') return 'border-l-destructive-600'
  if (frame.actor === 'system') return 'border-l-neon-muted'
  return 'border-l-neutral-700'
}

// Actor → dot treatment, same rationale as actorBorderClass.
function actorDotClass(frame: ReplayFrame): string {
  if (frame.status === 'error') return 'bg-destructive-500'
  if (frame.actor === 'system') return 'bg-neon-glow'
  return 'bg-neutral-600'
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(2)}s`
}

interface FrameRowProps {
  frame: ReplayFrame
  isActive: boolean
  onClick: () => void
  rowRef?: React.Ref<HTMLButtonElement>
}

function FrameRow({ frame, isActive, onClick, rowRef }: FrameRowProps) {
  const indent = frame.depth * 16 // ml-4 = 16px per level
  return (
    <button
      ref={rowRef}
      onClick={onClick}
      aria-current={isActive ? 'true' : undefined}
      style={{ paddingLeft: `${8 + indent}px` }}
      className={[
        'w-full flex items-start gap-2 py-1.5 pr-3 text-left transition-colors duration-75',
        'border-l-2',
        actorBorderClass(frame),
        isActive
          ? 'bg-neutral-800'
          : 'bg-transparent hover:bg-neutral-900',
      ].join(' ')}
    >
      <span
        className={[
          'mt-1 shrink-0 w-1.5 h-1.5 rounded-full',
          actorDotClass(frame),
        ].join(' ')}
        aria-hidden="true"
      />
      <span className="flex-1 min-w-0">
        <span
          className={[
            'block text-xs font-mono truncate',
            frame.status === 'error' ? 'text-destructive-400' : 'text-neutral-300',
          ].join(' ')}
        >
          {frame.event.type}
        </span>
        {frame.payloadPreview && (
          <span className="block text-xs text-pewter truncate mt-0.5">
            {frame.payloadPreview}
          </span>
        )}
      </span>
      {/* `~` when this frame's instant was inferred rather than measured. Sits
          beside the sequence number, which on a derived run is the order we
          LEARNED of the event — not the order it happened. */}
      <span className="shrink-0 flex items-center gap-1 text-xs font-mono text-pewter mt-0.5">
        <InferredTimingMark timing={readEventTiming(frame.event)} />#
        {frame.event.sequenceNumber}
      </span>
      {frame.status === 'terminal' && (
        <span className="shrink-0 text-xs font-mono text-neon-glow mt-0.5">
          end
        </span>
      )}
    </button>
  )
}

export function ReplayViewer({ projection, failureSummary: _failureSummary }: ReplayViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const { frames } = projection
  const total = frames.length

  // Frame-list window, centered on the current step initially. Expander buttons
  // shift it; stepping outside the window recenters it (effect below).
  const [windowStart, setWindowStart] = useState(0)
  const activeRowRef = useRef<HTMLButtonElement | null>(null)

  const activeFrame = total > 0 ? frames[currentIndex] : null

  // What the rendered order of these frames is entitled to CLAIM. Derived from
  // the frames themselves, so no service or contract change is needed to carry
  // it: `buildReplayProjection` has already ordered them, and this reports which
  // ordering it used. Returns `sequence-native` for every first-party run, in
  // which case `OrderingBasisNote` renders nothing.
  const ordering = useMemo(() => analyzeRunOrdering(frames.map((f) => f.event)), [frames])

  function goPrev() {
    setCurrentIndex((i) => Math.max(0, i - 1))
  }

  function goNext() {
    setCurrentIndex((i) => Math.min(total - 1, i + 1))
  }

  // Unified list-navigation model (shared with Timeline/EventInspector):
  // ArrowLeft/ArrowRight step frames as before; `k`/`j` are the same "back"/
  // "forward" aliases the other inspectors use for up/down, and g/Home,
  // G/End jump to the first/last frame. See src/lib/hooks/useKeyScope.ts.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Never hijack keys while the user is typing in a form control.
      if (isEditableTarget(e.target)) return
      if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault()
        setCurrentIndex((i) => Math.max(0, i - 1))
      } else if (e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault()
        setCurrentIndex((i) => Math.min(total - 1, i + 1))
      } else if (isNavFirstKey(e)) {
        e.preventDefault()
        setCurrentIndex(0)
      } else if (isNavLastKey(e)) {
        e.preventDefault()
        setCurrentIndex(total - 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [total])

  // Keep the active frame inside the window: when stepping crosses the window
  // edge, recenter the window on the current step.
  useEffect(() => {
    if (currentIndex < windowStart || currentIndex >= windowStart + WINDOW_SIZE) {
      setWindowStart(
        Math.max(0, Math.min(currentIndex - Math.floor(WINDOW_SIZE / 2), total - WINDOW_SIZE))
      )
    }
  }, [currentIndex, windowStart, total])

  // Stepping scrolls the active frame into view within the frame list.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentIndex, windowStart])

  if (total === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2 bg-graphite border border-graphite-light rounded-[4px] mx-6 mt-4 text-xs text-pewter font-medium">
          Replay is a derived projection. The event log is not modified.
        </div>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            title="No frames"
            description="No events have been recorded for this run yet. Instrument your agent with the SDK to record events."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Read-only banner */}
      <div className="px-4 py-2 bg-graphite border border-graphite-light rounded-[4px] mx-6 mt-4 text-xs text-pewter font-medium shrink-0">
        Replay is a derived projection. The event log is not modified.
      </div>

      {/* Ordering basis — silent for a natively-recorded run. */}
      {ordering.basis !== 'sequence-native' && (
        <div className="mx-6 mt-2 shrink-0">
          <OrderingBasisNote ordering={ordering} subject="replay" />
        </div>
      )}

      {/* Truncation warning — shown when the run exceeds MAX_EVENTS_PER_REPLAY */}
      {projection.truncated && (
        <div className="px-4 py-2 bg-graphite border border-graphite-light rounded-[4px] mx-6 mt-2 text-xs text-pewter font-medium shrink-0">
          This run contains more than 10,000 events. Only the first 10,000 are shown in this replay.
        </div>
      )}

      {/* Controls bar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-neutral-800 mt-3 shrink-0">
        <button
          onClick={goPrev}
          disabled={currentIndex === 0}
          aria-label="Previous frame"
          className="w-8 h-8 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-75"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={goNext}
          disabled={currentIndex === total - 1}
          aria-label="Next frame"
          className="w-8 h-8 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-75"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <span className="text-xs font-mono text-neutral-400">
          Frame {currentIndex + 1} / {total}
        </span>

        {activeFrame && (
          <span className="text-xs font-mono text-pewter">
            {formatElapsed(activeFrame.elapsed_ms)}
          </span>
        )}

        <span className="ml-auto text-xs text-pewter font-mono">
          ←/→ or k/j to step · g/G first/last · press ? for all shortcuts
        </span>
      </div>

      {/* Main split: frame list + frame detail */}
      <div className="flex-1 flex overflow-hidden">
        {/* Frame list — windowed to WINDOW_SIZE mounted rows */}
        <div className="w-72 shrink-0 border-r border-neutral-800 overflow-y-auto">
          {windowStart > 0 && (
            <button
              onClick={() => setWindowStart(Math.max(0, windowStart - WINDOW_SIZE))}
              className="w-full text-left px-3 py-1.5 text-xs font-mono text-pewter hover:text-cloud border-b border-neutral-800 transition-colors duration-100"
            >
              ↑ {windowStart} earlier
            </button>
          )}
          {frames.slice(windowStart, windowStart + WINDOW_SIZE).map((frame, relIdx) => {
            const i = windowStart + relIdx
            return (
              <FrameRow
                key={frame.event.id}
                frame={frame}
                isActive={i === currentIndex}
                onClick={() => setCurrentIndex(i)}
                rowRef={i === currentIndex ? activeRowRef : undefined}
              />
            )
          })}
          {windowStart + WINDOW_SIZE < total && (
            <button
              onClick={() =>
                setWindowStart(Math.min(total - WINDOW_SIZE, windowStart + WINDOW_SIZE))
              }
              className="w-full text-left px-3 py-1.5 text-xs font-mono text-pewter hover:text-cloud border-t border-neutral-800 transition-colors duration-100"
            >
              ↓ {total - windowStart - WINDOW_SIZE} later
            </button>
          )}
        </div>

        {/* Frame detail */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeFrame ? (
            <FrameDetail frame={activeFrame} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

interface FrameDetailProps {
  frame: ReplayFrame
}

function FrameDetail({ frame }: FrameDetailProps) {
  const { event } = frame

  return (
    <div className="flex flex-col gap-4">
      {/* Frame header */}
      <div
        className={[
          'flex flex-col gap-1 border-l-4 pl-3 py-1',
          actorBorderClass(frame),
        ].join(' ')}
      >
        <div className="flex items-center gap-3">
          <span
            className={[
              'text-sm font-mono font-semibold',
              frame.status === 'error' ? 'text-destructive-400' : 'text-neutral-100',
            ].join(' ')}
          >
            {event.type}
          </span>
          {frame.status === 'error' && (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-destructive-900 text-destructive-400 border border-destructive-700">
              error
            </span>
          )}
          {frame.status === 'terminal' && (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-primary-900 text-neon-glow border border-primary-800">
              terminal
            </span>
          )}
        </div>
        {frame.payloadPreview && (
          <span className="text-xs text-neutral-500">{frame.payloadPreview}</span>
        )}
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div className="text-neutral-500">Sequence</div>
        <div className="font-mono text-neutral-300">#{event.sequenceNumber}</div>

        <div className="text-neutral-500">Actor</div>
        <div className="font-mono text-neutral-300">{frame.actor}</div>

        <div className="text-neutral-500">Elapsed</div>
        <div className="font-mono text-neutral-300">{formatElapsed(frame.elapsed_ms)}</div>

        {/* Timestamp — plus, for a derived event whose instant was clamped, the
            raw value and the skew. A clamped instant was NOT measured, and it is
            rendered as inferred rather than presented as a reading. */}
        <EventTimingRows event={event} />

        {event.parentEventId && (
          <>
            <div className="text-neutral-500">Parent</div>
            <div className="font-mono text-neutral-400 truncate">{event.parentEventId}</div>
          </>
        )}

        <div className="text-neutral-500">Depth</div>
        <div className="font-mono text-neutral-300">{frame.depth}</div>
      </div>

      {/* Payload */}
      <div>
        <div className="text-xs text-neutral-500 mb-2">Payload</div>
        <div className="rounded bg-neutral-950 border border-neutral-800 overflow-auto max-h-[480px]">
          <pre className="text-xs font-mono text-neutral-300 whitespace-pre-wrap break-words leading-relaxed p-3">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  )
}
