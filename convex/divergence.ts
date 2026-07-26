// ---------------------------------------------------------------------------
// REPLAY DIVERGENCE — Convex query surface.
//
// "I have a new AgentVersion. Against this run's recorded history, where would
// it have diverged?" — and its fleet form, "apply target V across this agent's
// recorded runs: how many break, and for how many DISTINCT reasons?"
//
// All analysis logic lives in the PURE engine, convex/helpers/divergence.ts,
// which mirrors the canonical vocabulary in
// `packages/contracts/src/divergence.ts`. This file is only: authorize -> read
// bounded facts -> call the engine -> report coverage honestly. NO EXECUTION of
// agent code happens anywhere.
//
// READ-ONLY. Every function here is a `query`. Nothing writes, and in particular
// nothing writes a divergence result back: a divergence report is a DERIVED
// PROJECTION over recorded events (CLAUDE.md Event Log Rule 2), recomputed on
// demand, never stored. `analyzedAt` is stamped from the server clock here (the
// engine takes it as data) so the report is self-evidently a snapshot.
//
// ===========================================================================
// TENANCY
// ===========================================================================
// Every function resolves and authorizes the CALLER first (getAuthContext +
// requireOrgMembership) and only THEN observes any id from `args`. A run or
// agent_version belonging to another org and one that does not exist produce
// the SAME error on the SAME code path. This repo has closed 25 cross-org
// existence oracles (convex/tenancy_oracle.test.ts); this file does not open a
// 26th, and convex/divergence.test.ts asserts outcome EQUALITY, not merely that
// both cases throw.
//
// ===========================================================================
// WHY THE FLEET QUESTION IS THREE FUNCTIONS, NOT ONE
// ===========================================================================
// The naive shape — "analyse the last 10,000 runs" — cannot be one Convex query
// execution. Two hard limits decide the architecture:
//
//   (1) Convex permits ONE `.paginate()` per function execution.
//   (2) `MAX_EVENTS_PER_RUN` is 50,000 and `events` has no index on `type`, so
//       per-run event access is a scan of that run's log.
//
// So the surface is a progressive-disclosure ladder, cheapest first — the shape
// docs/mcp.md uses for the read API:
//
//   TIER 1  compareVersionConfigs   ZERO run reads, ZERO event reads. Answers
//           the whole model/prompt/budget/decoding/tool-inventory question for
//           the ENTIRE fleet at once, because every SPECULATIVE finding depends
//           only on the (baseline, target) pair and is identical for all 10,000
//           runs. In practice this is most of the answer, and it is free.
//
//   TIER 2  analyzeRun              ONE run. Spends the single `.paginate()` on
//           that run's events, so a run larger than one page is continued by the
//           caller via `nextEventCursor` and reported `eventHistoryComplete:
//           false` until it is exhausted.
//
//   TIER 3  analyzeFleet            A BOUNDED BATCH of the baseline version's
//           runs. The single `.paginate()` is spent on RUNS, so each run's
//           events are read with a small bounded `.take()` instead — fleet
//           results are explicitly SAMPLED per run, flagged in `window`, never
//           hidden. Page with `nextCursor`; merge with `mergeFleetAnalyses`.
//
// What we will NOT do to make this cheaper: denormalize a `toolsSeen` array
// onto `runs` the way `modelsSeen` is denormalized. It would be populated only
// for runs recorded AFTER the change; every pre-existing run would carry an
// ABSENT field, and absent is indistinguishable from "called no tools". That is
// exactly the silent-empty-as-success failure this feature exists to prevent,
// and it would be most wrong precisely on the historical runs a replay test is
// for.
// ---------------------------------------------------------------------------

import { v } from "convex/values";

import { query } from "./_generated/server.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import {
  analyzeConfigPair,
  analyzeRunAgainstDelta,
  extractRunObservation,
  foldFleetDivergence,
  type ConfigDelta,
  type ObservableEvent,
  type RunDivergenceAnalysis,
} from "./helpers/divergence.js";
import { afrError } from "./helpers/errors.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

// ---------------------------------------------------------------------------
// Bounds. Each is an HONESTY bound as much as a cost bound: when one is hit the
// result says so, and the verdict cannot be `compatible`.
// ---------------------------------------------------------------------------

/**
 * Events read per page in the single-run analysis. Sized against the 10 KB
 * inline payload ceiling (Event Log Rule 3): 500 events is a 5 MB worst case,
 * inside Convex's per-query byte budget, while covering most runs in one call.
 */
export const DIVERGENCE_EVENT_PAGE_SIZE = 500;

/** Runs analysed per fleet batch. Small, because each run costs an event scan. */
export const DIVERGENCE_FLEET_RUNS_PER_BATCH = 25;
export const DIVERGENCE_FLEET_MAX_RUNS_PER_BATCH = 100;

