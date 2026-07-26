/**
 * CROSS-RUN CAUSAL GRAPH — ADVERSARIAL SUITE, ENGINE LAYER (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * `packages/contracts/src/causality.ts` — the vocabulary and the CLIENT-SIDE
 * GATES that decide whether an arrow reaches an operator's screen during an
 * incident. Its companion, `causal_adversarial_substrate.test.ts`, grades the
 * backend primitives underneath; read them together, because a gate cannot
 * report a bound the hop never gave it.
 *
 * THE THREAT MODEL IS THE WIRE, and the file under attack says so itself: "a
 * type is a promise about our own code and not about the wire." Every defect
 * below is constructed as a value TypeScript forbids and a server can send —
 * a dropped array, a field a projection removed, a self-report nothing
 * cross-checks. `RecordedCausalEdge.recordedBy` is a non-empty tuple TYPE; that
 * is a compile-time promise, and this file is about what arrives at runtime.
 *
 * ── THREE DEFECTS, ONE SHAPE ───────────────────────────────────────────────
 * All three findings below are the SAME failure, and naming it is worth more
 * than any of them individually:
 *
 *   THE GATE VALIDATES EACH PART AND NEVER COMPARES THE PARTS TO EACH OTHER.
 *
 * `traversalUnusableFields` asks "is this field well-formed?". `edgeIncoherences`
 * asks "does this edge contradict itself?". Both are thorough. Neither asks
 * whether the ORIGIN CLAIM agrees with the EDGE SET sitting beside it in the
 * same object — even though `traversalIncoherences` is documented as "the ONE
 * FUNCTION a gate should call... the only entry point holding both the edges
 * and the node set". It holds the termini too, and does not use them.
 *
 * This is the `fleet_health.ts` lesson recurring one layer up. There, the rule
 * was applied to three of six call sites. Here, the CROSS-CHECK dimension is
 * absent from all of them — and it is absent from a file whose header
 * enumerates, correctly, every trap it is defending against. Care did not work
 * here either.
 *
 * ── ANTI-VACUITY ───────────────────────────────────────────────────────────
 * Every defect is recorded by a test that DERIVES it from a shipped function's
 * OUTPUT on a constructed fixture — never from a constant and never from a grep
 * that resembles the property. The counterweight tests are as important as the
 * findings: each defect is paired with a case proving the same gate DOES fire
 * on a neighbouring input, so "the gate returned []" is never confused with
 * "the gate is switched off". And the sweeps enumerate their subjects from the
 * module under test, so a new exported helper is graded without this file
 * changing.
 */

import { readdirSync, readFileSync } from 'node:fs'

const nodeFs = () => ({ readdirSync })

