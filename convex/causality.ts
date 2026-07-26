// ---------------------------------------------------------------------------
// CROSS-RUN CAUSAL GRAPH — the Convex surface.
//
// Three questions, one traversal:
//
//   UPWARD    `traceRunOrigin`  — what caused this run?
//   DOWNWARD  `traceRunImpact`  — what ran on this run's output? (the question
//                                 nobody could answer before this file, and the
//                                 one an autonomous company needs before it can
//                                 decide a blast radius)
//   BOTH      `getIncidentGraph` — the connected component around a run.
//
// The vocabulary is `packages/contracts/src/causality.ts`, imported not
// mirrored. The pure fold is `convex/helpers/causal_graph.ts`. THIS FILE OWNS
// EXACTLY THREE THINGS the pure engine cannot: authorization, org scoping at
// every hop, and the bounded walk.
//
// ===========================================================================
// THE LOG IS THE RECORD. THIS FILE READS AN INDEX OVER IT.
// ===========================================================================
//
// A causal handoff is recorded in the append-only event log — an event in one
// run's log NAMING the other run's id (convex/helpers/causal_derive.ts) — or on
// the immutable `runs.parentRunId` field. `run_causal_edges` is a DERIVED,
// REBUILDABLE INDEX over those records and nothing more, for one reason: "which
// OTHER run's log names run X?" is a lookup keyed on a value buried inside
// `payload`, which is `v.any()`, and no index the events table can carry
// answers it.
//
// An earlier draft made that table the record itself. That was wrong. A side
// table is mutable and deletable, so a lost row silently relaunders the fact —
// and the absence of an edge row is INDISTINGUISHABLE from "there was never a
// handoff", which is exactly the recorded-origin-versus-lost-trail distinction
// this feature exists to preserve, defeated by its own storage.
//
// {@link rebuildRunCausalEdges} is what keeps the index honest: it deletes every
// row projected from a run's log and re-derives them from that log alone. If a
// row cannot be rebuilt, it should not exist.
//
// ===========================================================================
// ORG SCOPING IS PER-HOP, NOT PER-CALL
// ===========================================================================
//
// A traversal is the one shape in this product where "check the org at the entry
// point" is not enough. Every other query reads one org-indexed range and
// returns it. A traversal reads a run, then a run that run points at, then a run
// THAT run points at — and a single mis-stamped historical row anywhere in that
// chain walks the reader into another tenant's data with the entry-point check
// long since passed.
//
// Two independent mechanisms, either alone sufficient:
//
//   1. STRUCTURAL. Every edge read goes through an ORG-PREFIXED index
//      (`run_causal_edges.by_org_consumer` / `.by_org_producer`,
//      `runs.by_org_parent`) with the caller's own orgId bound. A foreign row is
//      not filtered out after being read; it is not in the range.
//
//   2. RE-CHECKED. Every `ctx.db.get` on a run re-checks `run.orgId` before the
//      run is admitted as an observation.
//
// AND THE FAILURE IS SILENT, DELIBERATELY. A hop that leaves the org yields no
// observation — identical, byte for byte, to a hop into a run that never existed
// or has been deleted by retention. It does not throw and does not log a
// distinguishable code. A distinguishable "forbidden" would be a cross-org
// existence oracle: point a traversal at a guessed id and read the error to
// learn whether it is real. `convex/tenancy_oracle.test.ts` established this
// pattern; this file extends it from the first hop to every hop.
//
// ===========================================================================
// NO `.paginate()`, AND WHY THAT IS THE RIGHT CALL RATHER THAN A GAP
// ===========================================================================
//
// The one-`.paginate()`-per-execution budget is spent on nothing here. A cursor
// over a graph frontier is a cursor over a set the NEXT page's own traversal
// would change underneath it: page 2 of "the runs 3 hops downstream" is not a
// stable range, it is a re-derivation. Paging it produces a report that is
// internally inconsistent in a way no field can express.
//
// The resumption story is explicit re-rooting instead: every unexpanded frontier
// becomes a `LostTrail` NAMING THE RUN, with `wouldBeRecoveredBy` telling the
// caller to re-root there. That composes correctly (each traversal is internally
// consistent), it is honest, and it is the only form that survives a graph
// mutating between calls.
// ---------------------------------------------------------------------------

