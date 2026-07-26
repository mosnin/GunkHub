import { cn, formatRelativeTime } from '@/lib/utils'

interface MutedBadgeProps {
  /** Epoch ms the pattern was muted, if known — used only for the tooltip. */
  mutedAt?: number
  className?: string
}

/**
 * Compact "Muted" indicator for a failure pattern whose alerts an admin has
 * suppressed (mute/unmute control, cycle 3 — see PatternMuteControl). Shown
 * whenever `pattern.muted` is true and the pattern is NOT currently spiking.
 * When it IS spiking, `SpikeBadge`'s `mutedAlerts` prop already annotates the
 * SPIKING badge itself ("SPIKING · MUTED") so callers should render only one
 * of the two — never hide the spike, never show a redundant second badge.
 *
 * Palette-only: this is a neutral status marker, not an alert, so it uses the
 * graphite/pewter greyscale system per design.md — never an off-palette
 * "warning" color.
 */
export function MutedBadge({ mutedAt, className }: MutedBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border bg-graphite text-pewter border-graphite-light whitespace-nowrap',
        className,
      )}
      title={
        typeof mutedAt === 'number'
          ? `Alerts muted for this pattern ${formatRelativeTime(mutedAt)}`
          : 'Alerts are muted for this pattern'
      }
    >
      MUTED
      <span className="sr-only"> — alerts are muted for this pattern</span>
    </span>
  )
}