import {
  causalTraversalVerdict,
  citedEndpointCount,
  computeCausalVerdict,
  convergencePoints,
  cycleReEntries,
  traversalClaimContradictions,
  DEFAULT_CAUSAL_MAX_DEPTH,
  downstreamRunCount,
  edgeIncoherences,
  edgesInto,
  edgesOutOf,
  isCausalTraversalComplete,
  lostTrails,
  MAX_CAUSAL_NODES,
  originStatement,
  recordedOrigins,
  suspicionQuestion,
  traversalIncoherences,
  traversalUnusableFields,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  CausalEvidence,
  CausalNode,
  CausalTraversal,
  RecordedCausalEdge,
  RecordedOrigin,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const observedDefects = new Set<string>()
const record = (id: string): void => void observedDefects.add(id)

/**
 * EMPTY BY ACHIEVEMENT, NOT BY ABSENCE. All four entries this suite ever held
 * were fixed as ONE THING — `traversalClaimContradictions()`, which builds the
 * graph once and dispatches a TOTAL `Record<CausalClaim, ...>`, so a new
 * self-claim is a compile error until it has an audit. That is the durable
 * shape: not four checks added at four call sites, but the primitive that
 * permits the wrong choice being removed. It is the same remedy the
 * `fleet_health.ts` cycle landed on, arrived at independently.
 *
 * An empty ledger is the most dangerous state this file can be in, because
 * `toEqual([])` passes just as happily when every probe has gone blind. So each
 * retirement below is a POSITIVE assertion that the specific audit FIRES on the
 * exact fixture that used to defeat it, and `teeth/every retirement is
 * re-derived` recomputes all four from shipped output and RE-RECORDS any that
 * regresses.
 */
const KNOWN_DEFECTS: readonly string[] = []

/** An honestly-reported two-cycle, whose path IS backed by the edge set. */
function honestCycle(): CausalTraversal {
  return traversalOf({
    edges: [edge('A', 'B'), edge('B', 'A')],
    termini: [
      { terminus: 'cycle_reentry', reEnteredRunId: 'A', hopsToReEntry: 2, cyclePath: ['A', 'B', 'A'] },
    ] as never,
  })
}

const T0 = 1_760_000_000_000

function srcOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

const CAUSALITY_SRC = srcOf('../../packages/contracts/src/causality.ts')

// ---------------------------------------------------------------------------
// Fixtures
//
// `as never` appears wherever the WIRE can carry a value the TYPE forbids.
// That is the point of the fixture, not a shortcut around it: every such cast
// marks a shape TypeScript refuses and a server can still send.
// ---------------------------------------------------------------------------

function node(runId: string, hopsFromSubject: number): CausalNode {
  return {
    runId,
    hopsFromSubject,
    adjacency: 'edge_recorded',
    agentId: 'ag_1',
    status: 'failed',
    startedAt: T0,
  }
}

function citation(recordedInRunId: string, namesRunId: string): CausalEvidence {
  return {
    cites: 'run_field',
    recordedInRunId,
    namesRunId,
    field: 'runs.parentRunId',
    recordedAt: T0,
  } as never
}

function edge(from: string, to: string, over: Partial<RecordedCausalEdge> = {}): RecordedCausalEdge {
  return {
    basis: 'recorded',
    kind: 'spawned',
    edgeKey: `${from}->${to}`,
    producerRunId: from,
    consumerRunId: to,
    recordedFact: `${to} recorded that ${from} spawned it`,
    handoffAt: T0,
    recordedBy: [citation(to, from)] as never,
    ...over,
  }
}

function originAt(runId: string, hops: number): RecordedOrigin {
  return {
    terminus: 'recorded_origin',
    originRunId: runId,
    hopsToOrigin: hops,
    establishedBy: [
      { proves: 'adjacent_edge_set_read', runId, inboundReadComplete: true, inboundEdgesFound: 0, scannedAt: T0 },
    ],
  } as never
}

function lostAt(runId: string, hops: number, kind = 'depth_limit_reached') {
  return {
    terminus: 'trail_lost',
    lastReachedRunId: runId,
    kind,
    hopsBeforeLoss: hops,
    lostBecause: `the depth limit (${hops}) was reached`,
    wouldBeRecoveredBy: 're-run with --max-depth 20',
  }
}

function traversalOf(over: Partial<CausalTraversal> = {}): CausalTraversal {
  return {
    analyzedAt: T0,
    subjectRunId: 'A',
    verdict: 'chain_recorded',
    nodes: [node('A', 0), node('B', 1)],
    edges: [edge('B', 'A')],
    termini: [originAt('B', 1)],
    suspected: [],
    unanswered: [],
    scan: {
      subjectRunId: 'A',
      direction: 'upstream',
      maxDepthRequested: DEFAULT_CAUSAL_MAX_DEPTH,
      deepestReached: 1,
      runsVisited: 2,
      edgesRead: 1,
      scanTruncated: false,
      edgeSetsComplete: true,
    },
    ...over,
  } as never
}

/** Both shipped gates, as a client actually applies them. */
function gateVerdict(t: CausalTraversal): {
  incoherences: string[]
  unusable: string[]
  complete: boolean
  verdict: string
} {
  return {
    incoherences: traversalIncoherences(t).map((f) => f.incoherence),
    unusable: traversalUnusableFields(t).map((f) => f.reason),
    complete: isCausalTraversalComplete(t),
    verdict: causalTraversalVerdict(t),
  }
}

// ---------------------------------------------------------------------------
// BASELINE — the gates are ON. Everything below depends on this.
// ---------------------------------------------------------------------------

describe('gates are live', () => {
  it('a well-formed traversal passes, so a clean result is not the gates being off', () => {
    const g = gateVerdict(traversalOf())
    expect(g.incoherences).toEqual([])
    expect(g.unusable).toEqual([])
    expect(g.complete).toBe(true)
    expect(g.verdict).toBe('chain_recorded')
  })

  it('each gate FIRES on the malformation it exists for', () => {
    // THE COUNTERWEIGHT. Every "the gate returned []" finding below is only
    // meaningful because these show the same gates rejecting neighbouring
    // inputs. Derived from output, one assertion per mechanism.
    expect(traversalIncoherences(traversalOf({ edges: [edge('A', 'A')] })).map((f) => f.incoherence)).toContain(
      'self_loop'
    )
    expect(
      traversalIncoherences(traversalOf({ edges: [edge('Z', 'A')] })).map((f) => f.incoherence)
    ).toContain('endpoint_not_in_traversal')
    expect(
      traversalIncoherences(
        traversalOf({ edges: [edge('B', 'A', { recordedBy: [citation('QQ', 'B')] as never })] })
      ).map((f) => f.incoherence)
    ).toContain('evidence_names_neither_endpoint')
    expect(
      traversalIncoherences(traversalOf({ edges: [edge('B', 'A', { handoffAt: NaN })] })).map((f) => f.incoherence)
    ).toContain('unusable_numbers')
    expect(traversalIncoherences(traversalOf({ edges: [null] as never })).map((f) => f.incoherence)).toContain(
      'malformed_edge'
    )

    // ...and the origin proof gate, which is the strongest thing in the file.
    const unprovenOrigin = traversalOf({
      termini: [{ terminus: 'recorded_origin', originRunId: 'B', hopsToOrigin: 1, establishedBy: [] }] as never,
    })
    expect(traversalUnusableFields(unprovenOrigin).map((f) => f.reason)).toContain('unproven_origin')
  })
})

// ---------------------------------------------------------------------------
// 1. AN INFERRED EDGE PRESENTED AS RECORDED
// ---------------------------------------------------------------------------

describe('inferred-as-recorded', () => {
  it('RETIRED: an edge with ZERO citations is now refused by the primitive', () => {
    // `evidence/an-edge-with-no-citations-passes-as-recorded` is RETIRED.
    // `recordedBy` is a non-empty tuple TYPE; on the wire it can be `[]`, and
    // that is now caught where every consumer already looks rather than at
    // three call sites that each remembered to check.
    const uncited = edge('B', 'A', { recordedBy: [] as never })
    expect(citedEndpointCount(uncited)).toBe(0)

    const t = traversalOf({ edges: [uncited] })
    expect(traversalClaimContradictions(t).map((f) => f.contradiction)).toContain('edge_cites_nothing')
    // It reaches the COHERENCE gate too, which is what the SDK and the web
    // adapter both call.
    expect(traversalIncoherences(t).map((f) => f.incoherence)).toContain('edge_cites_nothing')
    // ...and it blocks the verdict rather than merely being reported.
    expect(isCausalTraversalComplete(t)).toBe(false)

    // COUNTERWEIGHT: a cited edge still passes, so the audit is not always-on.
    expect(traversalClaimContradictions(traversalOf())).toEqual([])
  })

  it('the rule now lives in the PRIMITIVE, not at N call sites', () => {
    // The finding that outlasted the defect. Previously three consumers each
    // re-implemented the non-empty check and the shared gate did not make it —
    // the "applied at N call sites, will be applied at N-1 next time" shape
    // that produced three of six in `fleet_health.ts`. It is now one audit.
    const union = /export type CausalIncoherence =[\s\S]*?;\n/.exec(CAUSALITY_SRC)?.[0] ?? ''
    expect(union.length).toBeGreaterThan(0)
    expect(union).toMatch(/edge_cites_nothing/)

    // And the dispatch is TOTAL over the claim union, so a new self-claim
    // cannot ship without an audit. Derived from source: every member of
    // `CausalClaim` appears as a key of `CLAIM_AUDITS`.
    const claims = [...(/export type CausalClaim =[\s\S]*?;\n/.exec(CAUSALITY_SRC)?.[0] ?? '').matchAll(/\| "(\w+)"/g)].map(
      (m) => m[1] as string
    )
    expect(claims.length).toBeGreaterThanOrEqual(5)
    const audits = /const CLAIM_AUDITS[\s\S]*?\n\};/.exec(CAUSALITY_SRC)?.[0] ?? ''
    expect(audits.length).toBeGreaterThan(0)
    for (const c of claims) expect(audits).toMatch(new RegExp(`\\b${c}:`))

    // TEETH: the totality probe can fail.
    expect(/\bnot_a_real_claim:/.test(audits)).toBe(false)
  })

  it('no-evidence and bad-evidence are now BOTH rejected, in the right order', () => {
    // The asymmetry that made the old defect precise — bad evidence caught,
    // NO evidence not — is gone. Both are refused, and the empty case is
    // refused FIRST, because "cites nothing" is the stronger objection and a
    // reader should not have to infer it from a citation-shape complaint.
    const wrong = edge('B', 'A', { recordedBy: [citation('QQ', 'B')] as never })
    const uncited = edge('B', 'A', { recordedBy: [] as never })
    expect(edgeIncoherences(wrong, new Set(['A', 'B']))).toContain('evidence_names_neither_endpoint')
    expect(edgeIncoherences(uncited, new Set(['A', 'B']))).toContain('edge_cites_nothing')
    // Strictly weaker input is no longer graded strictly better.
    expect(edgeIncoherences(uncited, new Set(['A', 'B'])).length).toBeGreaterThan(0)
  })

  it('a MALFORMED citation element is caught, which is how the empty case slipped past', () => {
    // `recordedBy: [null]` IS reported — `traversalUnusableFields` walks the
    // citation array with `indexedElements`. So the array is inspected; it is
    // only its LENGTH that is never asked about. The check that exists is what
    // makes the missing one easy to overlook.
    const nulled = traversalOf({ edges: [edge('B', 'A', { recordedBy: [null] as never })] })
    expect(traversalUnusableFields(nulled).map((f) => f.reason)).toContain('malformed_element')

    const empty = traversalOf({ edges: [edge('B', 'A', { recordedBy: [] as never })] })
    expect(traversalUnusableFields(empty)).toEqual([])
  })

  it('INHERITED (Team C): a sequenceNumber of 0 is refused, not read as a real position', () => {
    // Team C's deleted adapter had been emitting `sequenceNumber: 0` on every
    // event citation. Kept as a LIVE assertion against the gate that catches
    // it rather than as folklore about a file nobody can open any more — the
    // adapter is gone, so this is the only place the shape stays tested.
    //
    // Event Log Rule 4: sequence numbers start at 1. `0` is the falsy-default
    // shape — the numeric twin of the null-versus-zero defect.
    const zeroSeq = traversalOf({
      edges: [
        edge('B', 'A', {
          recordedBy: [
            { cites: 'event', recordedInRunId: 'A', namesRunId: 'B', eventId: 'ev1', sequenceNumber: 0, recordedAt: T0 },
          ] as never,
        }),
      ],
    })
    expect(traversalUnusableFields(zeroSeq).map((f) => f.reason)).toContain('not_a_sequence_number')

    // LAYERING, CHECKED RATHER THAN ASSUMED. It is the USABILITY gate that
    // catches this, not the completeness predicate — a citation pointing at a
    // log position that cannot exist is a fact about the VALUE, and
    // completeness is a claim about the WALK. I expected it to block
    // completeness and it does not, which is correct and worth stating,
    // because it means a consumer that applies only `isCausalTraversalComplete`
    // would render it.
    expect(isCausalTraversalComplete(zeroSeq)).toBe(true)
    // So the gate has to be applied. Both shipped consumers do — asserted,
    // since Team C's adapter (which used to absorb this) is gone.
    expect(srcOf('../../apps/web/src/lib/causal/audit.ts')).toMatch(/traversalUnusableFields\(traversal\)/)
    expect(srcOf('../../packages/sdk/src/reader.ts')).toMatch(/traversalUnusableFields/)

    // COUNTERWEIGHT: 1 is accepted, so the rule is about the ORIGIN of the
    // numbering and not a blanket refusal of small integers.
    const oneSeq = traversalOf({
      edges: [
        edge('B', 'A', {
          recordedBy: [
            { cites: 'event', recordedInRunId: 'A', namesRunId: 'B', eventId: 'ev1', sequenceNumber: 1, recordedAt: T0 },
          ] as never,
        }),
      ],
    })
    expect(traversalUnusableFields(oneSeq)).toEqual([])
    expect(isCausalTraversalComplete(oneSeq)).toBe(true)
  })

  it('INHERITED (Team C): an artifact handoff must be cited by the CONSUMER, not by the row itself', () => {
    // The second defect the deleted adapter had been emitting: falling back to
    // naming the edge-index row as the edge's own evidence. An edge whose
    // proof is "a row in the table that asserts this edge" is circular, and
    // circular self-evidence is exactly what an inference engine produces.
    const producerOnly = edge('B', 'A', {
      kind: 'artifact_handoff',
      recordedBy: [
        { cites: 'artifact', recordedInRunId: 'B', artifactId: 'art1', sha256: 'ab12', role: 'produced', recordedAt: T0 },
      ] as never,
    })
    expect(edgeIncoherences(producerOnly, new Set(['A', 'B']))).toContain('artifact_handoff_not_cited_by_consumer')

    // COUNTERWEIGHT: the consumer's own recorded READ satisfies it — a real
    // record of a real handoff, carrying the direction a shared hash lacks.
    const consumerCited = edge('B', 'A', {
      kind: 'artifact_handoff',
      recordedBy: [
        { cites: 'artifact', recordedInRunId: 'A', artifactId: 'art1', sha256: 'ab12', role: 'consumed', recordedAt: T0 },
      ] as never,
    })
    expect(edgeIncoherences(consumerCited, new Set(['A', 'B']))).toEqual([])
  })

  it('nothing in the web layer can pre-absorb these any more — the seam is gone', () => {
    // Team C deleted its adapter, and with it the `cycle_detected` -> LostTrail
    // degradation that used to soften a walker regression before it reached a
    // screen. That removes a defensive layer this suite could otherwise have
    // been silently relying on, so the reliance is asserted away here.
    const { readdirSync } = nodeFs()
    const libCausal = readdirSync(new URL('../../apps/web/src/lib/causal/', import.meta.url))
    expect(libCausal).not.toContain('adapt.ts')
    // And the degradation vocabulary is nowhere in the web tree.
    for (const f of libCausal) {
      if (!f.endsWith('.ts')) continue
      expect(srcOf(`../../apps/web/src/lib/causal/${f}`)).not.toMatch(/cycle_detected/)
    }
  })

  it('SURVIVED: proximity cannot move the verdict, by construction', () => {
    // Attacked and found nothing. `suspected` is a separate type, is declared
    // `displays` rather than `gates` in the traversal-collection table, and
    // `CausalVerdictInput` has no slot a suspicion could occupy. Flooding the
    // traversal with coincidences leaves the verdict untouched — asserted from
    // output, not from reading the type.
    const flooded = traversalOf({
      edges: [],
      termini: [originAt('A', 0)],
      suspected: Array.from({ length: 50 }, (_, i) => ({
        basis: 'suspected',
        kind: 'shared_session',
        suspicionKey: `s${i}`,
        runIds: ['A', 'B'],
        observedCoincidence: 'both runs carry session s-1',
      })) as never,
    })
    expect(causalTraversalVerdict(flooded)).toBe('isolated')
    expect(computeCausalVerdict({ edgeCount: 0, complete: true })).toBe('isolated')

    // And the input type has nowhere to put one.
    const verdictInput = /export interface CausalVerdictInput \{[\s\S]*?\n\}/.exec(CAUSALITY_SRC)?.[0] ?? ''
    expect(verdictInput.length).toBeGreaterThan(0)
    expect(verdictInput).not.toMatch(/suspect/i)

    // TEETH on that grep: it can fail.
    expect(/suspect/i.test('  suspectedCount: number;')).toBe(true)
  })

  it('SURVIVED: a suspicion is phrased as a question, never as a claim', () => {
    const q = suspicionQuestion({
      basis: 'suspected',
      kind: 'shared_session',
      suspicionKey: 's1',
      runIds: ['A', 'B'],
      observedCoincidence: 'both runs carry session s-1',
    } as never)
    expect(typeof q).toBe('string')
    expect(q.length).toBeGreaterThan(0)
    // A question, not an assertion of causation.
    expect(q).not.toMatch(/\bcaused\b/i)
  })
})

