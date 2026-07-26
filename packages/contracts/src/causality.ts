// ---------------------------------------------------------------------------
// CROSS-RUN CAUSALITY — "what caused this, and what did it break?"
//
// Runs are isolated islands in this product today. An autonomous company runs
// agents that hand work to other agents — a planner spawns a worker, a worker
// writes an artifact a nightly job reads, a retry loop re-enters the same
// pipeline — and when the last one in that chain fails, every view we have
// shows one run failing for reasons that are not in it. This file is the type
// contract for walking the chain: UP from a failure to where it came from,
// DOWN from a failing run to what consumed its output, and OUTWARD to the whole
// connected component for an incident.
//
// DERIVED, NEVER SOURCE OF TRUTH — same posture as replay, diff, divergence and
// fleet health (CLAUDE.md Event Log Rule 2). A `CausalTraversal` is computed at
// query time by walking recorded edges. Recompute it; do not cache it as a fact.
//
// ---------------------------------------------------------------------------
// INVARIANT 1 — A CAUSAL EDGE IS RECORDED, NEVER INFERRED
// ---------------------------------------------------------------------------
//
// Two runs adjacent in time are not thereby causally linked. Two runs sharing a
// session are not. Two runs touching the same resource are not. Every one of
// those is a coincidence an engine can compute from data it already has, which
// is exactly why the pressure to promote them is enormous: they are cheap, they
// are plentiful, and each one produces a satisfying arrow on a graph.
//
// An arrow is the most persuasive object this product can draw. Nobody reads a
// confidence badge next to an arrow. An operator tracing an incident follows
// arrows to a run, reads its logs, and acts — and if one of the arrows was
// manufactured from "these two happened within a second of each other on a busy
// afternoon", the trace terminates on an innocent run and the actual cause
// keeps running. So the separation is STRUCTURAL, not advisory, and it is the
// third time this codebase has drawn the same line (proven vs speculative in
// `divergence.ts`, observed vs hypothesised in `fleet_health.ts`, recorded vs
// inferred here):
//
//   1. TWO TYPES, MUTUALLY UNASSIGNABLE. {@link RecordedCausalEdge} and
//      {@link SuspectedLink} share no assignable shape. Distinct `basis`
//      literals AND required fields the other lacks, so assignment fails in
//      BOTH directions on a missing required property rather than merely on the
//      discriminant. Deleting the discriminant would not open the hole.
//
//   2. A SUSPECTED LINK HAS NO DIRECTION. THIS IS THE LOAD-BEARING ONE.
//      `RecordedCausalEdge` has `producerRunId` and `consumerRunId`;
//      {@link SuspectedLink} has an unordered `runIds` and NO from/to fields at
//      all. Direction is precisely the thing that cannot be inferred — "these
//      two runs are related" is sometimes computable, "this one caused that
//      one" never is — so the type cannot express it. A suspected link is
//      therefore not merely flagged as unwalkable, IT IS UNWALKABLE: there is
//      no field a traversal could follow. Every collection that a walk consumes
//      is typed `RecordedCausalEdge[]`, so speculation cannot enter a chain
//      even if a consumer wants it to.
//
//   3. NO SHARED TEXT FIELD, AND THE SUSPICION HAS NO HEADLINE AT ALL. An edge
//      says `recordedFact`; an unanswered question says `undecidedQuestion`; a
//      suspected link says NOTHING — it carries `kind` and a `sharedValue`, and
//      its sentence is COMPOSED by {@link suspicionQuestion}, always
//      interrogative. This is `fleet_health.ts`'s hypothesis rule applied to the
//      speculative side of this feature, and for the same reason: every other
//      barrier here stops a CONSUMER promoting a guess by forgetting something,
//      and a free prose field lets the ENGINE do it by writing "run_a caused
//      run_b" — a compiling, contract-valid link that reads as a finding no
//      matter what chrome surrounds it.
//
//      An edge KEEPS its prose (`recordedFact`), and that asymmetry is
//      deliberate: an edge is a fact, and facts are safe to phrase in the past
//      tense. The dangerous sentence was only ever on the speculative side.
//
//   4. AN EDGE MUST CARRY ITS RECORD. `recordedBy` is a NON-EMPTY tuple type,
//      so an edge with nothing behind it does not compile — the same rule as
//      `ProvenDivergence.provenBy` and `ObservedCorrelation.observedBy`.
//
//   5. NO EXPORTED UNION OF THE TWO. There is no `CausalLink = Recorded |
//      Suspected`. A union is the flattening this design refuses to make
//      convenient, which is also why {@link CausalTraversal} keeps separate
//      arrays.
//
//   6. A SUSPICION CAN NEVER MOVE THE VERDICT.
//      {@link computeCausalVerdict} does not take a suspected-link count. There
//      is no parameter to pass, so no threshold can be added without a contract
//      change, and `afr cause` has no `--fail-on` value that fires on one.
//
// ---------------------------------------------------------------------------
// INVARIANT 2 — A CHAIN THAT ENDS AND A CHAIN WHOSE TRAIL IS LOST ARE
//              DIFFERENT TYPES
// ---------------------------------------------------------------------------
//
// This is the invariant this file exists for, and it is new at this altitude.
//
//   "The origin is run X."          The investigation is OVER. Nothing produced
//                                   the input to X. Read X.
//   "We lost the trail at run X."   The investigation is INCOMPLETE. Something
//                                   may well have produced X's input; we did not
//                                   get to look.
//
// These are opposite claims about the same run id, and the second is the more
// common one in production — the SDK may simply not have recorded the edge, the
// depth cap may have bitten, the producing run may have aged out of retention.
// A design that renders them the same way is a design that tells an operator
// "you have found it" when the honest sentence is "you have run out of road".
//
// A flag would not have worked, and it is worth saying why rather than leaving
// it as an unexplored option. `{ runId, isOrigin: boolean }` fails the moment a
// renderer writes `Origin: ${terminus.runId}` and reads the flag only to choose
// a colour — which is what every renderer does, because the run id is the thing
// on the screen and the flag is chrome. A forgotten flag then prints "Origin:
// run_x" for a lost trail, and it prints it in the confident register, and it
// compiles. The failure mode is silent, plausible, and in the one direction
// that ends an investigation early.
//
// So the two claims are two types, they are mutually unassignable, and —
// crucially — THEY SHARE NO FIELD EXCEPT THE DISCRIMINANT:
//
//   {@link RecordedOrigin}: `originRunId`,   `hopsToOrigin`,   `establishedBy`
//   {@link LostTrail}:      `lastReachedRunId`, `hopsBeforeLoss`, `lostBecause`,
//                           `wouldBeRecoveredBy`
//
// There is deliberately no shared `runId` and no shared `depth`. A renderer
// CANNOT write one template that handles both, because there is no property
// common to both that carries any information. `terminus.originRunId` does not
// compile on a `LostTrail`; `terminus.runId` does not compile on either. Every
// consumer is forced through a narrow, and having narrowed, it is holding a type
// whose field names state which claim it is making.
//
// `hopsToOrigin` versus `hopsBeforeLoss` is the same distinction applied to a
// number, and it is the `null`-versus-`0` lesson from `FleetShareMeasurement`
// in its exact form: THESE ARE NOT THE SAME QUANTITY. `hopsToOrigin` is the
// true length of the recorded chain. `hopsBeforeLoss` is a LOWER BOUND on it.
// An unmeasured quantity is not a measured extreme, and a shared `depth: number`
// would have quietly made a floor look like a total everywhere it was summed,
// averaged or compared.
//
// ---------------------------------------------------------------------------
// INVARIANT 3 — ABSENCE OF AN EDGE IS NOT ABSENCE OF CAUSATION
// ---------------------------------------------------------------------------
//
// Recording is partial by nature: the SDK records what it was asked to record.
// So an engine needs to say two different things about a run's neighbourhood,
// and a boolean cannot:
//
//   "There is no edge here."             The complete edge set was read; it is empty.
//   "I do not know whether there is."    The edge set was not read.
//
// {@link EdgeAdjacency} is three-valued for that reason, and
// {@link RecordedOrigin} can only be constructed from an {@link OriginProof}
// whose `inboundReadComplete` is the LITERAL TYPE `true` and whose
// `inboundEdgesFound` is the LITERAL TYPE `0`. A truncated read cannot be
// spelled as an origin proof — not "should not be", CANNOT: `false` is not
// assignable to `true`, and the code will not compile.
//
// AND EVEN THEN, WHAT IS ESTABLISHED IS THE ORIGIN OF THE RECORDED CHAIN, NOT
// THE ROOT CAUSE OF ANYTHING. The type is named `RecordedOrigin` and not
// `RootCause` for that reason, and {@link originStatement} composes a sentence
// that says so. A flight recorder stores what happened; the edge that was never
// instrumented is invisible to it, and no amount of walking finds it.
//
// A negative test asserting all three invariants (via `@ts-expect-error`, which
// fails the build if any conflation ever BECOMES legal) lives at
// `tests/unit/causal_type_conflation.test.ts`.
//
// See `packages/sdk/src/reader.ts` (`getCausalTrace`) for the wire-level
// counterpart: the same segregation re-checked at runtime, because a server is
// not typechecked by us and TypeScript's guarantee stops at the wire.
// ---------------------------------------------------------------------------

import type { RunStatus } from "./status.js";

// ---------------------------------------------------------------------------
// RECORDED edges — the only thing a traversal may walk
// ---------------------------------------------------------------------------

/**
 * A kind of causal edge that is DECIDABLE from stored rows alone.
 *
 * CLOSED SET, and it must stay closed. Every member names a specific thing the
 * SDK or the ingest path WROTE DOWN at the moment the handoff happened. If the
 * edge you want to add is computed after the fact by comparing two runs that
 * were never told about each other, it is not a member of this union — whatever
 * it produces is a {@link SuspectedLink}.
 *
 * ---------------------------------------------------------------------------
 * THIS SPELLING IS FROZEN, BECAUSE IT IS A STORED VALUE
 * ---------------------------------------------------------------------------
 *
 * Any Convex index over causal edges stores this string in its `kind` column.
 * Contracts is the authority on the vocabulary (CLAUDE.md, Repo Conventions ->
 * Types); a backend that spells one of these differently is not a variant, it
 * is a migration. Alignment is free while no rows exist and costs a backfill
 * the moment they do, so the five strings below are fixed as of contracts
 * 0.24.0 and change only through a versioned contract bump with a migration
 * plan. {@link RECORDED_CAUSAL_EDGE_KINDS} is the runtime enumeration, for a
 * schema validator to be built from rather than retyped.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE RECORD LIVES — THE LOG, NEVER A SIDE TABLE
 * ---------------------------------------------------------------------------
 *
 * Every member of {@link CausalEvidence} cites the IMMUTABLE EVENT LOG: an
 * event, an artifact the run's own log records handling, or a field on the run
 * record. That is deliberate and it is the same argument that put provenance on
 * the event record rather than beside it.
 *
 * A side table holding edges is MUTABLE AND DELETABLE. A lost row there does
 * not degrade the answer, it LAUNDERS it: the edge silently becomes an absence,
 * permanently, underneath an append-only log that still contains the truth. And
 * the absence is indistinguishable from "no edge was ever recorded" — which is
 * the exact ended-versus-lost distinction this whole contract exists to
 * preserve, defeated by its own storage.
 *
 * So: THE LOG IS THE RECORD. Any `run_causal_edges`-style table is a DERIVED,
 * REBUILDABLE INDEX over it, never a source of truth, and its schema comment
 * must say so. An index that cannot be rebuilt from the log is a second
 * substrate for the same fact, and the two will disagree.
 */
export type RecordedCausalEdgeKind =
  /**
   * The producer run recorded that it started the consumer run.
   * RECORD: an event in the producer's log naming the consumer's run id, or the
   * consumer's run record carrying `parentRunId` set at `startRun`.
   */
  | "spawned"
  /**
   * The consumer run recorded that it read an artifact the producer wrote.
   * RECORD: an artifact id present on both runs, with a matching SHA-256.
   * This is the edge that crosses time — a nightly job reading yesterday's
   * output — and the one no adjacency heuristic could ever find.
   */
  | "artifact_handoff"
  /**
   * The consumer run recorded that it was invoked with the producer's output as
   * its input. RECORD: an event in the consumer's log naming the producer run id.
   */
  | "output_consumed"
  /**
   * The consumer run recorded that it is a retry of the producer run.
   * RECORD: an event or run field naming the run being retried. Kept distinct
   * from `spawned` because a retry chain is the one shape where every run in the
   * chain has the same agent and the same input, and an operator reading a trace
   * needs to know they are looking at one thing failing four times rather than
   * four things failing.
   */
  | "retry_of"
  /**
   * The producer run recorded that it delegated a sub-task to the consumer.
   * RECORD: an event in the producer's log naming the consumer run id.
   */
  | "delegated_to";

