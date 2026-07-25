/**
 * Event provenance contract — packages/contracts/src/provenance.ts.
 *
 * The ruling under test: an event DERIVED from an OTel span must be
 * distinguishable from one recorded natively by the SDK. The event log is
 * evidentiary and APPEND-ONLY, so a derived event that looks first-party is a
 * permanent misrepresentation of how strong the evidence is.
 *
 * These tests pin three things:
 *   1. the runtime helpers actually distinguish, and reject self-contradictory
 *      provenance BEFORE it reaches an append-only table;
 *   2. the "absent means native" default is confined to one named function
 *      rather than assumed inline;
 *   3. the TYPE-LEVEL half — that a derived write cannot omit provenance and
 *      cannot claim to be first-party. Those are compile-time facts, so they
 *      are asserted with `@ts-expect-error`, which FAILS the typecheck gate if
 *      the constraint is ever loosened.
 */
import {
  IMPLIED_NATIVE_PROVENANCE,
  isDerivedProvenance,
  isProvenanceConsistent,
  resolveEventProvenance,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  DerivedEvent,
  Event,
  EventProvenance,
  IngestOtelSpansResponse,
  NativeEventProvenance,
  OtelDerivedEventWrite,
  OtelEventProvenance,
  OtelSpanUnmappedPayload,
} from '@agent-flight-recorder/contracts'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN_ID = '00f067aa0ba902b7'
const PARENT_SPAN_ID = 'a1b2c3d4e5f60718'

function otelProvenance(overrides: Partial<OtelEventProvenance> = {}): OtelEventProvenance {
  return {
    source: 'otel',
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    spanName: 'chat gpt-4o',
    semconvVersion: '1.29.0',
    mapperVersion: '0.1.0',
    lossy: false,
    receivedAt: 1_753_400_000_000,
    ...overrides,
  }
}

describe('distinguishing derived events from native ones', () => {
  it('identifies an OTel-derived provenance', () => {
    expect(isDerivedProvenance(otelProvenance())).toBe(true)
  })

  it('does not treat a native recording as derived', () => {
    const native: NativeEventProvenance = { source: 'sdk', sdkVersion: '1.4.2' }
    expect(isDerivedProvenance(native)).toBe(false)
  })

  /**
   * The load-bearing case. An event carrying no provenance is a legacy row,
   * and legacy rows are native — it must NEVER be reported as derived, because
   * that would flip the failure from "derived event looks native" to "native
   * event looks derived", which is the same class of lie in the other
   * direction.
   */
  it('does not treat absent provenance as derived', () => {
    expect(isDerivedProvenance(undefined)).toBe(false)
  })

  it('narrows to OtelEventProvenance so span identity is reachable without a cast', () => {
    const provenance: EventProvenance = otelProvenance({ parentSpanId: PARENT_SPAN_ID })
    if (!isDerivedProvenance(provenance)) throw new Error('expected derived')
    // Reachable only because the predicate is a type guard.
    expect(provenance.traceId).toBe(TRACE_ID)
    expect(provenance.parentSpanId).toBe(PARENT_SPAN_ID)
  })
})

describe('the "absent means native" default is confined to one place', () => {
  it('resolves absent provenance to native', () => {
    expect(resolveEventProvenance(undefined)).toEqual({ source: 'sdk' })
  })

  it('never overrides a provenance that is actually present', () => {
    const provenance = otelProvenance()
    expect(resolveEventProvenance(provenance)).toBe(provenance)
  })

  /**
   * The default must not be silently mutable — it is shared, and a consumer
   * that stamped a `sdkVersion` onto it would retroactively change what every
   * other legacy event appears to claim.
   */
  it('exposes the implied default as an inspectable constant', () => {
    expect(IMPLIED_NATIVE_PROVENANCE).toEqual({ source: 'sdk' })
    expect(IMPLIED_NATIVE_PROVENANCE.source).toBe('sdk')
  })

  it('a legacy event with no provenance field is still a valid Event', () => {
    const legacy: Event = {
      id: 'ev_1',
      runId: 'run_1',
      orgId: 'org_1',
      type: 'llm.request',
      sequenceNumber: 1,
      timestamp: 1_753_400_000_000,
      payload: { type: 'llm.request', model: 'gpt-4o', messages: [] },
    }
    expect(legacy.provenance).toBeUndefined()
    expect(resolveEventProvenance(legacy.provenance).source).toBe('sdk')
  })
})

