import type { AdaptedFailurePattern } from '@/components/patterns/adapt'

import { PatternRow } from '@/components/patterns/PatternRow'
import { EmptyState } from '@/components/ui/EmptyState'

interface PatternListProps {
  patterns: AdaptedFailurePattern[]
}

/**
 * Ranked table of recurring failure-fingerprint rollups. Ranked by
 * `lastSeenAt` descending — the patterns that JUST fired again lead, per the
 * feature brief ("this keeps happening ... spiking now"). Handles its own
 * empty state; loading/error are handled by the page (same split as
 * SelectableRunList / AuditPage).
 */
export function PatternList({ patterns }: PatternListProps) {
  if (patterns.length === 0) {
    return (
      <EmptyState
        title="No recurring failure patterns yet"
        description="Patterns appear as failures recur across runs. Once the same failure fingerprint is seen more than once, it shows up here — ranked by how recently it last happened."
      />
    )
  }

  return (
    <div className="overflow-x-auto rounded-[4px] border border-graphite">
      <table className="w-full text-sm border-collapse min-w-[900px]">
        <thead>
          <tr className="border-b border-graphite bg-graphite-deep">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[280px]">
              Pattern
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[140px]">
              Class
            </th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-pewter uppercase tracking-wider min-w-[90px]">
              Occurrences
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[120px]">
              First seen
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[120px]">
              Last seen
            </th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-pewter uppercase tracking-wider min-w-[90px]">
              Versions
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-pewter uppercase tracking-wider min-w-[110px]">
              Spike
            </th>
          </tr>
        </thead>
        <tbody className="bg-graphite-deep">
          {patterns.map((pattern) => (
            <PatternRow key={pattern.id || pattern.fingerprintHash} pattern={pattern} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
