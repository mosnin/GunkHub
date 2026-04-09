import type { Run } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { RunList } from '@/components/runs/RunList'
import { Card } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { listRuns } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Dashboard' }

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="px-4 py-4">
        <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</p>
        <p className="mt-1.5 text-2xl font-semibold text-neutral-100 font-mono">{value}</p>
      </div>
    </Card>
  )
}

export default async function DashboardPage() {
  let runs: Run[] = []
  let error: string | null = null

  try {
    const result = await listRuns({ limit: 20 })
    runs = result.runs
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load runs'
  }

  const totalRuns = runs.length
  const failedRuns = runs.filter((r) => r.status === 'failed').length
  const activeRuns = runs.filter((r) => r.status === 'running').length

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader title="Dashboard" />

      {error ? (
        <div className="mt-6">
          <ErrorState title="Failed to load data" message={error} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard label="Recent Runs" value={String(totalRuns)} />
            <StatCard label="Failed" value={String(failedRuns)} />
            <StatCard label="Active" value={String(activeRuns)} />
          </div>

          <div className="mt-8">
            <h2 className="text-sm font-semibold text-neutral-300 mb-4">Recent Runs</h2>
            <RunList runs={runs} />
          </div>
        </>
      )}
    </div>
  )
}
