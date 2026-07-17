'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { DiffKind, EventDiff, FieldChange, RunDiff } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'

interface DiffViewerProps {
  diff?: RunDiff
  incomparable?: boolean
  incomparableReason?: string
  loading?: boolean
}

// Event type → color class consistent with Timeline
function typeColorClass(type: string | undefined): string {
  if (!type) return 'text-neutral-500'
  if (type.startsWith('llm.') || type.startsWith('LLM_')) return 'text-violet-400'
  if (type.startsWith('tool.') || type.startsWith('TOOL_')) return 'text-amber-400'
  if (type.startsWith('http.') || type.startsWith('HTTP_')) return 'text-sky-400'
  if (type.startsWith('run.') || type.startsWith('RUN_')) return 'text-neon-glow'
  if (type.startsWith('memory.') || type.startsWith('MEMORY_')) return 'text-pink-400'
  if (type.startsWith('retrieval.') || type.startsWith('RETRIEVAL_')) return 'text-cyan-400'
  return 'text-neutral-400'
}

const kindConfig: Record<
  DiffKind,
  { prefix: string; border: string; bg: string; text: string }
> = {
  same:    { prefix: ' ', border: 'border-l-neutral-700', bg: '',                  text: 'text-neutral-500' },
  added:   { prefix: '+', border: 'border-l-primary-700', bg: 'bg-primary-900/20', text: 'text-neon-glow' },
  removed: { prefix: '-', border: 'border-l-red-600',     bg: 'bg-red-950/20',     text: 'text-red-400'    },
  changed: { prefix: '~', border: 'border-l-amber-600',   bg: 'bg-amber-950/20',   text: 'text-amber-400'  },
}

interface FieldChangesTableProps {
  changes: FieldChange[]
}

