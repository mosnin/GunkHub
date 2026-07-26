/* eslint-disable */
/**
 * ===========================================================================
 * CONFORMANCE SUITE FOR `otelIngestSpans` (convex/otel_ingest.ts, ADR-007).
 * ===========================================================================
 *
 * These tests exercise the REAL Convex mutation through the convex-test
 * harness — the real schema, the real indexes, the real mapper. Nothing here
 * is a reference implementation or a stand-in.
 *
 * The properties under test, and why each one is here rather than being
 * assumed:
 *
 *   DEDUP        A redelivered batch must produce EXACTLY ZERO new events.
 *                OTLP exporters retry on timeout and on 5xx and at-least-once
 *                is the norm, so this is the common case, not the edge one.
 *                Under an append-only log a failure here permanently doubles
 *                the run.
 *   CONTIGUITY   Sequence numbers must be contiguous from 1 with no gaps and
 *                no repeats, ACROSS batches. A gap is unfixable — there is no
 *                update mutation to close it.
 *   CONCURRENCY  Two batches of the SAME trace must produce one run and one
 *                consistent sequence, whichever order they land in.
 *   TENANCY      A trace id from org A must be INDISTINGUISHABLE from missing
 *                when presented by org B. Asserted as EQUALITY OF OUTCOMES
 *                (following convex/tenancy_oracle.test.ts), not merely as
 *                "both throw" — a version that errors for one and succeeds for
 *                the other fails here.
 *   CEILINGS     An over-sized batch is REJECTED WHOLE, never truncated, and
 *                the rejection commits nothing.
 *   HOSTILITY    A malformed or adversarial batch either maps honestly or is
 *                refused. It never half-writes and never writes a row that
 *                cannot be read back.
 *
 * A NOTE ON WHAT THE CONCURRENCY TESTS CAN AND CANNOT PROVE — read this
 * before trusting them further than they go. convex-test executes mutations
 * one at a time against an in-process store; it does NOT simulate Convex's
 * optimistic-concurrency retry. So these tests prove the SERIALIZED OUTCOME is
 * correct for every interleaving of whole mutations — which is exactly what
 * OCC reduces concurrent execution to, and which is what would break if the
 * mutation cached state across calls or resolved the run by anything but the
 * `(orgId, traceId)` index. They do NOT prove the OCC conflict detection
 * itself fires; that is a property of Convex, argued from the index ranges the
 * mutation reads (RULING 2 in convex/otel_ingest.ts) and not observable from
 * here. Stated plainly so nobody reads more into a green suite than it earns.
 */
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'

import { api, internal } from './_generated/api'
import { mapTraceToEvents } from './helpers/otel_mapping'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

// --- fixtures ---------------------------------------------------------------

const TRACE_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const TRACE_B = 'ffeeddccbbaa99887766554433221100'

const KEY_A = 'hash_org_a'
const KEY_B = 'hash_org_b'

/** Epoch nanoseconds as the decimal string OTLP/JSON uses for uint64. */
function nanos(msFromBase: number, baseMs: number): string {
  return (BigInt(baseMs + msFromBase) * 1_000_000n).toString()
}

/** 16-hex span id from a small integer, so fixtures stay readable AND W3C-valid. */
function spanId(n: number): string {
  return n.toString(16).padStart(16, '0')
}

interface SpanOpts {
  parent?: number
  name?: string
  start: number
  end?: number
  attributes?: Record<string, unknown>
  status?: { code: number | 'unset' | 'ok' | 'error'; message?: string }
  traceId?: string
  kind?: 'internal' | 'client' | 'server' | 'producer' | 'consumer' | 'unspecified'
}

function makeSpan(n: number, baseMs: number, opts: SpanOpts): Record<string, unknown> {
  const span: Record<string, unknown> = {
    traceId: opts.traceId ?? TRACE_A,
    spanId: spanId(n),
    name: opts.name ?? 'chat gpt-4o',
    startTimeUnixNano: nanos(opts.start, baseMs),
  }
  if (opts.parent !== undefined) span.parentSpanId = spanId(opts.parent)
  if (opts.end !== undefined) span.endTimeUnixNano = nanos(opts.end, baseMs)
  if (opts.attributes !== undefined) span.attributes = opts.attributes
  if (opts.status !== undefined) span.status = opts.status
  if (opts.kind !== undefined) span.kind = opts.kind
  return span
}

const CHAT_ATTRS = {
  'gen_ai.operation.name': 'chat',
  'gen_ai.provider.name': 'openai',
  'gen_ai.request.model': 'gpt-4o',
  'gen_ai.response.model': 'gpt-4o',
  'gen_ai.usage.input_tokens': 120,
  'gen_ai.usage.output_tokens': 40,
  'gen_ai.response.finish_reasons': ['stop'],
}

const TOOL_ATTRS = {
  'gen_ai.operation.name': 'execute_tool',
  'gen_ai.tool.name': 'search_web',
  'gen_ai.tool.call.id': 'call_abc',
}

/**
 * A well-formed, complete trace: a root `invoke_agent` with a `chat` child and
 * an `execute_tool` grandchild, all closed. The root's closure is what lets
 * the mapper emit a terminal event.
 */
function completeTrace(baseMs: number, traceId = TRACE_A): Record<string, unknown>[] {
  return [
    makeSpan(1, baseMs, {
      start: 0,
      end: 500,
      name: 'invoke_agent researcher',
      attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'researcher' },
      traceId,
    }),
    makeSpan(2, baseMs, { parent: 1, start: 10, end: 200, attributes: CHAT_ATTRS, traceId }),
    makeSpan(3, baseMs, {
      parent: 2,
      start: 210,
      end: 300,
      name: 'execute_tool search_web',
      attributes: TOOL_ATTRS,
      traceId,
    }),
  ]
}

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: any) => {
    const now = Date.now()
    const orgA = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_a', name: 'Org A', slug: 'org-a', plan: 'pro', createdAt: now, updatedAt: now,
    })
    const orgB = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_b', name: 'Org B', slug: 'org-b', plan: 'pro', createdAt: now, updatedAt: now,
    })
    const projA = await ctx.db.insert('projects', { orgId: orgA, name: 'PA', slug: 'pa', createdAt: now, updatedAt: now })
    const projB = await ctx.db.insert('projects', { orgId: orgB, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projA, name: 'Agent A', slug: 'a', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projB, name: 'Agent B', slug: 'b', createdAt: now, updatedAt: now })

    await ctx.db.insert('api_keys', {
      orgId: orgA, keyHash: KEY_A, name: 'A key', createdBy: 'u_a', createdAt: now, scopes: ['ingest:write'],
    })
    await ctx.db.insert('api_keys', {
      orgId: orgB, keyHash: KEY_B, name: 'B key', createdBy: 'u_b', createdAt: now, scopes: ['ingest:write'],
    })
    return { orgA, orgB, projA, projB, agentA, agentB }
  })
}

/** Capture an outcome as a COMPARABLE value — the tenancy tests compare these with toEqual. */
async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function eventsOf(t: ReturnType<typeof convexTest>, runId: string) {
  return await t.run(async (ctx: any) => {
    return await ctx.db
      .query('events')
      .withIndex('by_run', (q: any) => q.eq('runId', runId))
      .collect()
  })
}

async function allRuns(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: any) => await ctx.db.query('runs').collect())
}

const BASE = Date.now() - 60_000

// ===========================================================================
describe('otelIngestSpans — happy path and run materialization', () => {
  it('materializes a run keyed on (orgId, traceId) and appends a contiguous, provenance-carrying sequence', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA, projA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      agentVersion: '2.4.1',
      spans: completeTrace(BASE) as any,
    })

    expect(res.runCreated).toBe(true)
    expect(res.rejected).toEqual([])
    expect(res.eventIds.length).toBeGreaterThan(0)
    expect(res.firstSequenceNumber).toBe(1)

    const runs = await allRuns(t)
    expect(runs).toHaveLength(1)
    expect(runs[0].otelTraceId).toBe(TRACE_A)
    expect(runs[0].orgId).toBe(orgA)
    expect(runs[0].projectId).toBe(projA)
    // STILL RUNNING even though the trace looks complete. Terminality is
    // deferred to the settle sweep — "every span in this batch is closed" is a
    // fact about a batch, not about a trace, and deciding on it is what used to
    // lose a span that arrived in a later batch. See convex/otel_settle.ts.
    expect(runs[0].status).toBe('running')
    // But the closed root WAS observed and recorded, which is what arms settle.
    expect(runs[0].otelRoot?.spanId).toBe(spanId(1))
    expect(runs[0].otelRoot?.status).toBe('unset')
    expect(runs[0].otelLastAppendAt).toBeGreaterThan(0)

    const events = await eventsOf(t, runs[0]._id)
    expect(events.map((e: any) => e.sequenceNumber)).toEqual(
      events.map((_: any, i: number) => i + 1),
    )
    expect(events[0].type).toBe('run.started')
    // No terminal from an ingest batch, ever.
    expect(events.some((e: any) => e.type === 'run.completed' || e.type === 'run.failed')).toBe(false)

    // D10: every derived row carries its temporal key. Without it the log is
    // permanently unorderable — there is no backfill that is not a rewrite of
    // history.
    for (const e of events) {
      expect(e.temporalOrder, `event ${e.sequenceNumber} must carry temporalOrder`).toBeDefined()
      expect(e.temporalOrder.instantUnixNano).toMatch(/^\d+$/)
      expect(e.temporalOrder.rawInstantUnixNano).toMatch(/^\d+$/)
      expect(['open', 'close']).toContain(e.temporalOrder.phase)
    }

    // EVERY row is marked derived. Not one can pass for a first-party recording.
    for (const e of events) {
      expect(e.provenance?.source).toBe('otel')
      expect(e.provenance?.traceId).toBe(TRACE_A)
      expect(e.provenance?.mapperVersion).toBeTruthy()
      expect(e.provenance?.semconvVersion).toBeTruthy()
      expect(e.provenance?.spanId).toMatch(/^[0-9a-f]{16}$/)
    }

    // The llm.request/llm.response pair really was derived from the chat span.
    expect(events.map((e: any) => e.type)).toContain('llm.request')
    expect(events.map((e: any) => e.type)).toContain('llm.response')
    expect(events.map((e: any) => e.type)).toContain('tool.call')

    // ADR-002 denormalized counters are populated on the derived path too, so
    // a derived run is not second-class on the analytics surfaces.
    expect(runs[0].tokensIn).toBe(120)
    expect(runs[0].tokensOut).toBe(40)
    expect(runs[0].modelsSeen).toContain('gpt-4o')
  })

  it('get-or-creates exactly one immutable AgentVersion across repeated traces naming it', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    for (const [i, trace] of [TRACE_A, TRACE_B].entries()) {
      await t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A,
        traceId: trace,
        agentId: agentA,
        agentVersion: '2.4.1',
        spans: completeTrace(BASE + i * 1000, trace) as any,
      })
    }

    const versions = await t.run(async (ctx: any) => await ctx.db.query('agent_versions').collect())
    expect(versions).toHaveLength(1)
    expect(versions[0].version).toBe('2.4.1')

    const runs = await allRuns(t)
    expect(runs).toHaveLength(2)
    expect(new Set(runs.map((r: any) => r.agentVersionId))).toEqual(new Set([versions[0]._id]))
  })

  it('invents no AgentVersion when the caller names none', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE) as any,
    })

    const versions = await t.run(async (ctx: any) => await ctx.db.query('agent_versions').collect())
    expect(versions).toEqual([])
    const runs = await allRuns(t)
    expect(runs[0].agentVersionId).toBeUndefined()
  })
})

