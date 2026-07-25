/* eslint-disable */
/**
 * CROSS-RUN CAUSAL GRAPH — pure engine verification.
 *
 * Verified against the CONTRACT's own validators (`isCausalTraversalComplete`,
 * `causalTraversalVerdict`, `traversalIncoherences`, `convergencePoints`,
 * `originStatement`), not against a local re-derivation — a mirror of a
 * certainty boundary is two definitions that can silently disagree.
 *
 * Seven properties dominate, and each maps to a section below:
 *
 *  (A) NO INFERRED EDGES ANYWHERE. Runs adjacent in time, sharing a session,
 *      and sharing an agent produce ZERO edges. The session appears only as a
 *      `SuspectedLink` — directionless, unwalkable, unable to move the verdict.
 *
 *  (B) A CYCLE TERMINATES AND IS A COMPLETE ANSWER. `CycleReEntry`, with a
 *      `cyclePath` every consecutive pair of which is a recorded edge.
 *
 *  (C) "THE CHAIN ENDED" AND "WE STOPPED" ARE DIFFERENT ANSWERS, sharing no
 *      field name, and the incomplete-read case never renders as an origin.
 *
 *  (D) LIMITS ARE REPORTED, NOT SILENT — and every unexpanded frontier NAMES
 *      the run to re-root at.
 *
 *  (E) AN UNOBSERVABLE ENDPOINT (deleted OR cross-org, indistinguishably)
 *      NEVER BECOMES A NODE OR AN EDGE.
 *
 *  (F) FAN-IN IS AN INTERIOR NODE, NOT A TERMINUS.
 *
 *  (G) THE COMPLETENESS PREDICATE IS NOT VACUOUS on an empty walk.
 */
import { describe, it, expect } from 'vitest'

import {
  causalTraversalVerdict,
  computeCausalVerdict,
  convergencePoints,
  cycleReEntries,
  edgesInto,
  isCausalTraversalComplete,
  lostTrails,
  originStatement,
  recordedOrigins,
  suspicionQuestion,
  traversalClaimContradictions,
  traversalIncoherences,
  type RunStatus,
} from '@agent-flight-recorder/contracts'

import {
  CAUSAL_MAX_DEPTH,
  CAUSAL_MIN_DEPTH,
  DEFAULT_CAUSAL_MAX_DEPTH,
  clampCausalDepth,
  foldCausalGraph,
  type CausalEdgeObservation,
  type CausalGraphInput,
  type CausalNodeObservation,
} from './causal_graph.js'

const T0 = 1_700_000_000_000

function node(runId: string, over: Partial<CausalNodeObservation> = {}): CausalNodeObservation {
  return {
    runId,
    agentId: `ag_${runId}`,
    status: 'completed' as RunStatus,
    startedAt: T0,
    expanded: true,
    onwardReadComplete: true,
    ...over,
  }
}

function edge(
  producerRunId: string,
  consumerRunId: string,
  over: Partial<CausalEdgeObservation> = {},
): CausalEdgeObservation {
  return {
    producerRunId,
    consumerRunId,
    kind: 'output_consumed',
    handoffAt: T0,
    recordedInRunId: consumerRunId,
    citation: {
      cites: 'event',
      eventId: `ev_${producerRunId}_${consumerRunId}`,
      sequenceNumber: 3,
      eventType: 'tool.call',
      namesRunId: producerRunId,
    },
    ...over,
  }
}

function input(over: Partial<CausalGraphInput> = {}): CausalGraphInput {
  return {
    analyzedAt: T0,
    subjectRunId: 'r1',
    direction: 'upstream',
    nodes: [],
    edges: [],
    frontier: [],
    maxDepthRequested: 10,
    scanTruncated: false,
    ...over,
  }
}

