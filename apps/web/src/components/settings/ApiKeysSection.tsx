'use client'

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

// Warning thresholds for the lifecycle UX (task spec): a key is flagged when it
// expires within 14 days, or has gone unused (or never been used) for 30+ days.
const EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000
const STALE_UNUSED_MS = 30 * 24 * 60 * 60 * 1000

interface ApiKey {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  scopes: string[] | null
}

interface GenerateResult {
  id: string
  name: string
  key: string
  createdAt: number
  expiresAt?: number
  scopes?: string[]
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Human-readable rotated-key name suffix: `-rotated-YYYYMMDD`. */
function rotatedName(name: string): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${name}-rotated-${String(yyyy)}${mm}${dd}`
}

interface KeyWarning {
  level: 'expired' | 'expiring' | 'stale' | null
  message: string | null
}

/** Computes the lifecycle warning (if any) for a single key, per the task's
 * 14-day-expiring / 30-day-unused thresholds. Destructive-toned dot + pewter
 * note is the sanctioned treatment (design.md: no new colors, warn dot only). */
function getKeyWarning(key: ApiKey, now: number): KeyWarning {
  if (key.expiresAt !== null && key.expiresAt <= now) {
    return { level: 'expired', message: 'Expired — this key is rejected by ingest.' }
  }
  if (key.expiresAt !== null && key.expiresAt - now <= EXPIRING_SOON_MS) {
    const days = Math.max(0, Math.ceil((key.expiresAt - now) / (24 * 60 * 60 * 1000)))
    return { level: 'expiring', message: `Expires in ${String(days)} day${days === 1 ? '' : 's'}.` }
  }
  const lastActivity = key.lastUsedAt ?? key.createdAt
  if (now - lastActivity >= STALE_UNUSED_MS) {
    return {
      level: 'stale',
      message: key.lastUsedAt === null ? 'Never used since creation.' : 'Unused for 30+ days.',
    }
  }
  return { level: null, message: null }
}

/** The scopes the backend accepts (`/api/api-keys` POST validates against
 * this same set — see `lib/apiKeyScopes.ts`'s `ALLOWED_KEY_SCOPES`). Ingest
 * is for the SDK (writing runs/events); Read is for the v1 read API and the
 * `afr` CLI. A key with neither scope selected is created with no explicit
 * `scopes` field, which defaults server-side to `["ingest:write"]`. */
const SCOPE_OPTIONS = [
  { value: 'ingest:write', label: 'Ingest (write)', help: 'Used by the SDK to record runs and events.' },
  { value: 'read', label: 'Read', help: 'Used by the v1 read API and the afr CLI.' },
] as const

function ScopeChips({ scopes }: { scopes: string[] | null }) {
  if (!scopes || scopes.length === 0) {
    return <span className="text-xs text-pewter font-mono">full access</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <span
          key={s}
          className="inline-flex items-center px-1.5 py-0.5 rounded-[4px] text-xs font-mono text-cloud bg-graphite border border-graphite-light"
        >
          {s === 'ingest:write' ? 'ingest' : s === 'ingest:read' ? 'ingest-read' : s === 'read' ? 'read' : s}
        </span>
      ))}
    </div>
  )
}

function NewKeyModal({
  result,
  isRotation,
  oldKeyName,
  onClose,
}: {
  result: GenerateResult
  isRotation: boolean
  oldKeyName: string | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const dialogRef = useFocusTrap<HTMLDivElement>(true)

  function handleCopy() {
    void navigator.clipboard.writeText(result.key).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-key-title"
        tabIndex={-1}
        className="bg-graphite-deep border border-graphite-light rounded-[4px] shadow-lg w-full max-w-md mx-4 outline-none"
      >
        <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between">
          <h3 id="new-key-title" className="text-sm font-semibold text-neutral-100">
            {isRotation ? 'Replacement Key Created' : 'API Key Created'}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-pewter hover:text-cloud transition-colors duration-100"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-start gap-2 bg-destructive-900/40 border border-destructive-700/60 rounded-[4px] px-3 py-2.5">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="text-destructive-400 shrink-0 mt-0.5">
              <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M6.68 2.5L1.5 11a1.5 1.5 0 001.32 2.25h10.36A1.5 1.5 0 0014.5 11L9.32 2.5a1.5 1.5 0 00-2.64 0z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <p className="text-xs text-destructive-400 leading-relaxed">
              This key is shown <strong>only once</strong>. Copy it now and store it securely. You cannot retrieve it again.
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-neutral-400 mb-1.5 uppercase tracking-wider">
              {isRotation ? 'Replacement API Key' : 'Your API Key'}
            </p>
            <CodeBlock content={result.key} maxHeight="60px" />
          </div>

          {isRotation && (
            <div className="rounded-[4px] border border-graphite-light bg-graphite px-3 py-2.5">
              <p className="text-xs text-cloud leading-relaxed">
                Update the consumers using{' '}
                <span className="font-mono text-neutral-300">{oldKeyName}</span> to this new key
                first. Once traffic has moved over, come back and{' '}
                <strong className="text-whiteout">revoke the old key</strong> below — rotation
                does not revoke it automatically, so both keys work until you do.
              </p>
            </div>
          )}

          <Button
            variant={copied ? 'ghost' : 'primary'}
            onClick={handleCopy}
            className="w-full"
          >
            {copied ? 'Copied!' : 'Copy to clipboard'}
          </Button>
        </div>

        <div className="px-5 py-3 border-t border-neutral-800">
          <Button variant="secondary" onClick={onClose} className="w-full">
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

interface RevokeButtonProps {
  keyId: string
  onRevoked: (id: string) => void
}

function RevokeButton({ keyId, onRevoked }: RevokeButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Reset confirming state on Escape or click outside
  useEffect(() => {
    if (!confirming) return

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setConfirming(false)
    }
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setConfirming(false)
      }
    }

    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClickOutside)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClickOutside)
    }
  }, [confirming])

  async function handleRevoke() {
    setRevoking(true)
    setError(null)
    try {
      const res = await fetch(`/api/api-keys/${keyId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string }
        throw new Error(body.message ?? `Server error ${res.status}`)
      }
      onRevoked(keyId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key')
      setConfirming(false)
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div ref={containerRef} className="flex flex-col items-end gap-1">
      {confirming ? (
        <button
          onClick={() => { void handleRevoke() }}
          disabled={revoking}
          className="text-xs text-destructive-400 hover:text-destructive-500 disabled:opacity-40 disabled:pointer-events-none transition-colors duration-100"
        >
          {revoking ? 'Revoking…' : 'Confirm?'}
        </button>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="text-xs text-neutral-400 hover:text-neutral-300 transition-colors duration-100"
        >
          Revoke
        </button>
      )}
      {error && <span className="text-destructive-400 text-xs">{error}</span>}
    </div>
  )
}

