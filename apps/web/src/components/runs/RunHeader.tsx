'use client'

import { useState, useTransition, useEffect } from 'react'

import type { VerificationStatus } from '@/lib/services/projection_verify'
import type { RunStatus, GetRunResponse } from '@agent-flight-recorder/contracts'

import { IntegrityBadge } from '@/components/runs/IntegrityBadge'
import { Badge } from '@/components/ui/Badge'
import { updateRunTagsAction } from '@/lib/actions/runs'
import { truncateId, formatDuration, formatRelativeTime } from '@/lib/utils'

interface RunHeaderProps {
  runId: string
  status: RunStatus
  agentName: string
  agentVersionLabel?: string
  startedAt: number
  endedAt?: number
  triggeredBy?: string
  tags?: string[]
  metadata?: Record<string, unknown>
  isLive?: boolean
  verificationStatus?: VerificationStatus | null
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
      className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded text-pewter hover:text-cloud hover:bg-neutral-800 transition-colors duration-100 shrink-0"
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

export function RunHeader({ runId, status, agentName, agentVersionLabel, startedAt, endedAt, triggeredBy, tags, metadata, isLive = false, verificationStatus }: RunHeaderProps) {
  const [liveStatus, setLiveStatus] = useState<RunStatus>(status)
  const [liveEndedAt, setLiveEndedAt] = useState<number | undefined>(endedAt)

  useEffect(() => {
    if (!isLive) return
    if (liveStatus !== 'running') return  // already terminal, don't poll

    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/runs/${runId}`)
          if (!res.ok) return
          const data = (await res.json()) as GetRunResponse
          setLiveStatus(data.run.status)
          if (data.run.endedAt !== undefined) {
            setLiveEndedAt(data.run.endedAt)
          }
        } catch {
          // Non-fatal: ignore failed status polls
        }
      })()
    }, 5000)

    return () => clearInterval(timer)
  }, [isLive, liveStatus, runId])

  const [isEditing, setIsEditing] = useState(false)
  const [draftTags, setDraftTags] = useState<string[]>(tags ?? [])
  const [savedTags, setSavedTags] = useState<string[]>(tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function commitInput() {
    const val = tagInput.trim()
    if (!val) {
      setTagInput('')
      return
    }
    const normalized = [...new Set([...draftTags, val])]
    setDraftTags(normalized)
    setTagInput('')
  }

  function removeTag(tag: string) {
    setDraftTags((prev) => prev.filter((t) => t !== tag))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitInput()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
      setDraftTags(savedTags)
      setTagInput('')
      setErrorMsg(null)
    }
  }

  function handleSave() {
    setErrorMsg(null)
    startTransition(async () => {
      const err = await updateRunTagsAction(runId, draftTags)
      if (err) {
        setErrorMsg(err)
        // Revert to last known-good saved state on error
        setDraftTags(savedTags)
      } else {
        setSavedTags(draftTags)
        setIsEditing(false)
      }
    })
  }

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

        <Badge status={liveStatus} />
        {verificationStatus && (
          <IntegrityBadge status={verificationStatus} />
        )}
        {isLive && liveStatus === 'running' && (
          <span className="flex items-center gap-1 text-xs font-mono text-pewter">
            <span className="w-1.5 h-1.5 rounded-full bg-neon-glow animate-neon-pulse" aria-hidden="true" />
            live
          </span>
        )}

        <span className="text-xs text-neutral-500 font-mono">{truncateId(agentName, 20)}</span>

        {agentVersionLabel && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono text-neutral-500 bg-neutral-900 border border-neutral-800">
            v{agentVersionLabel}
          </span>
        )}

        <span className="text-xs text-neutral-500">{formatRelativeTime(startedAt)}</span>

        {liveEndedAt && (
          <span className="text-xs font-mono text-neutral-500">
            {formatDuration(liveEndedAt - startedAt)}
          </span>
        )}

        {triggeredBy && (
          <span className="text-xs text-pewter">
            via <span className="text-neutral-500 font-mono">{triggeredBy}</span>
          </span>
        )}
      </div>

      {/* Tags row — read or edit mode */}
      <div className="flex flex-wrap items-center gap-1.5 mt-2 min-h-[1.5rem]">
        {isEditing ? (
          <>
            {/* Draft tag chips with remove button */}
            {draftTags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-neutral-400 bg-neutral-900 border border-neutral-700"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="text-pewter hover:text-neutral-300 transition-colors"
                  aria-label={`Remove tag ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}

            {/* Tag input */}
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commitInput}
              placeholder="Add tag…"
              className="bg-transparent text-xs font-mono text-neutral-300 placeholder-neutral-500 border-b border-neutral-700 focus:border-neutral-500 outline-none w-24 py-0.5"
              autoFocus
              disabled={isPending}
            />

            {/* Save / Cancel */}
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending}
              className="text-xs font-mono text-primary-400 hover:text-primary-300 disabled:text-pewter transition-colors"
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsEditing(false)
                setDraftTags(savedTags)
                setTagInput('')
                setErrorMsg(null)
              }}
              disabled={isPending}
              className="text-xs font-mono text-pewter hover:text-cloud disabled:text-pewter transition-colors"
            >
              Cancel
            </button>

            {/* Error feedback */}
            {errorMsg && (
              <span className="text-xs text-destructive-500 font-mono">{errorMsg}</span>
            )}
          </>
        ) : (
          <>
            {/* Read-only tag chips */}
            {savedTags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono text-neutral-500 bg-neutral-900 border border-neutral-800"
              >
                {tag}
              </span>
            ))}

            {/* Edit affordance — always shown so the user can add tags even when empty */}
            <button
              type="button"
              onClick={() => {
                setDraftTags(savedTags)
                setIsEditing(true)
              }}
              className="inline-flex items-center gap-0.5 text-xs text-pewter hover:text-neutral-500 transition-colors font-mono"
              aria-label="Edit tags"
              title="Edit tags"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M7 1L9 3L3 9H1V7L7 1Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {savedTags.length === 0 ? 'Add tags' : 'Edit'}
            </button>
          </>
        )}
      </div>

      {/* Metadata — collapsible details, only when metadata has keys */}
      {metadata && Object.keys(metadata).length > 0 && (
        <details className="mt-2">
          <summary className="text-xs text-pewter cursor-pointer hover:text-neutral-500 select-none">
            Metadata ({Object.keys(metadata).length} field{Object.keys(metadata).length !== 1 ? 's' : ''})
          </summary>
          <dl className="mt-2 flex flex-col gap-1">
            {Object.entries(metadata).map(([key, value]) => (
              <div key={key} className="flex gap-3 text-xs">
                <dt className="font-mono text-pewter shrink-0 min-w-[6rem]">{key}</dt>
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