/** Every traversal this engine emits must satisfy the contract's own checks. */
function expectCoherent(t: ReturnType<typeof foldCausalGraph>) {
  // A WALK ALWAYS STOPS SOMEWHERE. `termini` is a non-empty tuple by type, and
  // an empty array satisfies `termini.every(...)` by vacuity — which is how a
  // traversal with no frontiers at all would read as "every frontier reached an
  // origin". Asserted here so the whole suite carries it rather than the two
  // tests that thought to check.
  expect(t.termini.length).toBeGreaterThan(0)
  expect(traversalIncoherences(t)).toEqual([])
  // EVERY SELF-CLAIM AUDITED AGAINST THE EDGE SET BESIDE IT, not in isolation.
  // A `RecordedOrigin` whose run has an adjacent edge in this same traversal, a
  // `cyclePath` naming a hop the edge set does not contain, a cycle in the edge
  // set that no terminus declares, a terminus naming a run the walk never
  // reached — all four are decidable from data already in hand, and all four are
  // exactly the kind of thing a per-element validator cannot see.
  expect(traversalClaimContradictions(t)).toEqual([])
  // The server's stated verdict must equal what its own contents imply.
  expect(t.verdict).toBe(causalTraversalVerdict(t))
}

// ===========================================================================
// (A) NO INFERRED EDGES ANYWHERE
// ===========================================================================

