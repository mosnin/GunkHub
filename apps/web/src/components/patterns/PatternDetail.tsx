import Link from 'next/link'

import type { AdaptedFailurePattern } from '@/components/patterns/adapt'
import type { FailurePatternOccurrence, FailurePatternTrendPoint } from '@agent-flight-recorder/contracts'

import { PatternTrendSparkline } from '@/components/patterns/PatternTrendSparkline'
import { SpikeBadge } from '@/components/patterns/SpikeBadge'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatRelativeTime, truncateId } from '@/lib/utils'

/** Resolved label + owning agent for one affected agent version, keyed by agentVersionId. Resolved server-side by the detail page (mirrors how the run-detail page resolves `agentVersionLabel` via `getAgentVersion`). */
export interface ResolvedAgentVersion {
  agentId: string
  version: string
}

interface PatternDetailProps {
  pattern: AdaptedFailurePattern
  recentOccurrences: FailurePatternOccurrence[]
  trend: FailurePatternTrendPoint[]
  agentVersions: Record<string, ResolvedAgentVersion | undefined>
}

function formatFailureClass(cls: string): string {
  return cls.replace(/_/g, ' ')
}

function formatDay(day: string): string {
  if (!day) return 'unknown day'
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Full detail view for one failure-fingerprint pattern: trend, spike assessment, representative runs, and affected agent versions. */
export function PatternDetail({ pattern, recentOccurrences, trend, agentVersions }: PatternDetailProps) {
  const spike = pattern.lastSpikeAssessment
  const isSpiking = spike?.isSpiking === true

  return (
    <div className="flex flex-col gap-6">
      {/* Header — label, class, fingerprint, spike state */}
      <div className="rounded-[4px] border border-graphite-light bg-graphite-deep px-5 py-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-lg font-medium text-whiteout truncate">{pattern.label}</h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="inline-flex items-center px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border bg-graphite text-cloud border-graphite-light">
                {formatFailureClass(pattern.class)}
              </span>
              <div className="flex items-center gap-1">
                <span className="text-xs font-mono text-pewter" title={pattern.fingerprintHash}>
                  {truncateId(pattern.fingerprintHash, 16)}
                </span>
                <CopyToClipboardButton value={pattern.fingerprintHash} label="Copy fingerprint hash" />
              </div>
            </div>
          </div>
          <SpikeBadge isSpiking={isSpiking} assessed={pattern.hasSpikeAssessment} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t border-graphite">
          <div>
            <p className="text-xs text-pewter uppercase tracking-wider">Occurrences</p>
            <p className="font-mono text-lg text-whiteout mt-0.5">{pattern.count.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-pewter uppercase tracking-wider">First seen</p>
            <p className="font-mono text-sm text-neutral-300 mt-0.5" title={new Date(pattern.firstSeenAt).toISOString()}>
              {formatRelativeTime(pattern.firstSeenAt)}
            </p>
          </div>
          <div>
            <p className="text-xs text-pewter uppercase tracking-wider">Last seen</p>
            <p className="font-mono text-sm text-neutral-300 mt-0.5" title={new Date(pattern.lastSeenAt).toISOString()}>
              {formatRelativeTime(pattern.lastSeenAt)}
            </p>
          </div>
          <div>
            <p className="text-xs text-pewter uppercase tracking-wider">Affected versions</p>
            <p className="font-mono text-sm text-neutral-300 mt-0.5">
              {pattern.hasAffectedVersions ? pattern.affectedAgentVersionIds.length.toLocaleString() : 'not available'}
            </p>
          </div>
        </div>
      </div>

      {/* Trend + spike assessment summary */}
      <section aria-labelledby="pattern-trend-heading" className="rounded-[4px] border border-graphite-light bg-graphite-deep px-5 py-4">
        <h2 id="pattern-trend-heading" className="text-xs font-mono uppercase tracking-wider text-pewter mb-3">
          14-day trend
        </h2>
        {trend.length === 0 ? (
          <p className="text-sm text-neutral-500">No daily trend data available for this pattern yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <PatternTrendSparkline trend={trend} size="large" />
            <div className="flex justify-between text-xs font-mono text-pewter">
              <span>{formatDay(trend[0]?.day ?? '')}</span>
              <span>{formatDay(trend[trend.length - 1]?.day ?? '')}</span>
            </div>
          </div>
        )}

        {pattern.hasSpikeAssessment && spike ? (
          <p className="text-sm text-neutral-300 mt-3 pt-3 border-t border-graphite leading-relaxed">
            {isSpiking ? (
              <>
                <span className="text-neon-glow font-medium">Spiking</span> — {spike.recentCount.toLocaleString()} recent
                occurrences vs. a baseline mean of {spike.baselineMean.toFixed(1)} (z = {spike.z.toFixed(2)}).
              </>
            ) : (
              <>
                Not spiking — {spike.recentCount.toLocaleString()} recent occurrences vs. a baseline mean of{' '}
                {spike.baselineMean.toFixed(1)} (z = {spike.z.toFixed(2)}).
              </>
            )}{' '}
            Assessed {formatRelativeTime(spike.assessedAt)}.
          </p>
        ) : (
          <p className="text-xs text-pewter mt-3 pt-3 border-t border-graphite">
            No spike assessment has run for this pattern yet.
          </p>
        )}
      </section>

      {/* Representative runs */}
      <section aria-labelledby="pattern-runs-heading" className="rounded-[4px] border border-graphite-light bg-graphite-deep px-5 py-4">
        <h2 id="pattern-runs-heading" className="text-xs font-mono uppercase tracking-wider text-pewter mb-3">
          Representative runs
        </h2>
        {!pattern.hasRepresentativeRuns ? (
          <p className="text-sm text-neutral-500">Representative runs are not available for this pattern yet.</p>
        ) : pattern.representativeRunIds.length === 0 ? (
          <p className="text-sm text-neutral-500">No representative runs recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pattern.representativeRunIds.map((runId) => (
              <li key={runId}>
                <Link
                  href={`/runs/${runId}`}
                  className="inline-flex items-center gap-1.5 font-mono text-sm text-neutral-300 hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
                >
                  {truncateId(runId, 16)}
                  <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {recentOccurrences.length > 0 && (
          <div className="mt-4 pt-4 border-t border-graphite">
            <p className="text-xs text-pewter uppercase tracking-wider mb-2">Recent occurrences</p>
            <ul className="flex flex-col gap-1">
              {recentOccurrences.map((occ) => (
                <li key={occ.id || occ.runId} className="flex items-center gap-2 text-xs font-mono">
                  <Link
                    href={`/runs/${occ.runId}`}
                    className="text-neutral-400 hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
                  >
                    {truncateId(occ.runId, 12)}
                  </Link>
                  <span className="text-pewter">{formatRelativeTime(occ.occurredAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Affected agent versions */}
      <section aria-labelledby="pattern-versions-heading" className="rounded-[4px] border border-graphite-light bg-graphite-deep px-5 py-4">
        <h2 id="pattern-versions-heading" className="text-xs font-mono uppercase tracking-wider text-pewter mb-3">
          Affected agent versions
        </h2>
        {!pattern.hasAffectedVersions ? (
          <p className="text-sm text-neutral-500">Affected version data is not available for this pattern yet.</p>
        ) : pattern.affectedAgentVersionIds.length === 0 ? (
          <EmptyState
            title="No affected versions recorded"
            description="This pattern hasn't been linked to a specific agent version yet."
          />
        ) : (
          <ul className="flex flex-wrap gap-2">
            {pattern.affectedAgentVersionIds.map((versionId) => {
              const resolved = agentVersions[versionId]
              return (
                <li key={versionId}>
                  <Link
                    href={resolved ? `/agents/${resolved.agentId}` : '#'}
                    className="inline-flex items-center px-2 py-1 rounded-[4px] text-xs font-mono border bg-graphite text-cloud border-graphite-light hover:border-neon-muted hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow"
                    title={resolved ? `View agent for version ${resolved.version}` : truncateId(versionId, 16)}
                  >
                    {resolved ? resolved.version : truncateId(versionId, 12)}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
