'use client'

import { useId, useRef, useState } from 'react'

import type { FailurePatternStatus } from '@agent-flight-recorder/contracts'

import { PatternStatusBadge } from '@/components/patterns/PatternStatusBadge'
import { Button } from '@/components/ui/Button'
import { parseSafeHttpUrl } from '@/lib/utils'

interface PatternLifecycleControlProps {
  fingerprintHash: string
  status: FailurePatternStatus
  regressed: boolean
  resolutionNote?: string
  resolutionRef?: string
}

interface LifecycleFields {
  status?: FailurePatternStatus
  resolutionNote?: string
  resolutionRef?: string
  regressedAt?: number
}

interface LifecycleApiResult extends LifecycleFields {
  error?: string
}

const MAX_NOTE_LENGTH = 2000
const MAX_REF_LENGTH = 500

/** Route responds `{ pattern: FailurePattern }` (same envelope as the mute route) — read lifecycle fields off the nested pattern doc. */
function readLifecycleFields(body: Record<string, unknown>): LifecycleFields {
  const pattern = body['pattern']
  if (!pattern || typeof pattern !== 'object') return {}
  const p = pattern as Record<string, unknown>
  const rawStatus = p['status']
  return {
    ...((rawStatus === 'open' || rawStatus === 'acknowledged' || rawStatus === 'resolved') && { status: rawStatus }),
    ...(typeof p['resolutionNote'] === 'string' && { resolutionNote: p['resolutionNote'] }),
    ...(typeof p['resolutionRef'] === 'string' && { resolutionRef: p['resolutionRef'] }),
    ...(typeof p['regressedAt'] === 'number' && { regressedAt: p['regressedAt'] }),
  }
}

