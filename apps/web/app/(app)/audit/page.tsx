import Link from 'next/link'

import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import {
  AuditAccessDeniedError,
  listAuditLog,
  type AuditLogEntry,
} from '@/lib/services/audit'
import { truncateId } from '@/lib/utils'

export const metadata: Metadata = { title: 'Audit Log' }

const PAGE_SIZE = 50

interface AuditPageProps {
  searchParams: {
    cursor?: string
  }
}

/** Format a millisecond epoch as an ISO string, for the title attribute. */
function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

/** Format a millisecond epoch as a short absolute timestamp for display. */
function formatAbsolute(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** One-line summary of the metadata blob — bounded length, key: value pairs. */
function summarizeMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) return '—'
  const parts = Object.entries(metadata).map(([key, value]) => {
    const rendered =
      typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
    return `${key}=${rendered}`
  })
  const joined = parts.join(', ')
  return joined.length > 120 ? `${joined.slice(0, 117)}...` : joined
}

function AuditRow({ entry }: { entry: AuditLogEntry }) {
  return (
    <tr className="border-b border-graphite last:border-b-0 hover:bg-graphite/60 transition-colors duration-100">
      <td
        className="px-3 py-2.5 text-xs font-mono text-neutral-400 whitespace-nowrap align-top"
        title={toIso(entry.timestamp)}
      >
        {formatAbsolute(entry.timestamp)}
      </td>
      <td className="px-3 py-2.5 align-top">
        <span className="inline-flex items-center px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border bg-graphite text-cloud border-graphite-light whitespace-nowrap">
          {entry.action}
        </span>
      </td>
      <td className="px-3 py-2.5 text-xs font-mono text-neutral-300 align-top whitespace-nowrap">
        {entry.actorClerkUserId === 'clerk-webhook' ? (
          <span className="text-pewter italic">clerk-webhook</span>
        ) : (
          entry.actorClerkUserId
        )}
      </td>
      <td className="px-3 py-2.5 align-top">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-xs font-mono text-neutral-500 shrink-0">{entry.targetType}</span>
          <span className="text-xs font-mono text-neutral-300 truncate" title={entry.targetId}>
            {truncateId(entry.targetId, 12)}
          </span>
          <CopyToClipboardButton value={entry.targetId} label="Copy target ID" />
        </div>
      </td>
      <td className="px-3 py-2.5 text-xs font-mono text-neutral-500 align-top max-w-[360px] truncate" title={summarizeMetadata(entry.metadata)}>
        {summarizeMetadata(entry.metadata)}
      </td>
    </tr>
  )
}

export default async function AuditPage({ searchParams }: AuditPageProps) {
  let result: Awaited<ReturnType<typeof listAuditLog>> | null = null
  let error: string | null = null
  let accessDenied = false

  try {
    result = await listAuditLog({ limit: PAGE_SIZE, cursor: searchParams.cursor })
  } catch (err) {
    if (err instanceof AuditAccessDeniedError) {
      accessDenied = true
    } else {
      error = err instanceof Error ? err.message : 'Failed to load audit log'
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Audit Log"
        subtitle="Who did what, when — every privileged change in your organization."
      />

      <div className="mt-4">
        {accessDenied ? (
          <EmptyState
            title="Admin access required"
            description="The audit log records privileged changes across your organization and is visible to org admins only. Ask an admin on your team for access, or switch to an organization where you hold the admin role."
          />
        ) : error ? (
          <ErrorState title="Failed to load audit log" message={error} />
        ) : result && result.entries.length === 0 ? (
          <EmptyState
            title="No audit events yet"
            description="Privileged changes — API key creation, membership updates, project and agent lifecycle changes — will appear here as they happen."
          />
        ) : result ? (
          <div className="overflow-x-auto rounded-[4px] border border-graphite">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-graphite bg-graphite-deep">
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[180px]">
                    Timestamp
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[160px]">
                    Action
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[160px]">
                    Actor
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[220px]">
                    Target
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider">
                    Metadata
                  </th>
                </tr>
              </thead>
              <tbody className="bg-graphite-deep">
                {result.entries.map((entry) => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {!accessDenied && !error && (searchParams.cursor ?? result?.nextCursor) && (
        <div className="mt-4 flex items-center justify-between border-t border-graphite pt-3">
          <div>
            {searchParams.cursor && (
              <Link
                href="/audit"
                className="px-2 py-1 rounded text-xs font-mono font-medium border bg-transparent text-neutral-400 border-graphite-light hover:text-neutral-200 hover:border-neutral-600 transition-colors duration-100"
              >
                ← First page
              </Link>
            )}
          </div>
          <div>
            {result?.nextCursor && (
              <Link
                href={`/audit?cursor=${encodeURIComponent(result.nextCursor)}`}
                className="px-2 py-1 rounded text-xs font-mono font-medium border bg-transparent text-neutral-400 border-graphite-light hover:text-neutral-200 hover:border-neutral-600 transition-colors duration-100"
              >
                Older events →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
