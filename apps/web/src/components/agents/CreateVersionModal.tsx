'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import { Button } from '@/components/ui/Button'
import { createAgentVersionAction } from '@/lib/actions/agent_versions'
import { EVAL_RULE_REFERENCE, parseEvalRulesInput } from '@/lib/evalRulesValidation'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

interface CreateVersionModalProps {
  isOpen: boolean
  agentId: string
  onClose: () => void
  onCreated: (v: { id: string; version: string }) => void
}

export function CreateVersionModal({
  isOpen,
  agentId,
  onClose,
  onCreated,
}: CreateVersionModalProps) {
  const [version, setVersion] = useState('')
  const [changelog, setChangelog] = useState('')
  const [configSnapshotRaw, setConfigSnapshotRaw] = useState('')
  const [evalRulesRaw, setEvalRulesRaw] = useState('')
  const [showRulesReference, setShowRulesReference] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const versionRef = useRef<HTMLInputElement>(null)
  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setVersion('')
      setChangelog('')
      setConfigSnapshotRaw('')
      setEvalRulesRaw('')
      setShowRulesReference(false)
      setError(null)
    }
  }, [isOpen])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!version.trim() || isPending) return
    setError(null)

    let parsedConfig: Record<string, unknown> | undefined
    if (configSnapshotRaw.trim()) {
      try {
        parsedConfig = JSON.parse(configSnapshotRaw) as Record<string, unknown>
      } catch {
        setError('Config snapshot must be valid JSON')
        return
      }
    }

    const evalRulesResult = parseEvalRulesInput(evalRulesRaw)
    if (evalRulesResult.error) {
      setError(evalRulesResult.error)
      return
    }

    startTransition(async () => {
      const result = await createAgentVersionAction(
        agentId,
        version,
        changelog || undefined,
        parsedConfig,
        evalRulesResult.rules,
      )
      if ('error' in result) {
        setError(result.error)
      } else {
        onCreated({ id: result.agentVersion.id, version: result.agentVersion.version })
      }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-version-title"
        tabIndex={-1}
        className="w-full max-w-lg mx-4 rounded-[4px] border border-graphite-light bg-graphite-deep shadow-lg outline-none"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 id="create-version-title" className="text-sm font-semibold text-neutral-100">New Version</h2>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="px-5 py-5 flex flex-col gap-4">
            {/* Version */}
            <div>
              <label
                htmlFor="version-version"
                className="block text-xs font-medium text-neutral-400 mb-1.5"
              >
                Version <span className="text-destructive-400">*</span>
              </label>
              <input
                ref={versionRef}
                id="version-version"
                type="text"
                placeholder="1.0.0"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                maxLength={64}
                disabled={isPending}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'create-version-error' : undefined}
                className="w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
              />
            </div>

            {/* Changelog */}
            <div>
              <label
                htmlFor="version-changelog"
                className="block text-xs font-medium text-neutral-400 mb-1.5"
              >
                Changelog <span className="text-pewter">(optional)</span>
              </label>
              <textarea
                id="version-changelog"
                rows={3}
                placeholder="Describe what changed in this version…"
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                disabled={isPending}
                className="w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50 resize-none"
              />
            </div>

            {/* Config snapshot */}
            <div>
              <label
                htmlFor="version-config"
                className="block text-xs font-medium text-neutral-400 mb-1.5"
              >
                Config snapshot (JSON) <span className="text-pewter">(optional)</span>
              </label>
              <textarea
                id="version-config"
                rows={4}
                placeholder="{}"
                value={configSnapshotRaw}
                onChange={(e) => setConfigSnapshotRaw(e.target.value)}
                disabled={isPending}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'create-version-error' : undefined}
                className="w-full px-3 py-2 text-sm font-mono bg-neutral-950 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50 resize-none"
              />
            </div>

            {/* Eval rules (JSON editor) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="version-eval-rules"
                  className="block text-xs font-medium text-neutral-400"
                >
                  Eval rules (JSON) <span className="text-pewter">(optional)</span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowRulesReference((v) => !v)}
                  className="text-xs text-neon-glow hover:text-whiteout transition-colors duration-100"
                  aria-expanded={showRulesReference}
                  aria-controls="eval-rules-reference"
                >
                  {showRulesReference ? 'Hide reference' : 'Rules reference'}
                </button>
              </div>
              {showRulesReference && (
                <div
                  id="eval-rules-reference"
                  className="mb-2 flex flex-col gap-1.5 rounded-[4px] border border-graphite-light bg-graphite px-3 py-2.5 max-h-40 overflow-y-auto"
                >
                  {EVAL_RULE_REFERENCE.map((r) => (
                    <div key={r.kind} className="text-xs">
                      <span className="font-mono text-whiteout font-medium">{r.kind}</span>
                      <span className="text-pewter"> — {r.description}</span>
                      <div className="font-mono text-xs text-pewter break-all">{r.example}</div>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                id="version-eval-rules"
                rows={4}
                placeholder='[{ "kind": "terminal_status", "expect": ["completed"] }]'
                value={evalRulesRaw}
                onChange={(e) => setEvalRulesRaw(e.target.value)}
                disabled={isPending}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'create-version-error' : undefined}
                className="w-full px-3 py-2 text-sm font-mono bg-neutral-950 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50 resize-none"
              />
              <p className="mt-1 text-xs text-pewter">
                A structured rule builder is planned for a future cycle — this JSON editor is
                validated against the 6 supported rule kinds before submit.
              </p>
            </div>

            {/* Error */}
            {error && (
              <p id="create-version-error" role="alert" className="text-sm text-destructive-400 mt-2">
                {error}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="px-5 py-4 border-t border-neutral-800 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={isPending || !version.trim()}
            >
              {isPending ? 'Creating…' : 'Create Version'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
