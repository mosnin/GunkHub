// ---------------------------------------------------------------------------
// CROSS-RUN CAUSAL GRAPH ENGINE
//
// "What caused this run?", "What ran on this run's output?", and "what is the
// whole connected component of this incident?"
//
// PURE. Deterministic. No `ctx`, no `ctx.db`, no I/O, no `Date.now()`, no
// randomness, no unbounded recursion. Same posture as
// convex/helpers/{fleet,divergence,otel_mapping,analytics,failure_summary}.ts.
// `analyzedAt` is an INPUT for the same reason it is in helpers/divergence.ts
// and helpers/fleet.ts.
//
// The I/O half — the bounded breadth-first walk that produces the observations
// this file folds — lives in convex/causality.ts. The split is deliberate: the
// two properties most likely to be got wrong (termination on a cycle, and the
// distinction between "the chain ends here" and "we lost the trail here") are
// decided HERE, over plain arrays, and are therefore testable with literals.
//
// ===========================================================================
// PART 1 — THE CONTRACT VOCABULARY, IMPORTED (not mirrored)
// ===========================================================================
//
// Everything about certainty, termini, coverage and verdict is IMPORTED from
// `packages/contracts/src/causality.ts`, which is canonical. There is no copy
// of it here.
//
// This follows helpers/divergence.ts and helpers/fleet.ts, which made the same
// call for the same reason: `convex/package.json` depends on
// `@agent-flight-recorder/contracts`, so both the TYPES and the RUNTIME
// functions (`computeCausalVerdict`, `isCausalTraversalComplete`) resolve and
// EXECUTE inside the Convex isolate.
//
// AN EARLIER DRAFT OF THIS FILE DEFINED THE VOCABULARY LOCALLY and recorded the
// debt in a comment. That was wrong, and wrong in the most expensive possible
// way: the contract already existed, written concurrently by another team, so
// the repository briefly carried TWO `RecordedCausalEdge` types with different
// shapes. The local copy was DELETED rather than kept in sync, which is the only
// correct resolution — a mirror is two definitions of a certainty boundary that
// can silently disagree, and a drifted certainty boundary here renders a lost
// trail as an origin.
//
// THE ONE COST, STATED: `@agent-flight-recorder/contracts` resolves through
// `dist/`, a gitignored build artifact, so `convex typecheck` requires
// `packages/contracts` to be BUILT first. helpers/divergence.ts already records
// this build-ordering coupling; this file inherits it and adds nothing new.
//
// ===========================================================================
// PART 2 — THE ONE INVARIANT THIS ENGINE ENFORCES
// ===========================================================================
//
// A CAUSAL EDGE MUST BE RECORDED, NEVER INFERRED.
//
// Two runs adjacent in time are not causally linked. Two runs sharing a
// `sessionId` are not causally linked. Two runs touching the same resource are
// not causally linked. The contract makes each of those a `SuspectedLink` —
// directionless by construction (no `producerRunId`/`consumerRunId`, so it is
// unwalkable rather than merely marked do-not-walk), with a required
// `notAnEdgeBecause` and a required `wouldBeRecordedBy`.
//
// This engine implements that rather than reinterpreting it. Two rules bind the
// code below:
//
//   * A `RecordedCausalEdge` is a statement about a stored ROW, in the past
//     tense, carrying `recordedBy` citations that can be opened and checked.
//     Every citation this engine emits names an EVENT in one of the edge's own
//     two endpoints' logs, an ARTIFACT checksum, or a RUN FIELD.
//   * A `SuspectedLink` is a coincidence. It cannot be walked, cannot enter
//     `edges` (typed `RecordedCausalEdge[]`, not a union), and cannot move the
//     verdict — `computeCausalVerdict` has no parameter for it, so this engine
//     has nowhere to put one even if it wanted to.
//
// ===========================================================================
// PART 3 — THREE WAYS A FRONTIER STOPS, AND ONLY ONE MEANS "WE FAILED"
// ===========================================================================
//
// The contract's `ChainTerminus = RecordedOrigin | CycleReEntry | LostTrail`
// shares NO property except the discriminant, so the union is useless
// unnarrowed and `originRunId ?? lastReachedRunId` cannot be written. This
// engine's job is to pick the right one, and the ORDER of the checks in
// {@link classifyFrontier} is the safety property:
//
//   RecordedOrigin  requires a COMPLETE read that found ZERO edges. Both facts
//                   are literal types on `OriginProof` (`inboundReadComplete:
//                   true`, `inboundEdgesFound: 0`), so a truncated or non-empty
//                   read is UNSPELLABLE as an origin.
//   CycleReEntry    the walk closed a loop. A COMPLETE disposition, not a
//                   failure: "the chain loops a -> b -> a" tells an operator
//                   they are looking at one thing failing repeatedly and there
//                   is no earlier run to go and read.
//   LostTrail       everything else — and the common case in production.
//
// FAN-IN IS NOT A TERMINUS, and an earlier draft of this engine got that wrong
// by making it one. A convergence run is an ORDINARY INTERIOR NODE: the walk
// continues through every one of its producers and each branch terminates on its
// own, so a fan-in terminus would double-count against the branch termini
// describing the same walk. The contract exposes `convergencePoints()` as a
// query over the edge set instead. The one case that genuinely needs naming is a
// walk that STOPS at a convergence without expanding it, which is a `LostTrail`
// with kind `convergence_not_followed` — emitted below.
//
// ===========================================================================
// PART 4 — CYCLES ARE REAL, AND ARE A COMPLETE ANSWER
// ===========================================================================
//
// `runs.parentRunId` alone cannot cycle: the parent must exist when the child is
// created and the field is never mutated. But a handoff recorded in an event log
// CAN, because the event is written between two runs that both already exist —
// which is what a supervisor retry loop or a mutual hand-off produces, and those
// are ordinary agent architectures, not corruption.
//
// Termination is by a visited set on run id — every walk below is
// O(nodes + edges) and cannot revisit — and the cycle is REPORTED as a
// `CycleReEntry` carrying its `cyclePath`, never silently truncated. Silent
// truncation is the failure mode to fear: an operator not told a loop exists
// reads a 3-node graph and concludes the blast radius is 3.
//
// ===========================================================================
// PART 5 — VACUOUS TRUTH
// ===========================================================================
//
// The completeness predicate is the contract's `isCausalTraversalComplete`,
// USED AND NOT HAND-ROLLED — `complete: true` is the single input that turns "no
// edges" into `isolated`, so a locally invented version of it is a locally
// invented all-clear. It carries two positive clauses (`runsVisited > 0`, and a
// NON-EMPTY terminus set checked BEFORE `.every()`), which is exactly the
// vacuity sweep this repo now runs.
//
// This engine adds no second completeness predicate, and in particular there is
// NO function here meaning "the causal structure is complete", because none can
// exist: whether the recorded edges are all the real edges is not answerable
// from stored data. Recording is opt-in and partial. That limit is carried by
// the contract's `originStatement()`, which composes "the recorded chain starts
// at run X" rather than "run X is the root cause".
//
// ===========================================================================
// PART 6 — CROSS-ORG IS MISSING, AT EVERY HOP
// ===========================================================================
//
// This engine never sees an org id, and that is the point: it folds only what
// convex/causality.ts chose to OBSERVE. That layer resolves every hop through an
// org-prefixed index and re-checks `run.orgId` on every document it reads. A hop
// that leaves the org yields NO observation, so it arrives here identical to a
// hop into a deleted run: an edge naming a run that is not in `nodes`, which
// folds to a `LostTrail` with kind `adjacent_run_unavailable`. There is no
// branch here that could distinguish them, which is the property being defended
// — a distinguishable "forbidden" is a cross-org existence oracle.
// ---------------------------------------------------------------------------