interface ApiKeysSectionProps {
  initialKeys: ApiKey[]
  loadError: string | null
}

export function ApiKeysSection({ initialKeys, loadError }: ApiKeysSectionProps) {
  // Initial list is server-rendered and passed in as a prop — no client-side
  // useEffect fetch (forbidden pattern). Mutations still update this state locally.
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys)
  const [keyName, setKeyName] = useState('')
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['ingest:write'])
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState<GenerateResult | null>(null)
  const [rotatingId, setRotatingId] = useState<string | null>(null)
  const [rotateError, setRotateError] = useState<string | null>(null)
  const [isRotationResult, setIsRotationResult] = useState(false)
  const [rotationSourceName, setRotationSourceName] = useState<string | null>(null)
  const fetchError = loadError
  const now = Date.now()

  async function createKey(body: Record<string, unknown>): Promise<GenerateResult> {
    const res = await fetch('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as { message?: string }
      throw new Error(errBody.message ?? `Server error ${res.status}`)
    }
    return (await res.json()) as GenerateResult
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenerateError(null)
    try {
      const data = await createKey({
        name: keyName.trim(),
        ...(selectedScopes.length > 0 && { scopes: selectedScopes }),
      })
      setIsRotationResult(false)
      setRotationSourceName(null)
      setNewKey(data)
      setKeys((prev) => [
        {
          id: data.id,
          name: data.name,
          createdAt: data.createdAt,
          lastUsedAt: null,
          expiresAt: data.expiresAt ?? null,
          scopes: data.scopes ?? null,
        },
        ...prev,
      ])
      setKeyName('')
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate key')
    } finally {
      setGenerating(false)
    }
  }

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    )
  }

  /**
   * Rotate = create a replacement key with the same name (suffixed
   * `-rotated-YYYYMMDD`) and the same scopes as the source key, shown once via
   * the same NewKeyModal. No silent auto-revoke of the source key — a human
   * must click Revoke on the old row after moving consumers over.
   */
  async function handleRotate(key: ApiKey) {
    setRotatingId(key.id)
    setRotateError(null)
    try {
      const data = await createKey({
        name: rotatedName(key.name),
        ...(key.scopes !== null && { scopes: key.scopes }),
      })
      setIsRotationResult(true)
      setRotationSourceName(key.name)
      setNewKey(data)
      setKeys((prev) => [
        {
          id: data.id,
          name: data.name,
          createdAt: data.createdAt,
          lastUsedAt: null,
          expiresAt: data.expiresAt ?? null,
          scopes: data.scopes ?? null,
        },
        ...prev,
      ])
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : 'Failed to rotate key')
    } finally {
      setRotatingId(null)
    }
  }

  function handleRevoked(id: string) {
    setKeys((prev) => prev.filter((k) => k.id !== id))
  }

  return (
    <>
      {newKey && (
        <NewKeyModal
          result={newKey}
          isRotation={isRotationResult}
          oldKeyName={rotationSourceName}
          onClose={() => setNewKey(null)}
        />
      )}

      <Card>
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">API Keys</h2>
          <p className="mt-0.5 text-xs text-neutral-400">
            Used to authenticate the SDK when recording runs.
          </p>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          {/* Key name input + scope picker + generate button */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="Key name (e.g. production)"
                aria-label="Key name"
                className="flex-1 max-w-xs bg-neutral-900 border border-neutral-700 text-neutral-200 text-sm px-3 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-neon-glow placeholder-neutral-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && keyName.trim() && !generating) {
                    void handleGenerate()
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => { void handleGenerate() }}
                disabled={generating || keyName.trim().length === 0}
              >
                {generating ? 'Generating…' : 'Generate new key'}
              </Button>
            </div>

            <fieldset className="flex flex-wrap items-start gap-4">
              <legend className="text-xs font-medium text-pewter uppercase tracking-wider mb-1 w-full">
                Scopes
              </legend>
              {SCOPE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-start gap-1.5 text-xs text-cloud cursor-pointer max-w-[220px]"
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(opt.value)}
                    onChange={() => toggleScope(opt.value)}
                    className="mt-0.5 accent-neon-glow"
                  />
                  <span>
                    <span className="text-whiteout font-medium">{opt.label}</span>
                    <span className="block text-pewter">{opt.help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {selectedScopes.length === 0 && (
              <p className="text-xs text-pewter">
                No scope selected — the key will default to full access. Prefer selecting Ingest
                and/or Read explicitly for least-privilege keys.
              </p>
            )}
          </div>

          {generateError && (
            <p className="text-destructive-400 text-sm">{generateError}</p>
          )}
          {rotateError && (
            <p className="text-destructive-400 text-sm">{rotateError}</p>
          )}

          {/* Key list */}
          {fetchError ? (
            <p className="text-destructive-400 text-sm">{fetchError}</p>
          ) : keys.length === 0 ? (
            <p className="text-sm text-neutral-400">
              No API keys yet. Enter a name above and generate one to start recording runs.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-neutral-800">
              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="border-b border-neutral-800 bg-neutral-900">
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider w-1/4">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider w-1/6">
                      Created
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider w-1/6">
                      Expires
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider w-1/6">
                      Last used
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider w-1/6">
                      Scopes
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-neutral-400 uppercase tracking-wider w-1/4">
                      {/* Actions column */}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                  {keys.map((k) => {
                    const warning = getKeyWarning(k, now)
                    return (
                      <tr key={k.id}>
                        <td className="px-4 py-3 text-sm text-neutral-300 align-top">
                          <div className="truncate" title={k.name}>{k.name}</div>
                          {warning.message && (
                            <div className="mt-1 flex items-center gap-1.5">
                              <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  warning.level === 'expired'
                                    ? 'bg-destructive-500 shadow-[var(--shadow-glow-warn)]'
                                    : warning.level === 'expiring'
                                      ? 'bg-destructive-500'
                                      : 'bg-pewter'
                                }`}
                                aria-hidden="true"
                              />
                              <span className="text-xs text-pewter">{warning.message}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-neutral-400 align-top">
                          {formatDate(k.createdAt)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-neutral-400 align-top">
                          {k.expiresAt ? formatDate(k.expiresAt) : 'Never'}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-neutral-400 align-top">
                          {k.lastUsedAt ? formatDate(k.lastUsedAt) : 'Never'}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <ScopeChips scopes={k.scopes} />
                        </td>
                        <td className="px-4 py-3 text-right align-top">
                          <div className="flex items-center justify-end gap-3">
                            <button
                              onClick={() => { void handleRotate(k) }}
                              disabled={rotatingId === k.id}
                              className="text-xs text-neutral-400 hover:text-neutral-300 disabled:opacity-40 disabled:pointer-events-none transition-colors duration-100"
                              title="Create a replacement key with the same scopes"
                            >
                              {rotatingId === k.id ? 'Rotating…' : 'Rotate'}
                            </button>
                            <RevokeButton keyId={k.id} onRevoked={handleRevoked} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </>
  )
}