// ===========================================================================
describe('DEDUP — idempotent redelivery', () => {
  it('a redelivered batch produces EXACTLY ZERO new events and no second run', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    const spans = completeTrace(BASE)

    const first = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
    })
    const runId = first.runId
    const afterFirst = await eventsOf(t, runId)
    expect(afterFirst.length).toBeGreaterThan(0)

    // Redeliver the IDENTICAL batch. The run has since terminated, which is
    // the realistic case: the exporter's retry arrives after the root closed.
    const second = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
    })

    expect(second.runId).toBe(runId)
    expect(second.runCreated).toBe(false)
    expect(second.eventIds).toEqual([])
    expect(second.firstSequenceNumber).toBeNull()
    // Every span reported as NOT recorded, with the honest reason.
    expect(second.rejected.map((r: any) => r.reason).sort()).toEqual(
      spans.map(() => 'already-known'),
    )

    const afterSecond = await eventsOf(t, runId)
    expect(afterSecond.map((e: any) => e._id)).toEqual(afterFirst.map((e: any) => e._id))
    expect(await allRuns(t)).toHaveLength(1)
  })

  it('redelivery is a NO-OP rather than RUN_NOT_ACTIVE — an exporter must be able to stop retrying', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    const spans = completeTrace(BASE)

    const first = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
    })
    // A redelivery must SUCCEED as a no-op...
    const redelivery = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
      }),
    )
    expect(redelivery.ok).toBe(true)
    expect(redelivery.value!.eventIds).toEqual([])

    // ...AND a genuinely new span must still be accepted, because the run has
    // NOT been closed by the batch that carried the root. This is the whole
    // point of deferring terminality: under the old per-batch rule this span
    // was refused with RUN_NOT_ACTIVE and lost permanently, purely because the
    // exporter happened to flush the root before it.
    const late = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A,
        traceId: TRACE_A,
        agentId: agentA,
        spans: [makeSpan(9, BASE, { parent: 1, start: 400, end: 450, attributes: CHAT_ATTRS })] as any,
      }),
    )
    expect(late.ok).toBe(true)
    const events = await eventsOf(t, first.runId)
    expect(events.some((e: any) => e.provenance.spanId === spanId(9))).toBe(true)
    expect(events.map((e: any) => e.sequenceNumber)).toEqual(events.map((_: any, i: number) => i + 1))
  })

  it('refuses a genuinely new span ONLY once the run has actually been settled', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE) as any,
    })

    // Force the trace quiet, then settle it as the scheduler would.
    await t.run(async (ctx: any) => {
      await ctx.db.patch(res.runId, { otelLastAppendAt: Date.now() - 10 * 60 * 1000 })
    })
    const settled = await t.mutation(internal.otel_settle.settleOtelTrace, { runId: res.runId })
    expect(settled.settled).toBe(true)
    expect(settled.reason).toBe('run.completed')

    const events = await eventsOf(t, res.runId)
    expect(events[events.length - 1].type).toBe('run.completed')
    expect(events.map((e: any) => e.sequenceNumber)).toEqual(events.map((_: any, i: number) => i + 1))
    const runs = await allRuns(t)
    expect(runs[0].status).toBe('completed')

    // D6. A late span is REJECTED PER SPAN, not by refusing the batch.
    //
    // Event Log Rule 5 makes it permanently unrecordable, so the honest report
    // is "this span was lost, here is its id" — a partial success an OTLP
    // exporter can act on. A whole-batch RUN_NOT_ACTIVE discarded the trace's
    // tail with no accounting AND handed the exporter a 5xx it would retry
    // forever.
    const late = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
        spans: [makeSpan(9, BASE, { parent: 1, start: 400, end: 450, attributes: CHAT_ATTRS })] as any,
      }),
    )
    expect(late.ok).toBe(true)
    expect(late.value!.eventIds).toEqual([])
    expect(late.value!.rejected).toEqual([{ spanId: spanId(9), reason: 'after-terminal' }])
    // Nothing was appended after the terminal.
    const afterLate = await eventsOf(t, res.runId)
    expect(afterLate[afterLate.length - 1].type).toBe('run.completed')
    expect(afterLate.every((e: any) => e.provenance.spanId !== spanId(9))).toBe(true)

    // ...and a REDELIVERY after close keeps its own reason. A retry is not
    // data loss, and reporting it as `after-terminal` would tell an operator a
    // span was dropped when nothing was.
    const redelivery = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE) as any,
      }),
    )
    expect(redelivery.ok).toBe(true)
    expect(redelivery.value!.eventIds).toEqual([])
    expect(redelivery.value!.rejected.map((r: any) => r.reason)).toEqual(
      completeTrace(BASE).map(() => 'already-known'),
    )
  })

  it('a closed run rejects late spans per span even with NO terminal event (the stale-sweep twin)', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE) as any,
    })

    // convex/stale_runs.ts patches a run to `timed_out` and appends NOTHING, so
    // `hasTerminalEvent` stays false while the run is just as closed. Passing
    // only `hasTerminalEvent` to the mapper would leave an exact twin of D6
    // reachable through the stale sweep.
    await t.run(async (ctx: any) => {
      await ctx.db.patch(res.runId, { status: 'timed_out', endedAt: Date.now() })
    })

    const late = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
        spans: [makeSpan(9, BASE, { parent: 1, start: 400, end: 450, attributes: CHAT_ATTRS })] as any,
      }),
    )
    expect(late.ok).toBe(true)
    expect(late.value!.rejected).toEqual([{ spanId: spanId(9), reason: 'after-terminal' }])
    expect(late.value!.eventIds).toEqual([])
    // The diagnostic names the lost span, so the loss is visible in the
    // response rather than inferred from silence.
    const diag = late.value!.diagnostics.find((d: any) => d.code === 'already-terminal')
    expect(diag).toBeDefined()
    expect(diag.spanIds).toEqual([spanId(9)])
  })

  it('partial redelivery records only the genuinely new spans', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    // Batch 1: root still open (no end time), so no terminal event yet.
    const openRoot = makeSpan(1, BASE, { start: 0, name: 'invoke_agent researcher',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } })
    const chat = makeSpan(2, BASE, { parent: 1, start: 10, end: 200, attributes: CHAT_ATTRS })
    const tool = makeSpan(3, BASE, { parent: 1, start: 210, end: 300,
      name: 'execute_tool search_web', attributes: TOOL_ATTRS })

    const b1 = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [openRoot, chat] as any,
    })
    expect(b1.runOpen).toBe(true)
    const countAfter1 = (await eventsOf(t, b1.runId)).length

    // Batch 2 REPEATS both spans and adds one. Only the new one may land.
    const b2 = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [openRoot, chat, tool] as any,
    })
    expect(b2.rejected.filter((r: any) => r.reason === 'already-known')).toHaveLength(2)

    const events = await eventsOf(t, b1.runId)
    const spanIds = events.map((e: any) => e.provenance.spanId)
    // No span appears twice.
    expect(new Set(spanIds).size).toBeLessThanOrEqual(spanIds.length)
    for (const id of [spanId(1), spanId(2), spanId(3)]) {
      // each span contributed at least one event, and its events are unique per phase
      expect(spanIds).toContain(id)
    }
    expect(events.length).toBeGreaterThan(countAfter1)
    // CONTIGUITY still holds across the two batches.
    expect(events.map((e: any) => e.sequenceNumber)).toEqual(
      events.map((_: any, i: number) => i + 1),
    )
  })

  it('a duplicate span id WITHIN one batch is recorded once and reported', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    const chat = makeSpan(2, BASE, { parent: 1, start: 10, end: 200, attributes: CHAT_ATTRS })

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      spans: [makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
        attributes: { 'gen_ai.operation.name': 'invoke_agent' } }), chat, { ...chat }] as any,
    })

    expect(res.rejected.some((r: any) => r.reason === 'duplicate')).toBe(true)
    const events = await eventsOf(t, res.runId)
    const chatEvents = events.filter((e: any) => e.provenance.spanId === spanId(2))
    // One open + one close for the chat span, not two of each.
    expect(chatEvents.filter((e: any) => e.type === 'llm.request')).toHaveLength(1)
    expect(chatEvents.filter((e: any) => e.type === 'llm.response')).toHaveLength(1)
  })
})

