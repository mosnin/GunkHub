'use client'

interface ReplayViewerProps {
  runId: string
}

export function ReplayViewer({ runId: _runId }: ReplayViewerProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Read-only banner */}
      <div className="px-4 py-2 bg-amber-950/40 border border-amber-900/50 rounded-md mx-6 mt-4 text-xs text-amber-500/80 font-medium">
        Read-only projection — no changes are made to the event log
      </div>

      {/* Controls bar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-neutral-800 mt-4">
        {/* Play/Pause */}
        <button
          disabled
          className="w-8 h-8 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-600 cursor-not-allowed"
          aria-label="Play"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 2l7 4-7 4V2z" fill="currentColor" />
          </svg>
        </button>

        {/* Step */}
        <button
          disabled
          className="w-8 h-8 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-600 cursor-not-allowed"
          aria-label="Step forward"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 2l5 4-5 4V2zM9 2v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Speed */}
        <select
          disabled
          className="h-8 px-2 rounded bg-neutral-800 border border-neutral-700 text-xs text-neutral-600 cursor-not-allowed"
        >
          <option>1x</option>
          <option>2x</option>
          <option>0.5x</option>
        </select>

        {/* Progress bar */}
        <div className="flex-1 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
          <div className="h-full w-0 bg-primary-600 rounded-full" />
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        <div className="w-12 h-12 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center mb-4">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" className="text-neutral-700" />
            <path d="M7.5 6.5l6 3.5-6 3.5v-7z" fill="currentColor" className="text-neutral-600" />
          </svg>
        </div>
        <p className="text-sm font-medium text-neutral-400">Replay projection will render here</p>
        <p className="text-xs text-neutral-600 mt-1.5 max-w-xs leading-relaxed">
          The replay engine reconstructs agent state step-by-step from the immutable event log.
        </p>
      </div>

      {/* Frame counter */}
      <div className="px-6 py-3 border-t border-neutral-800 flex items-center justify-between">
        <span className="text-xs font-mono text-neutral-600">0 / 0 events</span>
        <span className="text-xs text-neutral-700">frame 0</span>
      </div>
    </div>
  )
}