import {
  computeCausalVerdict,
  DEFAULT_CAUSAL_MAX_DEPTH,
  isCausalTraversalComplete,
  MAX_CAUSAL_NODES,
  MAX_SUSPECTED_LINK_RUNS,
  type CausalDirection,
  type CausalEvidence,
  type CausalNode,
  type CausalScan,
  type CausalTraversal,
  type ChainTerminus,
  type EdgeAdjacency,
  type LostTrail,
  type RecordedCausalEdge,
  type RecordedCausalEdgeKind,
  type RunStatus,
  type SuspectedLink,
  type TrailLossKind,
  type UnansweredCausalQuestion,
} from "@agent-flight-recorder/contracts";

export type {
  CausalDirection,
  CausalNode,
  CausalScan,
  CausalTraversal,
  ChainTerminus,
  RecordedCausalEdge,
  RecordedCausalEdgeKind,
  SuspectedLink,
  UnansweredCausalQuestion,
};

export { MAX_CAUSAL_NODES, DEFAULT_CAUSAL_MAX_DEPTH };

// ===========================================================================
// PART A — BOUNDS
//
// THE HONEST ANSWER TO "fan-out 10 at depth 6". That is ~1.1 million runs. No
// bound makes it walkable inside one Convex transaction, and the honest product
// answer is not a bigger number — it is a COMPLETE answer to a SMALLER question.
// Breadth-first is what makes that possible: the walk fills level 0, then 1,
// then 2, and every unexpanded frontier becomes a `LostTrail` NAMING THE RUN, so
// the caller re-roots there. At fan-out 10 that is depth 2 (111 runs) inside the
// node budget.
//
// Depth-first would spend the same budget on one arbitrary tendril six levels
// deep and be able to report nothing complete at all.
//
// `MAX_CAUSAL_NODES` and `DEFAULT_CAUSAL_MAX_DEPTH` come from the CONTRACT, so
// the SDK's own bound checks and this engine's cannot drift.
// ===========================================================================

export const CAUSAL_MAX_DEPTH = 16;
export const CAUSAL_MIN_DEPTH = 1;

/** Edges read from ONE node in ONE direction before the fan-out is declared truncated. */
export const CAUSAL_MAX_FANOUT = 64;

/** Total edge rows read per traversal. A dense component exhausts this before the node budget. */
export const CAUSAL_MAX_EDGES = 2_000;

/** Bound on the non-causal session-sibling sample behind a `shared_session` suspicion. */
export const CAUSAL_MAX_SESSION_SIBLINGS = MAX_SUSPECTED_LINK_RUNS;

export function clampCausalDepth(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_CAUSAL_MAX_DEPTH;
  return Math.max(CAUSAL_MIN_DEPTH, Math.min(CAUSAL_MAX_DEPTH, Math.floor(requested)));
}

// ===========================================================================
// PART B — OBSERVATIONS. Plain rows, so the engine is testable with literals.
// ===========================================================================

