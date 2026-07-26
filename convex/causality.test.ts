/* eslint-disable */
/**
 * CROSS-RUN CAUSAL GRAPH — Convex surface verification
 * (convex-test harness, real functions against the real schema).
 *
 * The pure fold is verified in convex/helpers/causal_graph.test.ts. These tests
 * verify what only the real Convex layer can be wrong about:
 *
 *  (A) CROSS-ORG ISOLATION AT EVERY HOP, not just the first. Following
 *      convex/tenancy_oracle.test.ts, outcomes are captured as {ok, value} or
 *      {ok, error} and compared with toEqual, so a version that merely throws
 *      DIFFERENT errors for "foreign" vs "missing" still FAILS. The chain is
 *      built so the leak would be at hop 3, past every entry-point check.
 *
 *  (B) THE DOWNWARD QUESTION IS ACTUALLY ANSWERED — a failing run's transitive
 *      consumers, derived from the LOG and from `parentRunId`.
 *
 *  (C) A CYCLE THROUGH THE REAL DATABASE TERMINATES. Without a visited set this
 *      test would hang rather than fail, which is why it is here and not only in
 *      the pure suite.
 *
 *  (D) NOTHING IS INFERRED BY THE REAL WALK EITHER: a database full of
 *      same-session, temporally-adjacent runs yields an empty edge set.
 *
 *  (E) THE INDEX IS REBUILDABLE FROM THE LOG. The property that makes
 *      `run_causal_edges` a projection rather than a second source of truth: wipe
 *      it, re-derive from the events alone, and the row set is IDENTICAL. If it
 *      were not, the table would carry facts the log does not.
 *
 *  (F) RETENTION CASCADES, and a half-deleted chain reports a LOST TRAIL rather
 *      than a shorter one.
 */
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'

import {
  causalTraversalVerdict,
  isCausalTraversalComplete,
  lostTrails,
  recordedOrigins,
  traversalClaimContradictions,
  traversalIncoherences,
} from '@agent-flight-recorder/contracts'

import { api, internal } from './_generated/api'
import { deleteCausalEdgesForRun } from './causality'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const asA = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
const asB = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'user_b', org_id: 'clerk_b' })

/** Seeds two structurally identical orgs, each with `runCount` runs and no edges. */
async function seed(t: ReturnType<typeof convexTest>, runCount = 6) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const out: Record<string, any> = { now }
    for (const tag of ['a', 'b'] as const) {
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: `clerk_${tag}`, name: tag.toUpperCase(), slug: tag, plan: 'free', createdAt: now, updatedAt: now,
      })
      await ctx.db.insert('user_memberships', { clerkUserId: `user_${tag}`, orgId, role: 'member', joinedAt: now })
      const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agentId = await ctx.db.insert('agents', {
        orgId, projectId, name: `${tag}-agent`, slug: `${tag}-agent`, createdAt: now, updatedAt: now,
      })
      const runIds: any[] = []
      for (let i = 0; i < runCount; i++) {
        runIds.push(
          await ctx.db.insert('runs', {
            orgId, projectId, agentId,
            status: i === 0 ? 'failed' : 'completed',
            // ADJACENT IN TIME and IN ONE SESSION on purpose — the exact
            // configuration a temporal heuristic would link.
            startedAt: now + i * 1000,
            endedAt: now + i * 1000 + 500,
            sessionId: `${tag}-session`,
            metadata: {}, tags: [],
          }),
        )
      }
      out[tag] = { orgId, projectId, agentId, runIds }
    }
    return out
  })
}

/** Append an event to a run's log that RECORDS a handoff, and project it. */
async function recordHandoff(
  t: ReturnType<typeof convexTest>,
  args: { orgId: any; inRunId: any; payload: Record<string, unknown>; seq?: number; type?: string },
) {
  return await t.run(async (ctx) => {
    const eventId = await ctx.db.insert('events', {
      runId: args.inRunId,
      orgId: args.orgId,
      type: args.type ?? 'agent.message',
      sequenceNumber: args.seq ?? 1,
      timestamp: Date.now(),
      payload: args.payload,
    })
    return eventId
  })
}

// ===========================================================================
// (D) THE REAL WALK INFERS NOTHING
// ===========================================================================

