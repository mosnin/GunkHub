'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'

interface ApiKey {
  id: string
  name: string
  prefix: string
  createdAt: number
}

interface GenerateResult {
  key: string
  id: string
  name: string
  prefix: string
  createdAt: number
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl w-full max-w-md mx-4">
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
          {/* Warning */}
          <div className="flex items-start gap-2 bg-warning-900/50 border border-warning-700 rounded-md px-3 py-2.5">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="text-warning-400 shrink-0 mt-0.5">
              <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M6.68 2.5L1.5 11a1.5 1.5 0 001.32 2.25h10.36A1.5 1.5 0 0014.5 11L9.32 2.5a1.5 1.5 0 00-2.64 0z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <p className="text-xs text-warning-300 leading-relaxed">
              This key is shown <strong>only once</strong>. Copy it now and store it securely. You cannot retrieve it again.
            </p>
          </div>

          {/* Key display */}
          <div>
            <p className="text-xs font-medium text-neutral-500 mb-1.5 uppercase tracking-wider">Your API Key</p>
            <CodeBlock content={result.key} maxHeight="60px" />
          </div>

          {/* Copy button */}
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

// TODO (Team A): wire this to the real /api/api-keys GET+POST endpoints when available
export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [generating, setGenerating] = useState(false)
  const [newKey, setNewKey] = useState<GenerateResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    setGenerating(true)
    setError(null)

    try {
      // TODO (Team A): replace with real POST /api/api-keys call
      // For now return a 501 stub to indicate the route isn't available yet
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Key ${new Date().toLocaleDateString()}` }),
      })

      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const body: { message?: string } = await res.json().catch(() => ({}))
        throw new Error(body.message ?? `Server error ${res.status}`)
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const data: GenerateResult = await res.json()
      setNewKey(data)
      setKeys((prev) => [{ id: data.id, name: data.name, prefix: data.prefix, createdAt: data.createdAt }, ...prev])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate key')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
      {newKey && <NewKeyModal result={newKey} onClose={() => setNewKey(null)} />}

      <Card>
        <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-neutral-200">API Keys</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Used to authenticate the SDK when recording runs.
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { void handleGenerate() }}
            disabled={generating}
          >
            {generating ? 'Generating…' : 'Generate API Key'}
          </Button>
        </div>

        <div className="px-5 py-4">
          {error && (
            <div className="mb-4 flex items-center gap-2 text-xs text-destructive-400 bg-destructive-900/50 border border-destructive-700 rounded-md px-3 py-2">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="shrink-0">
                <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M6.68 2.5L1.5 11a1.5 1.5 0 001.32 2.25h10.36A1.5 1.5 0 0014.5 11L9.32 2.5a1.5 1.5 0 00-2.64 0z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              {error}
            </div>
          )}

          {keys.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No API keys yet. Generate one to start recording runs with the SDK.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-neutral-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-800 bg-neutral-900">
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Key prefix
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                  {keys.map((k) => (
                    <tr key={k.id}>
                      <td className="px-4 py-3 text-sm text-neutral-300">{k.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-neutral-400">{k.prefix}…</td>
                      <td className="px-4 py-3 text-xs text-neutral-500">{formatDate(k.createdAt)}</td>
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