/** One run the walk actually READ, in the caller's org. */
export interface CausalNodeObservation {
  runId: string;
  agentId?: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  sessionId?: string;
  /** Bounded sample of OTHER runs sharing `sessionId`. Non-causal — becomes a `SuspectedLink`. */
  sessionSiblingRunIds?: string[];
  /**
   * SHA-256 checksums of artifacts this run's rows reference. Bounded.
   *
   * NON-CAUSAL, AND THIS IS THE CASE WHERE THAT IS HARDEST TO BELIEVE. Two runs
   * referencing the same digest share a byte sequence — a cryptographically
   * exact match, which is exactly what makes the inference FEEL like proof. It
   * is not one: a matching hash says nothing about who WROTE and who READ, and
   * direction is the thing that cannot be inferred. So a shared digest becomes a
   * `shared_resource` SuspectedLink here and never an edge.
   *
   * An `artifact_handoff` EDGE requires the CONSUMING run's own log to record
   * that it read the artifact — the contract enforces it rather than documenting
   * it: `CausalArtifactCitation.role` is required, and `edgeIncoherences` emits
   * `artifact_handoff_not_cited_by_consumer` unless a `role: "consumed"`
   * citation exists whose `recordedInRunId` is the edge's consumer.
   */
  artifactChecksums?: string[];
  /** Did the walk expand this node (read its edge sets), or leave it on the frontier? */
  expanded: boolean;
  /** Was this node's onward edge set READ TO COMPLETION in the direction walked? */
  onwardReadComplete: boolean;
  /**
   * Did an event in this run's log carry an EXTERNALIZED payload?
   *
   * A handoff recorded inside a payload that exceeded the 10 KB inline ceiling
   * (Event Log Rule 3) is invisible to derivation — the stored payload is an
   * artifact pointer, not the facts. That makes this run's adjacency UNREAD
   * rather than empty, which is the difference between a lost trail and a false
   * origin.
   */
  externalizedPayloadSeen?: boolean;
}

/** One edge the walk actually READ, with the log position that records it. */
export interface CausalEdgeObservation {
  producerRunId: string;
  consumerRunId: string;
  kind: RecordedCausalEdgeKind;
  handoffAt: number;
  /** The endpoint whose LOG carries the record. Must be one of the two endpoints. */
  recordedInRunId: string;
  citation:
    | { cites: "event"; eventId: string; sequenceNumber: number; eventType: string; namesRunId: string }
    // `role` is REQUIRED by the contract and carries the DIRECTION: a shared
    // hash has none, a recorded read does. Nothing derives an artifact citation
    // yet (convex/helpers/causal_derive.ts reads events and run fields only), so
    // this variant is plumbed and unexercised — deliberately, rather than
    // deriving an edge from a digest match, which is a coincidence however
    // cryptographically exact.
    | { cites: "artifact"; artifactId: string; sha256: string; role: "produced" | "consumed" }
    | { cites: "run_field"; field: string; namesRunId: string };
}

/** A run discovered but never expanded, and why. Becomes a `LostTrail`. */
export interface CausalFrontierObservation {
  runId: string;
  hopsFromSubject: number;
  reason: "depth_limit_reached" | "budget_exhausted" | "convergence_not_followed";
}

export interface CausalGraphInput {
  analyzedAt: number;
  subjectRunId: string;
  direction: CausalDirection;
  /** Runs actually READ, in the caller's org. A hop that left the org contributes nothing. */
  nodes: readonly CausalNodeObservation[];
  /** Edge rows actually READ. Both endpoints are claims; only observed nodes are facts. */
  edges: readonly CausalEdgeObservation[];
  frontier: readonly CausalFrontierObservation[];
  maxDepthRequested: number;
  /** The walk stopped on a row ceiling: every count is a floor. */
  scanTruncated: boolean;
  scanRowCeiling?: number;
}

// ===========================================================================
// PART C — THE FOLD
// ===========================================================================

function citationOf(e: CausalEdgeObservation): CausalEvidence {
  switch (e.citation.cites) {
    case "event":
      return {
        cites: "event",
        recordedInRunId: e.recordedInRunId,
        eventId: e.citation.eventId,
        sequenceNumber: e.citation.sequenceNumber,
        eventType: e.citation.eventType,
        namesRunId: e.citation.namesRunId,
        recordedAt: e.handoffAt,
      };
    case "artifact":
      return {
        cites: "artifact",
        recordedInRunId: e.recordedInRunId,
        artifactId: e.citation.artifactId,
        sha256: e.citation.sha256,
        role: e.citation.role,
        recordedAt: e.handoffAt,
      };
    case "run_field":
      return {
        cites: "run_field",
        recordedInRunId: e.recordedInRunId,
        field: e.citation.field,
        namesRunId: e.citation.namesRunId,
        recordedAt: e.handoffAt,
      };
  }
}

function edgeKeyOf(e: { producerRunId: string; consumerRunId: string; kind: string }): string {
  return `${e.producerRunId}->${e.consumerRunId}:${e.kind}`;
}

function recordedFactOf(e: CausalEdgeObservation): string {
  const when = new Date(e.handoffAt).toISOString();
  switch (e.citation.cites) {
    case "event":
      return `run ${e.recordedInRunId} recorded a "${e.citation.eventType}" event at sequence ${e.citation.sequenceNumber} naming run ${e.citation.namesRunId} (${when})`;
    case "artifact":
      return `run ${e.recordedInRunId} recorded artifact ${e.citation.artifactId} (sha256 ${e.citation.sha256.slice(0, 8)}…), which the other run also references (${when})`;
    case "run_field":
      return `run ${e.recordedInRunId} carries \`${e.citation.field}\` = ${e.citation.namesRunId} on its own run record (${when})`;
  }
}

