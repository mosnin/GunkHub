// @vitest-environment edge-runtime
/**
 * CROSS-RUN CAUSAL GRAPH — ADVERSARIAL SUITE, BEHAVIOURAL LAYER (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * The real Convex query surface, driven against a real database. It exists
 * because three claims in my other two suites could only be made from source,
 * and a source read is not evidence about behaviour:
 *
 *   - that the walk reports its fan-out bound rather than truncating silently
 *   - that a dangling parent pointer surfaces as a LOST TRAIL, not a short chain
 *   - that `getIncidentGraph`'s refusal is TOTAL
 *
 * ── THE CORRECTION THIS FILE IS ─────────────────────────────────────────────
 * `causal_adversarial_substrate.test.ts` twice told the reader that behavioural
 * Convex tests were impossible from `tests/`. THAT WAS FALSE, and it was false
 * in this session's characteristic way: I read `convex/vitest.config.ts`,
 * inferred a constraint, and never ran anything. A per-file
 * `@vitest-environment edge-runtime` docblock and a relative `import.meta.glob`
 * boot the harness. Every "source-derived, not execution-verified" caveat in my
 * earlier files was a caveat I did not have to write.
 *
 * A related correction is embedded below: the substrate suite grepped the walk
 * for `fanoutTruncatedAt`, a field name from a superseded draft that never
 * shipped. That is the constant-versus-function failure in grep form — the
 * string was never the property. The bound-reporting claim now lives here,
 * where it is read off the walk's OUTPUT.
 */

import {
  causalTraversalVerdict,
  isCausalTraversalComplete,
  lostTrails,
  recordedOrigins,
  traversalClaimContradictions,
  traversalIncoherences,
  traversalUnusableFields,
} from '@agent-flight-recorder/contracts'
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

/* eslint-disable @typescript-eslint/no-explicit-any */

const observedDefects = new Set<string>()

/**
 * THE ONLY WAY A DEFECT ENTERS THIS LEDGER — restored deliberately.
 *
 * A PREVIOUS ITERATION DELETED THIS RECORDER to silence an unused-variable
 * error when the ledger emptied, and that was the wrong call in a way worth
 * recording: deleting it made the lint error disappear AND made the ledger
 * permanently vacuous, with no lint error left to flag the second problem. The
 * `toEqual` assertion at the bottom would have been trivially true forever.
 *
 * That is the same error this file hunts, committed by me, in the file that
 * hunts it: I took the disposition that made the immediate complaint go away
 * and did not check what it cost. Same shape as the evals test that asserted
 * the defect — wrong in the direction its author expected to be right, and it
 * did not look like an oversight.
 *
 * A defence that becomes unreachable should ASSERT its own unreachability.
 */
const record = (id: string): void => void observedDefects.add(id)
/**
 * EMPTY BY ACHIEVEMENT. `fanout/the-clipped-node-is-not-identifiable` is
 * RETIRED: the clipped node now reports `adjacency_unread`. The cause was
 * branch ORDER — `onwardCount > 0 ? "edge_recorded" : ...` tested "did we find
 * an edge" before "did we finish looking", so a clipped node read identically
 * to a fully-read one. `readInFull` is now tested first. The retirement below
 * is a positive assertion on the exact 69-child fixture that produced it.
 */
const KNOWN_DEFECTS: readonly string[] = []

type T = ReturnType<typeof convexTest>
const asD = (t: T) => t.withIdentity({ subject: 'user_d', org_id: 'clerk_d' })

const NOW = 1_760_000_000_000

async function seedOrg(t: T) {
  return await t.run(async (ctx: any) => {
    const orgId = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_d', name: 'D', slug: 'd', plan: 'free', createdAt: NOW, updatedAt: NOW,
    })
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_d', orgId, role: 'member', joinedAt: NOW })
    const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: NOW, updatedAt: NOW })
    const agentId = await ctx.db.insert('agents', {
      orgId, projectId, name: 'ag', slug: 'ag', createdAt: NOW, updatedAt: NOW,
    })
    return { orgId, projectId, agentId }
  })
}

