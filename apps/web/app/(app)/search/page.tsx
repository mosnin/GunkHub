import type { Run } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'


import { PageHeader } from '@/components/layout/PageHeader'
import { RunList } from '@/components/runs/RunList'
import { RunSearchBar } from '@/components/runs/RunSearchBar'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { searchRuns } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Search' }

interface SearchPageProps {
  searchParams: { q?: string }
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const q = searchParams.q?.trim() ?? ''

  let runs: Run[] = []
  let error: string | null = null
  if (q.length > 0) {
    try {
      runs = await searchRuns(q)
    } catch (err) {
      error = err instanceof Error ? err.message : 'Search failed'
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader title="Search" subtitle="Full-text search over run name, tags, and error text." />

      <div className="mt-4">
        <RunSearchBar initialQuery={q} autoFocus />
      </div>

      <div className="mt-4">
        {q.length === 0 ? (
          <EmptyState
            title="Search your runs"
            description="Type a run name, tag, or a fragment of an error message. Press / anywhere to jump to this search box."
          />
        ) : error ? (
          <ErrorState title="Search failed" message={error} />
        ) : runs.length === 0 ? (
          <EmptyState
            title={`No runs match "${q}"`}
            description="Try a different search term — search covers agent name, tags, triggeredBy, and terminal failure error text."
          />
        ) : (
          <>
            <p className="mb-3 text-xs text-pewter font-mono">
              {runs.length} result{runs.length === 1 ? '' : 's'} for &ldquo;{q}&rdquo;
            </p>
            <RunList runs={runs} />
          </>
        )}
      </div>
    </div>
  )
}
