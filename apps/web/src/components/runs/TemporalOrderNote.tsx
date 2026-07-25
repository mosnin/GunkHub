import { formatSkew, readEventTiming } from '@agent-flight-recorder/contracts'

import type { Event, EventTiming, RunOrdering } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Surfacing the difference between "the order it happened" and "the order we
// learned of it".
//
// DESIGN POSTURE (design.md — Neon): this is deliberately NOT a warning banner
// farm. A run whose ordering is sound says so in one quiet line and is otherwise
// invisible; a NATIVE run — every run recorded by the first-party SDK — renders
// NOTHING AT ALL, because there is nothing to caveat and a banner that always
// appears is a banner nobody reads.
//
// Colour follows design.md exactly: the only saturated marks are a status dot
// (Neon Glow when the order is trustworthy, System Warning when it is not),
// which is the sanctioned use for both — small state-carrying dots ≤ 8px, with
// the `--shadow-glow` / `--shadow-glow-warn` tokens. All COPY is Cloud or
// TOKEN SPELLING IS CANONICAL HERE, and deliberately does NOT match the
// surrounding legacy rows. `scripts/check-design-tokens.ts` ratchets two things
// this file originally got wrong:
//
//   * ALIAS_SPELLING — `text-neutral-500` is Ash `#797d86` wearing a class name
//     that gives no hint of it. design.md calls that alias "the single most
//     common accessibility defect in this codebase". These labels use
//     `text-pewter` `#94979e`: canonical, and strictly SAFER rather than merely
//     equivalent — Ash fails AA on every elevated surface (4.39 on Graphite
//     Deep, 3.68 on Graphite), while Pewter clears it on all of them and on
//     Blackout (7.18). The rows render on the Blackout ground today, where Ash
//     would have been legal; Pewter stays correct if this block is ever moved
//     onto a card. Likewise `bg-neutral-800` -> `bg-graphite` and
//     `bg-destructive-500` -> `bg-system-warning`.
//   * DERIVED_RAMP — `text-neutral-300` is `#a6a9af`, an INTERPOLATED value
//     with no design.md token behind it at all. Values are taken from the ramp,
//     not derived off it: these use `text-cloud` `#c9cbcf` (>= 7.91:1 on every
//     dark surface).
//
// Matching the adjacent legacy rows was the original reasoning and it was
// wrong: consistency with debt is how a ratchet erodes one convenient hex at a
// time. Do not "harmonise" these back.
//
// Pewter, never the red and never the green: System Warning is 4.20:1 on
// Graphite and fails AA as text, and Neon Glow is barred from copy by the
// Don'ts. Surfaces are Graphite on Blackout with 4px corners.
// ---------------------------------------------------------------------------

/** Converts an epoch-nanosecond decimal string to an ISO 8601 instant, ns precision preserved. */
export function nanoToIso(nano: string): string {
  const padded = nano.padStart(10, '0')
  const millisPart = padded.slice(0, -6)
  const subMilli = padded.slice(-6)
  const ms = Number(millisPart)
  if (!Number.isFinite(ms)) return nano
  const iso = new Date(ms).toISOString()
  // Splice the sub-millisecond digits in before the trailing `Z`.
  return `${iso.slice(0, -1)}${subMilli}Z`
}

interface OrderingBasisNoteProps {
  ordering: RunOrdering
  /** What the ordering applies to, for copy that reads correctly on both surfaces. */
  subject?: 'replay' | 'comparison'
}

/**
 * One-line, run-level statement of what the rendered order is entitled to claim.
 *
 * Renders `null` for a fully native run. That is the intended "nothing to say"
 * state, not a blank screen — the surrounding page is unaffected, and it is what
 * keeps the first-party path visually identical to before temporal ordering
 * existed.
 */
export function OrderingBasisNote({ ordering, subject = 'replay' }: OrderingBasisNoteProps) {
  if (ordering.basis === 'sequence-native') return null

  const noun = subject === 'comparison' ? 'This comparison' : 'This replay'

  if (ordering.basis === 'temporal') {
    return (
      <div className="flex items-start gap-2 px-4 py-2 bg-graphite border border-graphite-light rounded-[4px] text-xs">
        <span
          className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full bg-neon-glow shadow-[var(--shadow-glow)] forced-colors:bg-[Highlight]"
          aria-hidden="true"
        />
        <p className="text-cloud font-medium">
          Ordered by span time.{' '}
          <span className="text-pewter font-normal">
            {ordering.derivedCount} of {ordering.derivedCount + ordering.nativeCount} events were
            derived from OpenTelemetry spans, so {noun.toLowerCase()} is ordered by when they
            happened — not by sequence number, which on this path is the order the collector
            delivered them.
            {ordering.clampedCount > 0 && ordering.maxAbsSkewNano !== null && (
              <>
                {' '}
                <span className="font-mono">{ordering.clampedCount}</span>{' '}
                {ordering.clampedCount === 1 ? 'timing was' : 'timings were'} clamped to keep
                causal edges from pointing forward; largest adjustment{' '}
                <span className="font-mono text-cloud">{formatSkew(ordering.maxAbsSkewNano)}</span>.
              </>
            )}
          </span>
        </p>
      </div>
    )
  }

  // ingest-unverified
  const unkeyed = ordering.derivedCount - ordering.keyedCount
  return (
    <div className="flex items-start gap-2 px-4 py-2 bg-graphite border border-graphite-light rounded-[4px] text-xs">
      <span
        className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full bg-system-warning shadow-[var(--shadow-glow-warn)] forced-colors:bg-[Highlight]"
        aria-hidden="true"
      />
      <p className="text-cloud font-medium">
        Arrival order, not time order.{' '}
        <span className="text-pewter font-normal">
          <span className="font-mono">{unkeyed}</span> of{' '}
          <span className="font-mono">{ordering.derivedCount}</span> events derived from
          OpenTelemetry spans carry no ordering key, so {noun.toLowerCase()} is shown in the order
          the collector delivered spans. For a trace that arrived across several batches that is
          not the order things happened. Read it as a list, not a timeline.
        </span>
      </p>
    </div>
  )
}

