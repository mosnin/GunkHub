'use client'

import { useState } from 'react'

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
  tags?: string[]
  metadata?: Record<string, unknown>
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy run ID"
      aria-label="Copy run ID to clipboard"
      className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded text-neutral-600 hover:text-neutral-400 hover:bg-neutral-800 transition-colors duration-100 shrink-0"
    >
      {copied ? (
        /* Checkmark icon */
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        /* Copy icon */
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="4" y="4" width="6" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M2 8V2a1 1 0 011-1h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )
}

export function RunHeader({ runId, status, agentName, startedAt, endedAt, triggeredBy, tags, metadata }: RunHeaderProps) {
  return (
    <div className="px-6 py-4 border-b border-neutral-800 bg-neutral-950">
      {/* Main row */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {/* Run ID with copy button */}
        <div className="flex items-center gap-0.5">
          <span className="font-mono text-sm text-neutral-100 tracking-tight">
            {truncateId(runId, 12)}
          </span>
          <CopyButton value={runId} />
        </div>

        <Badge status={status} />

        <span className="text-xs text-neutral-500 font-mono">{truncateId(agentName, 20)}</span>

        <span className="text-xs text-neutral-500">{formatRelativeTime(startedAt)}</span>

        {endedAt && (
          <span className="text-xs font-mono text-neutral-500">
            {formatDuration(endedAt - startedAt)}
          </span>
        )}

        {triggeredBy && (
          <span className="text-xs text-neutral-600">
            via <span className="text-neutral-500 font-mono">{triggeredBy}</span>
          </span>
        )}
      </div>

      {/* Tags row — only rendered when tags exist */}
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono text-neutral-500 bg-neutral-900 border border-neutral-800"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Metadata — collapsible details, only when metadata has keys */}
      {metadata && Object.keys(metadata).length > 0 && (
        <details className="mt-2">
          <summary className="text-xs text-neutral-600 cursor-pointer hover:text-neutral-500 select-none">
            Metadata ({Object.keys(metadata).length} field{Object.keys(metadata).length !== 1 ? 's' : ''})
          </summary>
          <dl className="mt-2 flex flex-col gap-1">
            {Object.entries(metadata).map(([key, value]) => (
              <div key={key} className="flex gap-3 text-xs">
                <dt className="font-mono text-neutral-600 shrink-0 min-w-[6rem]">{key}</dt>
                <dd className="font-mono text-neutral-400 break-all">
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  )
}
