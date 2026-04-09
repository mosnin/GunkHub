'use client'

import type { Run } from '@agent-flight-recorder/contracts'

import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'
import { truncateId, formatDuration, formatRelativeTime } from '@/lib/utils'

interface RunListProps {
  runs?: Run[]
  loading?: boolean
}

export function RunList({ runs, loading }: RunListProps) {
  if (loading) {
    return <LoadingState message="Loading runs..." />
  }

  if (!runs || runs.length === 0) {
    return (
      <EmptyState
        title="No runs recorded yet."
        description="Runs will appear here once your agents start recording. Integrate the SDK to begin."
      />
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border border-neutral-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900">
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Run ID
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Agent
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Started
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Duration
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800 bg-neutral-950">
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-neutral-900 transition-colors duration-100">
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-neutral-300">{truncateId(run.id, 12)}</span>
              </td>
              <td className="px-4 py-3">
                <Badge status={run.status} />
              </td>
              <td className="px-4 py-3 text-neutral-400 text-xs">{run.agentId}</td>
              <td className="px-4 py-3 text-neutral-400 text-xs">{formatRelativeTime(run.startedAt)}</td>
              <td className="px-4 py-3 text-neutral-400 text-xs font-mono">
                {run.endedAt ? formatDuration(run.endedAt - run.startedAt) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