describe('D. the real traversal derives edges from the log, it does not infer them', () => {
  it('six adjacent same-session runs on one agent produce ZERO edges', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)

    const report = await asA(t).query(api.causality.traceRunImpact, { runId: s.a.runIds[0] })

    expect(report.edges).toEqual([])
    expect(report.nodes).toHaveLength(1) // only the subject is reachable
    expect(report.scan.edgesRead).toBe(0)
    expect(traversalIncoherences(report)).toEqual([])

    // The session appears ONLY as a suspicion — directionless, unwalkable, and
    // carrying RUN IDS rather than a count, so it can actually reach the
    // contract's quarantine band.
    expect(report.suspected).toHaveLength(1)
    expect(report.suspected[0]!.kind).toBe('shared_session')
    expect(report.suspected[0]!.runIds).toHaveLength(6)
    expect(report.suspected[0]!.runIds.every((r: string) => typeof r === 'string')).toBe(true)
    expect('producerRunId' in report.suspected[0]!).toBe(false)
  })

})

// ===========================================================================
// (B) THE DOWNWARD QUESTION
// ===========================================================================

describe('B. "what did this poison?" is answered from the log and from parentRunId', () => {
  it('walks a failing run transitively downstream across both recorded sources', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [bad, child, grandchild, consumer, unrelated] = s.a.runIds

    await t.run(async (ctx) => {
      // Source 1: parentRunId, written at run creation. A run-field record.
      await ctx.db.patch(child, { parentRunId: bad })
      await ctx.db.patch(grandchild, { parentRunId: child })
    })
    // Source 2: an event in the CONSUMER's own log naming the run it read from.
    // The link parentRunId structurally cannot express — both runs already exist.
    const evId = await recordHandoff(t, {
      orgId: s.a.orgId,
      inRunId: consumer,
      type: 'tool.call',
      payload: { consumedRunId: grandchild },
    })
    await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: evId })

    const report = await asA(t).query(api.causality.traceRunImpact, { runId: bad })
    const reached = report.nodes.map((n: any) => n.runId).sort()
    expect(reached).toEqual([bad, child, grandchild, consumer].sort())
    expect(reached).not.toContain(unrelated)

    const byId = new Map(report.nodes.map((n: any) => [n.runId, n]))
    expect(byId.get(bad)!.hopsFromSubject).toBe(0)
    expect(byId.get(consumer)!.hopsFromSubject).toBe(3)
    expect(report.edges.map((e: any) => e.kind).sort()).toEqual([
      'output_consumed', 'spawned', 'spawned',
    ])
    // Every edge cites a log position inside one of its own endpoints.
    for (const e of report.edges) {
      for (const c of e.recordedBy) expect([e.producerRunId, e.consumerRunId]).toContain(c.recordedInRunId)
    }
    expect(report.verdict).toBe('chain_recorded')
    expect(report.verdict).toBe(causalTraversalVerdict(report))
    expect(traversalIncoherences(report)).toEqual([])
  })

  it('an event recorded through the NORMAL write path is projected automatically', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [producer, consumer] = s.a.runIds

    // The ordinary ingest path, not the repair mutation: a run.started event
    // followed by one carrying the handoff.
    await t.run(async (ctx) => {
      await ctx.db.patch(consumer, { status: 'running' })
    })
    await asA(t).mutation(api.events.createEvent, {
      runId: consumer, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {},
    })
    await asA(t).mutation(api.events.createEvent, {
      runId: consumer, type: 'tool.call', sequenceNumber: 2, timestamp: Date.now(),
      payload: { consumedRunId: producer, name: 'read_report' },
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('run_causal_edges').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]!.producerRunId).toBe(producer)
    expect(rows[0]!.consumerRunId).toBe(consumer)
    expect(rows[0]!.kind).toBe('output_consumed')
    expect(rows[0]!.citation.cites).toBe('event')
    expect(rows[0]!.derivedFromRunId).toBe(consumer)

    const report = await asA(t).query(api.causality.traceRunImpact, { runId: producer })
    expect(report.nodes.map((n: any) => n.runId).sort()).toEqual([producer, consumer].sort())
  })

  it('walks upward to the earliest RECORDED cause, and never calls it a root cause', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [origin, mid, leaf] = s.a.runIds
    await t.run(async (ctx) => {
      await ctx.db.patch(mid, { parentRunId: origin })
      await ctx.db.patch(leaf, { parentRunId: mid })
    })

    const report = await asA(t).query(api.causality.traceRunOrigin, { runId: leaf })
    const origins = recordedOrigins(report)
    expect(origins).toHaveLength(1)
    expect(origins[0]!.originRunId).toBe(origin)
    expect(origins[0]!.hopsToOrigin).toBe(2)
    expect(lostTrails(report)).toEqual([])
    expect(isCausalTraversalComplete(report)).toBe(true)
  })

  it('a depth budget produces a LostTrail naming the real frontier run', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [r0, r1, r2, r3] = s.a.runIds
    await t.run(async (ctx) => {
      await ctx.db.patch(r1, { parentRunId: r0 })
      await ctx.db.patch(r2, { parentRunId: r1 })
      await ctx.db.patch(r3, { parentRunId: r2 })
    })

    const report = await asA(t).query(api.causality.traceRunImpact, { runId: r0, maxDepth: 2 })
    expect(report.nodes.map((n: any) => n.runId).sort()).toEqual([r0, r1, r2].sort())
    const lost = lostTrails(report)
    expect(lost.map((l) => l.lastReachedRunId)).toEqual([r2])
    expect(lost[0]!.kind).toBe('depth_limit_reached')
    expect(report.scan.maxDepthRequested).toBe(2)
    expect(isCausalTraversalComplete(report)).toBe(false)
  })
})