import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { deriveEdgeClaims } from "./helpers/causal_derive.js";
import {
  CAUSAL_MAX_EDGES,
  CAUSAL_MAX_FANOUT,
  CAUSAL_MAX_SESSION_SIBLINGS,
  clampCausalDepth,
  foldCausalGraph,
  MAX_CAUSAL_NODES,
  type CausalDirection,
  type CausalEdgeObservation,
  type CausalFrontierObservation,
  type CausalNodeObservation,
  type CausalTraversal,
} from "./helpers/causal_graph.js";
import { afrError } from "./helpers/errors.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

/** Events read per run when re-deriving that run's edges. Bounds the rebuild. */
const REBUILD_EVENT_SCAN_LIMIT = 5_000;

/**
 * Artifact rows read per run for the `shared_resource` suspicion, and the number
 * of runs that read is done for at all.
 *
 * DELIBERATELY SMALL. This read buys a SUSPICION, never an edge, so it must
 * never be the reason a traversal is expensive — and a suspicion is a prompt to
 * go and instrument something, which one example serves as well as fifty.
 */
const ARTIFACT_SCAN_PER_RUN = 10;
const ARTIFACT_SCAN_RUN_LIMIT = 25;

// ===========================================================================
// PROJECTION — log -> index
// ===========================================================================

/**
 * Project one stored event into `run_causal_edges` rows.
 *
 * Called at event-insert time from both write paths (the payload is already in
 * hand, so this costs no extra read), and again by {@link rebuildRunCausalEdges}
 * from the log alone. IDEMPOTENT on (org, producer, consumer, kind): a resend, a
 * retry, or a rebuild returns the existing row rather than inserting a
 * duplicate, which would otherwise inflate every fan-out count in the graph.
 *
 * TENANCY: the named run must be in the same org, and a run outside it is
 * dropped SILENTLY and identically to one that does not exist. A payload
 * carrying a foreign or fabricated run id therefore produces no edge, with
 * nothing in the outcome revealing which it was.
 */
