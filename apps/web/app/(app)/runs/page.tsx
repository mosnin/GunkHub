import Link from 'next/link'

import type { RunExplanationSummaryState } from '@/lib/services/explanations'
import type { Agent } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { EnvironmentFilterInput } from '@/components/runs/EnvironmentFilterInput'
import { RunSearchBar } from '@/components/runs/RunSearchBar'
import { SelectableRunList } from '@/components/runs/SelectableRunList'
import { ErrorState } from '@/components/ui/ErrorState'
import { listAgentsByOrg } from '@/lib/services/agents'
import {
  batchGetRunVerificationStatuses,
  type VerificationStatus,
} from '@/lib/services/projection_verify'
import { listRuns } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Runs' }

/** Valid verification filter values. */
const VERIFY_VALUES = ['all', 'verified', 'partial', 'failed', 'unverified'] as const
type VerifyFilter = (typeof VERIFY_VALUES)[number]

/** Well-known environment presets (ADR-002 allows any custom string up to 32
    chars too — a run whose environment isn't one of these still displays its
    chip everywhere, it's just not one of the quick-filter pills below). */
const ENV_VALUES = ['all', 'production', 'staging', 'development', 'preview'] as const
type EnvFilter = (typeof ENV_VALUES)[number]

const TRIAGE_VALUES = ['all', 'open', 'investigating', 'resolved'] as const
type TriageFilter = (typeof TRIAGE_VALUES)[number]

interface RunsPageProps {
  searchParams: {
    status?: string
    range?: string   // '24h' | '7d' | '30d'
    projectId?: string
    agentId?: string
    cursor?: string
    verify?: string  // VerifyFilter
    environment?: string
    triage?: string  // TriageFilter
  }
}

function rangeToStartedAfter(range: string | undefined): number | undefined {
  if (!range) return undefined
  const now = Date.now()
  if (range === '24h') return now - 24 * 60 * 60 * 1000
  if (range === '7d')  return now - 7  * 24 * 60 * 60 * 1000
  if (range === '30d') return now - 30 * 24 * 60 * 60 * 1000
  return undefined
}

/**
 * Map the UI's finer-grained verify filter to the server-side
 * `listRunsByVerification` filter (convex/runs.ts). "verified" and "partial"
 * both mean "latest verification passed" at the server (`passed`) — the split
 * between full-derivation-passed vs sequence-only-passed is a client-side
 * refinement of that already-correct, org-wide-scoped page (see
 * `matchesFineGrainedVerify` below), not a stand-in for real filtering.
 */
function toServerVerifyFilter(verify: VerifyFilter): 'failed' | 'passed' | 'unverified' | undefined {
  if (verify === 'all') return undefined
  if (verify === 'failed') return 'failed'
  if (verify === 'unverified') return 'unverified'
  return 'passed' // 'verified' | 'partial'
}

/**
 * Refines the server-filtered "passed" page into "verified" (full derivation
 * check passed) vs "partial" (sequence-only check passed). "failed",
 * "unverified", and "all" are already exactly right from the server, so this
 * is a no-op for them.
 */
function matchesFineGrainedVerify(
  status: VerificationStatus | undefined,
  verify: VerifyFilter,
): boolean {
  if (verify !== 'verified' && verify !== 'partial') return true
  if (!status || !status.verified || status.isValid !== true) return false
  return verify === 'verified' ? status.checksRan.includes('replay') : !status.checksRan.includes('replay')
}

/** Build href for a filter pill, preserving all other active searchParams. */
function buildHref(
  base: Record<string, string | undefined>,
  override: Record<string, string | undefined>,
): string {
  const merged = { ...base, ...override }
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(merged)) {
    if (v && v !== 'all') params.set(k, v)
  }
  const qs = params.toString()
  return `/runs${qs ? `?${qs}` : ''}`
}