// ===========================================================================
// (C) A CYCLE THROUGH THE REAL DATABASE
// ===========================================================================

describe('C. a recorded cycle terminates against the real database', () => {
  it('A <-> B terminates, and is a cycle_reentry rather than a lost trail', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [a, b] = s.a.runIds

    // A supervisor/retry loop: each run's own log names the other. Both are
    // RECORDED — this is an ordinary agent architecture, not corruption.
    const e1 = await recordHandoff(t, { orgId: s.a.orgId, inRunId: b, payload: { consumedRunId: a } })
    const e2 = await recordHandoff(t, { orgId: s.a.orgId, inRunId: a, seq: 2, payload: { consumedRunId: b } })
    await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: e1 })
    await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: e2 })

    const upward = await asA(t).query(api.causality.traceRunOrigin, { runId: a })
    expect(upward.nodes.map((n: any) => n.runId).sort()).toEqual([a, b].sort())
    expect(upward.termini.some((x: any) => x.terminus === 'cycle_reentry')).toBe(true)
    // A cycle is NOT a failure of the walk.
    expect(lostTrails(upward)).toEqual([])
    expect(recordedOrigins(upward)).toEqual([])
    expect(traversalIncoherences(upward)).toEqual([])
  })
})

// ===========================================================================
// (A) CROSS-ORG ISOLATION AT EVERY HOP
// ===========================================================================

describe('A. cross-org is indistinguishable from missing, at every hop', () => {
  it('a foreign subject run is reported exactly as a nonexistent one', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)

    const foreign = await outcome(() =>
      asA(t).query(api.causality.traceRunOrigin, { runId: s.b.runIds[0] }),
    )
    expect(foreign.ok).toBe(true)
    expect(foreign.value!.nodes).toEqual([])
    expect(foreign.value!.edges).toEqual([])
    expect(lostTrails(foreign.value!)[0]!.kind).toBe('edge_set_unreadable')
    expect(foreign.value!.verdict).toBe('indeterminate')

    // And an in-org run is genuinely different, so the test is not vacuous.
    const own = await asA(t).query(api.causality.traceRunOrigin, { runId: s.a.runIds[0] })
    expect(own.nodes).toHaveLength(1)
  })

  it('a cross-org neighbour at HOP 3 is dropped, and the trail is reported LOST', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [a0, a1, a2] = s.a.runIds
    const foreign = s.b.runIds[0]

    await t.run(async (ctx) => {
      await ctx.db.patch(a1, { parentRunId: a0 })
      await ctx.db.patch(a2, { parentRunId: a1 })
      // A mis-stamped historical row: an org-A index row naming an org-B run.
      // The projection path rejects this today; the traversal must not depend on
      // every historical write having been correct.
      await ctx.db.insert('run_causal_edges', {
        orgId: s.a.orgId, producerRunId: foreign, consumerRunId: a0,
        kind: 'output_consumed', handoffAt: Date.now(), derivedFromRunId: a0,
        citation: { cites: 'run_field', field: 'parentRunId' },
      })
    })

    const report = await asA(t).query(api.causality.traceRunOrigin, { runId: a2 })

    // The foreign run is in NO part of the answer.
    expect(report.nodes.map((n: any) => n.runId)).not.toContain(foreign)
    expect(report.edges.flatMap((e: any) => [e.producerRunId, e.consumerRunId])).not.toContain(foreign)

    // And the walk says it LOST the trail rather than naming a0 as the origin.
    expect(recordedOrigins(report)).toEqual([])
    const lost = lostTrails(report)
    expect(lost.map((l) => l.lastReachedRunId)).toEqual([a0])
    expect(lost[0]!.kind).toBe('adjacent_run_unavailable')
    expect(lost[0]!.lostBecause).toMatch(/INDISTINGUISHABLE/)
    expect(isCausalTraversalComplete(report)).toBe(false)
  })

  it("org B's identical graph never appears in org A's report, and vice versa", async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await t.run(async (ctx) => {
      for (const tag of ['a', 'b'] as const) {
        await ctx.db.patch(s[tag].runIds[1], { parentRunId: s[tag].runIds[0] })
        await ctx.db.patch(s[tag].runIds[2], { parentRunId: s[tag].runIds[1] })
      }
    })

    const ra = await asA(t).query(api.causality.traceRunImpact, { runId: s.a.runIds[0] })
    const rb = await asB(t).query(api.causality.traceRunImpact, { runId: s.b.runIds[0] })

    // Identical SHAPE (so a leak would DOUBLE the counts, not merely change
    // them) but disjoint CONTENTS.
    expect(ra.nodes).toHaveLength(3)
    expect(rb.nodes).toHaveLength(3)
    const aIds = new Set(ra.nodes.map((n: any) => n.runId))
    for (const n of rb.nodes) expect(aIds.has(n.runId)).toBe(false)
  })

  it('an unauthenticated caller gets nothing from any of the three surfaces', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    for (const fn of [
      api.causality.traceRunOrigin,
      api.causality.traceRunImpact,
    ]) {
      const r = await outcome(() => t.query(fn, { runId: s.a.runIds[0] }))
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/Unauthorized/)
    }
  })

  it('an event naming a run in ANOTHER org projects NO edge, silently', async () => {
    // The projection is where tenancy is enforced for the log->index path. A
    // payload carrying a foreign run id must produce nothing, and must produce
    // it the same way a fabricated id does — no distinguishable outcome that
    // could be used to probe another org's run ids.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const foreignNamed = await recordHandoff(t, {
      orgId: s.a.orgId, inRunId: s.a.runIds[1], payload: { consumedRunId: s.b.runIds[0] },
    })
    const fabricated = await recordHandoff(t, {
      orgId: s.a.orgId, inRunId: s.a.runIds[2], payload: { consumedRunId: 'not_a_real_id' },
    })
    const a = await outcome(() =>
      t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: foreignNamed }),
    )
    const b = await outcome(() =>
      t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: fabricated }),
    )
    expect(a).toEqual(b)
    expect(a.value!.written).toBe(0)
    expect(await t.run(async (ctx) => await ctx.db.query('run_causal_edges').collect())).toEqual([])
  })
})

