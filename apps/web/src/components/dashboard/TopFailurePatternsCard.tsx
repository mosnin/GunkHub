import Link from 'next/link'

import type { AdaptedFailurePattern } from '@/components/patterns/adapt'

import { MutedBadge } from '@/components/patterns/MutedBadge'
import { SpikeBadge } from '@/components/patterns/SpikeBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { formatRelativeTime } from '@/lib/utils'

interface TopFailurePatternsCardProps {
  /** null = the fetch failed (see `error`); [] = fetch succeeded, no patterns yet. */
  patterns: AdaptedFailurePattern[] | null
  error: string | null
}

const MAX_ROWS = 5

function formatFailureClass(cls: string): string {
  return cls.replace(/_/g, ' ')
}

/**
 * Dashboard glance ordering: spiking patterns first (the ones an engineer
 * needs to see NOW), then the rest by `lastSeenAt` descending — same base
 * order as the full Patterns list (PatternList), just with a "surface what's
 * actively spiking" boost on top since this card only has room for a few
 * rows.
 */
function rankForDashboard(patterns: AdaptedFailurePattern[]): AdaptedFailurePattern[] {
  return [...patterns]
    .sort((a, b) => {
      const aSpiking = a.lastSpikeAssessment?.isSpiking === true ? 1 : 0
      const bSpiking = b.lastSpikeAssessment?.isSpiking === true ? 1 : 0
      if (aSpiking !== bSpiking) return bSpiking - aSpiking
      return b.lastSeenAt - a.lastSeenAt
    })
    .slice(0, MAX_ROWS)
}

/**
 * Compact "Top recurring failures" widget for the dashboard — a proactive
 * surface for the Failure Patterns feature (PREVENTION, cycle 2) so an
 * engineer sees "this keeps happening" without navigating to /patterns
 * first. Reuses the cycle-1 SpikeBadge and the same `AdaptedFailurePattern`
 * shape as the Patterns list/detail pages. Every row deep-links to
 * `/patterns/[fingerprint]`.
 *
 * Three states, same convention as the rest of this page: `error` renders
 * ErrorState, an empty (but successfully fetched) list renders a calm
 * EmptyState ("No recurring failures — nice"), otherwise the ranked rows.
 */
export function TopFailurePatternsCard({ patterns, error }: TopFailurePatternsCardProps) {
  return (
    <div className="neon-surface relative overflow-hidden p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-pewter">Top recurring failures</h2>
        <Link
          href="/patterns"
          className="text-xs font-mono text-pewter hover:text-cloud transition-colors duration-100"
        >
          view all →
        </Link>
      </div>

      {error ? (
        <ErrorState title="Failed to load failure patterns" message={error} />
      ) : !patterns || patterns.length === 0 ? (
        <EmptyState
          title="No recurring failures — nice"
          description="Patterns appear here once the same failure fingerprint recurs across more than one run."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-graphite">
          {rankForDashboard(patterns).map((pattern) => (
            <li key={pattern.id || pattern.fingerprintHash}>
              <Link
                href={`/patterns/${encodeURIComponent(pattern.fingerprintHash)}`}
                className="flex items-center gap-3 py-2.5 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className="text-sm text-whiteout group-hover:text-neon-glow transition-colors duration-100 truncate"
                    title={pattern.label}
                  >
                    {pattern.label}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-[4px] text-[11px] font-mono font-medium border bg-graphite text-cloud border-graphite-light whitespace-nowrap">
                      {formatFailureClass(pattern.class)}
                    </span>
                    <span className="text-xs font-mono text-pewter whitespace-nowrap">
                      {formatRelativeTime(pattern.lastSeenAt)}
                    </span>
                  </div>
                </div>
                <span className="font-mono text-sm text-neutral-300 shrink-0 tabular-nums">
                  {pattern.count.toLocaleString()}
                </span>
                <SpikeBadge
                  isSpiking={pattern.lastSpikeAssessment?.isSpiking === true}
                  assessed={pattern.hasSpikeAssessment}
                  mutedAlerts={pattern.muted}
                  className="shrink-0"
                />
                {pattern.muted && pattern.lastSpikeAssessment?.isSpiking !== true && (
                  <MutedBadge mutedAt={pattern.mutedAt} className="shrink-0" />
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