/**
 * The frozen edge-kind vocabulary, as a runtime array.
 *
 * Exported so a Convex schema validator, an API route's parameter check and the
 * SDK gate are all BUILT FROM the same list rather than each retyping it. A
 * hand-copied union in a backend is how a stored `kind` starts drifting from
 * the contract that defines it.
 */
export const RECORDED_CAUSAL_EDGE_KINDS: readonly RecordedCausalEdgeKind[] = [
  "spawned",
  "artifact_handoff",
  "output_consumed",
  "retry_of",
  "delegated_to",
];

/** One recorded event that establishes an edge, cited by the run and position that store it. */
export interface CausalEventCitation {
  cites: "event";
  /** The run whose log carries this event. Must be one of the edge's two endpoints. */
  recordedInRunId: string;
  eventId: string;
  /**
   * Position in that run's log. Events are ordered by this within a run.
   *
   * MONOTONIC FROM 1 (CLAUDE.md Event Log Rule 4), SO `0` IS NOT A VALID
   * SEQUENCE NUMBER — and {@link traversalUnusableFields} refuses it.
   *
   * That is deliberate, and it is aimed at a specific temptation: a mapping
   * layer that has lost the real number reaches for `0` as a sentinel. A
   * sentinel drawn from the same domain as the data is indistinguishable from a
   * measurement, and this one would point an operator at the wrong end of a run's
   * log. Rule 4 leaves `0` outside the domain, so refusing it turns a silent
   * mis-citation into a loud one. If the number is genuinely unavailable, the
   * honest citation is not an event citation.
   */
  sequenceNumber: number;
  /** The event type that carried the handoff. */
  eventType: string;
  /** The OTHER run id, as it appears in the event. What makes the citation checkable. */
  namesRunId: string;
  recordedAt: number;
}

/**
 * An artifact this run's own log records it having written or read.
 *
 * ---------------------------------------------------------------------------
 * THE ARTIFACT QUESTION, ANSWERED — READ THIS BEFORE WRITING AN ENGINE
 * ---------------------------------------------------------------------------
 *
 * IS TWO RUNS SHARING AN ARTIFACT SHA-256 A RECORDED EDGE OR A SUSPECTED LINK?
 *
 * IT DEPENDS ON WHERE THE CITATION CAME FROM, AND THE LINE IS EXACT:
 *
 *   RECORDED EDGE (`artifact_handoff`) — THE CONSUMING RUN'S OWN LOG RECORDS
 *   THAT IT READ THAT ARTIFACT. run_b wrote down "I read artifact 4f2a"; run_a
 *   wrote down "I produced artifact 4f2a". Two runs each recording their own
 *   half of a handoff, at the moment it happened. That is a fact about
 *   dataflow, and the direction comes from the `role` fields rather than from
 *   anyone's judgement.
 *
 *   SUSPECTED LINK (`shared_resource`) — AN OUTSIDE JOIN NOTICED A MATCHING
 *   HASH. Nobody recorded reading anything; an engine scanned the artifacts
 *   table, found two rows with the same digest, and inferred a handoff. This is
 *   "adjacent therefore causal" in its most convincing costume — the checksum
 *   makes it feel like proof — and it is not an edge. Two runs may both READ
 *   the same input, both WRITE the same deterministic output, or reference the
 *   same blob for reasons unrelated to either.
 *
 * THE TEST, IN ONE SENTENCE: an `artifact_handoff` edge requires a citation
 * FROM THE CONSUMER'S OWN LOG with `role: 'consumed'`. If you had to join two
 * runs' artifact rows to find the connection, and neither run recorded reading
 * the other's output, you have a {@link SuspectedLink} — say so, and put the
 * instrumentation fix in `wouldBeRecordedBy`.
 *
 * `edgeIncoherences` enforces exactly this and reports
 * `artifact_handoff_not_cited_by_consumer` when it fails.
 */
export interface CausalArtifactCitation {
  cites: "artifact";
  /** The run whose log carries this citation. Must be one of the edge's two endpoints. */
  recordedInRunId: string;
  artifactId: string;
  /**
   * SHA-256 of the blob (Event Log Rule 3). The checksum is what makes this an
   * identity claim rather than a name collision: two runs referencing
   * "output.json" share a filename, two runs referencing the same digest share
   * a byte sequence.
   *
   * IT IS NOT, BY ITSELF, AN EDGE. See this interface's header — a matching
   * digest found by joining two runs' artifact rows is a coincidence, however
   * cryptographically exact the match.
   *
   * ---------------------------------------------------------------------
   * REQUIRED, AND STAYING REQUIRED — FOR A BACKEND WHOSE EDGE INDEX LACKS IT
   * ---------------------------------------------------------------------
   *
   * The digest is the entire difference between an identity claim and a
   * filename collision. Relaxing it would make `artifact_handoff` mean "two
   * rows mentioned something called output.json".
   *
   * It is NOT missing from the system: Event Log Rule 3 puts a SHA-256 on every
   * artifact record. What is missing is a denormalised copy on an edge-index
   * row, so the fix is a join at read time, not a weaker type.
   *
   * Until that join exists, DO NOT fall back to citing the index row itself: an
   * edge whose evidence is "a row in the table that asserts this edge" is
   * circular, and circular self-evidence is exactly what an inference engine
   * emits. Cite instead the EVENT in the consumer's log that recorded the read
   * ({@link CausalEventCitation}) — a real record of a real handoff, needing no
   * digest. If neither is available, the honest output is a
   * {@link SuspectedLink} of kind `shared_resource`, with the join to do named
   * in `wouldBeRecordedBy`.
   */
  sha256: string;
  /**
   * WHAT `recordedInRunId`'S OWN LOG SAYS IT DID WITH THIS ARTIFACT. REQUIRED,
   * and it is what carries the direction of an `artifact_handoff` — a shared
   * hash has no direction, a recorded read does.
   */
  role: "produced" | "consumed";
  recordedAt: number;
}

/** A parent link written onto the run record itself at `startRun`. */
export interface CausalRunFieldCitation {
  cites: "run_field";
  /** The run whose record carries the field. Must be one of the edge's two endpoints. */
  recordedInRunId: string;
  /** e.g. `"parentRunId"`. */
  field: string;
  /** The OTHER run id, as stored in that field. */
  namesRunId: string;
  recordedAt: number;
}

/**
 * The record half of an edge.
 *
 * THIS union is fine and the recorded/suspected union would not be, and the
 * difference is worth stating: every member here is a FACT, differing only in
 * which table stores it. A consumer that flattens these three flattens three
 * kinds of record, not two kinds of claim.
 */
export type CausalEvidence = CausalEventCitation | CausalArtifactCitation | CausalRunFieldCitation;

/**
 * A causal edge that WAS RECORDED at the moment the handoff happened.
 *
 * Safe to walk. Safe to draw as an arrow. Safe to phrase in the past tense.
 * Never assignable to or from {@link SuspectedLink} — see this file's header.
 */
export interface RecordedCausalEdge {
  /** Discriminant. The other structural barriers are `recordedBy`, `producerRunId` and `consumerRunId`. */
  basis: "recorded";
  kind: RecordedCausalEdgeKind;
  /**
   * Stable identity of the EDGE, engine-assigned and opaque. Must contain no
   * per-page state, so the same edge seen twice carries the same key.
   */
  edgeKey: string;
  /** The run whose work came FIRST. Direction is recorded, never inferred. */
  producerRunId: string;
  /** The run that consumed it. */
  consumerRunId: string;
  /**
   * One line, phrased about WHAT WAS RECORDED, in the past tense:
   * "run_b recorded reading artifact 4f2a (sha 9c31…) written by run_a".
   *
   * Never "run_a caused run_b to fail". Deliberately NOT named
   * `message`/`summary`/`title`, and deliberately ABSENT from
   * {@link SuspectedLink} — see this file's header, point 3.
   */
  recordedFact: string;
  /** When the handoff was recorded, epoch ms. Checked against the citations. */
  handoffAt: number;
  /**
   * THE RECORD. NON-EMPTY BY TYPE: an edge with an empty `recordedBy` does not
   * compile. Bounded — a sample sufficient to check the edge and start reading,
   * not every row that mentions both runs.
   *
   * Every citation must be checkable: `recordedInRunId` must be one of this
   * edge's two endpoints, and the SDK refuses a traversal where it is not. An
   * edge whose own record names neither of its endpoints is an edge the engine
   * did not actually read.
   */
  recordedBy: [CausalEvidence, ...CausalEvidence[]];
}

// ---------------------------------------------------------------------------
// SUSPECTED links — the coincidences, quarantined and DIRECTIONLESS
// ---------------------------------------------------------------------------

/**
 * A kind of coincidence an engine can compute WITHOUT any handoff having been
 * recorded. None of these is a causal edge; each is a reason someone might
 * wrongly draw one.
 *
 * Closed in type, for the same reason as {@link RecordedCausalEdgeKind}: a
 * monitoring script may key on these values.
 */
export type SuspectedLinkKind =
  /** They ran close together in time. The cheapest and most seductive false arrow there is. */
  | "temporal_adjacency"
  /** They carry the same `sessionId`. A session is a grouping, not a dataflow. */
  | "shared_session"
  /**
   * They touched the same external resource — a URL, a table, a queue. Whether
   * one wrote what the other read is exactly what was not recorded.
   */
  | "shared_resource"
  /** They ran on the same agent. Says nothing about one feeding the other. */
  | "shared_agent"
  /** They failed with the same fingerprint. A shared symptom, not a shared cause, and not a dataflow at all. */
  | "shared_failure_fingerprint";

/**
 * A COINCIDENCE between runs, with no recorded handoff behind it.
 *
 * NOT AN EDGE. Not evidence of one, and not the absence of one. It cannot be
 * walked, it cannot be drawn as an arrow, and it can never move a verdict or an
 * exit code.
 *
 * THE REASON IT EXISTS IN THE CONTRACT AT ALL, rather than being dropped: an
 * operator forms the suspicion within seconds of seeing two runs near each
 * other, and they will form it from whatever is on the screen. Making the
 * system state the coincidence explicitly, as a question, with what would turn
 * it into a real edge attached, is safer than leaving a human to construct an
 * undocumented arrow out of two adjacent timestamps. It is also the product's
 * best instrumentation prompt: every suspected link is a place the SDK could
 * have recorded an edge and did not.
 *
 * NOTE WHAT IS STRUCTURALLY ABSENT:
 *  - NO `producerRunId` / `consumerRunId`, and no from/to of any name. Direction
 *    is the thing that cannot be inferred, so the type cannot express it. This
 *    is what makes a suspected link unwalkable rather than merely
 *    marked-do-not-walk.
 *  - NO prose headline. Its sentence is composed by {@link suspicionQuestion},
 *    always interrogative.
 *
 * Never assignable to or from {@link RecordedCausalEdge}.
 */
export interface SuspectedLink {
  /** Discriminant. The other structural barriers are `runIds`, `notAnEdgeBecause` and `wouldBeRecordedBy`. */
  basis: "suspected";
  kind: SuspectedLinkKind;
  /** Stable identity of the suspicion, as `edgeKey` is for edges. Opaque. */
  linkKey: string;
  /**
   * The runs this coincidence involves. UNORDERED, AND THE ORDER CARRIES NO
   * MEANING — a consumer that reads `runIds[0]` as "the cause" is reading
   * something that is not there. Bounded by {@link MAX_SUSPECTED_LINK_RUNS}.
   *
   * ---------------------------------------------------------------------
   * IDS, NEVER A COUNT — AND A COUNT CANNOT BE UPGRADED INTO ONE
   * ---------------------------------------------------------------------
   *
   * A backend that knows only "this run has 4 session siblings" CANNOT produce
   * a `SuspectedLink`, and that is correct rather than an oversight. A
   * suspicion exists to be CHECKED — an operator reads the runs and decides —
   * and a link naming runs nobody can open is an unfalsifiable arrow, which is
   * the thing this band was built to prevent rather than to hold.
   *
   * So a count belongs in prose (a lost trail's `lostBecause`, say), never
   * manufactured into ids. If the quarantine band is unreachable from a given
   * path, the fix is for that path to carry the ids — not for this field to
   * accept a number.
   */
  runIds: string[];
  /**
   * The VALUE the runs share — the session id, the resource name, the
   * fingerprint. THIS IS A VALUE, NOT A SENTENCE, AND THAT IS THE POINT.
   * Absent for `temporal_adjacency`, which is about no shared value.
   */
  sharedValue?: string;
  /**
   * REQUIRED: why this is not an edge. "These two runs share a session id;
   * nothing in either run's log records one reading the other's output."
   *
   * Forcing the engine to write the limit down at the point of raising the
   * suspicion is what keeps suspicions honest — the same discipline as
   * `SpeculativeDivergence.speculativeBecause` and
   * `HypothesisedCause.notEstablishedBecause`.
   */
  notAnEdgeBecause: string;
  /**
   * REQUIRED: what INSTRUMENTATION would turn this into a real edge —
   * "record `Events.runSpawned(childRunId)` in the parent, or pass
   * `parentRunId` to `startRun`".
   *
   * This is the difference between a product that hands someone a hunch and one
   * that hands them a fix. Unlike a fleet hypothesis, which is tested by an
   * experiment, a suspected link is closed by CODE — and it stays open forever
   * until somebody writes that code, which is why the remedy is required rather
   * than optional.
   */
  wouldBeRecordedBy: string;
  /** Earliest of the runs involved, epoch ms. For ordering a display only. */
  firstSeenAt: number;
  /** Latest, epoch ms. */
  lastSeenAt: number;
}

