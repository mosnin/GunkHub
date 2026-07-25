// IMMUTABILITY: No updateEvent or deleteEvent. These operations must never exist.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { projectEventCausalEdges } from "./causality.js";
import { afrError } from "./helpers/errors.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_EVENTS_PER_RUN,
  MAX_PAGE_SIZE,
} from "./helpers/pagination.js";
import {
  addModelSeen,
  buildSearchText,
  extractErrorMessage,
  extractModel,
  extractTokenUsage,
} from "./helpers/run_fields.js";
import { incrementUsageCounters } from "./usage.js";

// Event types that must be the last event in a run (CLAUDE.md Event Log Rule 5).
const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed"]);

// Closed set of accepted event types. MUST stay in sync with the `EventType` union
// in packages/contracts/src/events.ts (the source of truth). Convex cannot import
// the contracts package (no path resolution / not a dependency; CLAUDE.md keeps the
// convex boundary free of cross-package deps and requires the shapes to align), so
// the union is mirrored here. An unknown/typo'd type (e.g. "run.complete") would
// otherwise persist as a non-terminal event and the run would never close.
const VALID_EVENT_TYPES = new Set<string>([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "llm.request",
  "llm.response",
  "llm.error",
  "tool.call",
  "tool.result",
  "tool.error",
  "memory.read",
  "memory.write",
  "retrieval.query",
  "retrieval.result",
  "http.request",
  "http.response",
  "custom",
]);

// CLAUDE.md Event Log Rule 3: payloads over 10 KB must be externalized to blob
// storage. Enforced server-side so a direct Convex call cannot bloat the store.
const MAX_INLINE_PAYLOAD_BYTES = 10 * 1024;

// Cycle 2 (docs/design/action_layer.md) — internal function reference,
// addressed by name (matches the makeFunctionReference pattern already used
// by convex/rollups.ts, convex/artifact_gc.ts, convex/projection_verify.ts,
// since convex/_generated/api.ts is not a live codegen output).
//
// AUDIT FIX (cycle 4): this file used to schedule
// alert_engine.evaluateAlertsForRun and insights.runEvalsForRun as two
// independent runAfter(0, ...) calls, with no ordering guarantee between
// them — an "eval_failed" alert rule could race runEvalsForRun's auto-run
// eval inserts and permanently miss the alert for this run. Fix: schedule
// ONLY alert_engine.runEvalsThenEvaluateAlerts (an internalAction that runs
// insights.ts's runEvalsForRun to completion, THEN this file's
// evaluateAlertsForRun) — see that action's doc comment in
// convex/alert_engine.ts for the full rationale. convex/insights.ts is
// unchanged by this fix.
const _runEvalsThenEvaluateAlertsRef = makeFunctionReference<"action">(
  "alert_engine:runEvalsThenEvaluateAlerts",
);

// ADR-004 — "Why did this fail?" run explanations. Scheduled ALONGSIDE (not
// as part of) the eval/alert wrapper above — explanation generation has no
// ordering dependency on evals/alerts, and must never add latency or failure
// risk to the ingest path. See convex/run_explanations.ts for the pipeline.
const _generateRunExplanationRef = makeFunctionReference<"action">(
  "run_explanations:generateRunExplanation",
);

// Applied to EVERY payload with no type-based exemption: a genuine externalized
// pointer is tiny and passes, while a client-spoofed `type: "_externalized"` field
// must not be a way to smuggle a large payload past the guard.
function assertPayloadWithinInlineLimit(payload: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? null)).length;
  if (bytes > MAX_INLINE_PAYLOAD_BYTES) {
    throw new Error(
      `Event payload is ${bytes} bytes, exceeding the ${MAX_INLINE_PAYLOAD_BYTES}-byte inline limit. ` +
        `Payloads over 10 KB must be externalized to blob storage (store a pointer, not the data).`,
    );
  }
}

/**
 * List events for a run, ordered by sequenceNumber, with optional type filter.
 */