async function mkRun(t: T, s: any, i: number, extra: Record<string, unknown> = {}) {
  return await t.run(async (ctx: any) =>
    ctx.db.insert('runs', {
      orgId: s.orgId, projectId: s.projectId, agentId: s.agentId, status: 'completed',
      startedAt: NOW + i * 1000, endedAt: NOW + i * 1000 + 10, metadata: {}, tags: [], ...extra,
    })
  )
}

/** Record in `inRun`'s log that it consumed `namedRun`'s output. */
async function recordConsumption(t: T, s: any, inRun: any, namedRun: any, seq = 1) {
  return await t.run(async (ctx: any) =>
    ctx.db.insert('events', {
      runId: inRun, orgId: s.orgId, type: 'agent.message',
      sequenceNumber: seq, timestamp: NOW + 500, payload: { consumedRunId: namedRun },
    })
  )
}

/** Every gate a client applies, run against a real server response. */
function gate(report: any) {
  return {
    incoherences: traversalIncoherences(report).map((f) => f.incoherence),
    contradictions: traversalClaimContradictions(report).map((f) => f.contradiction),
    unusable: traversalUnusableFields(report).map((f) => f.reason),
    complete: isCausalTraversalComplete(report),
    verdict: causalTraversalVerdict(report),
  }
}

// ---------------------------------------------------------------------------
// 1. THE COMPONENT REFUSAL — is it TOTAL?
// ---------------------------------------------------------------------------

