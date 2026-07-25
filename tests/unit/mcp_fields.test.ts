/**
 * SERVER-SIDE FIELD PROJECTION for `packages/mcp` — the `fields` selection each
 * tool sends, and the wire cost it removes.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tests/unit/mcp_progressive_disclosure.test.ts` asserts what the tools EMIT.
 * It cannot fail if the server sends thirty fields and the client throws
 * twenty-five away — which is exactly what this tier did before `fields`
 * (convex/read_api.ts §FIELD PROJECTION) existed. The context window was saved;
 * the wire bytes, the serialization and the backend read were all still paid.
 *
 * So this file asserts the OTHER half: that each tool asks for exactly the
 * columns it emits, and that the request cannot drift from the projection.
 *
 * THE DRIFT THIS GUARDS. The requested list and the emitted list are the same
 * fact stated twice, and the two failure modes are asymmetric:
 *
 *   - a column emitted but not requested reads `undefined` on every row, and an
 *     all-null column is DROPPED by `toColumnar` — it vanishes silently;
 *   - a field requested but not real is a HARD 422 from the read API (rule 2:
 *     an unknown field name is never silently ignored — Convex raises
 *     `INVALID_ARGUMENT`, which the v1 error mapping renders as 422), which
 *     fails the whole tool call rather than one column.
 *
 * The first is why both lists derive from one column table. The second is why
 * the request names are checked against the live Convex schema below.
 *
 * WIRE MEASUREMENT — STATED ASSUMPTION. Bytes are `Buffer.byteLength(
 * JSON.stringify(doc), 'utf8')`, the same estimator the progressive-disclosure
 * suite uses (and /4 for tokens). The "projected" figure is the same document
 * with only the selected fields kept, i.e. what `projectDoc` in
 * convex/read_api.ts produces — measured, not asserted from the other side of
 * the boundary.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseSchemaTableFields } from '../../scripts/check-schema-drift.js'

import type { Event, FailurePattern, Run } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Module seam — same non-literal-specifier trick, and same reason, as
// tests/unit/mcp_progressive_disclosure.test.ts: `packages/mcp` is not a
// workspace dependency of the tests package and has no vitest alias, so a bare
// specifier is unresolvable and a literal relative one is statically analyzed.
// ---------------------------------------------------------------------------

const PROJECTIONS_SPEC = '../../packages/mcp/src/projections.ts'
const FIELD_PROJECTION_SPEC = '../../packages/mcp/src/field-projection.ts'
const EVENTS_WINDOW_SPEC = '../../packages/mcp/src/events-window.ts'
const SDK_SPEC = '../../packages/sdk/src/index.ts'

interface ProjectedColumn {
  column: string
  source: string | null
}

interface Projections {
  PATTERN_COLUMNS: readonly ProjectedColumn[]
  RUN_COLUMNS: readonly ProjectedColumn[]
  EVENT_COLUMNS: readonly ProjectedColumn[]
  PATTERN_FIELDS: readonly string[]
  RUN_FIELDS: readonly string[]
  EVENT_FIELDS: readonly string[]
  PATTERN_REQUEST_FIELDS: readonly string[]
  RUN_REQUEST_FIELDS: readonly string[]
  EVENT_REQUEST_FIELDS: readonly string[]
  columnsOf(columns: readonly ProjectedColumn[]): string[]
  requestFieldsOf(columns: readonly ProjectedColumn[]): string[]
  toRunRow(run: Run): Record<string, unknown>
  toEventRow(event: Event): Record<string, unknown>
  toPatternRow(pattern: FailurePattern, confidence?: unknown): Record<string, unknown>
}

const projections = (await import(/* @vite-ignore */ PROJECTIONS_SPEC)) as Projections

const { withFieldProjection, isProjectionUnsupported } = (await import(
  /* @vite-ignore */ FIELD_PROJECTION_SPEC
)) as {
  withFieldProjection<T>(fields: readonly string[], call: (selection: string[] | undefined) => Promise<T>): Promise<T>
  isProjectionUnsupported(err: unknown): boolean
}

const { fetchEventWindow } = (await import(/* @vite-ignore */ EVENTS_WINDOW_SPEC)) as {
  fetchEventWindow(
    source: unknown,
    runId: string,
    fromSequence: number,
    limit: number,
  ): Promise<{ events: Event[]; nextFromSequence?: number }>
}