// ===========================================================================
describe('CONTIGUITY and CONCURRENCY — same-trace batches', () => {
  it('sequence numbers are contiguous from 1 across many batches', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    // Root stays open across every batch so nothing terminates early.
    const root = makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } })
    let runId = ''
    for (let i = 0; i < 6; i += 1) {
      const batch = [
        root,
        makeSpan(10 + i, BASE, { parent: 1, start: 10 + i * 10, end: 15 + i * 10, attributes: CHAT_ATTRS }),
      ]
      const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: batch as any,
      })
      runId = res.runId
    }

    const events = await eventsOf(t, runId)
    const seqs = events.map((e: any) => e.sequenceNumber)
    expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1)) // no gaps
    expect(new Set(seqs).size).toBe(seqs.length)                    // no repeats
    expect(await allRuns(t)).toHaveLength(1)
  })

  it('two concurrent FIRST batches of the same trace produce exactly one run', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const left = [makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } })]
    const right = [makeSpan(2, BASE, { start: 5, end: 60, attributes: CHAT_ATTRS })]

    // Dispatched without awaiting in between. convex-test serializes them (see
    // the header note); the invariant asserted is the one that must hold for
    // EITHER serialization, which is what Convex's OCC retry reduces genuine
    // concurrency to.
    const [a, b] = await Promise.all([
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: left as any,
      }),
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: right as any,
      }),
    ])

    expect(a.runId).toBe(b.runId)
    // Exactly one of them materialized the run.
    expect([a.runCreated, b.runCreated].filter(Boolean)).toHaveLength(1)
    expect(await allRuns(t)).toHaveLength(1)

    const events = await eventsOf(t, a.runId)
    const seqs = events.map((e: any) => e.sequenceNumber)
    expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1))
    // Both spans are present exactly once.
    const spanIds = new Set(events.map((e: any) => e.provenance.spanId))
    expect(spanIds).toEqual(new Set([spanId(1), spanId(2)]))
  })

  it('concurrent batches carrying the SAME span produce it once', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    const shared = makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } })

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        t.mutation(api.otel_ingest.otelIngestSpans, {
          apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [shared] as any,
        }),
      ),
    )

    expect(new Set(results.map((r: any) => r.runId)).size).toBe(1)
    const events = await eventsOf(t, results[0].runId)
    expect(events.filter((e: any) => e.provenance.spanId === spanId(1) && e.type === 'run.started'))
      .toHaveLength(1)
    // Two of the three calls were pure redeliveries.
    expect(results.filter((r: any) => r.eventIds.length === 0)).toHaveLength(2)
  })

  it('two DIFFERENT traces for the same agent get two independent runs, each numbered from 1', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const a = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE, TRACE_A) as any,
    })
    const b = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_B, agentId: agentA, spans: completeTrace(BASE, TRACE_B) as any,
    })

    expect(a.runId).not.toBe(b.runId)
    expect(a.firstSequenceNumber).toBe(1)
    expect(b.firstSequenceNumber).toBe(1)
    for (const runId of [a.runId, b.runId]) {
      const events = await eventsOf(t, runId)
      expect(events.map((e: any) => e.sequenceNumber)).toEqual(events.map((_: any, i: number) => i + 1))
    }
  })
})

// ===========================================================================
describe('TENANCY — a foreign trace id is indistinguishable from a novel one', () => {
  it('org B presenting org A\'s trace id gets the SAME outcome shape as a trace id nobody has used', async () => {
    const t = convexTest(schema, modules)
    const { agentA, agentB, orgA, orgB } = await seed(t)

    // Org A records a trace.
    const aRes = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE, TRACE_A) as any,
    })

    // Org B presents (i) org A's trace id and (ii) a trace id nobody has used.
    const foreign = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_B, traceId: TRACE_A, agentId: agentB, spans: completeTrace(BASE, TRACE_A) as any,
      }),
    )
    const novel = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_B, traceId: TRACE_B, agentId: agentB, spans: completeTrace(BASE, TRACE_B) as any,
      }),
    )

    // EQUALITY OF OUTCOMES, field by field, with only the identifiers (which
    // are per-run by construction) elided. No error, no timing tell, no
    // difference in what B learns. This is stronger than "both throw the same
    // message": there is no failure mode at all to distinguish.
    const shape = (o: any) => ({
      ok: o.ok,
      error: o.error,
      runCreated: o.value?.runCreated,
      eventCount: o.value?.eventIds.length,
      firstSequenceNumber: o.value?.firstSequenceNumber,
      rejected: o.value?.rejected,
      terminalType: o.value?.terminalType,
      runOpen: o.value?.runOpen,
    })
    expect(shape(foreign)).toEqual(shape(novel))

    // And the underlying separation is real, not merely unobservable.
    const runs = await allRuns(t)
    expect(runs).toHaveLength(3)
    const aRun = runs.find((r: any) => r._id === aRes.runId)
    expect(aRun.orgId).toBe(orgA)
    const bRunsForTraceA = runs.filter((r: any) => r.orgId === orgB && r.otelTraceId === TRACE_A)
    expect(bRunsForTraceA).toHaveLength(1)
    expect(bRunsForTraceA[0]._id).not.toBe(aRes.runId)

    // Org A's events were not touched, and org B's run carries only its own.
    const aEvents = await eventsOf(t, aRes.runId)
    expect(aEvents.every((e: any) => e.orgId === orgA)).toBe(true)
    const bEvents = await eventsOf(t, bRunsForTraceA[0]._id)
    expect(bEvents.every((e: any) => e.orgId === orgB)).toBe(true)
  })

  it('a foreign agentId is indistinguishable from a missing and from a malformed one', async () => {
    const t = convexTest(schema, modules)
    const { agentB } = await seed(t)
    const spans = completeTrace(BASE)

    const call = (agentId: string) =>
      outcome(() =>
        t.mutation(api.otel_ingest.otelIngestSpans, {
          apiKeyHash: KEY_A, traceId: TRACE_A, agentId, spans: spans as any,
        }),
      )

    const foreign = await call(agentB)                       // exists, org B
    const missing = await call(agentB.replace(/.$/, 'z'))     // well-shaped, absent
    const malformed = await call('not-an-id')                 // not an id at all

    expect(foreign).toEqual(missing)
    expect(foreign).toEqual(malformed)
    expect(foreign.ok).toBe(false)
    expect(foreign.error).toContain('Agent not found')
    // Nothing was created by any of the three.
    expect(await allRuns(t)).toEqual([])
  })

  it('rejects an unknown, revoked, expired, or under-scoped key without creating anything', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seed(t)
    await t.run(async (ctx: any) => {
      const now = Date.now()
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'revoked', name: 'r', createdBy: 'u', createdAt: now, revokedAt: now })
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'expired', name: 'e', createdBy: 'u', createdAt: now, expiresAt: now - 1 })
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'readonly', name: 'ro', createdBy: 'u', createdAt: now, scopes: ['read'] })
    })

    for (const hash of ['nonexistent', 'revoked', 'expired', 'readonly']) {
      const res = await outcome(() =>
        t.mutation(api.otel_ingest.otelIngestSpans, {
          apiKeyHash: hash, traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE) as any,
        }),
      )
      expect(res.ok, `key ${hash} must be refused`).toBe(false)
    }
    expect(await allRuns(t)).toEqual([])
    expect(await t.run(async (ctx: any) => await ctx.db.query('events').collect())).toEqual([])
  })

  it('spans naming a different trace are REJECTED, never numbered into this run', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const mine = completeTrace(BASE, TRACE_A)
    const theirs = [makeSpan(7, BASE, { start: 0, end: 10, attributes: CHAT_ATTRS, traceId: TRACE_B })]

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [...mine, ...theirs] as any,
    })

    expect(res.rejected).toContainEqual({ spanId: spanId(7), reason: 'foreign-trace' })
    const events = await eventsOf(t, res.runId)
    expect(events.every((e: any) => e.provenance.traceId === TRACE_A)).toBe(true)
    expect(events.every((e: any) => e.provenance.spanId !== spanId(7))).toBe(true)
    // Only one run — the foreign span did NOT materialize a run for TRACE_B.
    expect(await allRuns(t)).toHaveLength(1)
  })

  it('a batch with NOTHING for the named trace creates no run at all', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
        spans: [makeSpan(7, BASE, { start: 0, end: 10, attributes: CHAT_ATTRS, traceId: TRACE_B })] as any,
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('INVALID_ARGUMENT')
    expect(await allRuns(t)).toEqual([])
  })
})

