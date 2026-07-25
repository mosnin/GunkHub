'use client'

import { useEffect } from 'react'

import { ErrorState } from '@/components/ui/ErrorState'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * Segment error boundary. Worded so it cannot read as "this run is fine" —
 * see the blast-radius error boundary for the full argument.
 */
export default function RunDivergenceError({ error, reset }: Props) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-blackout">
      <ErrorState
        title="Divergence analysis did not run"
        message={`${error.message || 'An unexpected error occurred.'} No conclusion was reached — this is not a finding that the run is unaffected.`}
        retry={reset}
      />
    </div>
  )
}