describe('A. a causal edge is RECORDED, never INFERRED', () => {
  it('produces zero edges for runs adjacent in time, in one session, on one agent', () => {
    // The exact configuration a temporal heuristic would link: same session,
    // same agent, back-to-back, one failed then one started.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'r_failed',
        direction: 'downstream',
        nodes: [
          node('r_failed', {
            agentId: 'ag_1',
            status: 'failed' as RunStatus,
            startedAt: T0,
            endedAt: T0 + 1000,
            sessionId: 'sess_1',
            sessionSiblingRunIds: ['r_next'],
          }),
          node('r_next', {
            agentId: 'ag_1',
            startedAt: T0 + 1100,
            sessionId: 'sess_1',
            sessionSiblingRunIds: ['r_failed'],
          }),
        ],
        edges: [], // NOTHING was recorded.
      }),
    )

    expect(t.edges).toEqual([])
    expect(t.scan.edgesRead).toBe(0)
    expectCoherent(t)
  })

  it('a shared session is a SuspectedLink — directionless, and it asks rather than asserts', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'r_failed',
        nodes: [node('r_failed', { sessionId: 'sess_1', sessionSiblingRunIds: ['a', 'b', 'c'] })],
      }),
    )

    expect(t.suspected).toHaveLength(1)
    const link = t.suspected[0]!
    expect(link.basis).toBe('suspected')
    expect(link.kind).toBe('shared_session')
    expect(link.sharedValue).toBe('sess_1')
    // STRUCTURALLY UNWALKABLE: no from/to of any name.
    expect('producerRunId' in link).toBe(false)
    expect('consumerRunId' in link).toBe(false)
    // Its sentence is COMPOSED, always interrogative, never directional.
    expect(suspicionQuestion(link)).toMatch(/\?$/)
    expect(suspicionQuestion(link)).not.toMatch(/caused/)
    expect(link.notAnEdgeBecause).toMatch(/nothing in any of their logs records/)
    expect(link.wouldBeRecordedBy).toMatch(/consumedRunId/)
    // And it cannot move the verdict.
    expect(t.edges).toEqual([])
    expect(t.verdict).toBe(
      computeCausalVerdict({ edgeCount: 0, complete: isCausalTraversalComplete(t) }),
    )
  })

  it('a MATCHING ARTIFACT DIGEST is a suspicion, never an edge — the hardest case', () => {
    // Two runs referencing the same SHA-256 share a byte sequence. That exactness
    // is what makes the inference feel like proof; it is what makes it a precise
    // coincidence, because a hash carries no direction.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'component',
        nodes: [
          node('A', { artifactChecksums: ['9c31deadbeef'] }),
          node('B', { artifactChecksums: ['9c31deadbeef'] }),
        ],
      }),
    )
    expect(t.edges).toEqual([])
    const link = t.suspected.find((l) => l.kind === 'shared_resource')!
    expect(link.sharedValue).toBe('9c31deadbeef')
    expect(link.runIds.sort()).toEqual(['A', 'B'])
    // Directionless BY TYPE, so it cannot be walked or drawn as an arrow.
    expect('producerRunId' in link).toBe(false)
    expect('consumerRunId' in link).toBe(false)
    expect(link.notAnEdgeBecause).toMatch(/NO DIRECTION/)
    // And the remedy is the contract's own answer: the CONSUMER must record it.
    expect(link.wouldBeRecordedBy).toMatch(/CONSUMING run/)
    expect(suspicionQuestion(link)).toMatch(/\?$/)
    // It cannot move the verdict.
    expect(t.verdict).toBe(causalTraversalVerdict(t))
  })

  it('a shared digest raises NO suspicion when a recorded edge already links the pair', () => {
    // A coincidence sitting beside the fact it coincides with reads as
    // corroboration of it. There is nothing to corroborate: the edge is the
    // whole claim.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'downstream',
        nodes: [
          node('A', { artifactChecksums: ['9c31'] }),
          node('B', { artifactChecksums: ['9c31'] }),
        ],
        edges: [edge('A', 'B')],
      }),
    )
    expect(t.suspected.filter((l) => l.kind === 'shared_resource')).toEqual([])
    expect(t.edges).toHaveLength(1)
    expectCoherent(t)
  })

  it('every edge carries a citation naming a log position in one of its own endpoints', () => {
    const t = foldCausalGraph(input({ nodes: [node('r1'), node('r2')], edges: [edge('r1', 'r2')] }))
    expect(t.edges).toHaveLength(1)
    const e = t.edges[0]!
    expect(e.basis).toBe('recorded')
    expect(e.recordedBy.length).toBeGreaterThan(0)
    for (const c of e.recordedBy) {
      expect([e.producerRunId, e.consumerRunId]).toContain(c.recordedInRunId)
    }
    // The fact is about a ROW, in the past tense — it does not assert causation.
    expect(e.recordedFact).toMatch(/recorded a "tool\.call" event at sequence 3/)
    expect(e.recordedFact).not.toMatch(/caused/)
    expectCoherent(t)
  })

  it('the same handoff seen from both ends is ONE edge, not two', () => {
    const t = foldCausalGraph(
      input({ nodes: [node('r1'), node('r2')], edges: [edge('r1', 'r2'), edge('r1', 'r2')] }),
    )
    expect(t.edges).toHaveLength(1)
    expect(t.edges[0]!.recordedBy).toHaveLength(1)
  })

  it('keeps BOTH citations when two different logs record the same handoff', () => {
    const t = foldCausalGraph(
      input({
        nodes: [node('r1'), node('r2')],
        edges: [
          edge('r1', 'r2', { recordedInRunId: 'r2' }),
          edge('r1', 'r2', {
            recordedInRunId: 'r1',
            citation: { cites: 'run_field', field: 'parentRunId', namesRunId: 'r1' },
          }),
        ],
      }),
    )
    expect(t.edges).toHaveLength(1)
    expect(t.edges[0]!.recordedBy.map((c) => c.recordedInRunId).sort()).toEqual(['r1', 'r2'])
    expectCoherent(t)
  })
})

// ===========================================================================
// (B) CYCLES TERMINATE AND ARE A COMPLETE ANSWER
// ===========================================================================

