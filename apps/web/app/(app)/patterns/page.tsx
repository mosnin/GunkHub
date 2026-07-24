import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { adaptFailurePattern } from '@/components/patterns/adapt'
import { PatternList } from '@/components/patterns/PatternList'
import { ErrorState } from '@/components/ui/ErrorState'
import { listFailurePatterns } from '@/lib/services/failurePatterns'

export const metadata: Metadata = { title: 'Patterns' }

const LIST_LIMIT = 100

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
 */
export default async function PatternsPage() {
  let patterns: Awaited<ReturnType<typeof listFailurePatterns>> | null = null
  let error: string | null = null

  try {
    patterns = await listFailurePatterns(LIST_LIMIT)
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load failure patterns'
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Patterns"
        subtitle="Recurring failure fingerprints across your organization — ranked by how recently they last happened."
      />

      <div className="mt-4">
        {error ? (
          <ErrorState title="Failed to load failure patterns" message={error} />
        ) : (
          <PatternList patterns={(patterns ?? []).map(adaptFailurePattern)} />
        )}
      </div>
    </div>
  )
}
