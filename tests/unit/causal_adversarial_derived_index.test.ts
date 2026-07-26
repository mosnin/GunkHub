// @vitest-environment edge-runtime
/**
 * CROSS-RUN CAUSAL GRAPH — ADVERSARIAL SUITE, DERIVED-INDEX LAYER (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * The one property that makes `run_causal_edges` a PROJECTION rather than a
 * second source of truth: a row that the event log does not imply must not
 * survive. If that holds, the table cannot silently become a place where facts
 * live. If it does not, every "derived index" comment in `convex/causality.ts`
 * is decoration and the substrate argument collapses.
 *
 * ── WHY THIS FILE EXISTS AT ALL, GIVEN convex/causality.test.ts (E) ────────
 * Team A's suite asserts the rebuilt row set is identical. That is the AUTHOR
 * asserting their own invariant, on fixtures they chose. This file re-derives
 * it adversarially and INDEPENDENTLY: its own seeding, its own comparison, and
 * — the part their (E) does not do — it tries to FORGE a row that survives.
 * "Rebuild reproduces what rebuild produced" is a weaker claim than "nothing
 * else can persist", and only the second one is the ruling.
 *
 * ── A CORRECTION THIS FILE EMBODIES ────────────────────────────────────────
 * My earlier two suites reported, twice, that behavioural Convex tests were
 * impossible from `tests/` because `convex-test` needs `edge-runtime` and
 * inlined deps from `convex/vitest.config.ts`. THAT WAS WRONG, and it was
 * wrong in the way this session keeps being wrong: I inferred a limit from a
 * config file instead of executing anything. A per-file
 * `@vitest-environment edge-runtime` docblock plus a relative
 * `import.meta.glob` over `../../convex/**` boots the harness fine. The
 * findings the earlier files marked "source-derived, not execution-verified"
 * were verifiable all along.
 */

import { readFileSync, readdirSync } from 'node:fs'

import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'

import { api, internal } from '../../convex/_generated/api'
import schema from '../../convex/schema'

/**
 * `import.meta.glob` is a VITE COMPILE-TIME TRANSFORM, so the call must appear
 * literally — aliasing `import.meta` to a variable typechecks but silently
 * stops the transform from firing, and the harness then boots with no modules.
 * The shared `tests/tsconfig.json` does not carry `vite/client` in its `types`,
 * and it is not mine to edit with four teams on it, so the types are pulled in
 * FILE-LOCALLY by the reference below.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface ImportMeta {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob('../../convex/**/!(*.test).ts')

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const observedDefects = new Set<string>()

/**
 * THE ONLY WAY A DEFECT ENTERS THIS LEDGER. It is deliberately kept after the
 * ledger emptied, and it is kept WITH A LIVE CALLER rather than silenced — see
 * `teeth/every retirement is re-derived` below.
 *
 * A recorder with no caller is a ledger that can only stay empty: the
 * `toEqual` assertion at the bottom would be trivially true forever, which is
 * the vacuity shape this whole suite exists to hunt. Same disposition as an
 * unreachable tripwire — a defence that becomes unreachable should ASSERT its
 * own unreachability, not be deleted for going unreached.
 */
const record = (id: string): void => void observedDefects.add(id)

/**
 * EMPTY BY ACHIEVEMENT. `reclaim/a-row-keyed-to-a-third-run-is-unreclaimable`
 * is RETIRED — reclamation now runs TWO passes, so rebuilding EITHER endpoint
 * reclaims a forged row, and `citationIsPossible()` drops such a row from the
 * walk besides. The retirement is a POSITIVE assertion that both mechanisms
 * fire on the exact fixture that defeated the old one-pass version, never
 * "nothing was recorded".
 */
const KNOWN_DEFECTS: readonly string[] = []

/* eslint-disable @typescript-eslint/no-explicit-any */

type T = ReturnType<typeof convexTest>

