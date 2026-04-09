import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { RunList } from '@/components/runs/RunList'
import { ErrorState } from '@/components/ui/ErrorState'
import { listRuns } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Runs' }

interface RunsPageProps {
  searchParams: {
    status?: string
    projectId?: string
    agentId?: string
    cursor?: string
  }
}

export default async function RunsPage({ searchParams }: RunsPageProps) {
  let runs: Awaited<ReturnType<typeof listRuns>> | null = null
  let error: string | null = null

  try {
    runs = await listRuns({
      status: searchParams.status as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | undefined,
      projectId: searchParams.projectId,
      agentId: searchParams.agentId,
      cursor: searchParams.cursor,
      limit: 50,
    })
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load runs'
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Runs"
        subtitle="All agent runs across your organization."
      />
      <div className="mt-6">
        {error ? (
          <ErrorState
            title="Failed to load runs"
            message={error}
          />
        ) : (
          <RunList runs={runs?.runs} />
        )}
      </div>
    </div>
  )
}
