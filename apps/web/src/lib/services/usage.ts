// Usage metering service seam — see UsageSection for the rendering side.
//
// Team A is landing the `usage_counters` and `daily_rollups` Convex tables this
// cycle; this file cannot query them yet. The contract below is the boundary
// the NEXT cycle implements against: getUsageData() returns a typed UsageData
// discriminated union, and cycle 2's entire job is swapping the `{ available:
// false }` stub body for real Convex calls (fetchQuery(api.usage.getRollups,
// ...) or equivalent) — UsageSection and the page that calls this function do
// not need to change shape when that lands, only the data inside the
// `available: true` branch.
//
// No fake data is returned here. An honest unavailable state is not a bug to
// hide — it is the correct state until the data platform exists.

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

/**
 * Read the authenticated org's usage metrics for the given range.
 *
 * STUB (this cycle): usage_counters / daily_rollups do not exist in
 * convex/schema.ts yet, so there is nothing to query. Returns `{ available:
 * false }` unconditionally. Do not fabricate placeholder numbers here — the
 * UsageSection empty state is the correct and honest representation of this
 * state, matching the "no fake data" rule for this surface.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getUsageData(rangeDays: 7 | 30 = 7): Promise<UsageData> {
  return Promise.resolve({ available: false })
}