export default async function RunsPage({ searchParams }: RunsPageProps) {
  let runs: Awaited<ReturnType<typeof listRuns>> | null = null
  let agents: Agent[] = []
  let error: string | null = null
  const agentVersionLabels: Record<string, string> = {}

  const verifyFilter: VerifyFilter =
    VERIFY_VALUES.includes(searchParams.verify as VerifyFilter)
      ? (searchParams.verify as VerifyFilter)
      : 'all'

  const envFilter: EnvFilter = ENV_VALUES.includes(searchParams.environment as EnvFilter)
    ? (searchParams.environment as EnvFilter)
    : 'all' // unset, or a custom (non-preset) value — see customEnvironment below
  const customEnvironment =
    searchParams.environment && !ENV_VALUES.includes(searchParams.environment as EnvFilter)
      ? searchParams.environment
      : undefined

  const triageFilter: TriageFilter =
    TRIAGE_VALUES.includes(searchParams.triage as TriageFilter)
      ? (searchParams.triage as TriageFilter)
      : 'all'

  // Base searchParams dict for href builders. Excludes cursor (reset on filter
  // change) but preserves projectId so clicking a status/range/verify/agent pill
  // while scoped to a project does not silently drop the project filter.
  const baseParams = {
    status: searchParams.status,
    range: searchParams.range,
    agentId: searchParams.agentId,
    projectId: searchParams.projectId,
    verify: verifyFilter === 'all' ? undefined : verifyFilter,
    environment: envFilter === 'all' ? customEnvironment : envFilter,
    triage: triageFilter === 'all' ? undefined : triageFilter,
  }

  const serverVerifyFilter = toServerVerifyFilter(verifyFilter)
  const effectiveEnvironment = envFilter === 'all' ? customEnvironment : envFilter

  try {
    runs = await listRuns({
      status: searchParams.status as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | undefined,
      startedAfter: rangeToStartedAfter(searchParams.range),
      projectId: searchParams.projectId,
      agentId: searchParams.agentId,
      cursor: searchParams.cursor,
      verifyFilter: serverVerifyFilter,
      environment: effectiveEnvironment,
      limit: 50,
    })
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load runs'
  }

  // Triage has no server-side filter (ADR-002 has no by_org_triage index) —
  // narrow the already-fetched page client-side, same overfetch-then-filter
  // tradeoff the fine-grained verify split already accepts above. Only
  // failed/timed_out runs are triage-eligible; an untriaged eligible run
  // defaults to "open" (matching setRunTriage's own default), a non-eligible
  // run has no triage state and is excluded from every triage filter value.
  if (runs?.runs && triageFilter !== 'all') {
    const TRIAGE_ELIGIBLE = new Set(['failed', 'timed_out'])
    runs = {
      ...runs,
      runs: runs.runs.filter(
        (r) => TRIAGE_ELIGIBLE.has(r.status) && (r.triageState ?? 'open') === triageFilter,
      ),
    }
  }

  // Build version label lookup map for runs that have agentVersionId
  if (runs?.runs) {
    const { getAgentVersion } = await import('@/lib/services/agent_versions')
    const versionIds = [...new Set(
      runs.runs
        .filter((r) => r.agentVersionId != null)
        .map((r) => r.agentVersionId as string)
    )]
    await Promise.all(
      versionIds.map(async (vId) => {
        try {
          const v = await getAgentVersion(vId)
          if (v) agentVersionLabels[vId] = v.version
        } catch {
          // Non-fatal: omit version label for this run
        }
      })
    )
  }

  try {
    agents = await listAgentsByOrg()
  } catch {
    // Non-fatal: agent dropdown is hidden if fetch fails
  }

  // Batch-fetch verification statuses for this page of runs (non-fatal)
  let verificationStatuses: Record<string, VerificationStatus> = {}
  if (runs?.runs && runs.runs.length > 0) {
    verificationStatuses = await batchGetRunVerificationStatuses(
      runs.runs.map((r) => r.id),
    )
  }

  // "Why did this fail?" list preview — capped to the visible FAILED/timed_out
  // rows on this page only (never the whole list) to bound the per-run fetch
  // fan-out. See services/explanations.ts for the batch-query gap this papers
  // over. Non-fatal by construction — getRunExplanationSummaries never throws.
  let explanationSummaries: Record<string, RunExplanationSummaryState> = {}
  if (runs?.runs && runs.runs.length > 0) {
    const failedRunIds = runs.runs
      .filter((r) => r.status === 'failed' || r.status === 'timed_out')
      .map((r) => r.id)
    if (failedRunIds.length > 0) {
      const { getRunExplanationSummaries, withAnalyzingGracePeriod } = await import('@/lib/services/explanations')
      const raw = await getRunExplanationSummaries(failedRunIds)
      // Downgrade "analyzing" to "unavailable" (renders nothing, see
      // ExplanationPreview) for runs that ended long enough ago that
      // generation was evidently never scheduled/completed — an indefinite
      // pulse on those rows would be dishonest, not just imprecise.
      explanationSummaries = withAnalyzingGracePeriod(raw, runs.runs)
    }
  }

  // "failed"/"passed"/"unverified" are already exactly right from
  // listRunsByVerification; this only refines "passed" into "verified" vs
  // "partial" within the already server-filtered page (see
  // matchesFineGrainedVerify above).
  const filteredRuns = runs?.runs
    ? runs.runs.filter((run) =>
        matchesFineGrainedVerify(verificationStatuses[run.id], verifyFilter),
      )
    : undefined

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Runs"
        subtitle="All agent runs across your organization."
      />

      {/* Search — debounced, navigates to the dedicated /search results page.
          Press / anywhere on this page to focus it. */}
      <div className="mt-4">
        <RunSearchBar />
      </div>

      {/* Filter bar — URL-based, no JS required */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Status filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-pewter font-medium uppercase tracking-wider">Status</span>
          <div className="flex gap-1">
            {(['all', 'running', 'completed', 'failed', 'cancelled', 'timed_out'] as const).map((s) => {
              const active = s === 'all' ? !searchParams.status : searchParams.status === s
              const href = buildHref(baseParams, { status: s === 'all' ? undefined : s })
              return (
                <Link
                  key={s}
                  href={href}
                  className={[
                    'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
                    active
                      ? 'bg-primary-900 text-primary-300 border-primary-700'
                      : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                  ].join(' ')}
                >
                  {s}
                </Link>
              )
            })}
          </div>
        </div>

        {/* Date range filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-pewter font-medium uppercase tracking-wider">Range</span>
          <div className="flex gap-1">
            {(['all', '24h', '7d', '30d'] as const).map((r) => {
              const active = r === 'all' ? !searchParams.range : searchParams.range === r
              const href = buildHref(baseParams, { range: r === 'all' ? undefined : r })
              return (
                <Link
                  key={r}
                  href={href}
                  className={[
                    'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
                    active
                      ? 'bg-primary-900 text-primary-300 border-primary-700'
                      : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                  ].join(' ')}
                >
                  {r}
                </Link>
              )
            })}
          </div>
        </div>

        {/* Verification filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-pewter font-medium uppercase tracking-wider">Integrity</span>
          <div className="flex gap-1">
            {VERIFY_VALUES.map((v) => {
              const active = verifyFilter === v
              const href = buildHref(baseParams, { verify: v === 'all' ? undefined : v })
              return (
                <Link
                  key={v}
                  href={href}
                  className={[
                    'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
                    active
                      ? 'bg-primary-900 text-primary-300 border-primary-700'
                      : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                  ].join(' ')}
                >
                  {v}
                </Link>
              )
            })}
          </div>
        </div>

        {/* Agent filter — shown only when there are agents with runs */}
        {agents.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-pewter font-medium uppercase tracking-wider">Agent</span>
            <div className="flex gap-1 flex-wrap">
              {/* "All agents" option */}
              <Link
                href={buildHref(baseParams, { agentId: undefined })}
                className={[
                  'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
                  !searchParams.agentId
                    ? 'bg-primary-900 text-primary-300 border-primary-700'
                    : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                ].join(' ')}
              >
                all
              </Link>
              {agents.map((agent) => {
                const active = searchParams.agentId === agent.id
                return (
                  <Link
                    key={agent.id}
                    href={buildHref(baseParams, { agentId: agent.id })}
                    title={agent.name}
                    className={[
                      'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100 max-w-[160px] truncate',
                      active
                        ? 'bg-primary-900 text-primary-300 border-primary-700'
                        : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                    ].join(' ')}
                  >
                    {agent.slug ?? agent.name}
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Environment filter — ADR-002. Custom (non-preset) environment
            values still work via the URL but don't get a quick pill. */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-pewter font-medium uppercase tracking-wider">Env</span>
          <div className="flex gap-1">
            {ENV_VALUES.map((e) => {
              const active = e === 'all' ? envFilter === 'all' && !customEnvironment : envFilter === e
              const href = buildHref(baseParams, { environment: e === 'all' ? undefined : e })
              return (
                <Link
                  key={e}
                  href={href}
                  className={[
                    'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
                    active
                      ? 'bg-primary-900 text-primary-300 border-primary-700'
                      : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                  ].join(' ')}
                >
                  {e}
                </Link>
              )
            })}
            <EnvironmentFilterInput customEnvironment={customEnvironment} />
          </div>
        </div>

        {/* Triage filter — ADR-002, applies only to failed/timed_out runs. */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-pewter font-medium uppercase tracking-wider">Triage</span>
          <div className="flex gap-1">
            {TRIAGE_VALUES.map((t) => {
              const active = triageFilter === t
              const href = buildHref(baseParams, { triage: t === 'all' ? undefined : t })
              return (
                <Link
                  key={t}
                  href={href}
                  className={[
                    'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
                    active
                      ? 'bg-primary-900 text-primary-300 border-primary-700'
                      : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                  ].join(' ')}
                >
                  {t}
                </Link>
              )
            })}
          </div>
        </div>
      </div>

      {triageFilter !== 'all' && (
        <p className="mt-2 text-xs text-pewter">
          Triage has no server-side index yet — this filter is applied within this page of
          results, not across your whole history. Some matching runs on later pages won&#39;t
          appear until you page through them.
        </p>
      )}

      <div className="mt-4">
        {error ? (
          <ErrorState
            title="Failed to load runs"
            message={error}
          />
        ) : (
          <SelectableRunList
            runs={filteredRuns}
            agentVersionLabels={agentVersionLabels}
            verificationStatuses={verificationStatuses}
            explanationSummaries={explanationSummaries}
          />
        )}
      </div>

      {/* Pagination — cursor-based. Preserves all active filters (incl. projectId).
          Without this, runs beyond the first page of 50 were unreachable. */}
      {!error && (searchParams.cursor ?? runs?.nextCursor) && (
        <div className="mt-4 flex items-center justify-between border-t border-neutral-800 pt-3">
          <div>
            {searchParams.cursor && (
              <Link
                href={buildHref(
                  { ...baseParams, projectId: searchParams.projectId },
                  { cursor: undefined },
                )}
                className="px-2 py-1 rounded text-xs font-mono font-medium border bg-transparent text-neutral-400 border-neutral-800 hover:text-neutral-200 hover:border-neutral-700 transition-colors duration-100"
              >
                ← First page
              </Link>
            )}
          </div>
          <div>
            {runs?.nextCursor && (
              <Link
                href={buildHref(
                  { ...baseParams, projectId: searchParams.projectId },
                  { cursor: runs.nextCursor },
                )}
                className="px-2 py-1 rounded text-xs font-mono font-medium border bg-transparent text-neutral-400 border-neutral-800 hover:text-neutral-200 hover:border-neutral-700 transition-colors duration-100"
              >
                Older runs →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