export const listEvents = query({
  args: {
    runId: v.id("runs"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    types: v.optional(v.array(v.string())),
    // Tail mode: return only events with sequenceNumber > afterSeq. Live polling
    // uses this to fetch NEW events from the end of the log, instead of re-reading
    // the first page (which never contains newly appended tail events on runs
    // larger than one page).
    afterSeq: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the run is observed only afterwards, so a run in another org and a run
    // that does not exist are indistinguishable.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) {
      throw new Error("Run not found");
    }

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const baseQuery = ctx.db
      .query("events")
      .withIndex("by_run", (q) => {
        const scoped = q.eq("runId", args.runId);
        return args.afterSeq !== undefined
          ? scoped.gt("sequenceNumber", args.afterSeq)
          : scoped;
      });

    const typeSet = args.types && args.types.length > 0 ? new Set(args.types) : null;
    const filtered = typeSet
      ? baseQuery.filter((q) => {
          const typeValue = q.field("type");
          // Build a chain of OR conditions for each requested event type
          const conditions = [...typeSet].map((t) => q.eq(typeValue, t));
          // At least one type is guaranteed because typeSet is non-empty
          return conditions.slice(1).reduce(
            (acc, cond) => q.or(acc, cond),
            conditions[0]!,
          );
        })
      : baseQuery;

    const page = await filtered.paginate({
      numItems: limit,
      cursor: args.cursor ?? null,
    });

    return {
      events: page.page,
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
  },
});

/**
 * Get a single event by ID. Verifies org membership.
 */
export const getEvent = query({
  args: {
    eventId: v.id("events"),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the event is observed only afterwards. An event in another org and an
    // event that does not exist produce the same error on the same path.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const event = await ctx.db.get(args.eventId);
    if (!event || event.orgId !== orgId) {
      throw new Error("Event not found");
    }
    return event;
  },
});

/**
 * Append a new event to an active run. Validates that the run exists and is
 * in the "running" state before inserting.
 */
export const createEvent = mutation({
  args: {
    runId: v.id("runs"),
    type: v.string(),
    sequenceNumber: v.number(),
    timestamp: v.number(),
    payload: v.any(),
    parentEventId: v.optional(v.id("events")),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Resolve and authorize the CALLER
    // before observing args.runId. Writing to the append-only event log requires
    // at least "member" — a read-only viewer must never be able to mutate the
    // log (P0 authorization gate) — and that role gate is now applied to the
    // caller's OWN org, so the "Forbidden" it raises is runId-independent.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "member" });

    // Cross-org run and nonexistent run collapse to one outcome on one path.
    // This is a WRITE path: the check must also come before the idempotency
    // read below, so a cross-org caller cannot learn whether a given
    // (runId, sequenceNumber) pair already exists in another org.
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) {
      throw new Error("Run not found");
    }

    // Idempotency FIRST (mirrors sdkCreateEvents): a retry of an already-stored
    // event returns idempotently regardless of run status.
    const duplicate = await ctx.db
      .query("events")
      .withIndex("by_run", (q) =>
        q.eq("runId", args.runId).eq("sequenceNumber", args.sequenceNumber),
      )
      .unique();
    if (duplicate !== null) {
      return duplicate;
    }

    // A genuinely new event may only be appended while the run is running.
    if (run.status !== "running") {
      throw afrError(
        "RUN_NOT_ACTIVE",
        `Cannot append event to run with status "${run.status}". Run must be in "running" state.`,
      );
    }

    // Reject unknown event types: `type` is stored as an unvalidated string, so a
    // typo'd terminal event ("run.complete") would silently persist as a
    // non-terminal event and the run would never close. Enforce the closed set.
    if (!VALID_EVENT_TYPES.has(args.type)) {
      throw new Error(
        `Unknown event type "${args.type}". Must be one of the contracts EventType union.`,
      );
    }

    // Event Log Rule 4/5 enforcement.
    if (!Number.isInteger(args.sequenceNumber) || args.sequenceNumber < 1) {
      throw new Error(
        `Invalid sequenceNumber ${args.sequenceNumber}: must be a positive integer`,
      );
    }

    // Write ceiling: sequences are contiguous from 1, so the sequence number IS
    // the event count — an exact O(1) per-run cap check.
    if (args.sequenceNumber > MAX_EVENTS_PER_RUN) {
      throw afrError(
        "EVENT_LIMIT_EXCEEDED",
        `Run has reached the maximum of ${MAX_EVENTS_PER_RUN} events`,
      );
    }

    const latest = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .order("desc")
      .first();
    if (latest && TERMINAL_EVENT_TYPES.has(latest.type)) {
      throw afrError(
        "RUN_NOT_ACTIVE",
        "Cannot append event: a terminal event has already been recorded for this run",
      );
    }
    const expected = (latest ? latest.sequenceNumber : 0) + 1;
    if (args.sequenceNumber !== expected) {
      throw afrError(
        "SEQUENCE_CONFLICT",
        `Non-contiguous sequenceNumber: expected ${expected}, got ${args.sequenceNumber}`,
      );
    }

    // Event Log Rule 5: RUN_STARTED must be the first event of a run.
    if (!latest && args.type !== "run.started") {
      throw new Error(
        `First event of a run must be "run.started", got "${args.type}"`,
      );
    }

    // Event Log Rule 3: enforce payload externalization threshold.
    assertPayloadWithinInlineLimit(args.payload);

    const eventId = await ctx.db.insert("events", {
      runId: args.runId,
      orgId: run.orgId,
      type: args.type,
      sequenceNumber: args.sequenceNumber,
      timestamp: args.timestamp,
      payload: args.payload,
      parentEventId: args.parentEventId,
    });

    // CROSS-RUN CAUSAL GRAPH: project any handoff this event RECORDS into the
    // derived `run_causal_edges` index. Same category as the token counters
    // below — computed at insert time because the payload is already in hand,
    // never a second source of truth. The log remains the record; see
    // convex/helpers/causal_derive.ts.
    const insertedEvent = await ctx.db.get(eventId);
    if (insertedEvent) await projectEventCausalEdges(ctx, insertedEvent);

    // ADR-002: incremental token-usage counters, updated at event-insert time
    // rather than recomputed from a full replay (the log itself remains the
    // source of truth for the underlying llm.response payloads).
    if (args.type === "llm.response") {
      const { tokensIn, tokensOut } = extractTokenUsage(args.payload);
      if (tokensIn > 0 || tokensOut > 0) {
        await ctx.db.patch(args.runId, {
          tokensIn: (run.tokensIn ?? 0) + tokensIn,
          tokensOut: (run.tokensOut ?? 0) + tokensOut,
        });
      }
    }

    // Cycle 3 (cost accuracy): denormalize the model onto runs.modelsSeen so
    // getAgentCostStats (convex/insights.ts) can attribute tokens to models
    // without scanning every event. Tolerant extraction from either
    // llm.request or llm.response payloads — see helpers/run_fields.ts.
    if (args.type === "llm.request" || args.type === "llm.response") {
      const model = extractModel(args.payload);
      const updated = addModelSeen(run.modelsSeen, model);
      if (updated !== undefined) {
        await ctx.db.patch(args.runId, { modelsSeen: updated });
      }
    }

    // AUDIT FIX (cycle 5): terminal reconcile — mirrors sdkCreateEvents
    // (convex/sdk_ingest.ts): a run.completed/run.failed event appended via
    // this Clerk-authenticated write path must transition run.status to the
    // matching terminal status, exactly like the SDK ingest path already
    // does. Before this fix, createEvent only appended the error message to
    // runs.searchText on run.failed and never patched run.status/endedAt, so
    // a UI/dashboard-driven terminal event left the run stuck "running"
    // forever (RUN_NOT_ACTIVE would then block any further appends, but
    // nothing ever closed the run itself). The subsequent updateRunStatus
    // mutation (convex/runs.ts) is an idempotent no-op when it later
    // transitions to the same terminal status, same as the SDK path.
    if (TERMINAL_EVENT_TYPES.has(args.type)) {
      const patch: {
        status: "failed" | "completed";
        endedAt: number;
        searchText?: string;
      } = {
        status: args.type === "run.failed" ? "failed" : "completed",
        endedAt: args.timestamp,
      };
      if (args.type === "run.failed") {
        const errorMessage = extractErrorMessage(args.payload);
        if (errorMessage) {
          patch.searchText = buildSearchText([run.searchText, errorMessage]);
        }
      }
      await ctx.db.patch(args.runId, patch);
    }

    // ADR-002: approximate usage metering (see convex/usage.ts).
    const bytes = new TextEncoder().encode(JSON.stringify(args.payload ?? null)).length;
    await incrementUsageCounters(ctx, run.orgId, { eventsIngested: 1, bytesIngested: bytes });

    // Cycle 2 (docs/design/action_layer.md): on the terminal event, schedule
    // eval auto-run + alert evaluation, NON-BLOCKING (runAfter(0, ...)) so
    // neither ever adds latency or failure risk to the ingest path itself.
    // AUDIT FIX (cycle 4): scheduled as ONE action
    // (runEvalsThenEvaluateAlerts) that sequences the two mutations with a
    // real ordering guarantee — see the comment on
    // _runEvalsThenEvaluateAlertsRef above for why this replaced two
    // independent runAfter(0, ...) calls.
    if (TERMINAL_EVENT_TYPES.has(args.type)) {
      await ctx.scheduler.runAfter(0, _runEvalsThenEvaluateAlertsRef, { runId: args.runId });
    }

    // ADR-004: on a run.failed terminal event, schedule "Why did this fail?"
    // explanation generation, NON-BLOCKING. run.completed never gets one
    // (getRunExplanation returns null for non-failure statuses), so this is
    // scheduled only for run.failed, not every terminal event.
    if (args.type === "run.failed") {
      await ctx.scheduler.runAfter(0, _generateRunExplanationRef, { runId: args.runId });
    }

    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Failed to create event");
    return event;
  },
});