const { V1ApiError } = (await import(/* @vite-ignore */ SDK_SPEC)) as {
  V1ApiError: new (
    kind: string,
    message: string,
    opts?: { status?: number },
  ) => Error & { kind: string; status?: number }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/**
 * What the server sends back for a selection: the document with only the
 * selected fields kept, plus the identity field the read API always returns
 * (rule 3). Mirrors `projectDoc` — iterating the DOCUMENT's keys, so a
 * requested-but-unset optional field stays absent rather than becoming `null`.
 */
function projectDoc<T extends Record<string, unknown>>(doc: T, selection: readonly string[], identity: string): T {
  const keep = new Set([...selection, identity])
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(doc)) {
    if (keep.has(key)) out[key] = doc[key]
  }
  return out as T
}

function reduction(before: number, after: number): string {
  return `${String(before)} B -> ${String(after)} B (${(100 - (after / before) * 100).toFixed(1)}% off the wire)`
}

// ---------------------------------------------------------------------------
// The live Convex field vocabulary
// ---------------------------------------------------------------------------

/**
 * Parsed from `convex/schema.ts` rather than restated here, because the whole
 * hazard is a name in this package that the server does not recognize. A
 * hardcoded copy of the vocabulary would agree with itself forever.
 */
const schemaFields = parseSchemaTableFields(
  readFileSync(fileURLToPath(new URL('../../convex/schema.ts', import.meta.url)), 'utf8'),
)

/**
 * `IDENTITY_FIELD` in convex/read_api.ts — the field returned whether or not it
 * was requested. Deliberately not `_id` everywhere: an event is addressed by
 * `sequenceNumber` (Event Log Rule 4) and a pattern by `fingerprintHash`.
 */
const IDENTITY_FIELD = { runs: '_id', events: 'sequenceNumber', failure_patterns: 'fingerprintHash' } as const

const TIERS = [
  {
    tool: 'afr_list_failure_patterns',
    table: 'failure_patterns' as const,
    columns: projections.PATTERN_COLUMNS,
    emitted: projections.PATTERN_FIELDS,
    requested: projections.PATTERN_REQUEST_FIELDS,
  },
  {
    tool: 'afr_list_runs',
    table: 'runs' as const,
    columns: projections.RUN_COLUMNS,
    emitted: projections.RUN_FIELDS,
    requested: projections.RUN_REQUEST_FIELDS,
  },
  {
    tool: 'afr_get_run_events',
    table: 'events' as const,
    columns: projections.EVENT_COLUMNS,
    emitted: projections.EVENT_FIELDS,
    requested: projections.EVENT_REQUEST_FIELDS,
  },
]

// ---------------------------------------------------------------------------
// A. The request is DERIVED from the projection, not written twice
// ---------------------------------------------------------------------------