/**
 * Classify one frontier of the walk.
 *
 * ORDER IS THE SAFETY PROPERTY, and it reads deliberately like
 * `deriveAgentHealthState` in helpers/fleet.ts: the FAILURE dispositions are
 * tested FIRST, so `RecordedOrigin` is unreachable without a positive, complete,
 * empty read. Written the other way round — "if no edges, it is an origin" — the
 * function certifies every run whose edge set nobody managed to read.
 */
function classifyFrontier(args: {
  node: CausalNodeObservation & { hopsFromSubject: number };
  danglingCount: number;
  unexpandedReason?: CausalFrontierObservation["reason"];
  cyclePath?: [string, ...string[]];
  analyzedAt: number;
}): ChainTerminus {
  const { node } = args;

  // 1. A CLOSED LOOP. A complete disposition — the walk did not fail, it came
  //    back. Checked before the lost-trail cases because a cycle's re-entry node
  //    is legitimately never expanded a second time, and reporting that as a
  //    budget exhaustion would misdescribe a scan that read everything it meant
  //    to.
  if (args.cyclePath !== undefined) {
    return {
      terminus: "cycle_reentry",
      reEnteredRunId: node.runId,
      hopsToReEntry: node.hopsFromSubject,
      cyclePath: args.cyclePath,
    };
  }

  // 2. WE STOPPED. Every branch below is an UNFINISHED investigation.
  const lost = (kind: TrailLossKind, lostBecause: string, wouldBeRecoveredBy: string): LostTrail => ({
    terminus: "trail_lost",
    lastReachedRunId: node.runId,
    kind,
    hopsBeforeLoss: node.hopsFromSubject,
    lostBecause,
    wouldBeRecoveredBy,
  });

  if (args.danglingCount > 0) {
    return lost(
      "adjacent_run_unavailable",
      `${args.danglingCount} recorded edge(s) at this run name a run that could not be read. That is INDISTINGUISHABLE, by design, between a run deleted under this org's retention window and a run outside this organization — resolving which would itself be a cross-org disclosure`,
      "check whether the named run predates this org's retention window (ADR-001)",
    );
  }
  if (args.unexpandedReason === "depth_limit_reached") {
    return lost(
      "depth_limit_reached",
      "the requested hop ceiling was reached at this run; the chain continues past here by an unknown amount",
      `re-run with a higher maxDepth (ceiling ${CAUSAL_MAX_DEPTH}), or re-root a traversal at this run`,
    );
  }
  if (args.unexpandedReason === "convergence_not_followed") {
    return lost(
      "convergence_not_followed",
      "this run has more than one recorded producer and the walk did not expand them; the chain provably continues in several directions this traversal did not read",
      "re-root a traversal at this run to follow each producer",
    );
  }
  if (args.unexpandedReason === "budget_exhausted" || !node.expanded) {
    return lost(
      "budget_exhausted",
      "the engine's row budget ran out before this run's edge set was expanded; every count in this traversal is a floor",
      "re-root a traversal at this run; this component is larger than one transaction can walk",
    );
  }
  if (node.externalizedPayloadSeen === true) {
    return lost(
      "adjacency_unconfirmed",
      "at least one event in this run's log carried an EXTERNALIZED payload (Event Log Rule 3), so the stored row is an artifact pointer rather than the facts. A handoff recorded inside it is invisible to derivation, and this run's edge set therefore cannot be confirmed empty",
      "fetch the externalized artifact, or record the handoff in a small dedicated event so it survives the 10 KB inline ceiling",
    );
  }
  if (!node.onwardReadComplete) {
    return lost(
      "adjacency_unconfirmed",
      "this run's edge set was read and is empty, but the read could not be confirmed complete — the per-node fan-out ceiling was reached",
      "re-root a traversal at this run to enumerate its edges directly",
    );
  }

  // 3. THE CHAIN ENDED. Unreachable without a complete read that found nothing,
  //    and both of those facts are LITERAL TYPES on the proof, so a truncated or
  //    non-empty read cannot be spelled here even by mistake.
  return {
    terminus: "recorded_origin",
    originRunId: node.runId,
    hopsToOrigin: node.hopsFromSubject,
    establishedBy: [
      {
        proves: "adjacent_edge_set_read",
        runId: node.runId,
        inboundReadComplete: true,
        inboundEdgesFound: 0,
        scannedAt: args.analyzedAt,
      },
    ],
  };
}

function terminusKey(t: ChainTerminus): string {
  switch (t.terminus) {
    case "recorded_origin":
      return `1:${t.originRunId}`;
    case "cycle_reentry":
      return `2:${t.reEnteredRunId}`;
    case "trail_lost":
      return `3:${t.lastReachedRunId}:${t.kind}`;
  }
}

/**
 * Fold observations into a {@link CausalTraversal}.
 *
 * PURE and TOTAL: never throws, never recurses, and terminates on any input
 * including one whose edges form arbitrary cycles. Every walk below carries its
 * own visited set over run ids and each id is dequeued at most once, so the work
 * is bounded by `nodes.length + edges.length` regardless of shape.
 */
