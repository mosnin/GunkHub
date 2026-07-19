import Link from 'next/link'

import type { Metadata } from 'next'

import { UsageSection } from '@/components/settings/UsageSection'
import { ErrorState } from '@/components/ui/ErrorState'
import { getUsageData, type UsageData } from '@/lib/services/usage'

export const metadata: Metadata = { title: 'Usage — Settings' }

interface SettingsUsagePageProps {
  searchParams: { range?: string }
}

export default async function SettingsUsagePage({ searchParams }: SettingsUsagePageProps) {
  const rangeDays: 7 | 30 = searchParams.range === '30' ? 30 : 7

  // getUsageData() is a real Convex-backed read as of this cycle (Team A's
  // usage_counters table + getUsageForDay/listRecentUsage queries) — see
  // lib/services/usage.ts. It can still legitimately return
  // `{ available: false }` if the org can't be resolved; UsageSection renders
  // an honest empty state for that case rather than fake numbers. The
  // try/catch below guards against a live query failure blanking the page.
  let usage: UsageData = { available: false }
  let loadError: string | null = null
  try {
    usage = await getUsageData(rangeDays)
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load usage data'
  }

  if (loadError) {
    return <ErrorState title="Could not load usage data" message={loadError} />
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 self-end">
        {([7, 30] as const).map((d) => (
          <Link
            key={d}
            href={d === 7 ? '/settings/usage' : '/settings/usage?range=30'}
            aria-current={rangeDays === d ? 'page' : undefined}
            className={[
              'px-2 py-1 rounded text-xs font-mono font-medium border transition-colors duration-100',
              rangeDays === d
                ? 'bg-primary-900 text-primary-300 border-primary-700'
                : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300 hover:border-neutral-700',
            ].join(' ')}
          >
            {d}d
          </Link>
        ))}
      </div>
      <UsageSection data={usage} />
    </div>
  )
}