/** My own seeding — deliberately not Team A's, so the fixtures are independent. */
async function seed(t: T) {
  return await t.run(async (ctx: any) => {
    const now = 1_760_000_000_000
    const orgId = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_d', name: 'D', slug: 'd', plan: 'free', createdAt: now, updatedAt: now,
    })
    await ctx.db.insert('user_memberships', {
      clerkUserId: 'user_d', orgId, role: 'member', joinedAt: now,
    })
    const projectId = await ctx.db.insert('projects', {
      orgId, name: 'P', slug: 'p', createdAt: now, updatedAt: now,
    })
    const agentId = await ctx.db.insert('agents', {
      orgId, projectId, name: 'ag', slug: 'ag', createdAt: now, updatedAt: now,
    })
    const mkRun = async (i: number): Promise<any> =>
      await ctx.db.insert('runs', {
        orgId, projectId, agentId, status: 'completed',
        startedAt: now + i * 1000, endedAt: now + i * 1000 + 10,
        metadata: {}, tags: [],
      })
    // producer -> consumer, plus an UNRELATED third run used as a forgery key.
    const producer = await mkRun(0)
    const consumer = await mkRun(1)
    const bystander = await mkRun(2)
    return { now, orgId, projectId, agentId, producer, consumer, bystander }
  })
}

/** Append an event to `inRunId`'s log recording that it consumed `namedRunId`. */
async function recordConsumption(t: T, s: any, inRunId: any, namedRunId: any, seq = 1) {
  return await t.run(async (ctx: any) =>
    ctx.db.insert('events', {
      runId: inRunId, orgId: s.orgId, type: 'agent.message',
      sequenceNumber: seq, timestamp: s.now + 500,
      payload: { consumedRunId: namedRunId },
    })
  )
}

/** Every edge row in the org, normalised so `_id`/`_creationTime` cannot mask a difference. */
async function rowSet(t: T): Promise<string[]> {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db.query('run_causal_edges').collect()
    return rows
      .map((r: any) =>
        JSON.stringify({
          orgId: r.orgId, producerRunId: r.producerRunId, consumerRunId: r.consumerRunId,
          kind: r.kind, handoffAt: r.handoffAt, derivedFromRunId: r.derivedFromRunId,
          citation: r.citation,
        })
      )
      .sort()
  })
}

// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------

