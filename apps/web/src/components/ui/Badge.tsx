import type { RunStatus } from '@agent-flight-recorder/contracts'

import { cn } from '@/lib/utils'

interface BadgeProps {
  status: RunStatus
  className?: string
}

// Status pills carry a small status dot for at-a-glance scanning (design.md:
// high signal, calm technical palette). Only live/terminal states glow.
const statusConfig: Record<RunStatus, { label: string; className: string; dot: string }> = {
  pending: {
    label: 'pending',
    className: 'bg-graphite text-pewter border-graphite-light',
    dot: 'bg-pewter',
  },
  running: {
    label: 'running',
    className: 'bg-primary-900 text-primary-300 border-primary-800',
    dot: 'bg-neon-glow shadow-[var(--shadow-glow)] animate-neon-pulse',
  },
  completed: {
    label: 'completed',
    className: 'bg-success-900 text-success-400 border-success-700',
    dot: 'bg-neon-glow shadow-[var(--shadow-glow)]',
  },
  failed: {
    label: 'failed',
    className: 'bg-destructive-900 text-destructive-400 border-destructive-700',
    dot: 'bg-destructive-500 shadow-[var(--shadow-glow-warn)]',
  },
  cancelled: {
    label: 'cancelled',
    className: 'bg-graphite text-pewter border-graphite-light',
    dot: 'bg-pewter',
  },
  timed_out: {
    label: 'timed out',
    className: 'bg-warning-900 text-warning-400 border-warning-700',
    dot: 'bg-warning-500',
  },
}

export function Badge({ status, className }: BadgeProps) {
  const config = statusConfig[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border',
        config.className,
        className
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', config.dot)} aria-hidden="true" />
      {config.label}
    </span>
  )
}