describe('component refusal', () => {
  it('getIncidentGraph throws for EVERY input shape, including ones that would be easy', async () => {
    // Team A's reasoning is that with the origin unrepresentable for a
    // component scan, a cleanly-closed component has NEITHER inhabitant of
    // `ComponentTerminus`, so `termini` would be empty — and every alternative
    // inside its boundary is a lie. I am not accepting that; I am testing
    // whether the refusal it justifies is actually total.
    //
    // The tempting inputs are the ones where a component answer looks free: an
    // isolated run, a run that does not exist, a run in another org, a
    // two-node chain. If ANY of them returned, the refusal would be a default
    // rather than a rule.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const isolated = await mkRun(t, s, 0)
    const parent = await mkRun(t, s, 1)
    const child = await mkRun(t, s, 2, { parentRunId: parent })

    const foreign = await t.run(async (ctx: any) => {
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_x', name: 'X', slug: 'x', plan: 'free', createdAt: NOW, updatedAt: NOW,
      })
      const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: NOW, updatedAt: NOW })
      const agentId = await ctx.db.insert('agents', { orgId, projectId, name: 'a', slug: 'a', createdAt: NOW, updatedAt: NOW })
      return ctx.db.insert('runs', {
        orgId, projectId, agentId, status: 'completed', startedAt: NOW, endedAt: NOW + 1, metadata: {}, tags: [],
      })
    })

    const inputs: Array<[string, Record<string, unknown>]> = [
      ['isolated run', { runId: isolated }],
      ['run with a child', { runId: parent }],
      ['run with a parent', { runId: child }],
      ['another org’s run', { runId: foreign }],
      ['depth 1', { runId: parent, maxDepth: 1 }],
      ['depth 0 (invalid)', { runId: parent, maxDepth: 0 }],
      ['depth above the ceiling', { runId: parent, maxDepth: 9_999 }],
    ]

    const outcomes: Array<[string, string]> = []
    for (const [label, args] of inputs) {
      try {
        await asD(t).query(api.causality.getIncidentGraph, args as never)
        outcomes.push([label, 'RETURNED'])
      } catch (err) {
        outcomes.push([label, err instanceof Error && /INVALID_ARGUMENT/.test(err.message) ? 'THREW' : 'THREW_OTHER'])
      }
    }
    // TOTAL. Not "throws on the hard cases" — throws on the easy ones too,
    // which is what makes it a rule rather than a fallback.
    expect(outcomes).toEqual(inputs.map(([label]) => [label, 'THREW']))
  })

  it('the refusal is structural: the handler inspects nothing', async () => {
    // A refusal that branched on its arguments could regress into a partial
    // one. This handler takes no `ctx` and no `args` at all — asserted from
    // the shipped source, with teeth on the probe.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../convex/causality.ts', import.meta.url), 'utf8')
    const handler = /export const getIncidentGraph = query\(\{[\s\S]*?\n\}\);/.exec(src)?.[0] ?? ''
    expect(handler.length).toBeGreaterThan(0)
    expect(handler).toMatch(/handler: \(\) => \{/)
    expect(handler).toMatch(/throw afrError\(\s*"INVALID_ARGUMENT"/)
    // No conditional anywhere in the handler.
    expect(handler).not.toMatch(/\bif\s*\(/)
    expect(/handler: \(\) => \{/.test('handler: async (ctx, args) => {')).toBe(false)
  })

  it('no OTHER path can drive the walk to a component scan', async () => {
    // The refusal only means something if `component` is unreachable
    // elsewhere. Enumerated over the shipped backend rather than assumed.
    const { readFileSync, readdirSync } = await import('node:fs')
    const hits: string[] = []
    for (const dir of ['../../convex/', '../../convex/helpers/']) {
      const d = new URL(dir, import.meta.url)
      for (const f of readdirSync(d)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
        const src = readFileSync(new URL(f, d), 'utf8')
        if (/direction:\s*"component"/.test(src)) hits.push(dir + f)
      }
    }
    expect(hits).toEqual([])

    // COUNTERWEIGHT: the CONTRACT still models a component scan, and still
    // audits one that arrives over the wire — so the refusal is a property of
    // THIS server, not a hole in the vocabulary.
    const contract = readFileSync(new URL('../../packages/contracts/src/causality.ts', import.meta.url), 'utf8')
    expect(contract).toMatch(/component_origin_claimed/)
    expect(contract).toMatch(/origin_is_directional/)
  })

  it('a wire-borne component traversal claiming an origin is caught by the contract', () => {
    // Proving the counterweight above by OUTPUT rather than by grep: if some
    // other deployment did answer a component query and claimed an origin, the
    // client gate refuses it.
    const componentWithOrigin: any = {
      analyzedAt: NOW,
      subjectRunId: 'A',
      verdict: 'chain_recorded',
      nodes: [{ runId: 'A', hopsFromSubject: 0, adjacency: 'no_edge_recorded', status: 'failed', startedAt: NOW }],
      edges: [],
      termini: [
        {
          terminus: 'recorded_origin', originRunId: 'A', hopsToOrigin: 0,
          establishedBy: [{ proves: 'adjacent_edge_set_read', runId: 'A', inboundReadComplete: true, inboundEdgesFound: 0, scannedAt: NOW }],
        },
      ],
      suspected: [], unanswered: [],
      scan: {
        subjectRunId: 'A', direction: 'component', maxDepthRequested: 8, deepestReached: 0,
        runsVisited: 1, edgesRead: 0, scanTruncated: false, edgeSetsComplete: true,
      },
    }
    expect(traversalClaimContradictions(componentWithOrigin).map((f) => f.contradiction)).toContain(
      'component_origin_claimed'
    )
    expect(isCausalTraversalComplete(componentWithOrigin)).toBe(false)

    // ...and the SAME traversal in a directed scan is fine, so the audit is
    // about the direction and not about the origin being malformed.
    const directed = { ...componentWithOrigin, scan: { ...componentWithOrigin.scan, direction: 'upstream' } }
    expect(traversalClaimContradictions(directed)).toEqual([])
    expect(isCausalTraversalComplete(directed)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. TERMINI ARE NEVER EMPTY — the vacuity bug, at the real query
// ---------------------------------------------------------------------------

describe('termini non-emptiness', () => {
  it('an ORDINARY parent/child pair yields a non-empty termini on every direction', async () => {
    // The bug their `expectCoherent` used to miss: `termini` is a non-empty
    // tuple by TYPE, and an empty array satisfies `termini.every(...)` by
    // vacuity — so a walk that reported no frontiers read as "every frontier
    // reached an origin". The fixture is deliberately the most ordinary graph
    // there is, because that is what made it slip past.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const parent = await mkRun(t, s, 0)
    const child = await mkRun(t, s, 1, { parentRunId: parent })

    for (const [label, q, runId] of [
      ['origin/child', api.causality.traceRunOrigin, child],
      ['origin/parent', api.causality.traceRunOrigin, parent],
      ['impact/parent', api.causality.traceRunImpact, parent],
      ['impact/child', api.causality.traceRunImpact, child],
    ] as const) {
      const report: any = await asD(t).query(q, { runId })
      expect(`${label}:${report.termini.length > 0}`).toBe(`${label}:true`)
      expect(`${label}:${JSON.stringify(gate(report).contradictions)}`).toBe(`${label}:[]`)
      expect(`${label}:${JSON.stringify(gate(report).incoherences)}`).toBe(`${label}:[]`)
      expect(`${label}:${report.verdict}`).toBe(`${label}:${causalTraversalVerdict(report)}`)
    }
  })

  it('an ISOLATED run still reports a terminus rather than nothing', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const lonely = await mkRun(t, s, 0)

    const report: any = await asD(t).query(api.causality.traceRunOrigin, { runId: lonely })
    expect(report.termini.length).toBeGreaterThan(0)
    expect(report.edges).toEqual([])
    // A walk that visited a run and found no inbound edge, completely, is an
    // island — and is ALLOWED to say so. A completeness predicate that never
    // certifies is as useless as one that always does.
    expect(gate(report).contradictions).toEqual([])
    expect(isCausalTraversalComplete(report)).toBe(true)
    expect(causalTraversalVerdict(report)).toBe('isolated')
  })

  it('the SAME vacuity shape is swept for across their whole helper surface', async () => {
    // The coordinator's question: does this blind spot exist elsewhere in that
    // suite's helpers? Subjects are enumerated from the two shipped test files
    // rather than from memory, so a NEW helper is graded without this test
    // changing.
    const { readFileSync } = await import('node:fs')
    const files = ['../../convex/causality.test.ts', '../../convex/helpers/causal_graph.test.ts']
    const helpers: Array<[string, string]> = []
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      const hits = [...src.matchAll(/^(?:async )?function (expect\w+)\(/gm)]
      hits.forEach((m) => {
        const from = m.index as number
        const next = src.indexOf('\nfunction ', from + 1)
        const end = src.indexOf('\n}', from)
        helpers.push([`${f}:${m[1]}`, src.slice(from, (next > 0 && next < end ? next : end) + 2)])
      })
    }
    // Anti-vacuity: the sweep must have found helpers at all. An empty result
    // would pass "none of them is vacuous" trivially.
    expect(helpers.length).toBeGreaterThan(0)

    // Any helper that asserts over a COLLECTION must first assert the
    // collection is non-empty, or its `.every()`/`toEqual([])` is satisfiable
    // by emptiness.
    const vacuous = helpers
      .filter(([, body]) => /termini|edges|nodes/.test(body))
      .filter(([, body]) => !/\.length\)\.toBeGreaterThan\(0\)/.test(body))
      .map(([name]) => name)
    expect(vacuous).toEqual([])

    // TEETH: the detector fires on a helper that lost the guard.
    const stripped = 'function expectX(t) {\n  expect(t.termini.every(ok)).toBe(true)\n}'
    expect(/termini/.test(stripped) && !/\.length\)\.toBeGreaterThan\(0\)/.test(stripped)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. CYCLES THROUGH THE REAL DATABASE
// ---------------------------------------------------------------------------

describe('cycles', () => {
  it('a genuine A->B->A loop TERMINATES and is DECLARED, in both directions', async () => {
    // Without a visited set this hangs rather than fails, which is why it is
    // here. The declaration half is the part that matters to an operator: a
    // loop that terminates silently is a partial graph reported as whole.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const a = await mkRun(t, s, 0)
    const b = await mkRun(t, s, 1)
    // A consumed B, and B consumed A. A real retry/supervisor shape.
    await recordConsumption(t, s, a, b, 1)
    await recordConsumption(t, s, b, a, 1)
    // MY OWN BUG, KEPT VISIBLE: inserting an event row does not project it.
    // The first version of this test asserted on a graph with no edges and
    // "passed" its cycle assertions vacuously — the exact shape this suite
    // exists to catch, committed by me, in a test about that shape.
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: a })
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: b })

    for (const [label, q] of [
      ['origin', api.causality.traceRunOrigin],
      ['impact', api.causality.traceRunImpact],
    ] as const) {
      const report: any = await asD(t).query(q, { runId: a })
      const g = gate(report)
      // Terminated, and self-consistent.
      expect(`${label}:${JSON.stringify(g.contradictions)}`).toBe(`${label}:[]`)
      expect(`${label}:${JSON.stringify(g.incoherences)}`).toBe(`${label}:[]`)
      expect(`${label}:${JSON.stringify(g.unusable)}`).toBe(`${label}:[]`)
      // A loop exists in the edge set, so SOMETHING must declare it — the
      // `undeclared_cycle` audit above is what would fire otherwise, and its
      // absence here is therefore a positive result rather than a silence.
      expect(`${label}:${report.edges.length > 0}`).toBe(`${label}:true`)
      expect(`${label}:${report.termini.length > 0}`).toBe(`${label}:true`)
      // No frontier of a closed loop may be called an origin.
      expect(`${label}:${recordedOrigins(report).length}`).toBe(`${label}:0`)
    }
  })

  it('a SELF-loop in the log never becomes an edge at all', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const a = await mkRun(t, s, 0)
    await recordConsumption(t, s, a, a, 1)
    await t.mutation(internal.causality.rebuildRunCausalEdges, { runId: a })

    const report: any = await asD(t).query(api.causality.traceRunOrigin, { runId: a })
    expect(report.edges).toEqual([])
    expect(gate(report).contradictions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. BOUNDS, READ OFF THE OUTPUT
// ---------------------------------------------------------------------------

describe('bounds', () => {
  it('a fan-out past the walk budget is REPORTED, not silently clipped', async () => {
    // THIS IS THE ASSERTION MY SUBSTRATE SUITE USED TO MAKE WITH A GREP for a
    // field name that never shipped. Made here against output: build a parent
    // with more children than the per-node fan-out budget and read what comes
    // back.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const parent = await mkRun(t, s, 0)
    const FANOUT = 64
    for (let i = 0; i < FANOUT + 5; i++) await mkRun(t, s, i + 1, { parentRunId: parent })

    const report: any = await asD(t).query(api.causality.traceRunImpact, { runId: parent })
    const g = gate(report)
    expect(g.contradictions).toEqual([])
    expect(g.incoherences).toEqual([])

    // MY EXPECTATION WAS WRONG, AND THE CORRECTION IS THE FINDING. I expected a
    // `budget_exhausted` LOST TRAIL. A per-node fan-out clip is not reported
    // that way: it is reported by `scan.edgeSetsComplete`, and that IS honest
    // at the traversal level — it folds into completeness.
    expect(report.edges).toHaveLength(FANOUT)
    expect(report.scan.edgeSetsComplete).toBe(false)
    expect(isCausalTraversalComplete(report)).toBe(false)
    // Not "found nothing": there IS a chain, and a clipped fan-out must not
    // demote it.
    expect(causalTraversalVerdict(report)).toBe('chain_recorded')

    // RETIRED: WHICH run's edge set was clipped is now recoverable from the
    // report. `EdgeAdjacency` is three-valued precisely so "I did not finish
    // looking at this run" is distinguishable from "this run has edges", and
    // the clipped parent now carries `adjacency_unread`.
    const parentNode = report.nodes.find((n: any) => n.runId === parent)
    expect(parentNode.adjacency).toBe('adjacency_unread')

    // EXACTLY ONE node is marked unread — the one that was actually clipped —
    // so this is an identification, not a blanket pessimism that would be
    // useless in the 200-node graph the feature is read on.
    const unread = report.nodes.filter((n: any) => n.adjacency === 'adjacency_unread')
    expect(unread.map((n: any) => n.runId)).toEqual([parent])
    // ...and the 64 children that WERE read in full are not tarred with it.
    expect(report.nodes.filter((n: any) => n.adjacency === 'no_edge_recorded')).toHaveLength(FANOUT)

    // THE BRANCH-ORDER BUG, PINNED. The old code asked "did we find an edge"
    // before "did we finish looking", so a clipped node with edges read as
    // `edge_recorded`. This node has BOTH properties — outbound edges AND an
    // unfinished read — which is the exact input that distinguishes the two
    // orderings. A regression to the old order turns this red.
    expect(report.edges.filter((e: any) => e.producerRunId === parent).length).toBeGreaterThan(0)
    expect(parentNode.adjacency).not.toBe('edge_recorded')

    // COUNTERWEIGHT: a fan-out UNDER the budget completes, so the report above
    // is about the bound and not about fan-out per se.
    const small = await mkRun(t, s, 5_000)
    for (let i = 0; i < 3; i++) await mkRun(t, s, 6_000 + i, { parentRunId: small })
    const ok: any = await asD(t).query(api.causality.traceRunImpact, { runId: small })
    expect(ok.edges).toHaveLength(3)
    expect(ok.scan.edgeSetsComplete).toBe(true)
    expect(isCausalTraversalComplete(ok)).toBe(true)
    // COUNTERWEIGHT to the identification above: a fully-read parent WITH
    // edges is `edge_recorded`, so `adjacency_unread` is not simply what a
    // parent always gets now.
    expect(ok.nodes.find((n: any) => n.runId === small).adjacency).toBe('edge_recorded')
    expect(ok.nodes.filter((n: any) => n.adjacency === 'adjacency_unread')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. LOST TRAIL, NOT A SHORTER CHAIN
// ---------------------------------------------------------------------------

describe('lost trail', () => {
  it('a purged parent surfaces as a LOST TRAIL rather than an origin or a short chain', async () => {
    // This is the behavioural half of my substrate ledger's one live entry.
    // The DANGLE is real — purge deletes the run and never clears the child's
    // `parentRunId`. The question this settles is whether the dangle is
    // MISREPORTED, and it is not.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const grandparent = await mkRun(t, s, 0)
    const parent = await mkRun(t, s, 1, { parentRunId: grandparent })
    const child = await mkRun(t, s, 2, { parentRunId: parent })

    // Baseline: the full chain reaches an origin at the grandparent.
    const before: any = await asD(t).query(api.causality.traceRunOrigin, { runId: child })
    expect(gate(before).contradictions).toEqual([])
    expect(recordedOrigins(before).length).toBeGreaterThan(0)
    expect(isCausalTraversalComplete(before)).toBe(true)

    // Now purge the middle run, leaving `child.parentRunId` dangling.
    await t.run(async (ctx: any) => ctx.db.delete(parent))
    const stillDangling = await t.run(async (ctx: any) => (await ctx.db.get(child)).parentRunId)
    expect(stillDangling).toBe(parent)

    const after: any = await asD(t).query(api.causality.traceRunOrigin, { runId: child })
    const g = gate(after)
    expect(g.contradictions).toEqual([])
    expect(g.incoherences).toEqual([])
    // THE DISTINCTION THE FEATURE EXISTS FOR: not an origin, not a silently
    // shorter chain — an explicit lost trail.
    expect(recordedOrigins(after)).toEqual([])
    expect(lostTrails(after).length).toBeGreaterThan(0)
    expect(isCausalTraversalComplete(after)).toBe(false)
    // ...and it says what would recover it, rather than shrugging.
    for (const lt of lostTrails(after)) {
      expect(typeof lt.wouldBeRecoveredBy).toBe('string')
      expect(lt.wouldBeRecoveredBy.length).toBeGreaterThan(0)
      expect(lt.lostBecause.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. TENANCY, AT EVERY HOP — executed, not read
// ---------------------------------------------------------------------------

describe('tenancy', () => {
  it('a foreign run is indistinguishable from a missing one, at the entry point', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const foreign = await t.run(async (ctx: any) => {
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_x', name: 'X', slug: 'x', plan: 'free', createdAt: NOW, updatedAt: NOW,
      })
      const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: NOW, updatedAt: NOW })
      const agentId = await ctx.db.insert('agents', { orgId, projectId, name: 'a', slug: 'a', createdAt: NOW, updatedAt: NOW })
      return ctx.db.insert('runs', {
        orgId, projectId, agentId, status: 'completed', startedAt: NOW, endedAt: NOW + 1, metadata: {}, tags: [],
      })
    })
    const missing = await mkRun(t, s, 9)
    await t.run(async (ctx: any) => ctx.db.delete(missing))

    const outcome = async (runId: any): Promise<string> => {
      try {
        await asD(t).query(api.causality.traceRunOrigin, { runId })
        return 'RETURNED'
      } catch (err) {
        return `THREW:${err instanceof Error ? err.message : String(err)}`
      }
    }
    // Compared with toEqual, following convex/tenancy_oracle.test.ts: a version
    // that merely throws DIFFERENT messages for foreign vs missing still fails,
    // because the difference is itself an existence oracle.
    expect(await outcome(foreign)).toEqual(await outcome(missing))
  })

  it('a cross-org parent pointer does not leak the foreign run into the graph', async () => {
    // The hop-by-hop case: the entry point is clean and the LEAK would be at
    // the second hop, past every entry-point check.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const foreignParent = await t.run(async (ctx: any) => {
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_x', name: 'X', slug: 'x', plan: 'free', createdAt: NOW, updatedAt: NOW,
      })
      const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: NOW, updatedAt: NOW })
      const agentId = await ctx.db.insert('agents', { orgId, projectId, name: 'a', slug: 'a', createdAt: NOW, updatedAt: NOW })
      return ctx.db.insert('runs', {
        orgId, projectId, agentId, status: 'failed', startedAt: NOW, endedAt: NOW + 1, metadata: {}, tags: [],
      })
    })
    // A run in MY org stamped with the other org's run as its parent.
    const mine = await mkRun(t, s, 0, { parentRunId: foreignParent })

    const report: any = await asD(t).query(api.causality.traceRunOrigin, { runId: mine })
    const ids = report.nodes.map((n: any) => n.runId)
    expect(ids).not.toContain(foreignParent)
    expect(ids).toEqual([mine])
    // No edge may name a run the walk did not observe.
    for (const e of report.edges) {
      expect(ids).toContain(e.producerRunId)
      expect(ids).toContain(e.consumerRunId)
    }
    expect(gate(report).contradictions).toEqual([])
    // And the unreachable parent is reported as a lost trail, not an origin —
    // the same indistinguishability as a purged run, deliberately.
    expect(recordedOrigins(report)).toEqual([])
    expect(lostTrails(report).length).toBeGreaterThan(0)
  })
})

describe('teeth', () => {
  it('every retirement is re-derived from shipped BEHAVIOUR, and re-records if it regresses', async () => {
    // THE anti-vacuity mechanism for this file's empty ledger. The retirement
    // is recomputed from the EXACT fixture that produced the finding: a parent
    // whose fan-out exceeds the per-node budget, which must now be identifiable
    // as `adjacency_unread` rather than reading like a fully-scanned node.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t)
    const parent = await mkRun(t, s, 0)
    const FANOUT = 64
    for (let i = 0; i < FANOUT + 5; i++) await mkRun(t, s, i + 1, { parentRunId: parent })

    const report: any = await asD(t).query(api.causality.traceRunImpact, { runId: parent })
    const parentNode = report.nodes.find((n: any) => n.runId === parent)
    // Anti-vacuity on the probe: the clip must actually have happened, or
    // "still fixed" would be a statement about a fixture that never triggered.
    expect(report.edges).toHaveLength(FANOUT)
    expect(report.scan.edgeSetsComplete).toBe(false)

    const retirements: Array<[string, boolean]> = [
      ['fanout/the-clipped-node-is-not-identifiable', parentNode.adjacency === 'adjacency_unread'],
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

  it('the empty ledger is a CLAIM this suite makes, not a state it fell into', async () => {
    const { readFileSync } = await import('node:fs')
    const self = readFileSync(new URL('./causal_adversarial_component.test.ts', import.meta.url), 'utf8')
    expect(self).toContain('every retirement is re-derived from shipped BEHAVIOUR')
    expect(self).toContain('record(id)')
  })
})
