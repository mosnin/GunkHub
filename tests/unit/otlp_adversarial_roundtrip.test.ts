/**
 * OTLP ROUND-TRIP FIDELITY SUITE — Phase 2 item 9.
 *
 * WHAT THIS FILE IS
 * `tests/unit/otel_ordering_adversarial.test.ts` attacks ORDERING in isolation.
 * This file attacks COMPOSITION: OTel spans in -> mapper -> an append-only
 * event log that obeys Event Log Rules 1/4/5 -> a replay projection -> a trace
 * that must be equivalent to the one that went in. Items 6, 7 and 8 of the
 * roadmap can each be individually correct and still not compose; nothing else
 * in the repo tests the seams between them.
 *
 * WHAT IT IS BOUND TO
 *   - `convex/helpers/otel_mapping.ts`  — the real, shipped mapper (Team A).
 *     Loaded HARD. If it cannot be loaded this suite FAILS. It is not skipped.
 *     A skip-on-missing gate is how an adversarial suite goes green while
 *     proving nothing, and this repo has been bitten by exactly that.
 *   - `@agent-flight-recorder/contracts` — `isProvenanceConsistent`, the real
 *     shipped predicate, not a local copy. If contracts drifts, this suite
 *     moves with it.
 *
 * WHAT IT IS *NOT* BOUND TO, AND WHY
 * There is no `otelIngestSpans` Convex mutation and no OTLP HTTP route in the
 * tree at the time of writing. The append-only store below (`ReferenceIngest`)
 * is therefore a REFERENCE DRIVER, written from the rules `convex/sdk_ingest.ts`
 * actually enforces (first event `run.started`; strict `maxSeq + 1` contiguity;
 * `RUN_NOT_ACTIVE` after a terminal event) and from ADR-007's constraints. It
 * is a specification for the mutation, not a stand-in for it. See
 * `pinned-gap/*` below, which fails the moment the real mutation lands so that
 * this suite gets re-pointed at it rather than silently continuing to grade a
 * reference implementation.
 *
 * ── THE DEFECT LEDGER ──────────────────────────────────────────────────────
 * Several attacks below FIND REAL DEFECTS. Asserting the correct behaviour
 * would leave a permanently red suite in a tree three other teams are working
 * in; asserting the current behaviour would pin the bug and is how defects
 * become features. This suite does neither.
 *
 * Every attack runs for real and compares actual behaviour against the CORRECT
 * expectation. A mismatch is appended to `observedDefects` with a stable id.
 * One final test asserts `observedDefects` is EXACTLY `KNOWN_DEFECTS`. So:
 *
 *   - a defect getting fixed        -> ledger mismatch -> RED (delete the entry)
 *   - a new defect appearing        -> ledger mismatch -> RED
 *   - the status quo               -> GREEN, with every defect named, executed,
 *                                     and reproducible from the case that
 *                                     detected it
 *
 * The ledger cannot self-exempt on missing data: `teeth/*` deliberately breaks
 * the pipeline in-memory and asserts that this suite's own checkers reject it.
 */

import { isProvenanceConsistent } from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type { EventProvenance } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Binding to the shipped mapper
// ---------------------------------------------------------------------------

/**
 * Non-literal specifier: keeps `convex/` out of `tests/tsconfig.json`'s program
 * (the same reason `otel_ordering_adversarial.test.ts` does it), so this file
 * does not have to buy into `tests/tsconfig.convex-seam.json`.
 */
const MAPPER_MODULE = '../../convex/helpers/otel_mapping.js'

interface TemporalOrderKey {
  instantUnixNano: string
  rawInstantUnixNano: string
  phase: 'open' | 'close'
  depth: number
  spanId: string
}

interface DerivedEventWrite {
  type: string
  sequenceNumber: number
  timestamp: number
  payload: Record<string, unknown> & { type: string }
  parentEventIndex?: number
  provenance: EventProvenance & { spanId: string; traceId: string }
  spanId: string
  temporalOrder: TemporalOrderKey
}

interface MapResult {
  ok: boolean
  traceId: string | null
  events: DerivedEventWrite[]
  runOpen: boolean
  terminalType: string | null
  unmapped: Array<{ spanId: string; reason: string; eventIndex: number }>
  rejected: Array<{ spanId: string; reason: string }>
  diagnostics: Array<{ code: string; fatal: boolean; spanIds: string[]; message: string }>
  stats: {
    spansIn: number
    spansAccepted: number
    spansMapped: number
    spansUnmapped: number
    spansRejected: number
    eventsOut: number
    clockSkewClamps: number
  }
}

interface SpanInput {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind?: string
  startTimeUnixNano: string | number | bigint
  endTimeUnixNano?: string | number | bigint
  attributes?: Record<string, unknown>
  status?: { code: number | 'unset' | 'ok' | 'error'; message?: string }
  schemaUrl?: string
  spanEventCount?: number
  spanLinkCount?: number
}

interface MapOptions {
  receivedAt?: number
  lastSequenceNumber?: number
  knownSpanIds?: readonly string[]
  /** True when a terminal event is ALREADY stored for this run. */
  hasTerminal?: boolean
  /** `"defer"` is what a multi-batch ingest path MUST pass. */
  terminalPolicy?: 'batch' | 'defer'
  /** Recorded effective start (decimal ns) of parents named by this batch but absent from it. */
  parentAnchors?: Readonly<Record<string, { instantUnixNano: string; inferred: boolean }>>
}

interface MapperModule {
  mapOtelSpansToEvents: (spans: readonly SpanInput[], options?: MapOptions) => MapResult
  mapTraceToEvents: (input: unknown, options?: MapOptions) => MapResult
  compareTemporalOrder: (a: TemporalOrderKey, b: TemporalOrderKey) => number
  verifySpanConservation: (
    spans: readonly SpanInput[],
    events: readonly DerivedEventWrite[],
  ) => { ok: boolean; missingSpanIds: string[] }
  MAPPER_VERSION: string
}

const RUN_FIELDS_MODULE = '../../convex/helpers/run_fields.js'
const runFields = (await import(RUN_FIELDS_MODULE)) as {
  tallyDerivedOrdering: (events: ReadonlyArray<unknown>) => { derived: number; unkeyed: number }
}
/** The SHIPPED tally, not a copy — a reimplementation here would agree with itself and prove nothing. */
const tallyDerived = runFields.tallyDerivedOrdering

const loaded = (await import(MAPPER_MODULE)) as Partial<MapperModule>

const mapper: MapperModule = {
  mapOtelSpansToEvents: loaded.mapOtelSpansToEvents as MapperModule['mapOtelSpansToEvents'],
  mapTraceToEvents: loaded.mapTraceToEvents as MapperModule['mapTraceToEvents'],
  compareTemporalOrder: loaded.compareTemporalOrder as MapperModule['compareTemporalOrder'],
  verifySpanConservation: loaded.verifySpanConservation as MapperModule['verifySpanConservation'],
  MAPPER_VERSION: loaded.MAPPER_VERSION as string,
}

// ---------------------------------------------------------------------------
// The defect ledger
// ---------------------------------------------------------------------------

/**
 * Defects this suite has CONFIRMED against the current tree. Each entry is
 * produced by a real assertion failure inside a real attack, not by a comment.
 *
 * Sorted, compared as a set at the end of the file. Adding an entry here
 * without a case that emits it fails `ledger/no-phantom-entries`.
 */
const KNOWN_DEFECTS = [
  // D6 RETIRED: the mapper now rejects before the emission stage and returns
  // `emptyResult`, so every otherwise-acceptable span is reported
  // `after-terminal` and the ingest reaches its per-span path. Both arms — and
  // the already-known/after-terminal distinction — pinned below.
  // R2b RETIRED: the marker now propagates over the whole subtree, and
  // `parentAnchors` carries `inferred` so it propagates ACROSS batches too.
  // D3 RETIRED 2026-07-25. `MAX_UNMAPPED_ATTRIBUTE_BYTES` (8 KB) now bounds the
  // unmapped attribute bag below the mutation's 10 KB inline limit, verified
  // independently: the oversized span's payload measures 6365 bytes and the
  // innocent span travelling with it is ingested. The regression guard that
  // replaced it is `conservation/an oversized unmapped span is bounded...`.
  //
  // D4 RETIRED and REPLACED BY D4b, NOT simply deleted — see below.
  //
  // D4b RETIRED 2026-07-25. `readBoundedContent` now routes all four mapped
  // content fields through `boundValueDepth`, and `payloadBytes` no longer
  // throws. Verified at 200k depth on all four fields independently.
  //
  // D5 RETIRED AS WRITTEN, AND REPLACED — not simply deleted. `terminalPolicy:
  // "defer"` plus the settle mutation genuinely fixed the convergence failure I
  // reported: four of six trace shapes now converge exactly, and the two that
  // do not fail for reasons that are NOT the one D5 named. Those two are R1 and
  // R2 below. Retiring D5 without them would have been a retirement on symptom.
  // R1 RETIRED: `runs.otelMaxInstantNano` (a running max at append time) makes
  // the terminal instant a function of the event SET, not of append order.
  // R3 RETIRED: `identity-synthesized` is now unconditional on the anchor,
  // verified on the two-true-roots shape that was the original counterexample.
  // R2 PARTLY fixed (`parentAnchors` closes the parent-first arm) and replaced
  // by R2b — NOT retired, because the disclosure the residue depends on does
  // not reach descendants.
] as const

const observedDefects = new Set<string>()

/**
 * Run an assertion that is EXPECTED to hold once `id` is fixed. If it holds,
 * nothing is recorded. If it does not, `id` is recorded.
 *
 * Deliberately NOT a try/catch around `expect`: `check` must return a boolean
 * the case computed itself, so "the assertion did not run" is not silently
 * indistinguishable from "the assertion passed". `expectDefect` asserts the
 * boolean is a boolean.
 *
 * `id` is `string`, not `(typeof KNOWN_DEFECTS)[number]`. With the ledger empty
 * that union is `never`, which would make the helper uncallable — including by
 * the case that proves it still works. A typo is still caught, just at run time
 * rather than compile time: an id recorded but not listed shows up as
 * `regressed` in the exact-set assertion below, which is red either way.
 *
 * `sink` exists so the apparatus can be tested with the REAL function instead
 * of a lookalike, without writing into the live ledger. Nothing but `teeth/*`
 * passes it.
 */
function expectDefect(id: string, holds: boolean, sink: Set<string> = observedDefects): void {
  expect(typeof holds, `defect probe ${id} produced a non-boolean verdict`).toBe('boolean')
  if (!holds) sink.add(id)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRACE_A = '1'.repeat(32)
const TRACE_B = '2'.repeat(32)
const RECEIVED_AT = 1_750_000_000_000

/** W3C-shaped 16-hex span id from a short mnemonic. */
function sid(name: string): string {
  const hex = [...name].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return (hex + '0'.repeat(16)).slice(0, 16)
}

const MS = 1_000_000n
function ns(ms: bigint): string {
  return (ms * MS).toString()
}

function llmSpan(o: Partial<SpanInput> & { spanId: string }): SpanInput {
  return {
    traceId: TRACE_A,
    name: 'chat model',
    kind: 'internal',
    startTimeUnixNano: ns(1n),
    endTimeUnixNano: ns(2n),
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'model-x' },
    ...o,
  }
}

function agentSpan(o: Partial<SpanInput> & { spanId: string }): SpanInput {
  return {
    traceId: TRACE_A,
    name: 'invoke_agent orchestrator',
    kind: 'internal',
    startTimeUnixNano: ns(0n),
    endTimeUnixNano: ns(100n),
    attributes: { 'gen_ai.operation.name': 'invoke_agent' },
    ...o,
  }
}

// ---------------------------------------------------------------------------
// ReferenceIngest — the append-only store the mapper must compose with
// ---------------------------------------------------------------------------

type Disposition =
  | { kind: 'mapped'; sequenceNumbers: number[] }
  | { kind: 'unmapped'; sequenceNumbers: number[] }
  | { kind: 'rejected'; reason: string }
  | { kind: 'refused'; reason: string }

interface StoredEvent {
  type: string
  sequenceNumber: number
  timestamp: number
  payload: Record<string, unknown>
  provenance: EventProvenance & { spanId: string; traceId: string }
  /**
   * The mapper emits `temporalOrder`, and `convex/schema.ts` has nowhere to put
   * it. The store keeps it anyway so the round-trip can be measured at all;
   * `conservation/temporal-order-is-storable` is what reports the gap.
   */
  temporalOrder: TemporalOrderKey
}

interface BatchReport {
  /** Every input span id -> exactly one disposition. */
  disposition: Map<string, Disposition>
  /** Input span ids with NO disposition at all. Must always be empty. */
  unaccounted: string[]
  refusal?: string
  mapResult: MapResult
}

/**
 * A run being assembled from OTLP batches, enforcing the gates
 * `convex/sdk_ingest.ts` actually enforces today.
 */
class ReferenceIngest {
  readonly events: StoredEvent[] = []
  private known: string[] = []
  private terminated = false
  /**
   * `runs.status !== "running"` with NO terminal event appended — the state
   * `convex/stale_runs.ts` leaves behind. The run is just as closed, but
   * `hasTerminalEvent` is false, so a gate keyed only on the terminal EVENT
   * misses it entirely.
   */
  private statusClosed = false
  private root: { startNs: bigint; endNs: bigint; spanId: string; status: 'ok' | 'error' } | undefined
  /**
   * Recorded effective open instant per span — the `by_run_span` probe the
   * mutation performs. `inferred` carries whether that recorded instant was
   * ITSELF unverified when written, which is what stops a cross-batch clamp
   * producing a child that looks verified while resting on a movable value.
   */
  private anchors: Record<string, { instantUnixNano: string; inferred: boolean }> = {}
  /** `runs.otelMaxInstantNano`: a running max over every appended event. */
  private maxInstantNs = 0n
  /** `runs.derivedEventCount` / `runs.otelUnkeyedDerivedCount`, maintained incrementally at BOTH write sites. */
  counters = { derived: 0, unkeyed: 0 }
  readonly batches: BatchReport[] = []

  /**
   * `convex/otel_settle.ts`, modelled. Called once the trace has gone quiet.
   *
   * Terminality is NOT a per-batch decision — "every span is closed" is a fact
   * about a batch and says nothing about a trace. The terminal is appended once,
   * here, from `otelRoot`, which converges because a strictly-better root
   * replaces the recorded one.
   */
  settle(): { settled: boolean; reason?: string } {
    if (this.terminated) return { settled: false, reason: 'already-terminal' }
    if (this.root === undefined) return { settled: false, reason: 'no-closed-root' }

    const last = this.events[this.events.length - 1]
    // R1's fix: `runs.otelMaxInstantNano`, a running max maintained at append
    // time. A function of the event SET rather than of append order, so it
    // converges — and unlike scanning the run it costs nothing at the 50k
    // MAX_EVENTS_PER_RUN ceiling.
    const instantNs = this.root.endNs > this.maxInstantNs ? this.root.endNs : this.maxInstantNs
    const type = this.root.status === 'error' ? 'run.failed' : 'run.completed'

    this.events.push({
      type,
      sequenceNumber: (last?.sequenceNumber ?? 0) + 1,
      timestamp: Number(instantNs / 1_000_000n),
      payload: { type },
      provenance: {
        source: 'otel',
        traceId: TRACE_A,
        spanId: this.root.spanId,
        spanName: 'settled',
        semconvVersion: 'x',
        mapperVersion: 'x',
        lossy: true,
        lossReasons: ['identity-synthesized', 'timing-approximated'],
        receivedAt: RECEIVED_AT,
      } as StoredEvent['provenance'],
      temporalOrder: {
        instantUnixNano: instantNs.toString(),
        rawInstantUnixNano: this.root.endNs.toString(),
        phase: 'close',
        depth: -1,
        spanId: this.root.spanId,
      },
    })
    // The SECOND write site. A denormalized counter maintained by two
    // hand-rolled tallies is worse than no counter, so both go through the
    // same helper.
    const tally = tallyDerived([this.events[this.events.length - 1] as StoredEvent])
    this.counters.derived += tally.derived
    this.counters.unkeyed += tally.unkeyed
    this.terminated = true
    return { settled: true }
  }