export async function projectEventCausalEdges(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<number> {
  const claims = deriveEdgeClaims(event.payload);
  if (claims.length === 0) return 0;

  const self = await ctx.db.get(event.runId);
  if (!self || self.orgId !== event.orgId) return 0;

  let written = 0;
  for (const claim of claims) {
    // The payload's id is an untrusted string. It must resolve, in this org.
    let other: Doc<"runs"> | null = null;
    try {
      other = await ctx.db.get(claim.namedRunId as Id<"runs">);
    } catch {
      other = null; // malformed id — indistinguishable from missing, on purpose
    }
    if (!other || other.orgId !== event.orgId) continue;
    if (other._id === event.runId) continue; // a run cannot hand off to itself

    const producerRunId = claim.recordingRunIs === "producer" ? event.runId : other._id;
    const consumerRunId = claim.recordingRunIs === "producer" ? other._id : event.runId;

    const existing = await ctx.db
      .query("run_causal_edges")
      .withIndex("by_org_triple", (q) =>
        q
          .eq("orgId", event.orgId)
          .eq("producerRunId", producerRunId)
          .eq("consumerRunId", consumerRunId)
          .eq("kind", claim.kind),
      )
      .unique();
    if (existing !== null) continue;

    await ctx.db.insert("run_causal_edges", {
      orgId: event.orgId,
      producerRunId,
      consumerRunId,
      kind: claim.kind,
      // FROM THE EVENT, never from `Date.now()`. The handoff happened when the
      // event says it did; a rebuild months later must produce the same row.
      handoffAt: event.timestamp,
      derivedFromRunId: event.runId,
      citation: {
        cites: "event",
        eventId: event._id,
        sequenceNumber: event.sequenceNumber,
        eventType: event.type,
        payloadPath: claim.payloadPath,
      },
    });
    written += 1;
  }
  return written;
}

/**
 * Delete every row projected from one run's log, then re-derive them from that
 * log alone.
 *
 * THIS IS THE FUNCTION THAT MAKES "DERIVED INDEX" A CLAIM RATHER THAN A COMMENT.
 * A test asserts the row set before and after is identical; if it were not, the
 * table would be carrying facts the log does not, which is precisely what it is
 * forbidden to do.
 *
 * INTERNAL: it deletes rows, so it is not reachable from a client. Retention and
 * an operator repair path are its only callers.
 */
export const rebuildRunCausalEdges = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    // THE RUN IS GONE, SO ITS LOG IS GONE, so nothing can be rebuilt from it —
    // and `runMissing` says so rather than returning zeros that read as a
    // successful no-op rebuild. Any rows still projected from this run's log are
    // now unrebuildable, which is exactly what the retention cascade
    // ({@link deleteCausalEdgesForRun}) must remove BEFORE the run is deleted.
    // This function cannot do it itself: the rows are keyed by orgId, and the
    // only place the orgId could have been read from is the run that no longer
    // exists.
    if (!run) {
      return {
        deleted: 0,
        unreclaimable: 0,
        rebuilt: 0,
        eventsScanned: 0,
        scanTruncated: false,
        runMissing: true,
      };
    }

    // ---- RECLAMATION. Two passes, and the second is the one that closes the
    // ---- hole rebuildability would otherwise have.
    //
    // PASS 1: rows this run's log produced. The ordinary case.
    const derived = await ctx.db
      .query("run_causal_edges")
      .withIndex("by_org_derived_from", (q) =>
        q.eq("orgId", run.orgId).eq("derivedFromRunId", args.runId),
      )
      .collect();

    // PASS 2: rows that name this run as an ENDPOINT but are keyed to a THIRD
    // run's log.
    //
    // WHY THIS EXISTS. Reclamation keys on `(orgId, derivedFromRunId)`, and
    // nothing in the schema enforces that `derivedFromRunId` is one of the row's
    // own two endpoints — the contract requires it of a citation
    // (`CausalEvidence.recordedInRunId` must be an endpoint) but a stored row is
    // not typechecked by anyone. A row naming a BYSTANDER as its source survives
    // rebuilding both of its endpoints, because neither rebuild's index range
    // contains it, while remaining fully visible to the walk as an edge. It is
    // the single row the rebuild property cannot reach, and the rebuild property
    // is the whole basis for calling this table derived rather than a second
    // source of truth.
    //
    // NARROW TODAY, AND THAT IS NOT A REASON TO LEAVE IT: exactly one module
    // inserts here, always with `derivedFromRunId = event.runId`, which is an
    // endpoint by construction — so no shipped surface can forge one. This is a
    // repair-path gap, closed here so the invariant is enforced by the reclaimer
    // rather than by an argument about who currently writes.
    //
    // Such a row is DELETED, not re-keyed: its claimed provenance is false, and
    // if the log genuinely records the handoff, pass 3 below re-derives it with
    // a truthful citation.
    const asEndpoint = [
      ...(await ctx.db
        .query("run_causal_edges")
        .withIndex("by_org_producer", (q) =>
          q.eq("orgId", run.orgId).eq("producerRunId", args.runId),
        )
        .collect()),
      ...(await ctx.db
        .query("run_causal_edges")
        .withIndex("by_org_consumer", (q) =>
          q.eq("orgId", run.orgId).eq("consumerRunId", args.runId),
        )
        .collect()),
    ];
    const unreclaimable = asEndpoint.filter(
      (row) =>
        row.derivedFromRunId !== row.producerRunId &&
        row.derivedFromRunId !== row.consumerRunId,
    );

    const seen = new Set<string>();
    const stale = [...derived, ...unreclaimable].filter((row) => {
      if (seen.has(row._id)) return false;
      seen.add(row._id);
      return true;
    });
    for (const row of stale) await ctx.db.delete(row._id);

    const events = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(REBUILD_EVENT_SCAN_LIMIT + 1);
    const scanTruncated = events.length > REBUILD_EVENT_SCAN_LIMIT;

    let rebuilt = 0;
    for (const event of events.slice(0, REBUILD_EVENT_SCAN_LIMIT)) {
      rebuilt += await projectEventCausalEdges(ctx, event);
    }
    return {
      deleted: stale.length,
      /** Of `deleted`, how many were rows keyed to a run that is not an endpoint. */
      unreclaimable: unreclaimable.length,
      rebuilt,
      eventsScanned: Math.min(events.length, REBUILD_EVENT_SCAN_LIMIT),
      scanTruncated,
      runMissing: false,
    };
  },
});