describe('B. a cycle terminates and is reported as CycleReEntry', () => {
  it('A <- B <- A terminates and yields a cycle_reentry terminus with its path', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'upstream',
        nodes: [node('A'), node('B')],
        edges: [edge('B', 'A'), edge('A', 'B')],
      }),
    )
    const cycles = cycleReEntries(t)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.reEnteredRunId).toBe('A')
    // Every consecutive pair of the path must be a recorded edge in this same
    // traversal — which is what makes a fabricated loop contradict its own graph.
    const path = cycles[0]!.cyclePath
    expect(path[0]).toBe('A')
    expect(path[path.length - 1]).toBe('A')
    const keys = new Set(t.edges.map((e) => `${e.consumerRunId}<-${e.producerRunId}`))
    for (let i = 0; i + 1 < path.length; i++) {
      expect(keys.has(`${path[i]}<-${path[i + 1]}`)).toBe(true)
    }
    // A cycle is NOT a lost trail: the walk read everything it meant to.
    expect(lostTrails(t)).toEqual([])
    expect(recordedOrigins(t)).toEqual([])
    expectCoherent(t)
  })

  it('a 3-cycle terminates and every run gets a finite hop count', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'upstream',
        nodes: [node('A'), node('B'), node('C')],
        edges: [edge('B', 'A'), edge('C', 'B'), edge('A', 'C')],
      }),
    )
    expect(cycleReEntries(t)).toHaveLength(1)
    expect(t.nodes.every((n) => n.hopsFromSubject >= 0)).toBe(true)
    expectCoherent(t)
  })

  it('a long acyclic chain reports no cycle and reaches a recorded origin', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `r${i}`)
    const t = foldCausalGraph(
      input({
        subjectRunId: 'r39',
        direction: 'upstream',
        nodes: ids.map((id) => node(id)),
        edges: ids.slice(0, -1).map((id, i) => edge(id, ids[i + 1]!)),
        maxDepthRequested: 64,
      }),
    )
    expect(cycleReEntries(t)).toEqual([])
    expect(recordedOrigins(t).map((o) => o.originRunId)).toEqual(['r0'])
    expectCoherent(t)
  })

  it('a dense 200-node ring terminates without recursion', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `n${i}`)
    const t = foldCausalGraph(
      input({
        subjectRunId: 'n0',
        direction: 'upstream',
        nodes: ids.map((id) => node(id)),
        edges: ids.map((id, i) => edge(ids[(i + 1) % ids.length]!, id)),
        maxDepthRequested: 512,
      }),
    )
    expect(cycleReEntries(t)).toHaveLength(1)
    expect(t.nodes).toHaveLength(200)
  })
})

// ===========================================================================
// (C) "CHAIN ENDED" vs "WE STOPPED"
// ===========================================================================