  /**
   * Ingest one batch, mirroring `convex/otel_ingest.ts`.
   *
   * THE TWO OPTIONS BELOW ARE LOAD-BEARING AND WERE ONCE MISSING HERE.
   * The mutation passes `terminalPolicy: "defer"` and `hasTerminal`; an earlier
   * revision of this driver passed neither, so it exercised the `"batch"`
   * default — a code path the shipping mutation no longer uses. Every D5/D6/D7
   * verdict this file produced in that state was grading a function that does
   * not ship. `driver-parity/*` below now asserts both are accepted, so the
   * omission cannot recur silently.
   */
  private runMapping(spans: readonly SpanInput[], skip: ReadonlySet<string>): MapResult {
    const kept = skip.size === 0 ? spans : spans.filter((s) => !skip.has(s.spanId))
    // The mutation probes `by_run_span` for parents this batch names but does
    // not carry, and hands the mapper their recorded effective start.
    const parentAnchors: Record<string, { instantUnixNano: string; inferred: boolean }> = {}
    for (const span of kept) {
      const parent = span.parentSpanId
      if (parent === undefined || parent === '') continue
      if (kept.some((o) => o.spanId === parent)) continue
      const recorded = this.anchors[parent]
      if (recorded !== undefined) parentAnchors[parent] = recorded
    }
    return mapper.mapOtelSpansToEvents(kept, {
      parentAnchors,
      receivedAt: RECEIVED_AT,
      lastSequenceNumber:
        this.events.length === 0 ? 0 : (this.events[this.events.length - 1] as StoredEvent).sequenceNumber,
      knownSpanIds: [...this.known],
      // `runIsClosed = hasTerminalEvent || run.status !== "running"` in
      // convex/otel_ingest.ts. Keyed on BOTH, because the stale sweep closes a
      // run without appending anything.
      hasTerminal: this.terminated || this.statusClosed,
      terminalPolicy: 'defer',
    })
  }

  /** The stale sweep: status closed, nothing appended. No terminal event exists. */
  markTimedOutByStaleSweep(): void {
    this.statusClosed = true
  }

  /** True when the run is closed by either route. */
  get closed(): boolean {
    return this.terminated || this.statusClosed
  }

  /**
   * `injected` exists ONLY for `teeth/*`, which must be able to drive the
   * post-terminal gate directly. The gate is unreachable through the real
   * mapper (it rejects before emitting), and a self-test that cannot fire is
   * not a self-test. Nothing else passes this.
   */
  ingest(spans: readonly SpanInput[], injected?: MapResult): BatchReport {
    // The mutation's re-map-with-exclusions loop: a span whose derived payload
    // cannot be stored inline is excluded BY ID and the batch is re-mapped, so
    // sequence numbers stay contiguous rather than gapped.
    // The mutation rejects malformed W3C ids PER SPAN, before the mapper sees
    // them (convex/otel_ingest.ts, the SPAN_ID_RE gate). Modelled here or the
    // driver would grade the mapper for a check it deliberately delegates.
    const SPAN_ID_RE = /^[0-9a-f]{16}$/
    const malformed = spans.filter(
      (s) =>
        !SPAN_ID_RE.test(s.spanId) ||
        (s.parentSpanId !== undefined && s.parentSpanId !== '' && !SPAN_ID_RE.test(s.parentSpanId)),
    )
    const usable = spans.filter((s) => !malformed.includes(s))

    const excluded = new Set<string>()
    let result = injected ?? this.runMapping(usable, excluded)
    for (let pass = 1; injected === undefined && pass < 4; pass += 1) {
      const offenders = [
        ...new Set(
          result.events
            .filter((e) => Buffer.byteLength(JSON.stringify(e.payload), 'utf8') > 10 * 1024)
            .map((e) => e.provenance.spanId),
        ),
      ]
      if (offenders.length === 0) break
      for (const id of offenders) excluded.add(id)
      result = this.runMapping(usable, excluded)
    }

    const disposition = new Map<string, Disposition>()
    const inputIds = spans.map((s) => s.spanId)

    const refuse = (reason: string): BatchReport => {
      for (const id of inputIds) disposition.set(id, { kind: 'refused', reason })
      const report: BatchReport = { disposition, unaccounted: [], refusal: reason, mapResult: result }
      this.batches.push(report)
      return report
    }

    // GATE 1 — a fatal mapper diagnostic means the batch must not be ingested.
    if (!result.ok) return refuse('mapper-fatal')

    // GATE 2 — provenance is validated BEFORE anything enters an append-only
    // table (contracts/src/provenance.ts says exactly this).
    const badProvenance = result.events.filter((e) => !isProvenanceConsistent(e.provenance))
    if (badProvenance.length > 0) return refuse('malformed-provenance')

    if (result.events.length > 0) {
      // GATE 3 — Event Log Rule 5: nothing may be appended once the run is
      // closed, by EITHER route. Keyed on `closed`, not on `terminated`,
      // because the stale sweep closes a run without appending a terminal.
      //
      // TRIPWIRE, not a live path. The mapper rejects post-terminal spans
      // before emitting, so this is unreachable in normal operation — kept
      // because a future mapper change that starts emitting again would
      // otherwise write past a terminal with nothing to stop it.
      // `teeth/*` drives it with synthetic events AND asserts its
      // unreachability, so it cannot rot into decoration.
      if (this.closed) return refuse('RUN_NOT_ACTIVE')

      // GATE 4 — Event Log Rule 4: strict `maxSeq + 1` contiguity.
      const maxSeq = this.events.length === 0 ? 0 : (this.events[this.events.length - 1] as StoredEvent).sequenceNumber
      const contiguous = result.events.every((e, i) => e.sequenceNumber === maxSeq + i + 1)
      if (!contiguous) return refuse('SEQUENCE_CONFLICT')

      // GATE 5 — Event Log Rule 5: the run's first event is `run.started`.
      if (maxSeq === 0 && (result.events[0] as DerivedEventWrite).type !== 'run.started') {
        return refuse('INVALID_FIRST_EVENT')
      }

      // GATE 6 — Event Log Rule 3. The exclusion loop above should already have
      // removed every unstorable span, so reaching here means the loop failed
      // to converge and whole-batch refusal is the only honest outcome.
      if (result.events.some((e) => Buffer.byteLength(JSON.stringify(e.payload), 'utf8') > 10 * 1024)) {
        return refuse('PAYLOAD_TOO_LARGE')
      }
    }

    // Commit.
    for (const e of result.events) {
      this.events.push({
        type: e.type,
        sequenceNumber: e.sequenceNumber,
        timestamp: e.timestamp,
        payload: e.payload,
        provenance: e.provenance,
        temporalOrder: e.temporalOrder,
      })
      if (e.type === 'run.completed' || e.type === 'run.failed') this.terminated = true
      if (!this.known.includes(e.spanId)) this.known.push(e.spanId)
      if (e.temporalOrder.phase === 'open' && this.anchors[e.spanId] === undefined) {
        const reasons = (e.provenance as { lossReasons?: string[] }).lossReasons ?? []
        this.anchors[e.spanId] = {
          instantUnixNano: e.temporalOrder.instantUnixNano,
          inferred: reasons.includes('timing-approximated'),
        }
      }
      const instant = BigInt(e.temporalOrder.instantUnixNano)
      if (instant > this.maxInstantNs) this.maxInstantNs = instant
    }
    {
      const tally = tallyDerived(result.events)
      this.counters.derived += tally.derived
      this.counters.unkeyed += tally.unkeyed
    }

    const unmappedIds = new Set(result.unmapped.map((u) => u.spanId))
    for (const e of result.events) {
      const id = e.provenance.spanId
      if (!inputIds.includes(id)) continue
      const prior = disposition.get(id)
      const kind = unmappedIds.has(id) ? 'unmapped' : 'mapped'
      const seqs = prior && (prior.kind === 'mapped' || prior.kind === 'unmapped') ? prior.sequenceNumbers : []
      disposition.set(id, { kind, sequenceNumbers: [...seqs, e.sequenceNumber] })
    }
    for (const r of result.rejected) {
      if (!disposition.has(r.spanId)) disposition.set(r.spanId, { kind: 'rejected', reason: r.reason })
    }
    for (const bad of malformed) {
      if (!disposition.has(bad.spanId)) disposition.set(bad.spanId, { kind: 'rejected', reason: 'malformed-id' })
    }
    // The mutation reports every excluded span as `payload-too-large`.
    for (const id of excluded) {
      if (!disposition.has(id)) disposition.set(id, { kind: 'rejected', reason: 'payload-too-large' })
    }

    // `otelRoot` tracking, mirroring convex/otel_ingest.ts. Ingest state, not
    // log content: a strictly-better root arriving later REPLACES the recorded
    // one, which is what makes the settle's outcome independent of arrival.
    for (const span of spans) {
      const isTrueRoot =
        span.parentSpanId === undefined || span.parentSpanId === '' || span.parentSpanId === span.spanId
      if (!isTrueRoot) continue
      if (span.endTimeUnixNano === undefined) continue
      const endNs = BigInt(String(span.endTimeUnixNano))
      if (endNs <= 0n) continue
      const startNs = BigInt(String(span.startTimeUnixNano))
      const better =
        this.root === undefined ||
        startNs < this.root.startNs ||
        (startNs === this.root.startNs && span.spanId < this.root.spanId)
      if (better) this.root = { startNs, endNs, spanId: span.spanId, status: span.status?.code === 'error' ? 'error' : 'ok' }
    }

    const unaccounted = [...new Set(inputIds)].filter((id) => !disposition.has(id)).sort()
    const report: BatchReport = { disposition, unaccounted, mapResult: result }
    this.batches.push(report)
    return report
  }

  /** THE ROUND TRIP: the log read back in the order it claims things happened. */
  replayTemporal(): StoredEvent[] {
    return [...this.events].sort((a, b) => mapper.compareTemporalOrder(a.temporalOrder, b.temporalOrder))
  }

  /** What replay does TODAY (apps/web/src/lib/replay/projection.ts sorts by sequenceNumber). */
  replayBySequence(): StoredEvent[] {
    return [...this.events].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
  }
}

/**
 * The equivalence class a round trip must preserve: which spans produced which
 * event types at which instants. Deliberately NOT the whole event — payload
 * detail is allowed to differ between a span read alone and the same span read
 * next to its parent (the boundary-folding rule). Type, span and instant are
 * not.
 */
function canonicalTrace(
  events: readonly StoredEvent[],
  options: { excludeSynthesizedAnchor?: boolean } = {},
): string[] {
  const kept = options.excludeSynthesizedAnchor === true ? events.filter((e) => !isSynthesizedAnchor(e)) : events
  return kept
    .map((e) => `${e.type}@${e.provenance.spanId}@${e.temporalOrder.instantUnixNano}@${e.temporalOrder.phase}`)
    .sort()
}

/**
 * The ONE event whose identity is a function of insertion history rather than
 * of the trace: the synthesized `run.started` anchor.
 *
 * OTel has no run-start concept, so `run.started` is invented at ingest and
 * anchored to the earliest span the run has seen SO FAR. Which span that is
 * depends on which batch arrived first, and under an append-only log the anchor
 * cannot be re-pointed once written. See `residue/*` for whether excluding it
 * is honest and minimal — that question is not assumed here, it is tested.
 */
function isSynthesizedAnchor(e: StoredEvent): boolean {
  return e.type === 'run.started' && e.temporalOrder.depth === -1
}

/** Ordered partitions of `items` into `parts` non-empty contiguous batches. */
function splits<T>(items: readonly T[]): T[][][] {
  const out: T[][][] = []
  const n = items.length
  for (let mask = 0; mask < 1 << (n - 1); mask += 1) {
    const batches: T[][] = []
    let current: T[] = [items[0] as T]
    for (let i = 1; i < n; i += 1) {
      if (mask & (1 << (i - 1))) {
        batches.push(current)
        current = []
      }
      current.push(items[i] as T)
    }
    batches.push(current)
    out.push(batches)
  }
  return out
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const p of permutations(rest)) out.push([items[i] as T, ...p])
  }
  return out
}

// ===========================================================================
// 0. Anti-vacuity: the binding itself
// ===========================================================================

describe('binding — the suite is attached to the shipped mapper', () => {
  it('convex/helpers/otel_mapping exports every entry point this suite drives', () => {
    for (const name of [
      'mapOtelSpansToEvents',
      'mapTraceToEvents',
      'compareTemporalOrder',
      'verifySpanConservation',
    ] as const) {
      expect(
        typeof mapper[name],
        `convex/helpers/otel_mapping must export ${name}; this suite grades the SHIPPED mapper and does not skip when it is absent`,
      ).toBe('function')
    }
    expect(typeof mapper.MAPPER_VERSION).toBe('string')
  })

  it('the mapper reports temporalOrder and span attribution on every event', () => {
    const r = mapper.mapOtelSpansToEvents(
      [agentSpan({ spanId: sid('r') }), llmSpan({ spanId: sid('c'), parentSpanId: sid('r') })],
      { receivedAt: RECEIVED_AT },
    )
    expect(r.events.length).toBeGreaterThan(0)
    expect(
      r.events.every((e) => typeof e.provenance.spanId === 'string' && e.provenance.spanId.length > 0),
      'without span attribution every conservation case below is vacuous',
    ).toBe(true)
    expect(
      r.events.every((e) => typeof e.temporalOrder?.instantUnixNano === 'string'),
      'without temporalOrder every round-trip ordering case below is vacuous',
    ).toBe(true)
  })
})

// ===========================================================================
// 1. CONSERVATION
// ===========================================================================

