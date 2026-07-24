import Link from 'next/link'

import { cn } from '@/lib/utils'

/** Query-param values for the patterns list's status filter (see PatternsPage). `'all'` is the default — every value maps 1:1 onto a `?status=` value so the current filter is always a shareable, bookmarkable URL, never client-only state. */
export type PatternStatusFilterValue = 'all' | 'open' | 'acknowledged' | 'resolved' | 'regressed'

interface PatternStatusFilterProps {
  active: PatternStatusFilterValue
  /** Count per filter value, computed by the page from the already-fetched list — lets an engineer see "3 regressed" before clicking in. */
  counts: Record<PatternStatusFilterValue, number>
}

const OPTIONS: { value: PatternStatusFilterValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'regressed', label: 'Regressed' },
]

/**
 * Status filter for the Patterns list (docs/adr/006-failure-resolution.md).
 * Plain server-rendered `<Link>` pills driving a `?status=` query param —
 * no client component, no `useEffect`/router push. Filtering itself happens
 * server-side in the page component over the already-fetched list (cycle 1;
 * see PatternsPage), so this component only needs to render the current
 * selection and link to the others. Keeps the list's URL stable and
 * shareable, per design.md's "flow state" requirement.
 */
export function PatternStatusFilter({ active, counts }: PatternStatusFilterProps) {
  return (
    <div role="group" aria-label="Filter patterns by status" className="flex items-center gap-1.5 flex-wrap">
      {OPTIONS.map((opt) => {
        const isActive = opt.value === active
        const href = opt.value === 'all' ? '/patterns' : `/patterns?status=${opt.value}`
        return (
          <Link
            key={opt.value}
            href={href}
            // `page` rather than `true`: each pill IS the current view when
            // selected, and it is what a screen reader announces as the only
            // non-visual signal that this pill is the active one — the
            // Whiteout fill alone is invisible to AT.
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono border transition-colors duration-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow focus-visible:ring-offset-2 focus-visible:ring-offset-blackout',
              isActive
                ? 'bg-whiteout text-graphite-deep border-transparent'
                : 'bg-transparent text-cloud border-graphite-light hover:border-neutral-600',
            )}
          >
            {opt.label}
            <span className={cn('tabular-nums', isActive ? 'text-graphite-deep' : 'text-pewter')}>
              {counts[opt.value]}
              {/* Without this the link announces as e.g. "Open 3" — a bare
                  number whose meaning is carried purely by its position. */}
              <span className="sr-only">
                {' '}
                {counts[opt.value] === 1 ? 'pattern' : 'patterns'}
              </span>
            </span>
          </Link>
        )
      })}
    </div>
  )
}