/** Bound on {@link SuspectedLink.runIds}. */
export const MAX_SUSPECTED_LINK_RUNS = 20;

/** The noun each suspicion is about. Derived from `kind`, so it cannot drift with whatever an engine felt like writing. */
const SUSPICION_NOUN: Record<SuspectedLinkKind, string | null> = {
  temporal_adjacency: null,
  shared_session: "session",
  shared_resource: "resource",
  shared_agent: "agent",
  shared_failure_fingerprint: "failure fingerprint",
};

/**
 * THE SENTENCE A HUMAN READS FOR A SUSPICION, COMPOSED RATHER THAN TRANSMITTED.
 *
 * This function exists because it is the only way to make the MOOD of a
 * suspicion a property of the type. Every other barrier in this file stops a
 * CONSUMER from promoting a coincidence to an edge by forgetting to check
 * something. A free-text headline let the PRODUCER do it, in one keystroke,
 * with nothing downstream able to tell: "run_a caused run_b" is a perfectly
 * valid, compiling `SuspectedLink`, and during an incident that sentence is
 * what someone acts on.
 *
 * ALWAYS INTERROGATIVE, ALWAYS, AND NEVER DIRECTIONAL. Every branch returns a
 * question, and no branch names one run as the cause of another — it cannot,
 * because the type does not carry the ordering that would let it.
 *
 * @param link - the suspicion to render.
 * @returns a question, phrased for an operator, naming the shared value when
 *   there is one. Never a claim, and never an arrow, in any branch.
 */
export function suspicionQuestion(link: SuspectedLink): string {
  const count = Array.isArray(link?.runIds) ? link.runIds.length : 0;
  const subject = count === 2 ? "These two runs" : `These ${count} runs`;
  if (link.kind === "temporal_adjacency") {
    return `${subject} ran close together in time — is one of them feeding the other, and if so, which way?`;
  }
  const noun = SUSPICION_NOUN[link.kind] ?? "attribute";
  return link.sharedValue === undefined
    ? `${subject} share a ${noun} — is there a handoff between them that nothing recorded?`
    : `${subject} share the ${noun} \`${link.sharedValue}\` — is there a handoff between them that nothing recorded?`;
}

// ---------------------------------------------------------------------------
// TERMINI — where a walk stopped, and WHY, as two irreconcilable types
// ---------------------------------------------------------------------------

/**
 * What the engine knows about a run's edges in the direction it was walking.
 *
 * THREE-VALUED ON PURPOSE. A boolean here would force "I did not look" to be
 * reported as one of "there is an edge" or "there is no edge", and both are
 * lies — the second in the direction that ends an investigation early.
 *
 * See this file's header, invariant 3.
 */
export type EdgeAdjacency =
  /** At least one recorded edge in this direction. */
  | "edge_recorded"
  /** The COMPLETE edge set in this direction was read, and it is empty. */
  | "no_edge_recorded"
  /**
   * The edge set was not read — budget, depth cap, a missing index, a producing
   * run outside the retention window. NOT "no edge": UNKNOWN.
   */
  | "adjacency_unread";

/**
 * The proof that licenses a {@link RecordedOrigin}, and the only thing that can.
 *
 * BOTH LITERAL TYPES ARE THE POINT:
 *
 *  - `inboundReadComplete: true` — not `boolean`. An engine that stopped on a
 *    ceiling CANNOT construct this object. `false` is not assignable to `true`,
 *    so a truncated read producing an "origin" is a compile error rather than a
 *    convention someone is trusted to keep.
 *  - `inboundEdgesFound: 0` — not `number`. An origin established by a proof
 *    that found an inbound edge is a self-contradiction, and it will not compile.
 *
 * This is "evidence required by construction" in its strongest available form:
 * the illegal states are not merely unreachable through a validator, they are
 * unspellable in the type system.
 *
 * "Inbound" is relative to the walk. Walking upstream, it is the producer side;
 * walking downstream, the consumer side. A traversal names its direction on the
 * scan, so the word is never ambiguous in context.
 */
export interface OriginProof {
  proves: "adjacent_edge_set_read";
  /** The run whose edge set was read. Must equal the terminus's `originRunId`. */
  runId: string;
  /** LITERAL `true`. A truncated read cannot be spelled here. */
  inboundReadComplete: true;
  /** LITERAL `0`. A proof that found an edge cannot establish an origin. */
  inboundEdgesFound: 0;
  /** When the edge set was read, epoch ms. */
  scannedAt: number;
}

/**
 * THE WALK ENDED. Nothing recorded produced this run's input.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 *
 * IT CLAIMS: the complete set of edges into `originRunId`, in the direction
 * walked, was read, and it is empty. The recorded chain starts here.
 *
 * IT DOES NOT CLAIM: that `originRunId` is the root cause of anything, or that
 * nothing produced its input. Recording is partial — the SDK records what it
 * was asked to record — so an uninstrumented handoff is invisible to any walk,
 * however complete. That is why this type is called `RecordedOrigin` and not
 * `RootCause`, and why {@link originStatement} composes a sentence that says so
 * rather than leaving each surface to phrase it.
 *
 * Never assignable to or from {@link LostTrail}: distinct `terminus` literal,
 * plus `originRunId`/`hopsToOrigin`/`establishedBy` which `LostTrail` lacks, and
 * NO field in common with it except the discriminant. A renderer cannot write
 * one template that handles both — see this file's header, invariant 2.
 */
export interface RecordedOrigin {
  /** Discriminant. The structural barriers are `originRunId`, `hopsToOrigin` and `establishedBy`. */
  terminus: "recorded_origin";
  /**
   * The run the recorded chain starts at.
   *
   * DELIBERATELY NOT NAMED `runId`. {@link LostTrail} calls its run
   * `lastReachedRunId`, so there is no property a renderer can read without
   * first knowing which claim it is holding.
   */
  originRunId: string;
  /**
   * Hops from the traversal's subject to here. A TOTAL, not a floor: the walk
   * reached the end, so this is the true length of the recorded chain.
   *
   * DELIBERATELY NOT NAMED `depth`. {@link LostTrail.hopsBeforeLoss} is a
   * LOWER BOUND on a different quantity, and a shared `depth: number` would let
   * a floor be summed, averaged and compared as though it were a total — the
   * `null`-versus-`0` defect in numeric form.
   */
  hopsToOrigin: number;
  /**
   * THE PROOF. NON-EMPTY BY TYPE, and every member is an {@link OriginProof},
   * whose literal-typed fields make a truncated or non-empty read unspellable.
   *
   * An "origin" with nothing behind it is exactly the lost trail this invariant
   * exists to keep separate, and it does not compile.
   */
  establishedBy: [OriginProof, ...OriginProof[]];
}

/** Why a walk stopped without establishing an origin. Facts about the SCAN, never about the run. */
export type TrailLossKind =
  /** The requested `maxDepth` was reached. The chain continues; we stopped. */
  | "depth_limit_reached"
  /** The engine's row/time budget ran out before this frontier was expanded. */
  | "budget_exhausted"
  /**
   * An adjacent run id is recorded, but the run itself is not readable — aged
   * out under the org's retention window (ADR-001), or purged. The edge is real
   * and the far end is gone.
   */
  | "adjacent_run_unavailable"
  /**
   * The edge set for this run could not be enumerated at all — a missing index,
   * an unreadable row. Distinct from `budget_exhausted` because nothing was
   * spent; the read was not possible.
   */
  | "edge_set_unreadable"
  /**
   * The run's edge set was read and is empty, but the read could not be
   * confirmed COMPLETE. The single most important member of this union: it is
   * the case that LOOKS exactly like an origin and is not one. An engine
   * tempted to round this up to `RecordedOrigin` cannot, because
   * {@link OriginProof.inboundReadComplete} is the literal type `true`.
   */
  | "adjacency_unconfirmed"
  /**
   * The frontier reached a CONVERGENCE POINT — a run with several recorded
   * producers — and the walk did not follow them.
   *
   * FAN-IN IS NOT A KIND OF TERMINUS, AND THIS IS WHY IT DOES NOT NEED TO BE.
   * A run consuming two upstream outputs is an ordinary interior node: the walk
   * continues through BOTH producers, and each of those branches terminates on
   * its own. `edgesInto()` already names the joint causes, and
   * {@link convergencePoints} enumerates the nodes where they meet — so a
   * `FanIn` terminus would promote information the edge set already carries
   * into a frontier, and would then double-count against the branch termini
   * that describe the same walk.
   *
   * What genuinely needs a name is the case where the walk STOPS at a
   * convergence instead of expanding it — and that is a LOST TRAIL, not a
   * neutral outcome, because the chain provably continues in N directions the
   * traversal did not read. Filing it here rather than as its own band keeps
   * `isCausalTraversalComplete` honest: an unexpanded convergence must force
   * exit 11, and a fourth "we terminated correctly" band would have bought it a
   * clean one.
   */
  | "convergence_not_followed";

/**
 * THE WALK RAN OUT OF ROAD. This is not where the chain ends; it is where WE
 * stopped being able to follow it.
 *
 * The more common terminus in production, and the one a naive design renders as
 * an origin. Never assignable to or from {@link RecordedOrigin}, and sharing no
 * field with it except the discriminant — see this file's header, invariant 2.
 */
export interface LostTrail {
  /** Discriminant. The structural barriers are `lastReachedRunId`, `hopsBeforeLoss`, `lostBecause` and `wouldBeRecoveredBy`. */
  terminus: "trail_lost";
  /**
   * The last run the walk actually reached. NOT an origin, and deliberately not
   * named `originRunId` or `runId`: the whole point is that no template can
   * print it under an "Origin:" label without narrowing first.
   */
  lastReachedRunId: string;
  kind: TrailLossKind;
  /**
   * Hops from the subject to `lastReachedRunId`. A FLOOR on the chain's true
   * length, never a total — the chain continues past here by an unknown amount.
   *
   * Deliberately not named `depth`; see {@link RecordedOrigin.hopsToOrigin}.
   */
  hopsBeforeLoss: number;
  /**
   * REQUIRED: what specifically stopped the walk. "The depth limit (5) was
   * reached." An unexplained "unknown" is indistinguishable from laziness and
   * gets ignored.
   */
  lostBecause: string;
  /**
   * REQUIRED: what would recover the trail, as an action — "re-run with
   * `--max-depth 12`", or "instrument the parent with `parentRunId` so this
   * handoff is recorded next time".
   *
   * The difference between a product that says "I cannot tell" and one that says
   * "I cannot tell YET, and here is what to do". A terminus that reads as a
   * shrug is one people learn to click past — which during an incident means
   * clicking past the only honest thing on the screen.
   */
  wouldBeRecoveredBy: string;
}

/**
 * THE WALK CAME BACK TO A RUN IT HAD ALREADY REACHED.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A THIRD TYPE AND NOT A `LostTrail`
 * ---------------------------------------------------------------------------
 *
 * Cycles are ORDINARY in agent architectures, not pathological: a retry loop
 * re-enters the same pipeline, a supervisor re-invokes a worker that reports
 * back to it, a repair job feeds the job that scheduled it. When a walk reaches
 * a run already in the traversal, it stops — and it stops CORRECTLY, having
 * read everything it meant to read. Nothing was truncated, no budget ran out,
 * no adjacency went unconfirmed.
 *
 * Filing that as a {@link LostTrail} would state something false ABOUT THE
 * SCAN: "we stopped being able to follow it" when in fact we followed it all
 * the way round. It would also force the traversal incomplete and exit 11,
 * which means a fully-traced retry loop — a very common shape — could never
 * report a finished trace. That is the same class of error as reporting "no
 * divergences" when the analysis could not run: a statement about the scan that
 * the scan does not support, in the direction that misleads.
 *
 * Filing it as a {@link RecordedOrigin} would be worse: a cycle has no origin,
 * and the proof it would need (a complete, EMPTY adjacency read) does not exist
 * — the re-entered run demonstrably has an inbound edge, which is why the walk
 * stopped.
 *
 * SO: A CYCLE IS A COMPLETE TERMINUS. {@link isCausalTraversalComplete} accepts
 * it, and `afr cause` can exit 0 on a fully-walked loop.
 *
 * NO SHARED RUN-ID FIELD, SAME AS THE OTHER TWO. `reEnteredRunId` is spelled
 * differently from `originRunId` and `lastReachedRunId` on purpose, so that
 * `originRunId ?? lastReachedRunId ?? reEnteredRunId` cannot be written and a
 * renderer must narrow before it can print anything at all.
 */