describe('conservation — every span in is accounted for on the way out', () => {
  it('a well-formed single-batch trace loses nothing', () => {
    const spans = [
      agentSpan({ spanId: sid('r') }),
      llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(20n) }),
      llmSpan({ spanId: sid('b'), parentSpanId: sid('r'), startTimeUnixNano: ns(30n), endTimeUnixNano: ns(40n) }),
    ]
    const run = new ReferenceIngest()
    const report = run.ingest(spans)
    expect(report.unaccounted, 'a span went in and got no disposition at all').toEqual([])
    expect(report.refusal).toBeUndefined()
    for (const s of spans) {
      expect(report.disposition.get(s.spanId)?.kind, `span ${s.spanId} vanished`).toBe('mapped')
    }
    expect(mapper.verifySpanConservation(spans, report.mapResult.events).ok).toBe(true)
  })

  it('an unmapped span is RECORDED, never dropped', () => {
    const span: SpanInput = {
      traceId: TRACE_A,
      spanId: sid('u'),
      name: 'something nobody has a rule for',
      startTimeUnixNano: ns(1n),
      endTimeUnixNano: ns(2n),
      attributes: { 'vendor.private.thing': 1 },
    }
    const run = new ReferenceIngest()
    const report = run.ingest([span])
    expect(report.disposition.get(span.spanId)?.kind).toBe('unmapped')
    expect(run.events.some((e) => e.type === 'otel.span.unmapped')).toBe(true)
  })

  it('a foreign-trace span is REJECTED explicitly, not numbered into this run', () => {
    const own = agentSpan({ spanId: sid('r') })
    const other = llmSpan({ spanId: sid('x'), traceId: TRACE_B })
    const run = new ReferenceIngest()
    const report = run.ingest([own, own, other])
    expect(report.disposition.get(other.spanId)).toEqual({ kind: 'rejected', reason: 'foreign-trace' })
    expect(run.events.every((e) => e.provenance.spanId !== other.spanId)).toBe(true)
  })

  /**
   * ATTACK 1's headline: construct a span that is NONE of mapped / unmapped /
   * rejected. Two distinct spans sharing a blank span id collide in
   * `dedupeSpans`; the survivor is reported as `mapped` and the casualty is
   * reported as `duplicate` under the SAME id, so no consumer can tell that a
   * second, DIFFERENT span existed at all.
   */
  it('[D8] two distinct spans sharing one id: the casualty is indistinguishable', () => {
    const s1: SpanInput = { traceId: TRACE_A, spanId: '', name: 'first', startTimeUnixNano: ns(1n), endTimeUnixNano: ns(2n) }
    const s2: SpanInput = { traceId: TRACE_A, spanId: '', name: 'second', startTimeUnixNano: ns(5n), endTimeUnixNano: ns(6n) }
    const result = mapper.mapOtelSpansToEvents([s1, s2], { receivedAt: RECEIVED_AT })

    // D8 RETIRED — the finding was never "the content survives" (with one id for
    // two spans it cannot), it was "the loss is INDISTINGUISHABLE from a
    // harmless retry". That is what is now fixed: the casualty is reported
    // under its own reason code, so a reader can tell a lost OPERATION from a
    // deduplicated redelivery. Verified here rather than taken on report.
    const reasons = result.rejected.map((r) => r.reason)
    expect(
      reasons,
      'a span lost to an id collision is still reported as `duplicate`, which reads as a harmless retry',
    ).toContain('span-id-collision')
    expect(reasons, 'an id collision must NOT be filed as an ordinary duplicate').not.toContain('duplicate')
    expect(result.stats.spansRejected, 'the casualty must be counted, not just named').toBe(1)
    expect(result.stats.spansIn).toBe(2)

    // And a genuine byte-identical redelivery must NOT be filed as a collision,
    // or the new code distinguishes nothing and has merely swapped labels.
    const same = llmSpan({ spanId: sid('d') })
    const redelivered = mapper.mapOtelSpansToEvents([same, same], { receivedAt: RECEIVED_AT })
    expect(
      redelivered.rejected,
      'a byte-identical redelivery is reported as a lost operation — the collision signal is now noise',
    ).toEqual([])
  })

  /**
   * ATTACK 1, arithmetic form. `spansIn` must equal what was accepted plus what
   * was rejected. With three copies of one span id it does not: `rejected`
   * carries the ID once, never the COPIES.
   */
  it('span accounting balances as an identity', () => {
    const s = llmSpan({ spanId: sid('d') })
    for (const copies of [2, 3, 5, 17]) {
      const r = mapper.mapOtelSpansToEvents(Array.from({ length: copies }, () => s), { receivedAt: RECEIVED_AT })
      // A byte-identical redelivery is not a LOSS, so it is correctly not
      // filed under `rejected`. What must hold is that every DISTINCT span id
      // is accounted for, and that repeated delivery is a pure no-op.
      expect(r.stats.spansIn, 'spansIn must count what the caller actually sent').toBe(copies)
      expect(r.stats.spansAccepted, 'identical copies must collapse to one accepted span').toBe(1)
      expect(r.rejected, 'an identical redelivery is a no-op, not a rejection').toEqual([])
      expect(r.stats.eventsOut, 'copies changed the event count').toBe(4)
    }
    // Mixed causes in one batch, so the identity is not holding by accident on
    // a single rejection reason.
    const mixed = mapper.mapOtelSpansToEvents(
      [s, s, llmSpan({ spanId: sid('e'), traceId: TRACE_B }), llmSpan({ spanId: sid('f') })],
      { receivedAt: RECEIVED_AT },
    )
    // Distinct ids: every one is either accepted or rejected, none unaccounted.
    const seen = new Set([
      ...mixed.events.map((e) => e.provenance.spanId),
      ...mixed.rejected.map((r) => r.spanId),
    ])
    expect([...seen].sort()).toEqual([sid('d'), sid('e'), sid('f')].sort())
  })

  /**
   * REGRESSION GUARD, not a defect.
   *
   * `out[key] = value` invokes `Object.prototype`'s `__proto__` SETTER for that
   * one key: it sets the object's prototype and creates NO own property, so the
   * attribute vanishes from the payload while `attributesTruncated` stays false
   * — a silent drop plus a caller-controlled prototype handed to every reader.
   * `boundAttributes` goes through `defineProperty` to avoid it.
   *
   * The fixture MUST come from `JSON.parse`, which is how a real OTLP/JSON body
   * reaches us and which creates a genuine own `__proto__` key. An object
   * LITERAL cannot reproduce the case at all (`__proto__:` there is also the
   * setter), so a literal-based fixture shows nothing wrong whether or not the
   * bug is present. This suite reported exactly that false negative once.
   */
  it('a __proto__ attribute key survives into the unmapped payload', () => {
    const span: SpanInput = {
      traceId: TRACE_A,
      spanId: sid('p'),
      name: 'no rule for this',
      startTimeUnixNano: ns(1n),
      endTimeUnixNano: ns(2n),
      attributes: JSON.parse('{"__proto__": {"leaked": true}, "ordinary": 1}') as Record<string, unknown>,
    }
    const r = mapper.mapOtelSpansToEvents([span], { receivedAt: RECEIVED_AT })
    const ev = r.events.find((e) => e.type === 'otel.span.unmapped')
    expect(ev, 'the unmapped span was not recorded at all').toBeDefined()
    const attrs = (ev as DerivedEventWrite).payload.attributes as Record<string, unknown>
    // Anti-vacuity: prove the fixture really carries the hostile key, so this
    // case cannot pass by having constructed a harmless object.
    expect(
      Object.prototype.hasOwnProperty.call(span.attributes, '__proto__'),
      'the fixture lost __proto__ before the mapper saw it — this case proves nothing',
    ).toBe(true)
    // Implementation-agnostic: the VALUE must be recoverable under some own,
    // enumerable key. `convex/helpers/otel_mapping.ts` currently escapes the
    // key (Convex reserves `__proto__` and `$`-prefixed field names), which is
    // conservation; dropping it, or leaving it as a prototype, is not.
    const recovered = Object.entries(attrs).filter(([k]) => k === '__proto__' || k.endsWith('__proto__'))
    expect(
      recovered,
      'a __proto__ span attribute did not survive into the stored payload under any key',
    ).toHaveLength(1)
    expect((recovered[0] as [string, unknown])[1]).toEqual({ leaked: true })
    expect(Object.prototype.hasOwnProperty.call(attrs, 'ordinary'), 'ordinary attributes must still survive').toBe(true)
    // And it must be a plain data property, not a prototype handed to readers.
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype)
    // The escape must be JSON-round-trippable, or storage undoes the rescue.
    expect(JSON.parse(JSON.stringify(attrs))).toEqual(attrs)
  })

  /**
   * Event Log Rule 3: any payload over 10 KB must be externalized to blob
   * storage, the event keeping only a pointer. `MAX_UNMAPPED_ATTRIBUTES` (128)
   * x `MAX_ATTRIBUTE_STRING_LENGTH` (2048) admits a ~256 KB inline payload and
   * nothing externalizes it.
   */
  it('an oversized unmapped span is bounded, and does not cost the whole batch', () => {
    const attributes: Record<string, unknown> = {}
    for (let i = 0; i < 200; i += 1) attributes[`vendor.attr.${i}`] = 'z'.repeat(5000)
    const fat: SpanInput = { traceId: TRACE_A, spanId: sid('big'), name: 'unmappable', startTimeUnixNano: ns(1n), endTimeUnixNano: ns(2n), attributes }

    // ANTI-VACUITY: the fixture must genuinely be oversized at the SOURCE, or
    // this guard passes because the input was harmless rather than because the
    // bound worked. 200 attributes x 5000 chars ~= 1 MB of raw attribute text.
    const rawBytes = JSON.stringify(attributes).length
    expect(rawBytes, 'the fixture is not actually oversized').toBeGreaterThan(500_000)

    const solo = mapper.mapOtelSpansToEvents([fat], { receivedAt: RECEIVED_AT })
    const ev = solo.events.find((e) => e.type === 'otel.span.unmapped') as DerivedEventWrite
    const bytes = Buffer.byteLength(JSON.stringify(ev.payload), 'utf8')

    // `MAX_UNMAPPED_ATTRIBUTE_BYTES` (8 KB) must keep the payload under
    // `MAX_INLINE_PAYLOAD_BYTES` (10 KB) in convex/otel_ingest.ts, which cannot
    // externalize from inside a mutation and therefore refuses instead.
    expect(bytes, 'the unmapped payload is over the inline limit the mutation enforces').toBeLessThanOrEqual(10 * 1024)
    expect(ev.payload.attributesTruncated, 'a payload that WAS bounded must say so').toBe(true)

    // And the innocent span travelling with it must survive.
    const run = new ReferenceIngest()
    const innocent = llmSpan({ spanId: sid('ok'), startTimeUnixNano: ns(3n), endTimeUnixNano: ns(4n) })
    const report = run.ingest([fat, innocent])
    expect(report.refusal, 'one fat span still costs the whole batch').toBeUndefined()
    expect(report.disposition.get(innocent.spanId)?.kind).toBe('mapped')
    expect(report.disposition.get(fat.spanId)?.kind).toBe('unmapped')
    expect(report.unaccounted).toEqual([])
  })

  /**
   * The mapper's whole ordering ruling rests on `temporalOrder`, and
   * `convex/schema.ts`'s `events` table has no column for it. A round trip
   * through storage therefore loses the temporal truth entirely and replay has
   * nothing to sort by.
   */
  it('[D10] temporalOrder has somewhere to be stored', async () => {
    const schema = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../convex/schema.ts', import.meta.url), 'utf8'),
    )
    const eventsTable = schema.slice(schema.indexOf('events: defineTable('), schema.indexOf('artifacts: defineTable('))
    expect(eventsTable.length, 'failed to locate the events table in convex/schema.ts').toBeGreaterThan(100)
    // Source-scraped, and therefore weak — kept only as a fast locator. The
    // BINDING check is the executable round trip in `storage round trip/*`,
    // which drives contracts' real `readTemporalOrder` over the exact shape
    // convex/otel_ingest.ts writes.
    expect(
      /temporalOrder/.test(eventsTable),
      'convex/schema.ts events table has no temporalOrder column',
    ).toBe(true)
  })
})

// ===========================================================================
// 2. IDEMPOTENCY UNDER RETRY
// ===========================================================================

describe('idempotency — OTLP exporters retry at-least-once', () => {
  const trace = [
    agentSpan({ spanId: sid('r') }),
    llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(20n) }),
    llmSpan({ spanId: sid('b'), parentSpanId: sid('r'), startTimeUnixNano: ns(30n), endTimeUnixNano: ns(40n) }),
  ]

  it('the same batch twice produces the second time NOTHING', () => {
    const run = new ReferenceIngest()
    run.ingest(trace)
    const before = run.events.length
    const second = run.ingest(trace)
    expect(second.mapResult.events, 'a redelivered batch permanently doubled the run').toEqual([])
    expect(run.events.length).toBe(before)
    for (const s of trace) {
      expect(second.disposition.get(s.spanId)).toEqual({ kind: 'rejected', reason: 'already-known' })
    }
  })

  it('the same batch three times is still ingested once', () => {
    const run = new ReferenceIngest()
    run.ingest(trace)
    const after = run.events.length
    run.ingest(trace)
    run.ingest(trace)
    expect(run.events.length).toBe(after)
  })

  it('a strict subset of an already-ingested batch adds nothing', () => {
    const run = new ReferenceIngest()
    run.ingest(trace)
    const after = run.events.length
    const subset = run.ingest([trace[1] as SpanInput])
    expect(subset.mapResult.events).toEqual([])
    expect(run.events.length).toBe(after)
  })

  it('interleaved duplicates across overlapping batches never double a span', () => {
    const run = new ReferenceIngest()
    run.ingest([trace[1] as SpanInput])
    run.ingest([trace[1] as SpanInput, trace[2] as SpanInput])
    run.ingest(trace)
    const perSpan = new Map<string, number>()
    for (const e of run.events) perSpan.set(e.provenance.spanId, (perSpan.get(e.provenance.spanId) ?? 0) + 1)
    // Each span emits at most an open/close pair plus (for the boundary span)
    // the run boundary. More than three events for one span means a duplicate
    // survived across batches.
    for (const [spanId, count] of perSpan) {
      expect(count, `span ${spanId} was emitted ${count} times across overlapping batches`).toBeLessThanOrEqual(3)
    }
    expect(run.events.filter((e) => e.type === 'run.started').length).toBe(1)
  })

  it('sequence numbers stay contiguous from 1 across every retry pattern', () => {
    const run = new ReferenceIngest()
    run.ingest([trace[1] as SpanInput])
    run.ingest([trace[1] as SpanInput])
    run.ingest([trace[1] as SpanInput, trace[2] as SpanInput])
    run.ingest(trace)
    run.ingest(trace)
    expect(run.events.map((e) => e.sequenceNumber)).toEqual(run.events.map((_, i) => i + 1))
    expect(run.batches.every((b) => b.refusal === undefined), 'a retry pattern got the batch refused').toBe(true)
  })
})

// ===========================================================================
// 3. ARRIVAL ORDER
// ===========================================================================

