'use client'

import { useEffect, useState } from 'react'

import type { FailureSummary, ReplayFrame, ReplayProjection } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'

interface ReplayViewerProps {
  projection: ReplayProjection
  failureSummary: FailureSummary
}

// Actor → left border color class
function actorBorderClass(frame: ReplayFrame): string {
  if (frame.status === 'error') return 'border-l-red-600'
  switch (frame.actor) {
    case 'llm':       return 'border-l-violet-600'
    case 'tool':      return 'border-l-amber-600'
    case 'system':    return 'border-l-emerald-600'
    case 'http':      return 'border-l-sky-600'
    case 'memory':    return 'border-l-pink-600'
    case 'retrieval': return 'border-l-cyan-600'
    default:          return 'border-l-neutral-600'
  }
}

// Actor → dot color for the frame list
function actorDotClass(frame: ReplayFrame): string {
  if (frame.status === 'error') return 'bg-red-600'
  switch (frame.actor) {
    case 'llm':       return 'bg-violet-600'
    case 'tool':      return 'bg-amber-600'
    case 'system':    return 'bg-emerald-600'
    case 'http':      return 'bg-sky-600'
    case 'memory':    return 'bg-pink-600'
    case 'retrieval': return 'bg-cyan-600'
    default:          return 'bg-neutral-600'
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(2)}s`
}

interface FrameRowProps {
  frame: ReplayFrame
  isActive: boolean
  onClick: () => void
}

function FrameRow({ frame, isActive, onClick }: FrameRowProps) {
  const indent = frame.depth * 16 // ml-4 = 16px per level
  return (
    <button
      onClick={onClick}
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
            frame.status === 'error' ? 'text-red-400' : 'text-neutral-300',
          ].join(' ')}
        >
          {frame.event.type}
        </span>
        {frame.payloadPreview && (
          <span className="block text-xs text-neutral-600 truncate mt-0.5">
            {frame.payloadPreview}
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs font-mono text-neutral-700 mt-0.5">
        #{frame.event.sequenceNumber}
      </span>
      {frame.status === 'terminal' && (
        <span className="shrink-0 text-xs font-mono text-emerald-600 mt-0.5">
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

  const activeFrame = total > 0 ? frames[currentIndex] : null

  function goPrev() {
    setCurrentIndex((i) => Math.max(0, i - 1))
  }

  function goNext() {
    setCurrentIndex((i) => Math.min(total - 1, i + 1))
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setCurrentIndex((i) => Math.max(0, i - 1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setCurrentIndex((i) => Math.min(total - 1, i + 1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [total])

  if (total === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2 bg-amber-950/40 border border-amber-900/50 rounded-md mx-6 mt-4 text-xs text-amber-500/80 font-medium">
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
      <div className="px-4 py-2 bg-amber-950/40 border border-amber-900/50 rounded-md mx-6 mt-4 text-xs text-amber-500/80 font-medium shrink-0">
        Replay is a derived projection. The event log is not modified.
      </div>

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
          <span className="text-xs font-mono text-neutral-600">
            {formatElapsed(activeFrame.elapsed_ms)}
          </span>
        )}

        <span className="ml-auto text-xs text-neutral-700">
          ArrowLeft / ArrowRight to step
        </span>
      </div>

      {/* Main split: frame list + frame detail */}
      <div className="flex-1 flex overflow-hidden">
        {/* Frame list */}
        <div className="w-72 shrink-0 border-r border-neutral-800 overflow-y-auto">
          {frames.map((frame, i) => (
            <FrameRow
              key={frame.event.id}
              frame={frame}
              isActive={i === currentIndex}
              onClick={() => setCurrentIndex(i)}
            />
          ))}
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
              frame.status === 'error' ? 'text-red-400' : 'text-neutral-100',
            ].join(' ')}
          >
            {event.type}
          </span>
          {frame.status === 'error' && (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-red-950 text-red-400 border border-red-900">
              error
            </span>
          )}
          {frame.status === 'terminal' && (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-900">
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

        <div className="text-neutral-500">Timestamp</div>
        <div className="font-mono text-neutral-300">
          {new Date(event.timestamp).toISOString()}
        </div>

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