describe('C. a chain that ended and a chain we lost are different answers', () => {
  it('RecordedOrigin requires a complete read that found zero edges', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'C',
        direction: 'upstream',
        nodes: [node('A'), node('B'), node('C')],
        edges: [edge('A', 'B'), edge('B', 'C')],
      }),
    )
    const origins = recordedOrigins(t)
    expect(origins).toHaveLength(1)
    expect(origins[0]!.originRunId).toBe('A')
    expect(origins[0]!.hopsToOrigin).toBe(2)
    // The proof's two literal-typed facts.
    expect(origins[0]!.establishedBy[0]!.inboundReadComplete).toBe(true)
    expect(origins[0]!.establishedBy[0]!.inboundEdgesFound).toBe(0)
    // And the composed sentence does NOT say "root cause".
    expect(originStatement(origins[0]!)).not.toMatch(/root cause/i)
    expectCoherent(t)
  })

  it('an INCOMPLETE read at the terminus is a LostTrail, NOT an origin', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'B',
        direction: 'upstream',
        nodes: [node('A', { onwardReadComplete: false }), node('B')],
        edges: [edge('A', 'B')],
      }),
    )
    expect(recordedOrigins(t)).toEqual([])
    const lost = lostTrails(t)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.lastReachedRunId).toBe('A')
    expect(lost[0]!.kind).toBe('adjacency_unconfirmed')
    expect(isCausalTraversalComplete(t)).toBe(false)
  })

  it('the two termini share NO field name, so they cannot render the same', () => {
    const ended = recordedOrigins(
      foldCausalGraph(input({ subjectRunId: 'A', direction: 'upstream', nodes: [node('A')] })),
    )[0]!
    const lost = lostTrails(
      foldCausalGraph(
        input({
          subjectRunId: 'A',
          direction: 'upstream',
          nodes: [node('A', { onwardReadComplete: false })],
        }),
      ),
    )[0]!

    // The catastrophic renderer is `originRunId ?? lastReachedRunId`. Neither
    // object has a field the other has, so that expression cannot be written.
    expect('originRunId' in ended).toBe(true)
    expect('originRunId' in lost).toBe(false)
    expect('lastReachedRunId' in lost).toBe(true)
    expect('lastReachedRunId' in ended).toBe(false)
    expect('hopsToOrigin' in ended).toBe(true)
    expect('hopsToOrigin' in lost).toBe(false)
    // And the composed sentences are phrased differently.
    expect(originStatement(ended)).not.toEqual(originStatement(lost))
  })

  it('an externalized payload makes adjacency UNCONFIRMED, never an origin', () => {
    // Event Log Rule 3: over 10 KB the stored payload is an artifact pointer, so
    // a handoff recorded inside it is invisible to derivation.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'downstream',
        nodes: [node('A', { externalizedPayloadSeen: true })],
      }),
    )
    expect(recordedOrigins(t)).toEqual([])
    expect(lostTrails(t)[0]!.kind).toBe('adjacency_unconfirmed')
    expect(t.unanswered.map((u) => u.kind)).toContain('adjacency_unknown')
    expect(isCausalTraversalComplete(t)).toBe(false)
    expect(t.verdict).toBe('indeterminate')
  })

  it('a subject that could not be read is a LostTrail, and termini is never empty', () => {
    const t = foldCausalGraph(input({ subjectRunId: 'gone', nodes: [] }))
    expect(t.nodes).toEqual([])
    expect(t.edges).toEqual([])
    expect(t.termini.length).toBeGreaterThan(0)
    expect(lostTrails(t)[0]!.kind).toBe('edge_set_unreadable')
    expect(isCausalTraversalComplete(t)).toBe(false)
    expect(t.verdict).toBe('indeterminate')
  })

  it('a downstream leaf reaches a terminus whose sentence never claims a root cause', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'downstream',
        nodes: [node('A', { status: 'failed' as RunStatus })],
      }),
    )
    const origins = recordedOrigins(t)
    expect(origins).toHaveLength(1)
    expect(originStatement(origins[0]!)).toMatch(/recorded/i)
    expect(originStatement(origins[0]!)).not.toMatch(/root cause/i)
    // With no edges and a complete walk, the contract's own word for it:
    expect(t.verdict).toBe('isolated')
  })
})

// ===========================================================================
// (D) LIMITS ARE REPORTED, NOT SILENT
// ===========================================================================

