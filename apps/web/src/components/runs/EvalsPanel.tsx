import type { RunEvalSummary } from '@/lib/services/evals'
import type { Eval } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'
import { formatRelativeTime } from '@/lib/utils'

interface EvalsPanelProps {
  evals: Eval[]
  /** Pass/fail/score header from Team B's insights.getRunEvalSummary.
      Omitted (or unavailable) hides the header — the per-eval list below
      still renders either way. */
  summary?: RunEvalSummary
}

function SummaryHeader({ summary }: { summary: RunEvalSummary }) {
  if (!summary.available || summary.total === 0) return null
  const passColor = summary.passRatePct !== null && summary.passRatePct >= 90
    ? 'text-neon-glow'
    : summary.passRatePct !== null && summary.passRatePct < 50
      ? 'text-destructive-500'
      : 'text-whiteout'
  return (
    <dl className="flex flex-wrap gap-3 px-6 pt-6">
      <div className="flex-1 min-w-[100px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
        <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Pass rate</dt>
        <dd className={`mt-1 font-mono text-xl tabular-nums ${passColor}`}>
          {summary.passRatePct !== null ? `${summary.passRatePct.toFixed(1)}%` : '—'}
        </dd>
      </div>
      <div className="flex-1 min-w-[100px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
        <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Passed</dt>
        <dd className="mt-1 font-mono text-xl text-whiteout tabular-nums">{summary.passed}</dd>
      </div>
      <div className="flex-1 min-w-[100px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
        <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Failed</dt>
        <dd className="mt-1 font-mono text-xl text-destructive-500 tabular-nums">{summary.failed}</dd>
      </div>
      {summary.avgScore !== undefined && (
        <div className="flex-1 min-w-[100px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
          <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Avg score</dt>
          <dd className="mt-1 font-mono text-xl text-cloud tabular-nums">{summary.avgScore.toFixed(2)}</dd>
        </div>
      )}
    </dl>
  )
}

function PassFailChip({ passed }: { passed: boolean }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border shrink-0',
        passed
          ? 'bg-success-900 text-success-400 border-success-700'
          : 'bg-destructive-900 text-destructive-400 border-destructive-700',
      ].join(' ')}
    >
      <span
        className={[
          'w-1.5 h-1.5 rounded-full shrink-0',
          passed ? 'bg-neon-glow shadow-[var(--shadow-glow)]' : 'bg-destructive-500 shadow-[var(--shadow-glow-warn)]',
        ].join(' ')}
        aria-hidden="true"
      />
      {passed ? 'pass' : 'fail'}
    </span>
  )
}

/** Run-detail Evals tab — every eval recorded against this run (convex/evals.ts, append-only). */
export function EvalsPanel({ evals, summary }: EvalsPanelProps) {
  if (evals.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No evals recorded for this run"
          description="Evals are recorded automatically when the run's agent version has evalRules configured, or manually via recordEval. Nothing has been recorded against this run yet."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 pb-6">
      {summary && <SummaryHeader summary={summary} />}
      <div className="px-6 pt-6 flex flex-col gap-2">
      {evals.map((e) => (
        <div
          key={e.id}
          className="flex items-start gap-3 px-4 py-3 rounded-[4px] border border-graphite bg-graphite-deep"
        >
          <PassFailChip passed={e.passed} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-whiteout">{e.name}</span>
              <span className="text-xs font-mono text-pewter">{e.kind}</span>
              {e.score !== undefined && (
                <span className="text-xs font-mono text-cloud">score {e.score.toFixed(2)}</span>
              )}
            </div>
            {e.details && (
              <p className="mt-1 text-xs text-ash leading-relaxed break-words">{e.details}</p>
            )}
          </div>
          <span className="text-xs text-pewter shrink-0 font-mono">{formatRelativeTime(e.createdAt)}</span>
        </div>
      ))}
      </div>
    </div>
  )
}