export interface CycleReEntry {
  /** Discriminant. The structural barriers are `reEnteredRunId`, `hopsToReEntry` and `cyclePath`. */
  terminus: "cycle_reentry";
  /**
   * The already-visited run the walk came back to.
   *
   * Deliberately not named `runId`, `originRunId` or `lastReachedRunId` — see
   * this interface's header, and this file's invariant 2.
   */
  reEnteredRunId: string;
  /**
   * Hops from the subject to the re-entry. A TOTAL — the walk closed the loop —
   * and again deliberately not named `depth`, `hopsToOrigin` or
   * `hopsBeforeLoss`.
   */
  hopsToReEntry: number;
  /**
   * REQUIRED, NON-EMPTY: the run ids forming the loop, in walk order, starting
   * and ending at `reEnteredRunId`.
   *
   * A cycle a reader cannot see is a cycle they will assume is a bug in the
   * tool. This is also what makes the claim checkable: every consecutive pair
   * must correspond to a recorded edge in the same traversal, so a fabricated
   * loop contradicts the edge set it sits beside.
   */
  cyclePath: [string, ...string[]];
}

/**
 * Where one frontier of a walk stopped.
 *
 * THE ONE PLACE THIS FILE EXPORTS A UNION OF DISPOSITION BANDS, and the reason
 * it is safe here while `FleetFinding = Observed | Hypothesis` was not is worth
 * stating: a frontier stops in EXACTLY ONE way, so this union fills a SINGLE
 * SLOT rather than typing a list. The danger of a findings union is the one loop
 * that renders mixed items uniformly; there is no such loop over a scalar. And
 * because the three members share no property except `terminus` — not a run id,
 * not a hop count, not a message — the union is USELESS UNNARROWED: every
 * access whatsoever forces a discriminant check. That is a stronger guarantee
 * than omitting the union would give, since the alternative (three optional
 * fields) admits all-absent and all-present.
 *
 * THE THREE ANSWERS, AND WHAT EACH SAYS ABOUT THE INVESTIGATION:
 *   {@link RecordedOrigin}  the chain ENDED here      — investigation complete
 *   {@link CycleReEntry}    the chain LOOPS back here — investigation complete
 *   {@link LostTrail}       WE stopped here           — investigation UNFINISHED
 *
 * Two of the three are complete and one is not, which is precisely why they
 * cannot be one type with a flag: the flag is what a renderer forgets, and the
 * consequence of forgetting is telling someone an unfinished investigation is
 * finished.
 */
export type ChainTerminus = RecordedOrigin | CycleReEntry | LostTrail;

/**
 * How a frontier of a COMPONENT walk can stop. NO ORIGIN ARM.
 *
 * ---------------------------------------------------------------------------
 * WHY A COMPONENT SCAN CANNOT PRODUCE AN ORIGIN — AND WHY THAT IS A TYPE RULE
 * RATHER THAN A RUNTIME ONE
 * ---------------------------------------------------------------------------
 *
 * "Nothing produced this run" is a DIRECTIONAL claim. A component walk closed
 * both sides, so every run it reached that has any lineage at all has an edge
 * touching it — which means {@link traversalClaimContradictions} rejects every
 * origin a component walk could ever emit. The claim is not merely usually
 * wrong; it is never satisfiable.
 *
 * A shape that compiles and can never be honest is the WEAK form of a barrier,
 * and it is the form this contract argues against everywhere else: a suspicion
 * has no direction field to follow, an `OriginProof` needs literal-typed `true`
 * and `0`, `originRunId ?? lastReachedRunId` does not compile. A runtime
 * rejection of a constructible claim is a rule somebody can forget to run; an
 * unrepresentable claim is not.
 *
 * So the component walk's frontier type simply has no origin in it, and
 * {@link TerminusFor} hands it to anyone who asked for a component. The right
 * way to ask "where did this chain start" is to run an `upstream` walk — which
 * is what `afr cause --direction up` does, and what the incident UI should do
 * alongside its component view rather than stitching one claim out of the other.
 *
 * A CYCLE AND A LOST TRAIL BOTH REMAIN LEGAL, and the pair still spans
 * complete-versus-incomplete, so a component walk can still report a finished
 * trace: every frontier either closed a loop or was honestly lost.
 */
export type ComponentTerminus = CycleReEntry | LostTrail;

/**
 * The frontier type a walk in direction `D` may report.
 *
 * DISTRIBUTIVE, so the permissive default is deliberate and worth stating: for
 * an unparameterised {@link CausalTraversal} — code that does not know which
 * walk it is holding — this resolves to the full {@link ChainTerminus}, and the
 * runtime audit is what protects that path. For `CausalDirection = 'component'`
 * it resolves to {@link ComponentTerminus}, and the origin becomes unspellable.
 *
 * THE SDK READ PATH IS WHERE THIS BITES, and it is the path every consumer
 * passes through: `FlightReader.getCausalTrace` infers `D` from the caller's own
 * `direction` argument, so `getCausalTrace({ direction: 'component', ... })`
 * returns a traversal whose `termini[0].originRunId` DOES NOT COMPILE. Nothing
 * reading a component graph — an adapter, a UI, the CLI — can hold an origin
 * from one.
 *
 * The wire check stays regardless, and must: a JSON body is not typechecked by
 * anyone, and the engine producing it may not be TypeScript at all.
 */
export type TerminusFor<D extends CausalDirection> = D extends "component" ? ComponentTerminus : ChainTerminus;

/**
 * The sentence for a terminus, COMPOSED rather than transmitted — so no surface
 * can render a lost trail in the confident register.
 *
 * Note that the origin branch states its own limit inline. "The recorded chain
 * starts at run X" is the honest claim; "run X is the root cause" is not, and
 * the difference is one an operator will not supply for themselves at 3am.
 *
 * EXHAUSTIVE OVER THE UNION BY CONSTRUCTION: the final branch is typed
 * `LostTrail` through a `never` check, so adding a fourth terminus band without
 * giving it a sentence is a compile error here rather than a silently
 * mis-rendered frontier on an incident screen.
 *
 * @param terminus - the frontier to render.
 * @returns a past-tense statement of where the walk ended for an origin or a
 *   cycle, and an explicit statement of INCOMPLETENESS for a lost trail. The
 *   three are never phrased alike.
 */
export function originStatement(terminus: ChainTerminus): string {
  if (terminus.terminus === "recorded_origin") {
    return (
      `The recorded chain starts at ${terminus.originRunId}, ${terminus.hopsToOrigin} hop(s) away: its complete ` +
      `edge set was read and is empty. Note this is the origin of what was RECORDED — an uninstrumented handoff ` +
      `would be invisible here.`
    );
  }
  if (terminus.terminus === "cycle_reentry") {
    return (
      `The chain LOOPS at ${terminus.reEnteredRunId}, ${terminus.hopsToReEntry} hop(s) away: ` +
      `${terminus.cyclePath.join(" -> ")}. The walk closed the loop and read everything it meant to — this ` +
      `frontier is finished, and a cycle has no origin to find.`
    );
  }
  return (
    `The trail was LOST at ${terminus.lastReachedRunId}, at least ${terminus.hopsBeforeLoss} hop(s) away — this is ` +
    `not where the chain ends, it is where we stopped following it (${terminus.lostBecause}). ` +
    `To recover it: ${terminus.wouldBeRecoveredBy}`
  );
}

// ---------------------------------------------------------------------------
// UNANSWERED — the third band, for the same reason divergence and fleet have one
// ---------------------------------------------------------------------------

/** Why a specific causal question could not be decided. Facts about the INPUTS, never about any run. */
export type UnansweredCausalQuestionKind =
  /** Whether a run has further edges could not be determined at all. */
  | "adjacency_unknown"
  /** An edge names a run that could not be loaded, so its own edges are unread. */
  | "run_unreadable"
  /** The component walk could not be closed — more frontiers than budget. */
  | "component_unclosed"
  /** The engine's own ceiling was reached mid-question. */
  | "engine_limit";

/**
 * A question this traversal COULD NOT ANSWER.
 *
 * Not an edge and not the absence of one. Never assignable to or from
 * {@link RecordedCausalEdge} or {@link SuspectedLink}: distinct `basis`
 * literal, plus a required `unknownBecause` neither of the others has, plus a
 * text field named for a question rather than a fact.
 *
 * COMPLETENESS-BEARING: any unanswered question makes the traversal incomplete,
 * which forces `indeterminate`, which in `afr cause` is exit 11.
 */
export interface UnansweredCausalQuestion {
  /** Discriminant. The structural barrier is `unknownBecause`. */
  basis: "unanswered";
  kind: UnansweredCausalQuestionKind;
  /** Stable identity of the question. Opaque. */
  questionKey: string;
  /** What could not be decided, PHRASED AS THE OPEN QUESTION. */
  undecidedQuestion: string;
  /** REQUIRED: what specifically stopped the walk from deciding it. */
  unknownBecause: string;
  /** What would make it answerable, as an action. */
  remedy?: string;
  /** Runs the question bears on, when it is run-specific. Bounded. */
  runIds?: string[];
}

// ---------------------------------------------------------------------------
// The traversal
// ---------------------------------------------------------------------------

/**
 * Which way the walk went.
 *
 * `component` is the incident view: walk BOTH ways from the subject until every
 * frontier terminates, yielding the connected component the subject belongs to.
 * It reuses the same terminus machinery because its frontiers stop in exactly
 * the same two ways.
 */
export type DirectedWalk =
  /** Toward what produced the subject's input. "What caused this?" */
  | "upstream"
  /** Toward what consumed the subject's output. "What did this break?" */
  | "downstream";

/**
 * What a caller can ASK for.
 *
 * `component` is the incident view: walk BOTH ways from the subject until every
 * frontier terminates, yielding the connected component the subject belongs to.
 *
 * IT IS NOT A DIRECTION, AND THE TYPES SAY SO — see {@link TerminusFor}. A
 * component walk has no single side, so it cannot produce an origin: "nothing
 * produced this" is a directional claim, and asking a direction-free scan for
 * one is a category error rather than a question with an unlucky answer.
 */
export type CausalDirection = DirectedWalk | "component";

/** One run reached by a walk. */
export interface CausalNode {
  runId: string;
  agentId?: string;
  /** Carried because "which upstream run FAILED" is the first thing an operator scans for. */
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** Hops from the subject. `0` for the subject itself. */
  hopsFromSubject: number;
  /**
   * What the engine knows about this run's further edges in the direction
   * walked. THREE-VALUED — `adjacency_unread` is not `no_edge_recorded`. See
   * {@link EdgeAdjacency}.
   */
  adjacency: EdgeAdjacency;
}

/**
 * What the walk actually covered.
 *
 * Same posture as `DivergenceScanWindow` and `FleetHealthScan`: the server
 * STATES its incompleteness in a field rather than refusing, and the GATE
 * decides that an incomplete walk is not a clean answer.
 */
export interface CausalScan<D extends CausalDirection = CausalDirection> {
  /** The run the walk started from. Echoed for ignored-parameter detection. */
  subjectRunId: string;
  /**
   * Echoed. A server that walked the other way answers a different question.
   *
   * PARAMETERISED, because it decides what {@link CausalTraversal.termini} may
   * contain: a `component` walk cannot report an origin. See
   * {@link TerminusFor}.
   */
  direction: D;
  /**
   * The hop ceiling that was asked for. ECHOED AND LOAD-BEARING: a deployment
   * that drops the parameter walks to its own — typically much shallower —
   * default, and reports a `depth_limit_reached` at a depth nobody chose. That
   * looks identical to an honest answer, so the SDK checks the echo exactly.
   */
  maxDepthRequested: number;
  /** The greatest `hopsFromSubject` actually reached. */
  deepestReached: number;
  /** Runs the walk visited. THE POSITIVE CLAUSE's subject — see {@link isCausalTraversalComplete}. */
  runsVisited: number;
  /** Edge rows read. Informational. */
  edgesRead: number;
  /** True when the walk stopped on the server's row ceiling: every count above is a floor. */
  scanTruncated: boolean;
  /** The ceiling that was hit, when the server reported it. */
  scanRowCeiling?: number;
  /**
   * Whether every visited run's edge set was read COMPLETELY.
   *
   * FALSE MEANS THE GRAPH MAY BE MISSING ARROWS THE ENGINE HAD ACCESS TO — a
   * different and worse failure than the graph missing arrows nobody recorded.
   * Folded into completeness, because a sampled edge set can produce a
   * plausible, connected, entirely wrong picture of an incident.
   */
  edgeSetsComplete: boolean;
  /**
   * PAGES REMAIN in the node listing. Its presence alone makes the traversal
   * incomplete. There is deliberately NO merge helper — see
   * {@link CausalDirection} and `afr cause`'s help.
   */
  nextCursor?: string;
}