describe('D. every bound is reported and names the run to re-root at', () => {
  it('a depth stop is a LostTrail naming the run, not an origin', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'downstream',
        nodes: [node('A'), node('B', { expanded: false, onwardReadComplete: false })],
        edges: [edge('A', 'B')],
        frontier: [{ runId: 'B', hopsFromSubject: 1, reason: 'depth_limit_reached' }],
        maxDepthRequested: 1,
      }),
    )
    const lost = lostTrails(t)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.lastReachedRunId).toBe('B')
    expect(lost[0]!.kind).toBe('depth_limit_reached')
    expect(lost[0]!.wouldBeRecoveredBy).toMatch(/maxDepth|re-root/)
    expect(recordedOrigins(t)).toEqual([])
    expect(isCausalTraversalComplete(t)).toBe(false)
    // A recorded edge still counts, even on an incomplete walk.
    expect(t.verdict).toBe('chain_recorded')
    expectCoherent(t)
  })

  it('the maxDepth parameter is ECHOED, so a dropped parameter is detectable', () => {
    const t = foldCausalGraph(input({ subjectRunId: 'A', nodes: [node('A')], maxDepthRequested: 7 }))
    expect(t.scan.maxDepthRequested).toBe(7)
  })

  it('a run the walk NEVER REACHED gets no terminus — it is named on the open question instead', () => {
    // `LostTrail.lastReachedRunId` means the last run the walk actually REACHED,
    // and the contract audits it against the node set. A terminus naming a run
    // nobody read is a frontier nobody can go and open — so the unread run is
    // reported on the completeness-bearing question, which carries run ids.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'downstream',
        nodes: [node('A')],
        edges: [],
        frontier: [{ runId: 'never_read', hopsFromSubject: 1, reason: 'budget_exhausted' }],
        scanTruncated: true,
        scanRowCeiling: 2000,
      }),
    )
    expect(lostTrails(t).map((l) => l.lastReachedRunId)).not.toContain('never_read')
    const unclosed = t.unanswered.find((u) => u.questionKey === 'component_unclosed')!
    expect(unclosed.runIds).toContain('never_read')
    expect(t.unanswered.map((u) => u.questionKey).sort()).toEqual([
      'component_unclosed',
      'scan_truncated',
    ])
    expect(isCausalTraversalComplete(t)).toBe(false)
    expect(traversalClaimContradictions(t)).toEqual([])
  })

  it('a real cycle is DECLARED even on a component walk', () => {
    // An earlier version returned no cycles for `component`, which left a
    // genuine A->B->A loop undeclared over an edge set that provably re-enters
    // itself — `cycles_are_declared` catches exactly that.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'component',
        nodes: [node('A'), node('B')],
        edges: [edge('A', 'B'), edge('B', 'A')],
      }),
    )
    expect(cycleReEntries(t)).toHaveLength(1)
    expect(traversalClaimContradictions(t)).toEqual([])
  })

  it('an ordinary parent/child pair on a component walk is NOT a cycle', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'component',
        nodes: [node('A'), node('B')],
        edges: [edge('A', 'B')],
      }),
    )
    expect(cycleReEntries(t)).toEqual([])
  })

  it('DOCUMENTS why a component scan is unrepresentable, which is why the query refuses', () => {
    // Under a `component` scan the contract counts EITHER arrow as adjacency,
    // so no run with lineage can carry a RecordedOrigin — and a fully-closed
    // component has no lost trail and no cycle either. The result is a traversal
    // with ZERO termini, which the non-empty tuple type forbids and which
    // `isCausalTraversalComplete` reads as incomplete for a trace that finished
    // perfectly. `causality:getIncidentGraph` therefore refuses rather than
    // returning this; the assertion below is the reason, kept executable so it
    // fails the day the contract makes it representable. The contract has since
    // made a component origin UNSPELLABLE in typed code (`ComponentTerminus` /
    // `TerminusFor<D>`) and audits it on the wire (`origin_is_directional`) —
    // which settles half of it. The remaining half is why the query still
    // refuses: `ComponentTerminus = CycleReEntry | LostTrail`, and a component
    // that closed cleanly has NEITHER, so there is still nothing valid to put in
    // a non-empty `termini`.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'component',
        nodes: [node('A'), node('B')],
        edges: [edge('A', 'B')],
      }),
    )
    expect(t.termini).toEqual([])
    expect(isCausalTraversalComplete(t)).toBe(false)
  })

  it('every emitted cyclePath hop is a RECORDED edge — never a fabricated loop', () => {
    // Two disjoint loops plus a run bridging them, so a greedy path-walker that
    // wandered out of the component would produce a hop the edge set lacks.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'downstream',
        nodes: [node('A'), node('B'), node('C'), node('D')],
        edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'A'), edge('C', 'D')],
      }),
    )
    const cycles = cycleReEntries(t)
    expect(cycles.length).toBeGreaterThan(0)
    const hops = new Set(t.edges.map((e) => `${e.producerRunId}->${e.consumerRunId}`))
    for (const c of cycles) {
      expect(c.cyclePath[0]).toBe(c.reEnteredRunId)
      expect(c.cyclePath[c.cyclePath.length - 1]).toBe(c.reEnteredRunId)
      for (let i = 0; i + 1 < c.cyclePath.length; i++) {
        expect(hops.has(`${c.cyclePath[i]}->${c.cyclePath[i + 1]}`)).toBe(true)
      }
    }
    expect(traversalClaimContradictions(t)).toEqual([])
  })

  it('a CLIPPED node is identifiable — adjacency_unread, not edge_recorded', () => {
    // The node has edges, so an `onwardCount > 0` test called it
    // `edge_recorded`, byte-identical to a node read in full. `edgeSetsComplete`
    // said "somewhere in this graph a node is short", which is honest and
    // unactionable; the traversal knew exactly which node.
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'downstream',
        nodes: [node('A', { onwardReadComplete: false }), node('B'), node('C')],
        edges: [edge('A', 'B'), edge('A', 'C')],
      }),
    )
    const byId = new Map(t.nodes.map((n) => [n.runId, n]))
    expect(byId.get('A')!.adjacency).toBe('adjacency_unread')
    // ...while a node read to the end WITH edges is still `edge_recorded`, so
    // the check is not a blanket downgrade.
    expect(byId.get('B')!.adjacency).toBe('no_edge_recorded')
    expect(t.scan.edgeSetsComplete).toBe(false)
  })

  it('a truncated fan-out makes edgeSetsComplete false', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'A',
        direction: 'downstream',
        nodes: [node('A', { onwardReadComplete: false }), node('B')],
        edges: [edge('A', 'B')],
      }),
    )
    expect(t.scan.edgeSetsComplete).toBe(false)
    expect(isCausalTraversalComplete(t)).toBe(false)
  })

  it('a fully-walked small graph IS complete', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'B',
        direction: 'upstream',
        nodes: [node('A'), node('B')],
        edges: [edge('A', 'B')],
      }),
    )
    expect(isCausalTraversalComplete(t)).toBe(true)
    expect(t.verdict).toBe('chain_recorded')
    expectCoherent(t)
  })

  it('clampCausalDepth bounds the caller', () => {
    expect(clampCausalDepth(undefined)).toBe(DEFAULT_CAUSAL_MAX_DEPTH)
    expect(clampCausalDepth(0)).toBe(CAUSAL_MIN_DEPTH)
    expect(clampCausalDepth(-5)).toBe(CAUSAL_MIN_DEPTH)
    expect(clampCausalDepth(9999)).toBe(CAUSAL_MAX_DEPTH)
    expect(clampCausalDepth(Number.NaN)).toBe(DEFAULT_CAUSAL_MAX_DEPTH)
    expect(clampCausalDepth(3.7)).toBe(3)
  })
})

