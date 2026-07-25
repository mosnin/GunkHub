'use client'

import { useEffect } from 'react'

import { ErrorState } from '@/components/ui/ErrorState'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * Segment error boundary.
 *
 * Deliberately worded so it can never be mistaken for "nothing would break".
 * On a surface whose whole job is to tell an operator whether a version is safe
 * to ship, a failure that reads as reassurance is the worst available outcome —
 * so this says outright that no conclusion was reached.
 */
export default function BlastRadiusError({ error, reset }: Props) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-blackout">
      <ErrorState
        title="Blast radius analysis did not run"
        message={`${error.message || 'An unexpected error occurred.'} No conclusion was reached — this is not a finding that the version is safe to ship.`}
        retry={reset}
      />
    </div>
  )
}
