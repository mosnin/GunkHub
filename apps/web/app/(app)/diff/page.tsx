import type { GetDiffResponse } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { DiffViewer } from '@/components/runs/DiffViewer'
import { ErrorState } from '@/components/ui/ErrorState'
import { getRunDiff } from '@/lib/services/diff'

export const metadata: Metadata = { title: 'Compare Runs' }

interface DiffPageProps {
  searchParams: { left?: string; right?: string }
}

export default async function DiffPage({ searchParams }: DiffPageProps) {
  const left = searchParams.left?.trim()
  const right = searchParams.right?.trim()

  const hasBothIds = Boolean(left && right)

  let diffData: GetDiffResponse | null = null
  let fetchError: string | null = null

  if (hasBothIds && left && right) {
    try {
      diffData = await getRunDiff(left, right)
    } catch (err) {
      fetchError = err instanceof Error ? err.message : 'Unknown error'
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Compare Runs"
        subtitle="Select two runs to compare their event sequences."
      />
      <div className="mt-6">
        {fetchError ? (
          <ErrorState title="Failed to load diff" message={fetchError} />
        ) : (
          <DiffViewer
            diff={diffData?.diff}
            incomparable={diffData?.incomparable}
            incomparableReason={diffData?.incomparableReason}
          />
        )}
      </div>
    </div>
  )
}