/**
 * Drop every index row projected from a run's log. Called by the retention
 * cascade when the run (and therefore its log) is deleted.
 *
 * A CASCADE, NOT AN ORPHAN SWEEP, and the distinction matters: the row's own
 * source of truth is exactly that run's log and no other, so once the log is
 * gone the row is unrebuildable — and an unrebuildable row in a derived index is
 * a fact with no record behind it, which is the thing this table must never
 * hold.
 *
 * Rows projected from the OTHER endpoint's log survive DELIBERATELY: that log
 * still exists and still records the handoff. The traversal then finds an edge
 * naming a run it cannot read and reports a `LostTrail` with kind
 * `adjacent_run_unavailable` — which is the truth, and is exactly the
 * distinction this feature exists to preserve.
 */
export async function deleteCausalEdgesForRun(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  runId: Id<"runs">,
): Promise<number> {
  const rows = await ctx.db
    .query("run_causal_edges")
    .withIndex("by_org_derived_from", (q) => q.eq("orgId", orgId).eq("derivedFromRunId", runId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

// ===========================================================================
// THE BOUNDED WALK
// ===========================================================================

interface WalkResult {
  nodes: CausalNodeObservation[];
  edges: CausalEdgeObservation[];
  frontier: CausalFrontierObservation[];
  scanTruncated: boolean;
}

/**
 * Observe one run, IN THE CALLER'S ORG.
 *
 * Returns `null` for a run that does not exist, has been deleted, or belongs to
 * another organization — three situations that MUST be one outcome here.
 */
async function observeRun(
  ctx: QueryCtx,
  runId: Id<"runs">,
  orgId: Id<"organizations">,
): Promise<Doc<"runs"> | null> {
  const run = await ctx.db.get(runId);
  if (!run || run.orgId !== orgId) return null;
  return run;
}

/**
 * A bounded sample of OTHER runs sharing this run's session.
 *
 * NON-CAUSAL. It becomes a `SuspectedLink` — directionless, unwalkable, unable
 * to move the verdict. Nothing traverses a session, and this is deliberately the
 * only place a session is read in this file, so "did we accidentally traverse
 * sessions?" is answerable by reading one call site rather than auditing the
 * walk.
 */
async function sessionSiblings(
  ctx: QueryCtx,
  run: Doc<"runs">,
  orgId: Id<"organizations">,
): Promise<string[]> {
  if (run.sessionId === undefined) return [];
  const siblings = await ctx.db
    .query("runs")
    .withIndex("by_org_session", (q) => q.eq("orgId", orgId).eq("sessionId", run.sessionId))
    .take(CAUSAL_MAX_SESSION_SIBLINGS + 1);
  return siblings.filter((s) => s._id !== run._id).map((s) => s._id);
}

/**
 * Is this index row's claimed provenance possible?
 *
 * `derivedFromRunId` is the log the row says it came from, and the contract
 * requires a citation's `recordedInRunId` to be one of the edge's own two
 * endpoints — a run's log cannot record a handoff it was not part of. A row
 * failing this is malformed, so the walk DROPS it rather than handing back an
 * edge whose citation names neither of its ends.
 *
 * Defence in depth beside the reclamation pass in `rebuildRunCausalEdges`: the
 * reclaimer removes such a row, this makes it invisible in the meantime.
 */
function citationIsPossible(row: Doc<"run_causal_edges">): boolean {
  return row.derivedFromRunId === row.producerRunId || row.derivedFromRunId === row.consumerRunId;
}

function toObservation(row: Doc<"run_causal_edges">): CausalEdgeObservation {
  const namesRunId =
    row.derivedFromRunId === row.producerRunId ? row.consumerRunId : row.producerRunId;
  return {
    producerRunId: row.producerRunId,
    consumerRunId: row.consumerRunId,
    kind: row.kind,
    handoffAt: row.handoffAt,
    recordedInRunId: row.derivedFromRunId,
    citation:
      row.citation.cites === "event"
        ? {
            cites: "event",
            eventId: row.citation.eventId,
            sequenceNumber: row.citation.sequenceNumber,
            eventType: row.citation.eventType,
            namesRunId,
          }
        : row.citation.cites === "artifact"
          ? {
              cites: "artifact",
              artifactId: row.citation.artifactId,
              sha256: row.citation.sha256,
              role: row.citation.role,
            }
          : { cites: "run_field", field: row.citation.field, namesRunId },
  };
}

/**
 * Breadth-first walk from `subjectRunId`, bounded on four axes, reporting every
 * bound it hits.
 *
 * BREADTH-FIRST IS LOAD-BEARING, not a style choice. Levels close in order, so
 * "every run within 2 hops, completely" is a real answer even when the component
 * has a million members, and every unexpanded frontier is NAMED. Depth-first
 * would spend the same budget on one arbitrary tendril and be able to claim
 * nothing complete at all.
 *
 * TERMINATION on a cyclic graph is by the `visited` set: an id is enqueued at
 * most once, so A->B->A enqueues A once and B once, bounded by the node budget
 * regardless.
 */
async function walk(
  ctx: QueryCtx,
  args: {
    subjectRunId: Id<"runs">;
    orgId: Id<"organizations">;
    direction: CausalDirection;
    depthBudget: number;
  },
): Promise<WalkResult> {
  const nodes: CausalNodeObservation[] = [];
  const edges: CausalEdgeObservation[] = [];
  const frontier: CausalFrontierObservation[] = [];
  const visited = new Set<string>();
  const frontierRuns = new Set<string>();
  const observedById = new Map<string, CausalNodeObservation>();
  let edgesRead = 0;
  let scanTruncated = false;

  const subject = await observeRun(ctx, args.subjectRunId, args.orgId);
  if (subject === null) return { nodes, edges, frontier, scanTruncated };

  const admit = async (run: Doc<"runs">): Promise<CausalNodeObservation> => {
    const obs: CausalNodeObservation = {
      runId: run._id,
      agentId: run.agentId,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      sessionSiblingRunIds: await sessionSiblings(ctx, run, args.orgId),
      // NON-CAUSAL. Feeds a `shared_resource` SuspectedLink and nothing else —
      // a matching digest carries no direction, so it can never become an edge.
      // Bounded to the first few runs: this read buys a suspicion, and a
      // suspicion is a prompt to instrument something, which one example serves
      // as well as fifty.
      artifactChecksums:
        nodes.length < ARTIFACT_SCAN_RUN_LIMIT
          ? (
              await ctx.db
                .query("artifacts")
                .withIndex("by_run", (q) => q.eq("runId", run._id))
                .take(ARTIFACT_SCAN_PER_RUN)
            ).map((a) => a.checksum)
          : [],
      // Set truthfully below when (and only when) the node is expanded.
      expanded: false,
      onwardReadComplete: false,
    };
    nodes.push(obs);
    observedById.set(run._id, obs);
    visited.add(run._id);
    return obs;
  };

  await admit(subject);
  const queue: Array<{ run: Doc<"runs">; depth: number }> = [{ run: subject, depth: 0 }];

  for (let head = 0; head < queue.length; head++) {
    const { run, depth } = queue[head]!;
    const obs = observedById.get(run._id)!;

    if (depth >= args.depthBudget) {
      // Discovered but NOT expanded: we have said nothing about this run's own
      // causes or effects.
      if (!frontierRuns.has(run._id)) {
        frontierRuns.add(run._id);
        frontier.push({ runId: run._id, hopsFromSubject: depth, reason: "depth_limit_reached" });
      }
      continue;
    }
    if (edgesRead >= CAUSAL_MAX_EDGES) {
      scanTruncated = true;
      if (!frontierRuns.has(run._id)) {
        frontierRuns.add(run._id);
        frontier.push({ runId: run._id, hopsFromSubject: depth, reason: "budget_exhausted" });
      }
      continue;
    }

    const discovered: Array<{ runId: Id<"runs">; depth: number }> = [];
    let onwardComplete = true;

    // ---- UPWARD: what produced this run. ---------------------------------
    if (args.direction !== "downstream") {
      // Source 1: the run's own parentRunId field, written at run creation and
      // never mutated. A run-field citation, not an event one.
      if (run.parentRunId !== undefined) {
        edges.push({
          producerRunId: run.parentRunId,
          consumerRunId: run._id,
          kind: "spawned",
          // The field carries no recording timestamp of its own. The child's
          // creation instant IS when the link was written, and saying so is more
          // honest than inventing a separate one.
          handoffAt: run.startedAt,
          recordedInRunId: run._id,
          citation: { cites: "run_field", field: "parentRunId", namesRunId: run.parentRunId },
        });
        discovered.push({ runId: run.parentRunId, depth: depth + 1 });
      }

      // Source 2: the derived index over the log. Org-prefixed.
      const inRows = await ctx.db
        .query("run_causal_edges")
        .withIndex("by_org_consumer", (q) => q.eq("orgId", args.orgId).eq("consumerRunId", run._id))
        .take(CAUSAL_MAX_FANOUT + 1);
      edgesRead += Math.min(inRows.length, CAUSAL_MAX_FANOUT);
      if (inRows.length > CAUSAL_MAX_FANOUT) onwardComplete = false;
      for (const row of inRows.slice(0, CAUSAL_MAX_FANOUT)) {
        if (!citationIsPossible(row)) continue;
        edges.push(toObservation(row));
        discovered.push({ runId: row.producerRunId, depth: depth + 1 });
      }
    }

    // ---- DOWNWARD: what ran on this run's output. ------------------------
    // THE QUESTION NOBODY COULD ANSWER BEFORE. Two sources, same discipline.
    if (args.direction !== "upstream") {
      // Source 1: runs whose parentRunId is this run. ORG-PREFIXED index, so a
      // child stamped with a foreign org is not in the range at all.
      const children = await ctx.db
        .query("runs")
        .withIndex("by_org_parent", (q) => q.eq("orgId", args.orgId).eq("parentRunId", run._id))
        .take(CAUSAL_MAX_FANOUT + 1);
      edgesRead += Math.min(children.length, CAUSAL_MAX_FANOUT);
      if (children.length > CAUSAL_MAX_FANOUT) onwardComplete = false;
      for (const child of children.slice(0, CAUSAL_MAX_FANOUT)) {
        edges.push({
          producerRunId: run._id,
          consumerRunId: child._id,
          kind: "spawned",
          handoffAt: child.startedAt,
          recordedInRunId: child._id,
          citation: { cites: "run_field", field: "parentRunId", namesRunId: run._id },
        });
        discovered.push({ runId: child._id, depth: depth + 1 });
      }

      // Source 2: the derived index over the log.
      const outRows = await ctx.db
        .query("run_causal_edges")
        .withIndex("by_org_producer", (q) => q.eq("orgId", args.orgId).eq("producerRunId", run._id))
        .take(CAUSAL_MAX_FANOUT + 1);
      edgesRead += Math.min(outRows.length, CAUSAL_MAX_FANOUT);
      if (outRows.length > CAUSAL_MAX_FANOUT) onwardComplete = false;
      for (const row of outRows.slice(0, CAUSAL_MAX_FANOUT)) {
        if (!citationIsPossible(row)) continue;
        edges.push(toObservation(row));
        discovered.push({ runId: row.consumerRunId, depth: depth + 1 });
      }
    }

    obs.expanded = true;
    obs.onwardReadComplete = onwardComplete;

    // ---- Enqueue. ---------------------------------------------------------
    for (const d of discovered) {
      if (visited.has(d.runId)) continue; // VISITED SET: terminates on cycles.
      visited.add(d.runId);
      if (nodes.length >= MAX_CAUSAL_NODES) {
        scanTruncated = true;
        // THE STOP IS RECORDED AT THE RUN BEING EXPANDED, not at the unread
        // neighbour. `LostTrail.lastReachedRunId` means the last run the walk
        // actually REACHED, and the contract audits it against the node set
        // (`terminus_run_was_reached`) — naming a run we never read would be a
        // frontier nobody can go and open. The unread neighbours are still
        // reported, by id, on the `component_unclosed` question.
        if (!frontierRuns.has(run._id)) {
          frontierRuns.add(run._id);
          frontier.push({ runId: run._id, hopsFromSubject: depth, reason: "budget_exhausted" });
        }
        continue;
      }
      const next = await observeRun(ctx, d.runId, args.orgId);
      // null = deleted OR cross-org, indistinguishably. It contributes NO node,
      // so the edge naming it becomes a dangling edge and folds to a `LostTrail`
      // with kind `adjacent_run_unavailable`. There is deliberately no branch
      // here that could tell an operator which of the two it was.
      if (next === null) continue;
      await admit(next);
      queue.push({ run: next, depth: d.depth });
    }
  }

  return { nodes, edges, frontier, scanTruncated };
}

/** Shared entry point for the three read surfaces below. */
async function traverse(
  ctx: QueryCtx,
  args: { runId: Id<"runs">; direction: CausalDirection; maxDepth?: number },
): Promise<CausalTraversal> {
  // TENANCY: the caller is resolved and authorized BEFORE any run is observed
  // (CLAUDE.md Tenancy Rule 5), so the subject run is looked at only through an
  // org we have already established the caller belongs to.
  const { orgId } = await getAuthContext(ctx);
  await requireOrgMembership(ctx, orgId);

  const depthBudget = clampCausalDepth(args.maxDepth);
  const result = await walk(ctx, {
    subjectRunId: args.runId,
    orgId,
    direction: args.direction,
    depthBudget,
  });

  return foldCausalGraph({
    analyzedAt: Date.now(),
    subjectRunId: args.runId,
    direction: args.direction,
    nodes: result.nodes,
    edges: result.edges,
    frontier: result.frontier,
    maxDepthRequested: depthBudget,
    scanTruncated: result.scanTruncated,
    scanRowCeiling: CAUSAL_MAX_EDGES,
  });
}

// ===========================================================================
// READ SURFACES
// ===========================================================================

/**
 * UPWARD — "what caused this run?"
 *
 * `traversal.termini` answers it, in one of three mutually exclusive ways that
 * share no property except the discriminant: the chain ENDED
 * (`RecordedOrigin.originRunId`), the chain LOOPS
 * (`CycleReEntry.reEnteredRunId`), or WE stopped (`LostTrail.lastReachedRunId`).
 * There is no field a renderer can read without first narrowing, so "the origin
 * is run X" and "we lost the trail at run X" cannot render the same.
 */
export const traceRunOrigin = query({
  args: { runId: v.id("runs"), maxDepth: v.optional(v.number()) },
  handler: async (ctx, args) =>
    traverse(ctx, { runId: args.runId, direction: "upstream", maxDepth: args.maxDepth }),
});

/**
 * DOWNWARD — "what ran on this run's output?"
 *
 * The blast-radius question, and the reason this file exists. READ THE TERMINI
 * BEFORE THE NODES: a run with no recorded outbound handoff produces an empty
 * downstream graph, whose honest reading — composed by the contract's
 * `originStatement()` — is "nothing RECORDED consumed this run's output", never
 * "nothing did".
 */
export const traceRunImpact = query({
  args: { runId: v.id("runs"), maxDepth: v.optional(v.number()) },
  handler: async (ctx, args) =>
    traverse(ctx, { runId: args.runId, direction: "downstream", maxDepth: args.maxDepth }),
});

/**
 * BOTH — the connected component around a run.
 *
 * REFUSES, AND THE REFUSAL IS THE FEATURE. A component traversal cannot be
 * represented honestly under contracts 0.24.0, so returning one means returning
 * a wrong answer.
 *
 * THE ARGUMENT, because "we could not build it" and "it cannot be built" are
 * different claims and this is the second:
 *
 *   1. A component scan cannot make an ORIGIN claim at all — the contract now
 *      says so twice over: `TerminusFor<'component'>` resolves to
 *      `ComponentTerminus = CycleReEntry | LostTrail`, making the claim
 *      unspellable in typed code, and `origin_is_directional` audits it on the
 *      wire because a JSON body is typechecked by nobody.
 *   2. AND THAT IS THE HALF THAT STILL BITES. `CausalTraversal.termini` is a
 *      NON-EMPTY tuple, and a fully-closed component has no lost trail and no
 *      cycle. With the origin unrepresentable, `ComponentTerminus` has no
 *      inhabitant left for a component that finished — there is nothing valid to
 *      put in it — an ordinary parent/child pair
 *      produced a traversal with ZERO termini, which violates the contract's own
 *      type at runtime and makes `isCausalTraversalComplete` false for a trace
 *      that finished perfectly.
 *   3. Every alternative available inside this file is a lie: emitting a
 *      `LostTrail` for a walk that stopped nowhere misdescribes the scan, and
 *      emitting an origin ships a claim the audit rejects.
 *
 * So the honest surface is an error naming the two queries that ARE
 * representable. A caller asking a directional question of a component query
 * previously got a WRONG ANSWER; it now gets a refusal, which is the difference
 * between a tool that is incomplete and one that is misleading.
 *
 * The query is kept (rather than deleted) so an existing caller gets this
 * explanation instead of a missing-function error. It becomes a real traversal
 * again the moment the contract can represent a component-scan frontier —
 * either by making an origin claim unrepresentable under `component` rather
 * than always-false, or by adding a band for "the component closed".
 */
export const getIncidentGraph = query({
  args: { runId: v.id("runs"), maxDepth: v.optional(v.number()) },
  handler: () => {
    throw afrError(
      "INVALID_ARGUMENT",
      "a component traversal cannot be represented under the current causal contract: a `component` scan makes every RecordedOrigin contradict its own edge set, leaving a fully-closed component with no valid terminus. Call traceRunOrigin and traceRunImpact separately and read each against its own direction.",
    );
  },
});

// ===========================================================================
// WRITE SURFACE
// ===========================================================================

/**
 * Project one already-stored event into the index. THE REPAIR PATH.
 *
 * THERE IS NO CLIENT-CALLABLE WAY TO ASSERT AN EDGE, and that is the whole
 * design. A handoff is recorded by APPENDING TO THE LOG — an ordinary event
 * carrying `consumedRunId` / `spawnedRunId` / `delegatedToRunId` /
 * `retryOfRunId` — and both write paths project it automatically at insert time.
 *
 * WHY NO BARE-ASSERTION MUTATION EXISTS. A free-standing row is a fact with no
 * record behind it: unrebuildable, silently losable, and indistinguishable once
 * written from one the log actually supports. The event log is the only place in
 * this product where a claim about what happened cannot later be edited away.
 *
 * INTERNAL, not public. It exists for a log that already carries such an event
 * but whose index row is missing — an event written before this feature existed,
 * or a projection lost to a schema change. That is an operator repair, not a
 * product surface, and shipping it as a public mutation would have been an
 * unwired public function: `tests/unit/convex_function_refs.test.ts` flags
 * exactly that, and it was right to.
 */
export const projectEventCausalEdgesForRepair = internalMutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw afrError("NOT_FOUND", "Event not found");

    const claims = deriveEdgeClaims(event.payload);
    if (claims.length === 0) {
      throw afrError(
        "INVALID_ARGUMENT",
        "this event's payload records no cross-run handoff: none of `spawnedRunId`, `delegatedToRunId`, `consumedRunId`, `retryOfRunId` is present",
      );
    }
    const written = await projectEventCausalEdges(ctx, event);
    return { claims: claims.length, written };
  },
});

export const CAUSAL_LIMITS = {
  maxNodes: MAX_CAUSAL_NODES,
  maxFanout: CAUSAL_MAX_FANOUT,
  maxEdges: CAUSAL_MAX_EDGES,
} as const;
