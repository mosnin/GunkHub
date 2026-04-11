import type { Agent, Run } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { RunList } from '@/components/runs/RunList'
import { ErrorState } from '@/components/ui/ErrorState'
import { listDistinctAgents } from '@/lib/services/agents'
import {
  batchGetRunVerificationStatuses,
  type VerificationStatus,
} from '@/lib/services/projection_verify'
import { listRuns } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Runs' }

/** Valid verification filter values. */
const VERIFY_VALUES = ['all', 'verified', 'seq_verified', 'failed', 'unverified'] as const
type VerifyFilter = (typeof VERIFY_VALUES)[number]

interface RunsPageProps {
  searchParams: {
    status?: string
    range?: string   // '24h' | '7d' | '30d'
    projectId?: string
    agentId?: string
    cursor?: string
    verify?: string  // VerifyFilter
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

/** Returns true if the run matches the verification filter. */
function matchesVerifyFilter(
  run: Run,
  status: VerificationStatus | undefined,
  verify: VerifyFilter,
): boolean {
  if (verify === 'all') return true
  if (!status || !status.verified) return verify === 'unverified'
  if (verify === 'unverified') return false
  if (verify === 'failed') return !status.isValid
  if (verify === 'verified') return status.isValid === true && status.checksRan.includes('replay')
  if (verify === 'seq_verified') return status.isValid === true && !status.checksRan.includes('replay')
  return true
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

  // Base searchParams dict for href builders (excludes cursor to reset on filter change)
  const baseParams = {
    status: searchParams.status,
    range: searchParams.range,
    agentId: searchParams.agentId,
    verify: verifyFilter === 'all' ? undefined : verifyFilter,
  }

  try {
    runs = await listRuns({
      status: searchParams.status as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | undefined,
      startedAfter: rangeToStartedAfter(searchParams.range),
      projectId: searchParams.projectId,
      agentId: searchParams.agentId,
      cursor: searchParams.cursor,
      limit: 50,
    })
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load runs'
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
    agents = await listDistinctAgents()
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

  // Apply verification filter post-fetch
  const filteredRuns = runs?.runs
    ? runs.runs.filter((run) =>
        matchesVerifyFilter(run, verificationStatuses[run.id], verifyFilter),
      )
    : undefined

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Runs"
        subtitle="All agent runs across your organization."
      />

      {/* Filter bar — URL-based, no JS required */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Status filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-neutral-600 font-medium uppercase tracking-wider">Status</span>
          <div className="flex gap-1">
            {(['all', 'running', 'completed', 'failed', 'cancelled', 'timed_out'] as const).map((s) => {
              const active = s === 'all' ? !searchParams.status : searchParams.status === s
              const href = buildHref(baseParams, { status: s === 'all' ? undefined : s })
              return (
                <a
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
                </a>
              )
            })}
          </div>
        </div>

        {/* Date range filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-neutral-600 font-medium uppercase tracking-wider">Range</span>
          <div className="flex gap-1">
            {(['all', '24h', '7d', '30d'] as const).map((r) => {
              const active = r === 'all' ? !searchParams.range : searchParams.range === r
              const href = buildHref(baseParams, { range: r === 'all' ? undefined : r })
              return (
                <a
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
                </a>
              )
            })}
          </div>
        </div>

        {/* Verification filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-neutral-600 font-medium uppercase tracking-wider">Integrity</span>
          <div className="flex gap-1">
            {VERIFY_VALUES.map((v) => {
              const active = verifyFilter === v
              const href = buildHref(baseParams, { verify: v === 'all' ? undefined : v })
              const label = v === 'seq_verified' ? 'seq' : v
              return (
                <a
                  key={v}
                  href={href}
                  className={[
                    'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
                    active
                      ? 'bg-primary-900 text-primary-300 border-primary-700'
                      : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                  ].join(' ')}
                >
                  {label}
                </a>
              )
            })}
          </div>
        </div>

        {/* Agent filter — shown only when there are agents with runs */}
        {agents.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-neutral-600 font-medium uppercase tracking-wider">Agent</span>
            <div className="flex gap-1 flex-wrap">
              {/* "All agents" option */}
              <a
                href={buildHref(baseParams, { agentId: undefined })}
                className={[
                  'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
                  !searchParams.agentId
                    ? 'bg-primary-900 text-primary-300 border-primary-700'
                    : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                ].join(' ')}
              >
                all
              </a>
              {agents.map((agent) => {
                const active = searchParams.agentId === agent.id
                return (
                  <a
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
                  </a>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4">
        {error ? (
          <ErrorState
            title="Failed to load runs"
            message={error}
          />
        ) : (
          <RunList
            runs={filteredRuns}
            agentVersionLabels={agentVersionLabels}
            verificationStatuses={verificationStatuses}
          />
        )}
      </div>
    </div>
  )
}
