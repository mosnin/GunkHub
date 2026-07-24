import type { RunExplanationSummaryState } from '@/lib/services/explanations'

interface ExplanationPreviewProps {
  state: RunExplanationSummaryState
}

/**
 * One-line "why did this fail?" preview for a failed-runs-list row — the
 * signature touch of the Explainability Layer. Purely additive: renders
 * nothing when there's nothing honest to show (`unavailable`), so a row
 * without an explanation degrades to exactly what it looked like before this
 * feature existed. Calm and dense — a failure-class chip plus one truncated
 * line of prose, never markup, never a layout-shifting block.
 *
 * The caller (see `withAnalyzingGracePeriod` in `lib/services/explanations.ts`)
 * is responsible for downgrading `analyzing` to `unavailable` once a run has
 * been over long enough that generation evidently isn't coming — this
 * component trusts whatever state it's handed and never shows an indefinite
 * pulse on its own.
 */
export function ExplanationPreview({ state }: ExplanationPreviewProps) {
  if (state.status === 'unavailable') return null

  if (state.status === 'analyzing') {
    return (
      <div className="flex items-center gap-1.5">
        <span
          className="w-1 h-1 rounded-full bg-neon-glow motion-safe:animate-pulse shrink-0 forced-colors:bg-[Highlight]"
          aria-hidden="true"
        />
        <span className="text-xs text-pewter font-mono">analyzing failure…</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-[4px] text-[11px] font-mono font-medium bg-destructive-900/40 text-destructive-400 border border-destructive-700/60">
        {state.failureClass.replace(/_/g, ' ')}
      </span>
      <span className="text-xs text-pewter truncate" title={state.summary}>
        {state.summary}
      </span>
    </div>
  )
}
