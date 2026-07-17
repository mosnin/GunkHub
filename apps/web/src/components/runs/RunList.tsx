import Link from 'next/link'

import type { VerificationStatus } from '@/lib/services/projection_verify'
import type { Run } from '@agent-flight-recorder/contracts'

import { IntegrityBadge } from '@/components/runs/IntegrityBadge'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'
import { truncateId, formatDuration, formatRelativeTime } from '@/lib/utils'

interface RunListProps {
  runs?: Run[]
  loading?: boolean
  agentVersionLabels?: Record<string, string>
  /** When provided, an Integrity column is shown for each row. */
  verificationStatuses?: Record<string, VerificationStatus>
}

export function RunList({ runs, loading, agentVersionLabels = {}, verificationStatuses }: RunListProps) {
  if (loading) {
    return <LoadingState message="Loading runs..." />
  }

  if (!runs || runs.length === 0) {
    return (
      <EmptyState
        title="No runs recorded yet."
        description="Runs will appear here once your agents start recording. Instrument your first agent with the SDK."
      />
    )
  }

  const showIntegrity = verificationStatuses !== undefined

  return (
    <div className="overflow-x-auto rounded-md border border-neutral-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900">
            <th className="w-36 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Run ID
            </th>
            <th className="w-28 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Status
            </th>
            {showIntegrity && (
              <th className="w-28 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Integrity
              </th>
            )}
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Agent
            </th>
            <th className="w-28 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Version
            </th>
            <th className="w-36 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Started
            </th>
            <th className="w-24 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Duration
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Tags
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800 bg-neutral-950">
          {runs.map((run) => {
            const verificationStatus = verificationStatuses?.[run.id]
            return (
              <tr key={run.id} className="hover:bg-neutral-900 transition-colors duration-100 group">
                <td className="px-4 py-3">
                  <Link
                    href={`/runs/${run.id}`}
                    className="font-mono text-xs text-neutral-300 group-hover:text-neutral-100 transition-colors duration-100"
                  >
                    {truncateId(run.id, 12)}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/runs/${run.id}`} tabIndex={-1} aria-hidden>
                    <Badge status={run.status} />
                  </Link>
                </td>
                {showIntegrity && (
                  <td className="px-4 py-3">
                    {verificationStatus ? (
                      <Link href={`/runs/${run.id}`} tabIndex={-1} aria-hidden>
                        <IntegrityBadge status={verificationStatus} />
                      </Link>
                    ) : (
                      <span className="text-xs text-pewter">—</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-3">
                  <Link
                    href={`/runs/${run.id}`}
                    className="text-neutral-400 text-xs hover:text-neutral-300 transition-colors duration-100 font-mono"
                    tabIndex={-1}
                  >
                    {truncateId(run.agentId, 16)}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/runs/${run.id}`} tabIndex={-1} aria-hidden>
                    {run.agentVersionId && agentVersionLabels[run.agentVersionId] ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono text-neutral-400 bg-neutral-900 border border-neutral-800">
                        {agentVersionLabels[run.agentVersionId]}
                      </span>
                    ) : (
                      <span className="text-xs text-pewter">—</span>
                    )}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/runs/${run.id}`}
                    className="text-neutral-400 text-xs hover:text-neutral-300 transition-colors duration-100"
                    tabIndex={-1}
                  >
                    {formatRelativeTime(run.startedAt)}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/runs/${run.id}`}
                    className="text-neutral-400 text-xs font-mono hover:text-neutral-300 transition-colors duration-100"
                    tabIndex={-1}
                  >
                    {run.endedAt ? formatDuration(run.endedAt - run.startedAt) : '—'}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1 max-w-[200px]">
                    {(run.tags ?? []).slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono text-neutral-500 bg-neutral-900 border border-neutral-800"
                      >
                        {tag}
                      </span>
                    ))}
                    {(run.tags ?? []).length > 3 && (
                      <span className="text-xs text-pewter font-mono">
                        +{(run.tags ?? []).length - 3}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