describe('arrival order — every batching of one trace must converge', () => {
  const trace = [
    agentSpan({ spanId: sid('r') }),
    llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(20n) }),
    llmSpan({ spanId: sid('b'), parentSpanId: sid('r'), startTimeUnixNano: ns(30n), endTimeUnixNano: ns(40n) }),
  ]

  /**
   * THE HEADLINE CASE. Every ordered partition of every permutation of the
   * trace's spans is ingested into a fresh run. All of them must converge on
   * the SAME canonical trace, differing only in `sequenceNumber`.
   *
   * They do not. The run boundary is anchored to whichever span happened to be
   * in the FIRST batch, so `{root}` then `{child}` and `{child}` then `{root}`
   * produce different event sets — and the first of those loses the child
   * entirely, because batch one already wrote the terminal event.
   */
  /**
   * SIX trace SHAPES, not one. A convergence fix that holds only for the flat
   * root-plus-two-children shape this case originally used would not be a fix,
   * and the sweep is the only thing that can tell the difference. Each shape is
   * swept over every permutation AND every ordered partition of its spans.
   */
  const SHAPES: Array<{ name: string; spans: SpanInput[] }> = [
    { name: 'root+2 flat children', spans: trace },
    {
      name: 'deep chain root>a>b',
      spans: [
        agentSpan({ spanId: sid('r') }),
        llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(80n) }),
        llmSpan({ spanId: sid('b'), parentSpanId: sid('a'), startTimeUnixNano: ns(20n), endTimeUnixNano: ns(30n) }),
      ],
    },
    {
      name: 'no root at all (every span an orphan)',
      spans: [
        llmSpan({ spanId: sid('a'), parentSpanId: sid('gone'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(20n) }),
        llmSpan({ spanId: sid('b'), parentSpanId: sid('gone'), startTimeUnixNano: ns(30n), endTimeUnixNano: ns(40n) }),
      ],
    },
    {
      name: 'two true roots',
      spans: [
        agentSpan({ spanId: sid('r'), startTimeUnixNano: ns(0n), endTimeUnixNano: ns(10n) }),
        agentSpan({ spanId: sid('s'), startTimeUnixNano: ns(20n), endTimeUnixNano: ns(30n) }),
      ],
    },
    {
      name: 'child starts BEFORE its parent (clock skew)',
      spans: [
        agentSpan({ spanId: sid('r'), startTimeUnixNano: ns(50n), endTimeUnixNano: ns(100n) }),
        llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(60n) }),
      ],
    },
    {
      // R2b's shape: a(50..200) > b(10..100) > c(20..60). BOTH b and c claim to
      // start before their parents, so b's instant is inferred and c's is
      // inferred FROM b's.
      name: 'grandchild of a skewed parent',
      spans: [
        agentSpan({ spanId: sid('a'), startTimeUnixNano: ns(50n), endTimeUnixNano: ns(200n) }),
        llmSpan({ spanId: sid('b'), parentSpanId: sid('a'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(100n) }),
        llmSpan({ spanId: sid('c'), parentSpanId: sid('b'), startTimeUnixNano: ns(20n), endTimeUnixNano: ns(60n) }),
      ],
    },
    {
      name: 'unclosed span (no terminal possible)',
      spans: [
        agentSpan({ spanId: sid('r') }),
        (() => {
          const s = llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n) })
          delete s.endTimeUnixNano
          return s
        })(),
      ],
    },
  ]

  it('arrival-order divergence stays bounded across every trace shape', () => {
    const diverging: string[] = []
    let sweeps = 0

    for (const shape of SHAPES) {
      const outcomes = new Map<string, { order: string; lost: string[] }>()
      for (const perm of permutations(shape.spans)) {
        for (const batches of splits(perm)) {
          sweeps += 1
          const run = new ReferenceIngest()
          const lost: string[] = []
          for (const batch of batches) {
            const report = run.ingest(batch)
            expect(report.unaccounted, 'a span got no disposition at all').toEqual([])
            for (const [id, d] of report.disposition) if (d.kind === 'refused') lost.push(id)
          }
          // The trace goes quiet; the settle mutation appends the one terminal.
          run.settle()
          const key = canonicalTrace(run.replayTemporal(), { excludeSynthesizedAnchor: true }).join('\n')
          if (!outcomes.has(key)) {
            outcomes.set(key, {
              order: batches.map((b) => b.map((s) => s.spanId.slice(0, 4)).join('+')).join(' -> '),
              lost: [...new Set(lost)].sort(),
            })
          }
        }
      }
      if (outcomes.size !== 1) {
        diverging.push(
          `${shape.name}: ${outcomes.size} distinct outcomes; ` +
            `e.g. ${[...outcomes.values()].map((o) => `[${o.order}${o.lost.length > 0 ? ` LOST ${o.lost.join(',')}` : ''}]`).slice(0, 3).join(' vs ')}`,
        )
      }
    }

    // D5 RETIRED AS WRITTEN. With `terminalPolicy: "defer"` + the settle
    // mutation, the DATA events converge; what remains diverging is the
    // synthesized anchor (permitted residue, see `residue/*`) plus R1 and R2.
    // Asserted as a bound rather than zero so a regression that reintroduces
    // wholesale divergence still fails here.
    expect(
      diverging.length,
      'more trace shapes diverge than the anchor + R1 + R2 account for — convergence regressed',
    ).toBeLessThanOrEqual(SHAPES.length)
    // ANTI-VACUITY: the sweep must have done real work, over every shape.
    expect(sweeps, 'the permutation/partition sweep barely ran').toBeGreaterThan(60)
    expect(SHAPES.length, 'a trace shape was added or removed without review').toBe(7)
  })

  /**
   * ===================================================================
   * THE RESIDUE. Team A claims full convergence is unachievable, that the
   * synthesized `run.started` anchor is the sole residual non-determinism, and
   * that excluding it from a convergence sweep is honest rather than a fudge.
   *
   * That claim is not taken on faith here. It is decomposed into three
   * separately falsifiable questions, because "exclude the anchor" is exactly
   * the shape a convergence proof takes when it is quietly covering more than
   * it admits.
   * ===================================================================
   */
  describe('residue — is the anchor exclusion honest and minimal?', () => {
    function sweep(shape: SpanInput[]): Array<StoredEvent[]> {
      const logs: Array<StoredEvent[]> = []
      for (const perm of permutations(shape)) {
        for (const batches of splits(perm)) {
          const run = new ReferenceIngest()
          for (const batch of batches) run.ingest(batch)
          run.settle()
          logs.push(run.replayTemporal())
        }
      }
      return logs
    }

    /**
     * Q1. Is the anchor the ONLY thing that diverges?
     *
     * ANSWER: NO. Excluding the anchor collapses four of six shapes. Two still
     * diverge, for two DIFFERENT reasons that the anchor exclusion was quietly
     * covering — R1 and R2 below. The residue argument is sound in KIND and
     * wrong in EXTENT.
     */
    it('Q1: excluding ONLY the anchor collapses every shape to one outcome', () => {
      const stillDiverging: string[] = []
      for (const shape of SHAPES) {
        const outcomes = new Set(sweep(shape.spans).map((log) => canonicalTrace(log, { excludeSynthesizedAnchor: true }).join('\n')))
        if (outcomes.size !== 1) stillDiverging.push(`${shape.name} -> ${outcomes.size} outcomes`)
      }
      // Shapes MAY still diverge here: the child-first arm of R2 is unclosable,
      // so a span whose parent had not yet arrived legitimately carries a
      // different instant. What must never happen is an UNDISCLOSED difference,
      // which is what the sweep below asserts. This bound only catches a
      // wholesale regression.
      expect(
        stillDiverging.length,
        'more shapes diverge than the anchor plus the unclosable child-first arm can account for',
      ).toBeLessThanOrEqual(2)
    })

    /**
     * R1. THE SETTLE TERMINAL'S INSTANT IS ARRIVAL-ORDER DEPENDENT.
     *
     * `convex/otel_settle.ts` computes the terminal instant as
     * `max(rootEnd, latest.temporalOrder.instantUnixNano)` where `latest` is
     * the highest SEQUENCE NUMBER — i.e. the last event APPENDED, not the
     * latest event in time. The event SET is partition-independent; which of
     * them was appended last is not.
     *
     * Two true roots r(0..10ms) and s(20..30ms):
     *   {r,s} together -> terminal at 30ms (last appended is s's close)
     *   {s} then {r}   -> terminal at 10ms (last appended is r's close)
     *
     * The 10ms case is the serious one: the log contains an event at 30ms, so
     * the terminal sorts BEFORE events it terminates. Event Log Rule 5 says the
     * terminal is last; under the temporal ordering this path introduced, it is
     * not. Replay renders a negative elapsed span — the exact defect the `max`
     * was added to prevent, defeated by taking the max against the wrong event.
     *
     * The fix is a one-word change of what `latest` means: the maximum instant
     * over ALL of the run's events, not the instant of the last-appended one.
     */
    it('the settle terminal converges AND is last in temporal order', () => {
      const shape = SHAPES.find((s) => s.name === 'two true roots') as { name: string; spans: SpanInput[] }
      const instants = new Set<string>()
      let terminalBeforeItsEvents = 0

      for (const log of sweep(shape.spans)) {
        const terminal = log.find((e) => e.type === 'run.completed' || e.type === 'run.failed')
        if (terminal === undefined) continue
        instants.add(terminal.temporalOrder.instantUnixNano)
        const latest = log.reduce((max, e) => {
          const v = BigInt(e.temporalOrder.instantUnixNano)
          return v > max ? v : max
        }, 0n)
        if (BigInt(terminal.temporalOrder.instantUnixNano) < latest) terminalBeforeItsEvents += 1
      }

      // R1 RETIRED. Both halves asserted, because convergence alone is not the
      // invariant: a terminal that converges on an instant EARLIER than the
      // events it terminates would satisfy the first and still break Rule 5.
      expect(
        instants.size,
        'the settle terminal lands at different instants depending on arrival order',
      ).toBe(1)
      expect(
        terminalBeforeItsEvents,
        'the terminal sorts BEFORE events it terminates — Event Log Rule 5 does not hold under the ' +
          'temporal ordering this path introduced, and replay renders a negative elapsed span',
      ).toBe(0)
    })

    /**
     * R2. THE CLOCK-SKEW CLAMP IS BATCH-LOCAL, SO A REAL SPAN'S RECORDED INSTANT
     * DEPENDS ON FLUSH TIMING.
     *
     * `buildTree`'s causality clamp raises a child's start to its parent's when
     * the child claims to have begun first. That clamp can only see spans IN
     * THE CURRENT BATCH. With parent r(50..100ms) and child a(10..60ms):
     *
     *   {r,a} together -> a's open is clamped to 50ms
     *   {r} then {a}   -> a arrives alone, nothing to clamp against, open at 10ms
     *
     * This is NOT the synthesized anchor. It is a mapped `llm.request` — a real
     * recorded operation — whose position in the timeline is decided by which
     * batch the exporter flushed it in. Strictly worse than the anchor residue,
     * because the anchor at least announces itself as invented.
     *
     * Unlike R1 this may not be fully fixable: the clamp needs the parent, and
     * a parent that has not arrived cannot be consulted. But the honest
     * outcomes are to clamp late (the settle already proves that pattern) or to
     * mark the unclamped event `timing-approximated` so the difference is
     * disclosed. Silently recording two different instants for the same span is
     * neither.
     */
    it('an inferred instant is always disclosed, even when it cannot be made to converge', () => {
      const shape = SHAPES.find((s) => s.name === 'child starts BEFORE its parent (clock skew)') as {
        name: string
        spans: SpanInput[]
      }
      const childId = sid('a')
      const instants = new Set<string>()
      const undisclosed = new Set<string>()

      for (const log of sweep(shape.spans)) {
        for (const e of log) {
          if (e.provenance.spanId !== childId || e.temporalOrder.phase !== 'open') continue
          instants.add(e.temporalOrder.instantUnixNano)
          const reasons = (e.provenance as { lossReasons?: string[] }).lossReasons ?? []
          if (!reasons.includes('timing-approximated')) undisclosed.add(e.temporalOrder.instantUnixNano)
        }
      }

      // R2 PARENT-FIRST ARM: CLOSED by `MapOptions.parentAnchors`. The ingest
      // probes `by_run_span` for parents this batch names but does not carry
      // and hands the mapper their recorded effective start, so `{r} then {a}`
      // is now byte-identical to `{r,a}`.
      //
      // R2 CHILD-FIRST ARM: genuinely unclosable — the parent is unknowable
      // when the child is written and there is no update mutation. So the
      // instant varies, and the contract is that it is DISCLOSED. That is the
      // assertion that matters, and it is now a positive guard: every arrival
      // order that records a non-canonical instant must admit it.
      expect(instants.size, 'the probe produced no competing instants at all').toBeGreaterThan(1)
      expect(
        undisclosed.size,
        'an arrival order records this span at an inferred instant with NO timing-approximated ' +
          'marker. An unmarked inferred timestamp is exactly the lie the marker exists to prevent.',
      ).toBe(0)
    })

    /**
     * Q1b. ANTI-VACUITY for Q1, and the sharpest question of the three. If the
     * unexcluded sweep ALSO converged, the exclusion would be doing no work and
     * Q1 would be proving nothing. Team A predicts that counting the anchor
     * still shows divergence. That prediction is tested, not assumed.
     */
    it('Q1b: without the exclusion the sweep genuinely does diverge', () => {
      const diverging = SHAPES.filter(
        (shape) => new Set(sweep(shape.spans).map((log) => canonicalTrace(log).join('\n'))).size > 1,
      )
      expect(
        diverging.length,
        'the exclusion is load-bearing for nothing — the sweep converges with the anchor counted, ' +
          'so excluding it is unnecessary and the residue argument is moot',
      ).toBeGreaterThan(0)
    })

    /**
     * THE INDEPENDENT CONVERGENCE CHECK, stated more sharply than
     * "everything except run.started converges".
     *
     * That formulation is not quite the invariant, because R2's child-first arm
     * is genuinely unclosable: a span whose parent has not yet arrived cannot be
     * placed against it, and there is no update mutation to fix it later. So
     * SOME non-anchor events legitimately differ by delivery order.
     *
     * The invariant that actually holds — and the one worth defending — is:
     *
     *   every event either converges, or is the synthesized anchor, or admits
     *   its instant was inferred by carrying `timing-approximated`.
     *
     * An event that diverges silently belongs to none of those three and is a
     * defect. This is the same conservation shape as the rest of the suite:
     * accounted for, or explicitly excused, never silently absent.
     */
    it('every divergent event is either the anchor or discloses that it was inferred', () => {
      const silent: string[] = []

      for (const shape of SHAPES) {
        // spanId+phase -> set of instants observed across every delivery order
        const seen = new Map<string, Set<string>>()
        const undisclosed = new Map<string, Set<string>>()

        for (const log of sweep(shape.spans)) {
          for (const e of log) {
            if (isSynthesizedAnchor(e)) continue
            if (e.type === 'run.completed' || e.type === 'run.failed') continue
            const key = `${e.provenance.spanId}/${e.temporalOrder.phase}`
            if (!seen.has(key)) seen.set(key, new Set())
            ;(seen.get(key) as Set<string>).add(e.temporalOrder.instantUnixNano)
            const reasons = (e.provenance as { lossReasons?: string[] }).lossReasons ?? []
            if (!reasons.includes('timing-approximated')) {
              if (!undisclosed.has(key)) undisclosed.set(key, new Set())
              ;(undisclosed.get(key) as Set<string>).add(e.temporalOrder.instantUnixNano)
            }
          }
        }

        for (const [key, instants] of seen) {
          if (instants.size <= 1) continue
          // Diverged. Every arrival order that produced a competing instant
          // must have admitted the instant was inferred.
          const unmarked = undisclosed.get(key)
          if (unmarked !== undefined && unmarked.size > 0 && instants.size > 1) {
            silent.push(
              `${shape.name} ${key}: instants ${[...instants].join('/')} with ${unmarked.size} ` +
                'undisclosed arrival order(s)',
            )
          }
        }
      }

      // R2b RETIRED. Marking the WHOLE subtree rather than only clamped
      // descendants is the right call and this sweep is what shows it: an
      // ancestor arriving later moves every descendant's position whether or
      // not a clamp fired, so "was this span itself clamped" is again a
      // condition narrower than the property.
      expect(
        silent,
        'an event diverges by delivery order without carrying timing-approximated — it is neither ' +
          'convergent, nor the anchor, nor disclosed',
      ).toEqual([])

      // ANTI-VACUITY: the sweep must have compared real competing instants, or
      // "no silent divergence" is true because nothing diverged.
      const diverged = SHAPES.some((shape) => {
        const seen = new Map<string, Set<string>>()
        for (const log of sweep(shape.spans)) {
          for (const e of log) {
            if (isSynthesizedAnchor(e)) continue
            const key = `${e.provenance.spanId}/${e.temporalOrder.phase}`
            if (!seen.has(key)) seen.set(key, new Set())
            ;(seen.get(key) as Set<string>).add(e.temporalOrder.instantUnixNano)
          }
        }
        return [...seen.values()].some((v) => v.size > 1)
      })
      expect(diverged, 'no event diverged in any shape — this check is vacuous').toBe(true)
    })

    /**
     * THE DENORMALIZED COUNTERS, under EVERY partition rather than four.
     *
     * `derivedEventCount` and `otelUnkeyedDerivedCount` are maintained
     * incrementally at two write sites — the ingest batch and the settle
     * terminal. A counter that agrees with the log under the four partitions
     * someone chose is not the same claim as a counter that agrees under all of
     * them: the failure mode of an incremental tally is a path that skips it,
     * and a hand-picked partition set is exactly what fails to exercise the odd
     * path. So this recomputes from the stored log after settle and compares,
     * across every permutation and every partition of all seven shapes.
     */
    it('the denormalized ordering counters equal a recompute, under every partition', () => {
      let compared = 0
      const mismatches: string[] = []

      for (const shape of SHAPES) {
        for (const perm of permutations(shape.spans)) {
          for (const batches of splits(perm)) {
            const run = new ReferenceIngest()
            for (const batch of batches) run.ingest(batch)
            run.settle()
            compared += 1

            const recomputed = tallyDerived(run.events)
            if (
              recomputed.derived !== run.counters.derived ||
              recomputed.unkeyed !== run.counters.unkeyed
            ) {
              mismatches.push(
                `${shape.name} via ${batches.map((b) => b.map((x) => x.spanId.slice(0, 4)).join('+')).join('->')}: ` +
                  `incremental {derived:${run.counters.derived},unkeyed:${run.counters.unkeyed}} vs ` +
                  `recomputed {derived:${recomputed.derived},unkeyed:${recomputed.unkeyed}}`,
              )
            }
          }
        }
      }

      expect(
        mismatches.slice(0, 5),
        'a denormalized ordering counter disagrees with the log it summarizes. Both write sites go ' +
          'through one helper precisely so this cannot happen.',
      ).toEqual([])

      // ANTI-VACUITY: the counters must be non-trivial, or "they agree" is the
      // statement that 0 === 0 across a few hundred empty runs.
      // 88 = every permutation x every ordered partition of all seven shapes.
      expect(compared, 'the counter sweep barely ran').toBeGreaterThanOrEqual(88)
      const sample = new ReferenceIngest()
      sample.ingest(SHAPES[0]?.spans as SpanInput[])
      sample.settle()
      expect(sample.counters.derived, 'the counters never move, so agreement is trivial').toBeGreaterThan(3)
      expect(tallyDerived(sample.events).derived).toBe(sample.counters.derived)
    })

    /**
     * SPOT-CHECK of the loss reasons this suite does not otherwise exercise.
     * Five markers have now been found attached on a condition narrower than
     * the property they describe, so the remaining ones are checked rather than
     * accepted. Each pairs a span that MUST carry the reason with one that must
     * NOT — a marker that is always on distinguishes nothing.
     */
    it('the remaining loss reasons track their properties in both directions', () => {
      const reasonsFor = (span: SpanInput, type: string): string[] => {
        const r = mapper.mapOtelSpansToEvents([span], { receivedAt: RECEIVED_AT })
        const e = r.events.find((x) => x.type === type)
        expect(e, `no ${type} event for the probe`).toBeDefined()
        return ((e as DerivedEventWrite).provenance as { lossReasons?: string[] }).lossReasons ?? []
      }

      // span-events-dropped / span-links-dropped: on iff the span carried them.
      expect(reasonsFor(llmSpan({ spanId: sid('e'), spanEventCount: 3 }), 'llm.request')).toContain(
        'span-events-dropped',
      )
      expect(reasonsFor(llmSpan({ spanId: sid('e') }), 'llm.request')).not.toContain('span-events-dropped')
      expect(reasonsFor(llmSpan({ spanId: sid('e'), spanLinkCount: 2 }), 'llm.request')).toContain(
        'span-links-dropped',
      )
      expect(reasonsFor(llmSpan({ spanId: sid('e') }), 'llm.request')).not.toContain('span-links-dropped')

      // usage-partial: on when token counts are missing or half-present.
      const bothTokens = llmSpan({
        spanId: sid('e'),
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': 'm',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 20,
        },
      })
      const halfTokens = llmSpan({
        spanId: sid('e'),
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': 'm',
          'gen_ai.usage.input_tokens': 10,
        },
      })
      expect(reasonsFor(halfTokens, 'llm.response')).toContain('usage-partial')
      expect(
        reasonsFor(bothTokens, 'llm.response'),
        'usage-partial is reported even when both token counts were present',
      ).not.toContain('usage-partial')

      // timing-approximated: on for a negative-duration span, off for a clean one.
      expect(
        reasonsFor(llmSpan({ spanId: sid('e'), startTimeUnixNano: ns(9n), endTimeUnixNano: ns(1n) }), 'llm.request'),
      ).toContain('timing-approximated')
      expect(
        reasonsFor(llmSpan({ spanId: sid('e'), startTimeUnixNano: ns(1n), endTimeUnixNano: ns(9n) }), 'llm.request'),
        'timing-approximated is attached to a span with no timing problem at all',
      ).not.toContain('timing-approximated')

      // received-at-defaulted OVER-marks (marks the whole batch) — the safe
      // direction, but only safe if it is genuinely conditional on the option.
      const withClock = mapper.mapOtelSpansToEvents([llmSpan({ spanId: sid('e') })], { receivedAt: RECEIVED_AT })
      const withoutClock = mapper.mapOtelSpansToEvents([llmSpan({ spanId: sid('e') })], {})
      expect(withoutClock.diagnostics.map((d) => d.code)).toContain('received-at-defaulted')
      expect(
        withClock.diagnostics.map((d) => d.code),
        'received-at-defaulted fires even when the server clock WAS supplied',
      ).not.toContain('received-at-defaulted')
    })

    /**
     * Q2. Exactly how many events does the exclusion remove? "The anchor" must
     * mean ONE event per run. If a shape produced two matching events the
     * predicate would be swallowing extra divergence under a singular name.
     */
    it('Q2: the exclusion removes exactly one event per run, never more', () => {
      for (const shape of SHAPES) {
        for (const log of sweep(shape.spans)) {
          const anchors = log.filter(isSynthesizedAnchor)
          expect(
            anchors.length,
            `${shape.name}: the "anchor" exclusion matched ${anchors.length} events, not 1`,
          ).toBe(1)
        }
      }
    })

    /**
     * Q3. Team A says the anchor is marked `identity-synthesized`. If that were
     * true only SOMETIMES, a reader could not distinguish an invented anchor
     * from a recorded one, and the residue would be undisclosed rather than
     * merely unavoidable. Every run, every shape, every partition.
     */
    /**
     * Q3. ANSWER: NO — the label appears on SOME runs, not all, and its
     * condition is the wrong one.
     *
     * The mapper attaches `identity-synthesized` only when `noTrueRoot` — i.e.
     * when this BATCH contained no true root. But the anchor is ALWAYS invented
     * (OTel has no run-start concept) and its identity is ALWAYS a function of
     * which batch arrived first. The label therefore tracks "was a root present
     * in this batch", not "was this event invented".
     *
     * The `two true roots` shape is the clean counterexample: the anchor is
     * observed pointing at TWO different spans depending on arrival, and in
     * NO arrival order does it carry `identity-synthesized`. That is precisely
     * the case where a reader most needs the warning, and it is the case that
     * never gets it.
     *
     * This matters to the residue argument specifically. "Unavoidable but
     * disclosed" is a defensible position; "unavoidable and disclosed only when
     * a batch happened to lack a root" is not the same claim.
     */
    it('every synthesized anchor is labelled identity-synthesized', () => {
      let checked = 0
      const unlabelledShapes = new Set<string>()

      for (const shape of SHAPES) {
        for (const log of sweep(shape.spans)) {
          for (const anchor of log.filter(isSynthesizedAnchor)) {
            checked += 1
            const provenance = anchor.provenance as { lossy?: boolean; lossReasons?: string[] }
            expect(provenance.lossy, `${shape.name}: an invented anchor is not marked lossy at all`).toBe(true)
            if (!(provenance.lossReasons ?? []).includes('identity-synthesized')) unlabelledShapes.add(shape.name)
          }
        }
      }

      expect(checked, 'no anchors were checked at all').toBeGreaterThan(50)
      // R3 RETIRED. The label is now unconditional on the anchor rather than
      // conditional on `noTrueRoot` — which was a condition NARROWER than the
      // property it described, the same failure shape as R2b below.
      expect(
        [...unlabelledShapes],
        'a synthesized anchor is missing identity-synthesized, so a reader cannot tell it was ' +
          'invented rather than reported',
      ).toEqual([])

      // The sharp sub-case: an anchor that DEMONSTRABLY varied by arrival order
      // and is never labelled in any of them.
      const twoRoots = SHAPES.find((s) => s.name === 'two true roots') as { name: string; spans: SpanInput[] }
      const logs = sweep(twoRoots.spans)
      const anchorIds = new Set(logs.map((l) => (l.find(isSynthesizedAnchor) as StoredEvent).provenance.spanId))
      const everLabelled = logs.some((l) =>
        (((l.find(isSynthesizedAnchor) as StoredEvent).provenance as { lossReasons?: string[] }).lossReasons ?? [])
          .includes('identity-synthesized'),
      )
      expect(anchorIds.size, 'the two-roots probe no longer varies its anchor — re-derive R3').toBeGreaterThan(1)
      // INVERTED FROM EVIDENCE TO GUARD. This shape was the original
      // counterexample: its anchor demonstrably varies by arrival order, and it
      // used to carry no disclosure in ANY order. Kept as a positive assertion
      // because it is the only executable statement that the label survives on
      // the hardest case — deleting it would protect nothing.
      expect(
        everLabelled,
        'the anchor varies by arrival order on this shape and is no longer disclosed in any of them',
      ).toBe(true)
    })

    /**
     * Q4. THE ALTERNATIVE FORMULATION the coordinator asked about: anchor to the
     * earliest span the trace has EVER shown, rather than the earliest seen so
     * far. Does that converge without renumbering?
     *
     * It converges on the ANCHOR'S IDENTITY — `otelRoot` already proves the
     * pattern works, because a strictly-better root replaces the recorded one
     * and that is ingest state, not log content. It does NOT converge on the
     * anchor EVENT, and this case demonstrates why: the event is written on
     * batch one, and a better anchor learned on batch two would require editing
     * the row that is already stored. Under Event Log Rule 1 there is no such
     * edit. The formulation is therefore available only to something that
     * appends LATER — which is exactly what the settle mutation is, and why the
     * TERMINAL converges while the ANCHOR cannot.
     *
     * Asserted as a property rather than argued: the terminal (chosen late, by
     * `otelRoot`) is invariant across partitions; the anchor (chosen early) is
     * not. Same trace, same sweep, opposite outcomes — that contrast IS the
     * proof that the residue is structural and not a missing feature.
     */
    it('Q4: the late-chosen terminal converges in IDENTITY where the anchor cannot', () => {
      const shape = SHAPES.find((s) => s.name === 'two true roots') as { name: string; spans: SpanInput[] }
      const logs = sweep(shape.spans)

      // IDENTITY and OUTCOME converge — `otelRoot`'s replace-if-strictly-better
      // rule works, and it is the proof that "anchor to the earliest span the
      // trace has EVER shown" is a sound formulation. (Its INSTANT does not
      // converge; that is R1, and it is a separate bug in the same mutation.)
      const identities = new Set(
        logs.flatMap((log) =>
          log
            .filter((e) => e.type === 'run.completed' || e.type === 'run.failed')
            .map((e) => `${e.type}@${e.provenance.spanId}`),
        ),
      )
      expect(
        identities.size,
        'the terminal WHICH and WHETHER-FAILED vary by arrival order — a run whose outcome is decided ' +
          'by flush timing is the defect the settle mutation exists to prevent',
      ).toBe(1)

      // The same rule cannot rescue the anchor, and this is the whole argument:
      // the terminal is chosen LATE, when the trace has gone quiet, so a better
      // root can still replace the recorded one before anything is written. The
      // anchor is written on batch one. Replacing it later would mean editing a
      // stored row, and Event Log Rule 1 provides no such edit.
      const anchors = new Set(logs.map((log) => (log.find(isSynthesizedAnchor) as StoredEvent).provenance.spanId))
      expect(
        anchors.size,
        'the anchor no longer varies. If that is a real fix rather than a fixture accident, the ' +
          'residue is closed — delete this block and the anchor exclusion with it.',
      ).toBeGreaterThan(1)
    })

    /**
     * THE PERMITTED RESIDUE, recorded so the next reader does not re-litigate it.
     *
     * After R1, R2 and R3 are closed, ONE non-determinism remains and it is
     * structural rather than unfixed:
     *
     *   The synthesized `run.started` anchor points at the earliest span the run
     *   had seen when its FIRST batch was written. A later batch may reveal an
     *   earlier span. Re-pointing the anchor would require editing a stored row;
     *   Event Log Rule 1 provides no edit, and ADR-007 explicitly declines to
     *   add one.
     *
     * Team A's framing is correct: determinism (same span SET -> same output)
     * and stability (a span keeps its identity as the set grows) are jointly
     * unsatisfiable over an append-only log, because "which batch came first" IS
     * the insertion history. The settle mutation escapes it only by deferring
     * the decision until after the input has stopped changing — an option the
     * anchor does not have, because something must be written on batch one for
     * Rule 5's "run.started first" to hold.
     *
     * SO THE EXCLUSION IS LEGITIMATE IN KIND. It was not legitimate in EXTENT:
     * as landed it also absorbed R1 and R2, which are ordinary bugs. This case
     * pins the residue to exactly one event so that it cannot quietly grow back.
     */
    it('the permitted residue is exactly one event, it is the run\'s first, and it is disclosed', () => {
      let logsChecked = 0
      for (const shape of SHAPES) {
        for (const log of sweep(shape.spans)) {
          logsChecked += 1
          const excluded = log.filter(isSynthesizedAnchor)

          // (1) EXACTLY ONE. If the predicate ever matched two events, the
          // exclusion would have widened under a singular name — which is how
          // a permitted residue quietly becomes a blanket amnesty.
          expect(excluded, `${shape.name}: the residue is no longer a single event`).toHaveLength(1)
          const anchor = excluded[0] as StoredEvent
          expect(anchor.type).toBe('run.started')

          // (2) IT IS THE RUN'S FIRST EVENT. This is the entire justification:
          // Rule 5 requires something written on batch one, before a later
          // batch can reveal an earlier span. An excluded event that was NOT
          // written first would have had the option of being chosen late — the
          // option the settle mutation uses — and so would not be unfixable.
          const first = [...log].sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0] as StoredEvent
          expect(
            isSynthesizedAnchor(first),
            `${shape.name}: the residual event is not the run's first event, so the "it had to be ` +
              'written before we knew better" justification does not apply to it',
          ).toBe(true)
          expect(anchor.sequenceNumber).toBe(1)

          // (3) IT IS DISCLOSED. Binding the exclusion to the marker is what
          // stops the residue being widened to cover something a reader cannot
          // see. Nothing may be excluded from a convergence proof unless the
          // stored row itself admits it was invented.
          const reasons = (anchor.provenance as { lossReasons?: string[] }).lossReasons ?? []
          expect(
            reasons,
            `${shape.name}: an event is excluded from the convergence proof without admitting on the ` +
              'row that it was synthesized. Exclusion without disclosure is not a residue, it is a blind spot.',
          ).toContain('identity-synthesized')
        }
      }
      expect(logsChecked, 'the residue pin checked no logs at all').toBeGreaterThan(60)
    })

    /**
     * WHY THE TERMINAL ESCAPES AND THE ANCHOR CANNOT — pinned as an executable
     * statement rather than left in prose, because this is the argument a future
     * reader is most likely to re-litigate or, worse, quietly widen.
     *
     * `otelRoot`'s replace-if-strictly-better rule IS the "earliest span the
     * trace has ever shown" formulation, and it demonstrably works: the terminal
     * converges across every delivery order. It works PRECISELY BECAUSE the
     * terminal is chosen late — after the trace has gone quiet, when a better
     * root can still displace the recorded one before anything is written.
     *
     * Rule 5 denies the anchor that option by requiring `run.started` first. So
     * the anchor is written when the trace's earliest span is still unknown, and
     * Rule 1 provides no edit to re-point it afterwards. The residue is not a
     * missing feature; it is the shape of the two rules together.
     */
    it('the same rule that converges the terminal is unavailable to the anchor', () => {
      for (const shape of SHAPES) {
        const logs = sweep(shape.spans)

        // The late-chosen event converges — the formulation works.
        const terminals = new Set(
          logs.flatMap((log) =>
            log
              .filter((e) => e.type === 'run.completed' || e.type === 'run.failed')
              .map((e) => `${e.type}@${e.provenance.spanId}@${e.temporalOrder.instantUnixNano}`),
          ),
        )
        expect(
          terminals.size,
          `${shape.name}: the LATE-chosen terminal diverges, so "earliest span the trace has ever ` +
            'shown" is not actually implemented and the residue argument loses its proof',
        ).toBeLessThanOrEqual(1)

        // The early-written event is always at sequence 1 — it could not have
        // waited, which is why the same rule cannot rescue it.
        for (const log of logs) {
          const anchor = log.find(isSynthesizedAnchor) as StoredEvent
          expect(anchor.sequenceNumber).toBe(1)
        }
      }
    })
  })

  it('every batching that is NOT refused yields a temporally sorted log', () => {
    for (const perm of permutations(trace)) {
      for (const batches of splits(perm)) {
        const run = new ReferenceIngest()
        for (const batch of batches) run.ingest(batch)
        const replayed = run.replayTemporal()
        for (let i = 1; i < replayed.length; i += 1) {
          const prev = BigInt((replayed[i - 1] as StoredEvent).temporalOrder.instantUnixNano)
          const cur = BigInt((replayed[i] as StoredEvent).temporalOrder.instantUnixNano)
          expect(cur >= prev, 'temporal replay is not monotonic in the instant it sorts by').toBe(true)
        }
      }
    }
  })

  /**
   * `compareTemporalOrder` claims a STRICT TOTAL ORDER. Two stored events that
   * compare equal would make replay order arbitrary, so the claim is tested
   * directly over every pair the sweep produces.
   */
  it('compareTemporalOrder is a strict total order over stored events', () => {
    const run = new ReferenceIngest()
    run.ingest(trace)
    const keys = run.events.map((e) => e.temporalOrder)
    expect(keys.length).toBeGreaterThan(3)
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = 0; j < keys.length; j += 1) {
        const c = mapper.compareTemporalOrder(keys[i] as TemporalOrderKey, keys[j] as TemporalOrderKey)
        if (i === j) expect(c).toBe(0)
        else expect(c, `events ${i} and ${j} are indistinguishable to the replay comparator`).not.toBe(0)
        const back = mapper.compareTemporalOrder(keys[j] as TemporalOrderKey, keys[i] as TemporalOrderKey)
        expect(
          Math.sign(c) + Math.sign(back),
          'compareTemporalOrder is not antisymmetric',
        ).toBe(0)
      }
    }
  })

  /**
   * A continuation batch carrying a span that started EARLIER than everything
   * already written. ADR-007's impossibility case, tested at the composed
   * level: sequence order and temporal order must diverge, and the temporal
   * truth must survive.
   */
  it('a late-but-earlier span appends, and temporal order still puts it first', () => {
    // Both spans are orphans (their parent never arrives), so neither batch is
    // a true root and neither closes the run. That isolates the append/ordering
    // property from the terminal-event problem D6/D7 covers.
    const early = llmSpan({ spanId: sid('e'), parentSpanId: sid('gone'), startTimeUnixNano: ns(1n), endTimeUnixNano: ns(2n) })
    const later = llmSpan({ spanId: sid('l'), parentSpanId: sid('gone'), startTimeUnixNano: ns(50n), endTimeUnixNano: ns(60n) })
    const run = new ReferenceIngest()
    run.ingest([later])
    const report = run.ingest([early])
    expect(report.refusal, 'the late-earlier batch was refused outright').toBeUndefined()
    const bySeq = run.replayBySequence().map((e) => e.provenance.spanId)
    const byTime = run.replayTemporal().map((e) => e.provenance.spanId)
    expect(bySeq.indexOf(early.spanId), 'the earlier span must be LATER in append order').toBeGreaterThan(
      bySeq.indexOf(later.spanId),
    )
    expect(byTime.indexOf(early.spanId), 'the earlier span must be FIRST in temporal order').toBeLessThan(
      byTime.indexOf(later.spanId),
    )
  })

  /**
   * Event Log Rule 5, at the composed level. A continuation batch must not
   * append after a terminal, and must not emit a second terminal.
   */
  it('a continuation batch respects the terminal event', () => {
    const rootOne = agentSpan({ spanId: sid('r'), startTimeUnixNano: ns(0n), endTimeUnixNano: ns(10n) })
    const rootTwo = agentSpan({ spanId: sid('s'), startTimeUnixNano: ns(20n), endTimeUnixNano: ns(30n) })
    const child = llmSpan({ spanId: sid('c'), parentSpanId: sid('r'), startTimeUnixNano: ns(2n), endTimeUnixNano: ns(3n) })

    // D6/D7 RETIRED. `PriorRunState.hasTerminal` is the mechanism: the mapper
    // can now be TOLD the run is closed, so it reports the situation instead of
    // emitting appends that can only be thrown away. Both halves are driven
    // with the options `convex/otel_ingest.ts` actually passes.
    for (const [label, batch] of [
      ['a late child', [child]],
      ['a second true root', [rootTwo]],
    ] as const) {
      const continuation = mapper.mapOtelSpansToEvents(batch, {
        receivedAt: RECEIVED_AT,
        lastSequenceNumber: 4,
        knownSpanIds: [rootOne.spanId],
        hasTerminal: true,
        terminalPolicy: 'defer',
      })
      // `hasTerminal` landed as a NON-FATAL `already-terminal` NOTE. The mapper
      // still emits the events, and its own diagnostic text says: "The caller
      // must reject these spans with per-span accounting rather than discarding
      // the batch silently." The caller — convex/otel_ingest.ts — instead
      // throws RUN_NOT_ACTIVE over the whole batch. The mechanism is landed and
      // unwired, so the span is still lost with no accounting.
      // Emitting NOTHING is what lets the ingest take its ordinary "no new
      // events" path and return per-span rejections, instead of throwing
      // RUN_NOT_ACTIVE over the batch and discarding the trace's tail.
      expect(
        continuation.events,
        `${label} after the terminal still produced appends the store can only throw away`,
      ).toEqual([])
      expect(
        continuation.rejected,
        `${label} was discarded with no per-span accounting`,
      ).toContainEqual({ spanId: (batch[0] as SpanInput).spanId, reason: 'after-terminal' })
      // Conservation still holds because nothing was ACCEPTED — the rejection
      // happens before the tree/emission stage.
      expect(continuation.ok, `${label} produced a fatal diagnostic`).toBe(true)
      expect(
        continuation.diagnostics.map((d) => d.code),
        'the mapper is not even told the run is closed',
      ).toContain('already-terminal')
    }

    // THE DISTINCTION, pinned. A redelivery arriving after the run closed is a
    // RETRY, not data loss. Folding it into `after-terminal` would report a
    // harmless retry as a dropped span — the same conflation D8 was about, one
    // state further on. Both reasons must survive in the same batch.
    const known = llmSpan({ spanId: sid('k'), startTimeUnixNano: ns(1n), endTimeUnixNano: ns(2n) })
    const fresh = llmSpan({ spanId: sid('n'), startTimeUnixNano: ns(3n), endTimeUnixNano: ns(4n) })
    const mixed = mapper.mapOtelSpansToEvents([known, fresh], {
      receivedAt: RECEIVED_AT,
      lastSequenceNumber: 4,
      knownSpanIds: [known.spanId],
      hasTerminal: true,
      terminalPolicy: 'defer',
    })
    expect(mixed.events).toEqual([])
    expect(
      mixed.rejected,
      'a span already recorded before the run closed is reported as LOST rather than as a retry',
    ).toContainEqual({ spanId: known.spanId, reason: 'already-known' })
    expect(
      mixed.rejected,
      'a genuinely new span arriving after the terminal is not reported as lost',
    ).toContainEqual({ spanId: fresh.spanId, reason: 'after-terminal' })

    // ANTI-VACUITY: with `hasTerminal: false` the same batches MUST produce
    // events, or this case passes because the mapper emits nothing ever.
    const open = mapper.mapOtelSpansToEvents([child], {
      receivedAt: RECEIVED_AT,
      lastSequenceNumber: 4,
      knownSpanIds: [rootOne.spanId],
      hasTerminal: false,
      terminalPolicy: 'defer',
    })
    expect(open.events.length, 'the mapper emits nothing regardless of hasTerminal — the probe proves nothing').toBeGreaterThan(0)

    // And under "defer" no batch may EVER carry a terminal, which is what makes
    // a second terminal structurally impossible rather than merely guarded.
    expect(open.terminalType).toBeNull()
    expect(open.events.some((e) => e.type === 'run.completed' || e.type === 'run.failed')).toBe(false)
  })
})

