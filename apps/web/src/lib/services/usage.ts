// Usage metering service — see UsageSection for the rendering side.
//
// Team A landed the `usage_counters` table and the `getUsageForDay` /
// `listRecentUsage` queries this cycle (convex/usage.ts). This function reads
// them and folds the result into the typed UsageData contract established in
// Cycle 1 — UsageSection and the pages that call getUsageData() do not need
// to change shape, only the data inside the `available: true` branch.

import { auth } from '@clerk/nextjs/server'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

export interface UsageDailyPoint {
  /** ISO date (yyyy-mm-dd), UTC day bucket. */
  date: string
  events: number
  runs: number
}

export interface UsageDataAvailable {
  available: true
  rangeDays: 7 | 30
  eventCount: number
  runCount: number
  /** Rough storage footprint estimate in bytes (events + externalized artifacts). */
  storageEstimateBytes: number
  /** One point per day in the range, oldest first. Length === rangeDays. */
  dailyCounts: UsageDailyPoint[]
}

export interface UsageDataUnavailable {
  available: false
}

export type UsageData = UsageDataAvailable | UsageDataUnavailable

interface UsageCounterDoc {
  day: string
  runsStarted: number
  eventsIngested: number
  bytesIngested: number
  artifactBytes: number
}

/** "YYYY-MM-DD" in UTC for a given day offset (0 = today) from now. */
function dayString(offsetDays: number, now: number = Date.now()): string {
  const d = new Date(now - offsetDays * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

/**
 * Read the authenticated org's usage metrics for the given range.
 *
 * Builds a dense `dailyCounts` series (one point per day, zero-filled where
 * usage_counters has no row — a quiet day is a legitimate reading, not a
 * fetch failure) from `listRecentUsage`. Returns `{ available: false }` only
 * when the org itself cannot be resolved (no fabricated numbers, matching the
 * Cycle-1 "no fake data" rule) — a genuinely empty history still returns
 * `available: true` with zeroed counts, which is the honest reading once the
 * data platform exists.
 */
export async function getUsageData(rangeDays: 7 | 30 = 7): Promise<UsageData> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return { available: false }

  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) return { available: false }
  const orgDoc = org as Record<string, unknown>

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const rows = await client.query(convex.usage.listRecentUsage, {
    orgId: orgDoc._id,
    limit: rangeDays,
  })
  const byDay = new Map<string, UsageCounterDoc>()
  for (const row of (rows as UsageCounterDoc[]) ?? []) {
    byDay.set(row.day, row)
  }

  const now = Date.now()
  const dailyCounts: UsageDailyPoint[] = []
  let eventCount = 0
  let runCount = 0
  let storageEstimateBytes = 0

  // Oldest first, per the UsageDailyPoint contract.
  for (let offset = rangeDays - 1; offset >= 0; offset--) {
    const date = dayString(offset, now)
    const row = byDay.get(date)
    const events = row?.eventsIngested ?? 0
    const runs = row?.runsStarted ?? 0
    dailyCounts.push({ date, events, runs })
    eventCount += events
    runCount += runs
    storageEstimateBytes += (row?.bytesIngested ?? 0) + (row?.artifactBytes ?? 0)
  }

  return {
    available: true,
    rangeDays,
    eventCount,
    runCount,
    storageEstimateBytes,
    dailyCounts,
  }
}
