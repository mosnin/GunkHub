import Link from 'next/link'

import type { RunExplanationSummaryState } from '@/lib/services/explanations'
import type { FailedVerification } from '@/lib/services/projection_verify'
import type { Run } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { DashboardStats } from '@/components/dashboard/DashboardStats'
import { TopFailurePatternsCard } from '@/components/dashboard/TopFailurePatternsCard'
import { PageHeader } from '@/components/layout/PageHeader'
import { adaptFailurePattern } from '@/components/patterns/adapt'
import { IntegrityBadge } from '@/components/runs/IntegrityBadge'
import { RunList } from '@/components/runs/RunList'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { ErrorState } from '@/components/ui/ErrorState'
import { InlineError } from '@/components/ui/InlineError'
import { Reveal, RevealGroup, RevealItem } from '@/components/ui/Motion'
import { getDashboardStats, getPerAgentDashboardStats, type DashboardRange } from '@/lib/services/dashboard'
import { getRunExplanationSummaries, withAnalyzingGracePeriod } from '@/lib/services/explanations'
import { listFailurePatterns } from '@/lib/services/failurePatterns'
import { getRecentFailedVerifications } from '@/lib/services/projection_verify'
import { listRuns } from '@/lib/services/runs'
import { isEmpty, isOk } from '@/lib/services/serviceResult'
import { truncateId, formatRelativeTime } from '@/lib/utils'

const TOP_PATTERNS_LIMIT = 10

export const metadata: Metadata = { title: 'Dashboard' }

// Bento stat tile: layered near-black surface, GeistMono value, optional accent.
function StatTile({
  label,
  value,
  accent = 'neutral',
  hint,
}: {
  label: string
  value: string
  accent?: 'neutral' | 'neon' | 'warn'
  hint?: string
}) {
  const dot =
    accent === 'neon' ? 'bg-neon-glow shadow-[var(--shadow-glow)]' // sanctioned accent glow — design.md "Glow"
    : accent === 'warn' ? 'bg-destructive-500 shadow-[var(--shadow-glow-warn)]' // sanctioned warn glow — design.md "Glow"
    : 'bg-graphite-light'
  const valueColor =
    accent === 'neon' ? 'text-neon-glow' : accent === 'warn' ? 'text-destructive-500' : 'text-whiteout'
  return (
    <RevealItem className="neon-surface relative overflow-hidden p-5">
      <div className="scanline opacity-60" aria-hidden="true" />
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
        <p className="font-mono text-xs uppercase tracking-wider text-pewter">{label}</p>
      </div>
      <p className={`mt-3 font-mono text-[40px] leading-none font-medium tabular-nums ${valueColor}`}>{value}</p>
      {hint && <p className="mt-2 text-xs text-pewter">{hint}</p>}
    </RevealItem>
  )
}

/** Construct a minimal VerificationStatus from a FailedVerification for badge rendering. */
function failedVerificationBadgeStatus(fv: FailedVerification) {
  return {
    verified: true,
    isValid: false,
    verifiedAt: fv.verifiedAt,
    summary: fv.failureReason ?? 'Verification failed',
    sequenceGaps: fv.sequenceGaps,
    duplicateSeqNums: fv.duplicateSeqNums,
    checksRan: fv.checksRan,
    replayPassed: null,
    failureSummaryPassed: null,
  }
}

const SDK_INSTALL = `npm install @agent-flight-recorder/sdk`

interface DashboardPageProps {
  searchParams: { range?: string }
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const range: DashboardRange = searchParams.range === '30d' ? '30d' : '7d'

  let runs: Run[] = []
  let error: string | null = null

  try {
    const result = await listRuns({ limit: 20 })
    runs = result.runs
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load runs'
  }

  const totalRuns = runs.length
  const failedRuns = runs.filter((r) => r.status === 'failed').length
  const activeRuns = runs.filter((r) => r.status === 'running').length
  const hasRuns = totalRuns > 0

