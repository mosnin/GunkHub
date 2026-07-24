'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface ExplanationRegenerateButtonProps {
  runId: string
}

/**
 * Admin-only affordance to re-run failure analysis for this run.
 * Calls Team C's POST /api/runs/[runId]/explanation/regenerate (admin-gated
 * server-side too — this button is a convenience, not the enforcement point).
 * The client component is isolated to just this button so the rest of
 * ExplanationPanel stays a server component.
 */
export function ExplanationRegenerateButton({ runId }: ExplanationRegenerateButtonProps) {
  const router = useRouter()
  const [status, setStatus] = useState<'idle' | 'pending' | 'error'>('idle')

  async function handleClick() {
    setStatus('pending')
    try {
      const res = await fetch(`/api/runs/${runId}/explanation/regenerate`, { method: 'POST' })
      if (!res.ok) {
        setStatus('error')
        return
      }
      setStatus('idle')
      router.refresh()
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => { void handleClick() }}
        disabled={status === 'pending'}
        className="text-xs font-mono text-pewter hover:text-neon-glow disabled:opacity-50 disabled:pointer-events-none transition-colors duration-100"
      >
        {status === 'pending' ? 'Regenerating…' : 'Regenerate'}
      </button>
      {status === 'error' && (
        <span role="alert" className="text-xs text-destructive-400">
          Couldn&apos;t regenerate — try again.
        </span>
      )}
    </div>
  )
}
