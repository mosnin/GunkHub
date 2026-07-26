'use client'

import { useState } from 'react'

import type { RunTriageState } from '@agent-flight-recorder/contracts'

import { TriageChip } from '@/components/runs/RunMetaChips'

interface TriageControlProps {
  runId: string
  triageState: RunTriageState
  labels: string[]
  /** Only failed/timed_out runs may be triaged — matches the Convex invariant. */
  eligible: boolean
}

// Linear workflow: open -> investigating -> resolved, plus any -> open (reopen).
const NEXT_STATE: Record<RunTriageState, RunTriageState | null> = {
  open: 'investigating',
  investigating: 'resolved',
  resolved: null,
}

async function patchTriage(runId: string, body: Record<string, unknown>): Promise<{ run?: unknown; error?: string }> {
  try {
    const res = await fetch(`/api/runs/${runId}/triage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string }
      return { error: errBody.message ?? `Server error ${res.status}` }
    }
    return { run: await res.json() }
  } catch {
    return { error: 'Network error — could not reach the server' }
  }
}

/**
 * Triage state + labels editor for a failed/timed_out run — /api/runs/[id]/triage.
 * Enforces the same linear workflow client-side as the Convex mutation
 * (open -> investigating -> resolved, or reopen from anywhere) so the button
 * never offers an illegal transition.
 */
export function TriageControl({ runId, triageState: initial, labels: initialLabels, eligible }: TriageControlProps) {
  const [triageState, setTriageState] = useState<RunTriageState>(initial)
  const [labels, setLabels] = useState<string[]>(initialLabels)
  const [labelInput, setLabelInput] = useState('')
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!eligible) {
    return (
      <div className="flex items-center gap-2">
        <TriageChip triageState={triageState} />
        {labels.map((l) => (
          <span
            key={l}
            className="inline-flex items-center px-1.5 py-0.5 rounded-[4px] text-xs font-mono text-neutral-400 bg-neutral-900 border border-neutral-700"
          >
            {l}
          </span>
        ))}
      </div>
    )
  }

  async function advance() {
    const next = NEXT_STATE[triageState]
    if (!next) return
    setIsPending(true)
    setError(null)
    const { error: err } = await patchTriage(runId, { triageState: next })
    setIsPending(false)
    if (err) setError(err)
    else setTriageState(next)
  }

  async function reopen() {
    setIsPending(true)
    setError(null)
    const { error: err } = await patchTriage(runId, { triageState: 'open' })
    setIsPending(false)
    if (err) setError(err)
    else setTriageState('open')
  }

  async function commitLabels(next: string[]) {
    setIsPending(true)
    setError(null)
    const { error: err } = await patchTriage(runId, { labels: next })
    setIsPending(false)
    if (err) setError(err)
    else setLabels(next)
  }

  function addLabel() {
    const val = labelInput.trim()
    if (!val || labels.includes(val)) {
      setLabelInput('')
      return
    }
    setLabelInput('')
    void commitLabels([...labels, val])
  }

  function removeLabel(label: string) {
    void commitLabels(labels.filter((l) => l !== label))
  }

  const next = NEXT_STATE[triageState]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <TriageChip triageState={triageState} />

        {next && (
          <button
            type="button"
            onClick={() => { void advance() }}
            disabled={isPending}
            className="text-xs font-mono text-primary-400 hover:text-primary-300 disabled:text-pewter transition-colors"
          >
            {isPending ? 'Updating…' : `Mark ${next.replace('_', ' ')}`}
          </button>
        )}
        {triageState !== 'open' && (
          <button
            type="button"
            onClick={() => { void reopen() }}
            disabled={isPending}
            className="text-xs font-mono text-pewter hover:text-cloud disabled:text-pewter transition-colors"
          >
            Reopen
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {labels.map((label) => (
          <span
            key={label}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-neutral-400 bg-neutral-900 border border-neutral-700"
          >
            {label}
            <button
              type="button"
              onClick={() => removeLabel(label)}
              disabled={isPending}
              className="text-pewter hover:text-neutral-300 transition-colors"
              aria-label={`Remove label ${label}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              addLabel()
            }
          }}
          onBlur={addLabel}
          placeholder="Add label…"
          aria-label="Add triage label"
          disabled={isPending}
          className="bg-transparent text-xs font-mono text-neutral-300 placeholder-neutral-500 border-b border-neutral-700 focus:border-neutral-500 outline-none w-24 py-0.5"
        />
      </div>

      {error && (
        <span role="alert" className="text-xs text-destructive-500 font-mono">
          {error}
        </span>
      )}
    </div>
  )
}