describe('field selections are derived from the projections’ own column tables', () => {
  for (const tier of TIERS) {
    it(`${tier.tool}: emitted header is exactly columnsOf(table)`, () => {
      expect(
        [...tier.emitted],
        'the columnar header was written out by hand instead of derived — two lists that can disagree ' +
          'is the drift this cycle exists to remove',
      ).toEqual(projections.columnsOf(tier.columns))
    })

    it(`${tier.tool}: request is exactly requestFieldsOf(table)`, () => {
      expect([...tier.requested]).toEqual(projections.requestFieldsOf(tier.columns))
    })

    it(`${tier.tool}: every requested name is a real ${tier.table} field`, () => {
      const valid = schemaFields[tier.table]
      expect(valid, `convex/schema.ts has no ${tier.table} table`).toBeDefined()
      const unknown = tier.requested.filter((f) => !valid!.has(f))
      expect(
        unknown,
        `${tier.tool} would request ${JSON.stringify(unknown)}, which convex/schema.ts's ${tier.table} ` +
          `table does not declare. Read API rule 2 makes an unknown field a HARD ERROR, not a silent ` +
          `drop — this does not degrade the response, it fails the whole tool call.`,
      ).toEqual([])
    })

    it(`${tier.tool}: does not spend a slot on the identity field`, () => {
      // Rule 3: identity comes back regardless. Requesting it is dead weight,
      // and for runs the emitted name (`runId`) is not even a field name the
      // server would accept.
      expect(tier.requested).not.toContain(IDENTITY_FIELD[tier.table])
      expect(tier.requested, 'the SDK guarantees `id`; it is not a Convex field name').not.toContain('id')
    })

    it(`${tier.tool}: requests a non-empty, deduplicated list`, () => {
      // An empty list is a hard error on BOTH sides (SDK RangeError, read API
      // rule 4) — it means a filter or map produced nothing, never "give me
      // everything".
      expect(tier.requested.length).toBeGreaterThan(0)
      expect(new Set(tier.requested).size).toBe(tier.requested.length)
    })

    it(`${tier.tool}: every column with a null source is explained by identity or a join`, () => {
      // A null source means "not read from this document". If that is wrong the
      // field is quietly never requested and the column reads undefined
      // forever, which `toColumnar` then drops without a word.
      const nulls = tier.columns.filter((c) => c.source === null).map((c) => c.column)
      const permitted = new Set([
        IDENTITY_FIELD[tier.table],
        'runId', // renamed `_id` — identity, and not a server field name
        'confidenceState', // joined from the fixConfidence envelope
        'confidenceStale',
      ])
      expect(nulls.filter((c) => !permitted.has(c))).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// B. The projection cannot emit a column the table does not know about
// ---------------------------------------------------------------------------

const PATTERN: FailurePattern = {
  id: 'fp_0',
  orgId: 'org_caller',
  fingerprintHash: '01f3a9c1d4e7b2',
  class: 'tool_error',
  label: 'Tool call failed',
  salientKey: 'search',
  count: 128,
  firstSeenAt: 1_750_000_000_000,
  lastSeenAt: 1_753_400_000_000,
  representativeRunIds: ['run_a', 'run_b', 'run_c', 'run_d', 'run_e'],
  affectedAgentVersionIds: Array.from({ length: 20 }, (_, v) => `ver_${String(v)}`),
  affectedAgentIds: ['agent_a1', 'agent_b2'],
  lastSpikeAssessment: { assessedAt: 1_753_390_000_000, isSpiking: true, recentCount: 44, baselineMean: 6.25, z: 4.81 },
  muted: false,
  status: 'resolved',
  resolvedAt: 1_753_100_000_000,
  resolvedByUserId: 'user_2f9',
  resolutionNote: 'Added retry with jitter on 429 from the provider, plus a circuit breaker.',
  resolutionRef: 'https://github.com/acme/agent/pull/812',
  resolvedInVersionId: 'ver_7c1',
  resolvedAtRunCount: 1204,
  resolvedAtOccurrenceCount: 41,
} as unknown as FailurePattern

const RUN: Run = {
  id: 'run_000001',
  orgId: 'org_caller',
  projectId: 'proj_1',
  agentId: 'agent_a1',
  agentVersionId: 'ver_7c1',
  status: 'failed',
  startedAt: 1_753_400_000_000,
  endedAt: 1_753_400_030_000,
  metadata: { prompt: 'y'.repeat(2000), ticket: 'ACME-4412' },
  tags: ['nightly', 'regression-suite'],
  triggeredBy: 'user_2f9',
  sdkVersion: '0.7.5',
  sessionId: 'sess_31b',
  environment: 'production',
  labels: ['triage', 'flaky'],
  triageState: 'investigating',
  tokensIn: 120_400,
  tokensOut: 8_120,
  searchText: 'z'.repeat(3000),
  modelsSeen: ['claude-opus-5'],
} as unknown as Run

const EVENT: Event = {
  id: 'ev_18',
  runId: 'run_000001',
  orgId: 'org_caller',
  sequenceNumber: 18,
  type: 'llm.response',
  timestamp: 1_753_400_021_600,
  payload: { type: 'llm.response', model: 'claude-opus-5', content: 'x'.repeat(120), finish_reason: 'stop' },
} as unknown as Event

describe('projected rows emit only columns the table declares', () => {
  it('toPatternRow emits no column outside PATTERN_COLUMNS', () => {
    const row = projections.toPatternRow(PATTERN, { fingerprintHash: PATTERN.fingerprintHash, state: 'proving' })
    expect(Object.keys(row).filter((k) => !projections.PATTERN_FIELDS.includes(k))).toEqual([])
  })

  it('toRunRow emits no column outside RUN_COLUMNS', () => {
    expect(Object.keys(projections.toRunRow(RUN)).filter((k) => !projections.RUN_FIELDS.includes(k))).toEqual([])
  })

  it('toEventRow emits no column outside EVENT_COLUMNS', () => {
    // Adding a column here without adding it to the table means it is emitted
    // but never requested — `undefined` on every row once the server honors
    // the selection.
    expect(Object.keys(projections.toEventRow(EVENT)).filter((k) => !projections.EVENT_FIELDS.includes(k))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C. Degradation — a deployment without `?fields=` must still work
// ---------------------------------------------------------------------------

/** The SDK's client-side refusal: `invalid_response` with NO http status. */
function projectionIgnored(): Error {
  return new V1ApiError('invalid_response', 'response carried unrequested field(s)')
}

/**
 * A server-side rejection of a bad field name: the same `kind`, but with an
 * HTTP status. 422, not 400 — Convex raises `INVALID_ARGUMENT` and
 * apps/web/src/lib/apiErrorMapping.ts maps that to 422 on every v1 route, which
 * is the "well-formed request for something that does not exist" case. (400 is
 * the route's own SHAPE rejection: an empty, padded, duplicated or repeated
 * `?fields=`.) The code under test discriminates on `status` being present at
 * all, so it is correct for both — this fixture pins the real one anyway,
 * because a test that encodes the wrong contract teaches the wrong contract.
 */
function unknownFieldName(): Error {
  return new V1ApiError('invalid_response', 'INVALID_ARGUMENT: unknown field "nope"', { status: 422 })
}

describe('withFieldProjection — projection is an optimization, never a dependency', () => {
  it('sends the selection when the deployment honors it', async () => {
    const seen: (string[] | undefined)[] = []
    const out = await withFieldProjection(['status', 'startedAt'], async (selection) => {
      seen.push(selection)
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(seen).toEqual([['status', 'startedAt']])
  })

  it('retries WITHOUT the selection when the deployment ignored it', async () => {
    /**
     * The SDK refuses to hand back a full document dressed as a projection —
     * right for a generic caller, wrong here: this server re-projects every
     * response anyway, so a full document is a correct input, merely an
     * expensive one. Without this retry, adopting `fields` would turn a working
     * tool into a failing one on every pre-projection deployment.
     */
    const seen: (string[] | undefined)[] = []
    const out = await withFieldProjection(['status'], async (selection) => {
      seen.push(selection)
      if (selection !== undefined) throw projectionIgnored()
      return 'full-document'
    })
    expect(out).toBe('full-document')
    expect(seen).toEqual([['status'], undefined])
  })

  it('does NOT retry an unknown field name — a 422 is a bug in the column table', async () => {
    // Read API rule 2 exists so a wrong name fails loudly. Swallowing it with a
    // retry would restore exactly the silent-drop behavior that rule forbids.
    let calls = 0
    await expect(
      withFieldProjection(['nope'], async () => {
        calls++
        throw unknownFieldName()
      }),
    ).rejects.toThrow('unknown field')
    expect(calls).toBe(1)
  })

  it('does not treat an HTTP-derived invalid_response as an ignored projection', () => {
    expect(isProjectionUnsupported(projectionIgnored())).toBe(true)
    expect(isProjectionUnsupported(unknownFieldName())).toBe(false)
    expect(isProjectionUnsupported(new Error('network'))).toBe(false)
  })
})

describe('tier 4 window — degrades one step at a time', () => {
  function event(seq: number): Event {
    return { ...EVENT, id: `ev_${String(seq)}`, sequenceNumber: seq } as unknown as Event
  }

  it('sends the derived selection on the windowed read', async () => {
    const calls: { fields?: string[]; fromSequence?: number }[] = []
    const source = {
      getRunEventWindow: (_runId: string, options: { fromSequence?: number; limit?: number; fields?: string[] }) => {
        calls.push(options)
        return Promise.resolve({ events: [event(7), event(8)], fromSequence: 7 })
      },
      // Not a generator: an empty generator would satisfy `require-yield` only
      // by yielding, and yielding is precisely what must not happen here. This
      // throws the moment anything tries to iterate.
      iterateEvents: (): AsyncIterable<Event> => ({
        [Symbol.asyncIterator]: () => {
          throw new Error('must not page when the windowed read succeeded')
        },
      }),
    }
    const window = await fetchEventWindow(source, 'run_1', 7, 20)
    expect(window.events).toHaveLength(2)
    expect(calls[0]?.fields).toEqual([...projections.EVENT_REQUEST_FIELDS])
  })

  it('retries the WINDOW un-projected before falling back to paging', async () => {
    /**
     * The SDK reports "ignored `fields`" and "ignored `fromSequence`" as the
     * same `invalid_response`. Falling straight back to paging on the first one
     * would cost `ceil(fromSequence / 200)` round trips to work around a
     * problem the server does not have — trying the newer, cheaper thing must
     * never cost the caller the older, working thing.
     */
    const calls: (string[] | undefined)[] = []
    let paged = false
    const source = {
      getRunEventWindow: (_runId: string, options: { fields?: string[] }) => {
        calls.push(options.fields)
        if (options.fields !== undefined) return Promise.reject(projectionIgnored())
        return Promise.resolve({ events: [event(7)], fromSequence: 7 })
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      iterateEvents: async function* (): AsyncGenerator<Event> {
        paged = true
        yield event(1)
      },
    }
    const window = await fetchEventWindow(source, 'run_1', 7, 20)
    expect(window.events.map((e) => e.sequenceNumber)).toEqual([7])
    expect(calls).toEqual([[...projections.EVENT_REQUEST_FIELDS], undefined])
    expect(paged, 'paged despite the un-projected window read succeeding').toBe(false)
  })

  it('still pages when the deployment cannot honor the sequence floor either', async () => {
    const source = {
      getRunEventWindow: () => Promise.reject(projectionIgnored()),
      // eslint-disable-next-line @typescript-eslint/require-await
      iterateEvents: async function* (): AsyncGenerator<Event> {
        for (let seq = 1; seq <= 10; seq++) yield event(seq)
      },
    }
    const window = await fetchEventWindow(source, 'run_1', 7, 2)
    expect(window.events.map((e) => e.sequenceNumber)).toEqual([7, 8])
    expect(window.nextFromSequence).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// D. The measurement — what the selection actually removes from the wire
// ---------------------------------------------------------------------------

describe('wire cost of the derived selections', () => {
  it('afr_list_failure_patterns: a projected pattern is a fraction of the document', () => {
    const full = bytes(PATTERN)
    const projected = bytes(projectDoc(PATTERN as unknown as Record<string, unknown>, projections.PATTERN_REQUEST_FIELDS, 'fingerprintHash'))
    // eslint-disable-next-line no-console
    console.log(`  tier 1 wire/pattern: ${reduction(full, projected)}`)
    expect(projected, `tier 1 wire cost per pattern: ${reduction(full, projected)}`).toBeLessThan(full / 2)
  })

  it('afr_list_runs: the unbounded fields never leave the database', () => {
    const full = bytes(RUN)
    const projected = bytes(projectDoc(RUN as unknown as Record<string, unknown>, projections.RUN_REQUEST_FIELDS, '_id'))
    const serialized = JSON.stringify(
      projectDoc(RUN as unknown as Record<string, unknown>, projections.RUN_REQUEST_FIELDS, '_id'),
    )
    // eslint-disable-next-line no-console
    console.log(`  tier 5 wire/run:     ${reduction(full, projected)}`)
    // `metadata` and `searchText` are the unbounded ones — the reason a run row
    // must not be "the document, minus a few fields chosen by the client".
    expect(serialized).not.toContain('y'.repeat(50))
    expect(serialized).not.toContain('z'.repeat(50))
    expect(projected, `tier 5 wire cost per run: ${reduction(full, projected)}`).toBeLessThan(full / 10)
  })

  it('afr_get_run_events: the selection keeps the payload, because the payload is the point', () => {
    const full = bytes(EVENT)
    const projected = bytes(projectDoc(EVENT as unknown as Record<string, unknown>, projections.EVENT_REQUEST_FIELDS, 'sequenceNumber'))
    // eslint-disable-next-line no-console
    console.log(`  tier 4 wire/event:   ${reduction(full, projected)}`)
    // An honest result, not a flattering one: tier 4's cost IS the payload, and
    // no field selection can remove it. What comes off is `id`, `runId` and
    // `orgId` — a fixed per-event overhead, not a multiplier. The byte budgets
    // in `budgetEventRows`, not `fields`, are what bound this tier.
    expect(projections.EVENT_REQUEST_FIELDS).toContain('payload')
    expect(projected).toBeLessThan(full)
  })
})