describe('derived-index ruling', () => {
  it('the projection produces a row from the LOG, so there is something to reclaim', async () => {
    // Anti-vacuity, and it comes first for a reason: every destruction claim
    // below is meaningless if the table is simply always empty.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await recordConsumption(t, s, s.consumer, s.producer)

    expect(await rowSet(t)).toEqual([])
    const res: any = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    expect(res.runMissing).toBe(false)
    expect(res.rebuilt).toBe(1)

    const rows = await rowSet(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('"kind":"output_consumed"')
    // The row is keyed to the log it came from — the RECORDING run.
    expect(rows[0]).toContain(`"derivedFromRunId":"${s.consumer}"`)
  })

  it('rebuild is IDEMPOTENT and byte-identical, so the log fully determines the row', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await recordConsumption(t, s, s.consumer, s.producer)

    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    const first = await rowSet(t)
    expect(first).toHaveLength(1)

    // Wipe-and-rederive twice more. Identical every time — including
    // `handoffAt`, which is taken from the event and not from `Date.now()`.
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    expect(await rowSet(t)).toEqual(first)
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    expect(await rowSet(t)).toEqual(first)
  })

  it('a HAND-WRITTEN row keyed to the recording run does NOT survive a rebuild', async () => {
    // THE RULING, tested directly. A forged row is inserted straight into the
    // table — no public mutation can do this, which is itself part of the
    // property (see the write-surface test below) — and then reclaimed.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await recordConsumption(t, s, s.consumer, s.producer)
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    const legitimate = await rowSet(t)

    await t.run(async (ctx: any) => {
      await ctx.db.insert('run_causal_edges', {
        orgId: s.orgId,
        // A completely invented handoff, in the opposite direction.
        producerRunId: s.consumer,
        consumerRunId: s.producer,
        kind: 'spawned',
        handoffAt: s.now,
        derivedFromRunId: s.consumer,
        citation: { cites: 'run_field', field: 'FORGED' },
      })
    })
    expect(await rowSet(t)).toHaveLength(2)

    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    // Destroyed, and the legitimate row is byte-identical to before.
    expect(await rowSet(t)).toEqual(legitimate)
  })

  it('RETIRED: a row keyed to a THIRD run is reclaimed by EITHER endpoint', async () => {
    // Reclamation keys on `(orgId, derivedFromRunId)` and nothing in the schema
    // enforces that it is an endpoint. The fix does not add that constraint —
    // it adds a SECOND PASS, so an operator rebuilding either run in the edge
    // reclaims the row. That is the right shape: the reclamation key no longer
    // has to be guessed from the row's meaning.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await recordConsumption(t, s, s.consumer, s.producer)
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    const legitimate = await rowSet(t)

    const forge = async (): Promise<void> => {
      await t.run(async (ctx: any) => {
        await ctx.db.insert('run_causal_edges', {
          orgId: s.orgId,
          producerRunId: s.producer,
          consumerRunId: s.consumer,
          kind: 'spawned',
          handoffAt: s.now,
          derivedFromRunId: s.bystander, // keyed to a run with nothing to do with it
          citation: { cites: 'run_field', field: 'FORGED' },
        })
      })
    }
    const forgedCount = async (): Promise<number> => (await rowSet(t)).filter((r) => r.includes('FORGED')).length

    // Rebuilding the CONSUMER reclaims it.
    await forge()
    expect(await forgedCount()).toBe(1)
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    expect(await forgedCount()).toBe(0)
    expect(await rowSet(t)).toEqual(legitimate)

    // ...and so does rebuilding the PRODUCER, independently. Either endpoint,
    // which is what "no longer has to be guessed" means.
    await forge()
    expect(await forgedCount()).toBe(1)
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.producer })
    expect(await forgedCount()).toBe(0)
  })

  it('RETIRED (belt and braces): an impossible citation is dropped by the WALK too', async () => {
    // The second half of the fix, and the more important one at incident time:
    // even before any rebuild runs, a row whose `derivedFromRunId` is neither
    // endpoint cannot have been derived from either run's log, so it is not a
    // citation at all and the traversal refuses to walk it.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await t.run(async (ctx: any) => {
      await ctx.db.insert('run_causal_edges', {
        orgId: s.orgId,
        producerRunId: s.producer,
        consumerRunId: s.consumer,
        kind: 'spawned',
        handoffAt: s.now,
        derivedFromRunId: s.bystander,
        citation: { cites: 'run_field', field: 'FORGED' },
      })
    })
    // The row IS in the table...
    expect((await rowSet(t)).filter((r) => r.includes('FORGED'))).toHaveLength(1)

    // ...and does not reach the graph.
    const report: any = await t
      .withIdentity({ subject: 'user_d', org_id: 'clerk_d' })
      .query(api.causality.traceRunOrigin, { runId: s.consumer })
    expect(report.edges).toEqual([])

    // COUNTERWEIGHT: a row keyed to a REAL endpoint does reach the graph, so
    // the drop is about the impossible citation and not about walking at all.
    await recordConsumption(t, s, s.consumer, s.producer)
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    const ok: any = await t
      .withIdentity({ subject: 'user_d', org_id: 'clerk_d' })
      .query(api.causality.traceRunOrigin, { runId: s.consumer })
    expect(ok.edges).toHaveLength(1)
  })

  it('SCOPE: the defect above needs raw table access, which no shipped surface grants', async () => {
    // Honesty about severity, which is what makes it usable. There is NO
    // mutation — public or internal — that inserts into `run_causal_edges`
    // with a caller-supplied `derivedFromRunId`. Derived from source, and the
    // subject list comes from the module rather than from memory.
    const dir = new URL('../../convex/', import.meta.url)
    const inserts: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
      const src = readFileSync(new URL(f, dir), 'utf8')
      if (src.includes('insert("run_causal_edges"')) inserts.push(f)
    }
    // Exactly one module writes the table, and it is the projection.
    expect(inserts).toEqual(['causality.ts'])

    const src = readFileSync(new URL('causality.ts', dir), 'utf8')
    // The one insert sets `derivedFromRunId` from the EVENT, never from args.
    expect(src).toMatch(/derivedFromRunId: event\.runId,/)
    expect(src).not.toMatch(/derivedFromRunId: args\./)
    // TEETH on those greps.
    expect(/derivedFromRunId: args\./.test('derivedFromRunId: args.runId,')).toBe(true)

    // So the reachable consequence is narrower than the invariant's wording: a
    // PROJECTION BUG that stamped the wrong `derivedFromRunId` would produce
    // rows no endpoint rebuild could reclaim. That is a repair-path gap, not a
    // live forgery path.
    expect(true).toBe(true)
  })

  it('a run whose log is gone reports runMissing rather than a clean zero rebuild', async () => {
    // The vacuity shape, at the reclamation layer: "deleted 0, rebuilt 0" from
    // a missing run reads exactly like a successful no-op. It does not.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await t.run(async (ctx: any) => ctx.db.delete(s.bystander))

    const res: any = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.bystander })
    expect(res.runMissing).toBe(true)
    expect(res.deleted).toBe(0)
    expect(res.rebuilt).toBe(0)

    // COUNTERWEIGHT: a live run with an empty log reports the SAME zeros and a
    // FALSE `runMissing`, so the flag is the only thing separating them.
    const live: any = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.producer })
    expect(live.runMissing).toBe(false)
    expect(live.rebuilt).toBe(0)
    expect(live.runMissing).not.toBe(res.runMissing)
  })

  it('SURVIVED: the projection refuses a cross-org run id in an event payload', async () => {
    // The tenancy question at the WRITE side, which no source read can settle.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const foreign = await t.run(async (ctx: any) => {
      const now = s.now
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_x', name: 'X', slug: 'x', plan: 'free', createdAt: now, updatedAt: now,
      })
      const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agentId = await ctx.db.insert('agents', { orgId, projectId, name: 'a', slug: 'a', createdAt: now, updatedAt: now })
      return await ctx.db.insert('runs', {
        orgId, projectId, agentId, status: 'completed',
        startedAt: now, endedAt: now + 1, metadata: {}, tags: [],
      })
    })

    // Org D's run records consuming ORG X's run. A projection that trusted the
    // payload would write a cross-org edge.
    await recordConsumption(t, s, s.consumer, foreign)
    const res: any = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    expect(res.rebuilt).toBe(0)
    expect(await rowSet(t)).toEqual([])

    // COUNTERWEIGHT: the same payload shape with a SAME-ORG id does project, so
    // the refusal is about tenancy and not about the payload being unreadable.
    await recordConsumption(t, s, s.consumer, s.producer, 2)
    const ok: any = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    expect(ok.rebuilt).toBe(1)
  })

  it('SURVIVED: a self-handoff in the log is refused', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await recordConsumption(t, s, s.consumer, s.consumer)
    const res: any = await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })
    expect(res.rebuilt).toBe(0)
    expect(await rowSet(t)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// LEDGER
// ---------------------------------------------------------------------------

describe('teeth', () => {
  it('every retirement is re-derived from shipped BEHAVIOUR, and re-records if it regresses', async () => {
    // THE anti-vacuity mechanism for an empty ledger, and the thing that gives
    // `record` a caller. The retirement is recomputed here from the EXACT
    // fixture that defeated the one-pass version — a row keyed to a bystander,
    // reclaimed by rebuilding the endpoint that did NOT record it. If the
    // second pass is removed, the id is RE-RECORDED and the ledger below goes
    // red, rather than this suite going quietly green.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await recordConsumption(t, s, s.consumer, s.producer)
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.consumer })

    await t.run(async (ctx: any) => {
      await ctx.db.insert('run_causal_edges', {
        orgId: s.orgId,
        producerRunId: s.producer,
        consumerRunId: s.consumer,
        kind: 'spawned',
        handoffAt: s.now,
        derivedFromRunId: s.bystander,
        citation: { cites: 'run_field', field: 'FORGED' },
      })
    })
    const forged = async (): Promise<number> => (await rowSet(t)).filter((r) => r.includes('FORGED')).length
    // Anti-vacuity on the probe itself: the forgery must actually be present
    // before reclamation is asked to remove it.
    expect(await forged()).toBe(1)

    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: s.producer })

    const retirements: Array<[string, boolean]> = [
      ['reclaim/a-row-keyed-to-a-third-run-is-unreclaimable', (await forged()) === 0],
    ]
    const regressed: string[] = []
    for (const [id, stillFixed] of retirements) {
      if (!stillFixed) {
        record(id)
        regressed.push(id)
      }
    }
    expect(regressed).toEqual([])
  })
})

describe('defect ledger', () => {
  it('observed defects are EXACTLY the known set', () => {
    expect([...observedDefects].sort()).toEqual([...KNOWN_DEFECTS].sort())
  })

  it('the empty ledger is a CLAIM this suite makes, not a state it fell into', () => {
    const self = readFileSync(new URL('./causal_adversarial_derived_index.test.ts', import.meta.url), 'utf8')
    expect(self).toContain('every retirement is re-derived from shipped BEHAVIOUR')
    expect(self).toContain('record(id)')
  })
})
