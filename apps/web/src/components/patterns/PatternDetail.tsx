import Link from 'next/link'

import type { AdaptedFailurePattern } from '@/components/patterns/adapt'
import type { ResolutionEvidenceState } from '@/components/patterns/ResolutionEvidencePanel'
import type { RunExplanationSummaryState } from '@/lib/services/explanations'
import type { FailurePatternOccurrence, FailurePatternTrendPoint } from '@agent-flight-recorder/contracts'

import { isRegressedPattern, recurrencesSinceResolution } from '@/components/patterns/adapt'
import { MutedBadge } from '@/components/patterns/MutedBadge'
import { PatternLifecycleControl } from '@/components/patterns/PatternLifecycleControl'
import { PatternMuteControl } from '@/components/patterns/PatternMuteControl'
import { PatternTrendSparkline } from '@/components/patterns/PatternTrendSparkline'
import { ResolutionEvidencePanel } from '@/components/patterns/ResolutionEvidencePanel'
import { SpikeBadge } from '@/components/patterns/SpikeBadge'
import { ExplanationPreview } from '@/components/runs/ExplanationPreview'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatRelativeTime, parseSafeHttpUrl, truncateId } from '@/lib/utils'

/** Resolved label + owning agent for one affected agent version, keyed by agentVersionId. Resolved server-side by the detail page (mirrors how the run-detail page resolves `agentVersionLabel` via `getAgentVersion`). */
export interface ResolvedAgentVersion {
  agentId: string
  version: string
}

/** "Why did this fail?" preview for this pattern's most-recent representative run — resolved server-side by the detail page (one `getRunExplanationSummaries([runId])` call, same helper the dashboard uses). `null` when the pattern has no representative runs at all (nothing to preview, so the section is omitted rather than showing a placeholder for a run that doesn't exist). */
export interface TopRunExplanationPreview {
  runId: string
  state: RunExplanationSummaryState
}