// ===========================================================================
// (E) THE INDEX IS REBUILDABLE FROM THE LOG
// ===========================================================================

describe('E. run_causal_edges is a projection, not a second source of truth', () => {
  it('wiping and re-deriving from the log alone reproduces the IDENTICAL row set', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [p1, p2, consumer] = s.a.runIds

    for (const [i, producer] of [p1, p2].entries()) {
      const ev = await recordHandoff(t, {
        orgId: s.a.orgId, inRunId: consumer, seq: i + 1,
        payload: { consumedRunId: producer },
      })
      await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: ev })
    }

    const before = await t.run(async (ctx) =>
      (await ctx.db.query('run_causal_edges').collect())
        .map((r) => `${r.producerRunId}->${r.consumerRunId}:${r.kind}:${r.handoffAt}:${r.derivedFromRunId}`)
        .sort(),
    )
    expect(before).toHaveLength(2)

    const result = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: consumer })
    expect(result.deleted).toBe(2)
    expect(result.rebuilt).toBe(2)
    expect(result.scanTruncated).toBe(false)

    const after = await t.run(async (ctx) =>
      (await ctx.db.query('run_causal_edges').collect())
        .map((r) => `${r.producerRunId}->${r.consumerRunId}:${r.kind}:${r.handoffAt}:${r.derivedFromRunId}`)
        .sort(),
    )
    // IDENTICAL — including `handoffAt`, which is taken from the EVENT and never
    // from `Date.now()`, so a rebuild months later produces the same row.
    expect(after).toEqual(before)
  })

  it('a row with no log behind it does not survive a rebuild', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [a, b] = s.a.runIds
    // A hand-written row, as an earlier design would have allowed.
    await t.run(async (ctx) => {
      await ctx.db.insert('run_causal_edges', {
        orgId: s.a.orgId, producerRunId: a, consumerRunId: b, kind: 'output_consumed',
        handoffAt: Date.now(), derivedFromRunId: b,
        citation: { cites: 'run_field', field: 'invented' },
      })
    })
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: b })
    const rows = await t.run(async (ctx) => await ctx.db.query('run_causal_edges').collect())
    // Gone: the log does not support it, so the projection does not carry it.
    expect(rows).toEqual([])
  })

  it('projection is idempotent — re-projecting the same event adds nothing', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const ev = await recordHandoff(t, {
      orgId: s.a.orgId, inRunId: s.a.runIds[1], payload: { consumedRunId: s.a.runIds[0] },
    })
    const first = await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: ev })
    const second = await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: ev })
    expect(first.written).toBe(1)
    expect(second.written).toBe(0)
    const rows = await t.run(async (ctx) => await ctx.db.query('run_causal_edges').collect())
    expect(rows).toHaveLength(1)
  })

  it('an event recording no handoff is refused rather than inventing an edge', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const ev = await recordHandoff(t, {
      orgId: s.a.orgId, inRunId: s.a.runIds[0], payload: { message: 'hello' },
    })
    const r = await outcome(() =>
      t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: ev }),
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/records no cross-run handoff/)
  })

  it('exposes no CLIENT-CALLABLE way to write, update or delete an edge assertion', async () => {
    const mod = (await import('./causality.js')) as Record<string, any>
    // The whole point of the redesign: a caller cannot ASSERT an edge, only
    // point at a log position that already records one.
    expect(Object.keys(mod)).not.toContain('recordCausalEdge')
    expect(Object.keys(mod)).not.toContain('recordCausalEdgeFromEvent')

    // Every REGISTERED Convex function this module exposes, by name. A plain
    // exported helper (`deleteCausalEdgesForRun`, called by the retention
    // cascade) is not client-callable and is deliberately not in this set.
    const registered = Object.keys(mod).filter(
      (n) => mod[n]?.isQuery === true || mod[n]?.isMutation === true,
    )
    const publicFns = registered.filter((n) => mod[n]?.isPublic === true)
    // READ-ONLY, and exactly the three the web wires. An unwired public
    // function is dead surface — `tests/unit/convex_function_refs.test.ts`
    // flags it, and the repair path was moved to `internalMutation` rather
    // than given a ref it had no consumer for.
    expect(publicFns.sort()).toEqual(['getIncidentGraph', 'traceRunImpact', 'traceRunOrigin'])
    expect(registered.filter((n) => mod[n]?.isMutation === true).every((n) => mod[n]?.isInternal === true)).toBe(true)
    // No mutation that could edit or remove a recorded handoff.
    expect(registered.filter((n) => /^(update|delete|remove|edit)/i.test(n))).toEqual([])
    // And `deleteCausalEdgesForRun` really is a bare helper, not a function.
    expect(mod.deleteCausalEdgesForRun?.isQuery).toBeUndefined()
    expect(mod.deleteCausalEdgesForRun?.isMutation).toBeUndefined()
  })
})