  // "Why did this fail?" preview for the Recent Runs list — capped to the
  // FAILED/timed_out rows already on this (small, 20-row) page. Non-fatal:
  // getRunExplanationSummaries never throws, and the list renders identically
  // to before this feature when the map comes back empty.
  let explanationSummaries: Record<string, RunExplanationSummaryState> = {}
  const failedRunIds = runs
    .filter((r) => r.status === 'failed' || r.status === 'timed_out')
    .map((r) => r.id)
  if (failedRunIds.length > 0) {
    const raw = await getRunExplanationSummaries(failedRunIds)
    // Downgrade "analyzing" to "unavailable" (renders nothing, see
    // ExplanationPreview) for runs that ended long enough ago that
    // generation was evidently never scheduled/completed.
    explanationSummaries = withAnalyzingGracePeriod(raw, runs)
  }

  // Non-fatal, and now self-explaining: getRecentFailedVerifications catches
  // internally and returns an explained result, so the section can tell
  // "nothing failed verification" apart from "we could not find out". The old
  // try/catch left an empty array behind on failure, which rendered the
  // reassuring "No recent verification issues" over a thrown query.
  const failedVerifications = await getRecentFailedVerifications(5)

  // "Top recurring failures" widget (PREVENTION, cycle 2) — org-wide, not
  // scoped to the recent-runs window above, so it fetches independently and
  // never blocks the rest of the page. adaptFailurePattern is the same
  // reconciliation adapter the /patterns pages use (see
  // components/patterns/adapt.ts) — keeps this widget honest about which
  // fields the service actually returned (e.g. `hasSpikeAssessment`) instead
  // of defaulting a missing spike assessment to a false "not spiking".
  let topFailurePatterns: ReturnType<typeof adaptFailurePattern>[] | null = null
  let topFailurePatternsError: string | null = null
  try {
    const raw = await listFailurePatterns(TOP_PATTERNS_LIMIT)
    topFailurePatterns = raw.map(adaptFailurePattern)
  } catch (err) {
    topFailurePatternsError = err instanceof Error ? err.message : 'Failed to load failure patterns'
  }

  // Analytics — Team B's insights rollup. Independent of the recent-runs
  // fetch above (and its own error state), so a failure here never blanks
  // the rest of the page.
  const [dashboardStats, perAgentStats] = await Promise.all([
    getDashboardStats(range),
    getPerAgentDashboardStats(range),
  ])

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader title="Dashboard" />

      {/* Analytics — failure-rate trend, token volume, per-agent breakdown. */}
      <div className="mt-6">
        <DashboardStats stats={dashboardStats} perAgent={perAgentStats} range={range} />
      </div>

