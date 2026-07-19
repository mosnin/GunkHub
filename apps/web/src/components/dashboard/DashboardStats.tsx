import Link from 'next/link'

import type { AgentDashboardRow, DashboardRange, DashboardStats as DashboardStatsData } from '@/lib/services/dashboard'

import { EmptyState } from '@/components/ui/EmptyState'
import { RevealGroup, RevealItem } from '@/components/ui/Motion'

interface DashboardStatsProps {
  stats: DashboardStatsData
  perAgent: AgentDashboardRow[]
  range: DashboardRange
}

function StatTile({
  label,
  value,
  accent = 'neutral',
}: {
  label: string
  value: string
  accent?: 'neutral' | 'neon' | 'warn'
}) {
  const dot =
    accent === 'neon' ? 'bg-neon-glow shadow-[var(--shadow-glow)]'
    : accent === 'warn' ? 'bg-destructive-500 shadow-[var(--shadow-glow-warn)]'
    : 'bg-graphite-light'
  const valueColor = accent === 'neon' ? 'text-neon-glow' : accent === 'warn' ? 'text-destructive-500' : 'text-whiteout'
  return (
    <RevealItem className="neon-surface relative overflow-hidden p-4">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
        <p className="font-mono text-[11px] uppercase tracking-wider text-pewter">{label}</p>
      </div>
      <p className={`mt-2 font-mono text-2xl leading-none font-medium tabular-nums ${valueColor}`}>{value}</p>
    </RevealItem>
  )
}

export function DashboardStats({ stats, perAgent, range }: DashboardStatsProps) {
  return (
    <div className="flex flex-col gap-6">
      {/* Range toggle */}
      <div className="flex items-center justify-end gap-1.5">
        {(['7d', '30d'] as const).map((r) => (
          <Link
            key={r}
            href={r === '7d' ? '/dashboard' : '/dashboard?range=30d'}
            aria-current={range === r ? 'page' : undefined}
            className={[
              'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
              range === r
                ? 'bg-primary-900 text-primary-300 border-primary-700'
                : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
            ].join(' ')}
          >
            {r}
          </Link>
        ))}
      </div>

      {!stats.available ? (
        <EmptyState
          title="Analytics haven't computed yet"
          description="Dashboard rollups activate once there's run history to summarize for this range. This page is wired and ready — it will start showing real numbers as soon as the analytics pipeline catches up, with no further UI changes needed."
        />
      ) : (
        <>
          <RevealGroup className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Total runs" value={stats.totals.runsTotal.toLocaleString('en-US')} />
            <StatTile
              label="Failure rate"
              value={`${(stats.totals.failureRate * 100).toFixed(1)}%`}
              accent={stats.totals.failureRate > 0.1 ? 'warn' : 'neutral'}
            />
            <StatTile label="Tokens in" value={stats.totals.tokensIn.toLocaleString('en-US')} accent="neon" />
            <StatTile label="Tokens out" value={stats.totals.tokensOut.toLocaleString('en-US')} accent="neon" />
          </RevealGroup>

          {stats.series.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-pewter uppercase tracking-wider">
                Failure rate trend
              </p>
              <div
                className="flex items-end gap-[3px] h-20 border-b border-graphite"
                role="img"
                aria-label={`Failure rate for the last ${String(stats.series.length)} days`}
              >
                {stats.series.map((point) => {
                  const heightPct = Math.max(2, Math.round(point.failureRate * 100))
                  const isHigh = point.failureRate > 0.1
                  return (
                    <div
                      key={point.date}
                      className={[
                        'flex-1 min-w-[3px] rounded-t-[2px] transition-colors duration-100',
                        isHigh
                          ? 'bg-destructive-500/70 hover:bg-destructive-500'
                          : 'bg-neon-muted hover:bg-neon-glow',
                      ].join(' ')}
                      style={{ height: `${String(heightPct)}%` }}
                      title={`${point.date}: ${(point.failureRate * 100).toFixed(1)}% failure (${String(point.runsFailed)}/${String(point.runsTotal)})${point.source === 'fallback' ? ' — computed live, rollup pending' : ''}`}
                    />
                  )
                })}
              </div>
              <div className="flex justify-between text-[10px] font-mono text-pewter">
                <span>{stats.series[0]?.date}</span>
                <span>{stats.series[stats.series.length - 1]?.date}</span>
              </div>
              {stats.series.some((p) => p.source === 'fallback') && (
                <p className="text-xs text-pewter">
                  Some days shown were computed live — the nightly rollup hasn&#39;t caught up to them yet.
                </p>
              )}
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-pewter uppercase tracking-wider mb-2">
              Per-agent breakdown
            </p>
            {perAgent.length === 0 ? (
              <p className="text-sm text-neutral-500">No per-agent data available for this range.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-neutral-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-800 bg-neutral-900">
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Agent
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Runs
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Failure rate
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Tokens in
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Tokens out
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                    {perAgent.map((row) => (
                      <tr key={row.agentId}>
                        <td className="px-4 py-2">
                          <Link
                            href={`/agents/${row.agentId}`}
                            className="text-neutral-200 hover:text-whiteout transition-colors duration-100"
                          >
                            {row.agentName}
                          </Link>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                          {row.totals.runsTotal.toLocaleString('en-US')}
                        </td>
                        <td className={`px-4 py-2 font-mono text-xs ${row.totals.failureRate > 0.1 ? 'text-destructive-400' : 'text-neutral-400'}`}>
                          {(row.totals.failureRate * 100).toFixed(1)}%
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                          {row.totals.tokensIn.toLocaleString('en-US')}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                          {row.totals.tokensOut.toLocaleString('en-US')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
