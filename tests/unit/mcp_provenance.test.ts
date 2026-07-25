/**
 * PROVENANCE MUST SURVIVE THE LAST HOP.
 *
 * `Event.provenance` exists because a derived event is a DIFFERENT KIND OF
 * CLAIM from a first-party one: it is this system's interpretation of somebody
 * else's telemetry, possibly with information dropped on the way in, and — the
 * part that actually breaks a consumer — `sequenceNumber` on a derived run is
 * ingest order, not necessarily temporal order, which is exactly what replay and
 * diff assume it is.
 *
 * Convex records it, the v1 route forwards it, the contracts type it. This suite
 * covers the hop where all of that can still be thrown away for free: the MCP
 * projection, which is the last thing between the stored event and an agent's
 * context window.
 *
 * THIS IS NOT A HYPOTHETICAL FAILURE MODE. `ListPatternsResult.scanTruncated`
 * was computed correctly by Convex, forwarded correctly by the route, typed
 * correctly by the SDK, and dropped at this exact layer — and every test in the
 * repo stayed green, because nothing asserted the last hop. A marker nobody
 * reads is the same as no marker.
 *
 * The two invariants below are therefore asserted directly, on the DEFAULT
 * projection with no options passed, because the default is what an agent
 * actually gets:
 *
 *   1. THE FACT OF DERIVATION SURVIVES. No projection, no option, no window
 *      size may produce an event that looks first-party when it is derived.
 *   2. `lossy` SURVIVES TOO, as a SEPARATE claim. "Derived" and "derived and it
 *      lost information" are different statements about evidentiary strength.
 *
 * The third thing asserted is the ruling's other half: everything BEYOND those
 * two facts is projected down by default, so the badge cannot quietly grow into
 * a 230-byte record paid on every event of every window.
 */
import {
  EVENT_REQUEST_FIELDS,
  MAX_LIMIT,
  MAX_LIMIT_WITH_PROVENANCE,
  PROVENANCE_NAME_BYTE_CAP,
  PROVENANCE_NOTE,
  budgetEventRows,
  toEventRow,
  toProvenanceDetail,
} from '@agent-flight-recorder/mcp'
import { describe, expect, it } from 'vitest'

import {
  TIER4_WINDOW_TOKEN_BUDGET,
  attributeRowBytes,
  byteLength,
  estimateTokens,
  externalizedEvent,
  fatProvenance,
  nearThresholdEvent,
} from './mcp_budgets.js'

import type { Event, EventProvenance, OtelEventProvenance } from '@agent-flight-recorder/contracts'

/** A derived event with the maximal provenance record, and a trivial payload so the row's cost IS the provenance. */
type ProvenanceOverrides = { [K in keyof OtelEventProvenance]?: OtelEventProvenance[K] | undefined }

function derivedEvent(seq: number, provenance: ProvenanceOverrides = {}): Event {
  return {
    id: 'ev_' + String(seq),
    runId: 'run_8f2c1a',
    orgId: 'org_caller',
    sequenceNumber: seq,
    type: 'llm.request',
    timestamp: 1_753_500_000_000 + seq * 1200,
    payload: { type: 'llm.request', model: 'claude-opus-5' },
    provenance: { ...fatProvenance(seq), ...provenance },
  } as unknown as Event
}

/** The same event with no provenance at all — the pre-OTel row, which reads as native. */
function unrecordedEvent(seq: number): Event {
  const event = derivedEvent(seq) as Event & { provenance?: EventProvenance }
  delete event.provenance
  return event
}

/** A first-party SDK recording that says so explicitly. */
function nativeEvent(seq: number): Event {
  return {
    ...derivedEvent(seq),
    provenance: { source: 'sdk', sdkVersion: '0.17.0' },
  } as unknown as Event
}