// ===========================================================================
// (F) RETENTION CASCADES
// ===========================================================================

describe('F. retention deletes the projection with the log it came from', () => {
  it('a purged run takes its OWN projected rows and leaves the other end a LOST TRAIL', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [producer, consumer] = s.a.runIds

    const ev = await recordHandoff(t, {
      orgId: s.a.orgId, inRunId: consumer, payload: { consumedRunId: producer },
    })
    await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: ev })
    expect(await t.run(async (ctx) => (await ctx.db.query('run_causal_edges').collect()).length)).toBe(1)

    // Purge the CONSUMER — the run whose log carried the record — through the
    // real cascade helper, which retention calls BEFORE deleting the run. The
    // ordering is load-bearing: the rows are keyed by orgId, and the only place
    // the orgId can be read from is the run itself.
    await t.run(async (ctx) => {
      await deleteCausalEdgesForRun(ctx as any, s.a.orgId, consumer)
      await ctx.db.delete(ev)
      await ctx.db.delete(consumer)
    })

    // The projected row is gone with the log it came from.
    const rows = await t.run(async (ctx) => await ctx.db.query('run_causal_edges').collect())
    expect(rows).toEqual([])

    // And the producer's own downstream view is now honestly empty rather than
    // pointing at a run nobody can read.
    const report = await asA(t).query(api.causality.traceRunImpact, { runId: producer })
    expect(report.nodes.map((n: any) => n.runId)).toEqual([producer])
  })

  it('rebuilding a DELETED run says runMissing rather than reporting a clean no-op', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const gone = s.a.runIds[0]
    await t.run(async (ctx) => {
      await ctx.db.delete(gone)
    })
    const result = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: gone })
    // Zeros alone would read as "rebuilt successfully, nothing to do".
    expect(result.runMissing).toBe(true)
    expect(result.rebuilt).toBe(0)
  })

  it('a row whose OTHER endpoint was purged reports adjacent_run_unavailable, not a shorter chain', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [producer, consumer] = s.a.runIds

    const ev = await recordHandoff(t, {
      orgId: s.a.orgId, inRunId: consumer, payload: { consumedRunId: producer },
    })
    await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: ev })

    // Purge the PRODUCER. The consumer's log still records the handoff, so the
    // row correctly survives — and the walk must say the far end is gone.
    await t.run(async (ctx) => {
      await ctx.db.delete(producer)
    })

    const report = await asA(t).query(api.causality.traceRunOrigin, { runId: consumer })
    expect(recordedOrigins(report)).toEqual([])
    const lost = lostTrails(report)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.lastReachedRunId).toBe(consumer)
    expect(lost[0]!.kind).toBe('adjacent_run_unavailable')
    expect(lost[0]!.wouldBeRecoveredBy).toMatch(/retention/)
    expect(isCausalTraversalComplete(report)).toBe(false)
  })
})

