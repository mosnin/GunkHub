import type { GetDiffResponse } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { DiffViewer } from '@/components/runs/DiffViewer'
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
          <div className="rounded-md bg-red-950/30 border border-red-900/60 px-4 py-3 text-sm text-red-300">
            <span className="font-semibold">Failed to load diff: </span>
            {fetchError}
          </div>
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