// ===========================================================================
describe('CEILINGS — reject, never truncate', () => {
  it('an over-sized batch is refused WHOLE and commits nothing', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const spans = Array.from({ length: 1001 }, (_, i) =>
      makeSpan(i + 1, BASE, { start: i, end: i + 1, attributes: CHAT_ATTRS }),
    )
    const res = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
      }),
    )

    expect(res.ok).toBe(false)
    expect(res.error).toContain('BATCH_TOO_LARGE')
    // THE POINT OF THE TEST: not one span was recorded. A truncating ingest
    // would have written 1000 of them and returned success.
    expect(await allRuns(t)).toEqual([])
    expect(await t.run(async (ctx: any) => await ctx.db.query('events').collect())).toEqual([])
  })

  it('a batch exactly at the ceiling is accepted', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    const spans = Array.from({ length: 1000 }, (_, i) =>
      makeSpan(i + 1, BASE, { start: i, end: i + 1, attributes: CHAT_ATTRS }),
    )
    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
    })
    expect(res.eventIds.length).toBeGreaterThan(1000)
    const events = await eventsOf(t, res.runId)
    expect(events.map((e: any) => e.sequenceNumber)).toEqual(events.map((_: any, i: number) => i + 1))
  })

  it('an empty batch and a malformed traceId are refused before anything is read', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const empty = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [] as any,
      }),
    )
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('INVALID_ARGUMENT')

    for (const bad of ['', 'nope', TRACE_A.toUpperCase(), TRACE_A + 'aa', TRACE_A.slice(0, 31)]) {
      const res = await outcome(() =>
        t.mutation(api.otel_ingest.otelIngestSpans, {
          apiKeyHash: KEY_A, traceId: bad, agentId: agentA, spans: completeTrace(BASE) as any,
        }),
      )
      expect(res.ok, `traceId ${JSON.stringify(bad)} must be refused`).toBe(false)
      expect(res.error).toContain('INVALID_ARGUMENT')
    }
    expect(await allRuns(t)).toEqual([])
  })

  it('excludes an oversized span PER SPAN instead of losing the whole batch', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    // Opt-In content capture with a huge prompt. Event Log Rule 3 says it must
    // be externalized; this path has no blob access, so it cannot store it.
    // What it must NOT do is take the innocent spans down with it — OTLP has
    // partial success for exactly this case.
    const huge = 'x'.repeat(40_000)
    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      spans: [
        makeSpan(1, BASE, { start: 0, end: 500, name: 'invoke_agent x',
          attributes: { 'gen_ai.operation.name': 'invoke_agent' } }),
        makeSpan(2, BASE, {
          parent: 1, start: 10, end: 20,
          attributes: { ...CHAT_ATTRS, 'gen_ai.input.messages': [{ role: 'user', content: huge }] },
        }),
        makeSpan(3, BASE, { parent: 1, start: 30, end: 40,
          name: 'execute_tool search_web', attributes: TOOL_ATTRS }),
      ] as any,
    })

    // The offender is named, with a reason a caller can act on.
    expect(res.rejected).toContainEqual({ spanId: spanId(2), reason: 'payload-too-large' })
    // The innocent spans landed.
    const events = await eventsOf(t, res.runId)
    const seen = new Set(events.map((e: any) => e.provenance.spanId))
    expect(seen).toContain(spanId(1))
    expect(seen).toContain(spanId(3))
    expect(seen).not.toContain(spanId(2))
    // CONTIGUITY survives the exclusion — re-mapping, not event deletion.
    expect(events.map((e: any) => e.sequenceNumber)).toEqual(events.map((_: any, i: number) => i + 1))
    for (const e of events) {
      expect(new TextEncoder().encode(JSON.stringify(e.payload)).length).toBeLessThanOrEqual(10 * 1024)
    }
  })

  it('rejects a malformed span id PER SPAN, not by refusing the batch', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      spans: [
        makeSpan(1, BASE, { start: 0, end: 500, name: 'invoke_agent x',
          attributes: { 'gen_ai.operation.name': 'invoke_agent' } }),
        { traceId: TRACE_A, spanId: '', name: 'blank id', startTimeUnixNano: nanos(5, BASE) },
        { traceId: TRACE_A, spanId: 'NOT-HEX-AT-ALL!!', name: 'bad id', startTimeUnixNano: nanos(6, BASE) },
        makeSpan(3, BASE, { parent: 1, start: 30, end: 40,
          name: 'execute_tool search_web', attributes: TOOL_ATTRS }),
      ] as any,
    })

    expect(res.rejected).toContainEqual({ spanId: '', reason: 'malformed-id' })
    expect(res.rejected).toContainEqual({ spanId: 'NOT-HEX-AT-ALL!!', reason: 'malformed-id' })
    const events = await eventsOf(t, res.runId)
    const seen = new Set(events.map((e: any) => e.provenance.spanId))
    expect(seen).toContain(spanId(1))
    expect(seen).toContain(spanId(3))
    for (const e of events) expect(e.provenance.spanId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('a trace older than the stale-run ceiling is refused at the door, not accepted into a doomed run', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    const ancient = Date.now() - 48 * 60 * 60 * 1000

    const res = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: completeTrace(ancient) as any,
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('OTEL_TRACE_TOO_OLD')
    expect(await allRuns(t)).toEqual([])
  })

  it('enforces the per-key rate limit in SPANS and commits nothing when it trips', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seed(t)
    await t.run(async (ctx: any) => {
      await ctx.db.insert('api_keys', {
        orgId: orgA, keyHash: 'slow', name: 'slow', createdBy: 'u', createdAt: Date.now(),
        scopes: ['ingest:write'], rateLimitPerMin: 2,
      })
    })

    const res = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: 'slow', traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE) as any,
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('RATE_LIMITED')
    expect(await allRuns(t)).toEqual([])
  })
})

// ===========================================================================
describe('HOSTILITY — malformed and adversarial batches', () => {
  it('refuses the batch only when NO span in it is usable', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A,
        traceId: TRACE_A,
        agentId: agentA,
        spans: [
          {
            traceId: TRACE_A,
            spanId: 'NOT-HEX-AT-ALL!!',
            name: 'invoke_agent x',
            startTimeUnixNano: nanos(0, BASE),
            attributes: { 'gen_ai.operation.name': 'invoke_agent' },
          },
        ] as any,
      }),
    )

    expect(res.ok).toBe(false)
    expect(res.error).toContain('INVALID_ARGUMENT')
    // No empty run materialized for a batch that had nothing to record.
    expect(await allRuns(t)).toEqual([])
    expect(await t.run(async (ctx: any) => await ctx.db.query('events').collect())).toEqual([])
  })

  it('survives a parent cycle, a self-parent, orphans, and a negative duration without half-writing', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const spans = [
      // Genuine root, so the run has a boundary.
      makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
        attributes: { 'gen_ai.operation.name': 'invoke_agent' } }),
      // A -> B -> C -> A cycle.
      { ...makeSpan(2, BASE, { parent: 4, start: 10, end: 20, attributes: CHAT_ATTRS }) },
      { ...makeSpan(3, BASE, { parent: 2, start: 11, end: 21, attributes: CHAT_ATTRS }) },
      { ...makeSpan(4, BASE, { parent: 3, start: 12, end: 22, attributes: CHAT_ATTRS }) },
      // Self-parent.
      { ...makeSpan(5, BASE, { start: 30, end: 40, attributes: CHAT_ATTRS }), parentSpanId: spanId(5) },
      // Orphan: parent named but absent from the batch.
      makeSpan(6, BASE, { parent: 999, start: 50, end: 60, attributes: CHAT_ATTRS }),
      // Close precedes open.
      makeSpan(7, BASE, { start: 100, end: 50, attributes: CHAT_ATTRS }),
    ]

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
    })

    const codes = res.diagnostics.map((d: any) => d.code)
    expect(codes).toContain('parent-cycle')
    expect(codes).toContain('self-parent')
    expect(codes).toContain('orphan-span')
    expect(res.diagnostics.every((d: any) => d.fatal === false)).toBe(true)

    const events = await eventsOf(t, res.runId)
    // CONTIGUITY survives all of it.
    expect(events.map((e: any) => e.sequenceNumber)).toEqual(events.map((_: any, i: number) => i + 1))
    // CAUSALITY: every parent edge points at an EARLIER event in the same run.
    const bySeq = new Map(events.map((e: any) => [e._id, e.sequenceNumber]))
    for (const e of events) {
      if (e.parentEventId !== undefined) {
        expect(bySeq.get(e.parentEventId)).toBeLessThan(e.sequenceNumber)
      }
    }
    // COMPLETENESS: every accepted span produced at least one event.
    const covered = new Set(events.map((e: any) => e.provenance.spanId))
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(covered).toContain(spanId(n))
    // MONOTONICITY: the skew clamp makes timestamps non-decreasing along the
    // sequence, which the replay projection's elapsed_ms depends on.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp)
    }
  })

  it('records an unrecognized operation as otel.span.unmapped rather than dropping it', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      spans: [
        makeSpan(1, BASE, { start: 0, end: 100, name: 'invoke_agent x',
          attributes: { 'gen_ai.operation.name': 'invoke_agent' } }),
        makeSpan(2, BASE, { parent: 1, start: 10, end: 20, name: 'GET /v1/things',
          attributes: { 'http.request.method': 'GET', 'url.full': 'https://x/y' } }),
      ] as any,
    })

    expect(res.unmappedCount).toBeGreaterThan(0)
    const events = await eventsOf(t, res.runId)
    const unmapped = events.filter((e: any) => e.type === 'otel.span.unmapped')
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0].provenance.spanId).toBe(spanId(2))
    // It carries the span's own attributes, so the engineer can still see what
    // happened rather than a hole in the timeline.
    expect(unmapped[0].payload.attributes['http.request.method']).toBe('GET')
    expect(unmapped[0].payload.spanName).toBe('GET /v1/things')
  })

  it('handles a hostile __proto__ attribute key at all three layers it can be lost', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      spans: [
        makeSpan(1, BASE, { start: 0, end: 100, name: 'invoke_agent x',
          attributes: { 'gen_ai.operation.name': 'invoke_agent' } }),
        makeSpan(2, BASE, {
          parent: 1, start: 10, end: 20, name: 'mystery.operation',
          // JSON.parse, not an object literal — this is the REAL vector. An
          // object literal's `__proto__:` is the prototype SETTER and never
          // creates an own property, so a literal-based fixture would test
          // nothing. `JSON.parse` creates a genuine own `__proto__` key, which
          // is what an OTLP/JSON body carrying that attribute name produces.
          attributes: JSON.parse(
            '{"__proto__": {"polluted": true}, "constructor": "c", "safe": "ok"}',
          ) as Record<string, unknown>,
        }),
      ] as any,
    })

    const events = await eventsOf(t, res.runId)
    const unmapped = events.find((e: any) => e.type === 'otel.span.unmapped')
    expect(unmapped).toBeDefined()
    // Benign keys survive, including ones that merely LOOK dangerous.
    expect(unmapped.payload.attributes.safe).toBe('ok')
    expect(unmapped.payload.attributes.constructor).toBe('c')
    // Nothing anywhere was polluted.
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(unmapped.payload.attributes)).toBe(Object.prototype)

    // WHERE THE KEY ACTUALLY WENT, and why this test asserts absence rather
    // than survival. Probing each layer in isolation found THREE independent
    // places an own `__proto__` key is lost, two of which are silent:
    //
    //   1. THE MAPPER — `out[key] = value` invoked Object.prototype's
    //      `__proto__` SETTER, creating no own property and handing a
    //      caller-controlled prototype to every downstream reader. FIXED here
    //      (`setAttribute` + `storageSafeKey` in otel_mapping.ts); verified by
    //      calling the mapper directly, where the key now survives as
    //      `otel.attr.__proto__`.
    //   2. CONVEX DOCUMENT STORAGE — `ctx.db.insert` accepts a document with an
    //      own `__proto__` key and it is simply absent on read-back, with no
    //      error. The rename in (1) also defuses this.
    //   3. THE CONVEX ARGUMENT CODEC — and this one we cannot fix from
    //      `convex/` at all. The key is stripped from a `v.any()` argument
    //      BEFORE the handler runs, so by the time this mutation executes the
    //      attribute never existed. Verified with a minimal probe mutation.
    //
    // So the honest assertion is that the attribute is GONE, and the fix for
    // layer 3 belongs to the OTLP decoder in the transport layer, which must
    // escape the key before calling this mutation. Asserting survival here
    // would be asserting something this boundary cannot deliver.
    expect(unmapped.payload.attributes['otel.attr.__proto__']).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(unmapped.payload.attributes, '__proto__')).toBe(false)
  })

  it('handles non-numeric and zero timestamps without failing the batch', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      spans: [
        makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
          attributes: { 'gen_ai.operation.name': 'invoke_agent' } }),
        // endTimeUnixNano "0" means UNSET on the wire, NOT an instant at the
        // epoch. Read as an instant it would sort the tool's result before the
        // run began.
        { ...makeSpan(2, BASE, { parent: 1, start: 10, attributes: CHAT_ATTRS }), endTimeUnixNano: '0' },
        // Garbage that must not throw.
        { ...makeSpan(3, BASE, { parent: 1, start: 20, end: 30, attributes: CHAT_ATTRS }),
          startTimeUnixNano: 'not-a-number' },
      ] as any,
    })

    const events = await eventsOf(t, res.runId)
    expect(events.length).toBeGreaterThan(0)
    expect(events.map((e: any) => e.sequenceNumber)).toEqual(events.map((_: any, i: number) => i + 1))
    for (const e of events) {
      expect(Number.isFinite(e.timestamp)).toBe(true)
    }
    // The unclosed span produced its open event and NO close.
    const s2 = events.filter((e: any) => e.provenance.spanId === spanId(2))
    expect(s2.map((e: any) => e.type)).toEqual(['llm.request'])
  })

  it('a non-object attributes bag is ignored rather than silently mapping to nothing', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      spans: [
        makeSpan(1, BASE, { start: 0, end: 50, name: 'invoke_agent x',
          attributes: { 'gen_ai.operation.name': 'invoke_agent' } }),
        // A span whose name matches no convention AND whose attribute bag is a
        // scalar. The mapper indexes attributes by key, so a non-object bag
        // would make every read return undefined — the span would map to
        // "nothing recognized" for the wrong reason and look identical to a
        // genuinely unrecognized span. It is stripped at the boundary so the
        // outcome is the honest one.
        { ...makeSpan(2, BASE, { parent: 1, start: 10, end: 20, name: 'mystery.operation' }),
          attributes: 'sentinel' },
      ] as any,
    })

    const events = await eventsOf(t, res.runId)
    // Recorded honestly as unmapped — never dropped.
    const unmapped = events.filter((e: any) => e.type === 'otel.span.unmapped')
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0].provenance.spanId).toBe(spanId(2))
    expect(unmapped[0].payload.attributes).toEqual({})
  })
})