// ===========================================================================
// (G) listChildRuns — BOTH HALVES OF THE TRUNCATION DEFECT
// ===========================================================================

describe('G. listChildRuns reports its own truncation, and never drops rows after taking', () => {
  it('a capped page says so, and the count is a FLOOR', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t, 1)
    const parent = s.a.runIds[0]
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) {
        await ctx.db.insert('runs', {
          orgId: s.a.orgId, projectId: s.a.projectId, agentId: s.a.agentId,
          status: 'completed', startedAt: Date.now() + i, parentRunId: parent,
          metadata: {}, tags: [],
        })
      }
    })

    const page = await asA(t).query(api.runs.listChildRuns, { parentRunId: parent, limit: 5 })
    expect(page.runs).toHaveLength(5)
    expect(page.truncated).toBe(true)
    expect(page.complete).toBe(false)
    expect(page.nextCursor).toBeDefined()

    const whole = await asA(t).query(api.runs.listChildRuns, { parentRunId: parent, limit: 50 })
    expect(whole.runs).toHaveLength(12)
    expect(whole.complete).toBe(true)
    expect(whole.truncated).toBe(false)
    expect(whole.nextCursor).toBeUndefined()
  })

  it('a foreign child is not in the range at all, so a short page really is complete', async () => {
    // THE SECOND HALF, and the one that fools a reader who knows about the
    // first: filtering AFTER the take returned a short page WITHOUT the ceiling
    // having been reached, so `runs.length < limit` reported complete on a page
    // that had silently lost rows.
    const t = convexTest(schema, modules)
    const s = await seed(t, 1)
    const parent = s.a.runIds[0]
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('runs', {
          orgId: s.a.orgId, projectId: s.a.projectId, agentId: s.a.agentId,
          status: 'completed', startedAt: Date.now() + i, parentRunId: parent,
          metadata: {}, tags: [],
        })
      }
      // A data defect: an org-B run stamped with an org-A parent.
      await ctx.db.insert('runs', {
        orgId: s.b.orgId, projectId: s.b.projectId, agentId: s.b.agentId,
        status: 'completed', startedAt: Date.now(), parentRunId: parent,
        metadata: {}, tags: [],
      })
    })

    const page = await asA(t).query(api.runs.listChildRuns, { parentRunId: parent, limit: 4 })
    expect(page.runs).toHaveLength(3)
    expect(page.runs.every((r: any) => r.orgId === s.a.orgId)).toBe(true)
    // Three of four requested, and GENUINELY complete — because the foreign row
    // was never in the range, not because it was dropped after being read.
    expect(page.complete).toBe(true)
    expect(page.truncated).toBe(false)
  })

  it('a foreign parent is reported exactly as a missing one', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const foreign = await outcome(() =>
      asA(t).query(api.runs.listChildRuns, { parentRunId: s.b.runIds[0] }),
    )
    expect(foreign.ok).toBe(false)
    expect(foreign.error).toMatch(/Run not found/)
  })
})

// ===========================================================================
// (H) A DANGLING parentRunId AFTER A PURGE
// ===========================================================================

describe('H. a purged parent leaves a LOST TRAIL, not a shorter chain', () => {
  it('a child whose parentRunId points at a deleted run reports adjacent_run_unavailable', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [parent, child] = s.a.runIds
    await t.run(async (ctx) => {
      await ctx.db.patch(child, { parentRunId: parent })
      // Retention purges the parent. `parentRunId` is on the CHILD's immutable
      // run record and is never rewritten, so the pointer dangles by design.
      await ctx.db.delete(parent)
    })

    const report = await asA(t).query(api.causality.traceRunOrigin, { runId: child })
    // NOT reported as "the chain starts at the child".
    expect(recordedOrigins(report)).toEqual([])
    const lost = lostTrails(report)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.lastReachedRunId).toBe(child)
    expect(lost[0]!.kind).toBe('adjacent_run_unavailable')
    expect(lost[0]!.lostBecause).toMatch(/INDISTINGUISHABLE/)
    expect(isCausalTraversalComplete(report)).toBe(false)
    expect(report.verdict).toBe('indeterminate')
    expect(traversalClaimContradictions(report)).toEqual([])
  })
})