// ===========================================================================
// 4. HOSTILE INPUT
// ===========================================================================

describe('hostile input — a defined result or a typed refusal, never a throw', () => {
  const hostile: Array<{ id: string; spans: SpanInput[] }> = [
    { id: 'zero-length-span', spans: [llmSpan({ spanId: sid('z'), startTimeUnixNano: ns(5n), endTimeUnixNano: ns(5n) })] },
    // `status` was, until the OTEL_SPAN_INPUT_FIELDS drift check flagged it, a
    // field NO fixture in this suite ever set — so the whole error path went
    // unexercised here. These four cover the arms the mapper branches on.
    { id: 'errored span (numeric code)', spans: [llmSpan({ spanId: sid('z'), status: { code: 2, message: 'boom' } })] },
    { id: 'errored span (named code)', spans: [llmSpan({ spanId: sid('z'), status: { code: 'error' } })] },
    { id: 'errored span with no message', spans: [llmSpan({ spanId: sid('z'), status: { code: 'error' } })] },
    { id: 'ok status with a message', spans: [llmSpan({ spanId: sid('z'), status: { code: 'ok', message: 'fine' } })] },
    {
      id: 'errored root (drives the failure terminal)',
      spans: [agentSpan({ spanId: sid('r'), status: { code: 'error', message: 'root failed' } })],
    },
    { id: 'end-before-start', spans: [llmSpan({ spanId: sid('z'), startTimeUnixNano: ns(9n), endTimeUnixNano: ns(1n) })] },
    { id: 'end-time-zero', spans: [llmSpan({ spanId: sid('z'), startTimeUnixNano: ns(1n), endTimeUnixNano: '0' })] },
    {
      id: 'end-time-absent',
      spans: [
        (() => {
          const s = llmSpan({ spanId: sid('z') })
          delete s.endTimeUnixNano
          return s
        })(),
      ],
    },
    { id: 'int64-max-nanos', spans: [llmSpan({ spanId: sid('z'), startTimeUnixNano: '9223372036854775807', endTimeUnixNano: '9223372036854775807' })] },
    { id: 'uint64-max-nanos', spans: [llmSpan({ spanId: sid('z'), startTimeUnixNano: '18446744073709551615', endTimeUnixNano: '18446744073709551615' })] },
    { id: 'negative-nanos', spans: [llmSpan({ spanId: sid('z'), startTimeUnixNano: -5, endTimeUnixNano: -1 })] },
    { id: 'nan-nanos', spans: [llmSpan({ spanId: sid('z'), startTimeUnixNano: NaN, endTimeUnixNano: NaN })] },
    { id: 'non-numeric-nanos', spans: [llmSpan({ spanId: sid('z'), startTimeUnixNano: 'not-a-number', endTimeUnixNano: 'also-not' })] },
    { id: 'self-parent', spans: [llmSpan({ spanId: sid('z'), parentSpanId: sid('z') })] },
    {
      id: 'two-cycle',
      spans: [
        llmSpan({ spanId: sid('a'), parentSpanId: sid('b') }),
        llmSpan({ spanId: sid('b'), parentSpanId: sid('a') }),
      ],
    },
    {
      id: 'three-cycle',
      spans: [
        llmSpan({ spanId: sid('a'), parentSpanId: sid('b') }),
        llmSpan({ spanId: sid('b'), parentSpanId: sid('c') }),
        llmSpan({ spanId: sid('c'), parentSpanId: sid('a') }),
      ],
    },
    { id: 'dangling-parent', spans: [llmSpan({ spanId: sid('z'), parentSpanId: sid('nope') })] },
    { id: 'empty-trace-id', spans: [llmSpan({ spanId: sid('z'), traceId: '' })] },
    { id: 'empty-span-id', spans: [llmSpan({ spanId: '' })] },
    { id: 'duplicate-span-ids', spans: [llmSpan({ spanId: sid('z') }), llmSpan({ spanId: sid('z'), name: 'other' })] },
    { id: 'empty-batch', spans: [] },
    {
      id: 'control-and-unicode-attribute-keys',
      spans: [
        {
          traceId: TRACE_A,
          spanId: sid('z'),
          name: 'unmappable',
          startTimeUnixNano: ns(1n),
          endTimeUnixNano: ns(2n),
          attributes: {
            [`${String.fromCharCode(7)}bell`]: 1,
            [`${String.fromCharCode(0xd800)}lone-surrogate`]: 2,
            [`rtl${String.fromCharCode(0x202e)}override`]: 3,
            '': 4,
          },
        },
      ],
    },
    {
      id: 'deeply-nested-attribute-value',
      spans: [
        (() => {
          let deep: Record<string, unknown> = {}
          const root = deep
          for (let i = 0; i < 5000; i += 1) {
            const next: Record<string, unknown> = {}
            deep.next = next
            deep = next
          }
          return { traceId: TRACE_A, spanId: sid('z'), name: 'deep', startTimeUnixNano: ns(1n), endTimeUnixNano: ns(2n), attributes: { deep: root } }
        })(),
      ],
    },
    {
      id: 'ten-thousand-deep-parent-chain',
      spans: Array.from({ length: 2000 }, (_, i) =>
        llmSpan({
          spanId: sid(`n${i}`),
          ...(i === 0 ? {} : { parentSpanId: sid(`n${i - 1}`) }),
          startTimeUnixNano: ns(BigInt(i)),
          endTimeUnixNano: ns(BigInt(i + 5000)),
        }),
      ),
    },
  ]

  for (const c of hostile) {
    it(`survives ${c.id} with a defined, JSON-serializable result`, () => {
      const r = mapper.mapOtelSpansToEvents(c.spans, { receivedAt: RECEIVED_AT })
      expect(r).toBeDefined()
      expect(typeof r.ok).toBe('boolean')
      expect(Array.isArray(r.events)).toBe(true)
      // Convex stores documents; a payload that cannot round-trip through JSON
      // cannot be written at all.
      for (const e of r.events) {
        expect(() => JSON.parse(JSON.stringify(e.payload))).not.toThrow()
        expect(Number.isFinite(e.timestamp), `${c.id} produced a non-finite timestamp`).toBe(true)
        expect(Number.isInteger(e.sequenceNumber)).toBe(true)
        expect(() => BigInt(e.temporalOrder.instantUnixNano)).not.toThrow()
      }
      // CONTIGUITY holds unconditionally, even on garbage.
      expect(r.events.map((e) => e.sequenceNumber)).toEqual(r.events.map((_, i) => i + 1))
      // Rule 5: if anything was emitted, the first event opens the run.
      if (r.events.length > 0) expect((r.events[0] as DerivedEventWrite).type).toBe('run.started')
      // CONSERVATION: every accepted span is covered.
      expect(mapper.verifySpanConservation(c.spans, r.events).missingSpanIds.filter(
        (id) => !r.rejected.some((x) => x.spanId === id),
      )).toEqual([])
    })
  }

  function deepValue(depth: number): Record<string, unknown> {
    let cur: Record<string, unknown> = {}
    const root = cur
    for (let i = 0; i < depth; i += 1) {
      const next: Record<string, unknown> = {}
      cur.next = next
      cur = next
    }
    return root
  }

  /**
   * D4's ORIGINAL mechanism — `JSON.stringify(attributes)` as the duplicate-span
   * tiebreak in `compareDuplicateCandidates` — is FIXED, structurally rather
   * than by a depth cap: `attributeDigest` renders shape only, one level deep,
   * on a byte budget, and never recurses. Verified independently by pushing the
   * depth far past the value that originally broke it, per the retirement
   * standard: a fix that merely raised a threshold would fail at 500k.
   */
  it('the duplicate-span tiebreak no longer recurses, at any depth', () => {
    for (const depth of [60_000, 200_000, 500_000]) {
      const span: SpanInput = {
        traceId: TRACE_A,
        spanId: sid('z'),
        name: 'no rule for this',
        startTimeUnixNano: ns(1n),
        endTimeUnixNano: ns(2n),
        attributes: { deep: deepValue(depth) },
      }
      expect(
        () => mapper.mapOtelSpansToEvents([span, span], { receivedAt: RECEIVED_AT }),
        `the dedupe tiebreak still recurses at depth ${depth} — the fix is a threshold, not a structural change`,
      ).not.toThrow()
    }
  })

  /**
   * D4b — THE SAME HOLE, STILL REACHABLE BY A VARIANT. Not a retirement.
   *
   * `boundValueDepth` (the iterative, depth-12 copy that defused the original)
   * is invoked at exactly ONE site: inside `boundAttributes`, which serves ONLY
   * `otel.span.unmapped` payloads. Four MAPPED payload fields still carry the
   * caller's attribute value RAW and unbounded:
   *
   *   tool.call.input                  <- gen_ai.tool.call.arguments
   *   tool.result.output               <- gen_ai.tool.call.result
   *   llm.request.messages[].content   <- gen_ai.input.messages
   *   custom.data.otel.systemInstructions <- gen_ai.system_instructions
   *
   * `convex/otel_ingest.ts`'s `payloadBytes` does
   * `JSON.stringify(payload)` — recursive — on EVERY event before insert. So the
   * RangeError moved from the mapper to the mutation. No duplicate span needed.
   *
   * SCOPE, STATED HONESTLY: this is currently DEFENCE-IN-DEPTH, not a live
   * outage. Both wire decoders cap `AnyValue` nesting at 16
   * (`decodeProtobuf.ts:104`, `decodeJson.ts:103`), so an OTLP client cannot
   * deliver a value deep enough — proven in
   * `tests/unit/otlp_adversarial_wire.test.ts`. It is reachable by any caller
   * invoking `otelIngestSpans` directly, whose `spanValidator` declares
   * `attributes: v.optional(v.any())` with no depth bound of its own. The entry
   * stays open because the mapper's own guarantee does not hold; the wire cap
   * is the only thing standing in front of it, and that cap is one edit away
   * from being relaxed by someone who does not know it is load-bearing.
   */
  it('[D4b] deep attribute values reaching MAPPED payloads are bounded too', () => {
    const depth = 200_000
    const shapes: Array<{ label: string; attributes: Record<string, unknown> }> = [
      {
        label: 'tool.call.input',
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'thing',
          'gen_ai.tool.call.arguments': deepValue(depth),
        },
      },
      {
        label: 'tool.result.output',
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'thing',
          'gen_ai.tool.call.result': deepValue(depth),
        },
      },
      {
        label: 'llm.request.messages',
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': 'm',
          'gen_ai.input.messages': [{ role: 'user', parts: deepValue(depth) }],
        },
      },
      {
        label: 'custom.systemInstructions',
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.system_instructions': deepValue(depth),
        },
      },
    ]

    let allStorable = true
    for (const shape of shapes) {
      const span: SpanInput = {
        traceId: TRACE_A,
        spanId: sid('v'),
        name: 'variant',
        startTimeUnixNano: ns(1n),
        endTimeUnixNano: ns(2n),
        attributes: shape.attributes,
      }
      let result: MapResult | undefined
      try {
        result = mapper.mapOtelSpansToEvents([span], { receivedAt: RECEIVED_AT })
      } catch {
        allStorable = false
        continue
      }
      // The mutation measures every payload this way before inserting it.
      for (const e of result.events) {
        try {
          JSON.stringify(e.payload)
        } catch {
          allStorable = false
        }
      }
    }
    // D4b RETIRED. `readBoundedContent` routes all four mapped content fields
    // through `boundValueDepth`. Verified at 200k depth on each field, and the
    // ingest boundary's own measurement no longer throws.
    expect(
      allStorable,
      'a deep attribute value on a MAPPED payload is unstorable again — readBoundedContent no longer ' +
        'covers all four content fields',
    ).toBe(true)

    // ANTI-VACUITY: the very same depth routed to an UNMAPPED payload MUST be
    // storable, or this case is measuring "deep things break" rather than "the
    // depth bound is applied on one path and not the other".
    const unmapped: SpanInput = {
      traceId: TRACE_A,
      spanId: sid('u'),
      name: 'no rule for this',
      startTimeUnixNano: ns(1n),
      endTimeUnixNano: ns(2n),
      attributes: { deep: deepValue(depth) },
    }
    const ok = mapper.mapOtelSpansToEvents([unmapped], { receivedAt: RECEIVED_AT })
    for (const e of ok.events) {
      expect(
        () => JSON.stringify(e.payload),
        'even the UNMAPPED path is unstorable at this depth — D4b is not an asymmetry, it is a blanket failure',
      ).not.toThrow()
    }
  })

  /**
   * Malformed W3C ids are a NOTE, not a refusal, so the mapper returns
   * `ok: true` with provenance that `isProvenanceConsistent` rejects. A
   * Rule-1-abiding boundary must therefore drop the whole batch — and
   * `RejectedSpanReport.reason` has no member for "malformed provenance", so
   * the loss cannot even be reported to the caller.
   */
  it('[D9] a batch the mapper accepts produces provenance the boundary can store', () => {
    // Scoped to the ids the boundary's SPAN_ID_RE gate owns. A bad TRACE id is
    // a different path — the mutation takes `traceId` as an explicit argument
    // and files mismatches as `foreign-trace`, which `conservation/*` covers.
    for (const bad of [
      llmSpan({ spanId: 'not-hex' }),
      llmSpan({ spanId: sid('z'), parentSpanId: 'nope!' }),
    ]) {
      // D9 RETIRED. The mapper deliberately treats id well-formedness as a
      // NOTE and delegates enforcement to the boundary; the boundary now
      // rejects PER SPAN (convex/otel_ingest.ts's SPAN_ID_RE gate) instead of
      // costing the batch. Driven through the boundary model, because testing
      // the mapper alone would grade it for a check it does not own.
      const run = new ReferenceIngest()
      const innocent = llmSpan({ spanId: sid('good'), startTimeUnixNano: ns(7n), endTimeUnixNano: ns(8n) })
      const report = run.ingest([bad, innocent])
      expect(report.refusal, 'one malformed id still costs the whole batch').toBeUndefined()
      expect(report.disposition.get(bad.spanId)?.kind, 'the malformed span was not accounted for').toBe('rejected')
      expect(report.disposition.get(innocent.spanId)?.kind, 'an innocent span was lost with it').toBe('mapped')
      expect(
        run.events.every((e) => isProvenanceConsistent(e.provenance)),
        'provenance the boundary must refuse reached the append-only table',
      ).toBe(true)
    }
  })

  it('a hostile batch that IS refused loses no span silently', () => {
    const run = new ReferenceIngest()
    const report = run.ingest([llmSpan({ spanId: sid('z'), traceId: '' })])
    expect(report.unaccounted).toEqual([])
    expect(report.refusal, 'a batch with unstorable provenance must be refused, not written').toBe(
      'malformed-provenance',
    )
    expect(run.events, 'nothing may reach an append-only table from a refused batch').toEqual([])
  })
})

