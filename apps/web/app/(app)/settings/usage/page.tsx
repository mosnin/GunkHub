import type { Metadata } from 'next'

import { UsageSection } from '@/components/settings/UsageSection'
import { ErrorState } from '@/components/ui/ErrorState'
import { getUsageData, type UsageData } from '@/lib/services/usage'

export const metadata: Metadata = { title: 'Usage — Settings' }

export default async function SettingsUsagePage() {
  // getUsageData() is a typed seam — see lib/services/usage.ts. This cycle it
  // returns `{ available: false }` unconditionally (Team A's usage_counters /
  // daily_rollups tables don't exist yet); UsageSection renders an honest
  // empty state for that case rather than fake numbers. The try/catch here is
  // forward-looking: once cycle 2 wires real Convex calls into this function,
  // a query failure must not blank the page.
  let usage: UsageData = { available: false }
  let loadError: string | null = null
  try {
    usage = await getUsageData(7)
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load usage data'
  }

  if (loadError) {
    return <ErrorState title="Could not load usage data" message={loadError} />
  }

  return <UsageSection data={usage} />
}
