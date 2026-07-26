'use client'

import { useState } from 'react'

import { MutedBadge } from '@/components/patterns/MutedBadge'
import { Button } from '@/components/ui/Button'

interface PatternMuteControlProps {
  fingerprintHash: string
  muted: boolean
  mutedAt?: number
  /**
   * Resolved server-side from `getCurrentAuth().orgRole === 'admin'` by the
   * detail page — mirrors `AlertsSection`'s `isAdmin` prop. Muting is
   * admin-gated in the mute route itself (Team C); this flag lets a
   * non-admin see an honest, non-actionable explanation instead of a button
   * that would 403 on click. A stale/incorrect flag (e.g. a role change
   * mid-session) is still safe — the server re-checks on every request and
   * the resulting 403 surfaces through the same error path as any other
   * failed call, it just isn't the expected path.
   */
  isAdmin: boolean
}

interface MuteApiResult {
  muted?: boolean
  mutedAt?: number
  error?: string
}

/** Route responds `{ pattern: FailurePattern }` (mirrors PUT /api/alerts/[id]'s `{ rule }` shape) — read `muted`/`mutedAt` off the nested pattern doc, not the response body directly. */
function readPatternFields(body: Record<string, unknown>): { muted?: boolean; mutedAt?: number } {
  const pattern = body['pattern']
  if (!pattern || typeof pattern !== 'object') return {}
  const p = pattern as Record<string, unknown>
  return {
    ...(typeof p['muted'] === 'boolean' && { muted: p['muted'] }),
    ...(typeof p['mutedAt'] === 'number' && { mutedAt: p['mutedAt'] }),
  }
}

async function callMuteApi(fingerprintHash: string, method: 'POST' | 'DELETE'): Promise<MuteApiResult> {
  try {
    const res = await fetch(`/api/patterns/${encodeURIComponent(fingerprintHash)}/mute`, { method })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const message = typeof body['message'] === 'string' ? body['message'] : `Server error ${String(res.status)}`
      // A 403 here means the server disagrees with the `isAdmin` flag this
      // component was rendered with (stale role, revoked admin mid-session,
      // etc.) — surfaced as the same honest inline error as any other
      // failure, not silently swallowed and not assumed to have succeeded.
      return { error: res.status === 403 ? 'Admin only — you no longer have permission to change this.' : message }
    }
    const fields = readPatternFields(body)
    return {
      muted: fields.muted ?? method === 'POST',
      ...(fields.mutedAt !== undefined && { mutedAt: fields.mutedAt }),
    }
  } catch {
    return { error: 'Network error — could not reach the server' }
  }
}

/**
 * Mute/unmute control for one failure pattern's detail page (cycle 3). A
 * pill button that calls the admin-gated `POST`/`DELETE
 * /api/patterns/[fingerprint]/mute` route, then reconciles local state from
 * the server's response (mirrors TriageControl's "await, then set state from
 * the response" pattern — never optimistic, so a failed call never leaves
 * the UI showing a state the server didn't actually commit).
 *
 * Non-admins get the same honest, non-actionable treatment as
 * `AlertsSection` for admin-only rule configuration: no button that would
 * just 403, an explanatory sentence instead. The muted state itself (the
 * `MutedBadge`) is still shown to non-admins — visibility of "alerts are
 * muted" is not an admin-only fact, only the ability to change it is.
 */
export function PatternMuteControl({ fingerprintHash, muted: initialMuted, mutedAt: initialMutedAt, isAdmin }: PatternMuteControlProps) {
  const [muted, setMuted] = useState(initialMuted)
  const [mutedAt, setMutedAt] = useState<number | undefined>(initialMutedAt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    setBusy(true)
    setError(null)
    const result = await callMuteApi(fingerprintHash, muted ? 'DELETE' : 'POST')
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setMuted(result.muted ?? !muted)
    setMutedAt(result.mutedAt)
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {muted && <MutedBadge mutedAt={mutedAt} />}
        <p className="text-xs text-pewter text-right max-w-[220px]">
          Muting alerts for this pattern is admin-only. Ask an org admin to {muted ? 'unmute' : 'mute'} it.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {muted && <MutedBadge mutedAt={mutedAt} />}
        <Button
          type="button"
          variant={muted ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => {
            void toggle()
          }}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? (muted ? 'Unmuting…' : 'Muting…') : muted ? 'Unmute' : 'Mute alerts'}
        </Button>
      </div>
      {error && (
        <span role="alert" className="text-xs text-destructive-500 font-mono text-right max-w-[220px]">
          {error}
        </span>
      )}
    </div>
  )
}