async function callLifecycleApi(
  fingerprintHash: string,
  action: 'acknowledge' | 'resolve' | 'reopen',
  body?: { note?: string; ref?: string },
): Promise<LifecycleApiResult> {
  // acknowledge/resolve are POST; reopen is DELETE on the resolve route (per
  // Team C's routing: /api/patterns/[fingerprint]/{acknowledge,resolve}, with
  // DELETE on `resolve` meaning "reopen" rather than a separate endpoint).
  const path = action === 'reopen' ? 'resolve' : action
  const method = action === 'reopen' ? 'DELETE' : 'POST'
  try {
    const res = await fetch(`/api/patterns/${encodeURIComponent(fingerprintHash)}/${path}`, {
      method,
      ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const message = typeof parsed['message'] === 'string' ? parsed['message'] : `Server error ${String(res.status)}`
      return {
        error:
          res.status === 403
            ? 'You no longer have permission to change this pattern’s status.'
            : message,
      }
    }
    return readLifecycleFields(parsed)
  } catch {
    return { error: 'Network error — could not reach the server' }
  }
}

/**
 * Acknowledge / Resolve / Reopen control for one failure pattern's detail
 * page (docs/adr/006-failure-resolution.md, cycle 1 of Resolution). Modeled
 * directly on `PatternMuteControl`: a client component that calls the
 * member-gated `/api/patterns/[fingerprint]/{acknowledge,resolve}` routes
 * (Team C) and only ever reconciles local state from the server's response
 * — never optimistic, so a failed call never leaves the UI claiming a
 * status the server didn't actually commit.
 *
 * Unlike muting (admin-only), acknowledge/resolve/reopen are MEMBER-gated
 * per the brief, so — unlike `PatternMuteControl` — there is no `isAdmin`
 * branch here; every org member sees live actions. A stale permission (e.g.
 * membership revoked mid-session) still surfaces honestly through the same
 * 403 -> inline-error path as any other failure.
 */
export function PatternLifecycleControl({
  fingerprintHash,
  status: initialStatus,
  regressed: initialRegressed,
  resolutionNote: initialNote,
  resolutionRef: initialRef,
}: PatternLifecycleControlProps) {
  const [status, setStatus] = useState<FailurePatternStatus>(initialStatus)
  const [regressed, setRegressed] = useState(initialRegressed)
  const [resolutionNote, setResolutionNote] = useState<string | undefined>(initialNote)
  const [resolutionRef, setResolutionRef] = useState<string | undefined>(initialRef)
  const [busy, setBusy] = useState<'acknowledge' | 'resolve' | 'reopen' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [noteInput, setNoteInput] = useState('')
  const [refInput, setRefInput] = useState('')

  const noteFieldRef = useRef<HTMLTextAreaElement>(null)
  const noteId = useId()
  const refId = useId()

  function applyResult(result: LifecycleApiResult, fallbackStatus: FailurePatternStatus) {
    setStatus(result.status ?? fallbackStatus)
    // A successful acknowledge/resolve/reopen always clears the regressed
    // flag server-side (reopen resets it explicitly; resolve/acknowledge
    // only apply from a state where it wasn't set) — but reconcile from
    // whatever the server actually echoed back rather than assuming.
    setRegressed(typeof result.regressedAt === 'number' && (result.status ?? fallbackStatus) === 'open')
    setResolutionNote(result.resolutionNote)
    setResolutionRef(result.resolutionRef)
  }

  async function acknowledge() {
    setBusy('acknowledge')
    setError(null)
    const result = await callLifecycleApi(fingerprintHash, 'acknowledge')
    setBusy(null)
    if (result.error) {
      setError(result.error)
      return
    }
    applyResult(result, 'acknowledged')
  }

  async function reopen() {
    setBusy('reopen')
    setError(null)
    const result = await callLifecycleApi(fingerprintHash, 'reopen')
    setBusy(null)
    if (result.error) {
      setError(result.error)
      return
    }
    applyResult(result, 'open')
    setFormOpen(false)
  }

  function openResolveForm() {
    setError(null)
    setNoteInput('')
    setRefInput('')
    setFormOpen(true)
    // Focus the note field once the form mounts — keyboard users land
    // directly in the first field instead of having to tab past the button.
    requestAnimationFrame(() => noteFieldRef.current?.focus())
  }

  function closeResolveForm() {
    setFormOpen(false)
    setError(null)
  }

  async function submitResolve() {
    setBusy('resolve')
    setError(null)
    const note = noteInput.trim()
    const ref = refInput.trim()
    const result = await callLifecycleApi(fingerprintHash, 'resolve', {
      ...(note && { note }),
      ...(ref && { ref }),
    })
    setBusy(null)
    if (result.error) {
      setError(result.error)
      return
    }
    applyResult(result, 'resolved')
    setFormOpen(false)
  }

  const isBusy = busy !== null

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <PatternStatusBadge status={status} regressed={regressed} />
        {status === 'open' && !formOpen && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void acknowledge()
              }}
              disabled={isBusy}
              aria-busy={busy === 'acknowledge'}
            >
              {busy === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={openResolveForm} disabled={isBusy}>
              Resolve
            </Button>
          </>
        )}
        {status === 'acknowledged' && !formOpen && (
          <Button type="button" variant="secondary" size="sm" onClick={openResolveForm} disabled={isBusy}>
            Resolve
          </Button>
        )}
        {status === 'resolved' && !formOpen && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void reopen()
            }}
            disabled={isBusy}
            aria-busy={busy === 'reopen'}
          >
            {busy === 'reopen' ? 'Reopening…' : 'Reopen'}
          </Button>
        )}
      </div>

      {/* Live echo of the note/ref just submitted by THIS control, so a
          successful resolve is visibly confirmed without a page reload —
          the fuller "Resolution" section elsewhere on the detail page
          (acknowledged/resolved-by, full note) is server-rendered from the
          page's initial fetch and catches up on next navigation, same as
          PatternMuteControl's relationship to the page's other mute-state
          reads. Never dangerouslySetInnerHTML; the ref is only ever an <a>
          when it parses as http(s) (see parseSafeHttpUrl), otherwise plain
          text. */}
      {status === 'resolved' && !formOpen && (resolutionNote ?? resolutionRef) && (
        <div className="flex flex-col items-end gap-1 max-w-[280px] text-right">
          {resolutionNote && <p className="text-xs text-neutral-300 leading-relaxed">{resolutionNote}</p>}
          {resolutionRef &&
            (() => {
              const url = parseSafeHttpUrl(resolutionRef)
              return url ? (
                <a
                  href={url.toString()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-neon-glow hover:underline break-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
                >
                  {resolutionRef}
                </a>
              ) : (
                <span className="font-mono text-xs text-pewter break-all">{resolutionRef}</span>
              )
            })()}
        </div>
      )}

      {formOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submitResolve()
          }}
          className="flex flex-col gap-2 w-[280px] rounded-[4px] border border-graphite-light bg-graphite-deep p-3"
          aria-label="Resolve this failure pattern"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={noteId} className="text-xs text-pewter">
              Resolution note <span className="text-pewter">(optional)</span>
            </label>
            <textarea
              ref={noteFieldRef}
              id={noteId}
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value.slice(0, MAX_NOTE_LENGTH))}
              maxLength={MAX_NOTE_LENGTH}
              rows={3}
              placeholder="How was this fixed?"
              disabled={isBusy}
              className="bg-blackout text-sm text-whiteout placeholder-pewter border border-graphite-light rounded-[4px] px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-neon-glow resize-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={refId} className="text-xs text-pewter">
              Reference <span className="text-pewter">(optional — a PR/version link or ID)</span>
            </label>
            <input
              id={refId}
              type="text"
              value={refInput}
              onChange={(e) => setRefInput(e.target.value.slice(0, MAX_REF_LENGTH))}
              maxLength={MAX_REF_LENGTH}
              placeholder="https://... or a version id"
              disabled={isBusy}
              className="bg-blackout text-sm text-whiteout placeholder-pewter border border-graphite-light rounded-[4px] px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-neon-glow"
            />
          </div>
          <div className="flex items-center justify-end gap-2 mt-1">
            <Button type="button" variant="ghost" size="sm" onClick={closeResolveForm} disabled={isBusy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={isBusy} aria-busy={busy === 'resolve'}>
              {busy === 'resolve' ? 'Resolving…' : 'Mark resolved'}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <span role="alert" className="text-xs text-destructive-500 font-mono text-right max-w-[280px]">
          {error}
        </span>
      )}
    </div>
  )
}