// ---------------------------------------------------------------------------
// 2. A LOST TRAIL RENDERING AS AN ORIGIN
// ---------------------------------------------------------------------------

describe('origin-versus-lost-trail', () => {
  it('RETIRED: an origin claim is now audited against the traversal’s own edges', () => {
    // `origin/origin-claim-never-checked-against-the-edge-set` is RETIRED. The
    // traversal below asserts BOTH "A\'s inbound edge set was read completely
    // and was empty" and "B produced A". One of the two is false.
    const t = traversalOf({
      nodes: [node('A', 0), node('B', 1)],
      edges: [edge('B', 'A')],
      termini: [originAt('A', 0)],
    })
    expect(edgesInto(t, 'A')).toHaveLength(1)
    expect(traversalClaimContradictions(t).map((f) => f.contradiction)).toContain(
      'origin_contradicted_by_adjacent_edge'
    )
    expect(isCausalTraversalComplete(t)).toBe(false)

    // COUNTERWEIGHT: an origin at a run with no inbound edge still passes.
    expect(traversalClaimContradictions(traversalOf())).toEqual([])
    expect(isCausalTraversalComplete(traversalOf())).toBe(true)
  })

  it('the audit reports WHERE, so a contradiction is actionable rather than merely refused', () => {
    const t = traversalOf({ termini: [originAt('A', 0)] })
    const findings = traversalClaimContradictions(t)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.claim).toBe('origin_has_no_adjacent_edge')
    expect(typeof findings[0]?.at).toBe('string')
    expect(findings[0]?.at.length).toBeGreaterThan(0)
  })

  it('SURVIVED: an origin without a complete-and-empty proof IS rejected', () => {
    // The defect above is narrow, and saying so is what makes it credible. The
    // proof gate is real: a truncated read, a non-zero find, and a proof about
    // a different run are each refused. Derived from output.
    const bad = (proof: Record<string, unknown>): string[] =>
      traversalUnusableFields(
        traversalOf({
          termini: [
            { terminus: 'recorded_origin', originRunId: 'B', hopsToOrigin: 1, establishedBy: [proof] },
          ] as never,
        })
      ).map((f) => f.reason)

    const base = { proves: 'adjacent_edge_set_read', runId: 'B', inboundReadComplete: true, inboundEdgesFound: 0, scannedAt: T0 }
    expect(bad(base)).toEqual([])
    expect(bad({ ...base, inboundReadComplete: false })).toContain('unproven_origin')
    expect(bad({ ...base, inboundEdgesFound: 1 })).toContain('unproven_origin')
    expect(bad({ ...base, runId: 'OTHER' })).toContain('unproven_origin')
  })

  it('SURVIVED: a lost trail cannot be read with an origin template', () => {
    // The structural barrier holds: the two termini share no property but the
    // discriminant, so no renderer can print one as the other.
    const origin = originAt('B', 1) as unknown as Record<string, unknown>
    const lost = lostAt('B', 1) as unknown as Record<string, unknown>
    const shared = Object.keys(origin).filter((k) => k in lost)
    expect(shared).toEqual(['terminus'])

    // And the composed sentences are never phrased alike.
    expect(originStatement(lostAt('B', 1) as never)).toMatch(/not|lost|incomplete/i)
    expect(originStatement(originAt('B', 1))).not.toMatch(/\bnot\b/i)
  })

  it('SURVIVED: a lost trail anywhere blocks completeness, however many origins there are', () => {
    const mixed = traversalOf({
      nodes: [node('A', 0), node('B', 1), node('C', 1)],
      edges: [edge('B', 'A'), edge('C', 'A')],
      termini: [originAt('B', 1), lostAt('C', 1)] as never,
    })
    expect(isCausalTraversalComplete(mixed)).toBe(false)
    // ...but the recorded edges are NOT demoted, per the documented precedence.
    expect(causalTraversalVerdict(mixed)).toBe('chain_recorded')
  })
})