export function foldCausalGraph(input: CausalGraphInput): CausalTraversal {
  const nodeById = new Map(input.nodes.map((n) => [n.runId, n]));
  const subject = nodeById.get(input.subjectRunId);

  // ---- Deduplicate edges. -------------------------------------------------
  // The same handoff can arrive twice: once from the consumer's inbound scan and
  // once from the producer's outbound scan. It is ONE fact and must be ONE edge,
  // or every fan-out count doubles for the interior of the graph and stays
  // single at its rim.
  const byKey = new Map<string, { obs: CausalEdgeObservation; citations: CausalEvidence[] }>();
  for (const e of input.edges) {
    const key = edgeKeyOf(e);
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, { obs: e, citations: [citationOf(e)] });
      continue;
    }
    // A second citation is kept only when it is a genuinely DIFFERENT log
    // position, never a duplicate read of the same one.
    const next = citationOf(e);
    const already = prior.citations.some(
      (c) => c.cites === next.cites && c.recordedInRunId === next.recordedInRunId,
    );
    if (!already) prior.citations.push(next);
  }

  // ---- Adjacency, over OBSERVED endpoints only. ---------------------------
  // An edge whose other end was not observed is NOT adjacency — it is a lost
  // trail. Cross-org and deleted arrive here identically (PART 6).
  const onward = new Map<string, CausalEdgeObservation[]>();
  const danglingAt = new Map<string, number>();
  const push = (m: Map<string, CausalEdgeObservation[]>, k: string, v: CausalEdgeObservation) => {
    const list = m.get(k);
    if (list === undefined) m.set(k, [v]);
    else list.push(v);
  };

  for (const { obs } of byKey.values()) {
    const producerSeen = nodeById.has(obs.producerRunId);
    const consumerSeen = nodeById.has(obs.consumerRunId);
    if (producerSeen && consumerSeen) {
      // "Onward" is relative to the walk: upstream follows consumer -> producer.
      if (input.direction === "upstream") push(onward, obs.consumerRunId, obs);
      else if (input.direction === "downstream") push(onward, obs.producerRunId, obs);
      else {
        push(onward, obs.consumerRunId, obs);
        push(onward, obs.producerRunId, obs);
      }
      continue;
    }
    const anchor = producerSeen ? obs.producerRunId : consumerSeen ? obs.consumerRunId : undefined;
    if (anchor !== undefined) danglingAt.set(anchor, (danglingAt.get(anchor) ?? 0) + 1);
  }

  // ---- Hops from the subject, recomputed here rather than trusted. --------
  const hopsOf = new Map<string, number>();
  if (subject !== undefined) {
    hopsOf.set(subject.runId, 0);
    const queue: string[] = [subject.runId];
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head]!;
      const d = hopsOf.get(id)!;
      for (const e of onward.get(id) ?? []) {
        const next = e.producerRunId === id ? e.consumerRunId : e.producerRunId;
        // VISITED SET. This is what terminates on a cycle: an id already
        // assigned a hop count is never enqueued again, so A->B->A enqueues A
        // once.
        if (hopsOf.has(next)) continue;
        hopsOf.set(next, d + 1);
        queue.push(next);
      }
    }
  }

  // ---- Cycles, and the path that proves each. -----------------------------
  const cyclePathAt = detectCycleReEntries(
    input.nodes,
    [...byKey.values()].map((v) => v.obs),
    input.direction,
    hopsOf,
  );

  // ---- Edges. -------------------------------------------------------------
  const edges: RecordedCausalEdge[] = [];
  for (const { obs, citations } of byKey.values()) {
    if (!nodeById.has(obs.producerRunId) || !nodeById.has(obs.consumerRunId)) continue;
    edges.push({
      basis: "recorded",
      kind: obs.kind,
      edgeKey: edgeKeyOf(obs),
      producerRunId: obs.producerRunId,
      consumerRunId: obs.consumerRunId,
      recordedFact: recordedFactOf(obs),
      handoffAt: obs.handoffAt,
      recordedBy: citations as [CausalEvidence, ...CausalEvidence[]],
    });
  }
  edges.sort((a, b) => (a.edgeKey < b.edgeKey ? -1 : a.edgeKey > b.edgeKey ? 1 : 0));

  // ---- Nodes. -------------------------------------------------------------
  const frontierByRun = new Map(input.frontier.map((f) => [f.runId, f]));
  const nodes: CausalNode[] = input.nodes
    .map((n): CausalNode => {
      const onwardCount = (onward.get(n.runId) ?? []).length;
      // THREE-VALUED, AND "UNREAD" IS TESTED FIRST. That order is the whole
      // point, and getting it wrong was a real defect here:
      //
      //   A node whose fan-out was CLIPPED at the per-node ceiling has edges,
      //   so an `onwardCount > 0` test reported `edge_recorded` — byte-identical
      //   to a node whose edge set was read in full. With 69 children against a
      //   budget of 64, five vanish, every terminus is a clean
      //   `recorded_origin`, and nothing anywhere says WHICH rung of the ladder
      //   is short. `scan.edgeSetsComplete: false` did fold into completeness,
      //   so the traversal was not lying — but "somewhere in this graph a node
      //   is missing children" is not an answer anyone can act on, and the
      //   traversal knew exactly which node it clipped.
      //
      // `adjacency_unread` exists for precisely this case. A node is
      // `edge_recorded` only when we read its edge set to the END and found
      // something; anything less is UNREAD, whether the shortfall is zero edges
      // or sixty-four.
      const readInFull =
        n.expanded && n.onwardReadComplete && n.externalizedPayloadSeen !== true;
      const adjacency: EdgeAdjacency = !readInFull
        ? "adjacency_unread"
        : onwardCount > 0
          ? "edge_recorded"
          : "no_edge_recorded";
      return {
        runId: n.runId,
        ...(n.agentId !== undefined ? { agentId: n.agentId } : {}),
        status: n.status,
        startedAt: n.startedAt,
        ...(n.endedAt !== undefined ? { endedAt: n.endedAt } : {}),
        hopsFromSubject: hopsOf.get(n.runId) ?? -1,
        adjacency,
      };
    })
    .sort((a, b) => a.hopsFromSubject - b.hopsFromSubject || (a.runId < b.runId ? -1 : 1));

  // ---- Termini. ONE PER FRONTIER, and NON-EMPTY by contract. --------------
  const termini: ChainTerminus[] = [];
  for (const n of input.nodes) {
    const hops = hopsOf.get(n.runId) ?? -1;
    const onwardCount = (onward.get(n.runId) ?? []).length;
    const dangling = danglingAt.get(n.runId) ?? 0;
    const cyclePath = cyclePathAt.get(n.runId);
    const unexpanded = frontierByRun.get(n.runId)?.reason;

    // An INTERIOR node is not a frontier: the walk continued through it and its
    // own onward branches terminate on their own. Fan-in is exactly this case —
    // see PART 3.
    const isFrontier =
      onwardCount === 0 || dangling > 0 || cyclePath !== undefined || unexpanded !== undefined;
    if (!isFrontier) continue;

    termini.push(
      classifyFrontier({
        node: { ...n, hopsFromSubject: hops },
        danglingCount: dangling,
        ...(unexpanded !== undefined ? { unexpandedReason: unexpanded } : {}),
        ...(cyclePath !== undefined ? { cyclePath } : {}),
        analyzedAt: input.analyzedAt,
      }),
    );
  }
  // A FRONTIER ENTRY NAMING A RUN THE WALK NEVER OBSERVED GETS NO TERMINUS.
  //
  // `LostTrail.lastReachedRunId` means "the last run the walk actually
  // REACHED", and the contract audits exactly that (`terminus_run_was_reached`):
  // a terminus naming a run absent from the node set is a frontier nobody can go
  // and read. The walk therefore records its budget stops at the run it was
  // EXPANDING — which is observed — rather than at the unread neighbour, so this
  // case should not arise; if it ever does, the honest home for it is the
  // `component_unclosed` question below, which is completeness-bearing and
  // carries the run ids.
  for (const f of input.frontier) {
    if (nodeById.has(f.runId)) continue;
    // Deliberately no terminus. See above.
  }

  // THE SUBJECT ITSELF WAS UNREADABLE. Deleted, or another org — deliberately
  // indistinguishable. `termini` is non-empty BY TYPE, and a walk always stops
  // somewhere, so the honest entry is a lost trail rather than an empty array.
  if (subject === undefined) {
    termini.push({
      terminus: "trail_lost",
      lastReachedRunId: input.subjectRunId,
      kind: "edge_set_unreadable",
      hopsBeforeLoss: 0,
      lostBecause:
        "the subject run could not be read at all, so no edge set could be enumerated. Deleted under retention, or outside this organization — deliberately indistinguishable",
      wouldBeRecoveredBy: "check the run id, and whether it predates this org's retention window",
    });
  }

  termini.sort((a, b) => {
    const ka = terminusKey(a);
    const kb = terminusKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // ---- Suspicions. NOT EDGES, and structurally unable to become one. ------
  const suspected: SuspectedLink[] = [];
  for (const n of input.nodes) {
    if (n.sessionId === undefined) continue;
    const siblings = n.sessionSiblingRunIds ?? [];
    if (siblings.length === 0) continue;
    suspected.push({
      basis: "suspected",
      kind: "shared_session",
      linkKey: `shared_session:${n.sessionId}:${n.runId}`,
      runIds: [n.runId, ...siblings].slice(0, MAX_SUSPECTED_LINK_RUNS),
      sharedValue: n.sessionId,
      notAnEdgeBecause:
        "these runs carry the same sessionId, which is a grouping key an SDK caller sets to relate runs for display; nothing in any of their logs records one reading another's output, and a session says nothing about dataflow or direction",
      wouldBeRecordedBy:
        "record an event naming the other run id (`consumedRunId` / `spawnedRunId` / `delegatedToRunId` / `retryOfRunId`), or pass `parentRunId` to `startRun`",
      firstSeenAt: n.startedAt,
      lastSeenAt: n.endedAt ?? n.startedAt,
    });
  }
  // SHARED ARTIFACT DIGEST. See `CausalNodeObservation.artifactChecksums`: a
  // cryptographically exact match is the most persuasive non-edge there is, and
  // it is still a coincidence, because a hash carries no direction.
  const runsByChecksum = new Map<string, string[]>();
  for (const n of input.nodes) {
    for (const checksum of n.artifactChecksums ?? []) {
      const list = runsByChecksum.get(checksum);
      if (list === undefined) runsByChecksum.set(checksum, [n.runId]);
      else if (!list.includes(n.runId)) list.push(n.runId);
    }
  }
  for (const [checksum, runIds] of [...runsByChecksum.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (runIds.length < 2) continue;
    // Only raise it when nothing RECORDED already connects the pair — a
    // suspicion beside an edge for the same runs is noise that invites someone
    // to read the coincidence as corroboration of the fact.
    const alreadyLinked = edges.some(
      (e) => runIds.includes(e.producerRunId) && runIds.includes(e.consumerRunId),
    );
    if (alreadyLinked) continue;
    const times = runIds
      .map((id) => nodeById.get(id)?.startedAt)
      .filter((v): v is number => typeof v === "number");
    suspected.push({
      basis: "suspected",
      kind: "shared_resource",
      linkKey: `shared_resource:${checksum}`,
      runIds: runIds.slice(0, MAX_SUSPECTED_LINK_RUNS).sort(),
      sharedValue: checksum,
      notAnEdgeBecause:
        "these runs reference an artifact with the same SHA-256, so they share a byte sequence — but a digest carries NO DIRECTION, and nothing in either run's log records one reading what the other wrote. The exactness of the match is what makes this feel like proof; it is what makes it a precise coincidence",
      wouldBeRecordedBy:
        "have the CONSUMING run record that it read the artifact, so the handoff carries a direction (`role: \"consumed\"`) rather than only a matching hash",
      firstSeenAt: times.length > 0 ? Math.min(...times) : input.analyzedAt,
      lastSeenAt: times.length > 0 ? Math.max(...times) : input.analyzedAt,
    });
  }

  suspected.sort((a, b) => (a.linkKey < b.linkKey ? -1 : 1));

  // ---- Unanswered questions. Completeness-bearing. ------------------------
  const unanswered: UnansweredCausalQuestion[] = [];
  for (const n of input.nodes) {
    if (n.externalizedPayloadSeen !== true) continue;
    unanswered.push({
      basis: "unanswered",
      kind: "adjacency_unknown",
      questionKey: `externalized_payload:${n.runId}`,
      undecidedQuestion: `whether run ${n.runId} recorded a handoff inside an externalized payload`,
      unknownBecause:
        "an event in this run's log exceeded the 10 KB inline ceiling (Event Log Rule 3), so the stored payload is an artifact pointer and any run id inside it is not visible to edge derivation",
      remedy: "record the handoff in a small dedicated event so it survives the inline ceiling",
      runIds: [n.runId],
    });
  }
  if (input.scanTruncated) {
    unanswered.push({
      basis: "unanswered",
      kind: "engine_limit",
      questionKey: "scan_truncated",
      undecidedQuestion: "whether further recorded edges exist beyond the row ceiling this walk hit",
      unknownBecause: `the walk stopped on its row ceiling${
        input.scanRowCeiling !== undefined ? ` (${input.scanRowCeiling})` : ""
      }; every count in this traversal is a floor`,
      remedy: "narrow the question — re-root a traversal at one of the lost frontiers",
    });
  }
  if (input.frontier.length > 0) {
    unanswered.push({
      basis: "unanswered",
      kind: "component_unclosed",
      questionKey: "component_unclosed",
      undecidedQuestion: "what the rest of this incident's component contains",
      unknownBecause: `${input.frontier.length} frontier(s) were discovered but never expanded, so the component was not closed`,
      remedy: "re-root a traversal at one of the lost frontiers",
      runIds: input.frontier.slice(0, MAX_SUSPECTED_LINK_RUNS).map((f) => f.runId),
    });
  }
  unanswered.sort((a, b) => (a.questionKey < b.questionKey ? -1 : 1));

  const deepestReached = nodes.reduce((m, n) => (n.hopsFromSubject > m ? n.hopsFromSubject : m), 0);

  const scan: CausalScan = {
    // ECHOED EXACTLY for ignored-parameter detection. A deployment that dropped
    // `maxDepth` would walk to its own default and report a
    // `depth_limit_reached` at a depth nobody chose, which looks identical to an
    // honest answer — so the SDK checks the echo.
    subjectRunId: input.subjectRunId,
    direction: input.direction,
    maxDepthRequested: input.maxDepthRequested,
    deepestReached,
    runsVisited: nodes.length,
    edgesRead: edges.length,
    scanTruncated: input.scanTruncated,
    ...(input.scanRowCeiling !== undefined ? { scanRowCeiling: input.scanRowCeiling } : {}),
    // FALSE MEANS THE GRAPH MAY BE MISSING ARROWS THE ENGINE HAD ACCESS TO — a
    // different and worse failure than missing arrows nobody recorded.
    //
    // POSITIVE CLAUSE FIRST, and it is not redundant even though nothing
    // currently depends on it. `.every()` over an empty node set is `true`, so
    // a walk that read NOTHING reported "every edge set was read completely".
    // That was contained — the fold emits a `trail_lost` terminus for an
    // unreadable subject AND `isCausalTraversalComplete` carries
    // `runsVisited > 0` — but by two guards in other functions, neither of which
    // is visible from this line. Containment at a distance is how the same shape
    // survives a refactor that touches only one of the two. This makes the field
    // honest on its own terms: no node was read, so no node's edge set was read
    // to the end.
    edgeSetsComplete:
      input.nodes.length > 0 && input.nodes.every((n) => !n.expanded || n.onwardReadComplete),
  };

  const draft: CausalTraversal = {
    analyzedAt: input.analyzedAt,
    subjectRunId: input.subjectRunId,
    // Provisional; replaced immediately below from the traversal's own contents.
    verdict: "indeterminate",
    nodes,
    edges,
    termini: termini as [ChainTerminus, ...ChainTerminus[]],
    suspected,
    unanswered,
    scan,
  };

  return {
    ...draft,
    // THE SINGLE DEFINITION, from the contract. Not hand-rolled: `complete:
    // true` is the one input that turns "no edges" into `isolated`, so a locally
    // invented version of it is a locally invented all-clear.
    verdict: computeCausalVerdict({
      edgeCount: edges.length,
      complete: isCausalTraversalComplete(draft),
    }),
  };
}

/**
 * Find the runs where the walk closed a loop, and the path that proves each.
 *
 * Iterative Tarjan over the WALK-DIRECTION adjacency — no recursion, so a
 * 400-node chain cannot blow the stack. A strongly-connected component of size
 * >= 2 is a cycle; the re-entry run reported is the component's member closest
 * to the subject, because that is the one an operator reaches first.
 *
 * `cyclePath` starts and ends at the re-entry run, which is what makes the claim
 * checkable: every consecutive pair corresponds to a recorded edge in the same
 * traversal, so a fabricated loop contradicts the edge set beside it.
 */
export function detectCycleReEntries(
  nodes: readonly { runId: string }[],
  edges: readonly CausalEdgeObservation[],
  direction: CausalDirection,
  hopsOf: Map<string, number>,
): Map<string, [string, ...string[]]> {
  // ALWAYS THE TRUE DIRECTED EDGE SET (producer -> consumer), NEVER the walk
  // direction. Three reasons, and the third is the one that bit:
  //
  //   * A loop in producer->consumer is the same SET of runs as a loop in
  //     consumer->producer, so walk direction cannot change WHETHER there is a
  //     cycle — only the order the path is written in.
  //   * `cyclePath` must be checkable against the traversal's own edge set, and
  //     the contract's `cycle_path_is_real` audit checks each consecutive pair
  //     against `${producerRunId}->${consumerRunId}`. A path written in
  //     upstream order fails that audit while describing a perfectly real loop.
  //   * An earlier version returned NO cycles for a `component` walk, on the
  //     reasoning that bidirectional adjacency makes every parent/child pair
  //     look like a component. That was the right worry and the wrong fix: it
  //     made a genuine A->B->A loop UNDECLARED on a component walk, which the
  //     contract's `cycles_are_declared` audit correctly calls a contradiction —
  //     the traversal claims to have terminated some other way over a graph that
  //     provably re-enters itself. Using the true direction fixes both at once:
  //     a parent/child pair has no loop in producer->consumer, and a real cycle
  //     is found whichever way the walk went.
  void direction;

  const ids = nodes.map((n) => n.runId);
  const known = new Set(ids);
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const e of edges) {
    if (!known.has(e.producerRunId) || !known.has(e.consumerRunId)) continue;
    adjacency.get(e.producerRunId)!.push(e.consumerRunId);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of ids) {
    if (index.has(root)) continue;
    const work: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const neighbours = adjacency.get(frame.id) ?? [];
      if (frame.i < neighbours.length) {
        const next = neighbours[frame.i]!;
        frame.i++;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(next)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.id) break;
        }
        if (component.length > 1) components.push(component);
      }
    }
  }

  const out = new Map<string, [string, ...string[]]>();
  for (const component of components) {
    const members = new Set(component);
    const entry = [...component].sort(
      (a, b) => (hopsOf.get(a) ?? Infinity) - (hopsOf.get(b) ?? Infinity) || (a < b ? -1 : 1),
    )[0]!;

    // CLOSE THE LOOP THROUGH REAL HOPS, OR EMIT NOTHING.
    //
    // An earlier version walked greedily from `entry` and, when it failed to
    // close, fell back to `[entry, ...otherMembers, entry]` — a path whose
    // consecutive pairs are NOT necessarily recorded edges. That is a
    // FABRICATED LOOP, and it is the worst possible failure for this band:
    // `cycle_reentry` is a COMPLETE frontier, so an unverifiable one certifies
    // a FINISHED investigation over a loop nothing recorded. The contract's
    // `cycle_path_is_real` audit catches it, but a producer must not be
    // emitting it in the first place.
    //
    // Breadth-first from `entry` back to `entry`, recording predecessors, over
    // the true producer->consumer adjacency. Every hop in the reconstructed
    // path is therefore an edge in this same traversal, by construction.
    const predecessor = new Map<string, string>();
    const visited = new Set<string>([entry]);
    let frontier = [entry];
    let closed: string | undefined;
    while (frontier.length > 0 && closed === undefined) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const consumer of adjacency.get(current) ?? []) {
          if (!members.has(consumer)) continue;
          if (consumer === entry) {
            closed = current;
            break;
          }
          if (visited.has(consumer)) continue;
          visited.add(consumer);
          predecessor.set(consumer, current);
          next.push(consumer);
        }
        if (closed !== undefined) break;
      }
      frontier = next;
    }
    // Could not close a real loop through `entry`. Emit NOTHING rather than a
    // path the edge set does not support.
    if (closed === undefined) continue;

    const back: string[] = [];
    let cursor: string | undefined = closed;
    while (cursor !== undefined && cursor !== entry) {
      back.push(cursor);
      cursor = predecessor.get(cursor);
    }
    out.set(entry, [entry, ...back.reverse(), entry] as [string, ...string[]]);
  }
  return out;
}