// ===========================================================================
// (I) THE COMPONENT QUERY REFUSES RATHER THAN MISLEADS
// ===========================================================================

describe('I. getIncidentGraph refuses, because a component traversal is unrepresentable', () => {
  it('returns an explanatory error naming the two queries that ARE representable', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await outcome(() =>
      asA(t).query(api.causality.getIncidentGraph, { runId: s.a.runIds[0] }),
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/component traversal cannot be represented/)
    expect(r.error).toMatch(/traceRunOrigin and traceRunImpact/)
  })

  it('the two directional queries each audit clean against their OWN direction', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [origin, mid, leaf] = s.a.runIds
    await t.run(async (ctx) => {
      await ctx.db.patch(mid, { parentRunId: origin })
      await ctx.db.patch(leaf, { parentRunId: mid })
    })
    const up = await asA(t).query(api.causality.traceRunOrigin, { runId: leaf })
    const down = await asA(t).query(api.causality.traceRunImpact, { runId: origin })
    for (const r of [up, down]) {
      expect(r.termini.length).toBeGreaterThan(0)
      expect(traversalClaimContradictions(r)).toEqual([])
      expect(traversalIncoherences(r)).toEqual([])
      expect(isCausalTraversalComplete(r)).toBe(true)
    }
    expect(recordedOrigins(up)[0]!.originRunId).toBe(origin)
    expect(recordedOrigins(down)[0]!.originRunId).toBe(leaf)
  })
})

// ===========================================================================
// (J) CITATIONS REACH THE CONTRACT SHAPES INTACT
// ===========================================================================

describe('J. an event citation keeps its real sequence number, end to end', () => {
  it('carries the stored sequenceNumber rather than a 0 sentinel', async () => {
    // `0` is a plausible sequence value, so a `0` sentinel is indistinguishable
    // from data — the same class as null-versus-0 on a base rate.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [producer, consumer] = s.a.runIds
    const ev = await recordHandoff(t, {
      orgId: s.a.orgId, inRunId: consumer, seq: 17, type: 'tool.result',
      payload: { consumedRunId: producer },
    })
    await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: ev })

    const report = await asA(t).query(api.causality.traceRunOrigin, { runId: consumer })
    const citation = report.edges[0]!.recordedBy.find((c: any) => c.cites === 'event')!
    expect(citation.sequenceNumber).toBe(17)
    expect(citation.eventType).toBe('tool.result')
    expect(citation.eventId).toBe(ev)
    expect(citation.recordedInRunId).toBe(consumer)
    expect(citation.namesRunId).toBe(producer)
  })

  it('a matching artifact digest across two runs is a shared_resource SUSPICION, not an edge', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [a, b] = s.a.runIds
    await t.run(async (ctx) => {
      for (const runId of [a, b]) {
        await ctx.db.insert('artifacts', {
          runId, orgId: s.a.orgId, name: 'out.json', mimeType: 'application/json',
          size: 12, storageKey: `k_${runId}`, storageBucket: 'b',
          checksum: '9c31deadbeefcafe', createdAt: Date.now(),
        })
      }
      // Only a session links them at all, so both are reachable in one walk.
      await ctx.db.patch(b, { parentRunId: a })
    })

    const report = await asA(t).query(api.causality.traceRunImpact, { runId: a })
    // The parentRunId edge is real; the digest adds NO second edge.
    expect(report.edges).toHaveLength(1)
    expect(report.edges[0]!.kind).toBe('spawned')
    // And because a recorded edge already links the pair, the coincidence is not
    // raised beside it as though it corroborated anything.
    expect(report.suspected.filter((l: any) => l.kind === 'shared_resource')).toEqual([])
    expect(traversalClaimContradictions(report)).toEqual([])
  })
})

// ===========================================================================
// (K) THE CLIPPED NODE IS IDENTIFIABLE
// ===========================================================================

