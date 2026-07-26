import type { RunTriageState } from '@agent-flight-recorder/contracts'

interface EnvironmentChipProps {
  environment: string
  className?: string
}

/**
 * Environment chip — neutral graphite pill, no semantic color (design.md:
 * reserve destructive/neon for genuine status, not descriptive metadata).
 */
export function EnvironmentChip({ environment, className }: EnvironmentChipProps) {
  return (
    <span
      className={[
        'inline-flex items-center px-1.5 py-0.5 rounded-[4px] text-xs font-mono text-cloud bg-graphite border border-graphite-light',
        className ?? '',
      ].join(' ')}
      title={`Environment: ${environment}`}
    >
      {environment}
    </span>
  )
}

const TRIAGE_CONFIG: Record<RunTriageState, { label: string; className: string; dot: string }> = {
  open: {
    label: 'open',
    className: 'bg-destructive-900 text-destructive-400 border-destructive-700',
    dot: 'bg-destructive-500 shadow-[var(--shadow-glow-warn)]',
  },
  investigating: {
    label: 'investigating',
    className: 'bg-warning-900 text-warning-400 border-warning-700',
    dot: 'bg-warning-500',
  },
  resolved: {
    label: 'resolved',
    className: 'bg-success-900 text-success-400 border-success-700',
    dot: 'bg-neon-glow shadow-[var(--shadow-glow)]',
  },
}

interface TriageChipProps {
  triageState: RunTriageState
  className?: string
}

export function TriageChip({ triageState, className }: TriageChipProps) {
  const cfg = TRIAGE_CONFIG[triageState]
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border',
        cfg.className,
        className ?? '',
      ].join(' ')}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} aria-hidden="true" />
      {cfg.label}
    </span>
  )
}

export function LabelChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded-[4px] text-xs font-mono text-neutral-400 bg-neutral-900 border border-neutral-700">
      {label}
    </span>
  )
}
