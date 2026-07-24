import type { UsageData } from '@/lib/services/usage'

import { Card } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { isOk } from '@/lib/services/serviceResult'
import { formatBytes } from '@/lib/utils'

interface UsageSectionProps {
  data: UsageData
}

interface StatTileProps {
  label: string
  value: string
}

function StatTile({ label, value }: StatTileProps) {
  return (
    <div className="flex-1 min-w-[120px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
      <dt className="text-xs font-medium text-pewter uppercase tracking-wider">{label}</dt>
      <dd className="mt-1 font-mono text-xl text-whiteout tabular-nums">{value}</dd>
    </div>
  )
}

/**
 * CSS-only sparkline — a row of bars, one per day, height proportional to the
 * max of the series. No chart library (design.md: no external UI deps; Neon
 * accent for the data itself, not decoration).
 */
function DailyBars({
  dailyCounts,
}: {
  dailyCounts: Array<{ date: string; events: number; runs: number }>
}) {
  const max = Math.max(1, ...dailyCounts.map((d) => d.events))
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-pewter uppercase tracking-wider">
        Events per day
      </p>
      <div
        className="flex items-end gap-[3px] h-16 border-b border-graphite"
        role="img"
        aria-label={`Event counts for the last ${String(dailyCounts.length)} days`}
      >
        {dailyCounts.map((d) => {
          const heightPct = Math.max(2, Math.round((d.events / max) * 100))
          return (
            <div
              key={d.date}
              className="flex-1 min-w-[3px] bg-neon-muted hover:bg-neon-glow transition-colors duration-100 rounded-t-[4px]"
              style={{ height: `${String(heightPct)}%` }}
              title={`${d.date}: ${String(d.events)} events, ${String(d.runs)} runs`}
            />
          )
        })}
      </div>
      <div className="flex justify-between text-xs font-mono text-pewter">
        <span>{dailyCounts[0]?.date}</span>
        <span>{dailyCounts[dailyCounts.length - 1]?.date}</span>
      </div>
    </div>
  )
}

export function UsageSection({ data }: UsageSectionProps) {
  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">Usage</h2>
        <p className="mt-0.5 text-xs text-neutral-400">
          Event and run volume, and an estimate of stored data, for this organization.
        </p>
      </div>

      <div className="px-5 py-4">
        {/* usage.ts has no 'empty' branch by design: for a quiet org a
            zero-filled series IS the answer, so it returns status 'ok' with
            zeros rather than an absence. That leaves only 'ok' and 'error'
            reachable here, which is why there is no EmptyState — the only
            non-ok outcome is a genuine failure and it says so. */}
        {!isOk(data) ? (
          <ErrorState title="Couldn't load usage data" message={data.message} />
        ) : (
          <div className="flex flex-col gap-5">
            <dl className="flex flex-wrap gap-3">
              <StatTile label={`Events (${String(data.rangeDays)}d)`} value={data.eventCount.toLocaleString('en-US')} />
              <StatTile label={`Runs (${String(data.rangeDays)}d)`} value={data.runCount.toLocaleString('en-US')} />
              <StatTile label="Storage (est.)" value={formatBytes(data.storageEstimateBytes)} />
            </dl>

            <p className="text-xs text-pewter leading-relaxed border-l-2 border-graphite-light pl-2.5">
              <strong className="text-cloud font-medium">Approximate</strong> — for capacity
              planning, not billing. These counters are flushed probabilistically (roughly 1-in-10
              single-unit increments, scaled back up) to avoid contending on one document per
              organization per day, so they carry sampling variance rather than an exact count.
              When alert rules evaluate failure rate, they read from a separate bounded sample of
              recent runs, not these counters — the two numbers are independent approximations and
              are not expected to reconcile exactly. The event log itself remains the exact,
              append-only source of truth for anything that needs to be precise.
            </p>

            {data.dailyCounts.length > 0 && <DailyBars dailyCounts={data.dailyCounts} />}
          </div>
        )}
      </div>
    </Card>
  )
}
