import type { AgentCostStats } from '@/lib/services/cost'

import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

function formatUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

interface CostStatsProps {
  stats: AgentCostStats
}

/**
 * Agent cost breakdown — token volume + ESTIMATED cost by model. Every
 * dollar figure here is explicitly labeled "estimated": this is never billed
 * truth, it's a pricing-table lookup against recorded token counts.
 */
export function CostStats({ stats }: CostStatsProps) {
  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">Cost (estimated)</h2>
        <p className="mt-0.5 text-xs text-neutral-400">
          Token volume and an estimated dollar cost by model — not a billed total.
        </p>
      </div>

      <div className="px-5 py-4">
        {!stats.available ? (
          <EmptyState
            title="Cost estimates aren't available yet"
            description="This activates once cost rollups have been computed for this agent — no runs, or the analytics pipeline hasn't caught up yet."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="flex flex-wrap gap-3">
              <div className="flex-1 min-w-[140px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
                <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Estimated cost</dt>
                <dd className="mt-1 font-mono text-xl text-whiteout tabular-nums">
                  {formatUsd(stats.totalCostUsd)}
                </dd>
              </div>
              <div className="flex-1 min-w-[120px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
                <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Tokens in</dt>
                <dd className="mt-1 font-mono text-xl text-whiteout tabular-nums">
                  {stats.tokensIn.toLocaleString('en-US')}
                </dd>
              </div>
              <div className="flex-1 min-w-[120px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
                <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Tokens out</dt>
                <dd className="mt-1 font-mono text-xl text-whiteout tabular-nums">
                  {stats.tokensOut.toLocaleString('en-US')}
                </dd>
              </div>
            </dl>

            {stats.truncated && (
              <p className="text-xs text-pewter">
                Based on a bounded sample of recent runs — not every run in the range was scanned.
              </p>
            )}

            {stats.byModel.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-neutral-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-800 bg-neutral-900">
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Model
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Tokens in
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Tokens out
                      </th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Est. cost
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                    {stats.byModel.map((m) => (
                      <tr key={m.model}>
                        <td className="px-4 py-2 font-mono text-xs text-neutral-300">{m.model}</td>
                        <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                          {m.tokensIn.toLocaleString('en-US')}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                          {m.tokensOut.toLocaleString('en-US')}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                          {m.matched ? formatUsd(m.costUsd) : (
                            <span className="text-pewter">no pricing</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {stats.unmatchedModels.length > 0 && (
              <p className="text-xs text-pewter leading-relaxed">
                No pricing entry for: <span className="font-mono text-neutral-400">{stats.unmatchedModels.join(', ')}</span>.
                Cost coverage is partial — these models&#39; usage is counted in tokens above but not in the estimated total.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