// ===========================================================================
describe('Event Log Rules on the derived path', () => {
  it('run.started is first and the terminal event is last; the run status agrees with the log', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const failing = completeTrace(BASE)
    ;(failing[0] as any).status = { code: 2, message: 'agent gave up' }

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: failing as any,
    })

    // The batch itself emits no terminal; it records the failed root.
    expect(res.terminalType).toBeNull()
    const runsBefore = await allRuns(t)
    expect(runsBefore[0].otelRoot?.status).toBe('error')

    await t.run(async (ctx: any) => {
      await ctx.db.patch(res.runId, { otelLastAppendAt: Date.now() - 10 * 60 * 1000 })
    })
    const settled = await t.mutation(internal.otel_settle.settleOtelTrace, { runId: res.runId })
    expect(settled.reason).toBe('run.failed')

    const events = await eventsOf(t, res.runId)
    expect(events[0].type).toBe('run.started')
    expect(events[events.length - 1].type).toBe('run.failed')
    // The synthesized terminal declares itself synthesized. No span reported it.
    expect(events[events.length - 1].provenance.lossy).toBe(true)
    expect(events[events.length - 1].provenance.lossReasons).toContain('identity-synthesized')
    expect(events[events.length - 1].temporalOrder.depth).toBe(-1)
    expect(events[events.length - 1].temporalOrder.phase).toBe('close')
    // It never sorts before the events it terminates.
    for (const e of events) {
      expect(events[events.length - 1].timestamp).toBeGreaterThanOrEqual(e.timestamp)
    }

    const runs = await allRuns(t)
    expect(runs[0].status).toBe('failed')
    expect(runs[0].endedAt).toBe(events[events.length - 1].timestamp)
    // ADR-002: the failure message is searchable.
    expect(runs[0].searchText).toContain('status ERROR')
  })

  it('a trace whose root never closes stays in-progress and emits no terminal event', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A,
      traceId: TRACE_A,
      agentId: agentA,
      spans: [
        makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
          attributes: { 'gen_ai.operation.name': 'invoke_agent' } }),
        makeSpan(2, BASE, { parent: 1, start: 10, end: 20, attributes: CHAT_ATTRS }),
      ] as any,
    })

    expect(res.runOpen).toBe(true)
    expect(res.terminalType).toBeNull()
    const runs = await allRuns(t)
    expect(runs[0].status).toBe('running')
    expect(runs[0].endedAt).toBeUndefined()
    const events = await eventsOf(t, res.runId)
    expect(events.some((e: any) => e.type === 'run.completed' || e.type === 'run.failed')).toBe(false)
  })

  it('a continuation batch does NOT re-emit run.started', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    const root = makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } })

    const a = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [root] as any,
    })
    await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
      spans: [root, makeSpan(2, BASE, { parent: 1, start: 10, end: 20, attributes: CHAT_ATTRS })] as any,
    })

    const events = await eventsOf(t, a.runId)
    expect(events.filter((e: any) => e.type === 'run.started')).toHaveLength(1)
    expect(events[0].sequenceNumber).toBe(1)
  })

  it('every derived row is readable back through the by_run_span index', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: completeTrace(BASE) as any,
    })

    // The dedupe index is the whole idempotency guarantee; if a row is not
    // findable through it, the next redelivery duplicates that span.
    await t.run(async (ctx: any) => {
      for (const n of [1, 2, 3]) {
        const hit = await ctx.db
          .query('events')
          .withIndex('by_run_span', (q: any) =>
            q.eq('runId', res.runId).eq('provenance.spanId', spanId(n)),
          )
          .first()
        expect(hit, `span ${spanId(n)} must be findable`).not.toBeNull()
      }
    })
  })
})