// ===========================================================================
// (E) AN UNOBSERVABLE ENDPOINT NEVER BECOMES A NODE OR AN EDGE
// ===========================================================================

describe('E. deleted and cross-org arrive identically, and neither becomes an edge', () => {
  it('drops the edge and reports a trail lost that admits the two are indistinguishable', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'B',
        direction: 'upstream',
        nodes: [node('B')], // 'A' was NOT observed: deleted, or another org.
        edges: [edge('A', 'B')],
      }),
    )
    expect(t.edges).toEqual([])
    expect(t.nodes.map((n) => n.runId)).toEqual(['B'])
    const lost = lostTrails(t)
    expect(lost[0]!.kind).toBe('adjacent_run_unavailable')
    expect(lost[0]!.lostBecause).toMatch(/INDISTINGUISHABLE/)
    expect(lost[0]!.lostBecause).toMatch(/outside this organization/)
    expect(recordedOrigins(t)).toEqual([])
    expectCoherent(t)
  })

  it('the report is byte-identical whichever of the two it was', () => {
    const build = () =>
      foldCausalGraph(
        input({
          subjectRunId: 'B',
          direction: 'upstream',
          nodes: [node('B')],
          edges: [edge('A', 'B')],
        }),
      )
    expect(JSON.stringify(build())).toEqual(JSON.stringify(build()))
  })
})

