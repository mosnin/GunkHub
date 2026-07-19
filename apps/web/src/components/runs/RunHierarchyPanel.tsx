import Link from 'next/link'

import type { Run } from '@agent-flight-recorder/contracts'

import { Badge } from '@/components/ui/Badge'
import { truncateId, formatRelativeTime } from '@/lib/utils'

interface RunHierarchyPanelProps {
  parentRunId?: string
  sessionId?: string
  children: Run[]
}

/**
 * Compact trace tree — parent link, direct children, and a link to the
 * session's sibling runs. Hidden entirely (by the caller) when a run has
 * none of parentRunId/sessionId/children, so it never renders an empty shell.
 */
export function RunHierarchyPanel({ parentRunId, sessionId, children }: RunHierarchyPanelProps) {
  return (
    <div className="px-6 py-3 border-b border-neutral-800 flex flex-col gap-2">
      <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
        Trace
      </h2>

      {parentRunId && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-pewter font-mono shrink-0">parent</span>
          <Link
            href={`/runs/${parentRunId}`}
            className="font-mono text-neutral-300 hover:text-neutral-100 transition-colors duration-100"
          >
            {truncateId(parentRunId, 16)}
          </Link>
        </div>
      )}

      {sessionId && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-pewter font-mono shrink-0">session</span>
          <Link
            href={`/sessions/${encodeURIComponent(sessionId)}`}
            className="font-mono text-neutral-300 hover:text-neutral-100 transition-colors duration-100"
            title="View all runs in this session"
          >
            {sessionId}
          </Link>
        </div>
      )}

      {children.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-pewter font-mono text-xs">
            {children.length} child run{children.length === 1 ? '' : 's'}
          </span>
          <ul className="flex flex-col gap-1 pl-3 border-l border-graphite-light">
            {children.map((child) => (
              <li key={child.id}>
                <Link
                  href={`/runs/${child.id}`}
                  className="flex items-center gap-2 text-xs hover:bg-neutral-900 -ml-3 pl-3 pr-2 py-1 rounded-[4px] transition-colors duration-100"
                >
                  <Badge status={child.status} />
                  <span className="font-mono text-neutral-400">{truncateId(child.id, 12)}</span>
                  <span className="text-pewter ml-auto shrink-0">{formatRelativeTime(child.startedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