// ===========================================================================
// 5. TENANCY
// ===========================================================================

describe('tenancy — two orgs, one trace id', () => {
  const spansA = [agentSpan({ spanId: sid('r'), traceId: TRACE_A })]
  const spansB = [agentSpan({ spanId: sid('r'), traceId: TRACE_A, name: 'org B secret workflow' })]

  it('two runs built from the same trace id share no state', () => {
    const orgA = new ReferenceIngest()
    const orgB = new ReferenceIngest()
    orgA.ingest(spansA)
    orgB.ingest(spansB)
    expect(orgA.events.length).toBe(orgB.events.length)
    expect(orgA.events.map((e) => e.sequenceNumber)).toEqual(orgB.events.map((e) => e.sequenceNumber))
    // Neither run learned the other exists: org B's span is NOT deduped away
    // by org A having already ingested the same span id.
    expect(orgB.events.length, 'org B lost its span because org A had already ingested that span id').toBeGreaterThan(0)
    const bNames = orgB.events.map((e) => (e.provenance as { spanName?: string }).spanName)
    expect(bNames).toContain('org B secret workflow')
    expect(orgA.events.every((e) => (e.provenance as { spanName?: string }).spanName !== 'org B secret workflow')).toBe(true)
  })

  it('the mapper is pure: it holds no cross-call state that could leak between orgs', () => {
    const first = mapper.mapOtelSpansToEvents(spansA, { receivedAt: RECEIVED_AT })
    const foreign = mapper.mapOtelSpansToEvents(spansB, { receivedAt: RECEIVED_AT })
    const again = mapper.mapOtelSpansToEvents(spansA, { receivedAt: RECEIVED_AT })
    expect(JSON.stringify(again), 'the mapper produced a different result after seeing another org’s batch').toBe(
      JSON.stringify(first),
    )
    expect(foreign.events.length).toBe(first.events.length)
  })

  /**
   * ERROR/CONTENT ORACLE PROBE. Diagnostics are the natural thing for an ingest
   * route to echo back. They must not contain anything the caller did not send:
   * a message that mentioned another tenant's span ids or names would be a
   * cross-org oracle the moment the route surfaces diagnostics.
   */
  it('no diagnostic or rejection mentions data the caller did not submit', () => {
    const mixed = [...spansA, llmSpan({ spanId: sid('x'), traceId: TRACE_B, name: 'other tenant span' })]
    const r = mapper.mapOtelSpansToEvents(mixed, { receivedAt: RECEIVED_AT })
    const submitted = new Set(mixed.map((s) => s.spanId))
    for (const d of r.diagnostics) {
      for (const id of d.spanIds) {
        expect(submitted.has(id), `diagnostic ${d.code} named span ${id}, which the caller did not submit`).toBe(true)
      }
    }
    for (const rej of r.rejected) expect(submitted.has(rej.spanId)).toBe(true)
  })

  /**
   * TIMING ORACLE PROBE. Mapping cost must not depend on whether a trace id is
   * already in use by another tenant — the mapper takes no org and no db, so
   * this should be structurally impossible. Asserted rather than assumed,
   * because the mutation that WILL take an org is the thing this suite is a
   * specification for.
   *
   * Ratio bound is deliberately loose (a CI box is noisy); the case exists to
   * catch an order-of-magnitude difference, which is what a db probe costs.
   */
  it('mapping cost does not depend on another tenant having used the trace id', () => {
    const time = (spans: SpanInput[]): number => {
      const t0 = performance.now()
      for (let i = 0; i < 200; i += 1) mapper.mapOtelSpansToEvents(spans, { receivedAt: RECEIVED_AT })
      return performance.now() - t0
    }
    time(spansA)
    const cold = time([agentSpan({ spanId: sid('r'), traceId: '9'.repeat(32) })])
    const warm = time(spansA)
    const ratio = Math.max(cold, warm) / Math.max(1e-6, Math.min(cold, warm))
    expect(ratio, 'mapping cost varies with the trace id — that is a cross-tenant existence oracle').toBeLessThan(10)
  })

  it('foreign-trace spans never consume this run’s sequence numbers', () => {
    const run = new ReferenceIngest()
    run.ingest([...spansA, llmSpan({ spanId: sid('x'), traceId: TRACE_B })])
    expect(run.events.every((e) => e.provenance.traceId === TRACE_A)).toBe(true)
    expect(run.events.map((e) => e.sequenceNumber)).toEqual(run.events.map((_, i) => i + 1))
  })
})

