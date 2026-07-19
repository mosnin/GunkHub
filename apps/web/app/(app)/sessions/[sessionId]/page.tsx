import Link from 'next/link'

import type { Run } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { RunList } from '@/components/runs/RunList'
import { Badge } from '@/components/ui/Badge'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { listSessionRuns } from '@/lib/services/runs'
import { formatRelativeTime, truncateId } from '@/lib/utils'


export const metadata: Metadata = { title: 'Session' }

interface SessionPageProps {
  params: { sessionId: string }
}

/**
 * Mini-timeline: a horizontal strip of dots, one per run in the session,
 * ordered oldest-first, colored by status — a bird's-eye view of the
 * session before scanning the table below.
 */
function SessionMiniTimeline({ runs }: { runs: Run[] }) {
  const ordered = [...runs].sort((a, b) => a.startedAt - b.startedAt)
  const dotClass: Record<Run['status'], string> = {
    pending: 'bg-pewter',
    running: 'bg-neon-glow shadow-[var(--shadow-glow)] animate-neon-pulse',
    completed: 'bg-neon-glow shadow-[var(--shadow-glow)]',
    failed: 'bg-destructive-500 shadow-[var(--shadow-glow-warn)]',
    cancelled: 'bg-pewter',
    timed_out: 'bg-warning-500',
  }
  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto py-1"
      role="img"
      aria-label={`Timeline of ${String(ordered.length)} runs in this session, oldest first`}
    >
      {ordered.map((run) => (
        <a
          key={run.id}
          href={`/runs/${run.id}`}
          title={`${run.status} — ${truncateId(run.id, 12)} — ${formatRelativeTime(run.startedAt)}`}
          className="shrink-0"
        >
          <span className={`block w-2.5 h-2.5 rounded-full ${dotClass[run.status]}`} />
        </a>
      ))}
    </div>
  )
}

export default async function SessionPage({ params }: SessionPageProps) {
  const sessionId = decodeURIComponent(params.sessionId)

  let runs: Run[] = []
  let error: string | null = null
  try {
    runs = await listSessionRuns(sessionId)
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load session runs'
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <nav aria-label="breadcrumb" className="flex items-center gap-1.5 text-xs text-neutral-500 pb-1 flex-wrap">
        <Link href="/runs" className="hover:text-neutral-300 transition-colors duration-75">
          Runs
        </Link>
        <span className="text-pewter" aria-hidden>/</span>
        <span className="font-mono text-neutral-400" aria-current="page">
          session {truncateId(sessionId, 12)}
        </span>
      </nav>
      <PageHeader
        title="Session"
        subtitle={`Runs correlated under session ${sessionId}`}
        actions={<CopyToClipboardButton value={sessionId} label="Copy session ID" />}
      />

      {error ? (
        <div className="mt-6">
          <ErrorState title="Failed to load session" message={error} />
        </div>
      ) : runs.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No runs found for this session"
            description="Either the session ID is wrong, or no runs have been recorded against it yet — runs are correlated into a session via the SDK's sessionId option."
          />
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-3">
            <span className="text-xs text-pewter font-mono uppercase tracking-wider">
              {runs.length} run{runs.length === 1 ? '' : 's'}
            </span>
            {/* runs.length > 0 is guaranteed here (empty case returns above) */}
            <Badge status={(runs[runs.length - 1] ?? runs[0])?.status ?? 'pending'} />
          </div>

          <div className="mt-3">
            <SessionMiniTimeline runs={runs} />
          </div>

          <div className="mt-4">
            <RunList runs={runs} />
          </div>
        </>
      )}
    </div>
  )
}