function FieldChangesTable({ changes }: FieldChangesTableProps) {
  return (
    <table className="w-full text-xs font-mono mt-2 border-collapse">
      <thead>
        <tr className="text-neutral-600">
          <th className="text-left px-2 py-1 w-1/3 font-medium">field</th>
          <th className="text-left px-2 py-1 w-1/3 font-medium text-red-600">left</th>
          <th className="text-left px-2 py-1 w-1/3 font-medium text-neon-glow">right</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change, i) => (
          <tr key={i} className="border-t border-neutral-800">
            <td className="px-2 py-1 text-neutral-400 truncate max-w-0 w-1/3">{change.path}</td>
            <td className="px-2 py-1 text-red-400/80 truncate max-w-0 w-1/3">
              {JSON.stringify(change.left)}
            </td>
            <td className="px-2 py-1 text-neon-glow/80 truncate max-w-0 w-1/3">
              {JSON.stringify(change.right)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface EventDiffRowProps {
  entry: EventDiff
  isFirstDivergence: boolean
}

function EventDiffRow({ entry, isFirstDivergence }: EventDiffRowProps) {
  const [expanded, setExpanded] = useState(false)
  const cfg = kindConfig[entry.kind]
  const type = entry.leftEvent?.type ?? entry.rightEvent?.type
  const changes = entry.changes ?? []
  const hasChanges = entry.kind === 'changed' && changes.length > 0

  return (
    <div>
      {isFirstDivergence && (
        <div className="flex items-center gap-2 px-3 py-1 text-xs text-amber-400 font-mono border-t border-amber-900/40 bg-amber-950/10">
          <span aria-hidden="true">↑</span>
          First divergence
        </div>
      )}
      <div
        className={[
          'border-l-2 px-3 py-2',
          cfg.border,
          cfg.bg,
          entry.kind === 'same' ? 'opacity-50' : '',
        ].join(' ')}
      >
        <div className="flex items-center gap-2">
          <span className={['font-mono text-xs w-4 shrink-0 select-none', cfg.text].join(' ')}>
            {cfg.prefix}
          </span>
          <span className="font-mono text-xs text-neutral-600 w-8 shrink-0">
            #{entry.sequenceNumber}
          </span>
          <span className={['font-mono text-xs flex-1 truncate', typeColorClass(type)].join(' ')}>
            {type ?? '(no event)'}
          </span>
          {hasChanges && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors duration-75 flex items-center gap-1"
            >
              {expanded ? 'hide' : `${changes.length} changes`}
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                aria-hidden="true"
                className={['transition-transform duration-75', expanded ? 'rotate-180' : ''].join(' ')}
              >
                <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        {hasChanges && expanded && (
          <FieldChangesTable changes={changes} />
        )}
      </div>
    </div>
  )
}

/**
 * RunSelector — shown when the diff page has no runs selected yet.
 * Submits by navigating to /diff?left=[id]&right=[id].
 */
function RunSelector() {
  const router = useRouter()
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const l = left.trim()
    const r = right.trim()
    if (!l || !r) return
    router.push(`/diff?left=${encodeURIComponent(l)}&right=${encodeURIComponent(r)}`)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="diff-left" className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Run A (left)
          </label>
          <input
            id="diff-left"
            type="text"
            value={left}
            onChange={(e) => setLeft(e.target.value)}
            placeholder="Paste run ID..."
            className="h-9 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-sm text-neutral-300 placeholder-neutral-600 font-mono outline-none focus:border-neutral-600 transition-colors duration-75"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="diff-right" className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Run B (right)
          </label>
          <input
            id="diff-right"
            type="text"
            value={right}
            onChange={(e) => setRight(e.target.value)}
            placeholder="Paste run ID..."
            className="h-9 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-sm text-neutral-300 placeholder-neutral-600 font-mono outline-none focus:border-neutral-600 transition-colors duration-75"
          />
        </div>
      </div>
      <div>
        <button
          type="submit"
          disabled={!left.trim() || !right.trim()}
          className="px-4 py-2 rounded-md bg-neutral-800 border border-neutral-700 text-sm font-medium text-neutral-200 hover:bg-neutral-700 hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-75"
        >
          Compare runs
        </button>
      </div>
    </form>
  )
}

interface DiffResultProps {
  diff: RunDiff
  incomparable?: boolean
  incomparableReason?: string
}

function DiffResult({ diff, incomparable, incomparableReason }: DiffResultProps) {
  const { summary, leftRunId, rightRunId, eventDiffs } = diff
  const firstDivergenceIndex = eventDiffs.findIndex((e) => e.kind !== 'same')

  return (
    <div className="flex flex-col gap-4">
      {/* Header — run IDs + summary badges */}
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Run A</span>
            <span className="h-9 px-3 flex items-center rounded-md bg-neutral-900 border border-neutral-800 text-sm text-neutral-300 font-mono truncate">
              {leftRunId}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Run B</span>
            <span className="h-9 px-3 flex items-center rounded-md bg-neutral-900 border border-neutral-800 text-sm text-neutral-300 font-mono truncate">
              {rightRunId}
            </span>
          </div>
        </div>

        {/* Summary badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-primary-900/40 border border-primary-800/50 text-xs font-mono font-medium text-neon-glow">
            +{summary.added} added
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-950/40 border border-red-900/50 text-xs font-mono font-medium text-red-400">
            -{summary.removed} removed
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-950/40 border border-amber-900/50 text-xs font-mono font-medium text-amber-400">
            ~{summary.changed} changed
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-neutral-800 border border-neutral-700 text-xs font-mono font-medium text-neutral-500">
            ={summary.same} same
          </span>
          {summary.statusChanged && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-950/40 border border-amber-900/50 text-xs font-mono font-medium text-amber-400">
              status changed
            </span>
          )}
        </div>
      </div>

      {/* Truncation warning */}
      {diff.truncated && (
        <div className="px-4 py-2 bg-orange-950/40 border border-orange-900/50 rounded-md text-xs text-orange-400 font-medium">
          This comparison is partial. Each run was capped at 10,000 events — the displayed diff may not represent the full difference.
        </div>
      )}

      {/* Incomparable notice */}
      {incomparable && (
        <div className="rounded-md bg-amber-950/30 border border-amber-900/60 px-4 py-3 text-sm text-amber-300">
          <span className="font-semibold">Cannot compare: </span>
          {incomparableReason ?? 'These runs cannot be fairly compared.'}
        </div>
      )}

      {/* Diff list */}
      <div className="rounded-md border border-neutral-800 bg-neutral-950 overflow-hidden">
        {eventDiffs.length === 0 ? (
          <EmptyState
            title="No differences"
            description="These runs have identical event sequences."
          />
        ) : (
          <div className="divide-y divide-neutral-800/50">
            {eventDiffs.map((entry, i) => (
              <EventDiffRow
                key={`${entry.sequenceNumber}-${entry.kind}`}
                entry={entry}
                isFirstDivergence={i === firstDivergenceIndex && firstDivergenceIndex !== -1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function DiffViewer({ diff, incomparable, incomparableReason, loading }: DiffViewerProps) {
  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="h-9 rounded-md bg-neutral-900 border border-neutral-800 animate-pulse" />
          <div className="h-9 rounded-md bg-neutral-900 border border-neutral-800 animate-pulse" />
        </div>
        <div className="rounded-md border border-neutral-800 bg-neutral-900 py-20 flex items-center justify-center">
          <span className="text-sm text-neutral-500">Computing diff…</span>
        </div>
      </div>
    )
  }

  // No diff loaded yet — show selector + empty state
  if (!diff) {
    return (
      <div className="flex flex-col gap-6">
        <RunSelector />
        <div className="rounded-md border border-neutral-800 bg-neutral-900">
          <EmptyState
            title="No runs selected"
            description="Enter two run IDs above to compare their event sequences."
          />
        </div>
      </div>
    )
  }

  return (
    <DiffResult
      diff={diff}
      incomparable={incomparable}
      incomparableReason={incomparableReason}
    />
  )
}
