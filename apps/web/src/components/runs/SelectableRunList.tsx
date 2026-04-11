'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'

import type { VerificationStatus } from '@/lib/services/projection_verify'
import type { Run } from '@agent-flight-recorder/contracts'

import { IntegrityBadge } from '@/components/runs/IntegrityBadge'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { bulkReverifyAction, type BulkReverifyResult } from '@/lib/actions/verification'
import { truncateId, formatDuration, formatRelativeTime } from '@/lib/utils'

/** Run statuses that are eligible for on-demand reverification. */
const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled', 'timed_out'])

interface SelectableRunListProps {
  runs?: Run[]
  agentVersionLabels?: Record<string, string>
  verificationStatuses?: Record<string, VerificationStatus>
}

/**
 * Runs table with multi-select checkboxes and a bulk re-verify action bar.
 * Used exclusively on the /runs page (not the dashboard).
 * Always shows the Integrity column.
 */
export function SelectableRunList({
  runs,
  agentVersionLabels = {},
  verificationStatuses = {},
}: SelectableRunListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkResult, setBulkResult] = useState<BulkReverifyResult | null>(null)
  const [isPending, startTransition] = useTransition()

  if (!runs || runs.length === 0) {
    return (
      <EmptyState
        title="No runs recorded yet."
        description="Runs will appear here once your agents start recording. Instrument your first agent with the SDK."
      />
    )
  }

  const eligibleIds = runs.filter((r) => TERMINAL_STATUSES.has(r.status)).map((r) => r.id)
  const selectedEligible = [...selectedIds].filter((id) => eligibleIds.includes(id))
  const allEligibleSelected =
    eligibleIds.length > 0 && selectedEligible.length === eligibleIds.length

  function toggleAll() {
    setBulkResult(null)
    if (allEligibleSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(eligibleIds))
    }
  }

  function toggleRun(id: string) {
    setBulkResult(null)
    const next = new Set(selectedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedIds(next)
  }

  function handleBulkReverify() {
    setBulkResult(null)
    startTransition(async () => {
      const result = await bulkReverifyAction(selectedEligible)
      setBulkResult(result)
      setSelectedIds(new Set())
    })
  }

  const someSelected = selectedIds.size > 0

  return (
    <div>
      {/* Bulk action bar — shown when runs are selected or a result is available */}
      {(someSelected || bulkResult !== null) && (
        <div className="mb-2 flex items-center gap-3 px-3 py-2 rounded-md border border-neutral-800 bg-neutral-900 text-xs font-mono">
          {isPending ? (
            <span className="text-neutral-500">Re-verifying…</span>
          ) : someSelected ? (
            <>
              <span className="text-neutral-400">
                {selectedEligible.length} selected
                {selectedIds.size > selectedEligible.length && (
                  <span className="text-neutral-600 ml-1">
                    ({selectedIds.size - selectedEligible.length} non-terminal skipped)
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedIds(new Set())
                  setBulkResult(null)
                }}
                className="text-neutral-600 hover:text-neutral-400 transition-colors duration-100"
              >
                clear
              </button>
              <button
                type="button"
                onClick={handleBulkReverify}
                disabled={selectedEligible.length === 0}
                className="ml-auto px-2 py-0.5 rounded border text-xs font-mono transition-colors duration-100 border-primary-800 text-primary-400 hover:text-primary-300 hover:border-primary-700 disabled:text-neutral-700 disabled:border-neutral-800"
              >
                Re-verify {selectedEligible.length}
              </button>
            </>
          ) : bulkResult !== null ? (
            <>
              <span className="text-neutral-400">
                {bulkResult.succeeded.length > 0 && (
                  <span className="text-emerald-600">{bulkResult.succeeded.length} verified</span>
                )}
                {bulkResult.succeeded.length > 0 && bulkResult.failed.length > 0 && (
                  <span className="text-neutral-600 mx-1">·</span>
                )}
                {bulkResult.failed.length > 0 && (
                  <span className="text-red-500">{bulkResult.failed.length} failed</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setBulkResult(null)}
                className="ml-auto text-neutral-600 hover:text-neutral-400 transition-colors duration-100"
              >
                dismiss
              </button>
            </>
          ) : null}
        </div>
      )}

      {/* Run table */}
      <div className="overflow-x-auto rounded-md border border-neutral-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900">
              <th className="w-8 px-3 py-3 text-left">
                <input
                  type="checkbox"
                  checked={allEligibleSelected}
                  onChange={toggleAll}
                  className="accent-primary-500"
                  title={eligibleIds.length === 0 ? 'No eligible runs' : 'Select all eligible runs'}
                  disabled={eligibleIds.length === 0}
                />
              </th>
              <th className="w-36 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Run ID
              </th>
              <th className="w-28 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Status
              </th>
              <th className="w-28 px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Integrity
              </th>
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
              const verificationStatus = verificationStatuses[run.id]
              const isEligible = TERMINAL_STATUSES.has(run.status)
              const isSelected = selectedIds.has(run.id)
              const wasSucceeded = bulkResult?.succeeded.includes(run.id) ?? false
              const wasFailed = bulkResult?.failed.includes(run.id) ?? false

              return (
                <tr
                  key={run.id}
                  className={[
                    'hover:bg-neutral-900 transition-colors duration-100 group',
                    isSelected ? 'bg-neutral-900/50' : '',
                  ].join(' ')}
                >
                  <td className="px-3 py-3">
                    {isEligible ? (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRun(run.id)}
                        className="accent-primary-500"
                        aria-label={`Select run ${truncateId(run.id, 8)}`}
                      />
                    ) : (
                      <span className="inline-block w-4 h-4" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5">
                      <Link
                        href={`/runs/${run.id}`}
                        className="font-mono text-xs text-neutral-300 group-hover:text-neutral-100 transition-colors duration-100"
                      >
                        {truncateId(run.id, 12)}
                      </Link>
                      {wasSucceeded && (
                        <span className="text-emerald-600 text-xs" aria-label="re-verified">✓</span>
                      )}
                      {wasFailed && (
                        <span
                          className="text-red-600 text-xs"
                          aria-label="re-verify failed"
                          title={bulkResult?.errors[run.id]}
                        >
                          ✗
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/runs/${run.id}`} tabIndex={-1} aria-hidden>
                      <Badge status={run.status} />
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {verificationStatus ? (
                      <Link href={`/runs/${run.id}`} tabIndex={-1} aria-hidden>
                        <IntegrityBadge status={verificationStatus} />
                      </Link>
                    ) : (
                      <span className="text-xs text-neutral-700">—</span>
                    )}
                  </td>
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
                        <span className="text-xs text-neutral-700">—</span>
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
                        <span className="text-xs text-neutral-600 font-mono">
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
    </div>
  )
}
