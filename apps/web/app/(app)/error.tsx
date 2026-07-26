'use client'

import { useEffect } from 'react'

import { ErrorState } from '@/components/ui/ErrorState'

interface AppErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * Route-segment error boundary for the authenticated app. Next.js renders this
 * when a server or client component in the segment throws. The "Try again"
 * action is wired to `reset`, which re-renders the segment. Neon system:
 * Blackout ground, shared ErrorState primitive.
 */
export default function AppError({ error, reset }: AppErrorProps) {
  useEffect(() => {
    // Surface the failure for observability instead of swallowing it silently.
    console.error(error)
  }, [error])

  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-blackout">
      <ErrorState
        title="Something went wrong"
        message={error.message || 'An unexpected error occurred while loading this page.'}
        retry={reset}
      />
    </div>
  )
}
