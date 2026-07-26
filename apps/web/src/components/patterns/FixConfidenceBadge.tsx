import type { FixConfidenceState } from '@/components/patterns/adapt'

import { cn } from '@/lib/utils'

interface FixConfidenceBadgeProps {
  state: FixConfidenceState
  /**
   * 0..0.95. Rendered as a bare decimal against the ceiling elsewhere; here
   * it only ever appears as a secondary suffix, never as the primary content
   * — a number alone is exactly what this feature exists to stop shipping.
   */
  score?: number
  /** Hides the numeric suffix — used in dense table cells where the word alone must carry. */
  compact?: boolean
  className?: string
}

/**
 * "Did the fix hold?" at a glance — the four states Team B's `fixConfidence()`
 * derives (convex/insights.ts §12).
 *
 * The whole point is that these four must NEVER render identically:
 *
 *  - UNPROVEN  — a resolution was asserted, nothing has exercised it yet.
 *    Pure greyscale, the same calm register as MutedBadge. This is NOT an
 *    error state and must not be styled as one; it is also emphatically not
 *    success, so it gets none of the accent that `confirmed` earns.
 *  - PROVING   — evidence is accumulating. Greyscale text on a hairline
 *    accent border: visibly on its way to confirmed without claiming it.
 *  - CONFIRMED — the muted accent surface cycle 1 gives `resolved`.
 *  - REGRESSED — the fix demonstrably did not hold. Solid Neon Glow with
 *    inverted text plus the pulsing dot, matching PatternStatusBadge's
 *    regressed treatment exactly so the two never disagree on screen.
 *
 * Palette-only per design.md: urgency comes from contrast and motion, never a
 * hue outside Blackout/Whiteout/greyscale/Neon Glow. No red.
 */
const STATE_LABEL: Record<FixConfidenceState, string> = {
  unproven: 'UNPROVEN',
  proving: 'PROVING',
  confirmed: 'CONFIRMED',
  regressed: 'REGRESSED',
}

const STATE_CLASSES: Record<FixConfidenceState, string> = {
  unproven: 'bg-graphite text-pewter border-graphite-light',
  proving: 'bg-graphite text-cloud border-neon-muted',
  confirmed: 'bg-primary-900/40 text-neon-glow border-primary-700',
  regressed: 'bg-neon-glow text-graphite-deep border-neon-glow font-semibold',
}

const STATE_TITLE: Record<FixConfidenceState, string> = {
  unproven: 'Resolved, but nothing has exercised the fix yet — untested, not proven',
  proving: 'Evidence is accumulating: runs since the fix, no recurrence yet',
  confirmed: 'Enough clean exposure since the fix to call it held',
  regressed: 'The fix did not hold — this pattern failed again after being resolved',
}

export function FixConfidenceBadge({ state, score, compact = false, className }: FixConfidenceBadgeProps) {
  const showScore = !compact && typeof score === 'number' && Number.isFinite(score) && state !== 'regressed'

  return (
    // NOT a live region. This badge renders once per row in the patterns
    // list; `role="status"` turned a static table into N simultaneous
    // announcements on every render. The four states are distinguished by
    // their WORD (so the distinction survives greyscale, forced colors, and
    // a screen reader alike) — the sr-only sentence only adds the nuance a
    // sighted user gets from the tooltip.
    <span
      title={STATE_TITLE[state]}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border whitespace-nowrap',
        STATE_CLASSES[state],
        className,
      )}
    >
      {state === 'regressed' && (
        <span
          className="w-1.5 h-1.5 rounded-full bg-graphite-deep motion-safe:animate-neon-pulse shrink-0 forced-colors:bg-[Highlight]"
          aria-hidden="true"
        />
      )}
      {STATE_LABEL[state]}
      <span className="sr-only"> fix confidence — {STATE_TITLE[state]}</span>
      {showScore && (
        <span className="text-pewter font-normal">
          <span className="sr-only">score </span>
          {score.toFixed(2)}
        </span>
      )}
    </span>
  )
}