// ===========================================================================
// (F) FAN-IN IS AN INTERIOR NODE
// ===========================================================================

describe('F. fan-in is a convergence, not a terminus', () => {
  it('a run with two recorded producers yields TWO branch termini and one convergence', () => {
    const t = foldCausalGraph(
      input({
        subjectRunId: 'C',
        direction: 'upstream',
        nodes: [node('A'), node('B'), node('C')],
        edges: [edge('A', 'C'), edge('B', 'C', { kind: 'retry_of' })],
      }),
    )
    // Each branch terminates on its own; C is interior.
    expect(
      recordedOrigins(t)
        .map((o) => o.originRunId)
        .sort(),
    ).toEqual(['A', 'B'])
    expect(
      t.termini.some((x) => (x as { lastReachedRunId?: string }).lastReachedRunId === 'C'),
    ).toBe(false)

    // The convergence is enumerable from the edge set, per the contract.
    const convergences = convergencePoints(t)
    expect(convergences).toHaveLength(1)
    expect(convergences[0]!.runId).toBe('C')
    expect(convergences[0]!.producers).toHaveLength(2)
    expect(edgesInto(t, 'C')).toHaveLength(2)
    expectCoherent(t)
  })
})

// ===========================================================================
// (G) THE COMPLETENESS PREDICATE IS NOT VACUOUS
// ===========================================================================

describe('G. no predicate is vacuously true on an empty walk', () => {
  it('isCausalTraversalComplete is FALSE when nothing was read', () => {
    const t = foldCausalGraph(input({ subjectRunId: 'nothing', nodes: [], edges: [] }))
    expect(t.scan.runsVisited).toBe(0)
    expect(t.scan.scanTruncated).toBe(false)
    expect(t.scan.nextCursor).toBeUndefined()
    // Every NEGATIVE clause is satisfied. Only the positive clauses save it.
    expect(isCausalTraversalComplete(t)).toBe(false)
    // And the verdict is therefore NOT `isolated` — no run is certified as
    // having no causal neighbours off zero reads.
    expect(t.verdict).toBe('indeterminate')
  })

  it('edgeSetsComplete is FALSE on an empty walk, without relying on a distant guard', () => {
    // `.every()` over an empty node set is `true`, so a walk that read nothing
    // reported "every edge set was read completely". Two guards elsewhere
    // contained it — the `trail_lost` terminus and `runsVisited > 0` — but
    // neither is visible from the line that computes this, and containment at a
    // distance survives only until a refactor touches one of the two.
    const t = foldCausalGraph(input({ subjectRunId: 'nothing', nodes: [], edges: [] }))
    expect(t.scan.runsVisited).toBe(0)
    expect(t.scan.edgeSetsComplete).toBe(false)
    expect(isCausalTraversalComplete(t)).toBe(false)
  })

  it('the engine uses the CONTRACT verdict function, so a server cannot disagree with itself', () => {
    for (const t of [
      foldCausalGraph(input({ subjectRunId: 'A', nodes: [node('A')] })),
      foldCausalGraph(
        input({ subjectRunId: 'A', nodes: [node('A'), node('B')], edges: [edge('B', 'A')] }),
      ),
      foldCausalGraph(input({ subjectRunId: 'gone', nodes: [] })),
    ]) {
      expect(t.verdict).toBe(causalTraversalVerdict(t))
    }
  })

  it('exports no predicate claiming the CAUSAL STRUCTURE is complete', async () => {
    // Whether the recorded edges are all the real edges is unanswerable from
    // stored data, and an export that appeared to answer it would be the most
    // dangerous thing in the module.
    const mod = await import('./causal_graph.js')
    const names = Object.keys(mod)
    expect(names).not.toContain('isCausalGraphComplete')
    expect(names.filter((n) => /^is.*Complete$/.test(n))).toEqual([])
  })
})