describe('invariant 1 — the fact of derivation survives projection', () => {
  it('badges a derived event, with no options passed', () => {
    // The DEFAULT call. If this ever needs an argument to tell the truth, the
    // invariant is already broken: nothing about being told what you are
    // reading may be opt-in.
    expect(toEventRow(derivedEvent(18)).derived).toBe('otel')
  })

  it('badges a derived event whose payload was externalized', () => {
    // The artifact branch is a SECOND return path through toEventRow. A badge
    // set on only one of the two branches is a badge that disappears for
    // exactly the events large enough to be interesting.
    const row = toEventRow(externalizedEvent(18))
    expect(row.artifact).toBeDefined()
    expect(row.payload).toBeUndefined()
    expect(row.derived).toBe('otel')
  })

  it('badges every derived event of a full window, through budgetEventRows', () => {
    // budgetEventRows is what the SHIPPED TOOL calls; toEventRow is what tests
    // reach for. Every tier-4 assertion in this repo once called toEventRow
    // directly while the tool called budgetEventRows, so an entire byte-budget
    // stage was referenced nowhere. Assert the path that ships.
    const { rows, derived } = budgetEventRows(Array.from({ length: 50 }, (_, i) => derivedEvent(18 + i)))
    expect(derived).toBe(true)
    expect(rows).toHaveLength(50)
    expect(rows.every((r) => r.derived === 'otel')).toBe(true)
  })

  it('survives the byte budget that drops payloads', () => {
    // A window of near-threshold payloads exhausts WINDOW_PAYLOAD_BYTE_BUDGET
    // partway through and replaces the rest with markers. The badge is not
    // payload data and must not be collateral damage.
    const events = Array.from({ length: 50 }, (_, i) => nearThresholdEvent(18 + i))
    const { rows, truncated } = budgetEventRows(events)
    expect(truncated).toBe(true)
    expect(rows.every((r) => r.derived === 'otel')).toBe(true)
  })

  it('emits NOTHING for a native or unrecorded event, so the badge means something', () => {
    // A badge on every row is not a badge. Absence has to be load-bearing, and
    // it is also what keeps a native window at zero cost.
    for (const event of [nativeEvent(18), unrecordedEvent(18)]) {
      const row = toEventRow(event)
      expect(row.derived).toBeUndefined()
      expect(row.derivedLossy).toBeUndefined()
      expect(JSON.stringify(row)).not.toContain('derived')
    }
  })

  it('asks the read API for provenance, so the server cannot drop it first', () => {
    // The half of this invariant that does not live in toEventRow. `fields` is
    // what the server serializes: a column table that omits `provenance` makes
    // the badge disappear UPSTREAM, on a deployment that had the data — and
    // nothing in this file would look wrong.
    expect(EVENT_REQUEST_FIELDS).toContain('provenance')
  })
})

describe('invariant 2 — `lossy` survives, as a separate claim', () => {
  it('marks a lossy mapping', () => {
    const row = toEventRow(derivedEvent(18))
    expect(row.derived).toBe('otel')
    expect(row.derivedLossy).toBe(true)
  })

  it('distinguishes lossless from lossy — absence is the lossless claim, not silence', () => {
    // `lossy` is a REQUIRED boolean on OtelEventProvenance, so "not stated" is
    // not a state the source record can be in. That is what makes omitting the
    // field here unambiguous rather than merely cheap.
    const lossless = toEventRow(derivedEvent(18, { lossy: false, lossReasons: undefined }))
    expect(lossless.derived).toBe('otel')
    expect(lossless.derivedLossy).toBeUndefined()
  })

  it('never marks lossy without also marking derived', () => {
    // The pair is ordered: "lost information" is unreadable without "derived
    // from what". A row carrying one and not the other is incoherent.
    const rows = [derivedEvent(18), derivedEvent(19, { lossy: false, lossReasons: undefined }), nativeEvent(20)].map(
      (e) => toEventRow(e),
    )
    expect(rows.filter((r) => r.derivedLossy !== undefined && r.derived === undefined)).toHaveLength(0)
  })

  it('is readable without parsing a string — the packed encoding stays rejected', () => {
    // `derived: 'otel-lossy'` would save ~21 B an event and make the MORE
    // important of the two facts reachable only by string-matching a vocabulary
    // that is not the contract's.
    const row = toEventRow(derivedEvent(18))
    expect(row.derived).toBe('otel')
    expect(typeof row.derivedLossy).toBe('boolean')
  })
})