// ===========================================================================
describe('CONVERGENCE — the same trace, partitioned and permuted (D5/D6/D7)', () => {
  /**
   * THE PROPERTY: the set of events a trace produces must not depend on how the
   * exporter's batch processor happened to flush it.
   *
   * This is what a per-batch terminality rule broke. Root A(0..100) with child
   * B(10..20): `{A}` then `{B}` used to emit run.started AND run.completed on
   * batch 1 (a closed root, in a fully-closed batch), after which B was refused
   * with RUN_NOT_ACTIVE and LOST PERMANENTLY — while `{A,B}` kept both. Not a
   * sequence-numbering difference: a different set of events, one of which is
   * missing a real LLM call, decided by exporter timing.
   *
   * Compared as a MULTISET of (type, spanId). Sequence ORDER is deliberately
   * not compared — it is arrival order by design, and the temporal truth rides
   * in `temporalOrder` (asserted separately).
   */
  const ROOT = (base: number) =>
    makeSpan(1, base, { start: 0, end: 100, name: 'invoke_agent researcher',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } })
  const CHILD = (base: number) =>
    makeSpan(2, base, { parent: 1, start: 10, end: 20, attributes: CHAT_ATTRS })

  async function ingestAll(batches: Record<string, unknown>[][]) {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    let runId = ''
    for (const spans of batches) {
      const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
      })
      runId = res.runId
    }
    // Settle as the scheduler would, once the trace has gone quiet.
    await t.run(async (ctx: any) => {
      await ctx.db.patch(runId, { otelLastAppendAt: Date.now() - 10 * 60 * 1000 })
    })
    await t.mutation(internal.otel_settle.settleOtelTrace, { runId })
    const events = await eventsOf(t, runId)
    return {
      t,
      runId,
      events,
      fingerprint: events.map((e: any) => `${e.type}@${e.provenance.spanId}`).sort(),
      seqs: events.map((e: any) => e.sequenceNumber),
    }
  }

  it('produces the SAME event multiset under every partition and permutation', async () => {
    const together = await ingestAll([[ROOT(BASE), CHILD(BASE)]])
    const rootFirst = await ingestAll([[ROOT(BASE)], [CHILD(BASE)]])
    const childFirst = await ingestAll([[CHILD(BASE)], [ROOT(BASE)]])
    const overlapping = await ingestAll([
      [ROOT(BASE)],
      [ROOT(BASE), CHILD(BASE)],
      [CHILD(BASE)],
    ])

    // The SPAN-DERIVED events converge exactly — every real operation appears
    // under every partition, with the same type and the same source span.
    const spanDerived = (r: any) => r.fingerprint.filter((f: string) => !f.startsWith('run.started@'))
    expect(spanDerived(rootFirst)).toEqual(spanDerived(together))
    expect(spanDerived(childFirst)).toEqual(spanDerived(together))
    expect(spanDerived(overlapping)).toEqual(spanDerived(together))

    // THE ONE RESIDUAL DIVERGENCE, asserted rather than hidden: the SYNTHESIZED
    // `run.started` is anchored to the earliest span in the FIRST batch, so
    // when the child arrives before the root it is anchored on the child.
    //
    // This is not a bug that was missed — it is unfixable, and the mapper's
    // FINDINGS F1 proves why: over an append-only log, DETERMINISM (the same
    // span set yields the same output under any arrival order) and STABILITY
    // (a later span must not renumber what is already written) are jointly
    // unsatisfiable by any function of the span set. "Which batch came first"
    // IS the insertion history. What we can do is make the weakness legible on
    // the row, and that is asserted here: an anchor that is not a true root
    // declares `identity-synthesized`.
    for (const run of [together, rootFirst, childFirst, overlapping]) {
      expect(run.events.filter((e: any) => e.type === 'run.started')).toHaveLength(1)
    }
    expect(together.events[0].provenance.spanId).toBe(spanId(1))
    expect(rootFirst.events[0].provenance.spanId).toBe(spanId(1))
    const childAnchored = childFirst.events[0]
    expect(childAnchored.type).toBe('run.started')
    expect(childAnchored.provenance.spanId).toBe(spanId(2))
    expect(childAnchored.provenance.lossReasons).toContain('identity-synthesized')

    // And no span was lost in any partition — the failure that made this fatal.
    for (const run of [together, rootFirst, childFirst, overlapping]) {
      const seen = new Set(run.events.map((e: any) => e.provenance.spanId))
      expect(seen).toContain(spanId(1))
      expect(seen).toContain(spanId(2))
      expect(run.seqs).toEqual(run.seqs.map((_: number, i: number) => i + 1))
      expect(run.events.filter((e: any) => e.type === 'run.started')).toHaveLength(1)
      expect(run.events.filter((e: any) => e.type === 'run.completed')).toHaveLength(1)
      expect(run.events[run.events.length - 1].type).toBe('run.completed')
    }
  })

  it('never emits a terminal from an ingest batch, however complete the batch looks', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    // A batch that is complete by every per-batch test: a closed true root and
    // every span closed. Under the old rule this closed the run on the spot.
    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
      spans: [ROOT(BASE), CHILD(BASE)] as any,
    })
    expect(res.terminalType).toBeNull()
    expect(res.runOpen).toBe(true)
    const events = await eventsOf(t, res.runId)
    expect(events.some((e: any) => e.type.startsWith('run.') && e.type !== 'run.started')).toBe(false)
  })

  it('the settle waits while spans are still arriving, and closes exactly once (D7)', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [ROOT(BASE)] as any,
    })

    // Trace is NOT quiet — settle must decline and reschedule, not close.
    const early = await t.mutation(internal.otel_settle.settleOtelTrace, { runId: res.runId })
    expect(early.settled).toBe(false)
    expect(early.reason).toBe('still-arriving')
    expect((await allRuns(t))[0].status).toBe('running')

    // More spans arrive, as they legitimately may.
    await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [CHILD(BASE)] as any,
    })

    await t.run(async (ctx: any) => {
      await ctx.db.patch(res.runId, { otelLastAppendAt: Date.now() - 10 * 60 * 1000 })
    })
    const first = await t.mutation(internal.otel_settle.settleOtelTrace, { runId: res.runId })
    expect(first.settled).toBe(true)

    // The scheduler is at-least-once, so a second delivery must be a no-op —
    // a second run.completed would be permanent corruption.
    const second = await t.mutation(internal.otel_settle.settleOtelTrace, { runId: res.runId })
    expect(second.settled).toBe(false)
    expect(second.reason).toBe('already-closed')
    const events = await eventsOf(t, res.runId)
    expect(events.filter((e: any) => e.type === 'run.completed')).toHaveLength(1)
  })

  it('a root that never closes is never settled and stays honestly in-progress', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const openRoot = makeSpan(1, BASE, { start: 0, name: 'invoke_agent x',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } })
    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
      spans: [openRoot, CHILD(BASE)] as any,
    })

    expect((await allRuns(t))[0].otelRoot).toBeUndefined()
    await t.run(async (ctx: any) => {
      await ctx.db.patch(res.runId, { otelLastAppendAt: Date.now() - 10 * 60 * 1000 })
    })
    const settled = await t.mutation(internal.otel_settle.settleOtelTrace, { runId: res.runId })
    // The outcome is genuinely unknown. Inventing a terminal would assert one.
    expect(settled.settled).toBe(false)
    expect(settled.reason).toBe('no-closed-root')
    expect((await allRuns(t))[0].status).toBe('running')
  })

  it('an ORPHAN root is not mistaken for a run boundary', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    // Parent named but absent: the parent probably exists and simply has not
    // arrived, so this is a tree root but never a run boundary.
    const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
      spans: [makeSpan(2, BASE, { parent: 99, start: 10, end: 20, attributes: CHAT_ATTRS })] as any,
    })
    expect((await allRuns(t))[0].otelRoot).toBeUndefined()
    expect(res.diagnostics.map((d: any) => d.code)).toContain('orphan-span')
  })

  it('accounting balances, and a colliding span id is not reported as a harmless duplicate (D2/D8)', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    const chat = makeSpan(2, BASE, { parent: 1, start: 10, end: 20, attributes: CHAT_ATTRS })
    const three = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
      spans: [ROOT(BASE), chat, { ...chat }, { ...chat }] as any,
    })
    // D2: three copies means TWO discarded, and the stats must add up.
    expect(three.rejected.filter((r: any) => r.reason === 'duplicate')).toHaveLength(2)
    expect(three.stats.spansIn).toBe(three.stats.spansAccepted + three.stats.spansRejected)

    // D8: a DIFFERENT operation wearing the same id is a real loss, and must
    // not be filed under a reason that says nothing was lost.
    const t2 = convexTest(schema, modules)
    const { agentA: agent2 } = await seed(t2)
    const collider = { ...chat, name: 'execute_tool search_web', attributes: TOOL_ATTRS }
    const res = await t2.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agent2,
      spans: [ROOT(BASE), chat, collider] as any,
    })
    expect(res.rejected).toContainEqual({ spanId: spanId(2), reason: 'span-id-collision' })
    expect(res.rejected.some((r: any) => r.reason === 'duplicate')).toBe(false)
    expect(res.diagnostics.map((d: any) => d.code)).toContain('span-id-collision')
  })

  it('a deeply nested attribute on a duplicated span id does not blow the stack in the MAPPER (D4)', () => {
    // 60k-deep nesting is legal on the wire and entirely caller-controlled.
    //
    // The dedupe tiebreak used to settle ties with `JSON.stringify(attributes)`,
    // which recurses in the engine and throws `RangeError: Maximum call stack
    // size exceeded`. The tell was that a SINGLE copy mapped fine and a
    // DUPLICATED id threw — only the duplicate path reaches the tiebreak.
    // Asserted against the mapper directly, because that is the component that
    // was broken and the component that was fixed.
    let deep: any = {}
    let cursor = deep
    for (let i = 0; i < 60_000; i += 1) { cursor.n = {}; cursor = cursor.n }

    const root = { traceId: TRACE_A, spanId: spanId(1), name: 'invoke_agent x',
      startTimeUnixNano: nanos(0, BASE), endTimeUnixNano: nanos(100, BASE),
      attributes: { 'gen_ai.operation.name': 'invoke_agent' } }
    const nested = { traceId: TRACE_A, spanId: spanId(2), parentSpanId: spanId(1),
      name: 'mystery.operation', startTimeUnixNano: nanos(10, BASE),
      endTimeUnixNano: nanos(20, BASE), attributes: { deep } }

    for (const spans of [[root, nested], [root, nested, { ...nested }]]) {
      const result = mapTraceToEvents({ spans: spans as any, receivedAt: Date.now(),
        terminalPolicy: 'defer' })
      expect(result.ok).toBe(true)
      // And the bounded bag keeps every derived payload storable, which is the
      // other half: an unbounded attribute bag produced a ~256 KB payload
      // against a 10 KB inline limit.
      for (const e of result.events) {
        expect(new TextEncoder().encode(JSON.stringify(e.payload)).length)
          .toBeLessThanOrEqual(10 * 1024)
      }
    }
  })

  it('a batch Convex itself cannot decode commits nothing (boundary note)', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)

    let deep: any = {}
    let cursor = deep
    for (let i = 0; i < 60_000; i += 1) { cursor.n = {}; cursor = cursor.n }

    const res = await outcome(() =>
      t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA,
        spans: [makeSpan(2, BASE, { start: 10, end: 20, attributes: { deep } })] as any,
      }),
    )

    // THE CALL FAILS, AND THE FAILURE IS NOT OURS TO CATCH. Convex's ARGUMENT
    // CODEC recurses over a `v.any()` argument and throws before the handler is
    // entered — verified with a minimal probe mutation whose body never runs.
    // No code in `convex/` executes, so no depth guard here can intercept it.
    // The OTLP decoder in the transport layer must bound nesting depth before
    // calling, and it is well placed to: it already parses the body, so it can
    // reject the offending span with an OTLP partial-success rather than a 500.
    //
    // What IS guaranteed from this side, and is what this test pins: the
    // failure is atomic. No run, no event, no partial write.
    expect(res.ok).toBe(false)
    expect(await allRuns(t)).toEqual([])
    expect(await t.run(async (ctx: any) => await ctx.db.query('events').collect())).toEqual([])
  })
})