describe('malformed provenance is rejected before it reaches an append-only table', () => {
  it('accepts a well-formed OTel provenance', () => {
    expect(isProvenanceConsistent(otelProvenance())).toBe(true)
  })

  it('accepts any native provenance', () => {
    expect(isProvenanceConsistent({ source: 'sdk' })).toBe(true)
  })

  /** "Lossy" with no stated reason is an unfalsifiable disclaimer. */
  it('rejects lossy: true with no reasons', () => {
    expect(isProvenanceConsistent(otelProvenance({ lossy: true }))).toBe(false)
    expect(isProvenanceConsistent(otelProvenance({ lossy: true, lossReasons: [] }))).toBe(false)
  })

  it('accepts lossy: true when a reason is given', () => {
    expect(
      isProvenanceConsistent(
        otelProvenance({ lossy: true, lossReasons: ['identity-synthesized'] }),
      ),
    ).toBe(true)
  })

  /** Reasons on a non-lossy mapping is a direct contradiction. */
  it('rejects lossy: false carrying loss reasons', () => {
    expect(
      isProvenanceConsistent(otelProvenance({ lossy: false, lossReasons: ['usage-partial'] })),
    ).toBe(false)
  })

  it('rejects ids that are not W3C-shaped', () => {
    expect(isProvenanceConsistent(otelProvenance({ traceId: 'not-hex' }))).toBe(false)
    expect(isProvenanceConsistent(otelProvenance({ traceId: SPAN_ID }))).toBe(false)
    expect(isProvenanceConsistent(otelProvenance({ spanId: TRACE_ID }))).toBe(false)
    expect(isProvenanceConsistent(otelProvenance({ spanId: '00F067AA0BA902B7' }))).toBe(false)
    expect(isProvenanceConsistent(otelProvenance({ parentSpanId: 'zzzz' }))).toBe(false)
  })

  /**
   * `exactOptionalPropertyTypes` is on repo-wide, so an absent `parentSpanId`
   * is genuinely absent rather than an explicit `undefined` — build it by
   * omission, the way a root span actually arrives.
   */
  it('accepts an omitted parentSpanId (a root span has none)', () => {
    const rootSpan = otelProvenance()
    expect('parentSpanId' in rootSpan).toBe(false)
    expect(isProvenanceConsistent(rootSpan)).toBe(true)
  })

  it('rejects a non-finite or non-positive receivedAt', () => {
    expect(isProvenanceConsistent(otelProvenance({ receivedAt: 0 }))).toBe(false)
    expect(isProvenanceConsistent(otelProvenance({ receivedAt: -1 }))).toBe(false)
    expect(isProvenanceConsistent(otelProvenance({ receivedAt: Number.NaN }))).toBe(false)
  })
})

describe('unmapped spans are recorded, not dropped', () => {
  it('is a real event type with a payload in the EventPayload union', () => {
    const payload: OtelSpanUnmappedPayload = {
      type: 'otel.span.unmapped',
      spanName: 'vendor.custom.step',
      spanKind: 'internal',
      reason: 'no-matching-rule',
      attributes: { 'vendor.step': 3 },
      attributesTruncated: false,
    }
    const event: Event = {
      id: 'ev_2',
      runId: 'run_1',
      orgId: 'org_1',
      type: 'otel.span.unmapped',
      sequenceNumber: 2,
      timestamp: 1_753_400_000_001,
      payload,
      provenance: otelProvenance({ spanName: 'vendor.custom.step' }),
    }
    expect(event.type).toBe('otel.span.unmapped')
    expect(isDerivedProvenance(event.provenance)).toBe(true)
  })

  /**
   * An unmapped span still carries the span identity — in `provenance`, not
   * duplicated into the payload. Without it the record would say "something
   * arrived we could not read" while making it impossible to go read it.
   */
  it('keeps the source span reachable from an unmapped record', () => {
    const provenance = otelProvenance({ lossy: true, lossReasons: ['attributes-dropped'] })
    expect(isProvenanceConsistent(provenance)).toBe(true)
    expect(provenance.spanId).toBe(SPAN_ID)
    expect(provenance.semconvVersion).toBe('1.29.0')
  })

  it('distinguishes recorded-but-unmapped from rejected in the ingest response', () => {
    const response: IngestOtelSpansResponse = {
      eventIds: ['ev_1', 'ev_2'],
      unmappedCount: 1,
      rejected: [{ spanId: SPAN_ID, reason: 'run is not running' }],
    }
    // An unmapped span IS in the log; a rejected one is not. Conflating them
    // is how a dropped span passes for a recorded one.
    expect(response.eventIds).toHaveLength(2)
    expect(response.unmappedCount).toBe(1)
    expect(response.rejected).toHaveLength(1)
  })
})

/**
 * TYPE-LEVEL constraints. These bodies barely run; their purpose is to fail
 * `pnpm typecheck` if the write-path invariant is ever loosened. `@ts-expect-error`
 * is itself an error when the line it guards stops erroring, so a widened type
 * breaks the build rather than quietly passing.
 */
describe('the derived write path cannot omit or launder provenance', () => {
  it('requires provenance on OtelDerivedEventWrite', () => {
    // @ts-expect-error - provenance is REQUIRED on the derived write path.
    const missing: OtelDerivedEventWrite = {
      runId: 'run_1',
      type: 'tool.call',
      sequenceNumber: 1,
      timestamp: 1_753_400_000_000,
      payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' },
    }
    expect(missing).toBeDefined()
  })

  it('forbids a derived write from claiming to be a first-party SDK recording', () => {
    const write: OtelDerivedEventWrite = {
      runId: 'run_1',
      type: 'tool.call',
      sequenceNumber: 1,
      timestamp: 1_753_400_000_000,
      payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' },
      // @ts-expect-error - typed OtelEventProvenance, not EventProvenance:
      // the ingest mapper cannot launder a derived event into a native one.
      provenance: { source: 'sdk' },
    }
    expect(write.runId).toBe('run_1')
  })

  it('requires the fields that make a derived event investigable', () => {
    // @ts-expect-error - semconvVersion, mapperVersion and lossy are all required.
    const underspecified: OtelEventProvenance = {
      source: 'otel',
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      spanName: 'chat gpt-4o',
      receivedAt: 1_753_400_000_000,
    }
    expect(underspecified).toBeDefined()
  })

  it('DerivedEvent narrows an Event to one with OTel provenance', () => {
    const event: Event = {
      id: 'ev_3',
      runId: 'run_1',
      orgId: 'org_1',
      type: 'llm.response',
      sequenceNumber: 3,
      timestamp: 1_753_400_000_002,
      payload: {
        type: 'llm.response',
        model: 'gpt-4o',
        content: 'ok',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      },
      provenance: otelProvenance(),
    }
    if (!isDerivedProvenance(event.provenance)) throw new Error('expected derived')
    const derived: DerivedEvent = event as DerivedEvent
    expect(derived.provenance.traceId).toBe(TRACE_ID)
  })
})
