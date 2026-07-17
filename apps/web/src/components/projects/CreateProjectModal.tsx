'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import { Button } from '@/components/ui/Button'
import { createProjectAction } from '@/lib/actions/projects'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

interface CreateProjectModalProps {
  isOpen: boolean
  onClose: () => void
  onCreated: (project: { id: string; name: string }) => void
}

function slugPreview(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function CreateProjectModal({ isOpen, onClose, onCreated }: CreateProjectModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setName('')
      setDescription('')
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
    if (!name.trim() || isPending) return
    setError(null)

    startTransition(async () => {
      const result = await createProjectAction(name, description || undefined)
      if ('error' in result) {
        setError(result.error)
      } else {
        onCreated({ id: result.project.id, name: result.project.name })
      }
    })
  }

  const slug = slugPreview(name)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        tabIndex={-1}
        className="w-full max-w-md mx-4 rounded-[4px] border border-graphite-light bg-graphite-deep outline-none"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 id="create-project-title" className="text-sm font-semibold text-neutral-100">New Project</h2>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="px-5 py-5 flex flex-col gap-4">
            {/* Name */}
            <div>
              <label htmlFor="project-name" className="block text-xs font-medium text-neutral-400 mb-1.5">
                Name <span className="text-destructive-400">*</span>
              </label>
              <input
                ref={nameRef}
                id="project-name"
                type="text"
                placeholder="My Agent Project"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                disabled={isPending}
                className="w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50"
              />
              {slug && (
                <p className="mt-1.5 text-xs text-pewter font-mono">
                  slug: <span className="text-neutral-400">{slug}</span>
                </p>
              )}
            </div>

            {/* Description */}
            <div>
              <label htmlFor="project-description" className="block text-xs font-medium text-neutral-400 mb-1.5">
                Description <span className="text-pewter">(optional)</span>
              </label>
              <textarea
                id="project-description"
                rows={2}
                placeholder="Optional description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
                disabled={isPending}
                className="w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-700 rounded-md text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 disabled:opacity-50 resize-none"
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
              {isPending ? 'Creating…' : 'Create Project'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