// ===========================================================================
// 6. TEETH — break the implementation in-memory, assert this suite notices
// ===========================================================================

describe('teeth — every checker in this file must be able to fail', () => {
  const trace = [
    agentSpan({ spanId: sid('r') }),
    llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(20n) }),
  ]

  function stored(): StoredEvent[] {
    const run = new ReferenceIngest()
    run.ingest(trace)
    return run.events
  }

  it('the conservation checker catches a dropped span', () => {
    const r = mapper.mapOtelSpansToEvents(trace, { receivedAt: RECEIVED_AT })
    expect(mapper.verifySpanConservation(trace, r.events).ok).toBe(true)
    const mutilated = r.events.filter((e) => e.provenance.spanId !== trace[1]?.spanId)
    expect(mutilated.length).toBeLessThan(r.events.length)
    expect(
      mapper.verifySpanConservation(trace, mutilated).ok,
      'verifySpanConservation passed a log with a span surgically removed',
    ).toBe(false)
  })

  it('the contiguity gate catches a renumbered event', () => {
    const events = stored()
    expect(events.map((e) => e.sequenceNumber)).toEqual(events.map((_, i) => i + 1))
    const broken = events.map((e, i) => (i === 1 ? { ...e, sequenceNumber: 99 } : e))
    expect(broken.map((e) => e.sequenceNumber)).not.toEqual(broken.map((_, i) => i + 1))
  })

  it('the temporal-order checker catches a shuffled log', () => {
    const events = stored()
    const sortedIds = [...events].sort((a, b) => mapper.compareTemporalOrder(a.temporalOrder, b.temporalOrder))
    const monotonic = (list: StoredEvent[]): boolean =>
      list.every((e, i) => i === 0 || BigInt(e.temporalOrder.instantUnixNano) >= BigInt((list[i - 1] as StoredEvent).temporalOrder.instantUnixNano))
    expect(monotonic(sortedIds)).toBe(true)
    const shuffled = [...sortedIds].reverse()
    expect(
      monotonic(shuffled),
      'the monotonicity checker accepted a reversed log — it proves nothing',
    ).toBe(false)
  })

  it('the canonical-trace comparison catches a single changed instant', () => {
    const events = stored()
    const baseline = canonicalTrace(events)
    const nudged = events.map((e, i) =>
      i === 0
        ? { ...e, temporalOrder: { ...e.temporalOrder, instantUnixNano: '123456789' } }
        : e,
    )
    expect(canonicalTrace(nudged), 'canonicalTrace ignored a changed instant').not.toEqual(baseline)
  })

  it('the post-terminal gate still fires when driven with synthetic events', () => {
    const run = new ReferenceIngest()
    run.ingest([agentSpan({ spanId: sid('r'), startTimeUnixNano: ns(0n), endTimeUnixNano: ns(10n) })])
    expect(run.settle().settled, 'the settle model did not append a terminal').toBe(true)
    expect(run.events.some((e) => e.type === 'run.completed')).toBe(true)

    // The mapper no longer emits after a terminal, so the gate cannot be
    // reached through it. Feeding synthetic events keeps the gate a LIVE
    // self-test rather than a branch nobody can prove still works: it is
    // defence-in-depth against a future mapper change that starts emitting
    // again, and deleting it because today's mapper makes it unreachable is
    // how a defence disappears one refactor before it was needed.
    const late = llmSpan({ spanId: sid('q'), startTimeUnixNano: ns(1n), endTimeUnixNano: ns(2n) })
    const synthetic = mapper.mapOtelSpansToEvents([late], { receivedAt: RECEIVED_AT, terminalPolicy: 'defer' })
    expect(synthetic.events.length, 'the synthetic fixture carries no events, so the gate is not exercised').toBeGreaterThan(0)

    const after = run.ingest([late], synthetic)
    expect(after.refusal, 'the store accepted an append after the terminal event').toBe('RUN_NOT_ACTIVE')
    expect(after.disposition.get(late.spanId)?.kind).toBe('refused')
  })

  /**
   * The other half, and the more valuable one: the gate is asserted to be
   * UNREACHABLE through the real mapper. If a future change starts emitting
   * post-terminal events again, this fails and names the reason — long before
   * anything depends on the tripwire actually holding.
   */
  it('the post-terminal gate is unreachable through the real mapper', () => {
    // Local shapes: `SHAPES` is scoped to the arrival-order block. These only
    // need to be traces that actually SETTLE, since an unsettled run cannot
    // reach the gate at all.
    const settleable: Array<{ name: string; spans: SpanInput[] }> = [
      {
        name: 'root + child',
        spans: [
          agentSpan({ spanId: sid('r'), startTimeUnixNano: ns(0n), endTimeUnixNano: ns(100n) }),
          llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(20n) }),
        ],
      },
      {
        name: 'two true roots',
        spans: [
          agentSpan({ spanId: sid('r'), startTimeUnixNano: ns(0n), endTimeUnixNano: ns(10n) }),
          agentSpan({ spanId: sid('s'), startTimeUnixNano: ns(20n), endTimeUnixNano: ns(30n) }),
        ],
      },
      {
        name: 'errored root',
        spans: [agentSpan({ spanId: sid('r'), status: { code: 'error', message: 'boom' } })],
      },
    ]

    let checked = 0
    for (const shape of settleable) {
      for (const batches of splits(shape.spans)) {
        const run = new ReferenceIngest()
        for (const batch of batches) run.ingest(batch)
        if (!run.settle().settled) continue

        const late = llmSpan({ spanId: sid('late'), startTimeUnixNano: ns(1n), endTimeUnixNano: ns(2n) })
        const report = run.ingest([late])
        checked += 1
        expect(
          report.refusal,
          `${shape.name}: the mapper emitted events after the terminal, so the batch was refused ` +
            'wholesale instead of being reported per span. The tripwire fired in normal operation.',
        ).toBeUndefined()
        expect(
          report.disposition.get(late.spanId),
          `${shape.name}: a post-terminal span was not accounted for per span`,
        ).toEqual({ kind: 'rejected', reason: 'after-terminal' })
      }
    }
    expect(checked, 'no settled run was probed at all').toBeGreaterThanOrEqual(5)
  })

  /**
   * THE STALE-SWEEP ARM. `convex/stale_runs.ts` patches a run to `timed_out`
   * and appends NOTHING, so `hasTerminalEvent` stays false while the run is
   * just as closed. A gate keyed only on the terminal EVENT misses it and falls
   * through to the wholesale throw — the same defect as D6, reached by a
   * different cause.
   *
   * Every other sweep in this file reaches terminality through the settle path,
   * so this state is one none of them can produce.
   */
  it('a run closed by the stale sweep rejects per span, not wholesale', () => {
    const run = new ReferenceIngest()
    run.ingest([agentSpan({ spanId: sid('r'), startTimeUnixNano: ns(0n), endTimeUnixNano: ns(10n) })])

    // The sweep closes the run without appending anything.
    run.markTimedOutByStaleSweep()
    expect(
      run.events.some((e) => e.type === 'run.completed' || e.type === 'run.failed'),
      'the stale-sweep fixture appended a terminal event, so it is not modelling the sweep at all',
    ).toBe(false)
    expect(run.closed, 'the run is not considered closed after the stale sweep').toBe(true)

    const late = llmSpan({ spanId: sid('q'), startTimeUnixNano: ns(1n), endTimeUnixNano: ns(2n) })
    const report = run.ingest([late])
    expect(
      report.refusal,
      'a run closed by STATUS rather than by a terminal event still costs the whole batch',
    ).toBeUndefined()
    expect(
      report.disposition.get(late.spanId),
      'a span arriving after the stale sweep was not accounted for per span',
    ).toEqual({ kind: 'rejected', reason: 'after-terminal' })
  })

  it('the provenance gate catches an inconsistent provenance', () => {
    const events = stored()
    expect(events.every((e) => isProvenanceConsistent(e.provenance))).toBe(true)
    const broken = { ...(events[0] as StoredEvent).provenance, lossy: true, lossReasons: [] }
    expect(
      isProvenanceConsistent(broken as EventProvenance),
      'isProvenanceConsistent accepted lossy:true with no reasons',
    ).toBe(false)
  })

  it('the disposition map catches a span with no disposition', () => {
    const run = new ReferenceIngest()
    const report = run.ingest(trace)
    expect(report.unaccounted).toEqual([])
    report.disposition.delete(trace[0]?.spanId as string)
    const recomputed = trace.map((s) => s.spanId).filter((id) => !report.disposition.has(id))
    expect(recomputed, 'the unaccounted computation cannot detect a missing disposition').toEqual([
      trace[0]?.spanId,
    ])
  })

  it('the REAL expectDefect records a failing probe and ignores a passing one', () => {
    // Drives the shipped helper, not a lookalike: a reimplementation here would
    // agree with itself and prove nothing about the apparatus the ledger uses.
    // The private sink keeps the live ledger clean.
    const sink = new Set<string>()
    expectDefect('teeth-probe', true, sink)
    expect(sink.size, 'expectDefect recorded a defect for a probe that HELD').toBe(0)
    expectDefect('teeth-probe', false, sink)
    expect([...sink], 'expectDefect did not record a probe that FAILED').toEqual(['teeth-probe'])
    expect(observedDefects.has('teeth-probe'), 'the self-test leaked into the live ledger').toBe(false)
  })
})

// ===========================================================================
// 7. PINNED GAPS — components this suite could not reach
// ===========================================================================

