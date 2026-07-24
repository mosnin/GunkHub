import Link from 'next/link'

import type { Metadata } from 'next'

import { UsageSection } from '@/components/settings/UsageSection'
import { getUsageData } from '@/lib/services/usage'

export const metadata: Metadata = { title: 'Usage — Settings' }

interface SettingsUsagePageProps {
  searchParams: { range?: string }
}

export default async function SettingsUsagePage({ searchParams }: SettingsUsagePageProps) {
  const rangeDays: 7 | 30 = searchParams.range === '30' ? 30 : 7

  // getUsageData() catches internally and returns an explained ServiceResult,
  // so this is a direct assignment. Two things were deleted here on purpose:
  //
  //  - the fabricated `{ available: false }` seed, which asserted "no usage
  //    data" before a single query had run. That literal was the page-level
  //    form of the exact bug ServiceResult exists to kill.
  //  - the try/catch, which piped a raw `err.message` into ErrorState. Convex
  //    error prose can carry document IDs and function paths, and this app
  //    deliberately keeps a cross-org lookup indistinguishable from a missing
  //    record (CLAUDE.md, Tenancy Rules #3) — echoing it to the UI hands back
  //    exactly that oracle. The service's `message` is safe by construction.
  //
  // A non-'ok' result now reaches UsageSection, which explains it in place
  // rather than replacing the whole page (and its range toggle) with an error.
  const usage = await getUsageData(rangeDays)

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
