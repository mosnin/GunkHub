import type { FailureSummary as FailureSummaryType } from '@agent-flight-recorder/contracts'

interface FailureSummaryProps {
  summary: FailureSummaryType
}

/**
 * Compact failure callout panel. Renders only when the run has failed or is incomplete.
 * Designed to sit at the top of the run detail page without overwhelming the layout.
 */
export function FailureSummary({ summary }: FailureSummaryProps) {
  if (!summary.hasFailure && !summary.isIncomplete) return null

  const isFailed = summary.hasFailure
  const isIncomplete = summary.isIncomplete && !summary.hasFailure

  return (
    <div
      className={[
        'mx-6 mt-4 rounded-[4px] border px-4 py-3',
        isFailed
          ? 'bg-destructive-900/30 border-destructive-700/60'
          : 'bg-destructive-900/15 border-destructive-700/40',
      ].join(' ')}
      role="alert"
    >
      {/* Status line */}
      <div className="flex items-center gap-2 mb-2">
        <span aria-hidden="true" className={isFailed ? 'text-destructive-500' : 'text-destructive-400/70'}>
          {isFailed ? (
            // X icon
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : (
            // Warning icon
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M5.98 2.2L1.2 10a1.2 1.2 0 001.02 1.8h9.56A1.2 1.2 0 0012.8 10L8.02 2.2a1.2 1.2 0 00-2.04 0z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path d="M7 5.5v2.5M7 9.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span
          className={[
            'text-sm font-semibold',
            isFailed ? 'text-destructive-400' : 'text-destructive-400/80',
          ].join(' ')}
        >
          {isFailed ? 'Run Failed' : 'Incomplete'}
        </span>
      </div>

      {/* Cannot infer message */}
      {summary.cannotInfer && (
        <p className="text-xs text-neutral-500 mb-2">
          Cannot infer root cause — the run.failed event has no error message in the payload.
        </p>
      )}

      {/* Primary failure */}
      {summary.primaryFailure && (
        <div className="mb-2">
          <span className="text-xs text-neutral-500">Primary cause: </span>
          <span className="text-xs font-mono text-destructive-400">
            {summary.primaryFailure.type}
          </span>
          <span className="text-xs font-mono text-neutral-500">
            {' '}at #{summary.primaryFailure.sequenceNumber}
          </span>
          {summary.primaryFailure.errorMessage && (
            <p className="mt-1 text-xs text-neutral-400 leading-relaxed">
              Error: {summary.primaryFailure.errorMessage}
            </p>
          )}
        </div>
      )}

      {/* Incomplete message (no primary failure to show) */}
      {isIncomplete && !summary.primaryFailure && (
        <p className="text-xs text-destructive-400/80 mb-2">
          This run has no terminal event. It may still be in progress or was interrupted.
        </p>
      )}

      {/* Additional failure points */}
      {summary.allFailurePoints.length > 1 && (
        <div className="mt-2 pt-2 border-t border-neutral-800/60">
          <p className="text-xs text-neutral-500 mb-1">Also:</p>
          <ul className="flex flex-col gap-0.5">
            {summary.allFailurePoints
              .filter((fp) => fp.eventId !== summary.primaryFailure?.eventId)
              .map((fp) => (
                <li key={fp.eventId} className="text-xs font-mono">
                  <span className="text-neutral-500">{fp.type}</span>
                  <span className="text-pewter"> at </span>
                  <span className="text-neutral-500">#{fp.sequenceNumber}</span>
                  {fp.errorMessage && (
                    <span className="text-pewter font-sans ml-2">{fp.errorMessage.slice(0, 80)}</span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  )
}