/**
 * The verdict — "is there a recorded chain here?" — in one word.
 *
 * `indeterminate` is not a hedge; it is the answer that stops a false clean. A
 * walk that lost the trail has not established that the subject is an island.
 */
export type CausalVerdict =
  /** At least one recorded edge. There IS a cross-run chain, and it can be walked. */
  | "chain_recorded"
  /**
   * COMPLETE walk, every frontier an established origin, and no edges at all.
   * The subject really is an island — as far as anything was recorded.
   */
  | "isolated"
  /** No edges, but the walk did not finish. "Found nothing" is not evidence here. */
  | "indeterminate";

/**
 * The inputs {@link computeCausalVerdict} needs.
 *
 * NOTE WHAT IS NOT HERE: there is no suspected-link count, and there is no place
 * to put one. A coincidence cannot move this verdict. See this file's header,
 * invariant 1 point 6.
 */
export interface CausalVerdictInput {
  /** RECORDED edges only. */
  edgeCount: number;
  /**
   * Whether the traversal was complete.
   *
   * **Get this from {@link isCausalTraversalComplete}. Do not hand-roll it.**
   * `complete: true` is the single input that can turn "no edges" into
   * `isolated`, so a locally-invented version of it is a locally-invented
   * all-clear — and the failure is silent, because a hand-rolled predicate built
   * from "nothing went wrong" clauses is vacuously true on an empty walk.
   */
  complete: boolean;
}

/**
 * THE verdict rule, in one place, for every surface that states one.
 *
 * Precedence, and why:
 *
 *  1. `edgeCount > 0` -> `chain_recorded`, EVEN IF THE WALK WAS INCOMPLETE. A
 *     recorded edge does not become less real because something else went
 *     unread. Demoting it would hide the chain precisely when the graph is
 *     largest, which is during the incident.
 *  2. `!complete` -> `indeterminate`. No edges found and we did not finish
 *     looking: the false-island case, and it gets its own word.
 *  3. otherwise -> `isolated`.
 *
 * A consumer must not re-derive this. `afr cause` computes its exit code from
 * these same inputs rather than from a `verdict` string a server handed it, and
 * `FlightReader` cross-checks a server's `verdict` against this function.
 */
export function computeCausalVerdict(input: CausalVerdictInput): CausalVerdict {
  if (input.edgeCount > 0) return "chain_recorded";
  if (!input.complete) return "indeterminate";
  return "isolated";
}

/**
 * "What caused this, and what did it break?" — org-scoped, one subject run.
 *
 * Derived at query time; never stored (CLAUDE.md Event Log Rule 2).
 */
export interface CausalTraversal<D extends CausalDirection = CausalDirection> {
  /** Server clock at analysis time. The traversal is a snapshot; recompute rather than cache. */
  analyzedAt: number;
  /** The run the question was asked about. */
  subjectRunId: string;
  /** Must equal `causalTraversalVerdict(...)` over this traversal's own contents. Clients verify. */
  verdict: CausalVerdict;
  /** Every run reached. Bounded by the node ceiling — see {@link CausalScan.nextCursor}. */
  nodes: CausalNode[];
  /**
   * RECORDED edges. The graph. Typed `RecordedCausalEdge[]` and not a union, so
   * a suspected link cannot enter the walk even by an explicit cast at a call
   * site that has a `SuspectedLink` in hand.
   */
  edges: RecordedCausalEdge[];
  /**
   * EVERY FRONTIER, each an established origin or a lost trail.
   *
   * NON-EMPTY BY TYPE, and that is not decoration. `termini.every(t => t.terminus
   * === 'recorded_origin')` is VACUOUSLY TRUE on an empty array — a traversal
   * that reported no frontiers at all would read as "every frontier reached an
   * origin", i.e. as a complete trace, from the most natural check anyone would
   * write. A walk always stops somewhere; a report that says otherwise is not a
   * weaker answer, it is an unreadable one.
   */
  termini: [TerminusFor<D>, ...TerminusFor<D>[]];
  /**
   * Coincidences that are NOT edges. Never walked, never counted into the
   * verdict, never a gate signal, and each one names what instrumentation would
   * turn it into a real edge.
   */
  suspected: SuspectedLink[];
  /**
   * Questions the walk could not answer. Each one makes the traversal
   * incomplete, and therefore makes `verdict: 'isolated'` unreachable.
   */
  unanswered: UnansweredCausalQuestion[];
  /** REQUIRED. What the walk covered — see {@link CausalScan}. */
  scan: CausalScan<D>;
}

/**
 * An incident graph. Its frontiers cannot be origins — see
 * {@link ComponentTerminus} for why that is a type rule rather than a runtime
 * one.
 */
export type ComponentTraversal = CausalTraversal<"component">;

/** A one-way walk. The only kind that can establish where a chain started. */
export type DirectedTraversal = CausalTraversal<DirectedWalk>;

// ---------------------------------------------------------------------------
// READING A TRAVERSAL'S COLLECTIONS — THE ONLY WAY, ON PURPOSE
//
// Adopted wholesale from `fleet_health.ts`, whose write-up explains why the
// rule ("a required array's ELEMENTS are as untrusted as a required field")
// was named, written down, and then applied to three of the six places that
// needed it. Nothing below touches `traversal.edges`, `.termini`,
// `.unanswered`, `.suspected` or `.nodes` directly; there is no raw read to
// forget about, and there is no container-only helper available to make the
// mistake easy.
//
// Two accessors, because there are genuinely two needs: CONSUMERS want
// malformed elements GONE so they can compute; REPORTERS want them KEPT AND
// POSITIONED so they can name the bad entry. A reporter that silently dropped
// one would turn a malformed edge into an absent one.
// ---------------------------------------------------------------------------

/** An element that is at least shaped like a record. `null`, arrays and primitives are not. */
function isRecordLike(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Elements with POSITIONS PRESERVED, malformed ones surfaced as `null`. For the reporting functions. */
function indexedElements<T>(value: unknown): (T | null)[] {
  if (!Array.isArray(value)) return [];
  return value.map((element) => (isRecordLike(element) ? (element as T) : null));
}

/** Elements that can actually be computed with; malformed ones removed. For consumers. */
function soundElements<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecordLike) as T[];
}

/** A count: a non-negative integer. Rejects NaN, infinities, strings, null, undefined and negatives at once. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A real point in time. Rejects NaN and infinities, which arithmetic silently swallows. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * EVERY ARRAY COLLECTION ON A TRAVERSAL, AND WHAT A MALFORMED ELEMENT IN IT
 * MEANS.
 *
 * Declared ONCE, per collection, here — not decided at each call site. The
 * defect this prevents is on record in `fleet_health.ts`: reaching for the
 * CONSUMER accessor on a completeness-bearing collection silently deleted the
 * reason a verdict was not allowed to certify, and licensed the opposite
 * verdict.
 *
 * `termini` is the collection to look at hardest. A malformed terminus is an
 * unreadable answer to "where did this frontier stop?", and the two possible
 * answers are opposite claims. Dropping it would make the remaining termini
 * look like the whole frontier set — which, if the dropped one was the lost
 * trail, renders an incomplete trace as a finished one. So it GATES.
 */
const TRAVERSAL_COLLECTIONS = {
  /** Counted into the verdict. An unreadable edge is not "no edge". */
  edges: "gates",
  /** Every frontier must be readable, or we do not know whether the walk finished. */
  termini: "gates",
  /** Completeness-bearing. Dropping one deletes the reason to withhold a verdict. */
  unanswered: "gates",
  /** Cannot move the verdict by design. */
  suspected: "displays",
  /** A bounded view collection. */
  nodes: "displays",
} as const;

type TraversalCollection = keyof typeof TRAVERSAL_COLLECTIONS;

/** Every malformed element, with the collection and position that locate it. */
function malformedElements(traversal: CausalTraversal): { collection: TraversalCollection; index: number }[] {
  const found: { collection: TraversalCollection; index: number }[] = [];
  for (const collection of Object.keys(TRAVERSAL_COLLECTIONS) as TraversalCollection[]) {
    indexedElements((traversal as unknown as Record<string, unknown>)?.[collection]).forEach((element, index) => {
      if (element === null) found.push({ collection, index });
    });
  }
  return found;
}

/** Is anything unreadable in a collection the VERDICT depends on? */
function hasUnreadableGateInput(traversal: CausalTraversal): boolean {
  return malformedElements(traversal).some(({ collection }) => TRAVERSAL_COLLECTIONS[collection] === "gates");
}

/** A traversal's recorded edges, safe to compute with. */
function edgesOf(traversal: CausalTraversal): RecordedCausalEdge[] {
  return soundElements<RecordedCausalEdge>(traversal?.edges);
}

/** A traversal's termini, safe to compute with. */
function terminiOf(traversal: CausalTraversal): ChainTerminus[] {
  return soundElements<ChainTerminus>(traversal?.termini);
}

