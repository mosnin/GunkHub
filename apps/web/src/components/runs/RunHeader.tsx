import type { RunStatus } from '@agent-flight-recorder/contracts'

import { Badge } from '@/components/ui/Badge'
import { truncateId, formatDuration, formatRelativeTime } from '@/lib/utils'

interface RunHeaderProps {
  runId: string
  status: RunStatus
  agentName: string
  startedAt: number
  endedAt?: number
  triggeredBy?: string
}

export function RunHeader({ runId, status, agentName, startedAt, endedAt, triggeredBy }: RunHeaderProps) {
  return (
    <div className="px-6 py-5 border-b border-neutral-800 flex flex-wrap items-center gap-x-6 gap-y-2">
      <span className="font-mono text-sm text-neutral-100 tracking-tight">
        {truncateId(runId, 12)}
      </span>
      <Badge status={status} />
      <span className="text-sm text-neutral-400">{agentName}</span>
      <span className="text-sm text-neutral-500">{formatRelativeTime(startedAt)}</span>
      {endedAt && (
        <span className="text-sm font-mono text-neutral-500">
          {formatDuration(endedAt - startedAt)}
        </span>
      )}
      {triggeredBy && (
        <span className="text-xs text-neutral-600">
          triggered by <span className="text-neutral-500">{triggeredBy}</span>
        </span>
      )}
    </div>
  )
}