interface PatternDetailProps {
  pattern: AdaptedFailurePattern
  recentOccurrences: FailurePatternOccurrence[]
  trend: FailurePatternTrendPoint[]
  agentVersions: Record<string, ResolvedAgentVersion | undefined>
  topRunExplanation?: TopRunExplanationPreview | null
  /** Resolved server-side by the detail page from `getCurrentAuth().orgRole === 'admin'` — gates the mute/unmute control (cycle 3). See PatternMuteControl. */
  isAdmin: boolean
  /**
   * "Did the fix hold?" evidence (cycle 2). Always supplied by the page —
   * including its `unavailable`/`error` variants — so this section is never
   * silently omitted for a resolved pattern. Omitted entirely only for a
   * pattern with no lifecycle history at all, where there is nothing to
   * evidence and the section would be pure noise.
   */
  evidenceState?: ResolutionEvidenceState
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
export function PatternDetail({
  pattern,
  recentOccurrences,
  trend,
  agentVersions,
  topRunExplanation,
  isAdmin,
  evidenceState,
}: PatternDetailProps) {
  const spike = pattern.lastSpikeAssessment
  const isSpiking = spike?.isSpiking === true
  const regressed = isRegressedPattern(pattern)
  const resolutionRefUrl = pattern.resolutionRef ? parseSafeHttpUrl(pattern.resolutionRef) : null
  // EXACT, from the rollup's own baseline — `count - resolvedAtOccurrenceCount`.
  // Null when no baseline was captured, which renders as no claim at all
  // rather than a zero that would read as "it held".
  const recurrences = recurrencesSinceResolution(pattern)
  const hasLifecycleHistory =
    pattern.status !== 'open' || pattern.acknowledgedAt !== undefined || pattern.resolvedAt !== undefined

  return (
    <div className="flex flex-col gap-6">
      {/* Regression banner — the emotional core of this feature: a resolved
          pattern that failed again must be unmistakable, not just a badge
          buried in the header. Palette-only urgency (Neon Glow), no
          off-palette red. */}
      {regressed && (
        <div
          role="alert"
          className="rounded-[4px] border border-neon-glow bg-primary-900/30 px-5 py-3 flex items-start gap-3"
        >
          <span
            className="w-2 h-2 mt-1.5 rounded-full bg-neon-glow shadow-[var(--shadow-glow)] motion-safe:animate-neon-pulse shrink-0 forced-colors:bg-[Highlight]"
            aria-hidden="true"
          />
          <p className="text-sm text-whiteout leading-relaxed">
            <span className="font-semibold text-neon-glow">Your fix didn&apos;t hold</span> — this pattern was resolved
            {typeof pattern.resolvedAt === 'number' && <> on {new Date(pattern.resolvedAt).toLocaleDateString()}</>}
            {pattern.resolvedInVersionId && agentVersions[pattern.resolvedInVersionId] && (
              <> in <span className="font-mono">{agentVersions[pattern.resolvedInVersionId]?.version}</span></>
            )}
            , but it failed again{typeof pattern.regressedAt === 'number' && <> {formatRelativeTime(pattern.regressedAt)}</>}
            {recurrences !== null && recurrences > 0 && (
              <>
                {' '}
                — <span className="font-mono">{recurrences.toLocaleString()}</span>{' '}
                {recurrences === 1 ? 'recurrence' : 'recurrences'} since it was marked resolved
              </>
            )}
            .
          </p>
        </div>
      )}

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
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <SpikeBadge isSpiking={isSpiking} assessed={pattern.hasSpikeAssessment} mutedAlerts={pattern.muted} />
              {pattern.muted && !isSpiking && <MutedBadge mutedAt={pattern.mutedAt} />}
            </div>
            <PatternMuteControl
              fingerprintHash={pattern.fingerprintHash}
              muted={pattern.muted}
              mutedAt={pattern.mutedAt}
              isAdmin={isAdmin}
            />
            <div className="pt-1.5 border-t border-graphite w-full flex justify-end">
              <PatternLifecycleControl
                fingerprintHash={pattern.fingerprintHash}
                status={pattern.status}
                regressed={regressed}
                resolutionNote={pattern.resolutionNote}
                resolutionRef={pattern.resolutionRef}
              />
            </div>
          </div>
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

      {/* "Did the fix hold?" — the evidence behind the resolution claim, plus
          the lifecycle timeline. Rendered for any pattern with lifecycle
          history, INCLUDING its unavailable/error variants: a resolved
          pattern that silently omits this section is indistinguishable from
          one whose fix was proven, which is precisely the confusion cycle 2
          exists to remove. */}
      {hasLifecycleHistory && evidenceState && (
        <ResolutionEvidencePanel pattern={pattern} state={evidenceState} />
      )}

      {/* Resolution details — who acknowledged/resolved this pattern, when,
          and the free-text note/reference left behind (docs/adr/006-failure-
          resolution.md). Rendered whenever there's any lifecycle history to
          show; omitted entirely for a plain never-touched "open" pattern so
          it doesn't add noise to the common case. */}
      {(pattern.acknowledgedAt !== undefined || pattern.resolvedAt !== undefined) && (
        <section
          aria-labelledby="pattern-resolution-heading"
          className="rounded-[4px] border border-graphite-light bg-graphite-deep px-5 py-4"
        >
          <h2 id="pattern-resolution-heading" className="text-xs font-mono uppercase tracking-wider text-pewter mb-3">
            Resolution
          </h2>
          <div className="flex flex-col gap-3">
            {pattern.acknowledgedAt !== undefined && (
              <div>
                <p className="text-xs text-pewter uppercase tracking-wider">Acknowledged</p>
                <p className="text-sm text-neutral-300 mt-0.5">
                  {formatRelativeTime(pattern.acknowledgedAt)}
                  {pattern.acknowledgedByUserId && (
                    <>
                      {' '}
                      by <span className="font-mono text-xs text-cloud">{truncateId(pattern.acknowledgedByUserId, 12)}</span>
                    </>
                  )}
                </p>
              </div>
            )}
            {pattern.resolvedAt !== undefined && (
              <div>
                <p className="text-xs text-pewter uppercase tracking-wider">Resolved</p>
                <p className="text-sm text-neutral-300 mt-0.5">
                  {formatRelativeTime(pattern.resolvedAt)}
                  {pattern.resolvedByUserId && (
                    <>
                      {' '}
                      by <span className="font-mono text-xs text-cloud">{truncateId(pattern.resolvedByUserId, 12)}</span>
                    </>
                  )}
                </p>
              </div>
            )}
            {pattern.resolvedInVersionId && (
              <div>
                <p className="text-xs text-pewter uppercase tracking-wider">Fixed in version</p>
                {/* Validated at resolve time to belong to this org and to an
                    agent this pattern was observed on — so unlike
                    `resolutionRef` below, this is a trustworthy id, not free
                    text. It still only becomes a LINK once resolved to a real
                    agent. */}
                {agentVersions[pattern.resolvedInVersionId] ? (
                  <Link
                    href={`/agents/${agentVersions[pattern.resolvedInVersionId]?.agentId}`}
                    className="font-mono text-sm text-neon-glow hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
                  >
                    {agentVersions[pattern.resolvedInVersionId]?.version}
                  </Link>
                ) : (
                  <p className="font-mono text-sm text-neutral-300 mt-0.5">
                    {truncateId(pattern.resolvedInVersionId, 16)}
                  </p>
                )}
              </div>
            )}
            {pattern.resolutionNote && (
              <div>
                <p className="text-xs text-pewter uppercase tracking-wider">Note</p>
                <p className="text-sm text-neutral-300 mt-0.5 leading-relaxed whitespace-pre-wrap">
                  {pattern.resolutionNote}
                </p>
              </div>
            )}
            {pattern.resolutionRef && (
              <div>
                <p className="text-xs text-pewter uppercase tracking-wider">Reference</p>
                {/* Only rendered as a link when it parses as an http(s) URL —
                    see parseSafeHttpUrl. Anything else (a bare version id,
                    prose) stays plain text; never dangerouslySetInnerHTML. */}
                {resolutionRefUrl ? (
                  <a
                    href={resolutionRefUrl.toString()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-sm text-neon-glow hover:underline break-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
                  >
                    {pattern.resolutionRef}
                    <span aria-hidden="true">↗</span>
                  </a>
                ) : (
                  <p className="font-mono text-sm text-neutral-300 break-all mt-0.5">{pattern.resolutionRef}</p>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Why did this fail? — connects the pattern to a concrete root-cause
          explanation for its most-recent representative run (Explainability
          Layer reuse). Omitted entirely when there's no representative run
          to preview at all; a run WITH no explanation yet still renders this
          section, with an honest placeholder instead of a fabricated one. */}
      {topRunExplanation && (
        <section
          aria-labelledby="pattern-explanation-heading"
          className="rounded-[4px] border border-graphite-light bg-graphite-deep px-5 py-4"
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 id="pattern-explanation-heading" className="text-xs font-mono uppercase tracking-wider text-pewter">
              Why did this fail?
            </h2>
            <Link
              href={`/runs/${topRunExplanation.runId}`}
              className="inline-flex items-center gap-1 text-xs font-mono text-pewter hover:text-cloud transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
            >
              view run <span aria-hidden="true">→</span>
            </Link>
          </div>
          {topRunExplanation.state.status === 'unavailable' ? (
            <p className="text-sm text-neutral-500">
              No failure analysis is available yet for this pattern&apos;s most recent representative run.
            </p>
          ) : (
            <ExplanationPreview state={topRunExplanation.state} />
          )}
        </section>
      )}

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