      {error ? (
        <div className="mt-6">
          <ErrorState title="Failed to load data" message={error} />
        </div>
      ) : (
        <>
          {/* Bento stats row */}
          <RevealGroup className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatTile label="Recent Runs" value={String(totalRuns)} hint="in the last window" />
            <StatTile label="Failed" value={String(failedRuns)} accent={failedRuns > 0 ? 'warn' : 'neutral'} hint="need attention" />
            <StatTile label="Active" value={String(activeRuns)} accent={activeRuns > 0 ? 'neon' : 'neutral'} hint="running now" />
          </RevealGroup>

          {/* Top recurring failures — org-wide, shown regardless of whether
              this window has recent runs (a pattern can still be actively
              spiking even if nothing ran in the last 7/30 days). */}
          <div className="mt-6">
            <TopFailurePatternsCard patterns={topFailurePatterns} error={topFailurePatternsError} />
          </div>

          {hasRuns ? (
            <>
              {/* Verification issues section — shown only when there are runs */}
              <div className="mt-8">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-neutral-300">Verification Issues</h2>
                  <Link
                    href="/runs?verify=failed"
                    className="text-xs text-pewter hover:text-cloud transition-colors duration-100 font-mono"
                    title="View all failed — use the Runs page to bulk re-verify"
                  >
                    view all failed →
                  </Link>
                </div>

                {/* The calm "No recent verification issues" line is now
                    reachable ONLY from status 'empty' — i.e. the query ran and
                    genuinely found none. On 'error' we say so instead. This is
                    the exact string serviceResult.ts cites as the motivating
                    bug. okList() maps an empty list to 'empty', so an 'ok'
                    result always has at least one row. */}
                {!isOk(failedVerifications) ? (
                  isEmpty(failedVerifications) ? (
                    <div className="flex items-center gap-2 px-3 py-2.5 rounded-[4px] border border-graphite text-xs text-ash font-mono">
                      <span className="w-1.5 h-1.5 rounded-full bg-neon-muted shrink-0" aria-hidden="true" />
                      No recent verification issues
                    </div>
                  ) : (
                    <InlineError message={failedVerifications.message} />
                  )
                ) : (
                  <div className="rounded-md border border-neutral-800 divide-y divide-neutral-800">
                    {failedVerifications.items.map((fv) => (
                      <Link
                        key={fv.runId}
                        href={`/runs/${fv.runId}`}
                        className="flex items-center gap-3 px-3 py-2.5 hover:bg-neutral-900 transition-colors duration-100"
                      >
                        <span className="font-mono text-xs text-neutral-400 shrink-0">
                          {truncateId(fv.runId, 12)}
                        </span>
                        <IntegrityBadge status={failedVerificationBadgeStatus(fv)} />
                        {fv.failureReason && (
                          <span className="text-xs text-pewter truncate flex-1">
                            {fv.failureReason}
                          </span>
                        )}
                        <span className="text-xs text-pewter shrink-0 ml-auto">
                          {formatRelativeTime(fv.verifiedAt)}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent Runs list */}
              <Reveal className="mt-8">
                <h2 className="text-sm font-semibold text-neutral-300 mb-4">Recent Runs</h2>
                <RunList runs={runs} explanationSummaries={explanationSummaries} />
              </Reveal>
            </>
          ) : (
            /* Getting Started guide — only show when there are no runs yet */
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-neutral-300 mb-4">Getting Started</h2>
              <Card>
                <div className="px-5 py-4 border-b border-neutral-800">
                  <p className="text-sm font-medium text-neutral-200">Record your first run in 4 steps</p>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    No run recorded yet. Follow the steps below.
                  </p>
                </div>
                <div className="px-5 py-5 flex flex-col gap-5">
                  {/* Step 1 */}
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-mono font-bold text-neutral-400">1</span>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-neutral-300">Create a project</p>
                      <p className="mt-0.5 text-xs text-neutral-400">
                        Projects group your agents and their runs.
                      </p>
                      <Link
                        href="/projects"
                        className="mt-1.5 inline-flex text-xs text-primary-400 hover:text-primary-300 underline underline-offset-2 transition-colors duration-100"
                      >
                        Go to Projects →
                      </Link>
                    </div>
                  </div>

                  {/* Step 2 */}
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-mono font-bold text-neutral-400">2</span>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-neutral-300">Create an agent</p>
                      <p className="mt-0.5 text-xs text-neutral-400">
                        Within your project, create an agent to represent the code you&#39;re instrumenting.
                      </p>
                    </div>
                  </div>

                  {/* Step 3 */}
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-mono font-bold text-neutral-400">3</span>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-neutral-300">Generate an API key</p>
                      <p className="mt-0.5 text-xs text-neutral-400">
                        The SDK uses this key to authenticate when recording runs.
                      </p>
                      <Link
                        href="/settings"
                        className="mt-1.5 inline-flex text-xs text-primary-400 hover:text-primary-300 underline underline-offset-2 transition-colors duration-100"
                      >
                        Go to Settings →
                      </Link>
                    </div>
                  </div>

                  {/* Step 4 */}
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-mono font-bold text-neutral-400">4</span>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-neutral-300">Install the SDK and record a run</p>
                      <p className="mt-0.5 text-xs text-neutral-400">
                        Install the SDK, add your agent ID from the project page, and record your first run.
                      </p>
                      <div className="mt-2">
                        <CodeBlock content={SDK_INSTALL} language="bash" maxHeight="60px" />
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  )
}