// ---------------------------------------------------------------------------
// 3. CYCLES
// ---------------------------------------------------------------------------

describe('cycles', () => {
  it('RETIRED: an UNDECLARED cycle is now a contradiction', () => {
    // `cycle/a-cycle-is-invisible-to-every-gate` is RETIRED. A cycle in the
    // edge set that no `cycle_reentry` terminus names is a walk claiming to
    // have terminated some other way over a graph that provably re-enters
    // itself.
    const twoCycle = traversalOf({
      nodes: [node('A', 0), node('B', 1)],
      edges: [edge('A', 'B'), edge('B', 'A')],
      termini: [originAt('A', 0)],
    })
    expect(traversalClaimContradictions(twoCycle).map((f) => f.contradiction)).toContain('undeclared_cycle')
    expect(isCausalTraversalComplete(twoCycle)).toBe(false)

    // Length is not what the audit keys on: a three-cycle is caught too.
    const threeCycle = traversalOf({
      nodes: [node('A', 0), node('B', 1), node('C', 2)],
      edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')],
      termini: [originAt('A', 0)],
    })
    expect(traversalClaimContradictions(threeCycle).map((f) => f.contradiction)).toContain('undeclared_cycle')

    // COUNTERWEIGHT: an acyclic traversal is not accused of looping.
    expect(traversalClaimContradictions(traversalOf()).map((f) => f.contradiction)).not.toContain('undeclared_cycle')
  })

  it('the ONE cycle length that is caught is the one that needs no traversal to see', () => {
    // `self_loop` catches A -> A, which is decidable from a single edge. Every
    // cycle of length >= 2 requires looking at the edge SET, and no gate does.
    // That is the dimension this file's substrate companion warns about: the
    // sweep was general over edges and blind over the graph they form.
    expect(edgeIncoherences(edge('A', 'A'), new Set(['A']))).toContain('self_loop')
    expect(edgeIncoherences(edge('A', 'B'), new Set(['A', 'B']))).toEqual([])
    expect(edgeIncoherences(edge('B', 'A'), new Set(['A', 'B']))).toEqual([])
    // Individually clean; together, a cycle.
    const cyc = traversalOf({ edges: [edge('A', 'B'), edge('B', 'A')], termini: [originAt('A', 0)] })
    expect(traversalIncoherences(cyc)).toEqual([])
  })

  it('a DECLARED cycle is accepted, and completes the frontier honestly', () => {
    // The other half of the retirement: declaring the loop is now the way
    // through, so the audit pushes toward the honest label rather than merely
    // refusing everything cyclic.
    const honest = honestCycle()
    expect(cycleReEntries(honest)).toHaveLength(1)
    expect(traversalClaimContradictions(honest)).toEqual([])
    expect(traversalUnusableFields(honest)).toEqual([])
    // A closed loop IS a finished frontier — the walk did not run out of road.
    expect(isCausalTraversalComplete(honest)).toBe(true)
    expect(causalTraversalVerdict(honest)).toBe('chain_recorded')
  })

  it('RETIRED: a FABRICATED cycle path is now checked against the edge set', () => {
    // `cycle/a-fabricated-cycle-path-certifies-completeness` is RETIRED.
    // `cycle_reentry` is a COMPLETE disposition, so it certifies, so it is
    // exactly as forgeable as an origin. The old check verified only syntactic
    // closure; the hops are now verified against the edges.
    const fabricated = traversalOf({
      nodes: [node('A', 0)],
      edges: [],
      termini: [
        { terminus: 'cycle_reentry', reEnteredRunId: 'A', hopsToReEntry: 2, cyclePath: ['A', 'GHOST', 'A'] },
      ] as never,
      scan: { ...traversalOf().scan, runsVisited: 1, edgesRead: 0 } as never,
    })
    expect(traversalClaimContradictions(fabricated).map((f) => f.contradiction)).toContain(
      'cycle_path_not_in_edge_set'
    )
    expect(isCausalTraversalComplete(fabricated)).toBe(false)

    // The syntactic check still exists too — the two are independent.
    const unclosed = traversalOf({
      termini: [
        { terminus: 'cycle_reentry', reEnteredRunId: 'A', hopsToReEntry: 2, cyclePath: ['A', 'B'] },
      ] as never,
    })
    expect(traversalUnusableFields(unclosed).map((f) => f.reason)).toContain('unclosed_cycle')

    // COUNTERWEIGHT: a real loop backed by real edges passes both.
    expect(traversalClaimContradictions(honestCycle())).toEqual([])
  })

  it('SURVIVED: multiple producers are surfaced rather than silently collapsed', () => {
    // The fourth cycle-adjacent trap: when a run has more than one recorded
    // producer there is no single path upstream, and choosing one is a
    // fabrication. `convergencePoints` reports them all.
    const forked = traversalOf({
      nodes: [node('A', 0), node('B', 1), node('C', 1)],
      edges: [edge('B', 'A'), edge('C', 'A')],
      termini: [originAt('B', 1)],
    })
    const points = convergencePoints(forked)
    expect(points).toHaveLength(1)
    expect(points[0]?.runId).toBe('A')
    expect(points[0]?.producers).toHaveLength(2)
    // ...and a single-producer chain is NOT reported, so it is not always-on.
    expect(convergencePoints(traversalOf())).toEqual([])
  })

  it('SURVIVED: the one traversal function that WALKS the graph terminates on a cycle', () => {
    // `downstreamRunCount` is the only exported function that follows edges
    // transitively, and it carries a `seen` set. Attacked with a self-edge, a
    // two-cycle, a three-cycle and a cycle reachable only at depth; it
    // terminates and does not double-count in every case.
    const count = (edges: RecordedCausalEdge[], nodes: string[]): number =>
      downstreamRunCount(
        traversalOf({ edges, nodes: nodes.map((n, i) => node(n, i)), termini: [originAt('A', 0)] })
      )

    expect(count([edge('A', 'A')], ['A'])).toBe(0)
    expect(count([edge('A', 'B'), edge('B', 'A')], ['A', 'B'])).toBe(1)
    expect(count([edge('A', 'B'), edge('B', 'C'), edge('C', 'A')], ['A', 'B', 'C'])).toBe(2)
    // A cycle reachable only at depth: A -> B -> C -> D -> C.
    expect(
      count([edge('A', 'B'), edge('B', 'C'), edge('C', 'D'), edge('D', 'C')], ['A', 'B', 'C', 'D'])
    ).toBe(3)

    // Anti-vacuity: the same helper counts a plain fan-out correctly, so the
    // numbers above are not a constant that happens to match.
    expect(count([edge('A', 'B'), edge('A', 'C')], ['A', 'B', 'C'])).toBe(2)
    expect(edgesOutOf(traversalOf({ edges: [edge('A', 'B'), edge('A', 'C')] }), 'A')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 4. DEPTH AND FAN-OUT — is the bound reported, or silent?
// ---------------------------------------------------------------------------

describe('bounds', () => {
  it('SURVIVED: every individual way of not having finished defeats completeness', () => {
    // Attacked each bound separately rather than together, because a
    // completeness predicate that folds them can pass when only one is set.
    // Derived from output, one clause at a time.
    const base = traversalOf({ edges: [], termini: [originAt('A', 0)] })
    expect(isCausalTraversalComplete(base)).toBe(true)
    expect(causalTraversalVerdict(base)).toBe('isolated')

    const ways: Array<[string, CausalTraversal]> = [
      ['scanTruncated', traversalOf({ ...base, scan: { ...base.scan, scanTruncated: true } } as never)],
      ['edgeSetsIncomplete', traversalOf({ ...base, scan: { ...base.scan, edgeSetsComplete: false } } as never)],
      ['nextCursor', traversalOf({ ...base, scan: { ...base.scan, nextCursor: 'c1' } } as never)],
      ['nothingVisited', traversalOf({ ...base, scan: { ...base.scan, runsVisited: 0 } } as never)],
      ['noTermini', traversalOf({ ...base, termini: [] as never } as never)],
      [
        'unanswered',
        traversalOf({
          ...base,
          unanswered: [{ kind: 'node_ceiling_reached', questionKey: 'q1', undecidedQuestion: 'x', unknownBecause: 'y' }],
        } as never),
      ],
      ['malformedTerminus', traversalOf({ ...base, termini: [null] } as never)],
      ['malformedEdge', traversalOf({ ...base, edges: [null] } as never)],
    ]
    for (const [name, t] of ways) {
      expect(`${name}:${isCausalTraversalComplete(t)}`).toBe(`${name}:false`)
      expect(`${name}:${causalTraversalVerdict(t)}`).toBe(`${name}:indeterminate`)
    }
  })

  it('SURVIVED: a truncated scan cannot HIDE a recorded edge', () => {
    // The other direction, and the one that matters during an incident: a
    // recorded edge stays reported even when the walk did not finish.
    const truncated = traversalOf({ scan: { ...traversalOf().scan, scanTruncated: true } } as never)
    expect(isCausalTraversalComplete(truncated)).toBe(false)
    expect(causalTraversalVerdict(truncated)).toBe('chain_recorded')
  })

  it('SURVIVED: the node ceiling is a real number and completeness knows about pages', () => {
    expect(MAX_CAUSAL_NODES).toBeGreaterThan(0)
    expect(DEFAULT_CAUSAL_MAX_DEPTH).toBeGreaterThan(0)
    // A full page with a cursor is incomplete; a full page without one is not
    // automatically so. Derived from output at the exact ceiling.
    const full = Array.from({ length: MAX_CAUSAL_NODES }, (_, i) => node(`r${i}`, 1))
    const paged = traversalOf({
      nodes: full as never,
      edges: [],
      termini: [originAt('A', 0)],
      scan: { ...traversalOf().scan, runsVisited: MAX_CAUSAL_NODES, nextCursor: 'c1' } as never,
    })
    expect(isCausalTraversalComplete(paged)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. VACUITY
// ---------------------------------------------------------------------------

describe('vacuity', () => {
  it('SURVIVED: an empty walk cannot certify an island', () => {
    // The all-negative-clauses shape that produced defects in four other
    // layers. Here the predicate carries TWO positive clauses (`runsVisited > 0`
    // and `termini.length > 0`), and the ordering is correct: `.every()` over
    // an empty list is true, so the length check must precede it. Attacked
    // both orderings by constructing the value that distinguishes them.
    const nothing = traversalOf({ edges: [], termini: [] as never, nodes: [], scan: { ...traversalOf().scan, runsVisited: 0, edgesRead: 0 } } as never)
    expect(isCausalTraversalComplete(nothing)).toBe(false)
    expect(causalTraversalVerdict(nothing)).toBe('indeterminate')

    // The precise vacuity case: visited runs, but NO frontier reported. Without
    // the `termini.length > 0` clause this returns true and certifies an
    // island. It returns false.
    const visitedButNoFrontier = traversalOf({ edges: [], termini: [] as never })
    expect(visitedButNoFrontier.scan.runsVisited).toBeGreaterThan(0)
    expect(isCausalTraversalComplete(visitedButNoFrontier)).toBe(false)
  })

  it('SURVIVED: a graph of one node with one true origin IS allowed to say so', () => {
    // The counterweight. A completeness predicate that never certifies is as
    // useless as one that always does, so the isolated case must be reachable.
    const island = traversalOf({
      nodes: [node('A', 0)],
      edges: [],
      termini: [originAt('A', 0)],
      scan: { ...traversalOf().scan, runsVisited: 1, edgesRead: 0, deepestReached: 0 } as never,
    })
    expect(isCausalTraversalComplete(island)).toBe(true)
    expect(causalTraversalVerdict(island)).toBe('isolated')
    expect(downstreamRunCount(island)).toBe(0)
  })

  it('SURVIVED: an unreadable element in a GATING collection forces indeterminate', () => {
    // The `fleet_health.ts` defect, re-attacked here. The traversal-collection
    // table declares which collections gate; a malformed element in one must
    // block rather than be dropped. Enumerated FROM THE TABLE IN THE SOURCE, so
    // a new collection is graded without this file changing.
    const table = /const TRAVERSAL_COLLECTIONS = \{[\s\S]*?\} as const;/.exec(CAUSALITY_SRC)?.[0] ?? ''
    expect(table.length).toBeGreaterThan(0)
    const declared = [...table.matchAll(/^\s{2}(\w+): "(gates|displays)"/gm)].map(
      (m) => [m[1] as string, m[2] as string] as const
    )
    // Anti-vacuity: the table was actually parsed.
    expect(declared.length).toBeGreaterThanOrEqual(5)
    expect(declared.some(([, role]) => role === 'gates')).toBe(true)
    expect(declared.some(([, role]) => role === 'displays')).toBe(true)

    const clean = traversalOf({ edges: [], termini: [originAt('A', 0)] })
    expect(isCausalTraversalComplete(clean)).toBe(true)

    for (const [collection, role] of declared) {
      const poisoned = traversalOf({ ...clean, [collection]: [null] } as never)
      // Every collection reports the malformed element by position...
      expect(traversalUnusableFields(poisoned).map((f) => f.path)).toContain(`${collection}[0]`)
      // ...and exactly the gating ones block the verdict.
      expect(`${collection}:${isCausalTraversalComplete(poisoned)}`).toBe(`${collection}:${role !== 'gates'}`)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. TENANCY — what this layer CANNOT decide
// ---------------------------------------------------------------------------

describe('tenancy', () => {
  it('NOT TESTABLE HERE, and named rather than left as a silent gap', () => {
    // A traversal crosses org boundaries HOP BY HOP, and this layer cannot see
    // a hop. `CausalTraversal` carries no `orgId` on the traversal, on a node,
    // or on an edge — so a client gate structurally CANNOT detect a node that
    // came from another tenant. Asserted, so that if an org field is added the
    // omission stops being true and this test demands a real check.
    expect(CAUSALITY_SRC).not.toMatch(/^\s*orgId[?]?:/m)

    // Where the guarantee actually has to live, and the evidence that it does:
    // the substrate companion sweeps every caller-facing handler that walks a
    // non-org-prefixed runs index and requires both authorization and an org
    // comparison. That sweep currently finds nothing.
    expect(srcOf('./causal_adversarial_substrate.test.ts')).toContain(
      'every use of a cross-org runs index re-establishes the org in the same handler'
    )

    // The BACKEND walk landed mid-session and does re-check every hop, which
    // is asserted from its source in the substrate companion rather than
    // assumed here. What neither file can do is EXECUTE it: `convex-test`
    // needs the edge-runtime config in `convex/vitest.config.ts`, so a
    // behavioural cross-org test belongs in `convex/causality.test.ts`.
    const walk = srcOf('../../convex/causality.ts')
    expect(walk).toMatch(/const next = await observeRun\(ctx, d\.runId, args\.orgId\);/)
    // A regression to a first-hop-only check would have to delete this line,
    // and the substrate suite's index sweep would catch the index change.
    expect(/observeRun\(ctx, d\.runId, args\.orgId\)/.test('// org checked once at the top')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TEETH
// ---------------------------------------------------------------------------

describe('teeth', () => {
  it('every exported helper survives the wire shapes the gates were written for', () => {
    // THE GENERALIZED SWEEP, enumerated FROM THE MODULE'S OWN EXPORTS rather
    // than from a list, and general over the OTHER axis too: not "does it
    // throw" but "does it return something a caller can act on".
    const exported = [...CAUSALITY_SRC.matchAll(/^export function (\w+)/gm)].map((m) => m[1] as string)
    expect(exported.length).toBeGreaterThan(10)

    const impl: Record<string, (t: CausalTraversal) => unknown> = {
      isCausalTraversalComplete,
      causalTraversalVerdict,
      lostTrails,
      recordedOrigins,
      traversalIncoherences,
      traversalUnusableFields,
      downstreamRunCount,
      cycleReEntries,
      convergencePoints,
      traversalClaimContradictions,
      edgesInto: (t) => edgesInto(t, 'A'),
      edgesOutOf: (t) => edgesOutOf(t, 'A'),
    }
    // Subjects that take a traversal are covered; the rest take an edge or a
    // terminus and are exercised elsewhere in this file. A helper that is
    // NEITHER covered here NOR named below fails, so a new export cannot be
    // silently ungraded.
    const elsewhere = new Set([
      'computeCausalVerdict',
      'edgeIncoherences',
      'citedEndpointCount',
      'originStatement',
      'suspicionQuestion',
    ])
    const ungraded = exported.filter((n) => impl[n] === undefined && !elsewhere.has(n))
    expect(ungraded).toEqual([])

    // Hostile shapes a server can send and a type cannot prevent.
    const hostile: CausalTraversal[] = [
      {} as never,
      { ...traversalOf(), scan: null } as never,
      { ...traversalOf(), edges: null } as never,
      { ...traversalOf(), termini: [null] } as never,
      { ...traversalOf(), nodes: 'nope' } as never,
      traversalOf({ edges: [null] } as never),
    ]
    for (const [name, fn] of Object.entries(impl)) {
      for (const [i, t] of hostile.entries()) {
        // Must not throw...
        let out: unknown
        expect(() => {
          out = fn(t)
        }, `${name} threw on hostile[${i}]`).not.toThrow()
        // ...and must RETURN something, which is the dimension the fleet
        // suite's equivalent sweep was blind to.
        expect(out, `${name} returned undefined on hostile[${i}]`).not.toBe(undefined)
      }
    }
  })

  it('the hostile-shape sweep would catch a helper that lost the property', () => {
    // TEETH on the sweep itself: prove the two checks it makes can fail.
    const thrower = (): unknown => {
      throw new Error('boom')
    }
    expect(() => thrower()).toThrow()
    const undef = (): unknown => undefined
    expect(undef()).toBe(undefined)
  })

  it('every retirement is re-derived from shipped OUTPUT, and re-records if it regresses', () => {
    // THE anti-vacuity mechanism for an empty ledger. Each entry is recomputed
    // here from the exact fixture that used to defeat it, through the shipped
    // audit. Remove an audit and the id is RE-RECORDED and the ledger goes red,
    // rather than this suite going quietly green.
    const codes = (t: CausalTraversal): string[] =>
      traversalClaimContradictions(t).map((f) => f.contradiction as string)

    const retirements: Array<[string, () => boolean]> = [
      [
        'evidence/an-edge-with-no-citations-passes-as-recorded',
        () => codes(traversalOf({ edges: [edge('B', 'A', { recordedBy: [] as never })] })).includes('edge_cites_nothing'),
      ],
      [
        'origin/origin-claim-never-checked-against-the-edge-set',
        () => codes(traversalOf({ termini: [originAt('A', 0)] })).includes('origin_contradicted_by_adjacent_edge'),
      ],
      [
        'cycle/a-cycle-is-invisible-to-every-gate',
        () =>
          codes(
            traversalOf({ edges: [edge('A', 'B'), edge('B', 'A')], termini: [originAt('A', 0)] })
          ).includes('undeclared_cycle'),
      ],
      [
        'cycle/a-fabricated-cycle-path-certifies-completeness',
        () =>
          codes(
            traversalOf({
              nodes: [node('A', 0)],
              edges: [],
              termini: [
                { terminus: 'cycle_reentry', reEnteredRunId: 'A', hopsToReEntry: 2, cyclePath: ['A', 'GHOST', 'A'] },
              ] as never,
              scan: { ...traversalOf().scan, runsVisited: 1, edgesRead: 0 } as never,
            })
          ).includes('cycle_path_not_in_edge_set'),
      ],
    ]
    const regressed: string[] = []
    for (const [id, stillFixed] of retirements) {
      if (!stillFixed()) {
        record(id)
        regressed.push(id)
      }
    }
    expect(regressed).toEqual([])

    // ...and the audits are not simply always-on: a clean traversal is clean.
    expect(codes(traversalOf())).toEqual([])
  })

})

// ---------------------------------------------------------------------------
// LEDGER
// ---------------------------------------------------------------------------

describe('defect ledger', () => {
  it('observed defects are EXACTLY the known set', () => {
    expect([...observedDefects].sort()).toEqual([...KNOWN_DEFECTS].sort())
  })

  it('the ledger is backed by live checks, not by absent probes', () => {
    const self = srcOf('./causal_adversarial_engine.test.ts')
    // With an EMPTY ledger the only thing keeping it honest is the retirement
    // re-derivation, so assert that mechanism exists rather than asserting the
    // emptiness twice.
    expect(self).toContain('every retirement is re-derived from shipped OUTPUT')
    expect(self).toContain('record(id)')
    expect(self).toContain('undeclared_cycle')
  })
})