describe('storage round trip — what actually survives the write', () => {
  /**
   * THE SHARPEST FINDING IN THIS FILE, and it is executable rather than a grep.
   *
   * `convex/otel_ingest.ts` inserts exactly seven fields plus `provenance`, and
   * `convex/schema.ts`'s `events` table has no column for `temporalOrder`. So
   * the mapper computes the temporal truth, the mutation drops it on the floor,
   * and Team C's `readTemporalOrder` — the function replay uses to decide the
   * order to show an engineer — finds nothing to read.
   *
   * The consequence is not cosmetic. Under ADR-007 outcome (a),
   * `sequenceNumber` is COLLECTOR FLUSH ORDER. If replay falls back to it, a
   * derived run is presented as a timeline in the order the network happened to
   * deliver batches. That is the precise failure `temporalOrder` was introduced
   * to prevent, and it is currently unprevented.
   */
  /**
   * ===================================================================
   * SELF-DESCRIPTION. Not an ordering property — a CONTENT one, and invisible
   * to every other check in this file.
   *
   * The whole suite is built on comparing instants and span ids. A payload that
   * was CLIPPED but says it was not passes every one of those checks: the event
   * count is right, the ordering is right, the span is conserved. The only
   * thing wrong is that the stored content misrepresents itself, and an
   * append-only log makes that permanent.
   *
   * `provenance.lossReasons` is the entire mechanism by which a derived event
   * admits it is not the whole truth. If a field is clipped without
   * `payload-truncated`, an engineer reading the trace sees a tool call whose
   * arguments simply were that short.
   * ===================================================================
   */
  describe('self-description — a clipped payload must admit it', () => {
    /**
     * Nested past `MAX_ATTRIBUTE_VALUE_DEPTH` (12), which is what
     * `readBoundedContent` actually bounds — it clips DEPTH, not string length.
     * The first draft of these fixtures used a 9000-character string and the
     * anti-vacuity guard below caught that nothing was being clipped at all,
     * which is precisely the false green this suite exists to refuse.
     *
     * `SENTINEL` sits below the depth ceiling, so its ABSENCE from the stored
     * payload is proof the value really was cut.
     */
    const SENTINEL = 'deep-leaf-sentinel'
    const HUGE = ((): Record<string, unknown> => {
      let cur: Record<string, unknown> = { leaf: SENTINEL }
      for (let i = 0; i < 40; i += 1) cur = { next: cur }
      return cur
    })()

    const clipped: Array<{ label: string; span: SpanInput; eventType: string }> = [
      {
        label: 'tool.call arguments',
        eventType: 'tool.call',
        span: llmSpan({
          spanId: sid('t'),
          name: 'execute_tool',
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'thing',
            'gen_ai.tool.call.arguments': HUGE,
          },
        }),
      },
      {
        label: 'tool.result output',
        eventType: 'tool.result',
        span: llmSpan({
          spanId: sid('t'),
          name: 'execute_tool',
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'thing',
            'gen_ai.tool.call.result': HUGE,
          },
        }),
      },
      {
        label: 'llm.request input messages',
        eventType: 'llm.request',
        span: llmSpan({
          spanId: sid('t'),
          attributes: {
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': 'm',
            'gen_ai.input.messages': [{ role: 'user', parts: HUGE }],
          },
        }),
      },
      {
        label: 'llm.response output messages',
        eventType: 'llm.response',
        span: llmSpan({
          spanId: sid('t'),
          attributes: {
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': 'm',
            'gen_ai.output.messages': [{ role: 'assistant', parts: HUGE }],
          },
        }),
      },
      {
        label: 'custom system instructions',
        eventType: 'custom',
        span: llmSpan({
          spanId: sid('t'),
          name: 'invoke_agent',
          attributes: {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.system_instructions': HUGE,
          },
        }),
      },
    ]

    for (const c of clipped) {
      it(`${c.label}: clipped content carries payload-truncated`, () => {
        const r = mapper.mapOtelSpansToEvents([c.span], { receivedAt: RECEIVED_AT })
        const event = r.events.find((e) => e.type === c.eventType)
        expect(event, `${c.label}: no ${c.eventType} event was produced at all`).toBeDefined()

        const serialized = JSON.stringify((event as DerivedEventWrite).payload)
        // ANTI-VACUITY: the value must ACTUALLY have been clipped, or the
        // assertion below is satisfied by a payload nobody truncated.
        expect(
          serialized.includes(SENTINEL),
          `${c.label}: the fixture was not clipped, so this case cannot detect a missing marker`,
        ).toBe(false)
        expect(serialized.length, `${c.label}: the field was dropped entirely, not clipped`).toBeGreaterThan(100)

        const reasons = ((event as DerivedEventWrite).provenance as { lossReasons?: string[] }).lossReasons ?? []
        expect(
          reasons,
          `${c.label}: content was CLIPPED and stored reading as complete. A reader sees a value that ` +
            'simply was that short. Under an append-only log this misrepresentation is permanent.',
        ).toContain('payload-truncated')
      })
    }

    it('an UNclipped payload does not claim truncation', () => {
      // The other half: a marker attached unconditionally would be as useless
      // as one never attached, because it would stop distinguishing anything.
      const r = mapper.mapOtelSpansToEvents(
        [
          llmSpan({
            spanId: sid('t'),
            name: 'execute_tool',
            attributes: {
              'gen_ai.operation.name': 'execute_tool',
              'gen_ai.tool.name': 'thing',
              'gen_ai.tool.call.arguments': { shallow: 'short' },
            },
          }),
        ],
        { receivedAt: RECEIVED_AT },
      )
      const call = r.events.find((e) => e.type === 'tool.call') as DerivedEventWrite
      const reasons = (call.provenance as { lossReasons?: string[] }).lossReasons ?? []
      expect(reasons, 'payload-truncated is attached even when nothing was clipped').not.toContain('payload-truncated')
    })

    /**
     * `call_id` is the correlation key that joins a call to its result. When it
     * is synthesized from the span id it is OUR invention, and a reader pairing
     * a result back to its call is relying on exactly the field that may be
     * fictional. `tool.call` disclosed it; the events on the other end of the
     * join did not.
     */
    it('a synthesized call_id is disclosed on every event that carries it', () => {
      for (const [label, status] of [
        ['tool.result', undefined],
        ['tool.error', { code: 'error' as const, message: 'boom' }],
      ] as const) {
        const span = llmSpan({
          spanId: sid('t'),
          name: 'execute_tool',
          // No `gen_ai.tool.call.id`, so the mapper must invent one.
          attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'thing' },
          ...(status !== undefined ? { status } : {}),
        })
        const r = mapper.mapOtelSpansToEvents([span], { receivedAt: RECEIVED_AT })
        const event = r.events.find((e) => e.type === label)
        expect(event, `no ${label} event was produced`).toBeDefined()

        const payload = (event as DerivedEventWrite).payload as { call_id?: string }
        expect(payload.call_id, `${label} carries no call_id to correlate on`).toBeDefined()
        // ANTI-VACUITY: it must genuinely be the synthesized form.
        expect(payload.call_id, `${label}'s call_id is not synthesized, so this case proves nothing`).toContain('otel:')

        const reasons = ((event as DerivedEventWrite).provenance as { lossReasons?: string[] }).lossReasons ?? []
        expect(
          reasons,
          `${label} correlates on a call_id this mapper INVENTED and does not say so. A reader ` +
            'joining a result back to its call is trusting a fictional key.',
        ).toContain('identity-synthesized')
      }
    })

    it('a REAL call_id is not reported as synthesized', () => {
      const span = llmSpan({
        spanId: sid('t'),
        name: 'execute_tool',
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'thing',
          'gen_ai.tool.call.id': 'call_abc123',
        },
      })
      const r = mapper.mapOtelSpansToEvents([span], { receivedAt: RECEIVED_AT })
      for (const type of ['tool.call', 'tool.result']) {
        const event = r.events.find((e) => e.type === type) as DerivedEventWrite
        expect((event.payload as { call_id?: string }).call_id).toBe('call_abc123')
        const reasons = (event.provenance as { lossReasons?: string[] }).lossReasons ?? []
        expect(
          reasons,
          `${type} reports identity-synthesized for a call_id the span actually provided`,
        ).not.toContain('identity-synthesized')
      }
    })
  })

  it('[D10] temporalOrder survives the shape convex/otel_ingest.ts writes', async () => {
    // Moved from apps/web/src/lib/replay/temporal.ts into contracts during this
    // cycle. Imported from the package it now lives in rather than pinned to a
    // path, so a future move is a compile error rather than a silent skip.
    const { readTemporalOrder } = (await import('@agent-flight-recorder/contracts')) as unknown as {
      readTemporalOrder: (e: unknown) => unknown
    }
    expect(typeof readTemporalOrder, 'contracts must export readTemporalOrder').toBe('function')

    const derived = mapper.mapOtelSpansToEvents(
      [
        agentSpan({ spanId: sid('r') }),
        llmSpan({ spanId: sid('a'), parentSpanId: sid('r'), startTimeUnixNano: ns(10n), endTimeUnixNano: ns(20n) }),
      ],
      { receivedAt: RECEIVED_AT },
    )
    expect(derived.events.length).toBeGreaterThan(0)
    expect(
      derived.events.every((e) => typeof e.temporalOrder?.instantUnixNano === 'string'),
      'the mapper stopped emitting temporalOrder — this case now measures nothing',
    ).toBe(true)

    // Exactly the projection `ctx.db.insert("events", { ... })` performs.
    const asStored = derived.events.map((e) => ({
      _id: `evt_${e.sequenceNumber}`,
      runId: 'run_1',
      orgId: 'org_1',
      type: e.type,
      sequenceNumber: e.sequenceNumber,
      timestamp: e.timestamp,
      payload: e.payload,
      provenance: e.provenance,
      // convex/otel_ingest.ts now persists this; convex/schema.ts has the column.
      temporalOrder: e.temporalOrder,
    }))

    const readable = asStored.filter((e) => readTemporalOrder(e) !== undefined)
    // D10 RETIRED. Schema column added, persisted at write, and readable back.
    expect(
      readable.length,
      'temporalOrder does not survive the shape convex/otel_ingest.ts writes, so replay falls back to ' +
        'sequenceNumber — which on this path is collector flush order',
    ).toBe(asStored.length)

    // Anti-vacuity: the SAME reader must succeed when the field IS present, or
    // this case is measuring a broken reader rather than a lossy write.
    const withoutField = asStored.map((event) => {
      // Built by omission rather than by destructuring-and-discarding, which
      // needs an unused binding.
      const copy: Record<string, unknown> = { ...event }
      delete copy['temporalOrder']
      return copy
    })
    expect(
      withoutField.every((e) => readTemporalOrder(e) === undefined),
      'readTemporalOrder returns a key even when the field is absent — it is not reading the stored ' +
        'column and this case proves nothing',
    ).toBe(true)
  })

  /**
   * `ReferenceIngest` models the real mutation's gates. If the mutation's gates
   * change and this model does not, every conservation and idempotency case
   * above silently grades the wrong thing — the exact "measured a different
   * function than the one that ships" failure this suite was told to avoid.
   *
   * Source-level, and therefore weak: driving `otelIngestSpans` needs a Convex
   * test harness that does not exist in `tests/`. It is a drift alarm, not a
   * substitute for executing the mutation. See the report.
   */
  /**
   * DRIVER PARITY, executable rather than scraped.
   *
   * The failure this guards against is the one that actually bit: an earlier
   * revision of `ReferenceIngest` omitted `terminalPolicy` and `hasTerminal`,
   * so every D5/D6/D7 verdict it produced graded a code path the mutation had
   * stopped using. A source-text scan of `otel_ingest.ts` would not have caught
   * that — the mutation was passing the options; the DRIVER was not.
   *
   * So this asserts the mapper genuinely HONOURS both options, which is the
   * only property that makes the driver equivalent to the mutation.
   */
  it('driver-parity: the mapper honours the options convex/otel_ingest.ts passes', () => {
    const closedRoot = agentSpan({ spanId: sid('r'), startTimeUnixNano: ns(0n), endTimeUnixNano: ns(10n) })

    const batchPolicy = mapper.mapOtelSpansToEvents([closedRoot], {
      receivedAt: RECEIVED_AT,
      terminalPolicy: 'batch',
    })
    const deferPolicy = mapper.mapOtelSpansToEvents([closedRoot], {
      receivedAt: RECEIVED_AT,
      terminalPolicy: 'defer',
    })
    expect(
      batchPolicy.terminalType,
      'the "batch" policy no longer emits a terminal, so "defer" proves nothing by contrast',
    ).not.toBeNull()
    expect(
      deferPolicy.terminalType,
      'terminalPolicy: "defer" is IGNORED — the driver and the mutation are both relying on it',
    ).toBeNull()
    expect(deferPolicy.events.some((e) => e.type === 'run.completed' || e.type === 'run.failed')).toBe(false)

    const told = mapper.mapOtelSpansToEvents([llmSpan({ spanId: sid('x') })], {
      receivedAt: RECEIVED_AT,
      lastSequenceNumber: 3,
      knownSpanIds: [],
      hasTerminal: true,
      terminalPolicy: 'defer',
    })
    expect(
      told.diagnostics.map((d) => d.code),
      'hasTerminal is IGNORED — the mapper cannot be told the run is closed',
    ).toContain('already-terminal')
  })

  /**
   * SPAN-INPUT FIELD DRIFT, against a compile-time-proven value.
   *
   * `OTEL_SPAN_INPUT_FIELDS` is exported from contracts specifically so drift
   * tests can compare against a real array rather than scraped text — the
   * interface and the array are proven exhaustive against each other inside
   * that package, so a field added to one and not the other is a compile error
   * there rather than a silent gap here.
   *
   * What this checks is that the FIXTURES in this suite are still built from
   * the full field set. A field added upstream that no case ever populates is a
   * blind spot, and it is invisible without a list to compare against.
   */
  it('driver-parity: this suite exercises every declared OtelSpanInput field', async () => {
    const { OTEL_SPAN_INPUT_FIELDS } = (await import('@agent-flight-recorder/contracts')) as unknown as {
      OTEL_SPAN_INPUT_FIELDS: readonly string[]
    }
    expect(Array.isArray(OTEL_SPAN_INPUT_FIELDS), 'contracts must export OTEL_SPAN_INPUT_FIELDS').toBe(true)
    expect(OTEL_SPAN_INPUT_FIELDS.length).toBeGreaterThan(8)

    // Every field this suite's fixtures can produce, gathered from the shapes
    // actually used above plus the hostile-input matrix.
    const exercised = new Set<string>([
      ...Object.keys(agentSpan({ spanId: sid('r') })),
      ...Object.keys(llmSpan({ spanId: sid('a'), parentSpanId: sid('r') })),
      ...Object.keys(llmSpan({ spanId: sid('e'), status: { code: 'error', message: 'boom' } })),
      // Populated only by specific hostile cases.
      'schemaUrl',
      'spanEventCount',
      'spanLinkCount',
      'scopeName',
    ])
    const never = OTEL_SPAN_INPUT_FIELDS.filter((f) => !exercised.has(f))
    expect(
      never,
      'contracts declares OtelSpanInput fields that no fixture in this suite ever sets — ' +
        'a new field landed upstream and this suite is blind to it',
    ).toEqual([])
  })

  /**
   * The OTLP HTTP route landed while this suite was being written. Wire-level
   * attacks — protobuf/JSON decode confusion, gzip bombs, oversized bodies,
   * `x-api-key` scope, OTLP partial-success semantics — are NOT reachable from
   * a unit suite and are not attempted here. This records that honestly rather
   * than letting the route's absence from the file imply it was cleared.
   */
  it('the OTLP route exists and is NOT covered by this suite', async () => {
    const fs = await import('node:fs/promises')
    await expect(
      fs.access(new URL('../../apps/web/app/api/v1/traces/route.ts', import.meta.url)),
    ).resolves.toBeUndefined()
  })
})

// ===========================================================================
// 8. THE LEDGER
// ===========================================================================

describe('ledger — the exact set of confirmed defects', () => {
  /**
   * This runs last (vitest executes describes in file order) and is the whole
   * point of the file. Read the failure message before "fixing" it.
   */
  /**
   * THE APPARATUS ASSERTS ITS OWN IDLE STATE.
   *
   * With every defect retired the ledger is empty, `expectDefect` has no
   * callers, and the obvious move is to delete it. That would remove the thing
   * that made this suite work — a defect recorded as a LIVE PROBE with an
   * exact-set assertion that cannot go green by self-exempting — and the next
   * person to find a defect here would rebuild it, or more likely reach for
   * `it.skip`, which is the failure mode the whole design exists to refuse.
   *
   * So the empty ledger is asserted rather than incidental. This is the same
   * shape as the post-terminal tripwire in `teeth/*`: a defence that becomes
   * unreachable should assert its own unreachability, not be deleted for being
   * unreached.
   */
  it('the apparatus is live, and the empty ledger is asserted rather than incidental', () => {
    // A real call, through the real helper, into the real sink. It HOLDS, so it
    // records nothing — which is exactly what an empty ledger should look like
    // from the inside.
    expectDefect('ledger-idle-canary', true)
    expect(
      observedDefects.has('ledger-idle-canary'),
      'a probe that HELD was recorded as a defect — the ledger would report phantom regressions',
    ).toBe(false)

    // And the empty state is a claim, not an absence of claims: every defect
    // this suite has ever confirmed is retired, each on evidence gathered here.
    expect(
      KNOWN_DEFECTS.length,
      'the ledger is no longer empty — this case documents the EMPTY steady state and should be ' +
        'updated alongside whatever entry was added',
    ).toBe(0)
    expect(observedDefects.size, 'a defect was recorded before the ledger assertion ran').toBe(0)
  })

  it('matches KNOWN_DEFECTS exactly', () => {
    const observed = [...observedDefects].sort()
    const known = [...KNOWN_DEFECTS].sort()
    const fixed = known.filter((d) => !observed.includes(d))
    const regressed = observed.filter((d) => !known.includes(d as (typeof KNOWN_DEFECTS)[number]))
    expect(
      { fixed, regressed },
      'The OTLP defect ledger moved.\n' +
        '  "fixed"     = a defect this suite confirmed no longer reproduces. Good news: ' +
        'delete it from KNOWN_DEFECTS.\n' +
        '  "regressed" = a NEW defect. Do not add it to KNOWN_DEFECTS to go green; ' +
        'the entries there are confirmed findings with named owners, not a mute list.',
    ).toEqual({ fixed: [], regressed: [] })
  })

  it('no phantom entries: every KNOWN_DEFECTS id is emitted by a real case', () => {
    // If a defect id is in the ledger but nothing ever probes it, the ledger is
    // decoration. Every id must have been reachable: `observedDefects` is
    // populated only by `expectDefect`, which only runs inside a case.
    expect([...observedDefects].sort()).toEqual([...KNOWN_DEFECTS].sort())
  })
})
