// IMMUTABILITY: No updateEvent or deleteEvent. These operations must never exist.

import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_EVENTS_PER_RUN,
  MAX_PAGE_SIZE,
} from "./helpers/pagination.js";
import {
  buildSearchText,
  extractErrorMessage,
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
    const run = await ctx.db.get(args.runId);
    if (!run) {
      throw new Error("Run not found");
    }
    await requireOrgMembership(ctx, run.orgId);

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
    const event = await ctx.db.get(args.eventId);
    if (!event) {
      throw new Error("Event not found");
    }
    await requireOrgMembership(ctx, event.orgId);
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
    const run = await ctx.db.get(args.runId);
    if (!run) {
      throw new Error("Run not found");
    }

    // Writing to the append-only event log requires at least "member". A read-only
    // viewer must never be able to mutate the log (P0 authorization gate).
    await requireOrgMembership(ctx, run.orgId, { minimumRole: "member" });

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

    // ADR-002: terminal reconcile — append the extracted error message to
    // runs.searchText so a failed run's error text is searchable.
    if (args.type === "run.failed") {
      const errorMessage = extractErrorMessage(args.payload);
      if (errorMessage) {
        const searchText = buildSearchText([run.searchText, errorMessage]);
        await ctx.db.patch(args.runId, { searchText });
      }
    }

    // ADR-002: approximate usage metering (see convex/usage.ts).
    const bytes = new TextEncoder().encode(JSON.stringify(args.payload ?? null)).length;
    await incrementUsageCounters(ctx, run.orgId, { eventsIngested: 1, bytesIngested: bytes });

    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Failed to create event");
    return event;
  },
});
