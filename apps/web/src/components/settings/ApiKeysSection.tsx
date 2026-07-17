'use client'

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'

interface ApiKey {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
}

interface GenerateResult {
  id: string
  name: string
  key: string
  createdAt: number
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function NewKeyModal({ result, onClose }: { result: GenerateResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

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
      <div className="bg-graphite-deep border border-graphite-light rounded-[4px] w-full max-w-md mx-4">
        <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-100">API Key Created</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-600 hover:text-neutral-400 transition-colors duration-100"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-start gap-2 bg-amber-950/50 border border-amber-800 rounded-md px-3 py-2.5">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="text-amber-400 shrink-0 mt-0.5">
              <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M6.68 2.5L1.5 11a1.5 1.5 0 001.32 2.25h10.36A1.5 1.5 0 0014.5 11L9.32 2.5a1.5 1.5 0 00-2.64 0z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <p className="text-xs text-amber-300 leading-relaxed">
              This key is shown <strong>only once</strong>. Copy it now and store it securely. You cannot retrieve it again.
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-neutral-500 mb-1.5 uppercase tracking-wider">Your API Key</p>
            <CodeBlock content={result.key} maxHeight="60px" />
          </div>

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
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 disabled:pointer-events-none transition-colors duration-100"
        >
          {revoking ? 'Revoking…' : 'Confirm?'}
        </button>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors duration-100"
        >
          Revoke
        </button>
      )}
      {error && <span className="text-red-400 text-xs">{error}</span>}
    </div>
  )
}

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [keyName, setKeyName] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState<GenerateResult | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setFetchError(null)
      try {
        const res = await fetch('/api/api-keys')
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { message?: string }
          throw new Error(body.message ?? `Server error ${res.status}`)
        }
        const data = await res.json() as { keys: ApiKey[] }
        if (!cancelled) setKeys(data.keys)
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : 'Failed to load keys')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [])

  async function handleGenerate() {
    setGenerating(true)
    setGenerateError(null)
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: keyName.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string }
        throw new Error(body.message ?? `Server error ${res.status}`)
      }
      const data = await res.json() as GenerateResult
      setNewKey(data)
      setKeys((prev) => [
        { id: data.id, name: data.name, createdAt: data.createdAt, lastUsedAt: null },
        ...prev,
      ])
      setKeyName('')
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate key')
    } finally {
      setGenerating(false)
    }
  }

  function handleRevoked(id: string) {
    setKeys((prev) => prev.filter((k) => k.id !== id))
  }

  return (
    <>
      {newKey && (
        <NewKeyModal result={newKey} onClose={() => setNewKey(null)} />
      )}

      <Card>
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">API Keys</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Used to authenticate the SDK when recording runs.
          </p>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          {/* Key name input + generate button */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Key name (e.g. production)"
              className="flex-1 max-w-xs bg-neutral-900 border border-neutral-700 text-neutral-200 text-sm px-3 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-neutral-500 placeholder-neutral-600"
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

          {generateError && (
            <p className="text-red-400 text-sm">{generateError}</p>
          )}

          {/* Key list */}
          {loading ? (
            <p className="text-sm text-neutral-500">Loading keys…</p>
          ) : fetchError ? (
            <p className="text-red-400 text-sm">{fetchError}</p>
          ) : keys.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No API keys yet. Enter a name above and generate one to start recording runs.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-neutral-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-800 bg-neutral-900">
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider w-1/3">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider w-1/4">
                      Created
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider w-1/4">
                      Last used
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-neutral-500 uppercase tracking-wider w-1/6">
                      {/* Revoke column */}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                  {keys.map((k) => (
                    <tr key={k.id}>
                      <td className="px-4 py-3 text-sm text-neutral-300">{k.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-neutral-400">
                        {formatDate(k.createdAt)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                        {k.lastUsedAt ? formatDate(k.lastUsedAt) : 'Never'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <RevokeButton keyId={k.id} onRevoked={handleRevoked} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </>
  )
}