interface EventTimingRowsProps {
  event: Event
}

/**
 * Metadata-grid rows describing an event's timing HONESTLY.
 *
 * For a natively-recorded event this is one row — the timestamp, exactly as it
 * rendered before — because a first-party timestamp was measured and there is
 * nothing further to disclose.
 *
 * For a derived event whose instant was CLAMPED, the timestamp is marked
 * inferred and the raw value is shown beside it. `provenance.lossReasons`
 * containing `timing-approximated` means the mapper adjusted the instant so no
 * causal edge points forward in time — a necessary repair, but a repair, and
 * rendering the result in the same treatment as a measured value asserts a
 * precision we do not have.
 *
 * The raw instant is preserved in `temporalOrder.rawInstantUnixNano` precisely
 * so it stays inspectable: clock skew between an agent and its tools is itself a
 * debugging signal, not noise to hide.
 *
 * Designed to be spread into an existing `grid-cols-2` metadata grid — it emits
 * label/value pairs, no wrapper.
 */
export function EventTimingRows({ event }: EventTimingRowsProps) {
  const timing = readEventTiming(event)

  return (
    <>
      <div className="text-pewter">Timestamp</div>
      <div className="font-mono text-cloud flex items-center gap-2">
        <span className={timing.measured ? '' : 'text-pewter'}>
          {timing.measured ? '' : '~'}
          {new Date(event.timestamp).toISOString()}
        </span>
        {!timing.measured && <InferredTag />}
      </div>

      {timing.clamped && timing.rawInstantUnixNano !== undefined && (
        <>
          <div className="text-pewter">Raw instant</div>
          <div className="font-mono text-cloud break-all">
            {nanoToIso(timing.rawInstantUnixNano)}
            <span className="block text-pewter">{timing.rawInstantUnixNano} ns</span>
          </div>
        </>
      )}

      {timing.clamped && timing.effectiveInstantUnixNano !== undefined && (
        <>
          <div className="text-pewter">Effective instant</div>
          <div className="font-mono text-cloud break-all">
            {nanoToIso(timing.effectiveInstantUnixNano)}
            <span className="block text-pewter">{timing.effectiveInstantUnixNano} ns</span>
          </div>
        </>
      )}

      {timing.skewNano !== undefined && (
        <>
          <div className="text-pewter">Clock skew</div>
          <div className="font-mono text-cloud">
            {formatSkew(timing.skewNano)}
            <span className="text-pewter"> effective − raw</span>
          </div>
        </>
      )}

      {timing.approximated && !timing.clamped && (
        <>
          <div className="text-pewter">Timing</div>
          <div className="text-pewter">
            Reported as approximated by the span mapper. No raw instant was stored, so the size of
            the adjustment is not recoverable.
          </div>
        </>
      )}
    </>
  )
}

/**
 * The inferred marker.
 *
 * Not red — an inferred timestamp is a statement about evidence strength, not a
 * failure. A neutral Graphite chip with Pewter copy, which reads as a
 * qualification rather than an alarm.
 */
function InferredTag() {
  return (
    <span
      title="This instant was clamped or rounded by the OpenTelemetry span mapper, not measured."
      className="shrink-0 font-mono text-xs px-1.5 py-0.5 rounded-[4px] bg-graphite border border-graphite-light text-pewter"
    >
      inferred
    </span>
  )
}

/**
 * Compact inline marker for dense list rows (the replay frame list), where a
 * full timing block does not fit.
 *
 * A single `~` in Pewter, carrying an accessible name. It is a MARK, not prose —
 * one glyph, read as a symbol — so it stays at the row's own `text-xs` step
 * rather than dropping below the 12px mono prose floor.
 */
export function InferredTimingMark({ timing }: { timing: EventTiming }) {
  if (timing.measured) return null
  return (
    <span
      className="shrink-0 font-mono text-xs text-pewter"
      title="Inferred timing — clamped or rounded at ingest, not measured."
      aria-label="Inferred timing"
    >
      ~
    </span>
  )
}
