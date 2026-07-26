'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/Button'

/**
 * SWITCH A POLICY ON OR OFF. ADMIN-gated and audited server-side.
 *
 * ===========================================================================
 * THE REASON IS REQUIRED IN THE UI BECAUSE IT IS REQUIRED IN THE AUDIT LOG
 * ===========================================================================
 *
 * `convex/policies.ts`'s `disablePolicy` writes it to the append-only admin
 * audit log (CLAUDE.md Event Log Rule 6), and there is no default anywhere in
 * the stack. A prefilled "disabled from the UI" would be a row that records that
 * a control was switched off and not why — which is the only thing anybody reads
 * that row for.
 *
 * THIS IS AN AFFORDANCE, NOT A CONTROL. Convex enforces the admin gate; a
 * rendered button is a courtesy. Nothing here re-checks the role, because a
 * duplicated check is a check that can disagree with the one nearest the data.
 *
 * THERE IS NO DELETE BUTTON, HERE OR ANYWHERE. A policy that governed recorded
 * runs is part of how those runs were judged, and removing the row would leave
 * every past outcome pointing at a revision of nothing.
 */
interface PolicyEnableToggleProps {
  policyId: string
  enabled: boolean
}

export function PolicyEnableToggle({ policyId, enabled }: PolicyEnableToggleProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const verb = enabled ? 'Switch off' : 'Put back in force'

  async function submit(): Promise<void> {
    setError(null)
    setPending(true)
    try {
      const res = await fetch(`/api/policies/${policyId}/disable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled, reason }),
      })
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null)
        const message =
          body !== null && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
            ? (body as { message: string }).message
            : `The request failed with status ${res.status}.`
        // SURFACED, NEVER SWALLOWED. A failed switch-off that looks like it
        // worked leaves an operator believing a control is off while their runs
        // are still graded against it.
        setError(message)
        return
      }
      setOpen(false)
      setReason('')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The request could not be sent.')
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {verb}
      </Button>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-[4px] border border-graphite-light bg-graphite p-3">
      <label className="text-xs font-mono uppercase tracking-wider text-pewter" htmlFor={`reason-${policyId}`}>
        Reason (written to the admin audit log, required)
      </label>
      <input
        id={`reason-${policyId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="rounded-[4px] border border-graphite-light bg-graphite-deep px-2 py-1 text-sm font-mono text-whiteout"
        placeholder="e.g. the tool was renamed; superseded by pol_12"
      />
      {error === null ? null : (
        <p className="text-sm text-ember leading-relaxed">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending || reason.length === 0} onClick={() => void submit()}>
          {pending ? 'Recording…' : verb}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