/** An edge's citations, safe to compute with. */
function citationsOf(edge: RecordedCausalEdge): CausalEvidence[] {
  return soundElements<CausalEvidence>(edge?.recordedBy);
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/**
 * WHICH DISPOSITIONS MEAN THE INVESTIGATION FINISHED, DECLARED ONCE.
 *
 * A table rather than a condition at each call site, for the same reason
 * `REPORT_COLLECTIONS` is one in `fleet_health.ts`: a classification chosen at a
 * call site is one somebody can get wrong again, and here getting it wrong means
 * telling an operator that an unfinished investigation finished.
 *
 * IT IS A TOTAL MAP OVER THE UNION'S DISCRIMINANTS, so a fourth terminus band
 * cannot be added without deciding — in this table, explicitly — whether it
 * completes a trace. Defaulting to "complete" by omission is exactly how a new
 * kind of not-having-looked would quietly start buying exit 0.
 */
const COMPLETE_TERMINI: Record<ChainTerminus["terminus"], boolean> = {
  /** The chain ended and it was proven. */
  recorded_origin: true,
  /** The chain looped and the walk closed it. Nothing went unread. */
  cycle_reentry: true,
  /** WE stopped. The chain continues by an unknown amount. */
  trail_lost: false,
};

/**
 * Did this frontier finish the investigation?
 *
 * Fails CLOSED on an unrecognised discriminant: a terminus speaking a vocabulary
 * this contract does not define is not one to guess at, and the safe guess is
 * "we did not finish".
 */
function isCompleteTerminus(terminus: ChainTerminus | null | undefined): boolean {
  const disposition = terminus?.terminus;
  return disposition !== undefined && COMPLETE_TERMINI[disposition] === true;
}

/**
 * Was the WALK complete — did it reach every frontier and read every edge set?
 *
 * SEVEN CONDITIONS, and the FIRST TWO are the ones to protect.
 *
 * Five of them are negative ("nothing went wrong"), and a predicate made only
 * of negative clauses is VACUOUSLY TRUE ON AN EMPTY WALK:
 *
 *   { runsVisited: 0, scanTruncated: false, nextCursor: undefined, termini: [] }
 *
 * Nothing truncated, no pages left, no frontier lost — and nothing visited.
 * Fed to {@link computeCausalVerdict} with no edges, that returns `isolated`:
 * A RUN CERTIFIED AS HAVING NO CAUSAL NEIGHBOURS, DERIVED FROM ZERO READS. Same
 * category error as `isFleetHealthScanComplete`'s: the predicate answers "was
 * anything truncated?" when the property it must express is "do we have enough
 * evidence to conclude?". `runsVisited > 0` and a NON-EMPTY terminus set are the
 * positive clauses that fix it.
 *
 * THE TERMINUS CLAUSE IS THE ONE SPECIFIC TO THIS FEATURE, and it is the whole
 * of invariant 2 expressed as a gate: a traversal is complete only if NO
 * frontier is a {@link LostTrail}. One lost trail anywhere in the graph makes
 * the whole trace incomplete, however many other branches ended cleanly —
 * because the operator's question ("what caused this?") is not answered by the
 * branches that terminated, it is answered by the one that did not.
 *
 * NOTE THAT THE CLAUSE IS "NO LOST TRAIL" AND NOT "EVERY ORIGIN". A
 * {@link CycleReEntry} is a COMPLETE frontier — the walk closed the loop and
 * read everything it meant to — so requiring every frontier to be an origin
 * would report a fully-traced retry loop as an unfinished investigation, and no
 * retry chain could ever exit 0. Two of the three dispositions are complete;
 * only one is not, and the predicate names the one rather than enumerating the
 * others (so a future terminus band must be classified deliberately, in
 * {@link COMPLETE_TERMINI}, rather than defaulting to "complete" by omission).
 *
 * Note the ordering: the terminus scan runs only AFTER `terminiOf(...).length >
 * 0`, because a predicate over an empty list is vacuously satisfied.
 */
export function isCausalTraversalComplete(traversal: CausalTraversal): boolean {
  const scan = traversal?.scan;
  if (scan === null || typeof scan !== "object") return false;
  const termini = terminiOf(traversal);
  return (
    isCount(scan.runsVisited) &&
    scan.runsVisited > 0 &&
    // POSITIVE CLAUSE, and it must come before `.every()` below — a walk that
    // reported no frontiers at all would otherwise satisfy "every frontier
    // reached an origin" by vacuity, which is the exact false-clean this whole
    // invariant exists against.
    termini.length > 0 &&
    termini.every((terminus) => isCompleteTerminus(terminus)) &&
    scan.scanTruncated === false &&
    scan.edgeSetsComplete === true &&
    scan.nextCursor === undefined &&
    // INDEXED, NOT SOUND. Any entry blocks — including one too malformed to
    // read, which is the strongest ground for `indeterminate` there is.
    indexedElements(traversal?.unanswered).length === 0 &&
    !hasUnreadableGateInput(traversal) &&
    // A TRAVERSAL WHOSE CLAIMS CONTRADICT ITS OWN EDGES HAS NOT ESTABLISHED
    // ANYTHING. Folded in here rather than left to each gate, because all four
    // of the defects this audits produced `complete: true` — an origin
    // contradicted by an inbound edge, an undeclared cycle and a fabricated
    // cycle path each certify a finished investigation over data that refutes
    // it, which is the one output that ends an investigation on the wrong run.
    traversalClaimContradictions(traversal).length === 0
  );
}

/** Convenience: the verdict this traversal's own contents imply. Use to verify a server's `verdict`. */
export function causalTraversalVerdict(traversal: CausalTraversal): CausalVerdict {
  return computeCausalVerdict({
    edgeCount: edgesOf(traversal).length,
    complete: isCausalTraversalComplete(traversal),
  });
}

/**
 * The frontiers where the trail was LOST — the honest incompleteness of a trace,
 * in one call.
 *
 * `afr cause` prints these, the web renders them, and both do so from this
 * function rather than filtering a union locally, so no surface can quietly
 * decide that a `depth_limit_reached` "does not really count".
 */
export function lostTrails(traversal: CausalTraversal): LostTrail[] {
  return terminiOf(traversal).filter((t): t is LostTrail => t?.terminus === "trail_lost");
}

/** The frontiers where the recorded chain genuinely ended. */
export function recordedOrigins(traversal: CausalTraversal): RecordedOrigin[] {
  return terminiOf(traversal).filter((t): t is RecordedOrigin => t?.terminus === "recorded_origin");
}

/**
 * The frontiers where the chain looped back on itself.
 *
 * Kept separate from {@link recordedOrigins} even though both are COMPLETE
 * dispositions, because they are different answers to the operator's question:
 * "the chain starts at run_a" sends someone to read run_a, "the chain loops
 * a -> b -> a" tells them they are looking at one thing failing repeatedly and
 * there is no earlier run to go and read.
 */
export function cycleReEntries(traversal: CausalTraversal): CycleReEntry[] {
  return terminiOf(traversal).filter((t): t is CycleReEntry => t?.terminus === "cycle_reentry");
}

/**
 * CONVERGENCE POINTS — runs with more than one recorded producer in this
 * traversal. Fan-in, made first-class WITHOUT being a terminus.
 *
 * The operator-facing reason this exists: "what caused this?" has a genuinely
 * different answer at a convergence. A single chain has one story; a run that
 * consumed three upstream outputs has three, and reading only the first is how
 * the wrong one gets rolled back. So the merge points are enumerable rather than
 * left for someone to notice by counting arrows on a graph.
 *
 * WHY THIS IS A QUERY OVER THE EDGE SET AND NOT A `ChainTerminus` BAND. A
 * fan-in node is an ORDINARY INTERIOR NODE: the walk continues through every one
 * of its producers, and each of those branches terminates on its own. A `FanIn`
 * terminus would therefore (a) duplicate information `edgesInto` already
 * carries, and (b) double-count against the branch termini describing the same
 * walk — is the fan-in node's own upstream represented by the fan-in entry, or
 * by the branch termini above it? Both answers break something. The case that
 * genuinely needs naming is a walk that STOPS at a convergence without expanding
 * it, and that is a {@link LostTrail} with kind `convergence_not_followed`,
 * because the chain provably continues in N directions the traversal did not
 * read.
 *
 * @returns each convergence run id with the edges that meet there, ordered by
 *   the node listing so the output is stable.
 */
export function convergencePoints(
  traversal: CausalTraversal
): { runId: string; producers: RecordedCausalEdge[] }[] {
  const found: { runId: string; producers: RecordedCausalEdge[] }[] = [];
  for (const node of soundElements<CausalNode>(traversal?.nodes)) {
    if (typeof node.runId !== "string") continue;
    const producers = edgesInto(traversal, node.runId);
    if (producers.length > 1) found.push({ runId: node.runId, producers });
  }
  return found;
}

// ---------------------------------------------------------------------------
// COHERENCE — do the traversal's own contents agree WITH EACH OTHER?
//
// The class, from `fleet_health.ts`: verifying that a field is PRESENT, and
// internally well-formed, is not the same as verifying that what it carries
// agrees with the rest of the same report. All of it is decidable from the
// traversal's own contents at no extra request, and it is the last line of
// defence before an arrow reaches an operator's screen.
// ---------------------------------------------------------------------------

/** One way a traversal's own contents can contradict each other. */
export type CausalIncoherence =
  /** The entry is not an edge at all — `null`, or not an object. */
  | "malformed_edge"
  /** A numeric field this edge is made of is not a usable number. Checked FIRST: every rule below is a comparison, and every comparison with `NaN` is false, so a `NaN` SKIPS a check rather than failing it. */
  | "unusable_numbers"
  /** `producerRunId === consumerRunId`. A run did not hand off to itself, and a self-loop makes any walk non-terminating. */
  | "self_loop"
  /**
   * A citation whose `recordedInRunId` is NEITHER endpoint of the edge it
   * supports. THE SERIOUS ONE: an edge is only "recorded" because one of its two
   * runs wrote the handoff down. A citation from a third run is a row that
   * mentions both and proves nothing — which is precisely what an inference
   * engine produces when it is dressing a correlation up as a record.
   */
  | "evidence_names_neither_endpoint"
  /** A citation naming a run id that is not the edge's other endpoint. The record does not say what the edge claims. */
  | "evidence_names_wrong_run"
  /** An edge whose endpoints are not both in the traversal's node set. An arrow to nowhere. */
  | "endpoint_not_in_traversal"
  /**
   * AN EDGE THAT CITES NOTHING AT ALL.
   *
   * `recordedBy` is a non-empty tuple TYPE, and on the wire it can still be
   * `[]`. Before this code existed, such an edge returned ZERO incoherences and
   * ZERO unusable fields, and certified as `chain_recorded` — AN EDGE WITH NO
   * EVIDENCE PASSING AS RECORDED, in a feature whose entire premise is
   * recorded-never-inferred.
   *
   * THE DETAIL THAT NAMES THE BUG: an edge with ONE BAD citation was rejected
   * (`evidence_names_neither_endpoint`). NO EVIDENCE GRADED BETTER THAN BAD
   * EVIDENCE — the classic shape of a validator that only inspects what is
   * present. It lives HERE, in the per-edge primitive, and not only in the
   * layers above it: the SDK gate, the backend fold and the web adapter each
   * re-implemented an emptiness check of their own, so all three caught it and
   * the primitive everything new will reach for did not. Redundancy above a hole
   * is what hides the hole.
   */
  | "edge_cites_nothing"
  /**
   * An `artifact_handoff` edge with no citation from the CONSUMER'S OWN LOG
   * saying it CONSUMED the artifact.
   *
   * THE ANSWER TO "IS A SHARED SHA-256 AN EDGE?", ENFORCED. Two runs referencing
   * the same digest is `shared_resource` — a {@link SuspectedLink} — unless the
   * consuming run wrote down that it read that artifact. The checksum makes the
   * coincidence feel like proof, which is exactly what makes it the most
   * dangerous inference in this feature: two runs may both READ the same input,
   * both WRITE the same deterministic output, or reference one blob for
   * unrelated reasons. Without the consumer's own read, there is no dataflow and
   * no direction. See {@link CausalArtifactCitation}.
   */
  | "artifact_handoff_not_cited_by_consumer";

/** How many DISTINCT endpoints this edge's own citations were recorded in. */
export function citedEndpointCount(edge: RecordedCausalEdge): number {
  const endpoints = new Set([edge?.producerRunId, edge?.consumerRunId]);
  return new Set(citationsOf(edge).map((c) => c.recordedInRunId).filter((id) => endpoints.has(id))).size;
}

/**
 * Every way this edge's contents contradict each other or the traversal it sits in.
 *
 * @param edge - the edge to check.
 * @param knownRunIds - every run id in the traversal's node set. Pass an empty
 *   set to skip the membership rule (the SDK always passes the real set).
 * @returns every incoherence found, in a stable order. Empty means the edge does
 *   not refute itself — NOT that the handoff really happened.
 */
export function edgeIncoherences(edge: RecordedCausalEdge, knownRunIds: ReadonlySet<string>): CausalIncoherence[] {
  if (edge === null || typeof edge !== "object") return ["malformed_edge"];

  const citations = citationsOf(edge);
  const numbersUsable =
    isFiniteNumber(edge.handoffAt) &&
    typeof edge.producerRunId === "string" &&
    typeof edge.consumerRunId === "string" &&
    citations.every((c) => isFiniteNumber(c.recordedAt) && typeof c.recordedInRunId === "string");
  // FAILS CLOSED AND RETURNS EARLY. Once a value here is not what it claims to
  // be, the remaining rules cannot be evaluated, and reporting codes derived
  // from partly-garbage input would imply checks that did not happen.
  if (!numbersUsable) return ["unusable_numbers"];

  const found: CausalIncoherence[] = [];
  // EMPTINESS FIRST. Checked before every rule below, all of which inspect
  // citations that are present and therefore say nothing when there are none.
  if (citationsOf(edge).length === 0) found.push("edge_cites_nothing");
  if (edge.producerRunId === edge.consumerRunId) found.push("self_loop");

  const endpoints = new Set([edge.producerRunId, edge.consumerRunId]);
  if (citations.some((c) => !endpoints.has(c.recordedInRunId))) {
    found.push("evidence_names_neither_endpoint");
  }
  // A citation that names a run must name the OTHER endpoint. Artifact
  // citations name no run and are exempt by construction.
  if (
    citations.some(
      (c) =>
        (c.cites === "event" || c.cites === "run_field") &&
        typeof c.namesRunId === "string" &&
        !endpoints.has(c.namesRunId)
    )
  ) {
    found.push("evidence_names_wrong_run");
  }
  if (knownRunIds.size > 0 && (!knownRunIds.has(edge.producerRunId) || !knownRunIds.has(edge.consumerRunId))) {
    found.push("endpoint_not_in_traversal");
  }

  // THE ARTIFACT RULE. A shared digest is a coincidence; a recorded READ by the
  // consumer is a fact. This is the one place the difference is decidable, and
  // it is decidable from the edge's own citations at no extra cost.
  if (
    edge.kind === "artifact_handoff" &&
    !citations.some(
      (c) => c.cites === "artifact" && c.role === "consumed" && c.recordedInRunId === edge.consumerRunId
    )
  ) {
    found.push("artifact_handoff_not_cited_by_consumer");
  }
  return found;
}

/** One incoherence, and the edge it was found in. */
export interface CausalIncoherenceFinding {
  edgeKey: string;
  incoherence: CausalIncoherence;
}

/**
 * Every incoherence in a whole traversal.
 *
 * THE ONE FUNCTION A GATE SHOULD CALL. It is the only entry point holding both
 * the edges and the node set they must live inside, so it is the only one that
 * can catch an arrow to a run the traversal never reached. The SDK refuses any
 * response for which this is non-empty.
 *
 * TOLERATES A NULL ARRAY ELEMENT rather than throwing on it: a validator that
 * throws has handed its caller an unhandled exception instead of a refusal,
 * which on a monitoring loop is an exit code nobody wrote a meaning for.
 */
export function traversalIncoherences(traversal: CausalTraversal): CausalIncoherenceFinding[] {
  const knownRunIds = new Set(
    soundElements<CausalNode>(traversal?.nodes)
      .map((n) => n.runId)
      .filter((id): id is string => typeof id === "string")
  );
  return indexedElements<RecordedCausalEdge>(traversal?.edges).flatMap((edge, index) =>
    edgeIncoherences(edge as RecordedCausalEdge, knownRunIds).map((incoherence) => ({
      // A malformed entry has no key to name itself with, so it is addressed by
      // position — never dropped, because a silently shorter list is how a
      // malformed edge becomes an absent one.
      edgeKey: edge?.edgeKey ?? `(edges[${index}])`,
      incoherence,
    }))
  );
}

// ---------------------------------------------------------------------------
// SELF-CLAIMS — every assertion a traversal makes about its own shape, checked
// against the edge set it ships with.
//
// ---------------------------------------------------------------------------
// THE CLASS, STATED AS THE FAILURE RATHER THAN THE RULE, BECAUSE THE RULE WAS
// ALREADY WRITTEN DOWN IN THIS FILE AND DID NOT HELP
// ---------------------------------------------------------------------------
//
//   VERIFYING THAT A CLAIM IS PRESENT AND INTERNALLY WELL-FORMED IS NOT
//   VERIFYING THAT IT AGREES WITH THE DATA BESIDE IT.
//
// Four defects, all one class, all decidable at no extra request from the edge
// set already in hand:
//
//   1. An edge with `recordedBy: []` certified as `chain_recorded`. Fixed in
//      the per-edge primitive (`edge_cites_nothing`), because that is the
//      layer everything new reaches for.
//   2. A `RecordedOrigin` for run A, whose proof asserts `inboundEdgesFound: 0`
//      WHILE THE SAME TRAVERSAL CARRIES A RECORDED EDGE INTO A. The proof is
//      self-reported and was never checked against the arrows sitting beside
//      it. This is a lost trail certifying as an origin — the exact distinction
//      this feature exists to preserve, defeated by a claim nobody audited.
//   3. A cycle of length >= 2 (A->B->A, A->B->C->A) invisible to every gate,
//      reporting `complete: true` under an origin claim. Only `self_loop` was
//      caught, because length 1 is the only cycle decidable from a SINGLE edge.
//   4. `cyclePath: ['A','GHOST','A']` with no such edges. `unclosed_cycle`
//      validated SYNTACTIC closure only, and a cycle is a COMPLETING
//      disposition — a fabricated loop bought an all-clear.
//
// THE FIX IS ONE THING, NOT FOUR, and the precedent is `REPORT_COLLECTIONS` in
// `fleet_health.ts`: that reporter did not get four hand-written checks, it got
// a table that made it cover four collections of four BY CONSTRUCTION. A
// per-claim check is a LIST, and a list fails the way these bugs failed — by
// being incomplete, silently, at exactly the entry nobody thought about.
//
// So: the graph is built ONCE ({@link buildTraversalGraph}), and every claim
// kind is a key in {@link CLAIM_AUDITS}, a TOTAL Record over
// {@link CausalClaim}. A new claim a traversal can make about itself cannot be
// added without a compile error here demanding its audit. Nothing chooses which
// claims to check at a call site.
//
// DIRECTION IS RESPECTED. "Inbound" is relative to the walk: upstream, a run's
// adjacency is its PRODUCERS; downstream, its CONSUMERS; a component walk, both.
// Auditing an origin against the wrong side would reject every honest
// downstream trace, which is the shape a hasty fix to defect 2 would take.
// ---------------------------------------------------------------------------

/** A kind of assertion a traversal makes about its own shape. Each one has a mandatory audit. */
export type CausalClaim =
  /** Each edge asserts it was recorded. Audited against its own citations. */
  | "edge_is_recorded"
  /** Each `RecordedOrigin` asserts nothing is adjacent to its run. Audited against the edge set. */
  | "origin_has_no_adjacent_edge"
  /**
   * An origin asserts a DIRECTIONAL fact, so only a directed walk can make one.
   * Unrepresentable in typed code (see {@link ComponentTerminus}); audited here
   * because a JSON body is not typechecked by anyone.
   */
  | "origin_is_directional"
  /** Each `CycleReEntry` asserts a real loop. Audited against the edge set. */
  | "cycle_path_is_real"
  /** A cycle present in the edge set asserts nothing — so the traversal must DECLARE it. */
  | "cycles_are_declared"
  /** Each terminus asserts it stopped at a run the walk reached. Audited against the node set. */
  | "terminus_run_was_reached";

/** How a claim contradicted the data beside it. */
export type CausalClaimContradiction =
  /** An edge cites no record at all. See {@link CausalIncoherence.edge_cites_nothing}. */
  | "edge_cites_nothing"
  /**
   * AN ORIGIN CONTRADICTED BY THE EDGE SET IT SHIPS WITH. The proof says the
   * adjacent edge set is empty; the traversal carries an adjacent edge. One of
   * the two is false, and the safe reading is that the walk did not end.
   */
  | "origin_contradicted_by_adjacent_edge"
  /** A `cyclePath` naming a hop that is not a recorded edge in this traversal. A fabricated loop. */
  | "cycle_path_not_in_edge_set"
  /**
   * A CYCLE THE TRAVERSAL DID NOT DECLARE. The edge set loops and no
   * `cycle_reentry` terminus names any run in the loop, so the walk is claiming
   * to have terminated some other way over a graph that provably re-enters
   * itself.
   */
  | "undeclared_cycle"
  /** A terminus naming a run absent from the node set. A frontier nobody can go and read. */
  | "terminus_run_not_reached"
  /**
   * A COMPONENT WALK CLAIMED AN ORIGIN. A component closed both sides, so
   * "nothing produced this" is a claim it structurally cannot have established —
   * not an unlucky answer, a category error. Reported distinctly from
   * `origin_contradicted_by_adjacent_edge` so an engine author reads "you asked
   * a direction-free scan a directional question" rather than "your edge set
   * disagrees", which would send them looking in the wrong place.
   */
  | "component_origin_claimed";

/** One contradiction, and what it was found in. */
export interface CausalClaimFinding {
  claim: CausalClaim;
  contradiction: CausalClaimContradiction;
  /** e.g. `"edges[e_ab]"`, `"termini[0]"`, `"edges(cycle: run_a -> run_b -> run_a)"`. */
  at: string;
}

/** The graph, indexed once, so no audit re-walks the edge list. */
interface TraversalGraph {
  edges: RecordedCausalEdge[];
  nodeIds: ReadonlySet<string>;
  /** `${producerRunId}->${consumerRunId}` for every recorded edge. */
  hops: ReadonlySet<string>;
  /** Runs by the direction of the walk: what counts as "adjacent" for an origin claim. */
  adjacentOf: (runId: string) => RecordedCausalEdge[];
  /** Every cycle found among the recorded edges, each as a closed path. */
  cycles: string[][];
}

/** Producer -> consumers, over sound edges only. */
function outboundIndex(edges: readonly RecordedCausalEdge[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const edge of edges) {
    if (typeof edge.producerRunId !== "string" || typeof edge.consumerRunId !== "string") continue;
    const existing = index.get(edge.producerRunId);
    if (existing === undefined) index.set(edge.producerRunId, [edge.consumerRunId]);
    else existing.push(edge.consumerRunId);
  }
  return index;
}

/**
 * Every cycle among the recorded edges.
 *
 * ONLY `self_loop` WAS EVER CAUGHT BEFORE THIS, and the reason is worth stating:
 * a length-1 cycle is decidable from a SINGLE edge, and every check in
 * {@link edgeIncoherences} sees one edge at a time. A cycle of length two or
 * more is a property of the edge SET and is structurally invisible to a per-edge
 * validator — the same gap as the origin and cycle-path claims, which is why all
 * three are audited here and not there.
 *
 * BOUNDED AND ITERATIVE. A forward walk from each node, with a visited set, so
 * it terminates on any input including one deliberately malformed — a validator
 * that hangs at a boundary is worse than one that returns a wrong answer.
 * Traversals are capped at {@link MAX_CAUSAL_NODES}, so the cost is bounded too.
 */
function findCycles(edges: readonly RecordedCausalEdge[]): string[][] {
  const outbound = outboundIndex(edges);
  const found: string[][] = [];
  const seenCycleKeys = new Set<string>();

  for (const start of outbound.keys()) {
    // Breadth-first from `start`, recording predecessors, looking for a path
    // back to `start`.
    const predecessor = new Map<string, string>();
    const visited = new Set<string>([start]);
    let frontier = [start];
    let closed: string | undefined;
    while (frontier.length > 0 && closed === undefined) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const consumer of outbound.get(current) ?? []) {
          if (consumer === start) {
            predecessor.set(`__closed__`, current);
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
    if (closed === undefined) continue;

    // Reconstruct start -> ... -> closed -> start.
    const path: string[] = [start];
    const back: string[] = [];
    let cursor: string | undefined = closed;
    // `visited` bounds this loop; `predecessor` is acyclic by construction.
    while (cursor !== undefined && cursor !== start) {
      back.push(cursor);
      cursor = predecessor.get(cursor);
    }
    path.push(...back.reverse(), start);

    // One entry per distinct loop, keyed on its member set so the same cycle
    // discovered from two starting points is reported once.
    const key = [...new Set(path)].sort().join("|");
    if (seenCycleKeys.has(key)) continue;
    seenCycleKeys.add(key);
    found.push(path);
  }
  return found;
}

/** Index the traversal once. Direction-aware, because "adjacent" means the side the walk came from. */
function buildTraversalGraph(traversal: CausalTraversal): TraversalGraph {
  const edges = edgesOf(traversal);
  const nodeIds = new Set(
    soundElements<CausalNode>(traversal?.nodes)
      .map((n) => n.runId)
      .filter((id): id is string => typeof id === "string")
  );
  const hops = new Set(edges.map((e) => `${e.producerRunId}->${e.consumerRunId}`));
  const direction = traversal?.scan?.direction;
  const adjacentOf = (runId: string): RecordedCausalEdge[] => {
    // Walking UPSTREAM, a run's adjacency is what PRODUCED it. Walking
    // DOWNSTREAM, it is what CONSUMED it. A component walk closed both sides, so
    // either arrow contradicts an origin. Getting this backwards would reject
    // every honest downstream trace.
    if (direction === "downstream") return edges.filter((e) => e.producerRunId === runId);
    if (direction === "component") {
      return edges.filter((e) => e.producerRunId === runId || e.consumerRunId === runId);
    }
    return edges.filter((e) => e.consumerRunId === runId);
  };
  return { edges, nodeIds, hops, adjacentOf, cycles: findCycles(edges) };
}

/**
 * EVERY CLAIM KIND, WITH ITS MANDATORY AUDIT.
 *
 * A TOTAL `Record` over {@link CausalClaim}, so a new claim a traversal can make
 * about itself is a COMPILE ERROR here until somebody writes the check that
 * audits it against the data beside it. That is the whole repair: not four more
 * checks, but a shape in which "we forgot to audit that claim" cannot be
 * expressed.
 */
const CLAIM_AUDITS: Record<
  CausalClaim,
  (graph: TraversalGraph, traversal: CausalTraversal) => CausalClaimFinding[]
> = {
  edge_is_recorded: (graph) =>
    graph.edges
      .filter((edge) => citationsOf(edge).length === 0)
      .map((edge) => ({
        claim: "edge_is_recorded",
        contradiction: "edge_cites_nothing",
        at: `edges[${edge.edgeKey}]`,
      })),

  origin_is_directional: (_graph, traversal) =>
    traversal?.scan?.direction !== "component"
      ? []
      : recordedOrigins(traversal).map((origin) => ({
          claim: "origin_is_directional" as const,
          contradiction: "component_origin_claimed" as const,
          at: `termini(origin:${origin.originRunId})`,
        })),

  origin_has_no_adjacent_edge: (graph, traversal) =>
    // A component walk's origins are reported by `origin_is_directional`, whose
    // message names the actual mistake. Reporting both would tell an engine
    // author their edge set disagrees when the real answer is that they asked a
    // direction-free scan a directional question.
    traversal?.scan?.direction === "component"
      ? []
      : recordedOrigins(traversal)
      .filter((origin) => graph.adjacentOf(origin.originRunId).length > 0)
      .map((origin) => ({
        claim: "origin_has_no_adjacent_edge",
        contradiction: "origin_contradicted_by_adjacent_edge",
        at: `termini(origin:${origin.originRunId})`,
      })),

  cycle_path_is_real: (graph, traversal) =>
    cycleReEntries(traversal).flatMap((cycle) => {
      const path = Array.isArray(cycle.cyclePath) ? cycle.cyclePath : [];
      const missing = path
        .slice(0, -1)
        .map((from, i) => `${from}->${path[i + 1]}`)
        .filter((hop) => !graph.hops.has(hop));
      return missing.map((hop) => ({
        claim: "cycle_path_is_real" as const,
        contradiction: "cycle_path_not_in_edge_set" as const,
        at: `termini(cycle:${cycle.reEnteredRunId}) hop ${hop}`,
      }));
    }),

  cycles_are_declared: (graph, traversal) => {
    const declared = new Set(cycleReEntries(traversal).map((c) => c.reEnteredRunId));
    return graph.cycles
      .filter((cycle) => !cycle.some((runId) => declared.has(runId)))
      .map((cycle) => ({
        claim: "cycles_are_declared" as const,
        contradiction: "undeclared_cycle" as const,
        at: `edges(cycle: ${cycle.join(" -> ")})`,
      }));
  },

  terminus_run_was_reached: (graph, traversal) =>
    terminiOf(traversal)
      .map((terminus, index) => ({ terminus, index }))
      .filter(({ terminus }) => {
        const runId = terminusRunId(terminus);
        // Only audit termini whose run id is readable; an unreadable one is
        // already reported by `traversalUnusableFields` and blocks separately.
        return typeof runId === "string" && graph.nodeIds.size > 0 && !graph.nodeIds.has(runId);
      })
      .map(({ index }) => ({
        claim: "terminus_run_was_reached" as const,
        contradiction: "terminus_run_not_reached" as const,
        at: `termini[${index}]`,
      })),
};

/**
 * The run a terminus stopped at, whichever disposition it is.
 *
 * THE ONE PLACE IN THIS CODEBASE THAT COLLAPSES THE THREE RUN-ID FIELDS, and it
 * is deliberately NOT exported. The whole point of `originRunId` /
 * `reEnteredRunId` / `lastReachedRunId` being different names is that no
 * renderer can print one as another; a shared accessor handed to consumers would
 * re-open exactly that. This is an internal audit that needs the id purely to
 * check set membership, never to say anything about it.
 */
function terminusRunId(terminus: ChainTerminus | null | undefined): string | undefined {
  if (terminus === null || terminus === undefined) return undefined;
  if (terminus.terminus === "recorded_origin") return terminus.originRunId;
  if (terminus.terminus === "cycle_reentry") return terminus.reEnteredRunId;
  if (terminus.terminus === "trail_lost") return terminus.lastReachedRunId;
  return undefined;
}

/**
 * Every claim this traversal makes about its own shape that the data beside it
 * contradicts.
 *
 * THE ONE FUNCTION A GATE SHOULD CALL FOR SELF-CONSISTENCY, alongside
 * {@link traversalUnusableFields}. It builds the graph once and runs every
 * entry in {@link CLAIM_AUDITS}, so coverage is a property of the table rather
 * than of whoever last edited a gate.
 *
 * MUST NEVER THROW: it runs at a boundary on a body nothing has vouched for.
 *
 * @returns every contradiction, claim by claim in a stable order. Empty means
 *   the traversal's claims agree with its own edges — NOT that its edges are
 *   true.
 */
export function traversalClaimContradictions(traversal: CausalTraversal): CausalClaimFinding[] {
  if (traversal === null || typeof traversal !== "object") return [];
  const graph = buildTraversalGraph(traversal);
  return (Object.keys(CLAIM_AUDITS) as CausalClaim[]).flatMap((claim) => CLAIM_AUDITS[claim](graph, traversal));
}

// ---------------------------------------------------------------------------
// USABILITY — is what arrived something arithmetic can be done with AT ALL?
//
// The prior question to coherence, and genuinely different: a guard written as
// a comparison (`x <= 0`, `if (x.truncated)`) does not reject a non-number, it
// takes the other branch, and whether that branch is safe is luck. Asked
// directly, once, for every field that feeds a verdict, a gate or the display —
// and the SDK REFUSES a traversal that fails it.
// ---------------------------------------------------------------------------

/** Why a field's contents cannot be used. Facts about the VALUE, never about any run. */
export type CausalUnusableReason =
  /** Missing entirely, or present as something that is not a non-negative integer. */
  | "not_a_count"
  /**
   * An event citation's `sequenceNumber` is not a positive integer. `0` is the
   * case this exists for: Event Log Rule 4 starts sequences at 1, so a `0` is a
   * sentinel written where the real position was lost — and a sentinel inside
   * the data's own domain reads as a measurement.
   */
  | "not_a_sequence_number"
  /** Present but not a finite number. */
  | "not_a_finite_number"
  /** A flag that is not a boolean. Fails CLOSED: a dropped flag must never read as `false`. */
  | "not_a_boolean"
  /** A closed-vocabulary field carrying a value this contract does not define. */
  | "not_a_known_value"
  /** An array element that is not an object at all. */
  | "malformed_element"
  /**
   * A `recorded_origin` terminus whose proof does not establish anything — a
   * missing/empty `establishedBy`, a proof that did not read the complete edge
   * set, or one that found an edge.
   *
   * THE CHECK THIS FEATURE EXISTS FOR, AT THE WIRE. The type system makes an
   * unproven origin unspellable in OUR code; a JSON body is not typechecked, and
   * an origin without a proof is a LOST TRAIL WEARING AN ORIGIN'S CLOTHES —
   * which is the one output that tells an operator to stop investigating.
   */
  | "unproven_origin"
  /**
   * A `cycle_reentry` terminus whose `cyclePath` is not a closed loop naming the
   * run it claims to re-enter.
   *
   * THE SAME CHECK AS `unproven_origin`, FOR THE OTHER COMPLETE DISPOSITION. A
   * cycle terminates a frontier cleanly and lets a trace exit 0, so a fabricated
   * one buys a clean exit exactly as a fabricated origin does — and it is the
   * easier forgery, because a `LostTrail` an engine cannot be bothered to
   * explain is one relabel away from "oh, it looped".
   */
  | "unclosed_cycle";

/** One unusable field, addressed by a path a human can act on. */
export interface CausalUnusableFieldFinding {
  /** e.g. `"scan.maxDepthRequested"`, `"edges[e1].handoffAt"`, `"termini[0]"`. */
  path: string;
  reason: CausalUnusableReason;
}

/**
 * Every field in a traversal whose contents cannot be used.
 *
 * THE ONE FUNCTION A BOUNDARY SHOULD CALL, and it must run BEFORE
 * {@link traversalIncoherences} and before any verdict is computed — both do
 * arithmetic, and arithmetic on a string is how a lost trail becomes an origin.
 *
 * MUST NEVER THROW. It runs at a boundary, on a JSON body nothing has vouched
 * for, so every collection it walks is checked before it is walked.
 */
export function traversalUnusableFields(traversal: CausalTraversal): CausalUnusableFieldFinding[] {
  const found: CausalUnusableFieldFinding[] = [];
  const count = (value: unknown, path: string): void => {
    if (!isCount(value)) found.push({ path, reason: "not_a_count" });
  };
  const finite = (value: unknown, path: string): void => {
    if (!isFiniteNumber(value)) found.push({ path, reason: "not_a_finite_number" });
  };
  const bool = (value: unknown, path: string): void => {
    if (typeof value !== "boolean") found.push({ path, reason: "not_a_boolean" });
  };

  finite(traversal?.analyzedAt, "analyzedAt");

  const scan = (traversal?.scan ?? {}) as unknown as Record<string, unknown>;
  count(scan["maxDepthRequested"], "scan.maxDepthRequested");
  count(scan["deepestReached"], "scan.deepestReached");
  count(scan["runsVisited"], "scan.runsVisited");
  count(scan["edgesRead"], "scan.edgesRead");
  bool(scan["scanTruncated"], "scan.scanTruncated");
  bool(scan["edgeSetsComplete"], "scan.edgeSetsComplete");
  if (scan["direction"] !== "upstream" && scan["direction"] !== "downstream" && scan["direction"] !== "component") {
    found.push({ path: "scan.direction", reason: "not_a_known_value" });
  }

  // MALFORMED ELEMENTS FIRST, FOR EVERY COLLECTION, DRIVEN BY THE TABLE — so
  // this reporter cannot cover four of five. `fleet_health.ts` covered three of
  // four, and the one it missed was precisely the completeness-bearing one.
  for (const { collection, index } of malformedElements(traversal)) {
    found.push({ path: `${collection}[${index}]`, reason: "malformed_element" });
  }

  for (const edge of edgesOf(traversal)) {
    const at = `edges[${edge.edgeKey}]`;
    finite(edge.handoffAt, `${at}.handoffAt`);
    for (const [i, citation] of indexedElements<CausalEvidence>(edge.recordedBy).entries()) {
      if (citation === null) {
        found.push({ path: `${at}.recordedBy[${i}]`, reason: "malformed_element" });
        continue;
      }
      finite(citation.recordedAt, `${at}.recordedBy[${i}].recordedAt`);
      if (citation.cites === "event" && !(isCount(citation.sequenceNumber) && citation.sequenceNumber >= 1)) {
        // Event Log Rule 4: sequence numbers start at 1. A `0` is a sentinel
        // somebody wrote where the real value was lost — see
        // `CausalEventCitation.sequenceNumber`.
        found.push({ path: `${at}.recordedBy[${i}].sequenceNumber`, reason: "not_a_sequence_number" });
      }
    }
  }

  for (const [i, terminus] of terminiOf(traversal).entries()) {
    const at = `termini[${i}]`;
    if (terminus.terminus === "recorded_origin") {
      count(terminus.hopsToOrigin, `${at}.hopsToOrigin`);
      // THE ONE THAT MATTERS MOST. An origin is a claim that the investigation
      // is over; without a complete, empty adjacency read behind it, the honest
      // answer was `trail_lost` and the two are opposite claims about the same
      // run id.
      const proofs = soundElements<OriginProof>(
        (terminus as unknown as Record<string, unknown>)["establishedBy"]
      );
      const proven =
        proofs.length > 0 &&
        proofs.every(
          (p) => p.inboundReadComplete === true && p.inboundEdgesFound === 0 && p.runId === terminus.originRunId
        );
      if (!proven) found.push({ path: `${at}.establishedBy`, reason: "unproven_origin" });
    } else if (terminus.terminus === "cycle_reentry") {
      count(terminus.hopsToReEntry, `${at}.hopsToReEntry`);
      // A cycle is a COMPLETE disposition, so a fabricated one buys a clean
      // exit exactly as a fabricated origin does. Its path must at least be a
      // real, closed loop naming the run it claims to re-enter.
      const path = (terminus as unknown as Record<string, unknown>)["cyclePath"];
      const closed =
        Array.isArray(path) &&
        path.length >= 2 &&
        path.every((id) => typeof id === "string") &&
        path[0] === terminus.reEnteredRunId &&
        path[path.length - 1] === terminus.reEnteredRunId;
      if (!closed) found.push({ path: `${at}.cyclePath`, reason: "unclosed_cycle" });
    } else if (terminus.terminus === "trail_lost") {
      count(terminus.hopsBeforeLoss, `${at}.hopsBeforeLoss`);
    } else {
      found.push({ path: `${at}.terminus`, reason: "not_a_known_value" });
    }
  }

  for (const node of soundElements<CausalNode>(traversal?.nodes)) {
    const at = `nodes[${node.runId}]`;
    count(node.hopsFromSubject, `${at}.hopsFromSubject`);
    if (
      node.adjacency !== "edge_recorded" &&
      node.adjacency !== "no_edge_recorded" &&
      node.adjacency !== "adjacency_unread"
    ) {
      // Fails closed rather than being read as either. "No edge here" and "I do
      // not know whether there is an edge here" are the two answers this field
      // exists to keep apart; a third value is not a deployment to guess at.
      found.push({ path: `${at}.adjacency`, reason: "not_a_known_value" });
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Bound on a traversal's node listing before `nextCursor` is set. */
export const MAX_CAUSAL_NODES = 200;

/** Default hop ceiling for a walk. A judgement call, which is why it is a parameter and is echoed and verified. */
export const DEFAULT_CAUSAL_MAX_DEPTH = 10;

/**
 * The edges into a run (the runs that produced its input), in walk order.
 *
 * @param traversal - the traversal to read.
 * @param runId - the run to look at.
 */
export function edgesInto(traversal: CausalTraversal, runId: string): RecordedCausalEdge[] {
  return edgesOf(traversal).filter((e) => e.consumerRunId === runId);
}

/** The edges out of a run (the runs that consumed its output), in walk order. */
export function edgesOutOf(traversal: CausalTraversal, runId: string): RecordedCausalEdge[] {
  return edgesOf(traversal).filter((e) => e.producerRunId === runId);
}

/**
 * How many runs consumed this traversal's subject's output, transitively —
 * the BLAST RADIUS, and the number `afr cause --fail-on` gates on.
 *
 * A FLOOR WHENEVER THE TRAVERSAL IS INCOMPLETE, and callers must say so. It
 * counts what was reached; a lost trail downstream means more runs consumed the
 * output than this number admits. {@link isCausalTraversalComplete} is what
 * tells a caller which of the two it is holding, and `afr cause` prints the
 * distinction on the same line as the number rather than below it.
 *
 * @param traversal - the traversal to measure.
 * @returns distinct runs downstream of the subject, excluding the subject.
 */
export function downstreamRunCount(traversal: CausalTraversal): number {
  const subject = traversal?.subjectRunId;
  const reached = new Set<string>();
  const frontier: string[] = [subject];
  const seen = new Set<string>([subject]);
  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    for (const edge of edgesOutOf(traversal, current)) {
      if (seen.has(edge.consumerRunId)) continue;
      seen.add(edge.consumerRunId);
      reached.add(edge.consumerRunId);
      frontier.push(edge.consumerRunId);
    }
  }
  return reached.size;
}
