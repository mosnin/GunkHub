import type { FailurePatternStatus } from '@agent-flight-recorder/contracts'

import { cn } from '@/lib/utils'

interface PatternStatusBadgeProps {
  status: FailurePatternStatus
  /**
   * True when this is a REGRESSED pattern — `status === 'open'` AND
   * `regressedAt` is set (see `isRegressedPattern` in adapt.ts). Takes
   * priority over `status` for rendering: a regressed pattern IS open (the
   * regression guard reopened it), but "open" alone would understate what
   * happened, so this prop swaps in the distinct regressed treatment
   * instead of the plain "Open" badge.
   */
  regressed?: boolean
  className?: string
}

const STATUS_LABEL: Record<FailurePatternStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
}

// Neutral statuses (open/acknowledged) use the same graphite/pewter greyscale
// as MutedBadge — they're informational, not urgent. Resolved gets the calm
// Neon Glow "good" treatment (mirrors SpikeBadge's muted accent surface).
// Regressed is deliberately the ONLY status that departs from that calm
// register: a solid Neon Glow fill (inverted text) plus the pulsing dot
// SpikeBadge reserves for "this needs attention now" — the palette's only
// accent color pushed as hard as design.md allows, since it must read as
// urgent without reaching for an off-palette red.
const STATUS_CLASSES: Record<FailurePatternStatus, string> = {
  open: 'bg-graphite text-pewter border-graphite-light',
  acknowledged: 'bg-graphite text-cloud border-graphite-light',
  resolved: 'bg-primary-900/40 text-neon-glow border-primary-700',
}

/**
 * Lifecycle status badge for a failure pattern (docs/adr/006-failure-
 * resolution.md) — Open / Acknowledged / Resolved, plus a distinct
 * "Regressed" treatment for a resolved pattern the automatic regression
 * guard has reopened. Palette-only per design.md: no off-palette red/amber,
 * urgency comes from Neon Glow contrast + the shared pulsing-dot motif, not
 * a different hue.
 */
export function PatternStatusBadge({ status, regressed = false, className }: PatternStatusBadgeProps) {
  if (regressed) {
    return (
      <span
        role="status"
        aria-label="Regressed — this pattern was resolved but has failed again"
        className={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-mono font-semibold whitespace-nowrap',
          'bg-neon-glow text-graphite-deep border border-neon-glow',
          className,
        )}
        title="Resolved, then failed again — the regression guard reopened this pattern"
      >
        <span
          className="w-1.5 h-1.5 rounded-full bg-graphite-deep motion-safe:animate-neon-pulse shrink-0 forced-colors:bg-[Highlight]"
          aria-hidden="true"
        />
        REGRESSED
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border whitespace-nowrap',
        STATUS_CLASSES[status],
        className,
      )}
    >
      {STATUS_LABEL[status].toUpperCase()}
    </span>
  )
}
