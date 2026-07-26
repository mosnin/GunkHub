import type { AdaptedFailurePattern } from '@/components/patterns/adapt'
import type { PatternStatusFilterValue } from '@/components/patterns/PatternStatusFilter'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { adaptFailurePattern, isRegressedPattern } from '@/components/patterns/adapt'
import { PatternList } from '@/components/patterns/PatternList'
import { PatternStatusFilter } from '@/components/patterns/PatternStatusFilter'
import { ErrorState } from '@/components/ui/ErrorState'
import { listFailurePatterns } from '@/lib/services/failurePatterns'

export const metadata: Metadata = { title: 'Patterns' }

const LIST_LIMIT = 100

interface PatternsPageProps {
  searchParams: { status?: string }
}

function parseStatusFilter(raw: string | undefined): PatternStatusFilterValue {
  return raw === 'open' || raw === 'acknowledged' || raw === 'resolved' || raw === 'regressed' ? raw : 'all'
}

/** Applies the `?status=` filter over the already-fetched list — cycle 1 does this client-of-render-side rather than pushing a new Convex query filter, per the brief. */
function filterByStatus(patterns: AdaptedFailurePattern[], filter: PatternStatusFilterValue): AdaptedFailurePattern[] {
  switch (filter) {
    case 'all':
      return patterns
    case 'regressed':
      return patterns.filter((p) => isRegressedPattern(p))
    default:
      return patterns.filter((p) => p.status === filter)
  }
}

function countByStatus(patterns: AdaptedFailurePattern[]): Record<PatternStatusFilterValue, number> {
  return {
    all: patterns.length,
    open: patterns.filter((p) => p.status === 'open').length,
    acknowledged: patterns.filter((p) => p.status === 'acknowledged').length,
    resolved: patterns.filter((p) => p.status === 'resolved').length,
    regressed: patterns.filter((p) => isRegressedPattern(p)).length,
  }
}

/**
 * "Failure Patterns" list — a durable, ranked memory of recurring failure
 * fingerprints across the org (PREVENTION feature, cycle 1). Ranked by
 * `lastSeenAt` descending server-side (convex/failure_patterns.ts's
 * `by_org_lastSeenAt` index) so the pattern that JUST fired again leads.
 *
 * Data fetching mirrors every other (app) list page (RunsPage, AuditPage):
 * call the service layer directly from this server component, handle
 * loading via `loading.tsx`, and render ErrorState/EmptyState explicitly —
 * no blank screens. See `@/components/patterns/adapt` for why every raw
 * pattern is run through an adapter before reaching any component.
 *
 * Resolution lifecycle (cycle 1 of Resolution, docs/adr/006-failure-
 * resolution.md): the `?status=` query param drives a client-of-render-side
 * filter over the same fetched list — the service doesn't yet support
 * filtering server-side, and cycle 1 doesn't need it to (100-row page,
 * filtered here). The URL stays the single source of truth for "which
 * filter is active," so the filtered view is always a stable, shareable
 * link — never client component state that resets on reload.
 */
export default async function PatternsPage({ searchParams }: PatternsPageProps) {
  let patterns: Awaited<ReturnType<typeof listFailurePatterns>> | null = null
  let error: string | null = null

  try {
    patterns = await listFailurePatterns(LIST_LIMIT)
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load failure patterns'
  }

  const statusFilter = parseStatusFilter(searchParams.status)
  const adapted = (patterns ?? []).map(adaptFailurePattern)

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Patterns"
        subtitle="Recurring failure fingerprints across your organization — ranked by how recently they last happened."
      />

      <div className="mt-4 flex flex-col gap-4">
        {!error && <PatternStatusFilter active={statusFilter} counts={countByStatus(adapted)} />}

        {error ? (
          <ErrorState title="Failed to load failure patterns" message={error} />
        ) : (
          <PatternList
            patterns={filterByStatus(adapted, statusFilter)}
            {...(statusFilter !== 'all' &&
              adapted.length > 0 && {
                emptyTitle: `No ${statusFilter} patterns`,
                emptyDescription: 'Nothing matches this filter right now — try "All" to see every recurring pattern.',
              })}
          />
        )}
      </div>
    </div>
  )
}
