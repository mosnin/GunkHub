import type { Agent } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { RunList } from '@/components/runs/RunList'
import { ErrorState } from '@/components/ui/ErrorState'
import { listDistinctAgents } from '@/lib/services/agents'
import { listRuns } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Runs' }

interface RunsPageProps {
  searchParams: {
    status?: string
    range?: string   // '24h' | '7d' | '30d'
    projectId?: string
    agentId?: string
    cursor?: string
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

export default async function RunsPage({ searchParams }: RunsPageProps) {
  let runs: Awaited<ReturnType<typeof listRuns>> | null = null
  let agents: Agent[] = []
  let error: string | null = null

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

  try {
    agents = await listDistinctAgents()
  } catch {
    // Non-fatal: agent dropdown is hidden if fetch fails
  }

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
              const href = s === 'all'
                ? `/runs${searchParams.range ? `?range=${searchParams.range}` : ''}`
                : `/runs?status=${s}${searchParams.range ? `&range=${searchParams.range}` : ''}`
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
              const href = r === 'all'
                ? `/runs${searchParams.status ? `?status=${searchParams.status}` : ''}`
                : `/runs?range=${r}${searchParams.status ? `&status=${searchParams.status}` : ''}`
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

        {/* Agent filter — shown only when there are agents with runs */}
        {agents.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-neutral-600 font-medium uppercase tracking-wider">Agent</span>
            <div className="flex gap-1 flex-wrap">
              {/* "All agents" option */}
              <a
                href={(() => {
                  const params = new URLSearchParams()
                  if (searchParams.status) params.set('status', searchParams.status)
                  if (searchParams.range) params.set('range', searchParams.range)
                  const qs = params.toString()
                  return `/runs${qs ? `?${qs}` : ''}`
                })()}
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
                const params = new URLSearchParams()
                params.set('agentId', agent.id)
                if (searchParams.status) params.set('status', searchParams.status)
                if (searchParams.range) params.set('range', searchParams.range)
                return (
                  <a
                    key={agent.id}
                    href={`/runs?${params.toString()}`}
                    title={agent.name}
                    className={[
                      'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100 max-w-[160px] truncate',
                      active
                        ? 'bg-primary-900 text-primary-300 border-primary-700'
                        : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
                    ].join(' ')}
                  >
                    {agent.slug || agent.name}
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
          <RunList runs={runs?.runs} />
        )}
      </div>
    </div>
  )
}
