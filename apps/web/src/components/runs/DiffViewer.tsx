'use client'

interface DiffViewerProps {
  leftRunId?: string
  rightRunId?: string
}

export function DiffViewer({ leftRunId, rightRunId }: DiffViewerProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Run selectors */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Run A
          </label>
          <input
            type="text"
            disabled
            defaultValue={leftRunId ?? ''}
            placeholder="Select run A..."
            className="h-9 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-sm text-neutral-400 placeholder-neutral-600 font-mono cursor-not-allowed outline-none"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Run B
          </label>
          <input
            type="text"
            disabled
            defaultValue={rightRunId ?? ''}
            placeholder="Select run B..."
            className="h-9 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-sm text-neutral-400 placeholder-neutral-600 font-mono cursor-not-allowed outline-none"
          />
        </div>
      </div>

      {/* Stat badges */}
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-success-900/40 border border-success-700/50 text-xs font-mono font-medium text-success-400">
          <span>+</span>
          <span>Added</span>
          <span className="text-success-600">—</span>
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-destructive-900/40 border border-destructive-700/50 text-xs font-mono font-medium text-destructive-400">
          <span>-</span>
          <span>Removed</span>
          <span className="text-destructive-600">—</span>
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-warning-900/40 border border-warning-700/50 text-xs font-mono font-medium text-warning-400">
          <span>~</span>
          <span>Changed</span>
          <span className="text-warning-600">—</span>
        </span>
      </div>

      {/* Diff area */}
      <div className="rounded-md border border-neutral-800 bg-neutral-900 flex flex-col items-center justify-center py-20 px-6 text-center">
        <div className="w-10 h-10 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-4">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            className="text-neutral-600"
          >
            <rect x="2" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
            <rect x="9" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
        <p className="text-sm font-medium text-neutral-400">Event diff will render here</p>
        <p className="text-xs text-neutral-600 mt-1.5 max-w-xs leading-relaxed">
          Select two runs above to see a side-by-side comparison of their event sequences.
        </p>
      </div>
    </div>
  )
}