/**
 * Events read PER RUN inside a fleet batch. The single `.paginate()` is spent
 * on runs, so this is a `.take()` — a hard sample, not a page. A run with more
 * events than this reports `eventHistoryComplete: false` and can never be
 * graded `compatible` from a fleet call; re-run it through TIER 2.
 */
export const DIVERGENCE_FLEET_EVENTS_PER_RUN = 200;

/** Total event rows one fleet batch will read across all its runs. */
export const DIVERGENCE_FLEET_EVENT_BUDGET = 3_000;

/**
 * The event types this scan reads. Filtering at the query level is what makes
 * an event scan affordable.
 *
 * DELIBERATELY INCLUDES `tool.call` EVEN THOUGH ITS PAYLOAD MAY BE AN ARTIFACT
 * POINTER: the row keeps its `type` when the payload is externalized, so
 * reading it is how we LEARN an unnamed tool call exists. Filtering it out
 * would turn a known gap into an invisible one.
 *
 * DELIBERATELY INCLUDES `run.started`, WHICH THE ENGINE NEVER READS A FACT
 * FROM. It is the SOUNDNESS ANCHOR for `coverage.eventsExamined > 0`.
 *
 * Contracts 0.16.1 made `isDivergenceCoverageComplete` require
 * `eventsExamined > 0`, on the argument that zero events read can never mean
 * "an empty run" because Event Log Rule 5 guarantees every run has a
 * `RUN_STARTED` — so zero always means "nothing was read". THAT ARGUMENT DOES
 * NOT HOLD FOR A TYPE-FILTERED SCAN. Reading only tool/LLM events, a genuinely
 * complete run that made no tool call and no model call returns zero rows, and
 * `eventsExamined: 0` would then mean "nothing relevant to read" — the exact
 * weaker reading the contract's precondition assumes away. Such a run would be
 * permanently `indeterminate` for a reason that is an artifact of our filter,
 * not of the recording.
 *
 * Including `run.started` restores the contract's precondition exactly: every
 * real run yields at least one row, so `eventsExamined === 0` once again means
 * "we did not read the log", never "the log had nothing in it". The cost is one
 * row per run; the alternative is either a false `compatible` or a false
 * `indeterminate`, depending on which way the predicate is written.
 */
export const OBSERVED_EVENT_TYPES = ["run.started", "tool.call", "llm.request", "llm.response"] as const;

// ---------------------------------------------------------------------------
// Shared authorization + resolution
// ---------------------------------------------------------------------------

/**
 * Resolve two agent versions under the caller's org.
 *
 * ORDER IS THE SECURITY PROPERTY: caller first, ids second. A cross-org version
 * id and a nonexistent one reach the same `NOT_FOUND` on the same line.
 */
async function resolveVersionPair(
  ctx: QueryCtx,
  baselineVersionId: Id<"agent_versions">,
  targetVersionId: Id<"agent_versions">,
): Promise<{ orgId: Id<"organizations">; baseline: Doc<"agent_versions">; target: Doc<"agent_versions"> }> {
  const { orgId } = await getAuthContext(ctx);
  await requireOrgMembership(ctx, orgId);

  const baseline = await ctx.db.get(baselineVersionId);
  if (!baseline || baseline.orgId !== orgId) throw afrError("NOT_FOUND", "Agent version not found");
  const target = await ctx.db.get(targetVersionId);
  if (!target || target.orgId !== orgId) throw afrError("NOT_FOUND", "Agent version not found");
  if (baseline.agentId !== target.agentId) {
    // Comparing versions of different agents is not a replay question: the
    // recorded history belongs to a different agent, so nothing derived from it
    // would mean anything.
    throw afrError(
      "INVALID_ARGUMENT",
      "Both versions must belong to the same agent: a divergence report is only meaningful against that agent's own recorded history",
    );
  }
  return { orgId, baseline, target };
}

/**
 * EXPORTED for convex/read_api.ts's key-authed counterpart. Both doors must
 * observe a run identically — a divergence report that differs depending on
 * whether you arrived with a Clerk JWT or an `x-api-key` is exactly the kind
 * of silent two-door drift `read_api.ts`'s own header warns about.
 */
export function toObservableEvent(doc: Doc<"events">): ObservableEvent {
  return {
    _id: doc._id,
    type: doc.type,
    sequenceNumber: doc.sequenceNumber,
    payload: doc.payload,
    ...(doc.provenance
      ? { provenance: { source: doc.provenance.source, ...("lossy" in doc.provenance ? { lossy: doc.provenance.lossy } : {}) } }
      : {}),
  };
}

