'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

interface RetentionSectionProps {
  initialRetentionDays: number | null
  isAdmin: boolean
  loadError: string | null
}

function policyLabel(retentionDays: number | null): string {
  return retentionDays === null
    ? 'Runs are retained forever.'
    : `Terminal runs older than ${retentionDays} day${retentionDays === 1 ? '' : 's'} are deleted daily.`
}

export function RetentionSection({
  initialRetentionDays,
  isAdmin,
  loadError,
}: RetentionSectionProps) {
  const [retentionDays, setRetentionDays] = useState<number | null>(initialRetentionDays)
  const [draft, setDraft] = useState<string>(
    initialRetentionDays === null ? '' : String(initialRetentionDays),
  )
  const [confirming, setConfirming] = useState<'set' | 'clear' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const trimmed = draft.trim()
  const parsed = trimmed.length > 0 ? Number(trimmed) : null
  const validationError =
    trimmed.length > 0 &&
    (!Number.isInteger(parsed) || (parsed as number) < 1 || (parsed as number) > 3650)
      ? 'Enter a whole number of days between 1 and 3650.'
      : null

  const isClearing = trimmed.length === 0
  const dirty = isClearing ? retentionDays !== null : parsed !== retentionDays

  async function submit() {
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const body = isClearing ? { retentionDays: null } : { retentionDays: parsed }
      const res = await fetch('/api/org/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string }
        throw new Error(payload.message ?? `Server error ${res.status}`)
      }
      const data = (await res.json()) as { retentionDays: number | null }
      setRetentionDays(data.retentionDays)
      setDraft(data.retentionDays === null ? '' : String(data.retentionDays))
      setSuccess(
        data.retentionDays === null
          ? 'Retention window cleared. Runs are now retained forever.'
          : `Retention window set to ${data.retentionDays} days. Eligible runs older than this will be deleted on the next daily sweep.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update retention policy')
    } finally {
      setSaving(false)
      setConfirming(null)
    }
  }

  function requestSave() {
    if (validationError !== null || !dirty) return
    setSuccess(null)
    setError(null)
    setConfirming(isClearing ? 'clear' : 'set')
  }

  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">Data Retention</h2>
        <p className="mt-0.5 text-xs text-neutral-400">
          Controls how long terminal (completed, failed, cancelled, timed out) runs are
          kept. In-progress runs are never deleted by this policy.
        </p>
      </div>

      <div className="px-5 py-4 flex flex-col gap-4">
        {loadError ? (
          <p role="alert" className="text-destructive-400 text-sm">
            {loadError}
          </p>
        ) : (
          <p className="font-mono text-sm text-neutral-300">{policyLabel(retentionDays)}</p>
        )}

        {!isAdmin && (
          <p className="text-xs text-pewter">
            Only org admins can change the retention policy. Ask an admin if you need this
            changed.
          </p>
        )}

        {isAdmin && !loadError && (
          <>
            <div className="flex items-end gap-2">
              <div>
                <label
                  className="block text-xs font-medium text-pewter mb-1.5"
                  htmlFor="retention-days"
                >
                  Retention window (days)
                </label>
                <input
                  id="retention-days"
                  type="text"
                  inputMode="numeric"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setConfirming(null)
                    setSuccess(null)
                    setError(null)
                  }}
                  placeholder="Leave blank to retain forever"
                  className="w-64 h-9 px-3 rounded-[4px] bg-neutral-900 border border-neutral-700 font-mono text-sm text-neutral-200 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-neon-glow"
                />
              </div>
              <Button
                variant={isClearing ? 'destructive' : 'primary'}
                size="sm"
                disabled={!!validationError || !dirty || saving}
                onClick={requestSave}
              >
                {isClearing ? 'Clear window' : 'Save'}
              </Button>
            </div>

            {validationError && (
              <p role="alert" className="text-destructive-400 text-xs">
                {validationError}
              </p>
            )}

            {confirming && (
              <div className="flex items-start gap-2 bg-destructive-900/40 border border-destructive-700/60 rounded-[4px] px-3 py-2.5">
                <span
                  className="w-1.5 h-1.5 rounded-full bg-destructive-500 shrink-0 mt-1"
                  aria-hidden="true"
                />
                <div className="flex flex-col gap-2 flex-1">
                  <p className="text-xs text-destructive-400 leading-relaxed">
                    {confirming === 'clear'
                      ? 'This disables the retention window — no further scheduled deletions will occur, but data already deleted cannot be recovered.'
                      : `This will permanently delete terminal runs (and their events, artifacts, comments) older than ${String(parsed)} days, starting with the next daily sweep. This cannot be undone.`}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={saving}
                      onClick={() => {
                        void submit()
                      }}
                    >
                      {saving ? 'Saving…' : 'Confirm'}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={saving} onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="text-destructive-400 text-sm">
                {error}
              </p>
            )}
            {success && (
              <p role="alert" className="text-neon-glow text-sm">
                {success}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
