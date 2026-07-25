/**
 * ObservationSpan — time as a first-class axis, drawn only from measurements.
 *
 * ===========================================================================
 * A BURST HAS A SHAPE AND A COUNT CANNOT EXPRESS IT
 * ===========================================================================
 *
 * "Nine agents" is the same number whether the cluster started four minutes
 * ago and is still producing failures, or ran for a minute an hour ago and
 * stopped. Those are different incidents and demand different actions. So
 * every observed correlation carries where it sits inside the scan window and
 * how wide it is.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DRAWN IS EXACTLY WHAT IS MEASURED — NO MORE
 * ---------------------------------------------------------------------------
 *
 * `ObservedCorrelation` carries `firstObservedAt` and `lastObservedAt`, and
 * the scan carries `since`/`until`. Those four numbers determine a SPAN: a
 * start, an end, and a position within the window. All of it is measured, so
 * all of it can be drawn.
 *
 * What is NOT drawn is a curve. A sparkline implies per-bucket counts, and the
 * contract carries none — an interpolated one would be a picture of an
 * assumption, which on this surface is the same defect as rendering a
 * hypothesis as a finding, relocated into a graphic. If the engine later emits
 * buckets, THEN a sparkline is honest; until then a bar is the strongest claim
 * the data supports.
 *
 * Every visual fact is also a textual fact: start, end, width and whether it is
 * still running are all written out beside the bar. Strip the SVG and nothing
 * is lost — which is what makes this readable in a pasted screenshot, over a
 * phone call, and to a screen reader.
 *
 * All times are UTC and labelled `Z`. During an incident people in different
 * timezones read the same link; local-time rendering makes two readers
 * disagree about when something started, which is the one thing they must
 * agree on.
 */

import type { FleetHealthScan, ObservedCorrelation } from '@agent-flight-recorder/contracts'

import { usableTimestamp } from '@/lib/fleet/safe'
import { formatClockUtc } from '@/lib/fleet/window'
import { formatCoarseDuration } from '@/lib/utils'

/** Fixed geometry. A bar that resizes per row makes rows uncomparable. */
const TRACK_W = 132
const TRACK_H = 8

/**
 * How close to the window's end the last observation must be for the cluster to
 * read as still running. Generous, because rollup cadence lags real time and
 * calling a live burst "stopped" is the more dangerous of the two errors.
 */
const ONGOING_GRACE_MS = 5 * 60_000

interface ObservationSpanProps {
  correlation: ObservedCorrelation
  scan: FleetHealthScan
}

export function ObservationSpanCell({ correlation, scan }: ObservationSpanProps) {
  // USABILITY, not presence. A NaN or string timestamp produces a NaN offset,
  // which CSS resolves to 0 — so the bar silently pins to the far left of the
  // window and reads as "this started at the very beginning", a confident
  // temporal claim manufactured from a broken field. An unusable timestamp must
  // produce NO bar and NO clock, and say so.
  const first = usableTimestamp(correlation.firstObservedAt)
  const last = usableTimestamp(correlation.lastObservedAt)
  const winStart = usableTimestamp(scan.since)
  const winEnd = usableTimestamp(scan.until)

  if (first === null || last === null || winStart === null || winEnd === null || last < first) {
    return (
      <span className="font-mono text-xs text-pewter">
        observation window unreadable
        <span className="sr-only">
          {' '}
          — this correlation did not carry usable timestamps, so when it happened and whether it is
          still running cannot be shown. That is a gap, not a quiet period.
        </span>
      </span>
    )
  }

  const span = Math.max(1, winEnd - winStart)
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const left = clamp((first - winStart) / span)
  const right = clamp((last - winStart) / span)

  const x = left * TRACK_W
  // A one-pixel floor, so an instantaneous cluster is still visible as a mark
  // rather than vanishing into a zero-width rect that reads as "no data".
  const w = Math.max(1, (right - left) * TRACK_W)

  const ongoing = last >= winEnd - ONGOING_GRACE_MS
  const started = `${formatClockUtc(first)}Z`
  const ended = `${formatClockUtc(last)}Z`
  const width = formatCoarseDuration(Math.max(0, last - first))

  return (
    <div className="flex items-center gap-2 min-w-0">
      {/* Positioned boxes rather than an SVG, so every colour here is a
          BACKGROUND. Graphite Light is design.md's border/divider/structure
          token and is never a text colour; reaching it through `fill` +
          `currentColor` would present a 1.64:1 pairing to the token checker as
          text, and the checker would be right to object. Decorative: every fact
          it encodes is written out beside it. */}
      <div
        aria-hidden="true"
        className="relative shrink-0"
        style={{ width: TRACK_W, height: TRACK_H }}
      >
        {/* The scan window, so the span is read against its scope rather than
            against the row's own width. */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 bg-graphite-light" />
        <div
          className={`absolute top-0 h-full ${ongoing ? 'bg-ember' : 'bg-neon-glow'}`}
          style={{ left: x, width: w }}
        />
      </div>

      <span className="min-w-0 flex flex-col leading-tight">
        <span className="font-mono text-xs text-cloud tabular-nums whitespace-nowrap">
          {ongoing ? (
            <>
              from {started} · <span className="text-ember">STILL RUNNING</span>
            </>
          ) : (
            <>
              {started} → {ended} · ENDED
            </>
          )}
        </span>
        <span className="font-mono text-xs text-pewter whitespace-nowrap">
          spans {width}
        </span>
        {/* Spelled out, because "spans 4m" beside a bar is only legible to
            someone who already knows what the bar is measured against. */}
        <span className="sr-only">
          {ongoing
            ? `First observed at ${started}, and still producing observations at the end of the scan window.`
            : `First observed at ${started}, last observed at ${ended}, and producing nothing since.`}
        </span>
      </span>
    </div>
  )
}