/** Read a bounded, type-filtered slice of one run's events. EXPORTED — see toObservableEvent. */
export async function takeObservableEvents(
  ctx: QueryCtx,
  runId: Id<"runs">,
  limit: number,
): Promise<{ events: ObservableEvent[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .filter((q) => q.or(...OBSERVED_EVENT_TYPES.map((t) => q.eq(q.field("type"), t))))
    // One extra row is the truthful truncation signal: if it comes back, there
    // is more history than we read and the observation is incomplete.
    .take(limit + 1);
  return { events: rows.slice(0, limit).map(toObservableEvent), truncated: rows.length > limit };
}

// ---------------------------------------------------------------------------
// TIER 1 — config-pair comparison. Zero run reads, zero event reads.
// ---------------------------------------------------------------------------

/**
 * Compare two agent versions' configSnapshots.
 *
 * Answers, for the WHOLE fleet at once and at zero per-run cost, every question
 * that does not depend on recorded history — and, critically, which dimensions
 * could not be read at all. If `coverage.assessed` is empty, no amount of run
 * reading will help: the snapshots are absent or malformed, and the honest
 * answer is `indeterminate`.
 */
export const compareVersionConfigs = query({
  args: {
    baselineVersionId: v.id("agent_versions"),
    targetVersionId: v.id("agent_versions"),
  },
  handler: async (ctx, args) => {
    const { baseline, target } = await resolveVersionPair(ctx, args.baselineVersionId, args.targetVersionId);
    const delta = analyzeConfigPair(baseline.configSnapshot, target.configSnapshot);

    return {
      // Echoed for ignored-parameter detection, exactly as the contract's
      // reports do: a client can prove the server analysed the version it named.
      baselineVersionId: args.baselineVersionId,
      targetVersionId: args.targetVersionId,
      baselineVersion: baseline.version,
      targetVersion: target.version,
      analyzedAt: Date.now(),
      /**
       * NOT a verdict. This tier reads no events, so it can never emit a proven
       * finding, and calling its result `compatible` would be the exact false
       * clean this feature exists to prevent. The verdict comes from TIER 2/3.
       */
      speculative: delta.speculative,
      coverage: {
        assessed: delta.assessed,
        unassessed: delta.unassessed,
        eventsExamined: 0,
        eventHistoryComplete: false,
      },
      snapshotStatus: { baseline: delta.baseline.snapshotStatus, target: delta.target.snapshotStatus },
      /** Which proven kinds are still REACHABLE given what the target declares. Empty means TIER 2/3 can add nothing. */
      provenKindsReachable: [
        ...(delta.targetToolsByName !== null ? (["tool_removed", "tool_call_rejected_by_schema"] as const) : []),
        ...(delta.targetModels !== null ? (["model_removed"] as const) : []),
        ...(Object.keys(delta.targetBudgets).length > 0 ? (["budget_exceeded"] as const) : []),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// TIER 2 — one run, paged to completion.
// ---------------------------------------------------------------------------

/**
 * Analyse ONE recorded run against a target version.
 *
 * Spends the single permitted `.paginate()` on this run's events. A run larger
 * than one page returns `nextEventCursor`; until the caller has consumed every
 * page, `coverage.eventHistoryComplete` is false and the verdict cannot be
 * `compatible`.
 *
 * A run with NO recorded `agentVersionId` is still analysed. Proven kinds need
 * only the target's configuration, so a missing baseline restricts the report
 * to proof and marks every speculative dimension `baseline_config_missing`
 * rather than silently reporting "no changes".
 */
export const analyzeRun = query({
  args: {
    runId: v.id("runs"),
    targetVersionId: v.id("agent_versions"),
    /** Continuation cursor over this run's events. Opaque; from `nextEventCursor`. */
    eventCursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // TENANCY: caller resolved and authorized BEFORE args.runId is observed.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw afrError("NOT_FOUND", "Run not found");

    const target = await ctx.db.get(args.targetVersionId);
    if (!target || target.orgId !== orgId) throw afrError("NOT_FOUND", "Agent version not found");
    if (target.agentId !== run.agentId) {
      throw afrError(
        "INVALID_ARGUMENT",
        "The target version belongs to a different agent than this run: its configuration cannot be replayed against this history",
      );
    }

    // A baseline is OPTIONAL — see the doc comment. `undefined` flows into the
    // engine as an absent snapshot, which is exactly the tri-state it handles.
    let baseline: Doc<"agent_versions"> | null = null;
    if (run.agentVersionId) {
      baseline = await ctx.db.get(run.agentVersionId);
      if (baseline && baseline.orgId !== orgId) throw afrError("NOT_FOUND", "Agent version not found");
    }

    const delta = analyzeConfigPair(baseline?.configSnapshot, target.configSnapshot);

    const limit = Math.min(args.limit ?? DIVERGENCE_EVENT_PAGE_SIZE, DIVERGENCE_EVENT_PAGE_SIZE);
    const page = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .filter((q) => q.or(...OBSERVED_EVENT_TYPES.map((t) => q.eq(q.field("type"), t))))
      .paginate({ numItems: limit, cursor: args.eventCursor ?? null });

    const observation = extractRunObservation(page.page.map(toObservableEvent), { scanTruncated: !page.isDone });
    const analysis = analyzeRunAgainstDelta(delta, observation);

    return {
      runId: args.runId,
      baselineVersionId: run.agentVersionId ?? null,
      targetVersionId: args.targetVersionId,
      baselineVersion: baseline?.version ?? null,
      targetVersion: target.version,
      analyzedAt: Date.now(),
      verdict: analysis.verdict,
      proven: analysis.proven,
      speculative: analysis.speculative,
      indeterminate: analysis.indeterminate,
      coverage: analysis.coverage,
      nextEventCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

// ---------------------------------------------------------------------------
// TIER 3 — bounded fleet batch, grouped by distinct reason.
// ---------------------------------------------------------------------------

/**
 * Apply a target version across a BOUNDED BATCH of the baseline version's
 * recorded runs, most recent first, grouped by DISTINCT REASON.
 *
 * `provenReasons` is the headline: "340 broken runs with 12 root causes is a
 * tractable morning; 340 individual reports is not."
 *
 * COVERAGE IS PART OF THE ANSWER. `window.scanTruncated` is true while pages
 * remain, so `isFleetScanComplete` — and therefore the verdict — correctly
 * refuses `compatible` until the caller has walked the whole population and
 * merged the pages with `mergeFleetAnalyses`.
 */
export const analyzeFleet = query({
  args: {
    baselineVersionId: v.id("agent_versions"),
    targetVersionId: v.id("agent_versions"),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { orgId, baseline, target } = await resolveVersionPair(ctx, args.baselineVersionId, args.targetVersionId);
    const delta: ConfigDelta = analyzeConfigPair(baseline.configSnapshot, target.configSnapshot);

    const limit = Math.min(args.limit ?? DIVERGENCE_FLEET_RUNS_PER_BATCH, DIVERGENCE_FLEET_MAX_RUNS_PER_BATCH);

    // The single `.paginate()` of this execution, spent on RUNS. The index is
    // keyed on `agentVersionId` directly, so every row read already belongs to
    // this version and — because the version was org-checked above — to this
    // org. The `run.orgId !== orgId` guard below is defense in depth, not the
    // primary boundary.
    const page = await ctx.db
      .query("runs")
      .withIndex("by_agent_version_started", (q) => q.eq("agentVersionId", args.baselineVersionId))
      .order("desc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });

    const analyses: Array<{ runId: string; analysis: RunDivergenceAnalysis }> = [];
    let eventBudget = DIVERGENCE_FLEET_EVENT_BUDGET;
    let runsSkippedForBudget = 0;

    for (const run of page.page) {
      if (run.orgId !== orgId) continue;
      if (eventBudget <= 0) {
        runsSkippedForBudget += 1;
        continue;
      }
      const perRun = Math.min(DIVERGENCE_FLEET_EVENTS_PER_RUN, eventBudget);
      const { events, truncated } = await takeObservableEvents(ctx, run._id, perRun);
      eventBudget -= events.length;

      const observation = extractRunObservation(events, { scanTruncated: truncated });
      analyses.push({ runId: run._id, analysis: analyzeRunAgainstDelta(delta, observation) });
    }

    const fleet = foldFleetDivergence(analyses, {
      runsScanned: page.page.length,
      // Each way of not-having-looked gets its OWN field rather than being
      // folded into `scanTruncated`. Contracts' `isFleetScanComplete` checks
      // all four, and `nextCursor` is the one that would otherwise be missed:
      // a page that came back full and clean looks exactly like a finished scan.
      runsSkippedForBudget,
      scanTruncated: false,
      scanRowCeiling: limit,
      ...(page.isDone ? {} : { nextCursor: page.continueCursor }),
    });

    return {
      agentId: baseline.agentId,
      baselineVersionId: args.baselineVersionId,
      targetVersionId: args.targetVersionId,
      baselineVersion: baseline.version,
      targetVersion: target.version,
      analyzedAt: Date.now(),
      verdict: fleet.verdict,
      provenReasons: fleet.provenReasons,
      speculativeReasons: fleet.speculativeReasons,
      indeterminateReasons: fleet.indeterminateReasons,
      runsWithProvenDivergence: fleet.runsWithProvenDivergence,
      window: fleet.window,
      runsSkippedForBudget,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
