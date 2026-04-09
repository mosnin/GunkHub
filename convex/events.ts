import { mutation, query } from "./_generated/server";
import { v, Id } from "convex/values";
import { requireAuth } from "./helpers";

// APPEND ONLY: Do not add update or delete mutations for events. This is a hard invariant.

/**
 * Append a single event to a run's event stream.
 * MUST verify the run belongs to the authenticated org.
 * MUST verify the run is in "running" state.
 * Increments run.eventCount on each insertion.
 */
export const appendEvent = mutation({
  args: {
    runId: v.id("runs"),
    type: v.string(),
    category: v.string(),
    sequence: v.number(),
    timestamp: v.number(),
    payload: v.optional(v.any()),
    payloadExternalized: v.optional(v.boolean()),
    artifactId: v.optional(v.id("artifacts")),
    parentEventId: v.optional(v.id("events")),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    if (run.status !== "running") {
      throw new Error(`Cannot append event: run is in status "${run.status}", expected "running"`);
    }

    const eventId = await ctx.db.insert("events", {
      runId: args.runId,
      orgId: run.orgId,
      type: args.type,
      category: args.category,
      sequence: args.sequence,
      timestamp: args.timestamp,
      payload: args.payload,
      payloadExternalized: args.payloadExternalized ?? false,
      artifactId: args.artifactId,
      parentEventId: args.parentEventId,
      metadata: args.metadata ?? {},
    });

    // Increment the run's event counter
    await ctx.db.patch(args.runId, { eventCount: run.eventCount + 1 });

    return eventId;
  },
});

/**
 * Batch append multiple events to a run's event stream.
 * Same validations as appendEvent — run must belong to org and be in "running" state.
 */
export const appendEvents = mutation({
  args: {
    events: v.array(v.object({
      runId: v.id("runs"),
      type: v.string(),
      category: v.string(),
      sequence: v.number(),
      timestamp: v.number(),
      payload: v.optional(v.any()),
      payloadExternalized: v.optional(v.boolean()),
      artifactId: v.optional(v.id("artifacts")),
      parentEventId: v.optional(v.id("events")),
      metadata: v.optional(v.any()),
    })),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    if (args.events.length === 0) return [];

    // Collect unique run IDs and validate each before writing anything
    const runIds = [...new Set(args.events.map((e) => e.runId))];
    const runCache = new Map<string, { eventCount: number; orgId: Id<"organizations"> }>();

    for (const runId of runIds) {
      const run = await ctx.db.get(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);

      const org = await ctx.db.get(run.orgId);
      if (!org || org.clerkOrgId !== auth.orgId) {
        throw new Error("Access denied: resource belongs to a different organization");
      }

      if (run.status !== "running") {
        throw new Error(`Cannot append event: run "${runId}" is in status "${run.status}", expected "running"`);
      }

      runCache.set(runId, { eventCount: run.eventCount, orgId: run.orgId });
    }

    const insertedIds: string[] = [];

    for (const event of args.events) {
      const cached = runCache.get(event.runId)!;
      const eventId = await ctx.db.insert("events", {
        runId: event.runId,
        orgId: cached.orgId,
        type: event.type,
        category: event.category,
        sequence: event.sequence,
        timestamp: event.timestamp,
        payload: event.payload,
        payloadExternalized: event.payloadExternalized ?? false,
        artifactId: event.artifactId,
        parentEventId: event.parentEventId,
        metadata: event.metadata ?? {},
      });
      insertedIds.push(eventId);
      cached.eventCount += 1;
    }

    // Flush updated eventCounts back to each run
    for (const [runId, cached] of runCache.entries()) {
      await ctx.db.patch(runId as Id<"runs">, { eventCount: cached.eventCount });
    }

    return insertedIds;
  },
});

/**
 * List events for a run in sequence order.
 * Supports pagination via afterSeq and limit.
 */
export const listEvents = query({
  args: {
    runId: v.id("runs"),
    afterSeq: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) return [];

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    const limit = args.limit ?? 100;

    if (args.afterSeq !== undefined) {
      return await ctx.db
        .query("events")
        .withIndex("by_run_seq", (q) =>
          q.eq("runId", args.runId).gt("sequence", args.afterSeq!)
        )
        .order("asc")
        .take(limit);
    }

    return await ctx.db
      .query("events")
      .withIndex("by_run_seq", (q) => q.eq("runId", args.runId))
      .order("asc")
      .take(limit);
  },
});

/**
 * Get a single event by id. Verifies org ownership via the event's orgId.
 */
export const getEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const event = await ctx.db.get(args.eventId);
    if (!event) return null;

    const org = await ctx.db.get(event.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return event;
  },
});

/**
 * List events filtered by type for a given run.
 */
export const listEventsByType = query({
  args: {
    runId: v.id("runs"),
    type: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) return [];

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    const limit = args.limit ?? 100;
    return await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .filter((q) => q.eq(q.field("type"), args.type))
      .take(limit);
  },
});