// ===========================================================================
describe('CONVERGENCE SWEEP — every permutation x every ordered partition', () => {
  /**
   * The single-shape convergence test above is necessary but not sufficient: a
   * fix that only holds for root-plus-children would pass it. This sweeps SEVEN
   * trace shapes chosen for the distinct ways a trace can be awkward, and for
   * each one runs EVERY permutation of its spans crossed with EVERY ordered
   * partition of that permutation into batches — i.e. every way an exporter
   * could conceivably deliver it.
   *
   * `twoRoots` is the shape that caught a real second defect after the first
   * fix landed: with an OK root and an ERROR root, the run settled to
   * `run.completed` or `run.failed` depending on which batch arrived first,
   * because the recorded root was "first true root in the batch's array order".
   * The RUN'S OUTCOME, decided by exporter flush timing. Root selection is now
   * `min(effective start, spanId)` over the whole trace, with a strictly-better
   * root arriving later REPLACING the recorded one.
   */
  const AGENT = { 'gen_ai.operation.name': 'invoke_agent' }
  const span = (n: number, o: any = {}) => ({
    traceId: TRACE_A,
    spanId: spanId(n),
    name: o.name ?? 'chat gpt-4o',
    startTimeUnixNano: nanos(o.start ?? 0, BASE),
    ...(o.end !== undefined ? { endTimeUnixNano: nanos(o.end, BASE) } : {}),
    ...(o.parent !== undefined ? { parentSpanId: spanId(o.parent) } : {}),
    ...(o.status ? { status: o.status } : {}),
    attributes: o.attrs ?? CHAT_ATTRS,
  })

  const SHAPES: Record<string, any[]> = {
    'root + two children': [
      span(1, { name: 'invoke_agent r', start: 0, end: 100, attrs: AGENT }),
      span(2, { parent: 1, start: 10, end: 20 }),
      span(3, { parent: 1, start: 30, end: 40 }),
    ],
    'deep chain': [
      span(1, { name: 'invoke_agent r', start: 0, end: 100, attrs: AGENT }),
      span(2, { parent: 1, start: 10, end: 90 }),
      span(3, { parent: 2, start: 20, end: 80 }),
    ],
    // No true root at all: every parent names a span that never arrives.
    'all orphans': [span(2, { parent: 90, start: 10, end: 20 }), span(3, { parent: 91, start: 30, end: 40 })],
    // The outcome-flipping shape. Earliest root is OK, the other is ERROR.
    'two true roots (earliest ok)': [
      span(1, { name: 'invoke_agent a', start: 0, end: 100, attrs: AGENT }),
      span(2, { name: 'invoke_agent b', start: 5, end: 90, attrs: AGENT, status: { code: 2, message: 'x' } }),
    ],
    // ...and the mirror, where the earliest root is the failing one.
    'two true roots (earliest failed)': [
      span(1, { name: 'invoke_agent a', start: 5, end: 100, attrs: AGENT }),
      span(2, { name: 'invoke_agent b', start: 0, end: 90, attrs: AGENT, status: { code: 2, message: 'x' } }),
    ],
    // Child claims to start before its parent — unsynchronized clocks.
    'clock skew': [
      span(1, { name: 'invoke_agent r', start: 50, end: 100, attrs: AGENT }),
      span(2, { parent: 1, start: 0, end: 20 }),
    ],
    'unclosed child': [
      span(1, { name: 'invoke_agent r', start: 0, end: 100, attrs: AGENT }),
      span(2, { parent: 1, start: 10 }),
    ],
  }

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items]
    const out: T[][] = []
    items.forEach((item, i) => {
      for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest])
    })
    return out
  }
  function partitions<T>(items: T[]): T[][][] {
    if (items.length === 0) return [[]]
    const out: T[][][] = []
    for (let i = 1; i <= items.length; i += 1) {
      for (const rest of partitions(items.slice(i))) out.push([items.slice(0, i), ...rest])
    }
    return out
  }

  async function deliver(batches: any[][]) {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    let runId = ''
    for (const spans of batches) {
      const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
      })
      runId = res.runId
    }
    await t.run(async (ctx: any) => {
      await ctx.db.patch(runId, { otelLastAppendAt: Date.now() - 10 * 60 * 1000 })
    })
    await t.mutation(internal.otel_settle.settleOtelTrace, { runId })
    return await eventsOf(t, runId)
  }

  it('every shape, every permutation, every partition yields the same events', async () => {
    let deliveries = 0
    for (const [shapeName, spans] of Object.entries(SHAPES)) {
      const outcomes = new Map<string, string>()
      for (const perm of permutations(spans)) {
        for (const part of partitions(perm)) {
          const events = await deliver(part)
          deliveries += 1
          const label = part.map((b) => b.map((sp: any) => sp.spanId.slice(-2)).join('')).join('|')

          // Compared WITHOUT the synthesized run.started, whose anchor depends
          // on which spans arrived first and provably cannot be made stable —
          // see the mapper's FINDINGS F1. Everything else must be identical.
          const fingerprint = events
            .map((e: any) => `${e.type}@${e.provenance.spanId}`)
            .filter((f: string) => !f.startsWith('run.started@'))
            .sort()
            .join(',')
          const seen = outcomes.get(fingerprint)
          if (seen === undefined) outcomes.set(fingerprint, label)

          // Sequence numbers stay contiguous under every delivery order.
          expect(events.map((e: any) => e.sequenceNumber))
            .toEqual(events.map((_: any, i: number) => i + 1))
          // Exactly one run.started, always first, always keyed.
          const started = events.filter((e: any) => e.type === 'run.started')
          expect(started).toHaveLength(1)
          expect(events[0].type).toBe('run.started')
          for (const e of events) expect(e.temporalOrder).toBeDefined()
        }
      }
      expect(
        [...outcomes.entries()].map(([, label]) => label),
        `shape "${shapeName}" diverged across delivery orders`,
      ).toHaveLength(1)
    }
    // Anti-vacuity: the sweep really ran.
    expect(deliveries).toBeGreaterThan(60)
  }, 600_000)

  it("a trace with two true roots settles on the EARLIEST root's outcome, whichever arrives first", async () => {
    const ok = span(1, { name: 'invoke_agent a', start: 0, end: 100, attrs: AGENT })
    const failed = span(2, { name: 'invoke_agent b', start: 5, end: 90, attrs: AGENT,
      status: { code: 2, message: 'boom' } })

    for (const batches of [[[ok], [failed]], [[failed], [ok]], [[ok, failed]]]) {
      const events = await deliver(batches)
      const terminal = events[events.length - 1]
      // The EARLIEST root is the OK one, so the run completed — under every
      // delivery order, including the one where the failing root landed first.
      expect(terminal.type).toBe('run.completed')
      expect(terminal.provenance.spanId).toBe(spanId(1))
    }
  }, 120_000)
})

// ===========================================================================
describe('R1/R2/R3 — the residue is exactly one event, and it is labelled', () => {
  const AGENT = { 'gen_ai.operation.name': 'invoke_agent' }
  const sp = (n: number, o: any = {}) => ({
    traceId: TRACE_A,
    spanId: spanId(n),
    name: o.name ?? 'chat gpt-4o',
    startTimeUnixNano: nanos(o.start ?? 0, BASE),
    ...(o.end !== undefined ? { endTimeUnixNano: nanos(o.end, BASE) } : {}),
    ...(o.parent !== undefined ? { parentSpanId: spanId(o.parent) } : {}),
    attributes: o.attrs ?? CHAT_ATTRS,
  })

  async function deliverAndSettle(batches: any[][]) {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    let runId = ''
    for (const spans of batches) {
      const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
      })
      runId = res.runId
    }
    await t.run(async (ctx: any) => {
      await ctx.db.patch(runId, { otelLastAppendAt: Date.now() - 10 * 60 * 1000 })
    })
    await t.mutation(internal.otel_settle.settleOtelTrace, { runId })
    return await eventsOf(t, runId)
  }

  /**
   * R1. Event Log Rule 5 under the temporal ordering this path introduces:
   * "last" means last by INSTANT, not last by sequence number.
   *
   * The terminal's instant used to be `max(rootEnd, lastAppended.instant)`, and
   * `lastAppended` is the highest sequence number — a fact about arrival order,
   * not about the trace. Two true roots r(0-10ms) and s(20-30ms) delivered as
   * {s} then {r} put the last-appended event at 10ms, so the terminal landed at
   * 10ms while the log already held an event at 30ms. The terminal sorted
   * BEFORE the events it terminates and replay rendered a negative elapsed
   * span — the exact defect the `max` existed to prevent, defeated by maxing
   * against the wrong event.
   */
  it('the settle terminal sorts after EVERY event, under every delivery order', async () => {
    const r = sp(1, { name: 'invoke_agent r', start: 0, end: 10, attrs: AGENT })
    const s = sp(2, { name: 'invoke_agent s', start: 20, end: 30, attrs: AGENT })

    const instants: string[] = []
    for (const batches of [[[r, s]], [[s], [r]], [[r], [s]]]) {
      const events = await deliverAndSettle(batches)
      const terminal = events[events.length - 1]
      expect(terminal.type).toBe('run.completed')

      const maxOther = events
        .slice(0, -1)
        .reduce((m: bigint, e: any) => {
          const v = BigInt(e.temporalOrder.instantUnixNano)
          return v > m ? v : m
        }, BigInt(0))
      expect(
        BigInt(terminal.temporalOrder.instantUnixNano) >= maxOther,
        'terminal must not sort before an event it terminates',
      ).toBe(true)
      // Timestamps are non-decreasing along the sequence, so replay's
      // elapsed_ms can never go negative.
      for (const e of events) expect(terminal.timestamp).toBeGreaterThanOrEqual(e.timestamp)
      instants.push(terminal.temporalOrder.instantUnixNano)
    }
    // ...and the instant itself is partition-independent.
    expect(new Set(instants).size).toBe(1)
  }, 120_000)

  /**
   * R2. The causality clamp was batch-local, so a MAPPED operation — not the
   * synthesized boundary — had its timeline position decided by flush timing,
   * and only one of the two arms admitted anything was inferred.
   *
   * Parent anchors close the parent-first order outright. The child-first order
   * is not closable (the parent is unknowable when the child is written, and
   * there is no update mutation), so it is MARKED instead: an unmarked
   * inferred timestamp is the lie the marker exists to prevent.
   */
  it('clamps an out-of-batch parent when it is known, and marks the arm where it cannot', async () => {
    const parent = sp(1, { name: 'invoke_agent r', start: 50, end: 100, attrs: AGENT })
    const child = sp(2, { parent: 1, start: 10, end: 60 })

    const read = async (batches: any[][]) => {
      const events = await deliverAndSettle(batches)
      const req = events.find((e: any) => e.type === 'llm.request')
      expect(req).toBeDefined()
      return {
        instant: req.temporalOrder.instantUnixNano,
        raw: req.temporalOrder.rawInstantUnixNano,
        approximated: (req.provenance.lossReasons ?? []).includes('timing-approximated'),
      }
    }

    const together = await read([[parent, child]])
    const parentFirst = await read([[parent], [child]])
    const childFirst = await read([[child], [parent]])

    // Parent-first now produces byte-identical timing to single-batch delivery.
    expect(parentFirst.instant).toBe(together.instant)
    expect(BigInt(together.instant)).toBeGreaterThan(BigInt(together.raw))
    expect(together.approximated).toBe(true)

    // Child-first cannot be clamped — but it says so, which is the whole point.
    expect(childFirst.instant).toBe(childFirst.raw)
    expect(
      childFirst.approximated,
      'an unclamped orphan must still declare its timing unverified',
    ).toBe(true)
  }, 120_000)

  /**
   * R3. The anchor is invented in EVERY case and arrival-dependent in every
   * case, so the label has to be unconditional.
   *
   * It used to be attached only when the BATCH lacked a true root, which made
   * it a statement about the batch. Two true roots is the sharp counterexample:
   * the anchor names a different span depending on arrival, and under the old
   * condition it carried the warning in NO arrival order, because every batch
   * had a root. "Unavoidable but disclosed" only holds if it is always
   * disclosed.
   */
  it('run.started ALWAYS declares identity-synthesized, including when every batch has a root', async () => {
    const r = sp(1, { name: 'invoke_agent r', start: 0, end: 10, attrs: AGENT })
    const s = sp(2, { name: 'invoke_agent s', start: 20, end: 30, attrs: AGENT })

    const anchors = new Set<string>()
    for (const batches of [[[r, s]], [[s], [r]], [[r], [s]]]) {
      const events = await deliverAndSettle(batches)
      const started = events[0]
      expect(started.type).toBe('run.started')
      expect(started.provenance.lossy).toBe(true)
      expect(
        started.provenance.lossReasons,
        'the anchor is always invented, so it must always say so',
      ).toContain('identity-synthesized')
      anchors.add(started.provenance.spanId)
    }
    // The residue is real — the anchor genuinely differs by arrival order —
    // which is exactly why it must always be labelled.
    expect(anchors.size).toBeGreaterThan(1)
  }, 120_000)

  it('every derived event that is not run.started converges across delivery orders', async () => {
    // The exclusion is now MINIMAL: with R1/R2/R3 closed, run.started is the
    // only event whose identity varies, and only in its anchor.
    const r = sp(1, { name: 'invoke_agent r', start: 50, end: 100, attrs: AGENT })
    const child = sp(2, { parent: 1, start: 10, end: 60 })
    const s = sp(3, { name: 'invoke_agent s', start: 120, end: 130, attrs: AGENT })

    const fingerprints = new Set<string>()
    for (const batches of [[[r, child, s]], [[r], [child], [s]], [[s], [child], [r]], [[child, s], [r]]]) {
      const events = await deliverAndSettle(batches)
      fingerprints.add(
        events
          .filter((e: any) => e.type !== 'run.started')
          .map((e: any) => `${e.type}@${e.provenance.spanId}`)
          .sort()
          .join(','),
      )
    }
    expect(fingerprints.size).toBe(1)
  }, 120_000)
})

