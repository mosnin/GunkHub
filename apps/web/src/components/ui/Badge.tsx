import { cn } from '@/lib/utils'
import type { RunStatus } from '@agent-flight-recorder/contracts'

interface BadgeProps {
  status: RunStatus
  className?: string
}

const statusConfig: Record<RunStatus, { label: string; className: string }> = {
  pending: {
    label: 'pending',
    className: 'bg-neutral-800 text-neutral-400 border-neutral-700',
  },
  running: {
    label: 'running',
    className: 'bg-primary-900 text-primary-300 border-primary-800',
  },
  completed: {
    label: 'completed',
    className: 'bg-success-900 text-success-400 border-success-700',
  },
  failed: {
    label: 'failed',
    className: 'bg-destructive-900 text-destructive-400 border-destructive-700',
  },
  cancelled: {
    label: 'cancelled',
    className: 'bg-neutral-800 text-neutral-500 border-neutral-700',
  },
  timed_out: {
    label: 'timed out',
    className: 'bg-warning-900 text-warning-400 border-warning-700',
  },
}

export function Badge({ status, className }: BadgeProps) {
  // statusConfig is keyed by RunStatus — the lookup is always defined
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const config = statusConfig[status]!
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border',
        config.className,
        className
      )}
    >
      {config.label}
    </span>
  )
}
