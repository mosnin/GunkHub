'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import { Button } from '@/components/ui/Button'
import { createAgentAction } from '@/lib/actions/agents'

interface CreateAgentModalProps {
  isOpen: boolean
  projectId: string
  onClose: () => void
  onCreated: (agent: { id: string; name: string }) => void
}

export function CreateAgentModal({ isOpen, projectId, onClose, onCreated }: CreateAgentModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const nameRef = useRef<HTMLInputElement>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setName('')
      setDescription('')
      setError(null)
      setTimeout(() => nameRef.current?.focus(), 50)
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
    if (!name.trim() || isPending) return
    setError(null)

    startTransition(async () => {
      const result = await createAgentAction(projectId, name, description || undefined)
      if ('error' in result) {
        setError(result.error)
      } else {
        onCreated({ id: result.agent.id, name: result.agent.name })
      }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-md mx-4 rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-100">New Agent</h2>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="px-5 py-5 flex flex-col gap-4">
            {/* Name */}
            <div>
              <label htmlFor="agent-name" className="block text-xs font-medium text-neutral-400 mb-1.5">
                Name <span className="text-destructive-400">*</span>
              </label>
              <input
                ref={nameRef}
                id="agent-name"
                type="text"
                placeholder="My Agent"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                disabled={isPending}
                className="w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
              />
            </div>

            {/* Description */}
            <div>
              <label htmlFor="agent-description" className="block text-xs font-medium text-neutral-400 mb-1.5">
                Description <span className="text-neutral-600">(optional)</span>
              </label>
              <textarea
                id="agent-description"
                rows={2}
                placeholder="Optional description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
                disabled={isPending}
                className="w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50 resize-none"
              />
            </div>

            {/* Error */}
            {error && (
              <p className="text-xs text-destructive-400 bg-destructive-900/30 border border-destructive-800/50 rounded-md px-3 py-2">
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
              disabled={isPending || !name.trim()}
            >
              {isPending ? 'Creating…' : 'Create Agent'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