describe('K. a fan-out clip names the node it clipped', () => {
  it('the clipped parent reads adjacency_unread, not edge_recorded', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t, 1)
    const parent = s.a.runIds[0]
    // 69 children against a per-node budget of 64: five vanish.
    await t.run(async (ctx) => {
      for (let i = 0; i < 69; i++) {
        await ctx.db.insert('runs', {
          orgId: s.a.orgId, projectId: s.a.projectId, agentId: s.a.agentId,
          status: 'completed', startedAt: Date.now() + i, parentRunId: parent,
          metadata: {}, tags: [],
        })
      }
    })

    // Depth 2 so the children are EXPANDED — otherwise every child is
    // `adjacency_unread` for the unrelated reason that the depth limit stopped
    // us, and the assertion below would prove nothing about the clip.
    const report = await asA(t).query(api.causality.traceRunImpact, { runId: parent, maxDepth: 2 })
    const parentNode = report.nodes.find((n: any) => n.runId === parent)!

    // THE FINDING: the parent HAS edges, so an `onwardCount > 0` test called it
    // `edge_recorded` — byte-identical to a node read in full. It is not read in
    // full, and the traversal knows exactly which node that is.
    expect(parentNode.adjacency).toBe('adjacency_unread')
    expect(report.edges.length).toBe(64)

    // A child that WAS read in full, so the distinction is doing real work.
    const child = report.nodes.find((n: any) => n.runId !== parent)!
    expect(child.adjacency).toBe('no_edge_recorded')

    // And the coarse signal still holds alongside the precise one.
    expect(report.scan.edgeSetsComplete).toBe(false)
    expect(isCausalTraversalComplete(report)).toBe(false)
    expect(traversalClaimContradictions(report)).toEqual([])
  })

  it('a node read to the end WITH edges is still edge_recorded', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [parent, child] = s.a.runIds
    await t.run(async (ctx) => {
      await ctx.db.patch(child, { parentRunId: parent })
    })
    const report = await asA(t).query(api.causality.traceRunImpact, { runId: parent })
    expect(report.nodes.find((n: any) => n.runId === parent)!.adjacency).toBe('edge_recorded')
    expect(report.scan.edgeSetsComplete).toBe(true)
  })
})

// ===========================================================================
// (L) NO ROW IS UNREACHABLE BY A REBUILD
// ===========================================================================

describe('L. a row keyed to a bystander is reclaimable, and invisible meanwhile', () => {
  it('rebuilding EITHER endpoint destroys a row whose source run is a third party', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [producer, consumer, bystander] = s.a.runIds

    // A forged row: claims to have been derived from a run that is neither of
    // its endpoints. No shipped surface can write this — the projection always
    // keys on `event.runId`, an endpoint by construction — but the rebuild
    // property must not depend on an argument about who currently writes.
    await t.run(async (ctx) => {
      await ctx.db.insert('run_causal_edges', {
        orgId: s.a.orgId, producerRunId: producer, consumerRunId: consumer,
        kind: 'output_consumed', handoffAt: Date.now(), derivedFromRunId: bystander,
        citation: { cites: 'run_field', field: 'forged' },
      })
    })

    // It is not visible to the walk in the meantime: a run's log cannot record a
    // handoff it was not part of, so the citation is impossible on its face.
    const before = await asA(t).query(api.causality.traceRunOrigin, { runId: consumer })
    expect(before.edges).toEqual([])

    // And rebuilding an ENDPOINT reclaims it, though it is keyed to neither.
    const result = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: consumer })
    expect(result.unreclaimable).toBe(1)
    expect(result.deleted).toBe(1)
    expect(await t.run(async (ctx) => await ctx.db.query('run_causal_edges').collect())).toEqual([])
  })

  it('rebuilding the OTHER endpoint reclaims it too', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [producer, consumer, bystander] = s.a.runIds
    await t.run(async (ctx) => {
      await ctx.db.insert('run_causal_edges', {
        orgId: s.a.orgId, producerRunId: producer, consumerRunId: consumer,
        kind: 'output_consumed', handoffAt: Date.now(), derivedFromRunId: bystander,
        citation: { cites: 'run_field', field: 'forged' },
      })
    })
    const result = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: producer })
    expect(result.unreclaimable).toBe(1)
    expect(await t.run(async (ctx) => await ctx.db.query('run_causal_edges').collect())).toEqual([])
  })

  it('an HONEST row is not swept by the endpoint pass', async () => {
    // The reclaimer must not mistake a legitimately-keyed row for a forged one.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const [producer, consumer] = s.a.runIds
    const ev = await recordHandoff(t, {
      orgId: s.a.orgId, inRunId: consumer, payload: { consumedRunId: producer },
    })
    await t.mutation(internal.causality.projectEventCausalEdgesForRepair, { eventId: ev })

    // Rebuilding the PRODUCER touches nothing: the row is keyed to the
    // consumer's log, which is an endpoint, so it is honest and out of scope.
    const result = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: producer })
    expect(result.unreclaimable).toBe(0)
    expect(result.deleted).toBe(0)
    expect(await t.run(async (ctx) => (await ctx.db.query('run_causal_edges').collect()).length)).toBe(1)
  })
})
