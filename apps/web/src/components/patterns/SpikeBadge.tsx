import { cn } from '@/lib/utils'

interface SpikeBadgeProps {
  isSpiking: boolean
  /** True when the underlying service hasn't computed a spike assessment for this pattern yet (see adapt.ts's `hasSpikeAssessment`) — renders a neutral "not assessed" state instead of a false "not spiking" claim. */
  assessed?: boolean
  /**
   * True when an admin has muted alerts for this pattern (cycle 3 mute
   * control — see PatternMuteControl). Only affects the SPIKING badge: it
   * never hides the spike itself, it just appends a compact "MUTED"
   * annotation so an engineer sees both "this is spiking" and "alerts are
   * off for it" at a glance, without needing to correlate a second badge.
   * When the pattern is NOT spiking, this prop is a no-op — render
   * `<MutedBadge>` alongside instead (see that component).
   */
  mutedAlerts?: boolean
  className?: string
}

/**
 * Compact spike indicator for a pattern row/detail header. Uses ONLY the
 * neon accent for the "spiking" state — no off-palette red/amber — per
 * design.md ("Neon Glow ... data visualizations", reserved for interactive
 * highlights and status). A calm dot animates only when the pattern is
 * actually spiking, and only under motion-safe (prefers-reduced-motion off).
 */
export function SpikeBadge({ isSpiking, assessed = true, mutedAlerts = false, className }: SpikeBadgeProps) {
  if (!assessed) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border bg-graphite text-pewter border-graphite-light',
          className,
        )}
        title="Spike assessment has not run for this pattern yet"
      >
        not assessed
      </span>
    )
  }

  if (!isSpiking) return null

  return (
    <span
      role="status"
      aria-label={
        mutedAlerts
          ? 'This failure pattern is spiking — recent occurrences are well above its baseline rate. Alerts are muted for this pattern.'
          : 'This failure pattern is spiking — recent occurrences are well above its baseline rate'
      }
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border bg-primary-900/40 text-neon-glow border-primary-700',
        className,
      )}
    >
      <span
        className="w-1.5 h-1.5 rounded-full bg-neon-glow shadow-[var(--shadow-glow)] motion-safe:animate-neon-pulse shrink-0 forced-colors:bg-[Highlight]"
        aria-hidden="true"
      />
      SPIKING
      {mutedAlerts && <span className="text-pewter">· MUTED</span>}
    </span>
  )
}