describe('the ruling — projected DOWN by default', () => {
  it('does not emit the full record unless it was asked for', () => {
    const row = toEventRow(derivedEvent(18))
    expect(row.provenance).toBeUndefined()
    const serialized = JSON.stringify(row)
    for (const leaked of ['traceId', 'spanId', 'spanName', 'semconvVersion', 'mapperVersion', 'lossReasons']) {
      expect(serialized).not.toContain(leaked)
    }
  })

  it('emits the full record when it was', () => {
    const row = toEventRow(derivedEvent(18), { includeProvenance: true })
    expect(row.provenance).toMatchObject({
      source: 'otel',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      semconvVersion: '1.29.0',
      mapperVersion: '2026.7.1',
      lossy: true,
    })
    // The badge does NOT disappear on the detail path. A reader finds the two
    // facts at a fixed key regardless of which mode produced the row.
    expect(row.derived).toBe('otel')
    expect(row.derivedLossy).toBe(true)
  })

  it('costs an order of magnitude less than the full record, per event', () => {
    // The whole ruling in one number. ~230 B of provenance projected down to a
    // badge — this is what buys tier 4 back its headroom.
    const compact = byteLength(JSON.stringify(toEventRow(derivedEvent(18))))
    const full = byteLength(JSON.stringify(toEventRow(derivedEvent(18), { includeProvenance: true })))
    const badgeCost = full - byteLength(JSON.stringify({ ...toEventRow(derivedEvent(18)), derived: undefined }))
    expect(full - compact).toBeGreaterThan(200)
    expect(badgeCost).toBeGreaterThan(0)
    // The badge itself is a rounding error next to what it replaces.
    expect(byteLength(JSON.stringify(toProvenanceDetail(fatProvenance(18))))).toBeGreaterThan(
      10 * (byteLength(',"derived":"otel"') + byteLength(',"derivedLossy":true')),
    )
  })

  it('keeps a 50-event derived window inside tier 4’s budget BY DEFAULT', () => {
    const { rows } = budgetEventRows(Array.from({ length: 50 }, (_, i) => externalizedEvent(18 + i)))
    const response = { runId: 'run_8f2c1a', fromSequence: 18, events: rows, provenanceNote: PROVENANCE_NOTE }
    const tokens = estimateTokens(response)
    expect(
      tokens,
      `a saturated derived window costs ~${String(tokens)} tokens, over ${String(TIER4_WINDOW_TOKEN_BUDGET)}.\n` +
        attributeRowBytes(rows as unknown as Record<string, unknown>[]),
    ).toBeLessThanOrEqual(TIER4_WINDOW_TOKEN_BUDGET)
  })

  it('keeps the OPT-IN path inside tier 4’s budget at its own max limit — and would not at MAX_LIMIT', () => {
    // THE REASON MAX_LIMIT_WITH_PROVENANCE EXISTS, asserted rather than
    // asserted-in-a-comment. A full OtelEventProvenance projects to ~500 B at
    // the contract maximum, not the ~230 B a record with one loss reason costs,
    // because `lossReasons` is a closed union of EIGHT. Fifty of those breaches
    // the published 10,000-token ceiling, so the CEILING did not move — the
    // window did.
    const window = (n: number): number => {
      const { rows, derived } = budgetEventRows(
        Array.from({ length: n }, (_, i) => externalizedEvent(18 + i)),
        { includeProvenance: true },
      )
      return estimateTokens({
        runId: 'run_8f2c1a',
        fromSequence: 18,
        events: rows,
        nextFromSequence: 18 + n,
        ...(derived && { provenanceNote: PROVENANCE_NOTE }),
      })
    }
    expect(window(MAX_LIMIT_WITH_PROVENANCE)).toBeLessThanOrEqual(TIER4_WINDOW_TOKEN_BUDGET)
    // The falsifiable half: if this ever stops being true, the lower cap has
    // become unnecessary and should be deleted, not left as folklore.
    expect(window(MAX_LIMIT)).toBeGreaterThan(TIER4_WINDOW_TOKEN_BUDGET)
    expect(MAX_LIMIT_WITH_PROVENANCE).toBeLessThan(MAX_LIMIT)
  })

  it('bounds the two unbounded strings on the detail path', () => {
    // spanName and scopeName are preserved VERBATIM by contract, which means
    // unbounded. Every other field of OtelEventProvenance is bounded by its own
    // shape; these two are the cheap-by-luck bound, one level down.
    const detail = toProvenanceDetail(fatProvenance(18)) as Extract<
      ReturnType<typeof toProvenanceDetail>,
      { source: 'otel' }
    >
    expect(byteLength(detail.spanName)).toBeLessThanOrEqual(PROVENANCE_NAME_BYTE_CAP + 40)

    const hostile = toProvenanceDetail({
      ...fatProvenance(18),
      spanName: 'S'.repeat(4000),
      scopeName: 'C'.repeat(4000),
    }) as Extract<ReturnType<typeof toProvenanceDetail>, { source: 'otel' }>
    expect(hostile.spanName.length).toBeLessThan(4000)
    // Cut, and SAID SO — a silently shortened name is a wrong answer that looks
    // like a right one, which is the failure this package exists to remove.
    expect(hostile.spanName).toContain('truncated')
    expect(hostile.scopeName ?? '').toContain('truncated')
  })
})

describe('the window note', () => {
  it('is emitted once per window, not once per event', () => {
    const { rows, derived } = budgetEventRows(Array.from({ length: 50 }, (_, i) => derivedEvent(18 + i)))
    expect(derived).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('sequenceNumber is ingest order')
    // ~380 B once is affordable; ~380 B fifty times is the anti-pattern this
    // whole file is about.
    expect(byteLength(PROVENANCE_NOTE)).toBeLessThan(byteLength(JSON.stringify(rows)))
  })

  it('says the thing a consumer cannot work out for itself', () => {
    // The ordering caveat is the REASON provenance was made mandatory. A note
    // that only said "this is derived" would duplicate the badge and add
    // nothing.
    expect(PROVENANCE_NOTE).toContain('ingest order')
    expect(PROVENANCE_NOTE).toContain('includeProvenance')
  })

  it('is not emitted for a window with no derived events', () => {
    const { derived } = budgetEventRows(Array.from({ length: 10 }, (_, i) => nativeEvent(18 + i)))
    expect(derived).toBe(false)
  })
})

describe('native provenance on the detail path', () => {
  it('round-trips an SDK recording without inventing fields', () => {
    expect(toProvenanceDetail({ source: 'sdk', sdkVersion: '0.17.0' })).toEqual({
      source: 'sdk',
      sdkVersion: '0.17.0',
    })
    expect(toProvenanceDetail({ source: 'sdk' })).toEqual({ source: 'sdk' })
  })

  it('emits nothing for an event that carries no provenance, even when asked', () => {
    // "Unrecorded" is not "native". `resolveEventProvenance` is the ONE place
    // the absent-means-native default may be applied, and a detail view is
    // explicitly named in the contracts as a caller that must not apply it.
    expect(toEventRow(unrecordedEvent(18), { includeProvenance: true }).provenance).toBeUndefined()
  })
})
