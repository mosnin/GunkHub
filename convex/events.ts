// IMMUTABILITY: No updateEvent or deleteEvent. These operations must never exist.

import { query, mutation } from "convex/server";
import { v } from "convex/values";
import { requireOrgMembership } from "./auth.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./helpers/pagination.js";

/**
 * List events for a run, ordered by sequenceNumber, with optional type filter.
 */
export const listEvents = query({
  args: {
    runId: v.id("runs"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    types: v.optional(v.array(v.string())),
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
      .withIndex("by_run", (q) => q.eq("runId", args.runId));

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
    if (run.status !== "running") {
      throw new Error(
        `Cannot append event to run with status "${run.status}". Run must be in "running" state.`,
      );
    }

    await requireOrgMembership(ctx, run.orgId);

    const eventId = await ctx.db.insert("events", {
      runId: args.runId,
      orgId: run.orgId,
      type: args.type,
      sequenceNumber: args.sequenceNumber,
      timestamp: args.timestamp,
      payload: args.payload,
      parentEventId: args.parentEventId,
    });

    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Failed to create event");
    return event;
  },
});