// ===========================================================================
describe('R2b + the ordering counters', () => {
  const AGENT = { 'gen_ai.operation.name': 'invoke_agent' }
  const LLM = { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm' }
  const mk = (n: number, o: any = {}) => ({
    traceId: TRACE_A,
    spanId: spanId(n),
    name: o.name ?? 'chat m',
    startTimeUnixNano: nanos(o.start ?? 0, BASE),
    ...(o.end !== undefined ? { endTimeUnixNano: nanos(o.end, BASE) } : {}),
    ...(o.parent !== undefined ? { parentSpanId: spanId(o.parent) } : {}),
    attributes: o.attrs ?? LLM,
  })

  async function deliver(batches: any[][]) {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    let runId = ''
    for (const spans of batches) {
      const res = await t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: spans as any,
      })
      runId = res.runId
    }
    return { t, runId }
  }

  /**
   * R2b. `timing-approximated` was attached in the orphan loop, so its
   * condition was "this span is an orphan". The property is "this instant is
   * unverified against its true ancestor" — and those diverge for the orphan's
   * DESCENDANTS.
   *
   * With a(50-200) > b(10-100) > c(20-60), delivering {b,c} then {a} leaves c
   * NOT an orphan (b is right there), so c never entered the loop — yet c was
   * clamped to b, whose own instant was unverified. c inherited the unverified
   * anchor without inheriting the disclosure, and its instant varies 50 vs 20
   * across delivery orders.
   */
  it('propagates the unverified-instant marker to an orphan\'s whole subtree', async () => {
    const a = mk(1, { name: 'invoke_agent a', start: 50, end: 200, attrs: AGENT })
    const b = mk(2, { parent: 1, start: 10, end: 100 })
    const c = mk(3, { parent: 2, start: 20, end: 60 })

    for (const batches of [[[a, b, c]], [[a], [b, c]], [[c], [b], [a]], [[b, c], [a]], [[b], [a], [c]]]) {
      const { t, runId } = await deliver(batches)
      const events = await eventsOf(t, runId)
      for (const target of [spanId(2), spanId(3)]) {
        const ev = events.find((e: any) => e.provenance.spanId === target && e.type === 'llm.request')
        expect(ev, `span ${target} must be recorded`).toBeDefined()
        expect(
          (ev.provenance.lossReasons ?? []).includes('timing-approximated'),
          `${target} must disclose that its instant is inferred`,
        ).toBe(true)
      }
    }
  }, 120_000)

  /**
   * The conservation invariant, in Team D's stronger form: every event either
   * CONVERGES, or is the synthesized anchor, or ADMITS its instant was
   * inferred. Weaker forms ("everything but run.started converges") are simply
   * false — R2's child-first arm legitimately diverges — and would either fail
   * forever or get quietly weakened.
   */
  it('every event converges, is the anchor, or admits timing-approximated', async () => {
    const a = mk(1, { name: 'invoke_agent a', start: 50, end: 200, attrs: AGENT })
    const b = mk(2, { parent: 1, start: 10, end: 100 })
    const c = mk(3, { parent: 2, start: 20, end: 60 })

    const instants = new Map<string, Set<string>>()
    const excused = new Set<string>()
    for (const batches of [[[a, b, c]], [[a], [b, c]], [[c], [b], [a]], [[b, c], [a]], [[b], [a], [c]]]) {
      const { t, runId } = await deliver(batches)
      for (const e of await eventsOf(t, runId)) {
        const key = `${e.type}@${e.provenance.spanId}@${e.temporalOrder.phase}`
        if (!instants.has(key)) instants.set(key, new Set())
        instants.get(key)!.add(e.temporalOrder.instantUnixNano)
        if (e.type === 'run.started') excused.add(key)
        if ((e.provenance.lossReasons ?? []).includes('timing-approximated')) excused.add(key)
      }
    }
    expect(instants.size).toBeGreaterThan(3)
    for (const [key, seen] of instants) {
      if (seen.size === 1) continue
      expect(excused, `${key} diverges across delivery orders without excuse`).toContain(key)
    }
  }, 120_000)

  /**
   * The counters must equal a full recompute over the log. This is the guard
   * that makes a denormalized value trustworthy: two writers maintain it (the
   * ingest batch and the settle terminal), and a drift between them is exactly
   * the failure mode that makes such counters worse than useless.
   */
  it('the ordering counters equal a recompute from the log, under every partition', async () => {
    const a = mk(1, { name: 'invoke_agent a', start: 0, end: 200, attrs: AGENT })
    const b = mk(2, { parent: 1, start: 10, end: 100 })
    const c = mk(3, { parent: 2, start: 20, end: 60 })

    for (const batches of [[[a, b, c]], [[a], [b], [c]], [[c], [b], [a]], [[b, c], [a]]]) {
      const { t, runId } = await deliver(batches)
      // Settle so the terminal — the SECOND write site — is included.
      await t.run(async (ctx: any) => {
        await ctx.db.patch(runId, { otelLastAppendAt: Date.now() - 10 * 60 * 1000 })
      })
      await t.mutation(internal.otel_settle.settleOtelTrace, { runId })

      const events = await eventsOf(t, runId)
      const run = (await allRuns(t)).find((r: any) => r._id === runId)
      const derived = events.filter((e: any) => e.provenance?.source === 'otel').length
      const unkeyed = events.filter(
        (e: any) => e.provenance?.source === 'otel' && e.temporalOrder === undefined,
      ).length

      expect(run.derivedEventCount).toBe(derived)
      expect(run.otelUnkeyedDerivedCount ?? 0).toBe(unkeyed)
      // Everything this path writes is keyed, so the verdict is `temporal`.
      expect(unkeyed).toBe(0)
      expect(derived).toBe(events.length)
    }
  }, 120_000)

  it('a redelivered batch adds nothing to the counters', async () => {
    const a = mk(1, { name: 'invoke_agent a', start: 0, end: 200, attrs: AGENT })
    const b = mk(2, { parent: 1, start: 10, end: 100 })

    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    const first = await t.mutation(api.otel_ingest.otelIngestSpans, {
      apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [a, b] as any,
    })
    const before = (await allRuns(t))[0].derivedEventCount

    for (let i = 0; i < 3; i += 1) {
      await t.mutation(api.otel_ingest.otelIngestSpans, {
        apiKeyHash: KEY_A, traceId: TRACE_A, agentId: agentA, spans: [a, b] as any,
      })
    }
    const after = (await allRuns(t))[0].derivedEventCount
    expect(after).toBe(before)
    expect(after).toBe((await eventsOf(t, first.runId)).length)
  })

  it('counts are partition-independent', async () => {
    const a = mk(1, { name: 'invoke_agent a', start: 0, end: 200, attrs: AGENT })
    const b = mk(2, { parent: 1, start: 10, end: 100 })
    const c = mk(3, { parent: 2, start: 20, end: 60 })

    const totals = new Set<number>()
    for (const batches of [[[a, b, c]], [[a], [b], [c]], [[c], [b], [a]], [[b, c], [a]], [[a, b], [c]]]) {
      const { t, runId } = await deliver(batches)
      const run = (await allRuns(t)).find((r: any) => r._id === runId)
      totals.add(run.derivedEventCount)
    }
    expect(totals.size).toBe(1)
  }, 120_000)
})
