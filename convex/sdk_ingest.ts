// SDK ingest mutations — called from Next.js API routes WITHOUT Clerk JWT auth.
// Authentication here is via pre-hashed API key only. Do NOT call getAuthContext
// or requireOrgMembership in this file — those require a Clerk JWT.

import { mutation } from "convex/server";
import { v } from "convex/values";
import { Id } from "convex/_generated/dataModel";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Create a new run from an SDK call.  Authenticates via API key hash.
 * The run is created immediately in the "running" state because SDK callers
 * invoke startRun() at the very beginning of execution.
 */
export const sdkCreateRun = mutation({
  args: {
    apiKeyHash: v.string(),
    agentId: v.string(),
    agentVersionId: v.optional(v.string()),
    metadata: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
    triggeredBy: v.optional(v.string()),
    sdkVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db
      .query("api_keys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.apiKeyHash))
      .unique();

    if (!apiKey || apiKey.revokedAt !== undefined) {
      throw new Error("Unauthorized");
    }

    // Update lastUsedAt on the key record (fire-and-forget tracking)
    await ctx.db.patch(apiKey._id, { lastUsedAt: Date.now() });

    const agentId = args.agentId as Id<"agents">;
    const agent = await ctx.db.get(agentId);
    if (!agent) {
      throw new Error("Agent not found");
    }

    // Cross-org protection: the agent must belong to the same org as the API key
    if (agent.orgId !== apiKey.orgId) {
      throw new Error("Unauthorized");
    }

    const agentVersionId = args.agentVersionId
      ? (args.agentVersionId as Id<"agent_versions">)
      : undefined;

    const now = Date.now();
    const runId = await ctx.db.insert("runs", {
      orgId: apiKey.orgId,
      projectId: agent.projectId,
      agentId: agent._id,
      agentVersionId,
      status: "running",
      startedAt: now,
      endedAt: undefined,
      metadata: args.metadata ?? {},
      tags: args.tags ?? [],
      triggeredBy: args.triggeredBy,
      sdkVersion: args.sdkVersion,
    });

    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Failed to create run");

    // Return with _id aliased to id for SDK consumers
    const { _id, ...rest } = run;
    return { id: _id, ...rest };
  },
});

/**
 * Batch-insert events for one or more runs.  Authenticates via API key hash.
 * Events are inserted individually in the order provided by the SDK.
 * The run must be in "running" state; events for terminal runs are rejected.
 */
export const sdkCreateEvents = mutation({
  args: {
    apiKeyHash: v.string(),
    events: v.array(
      v.object({
        runId: v.string(),
        type: v.string(),
        sequenceNumber: v.number(),
        timestamp: v.number(),
        payload: v.any(),
        parentEventId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db
      .query("api_keys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.apiKeyHash))
      .unique();

    if (!apiKey || apiKey.revokedAt !== undefined) {
      throw new Error("Unauthorized");
    }

    const eventIds: string[] = [];

    for (const evt of args.events) {
      const runId = evt.runId as Id<"runs">;
      const run = await ctx.db.get(runId);

      if (!run) {
        throw new Error(`Run not found: ${evt.runId}`);
      }

      // Cross-org protection
      if (run.orgId !== apiKey.orgId) {
        throw new Error("Unauthorized");
      }

      if (run.status !== "running") {
        throw new Error(
          `Cannot append event to run with status "${run.status}". Run must be in "running" state.`,
        );
      }

      const existing = await ctx.db
        .query("events")
        .withIndex("by_run", (q) =>
          q.eq("runId", runId).eq("sequenceNumber", evt.sequenceNumber)
        )
        .unique();

      if (existing !== null) {
        // Idempotent: already stored — return existing ID
        eventIds.push(existing._id);
        continue;
      }

      const parentEventId = evt.parentEventId
        ? (evt.parentEventId as Id<"events">)
        : undefined;

      const eventId = await ctx.db.insert("events", {
        runId,
        orgId: run.orgId,
        type: evt.type,
        sequenceNumber: evt.sequenceNumber,
        timestamp: evt.timestamp,
        payload: evt.payload,
        parentEventId,
      });

      eventIds.push(eventId);
    }

    return { eventIds };
  },
});

/**
 * Transition a run to a terminal status from an SDK call.
 * Authenticates via API key hash.  Prevents double-termination.
 */
export const sdkUpdateRunStatus = mutation({
  args: {
    apiKeyHash: v.string(),
    runId: v.string(),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    endedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db
      .query("api_keys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.apiKeyHash))
      .unique();

    if (!apiKey || apiKey.revokedAt !== undefined) {
      throw new Error("Unauthorized");
    }

    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);

    if (!run) {
      throw new Error("Run not found");
    }

    // Cross-org protection
    if (run.orgId !== apiKey.orgId) {
      throw new Error("Unauthorized");
    }

    if (TERMINAL_STATUSES.has(run.status)) {
      throw new Error(
        `Cannot transition run from terminal status "${run.status}"`,
      );
    }

    await ctx.db.patch(runId, {
      status: args.status,
      endedAt: args.endedAt ?? Date.now(),
    });
  },
});

/**
 * Record an artifact whose content has already been uploaded to blob storage.
 * Authenticates via API key hash (same pattern as sdkCreateEvents).
 */
export const sdkCreateArtifact = mutation({
  args: {
    apiKeyHash: v.string(),
    runId: v.string(),
    eventId: v.optional(v.string()),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    storageKey: v.string(),
    storageBucket: v.string(),
    checksum: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db
      .query("api_keys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.apiKeyHash))
      .unique();

    if (!apiKey || apiKey.revokedAt !== undefined) {
      throw new Error("Unauthorized");
    }

    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);

    if (!run) {
      throw new Error("Run not found");
    }

    // Cross-org protection
    if (run.orgId !== apiKey.orgId) {
      throw new Error("Unauthorized");
    }

    // Deduplication: if an artifact with the same (runId, checksum) already exists,
    // return it instead of inserting a duplicate. This guards against retry scenarios
    // where the blob upload succeeded but the subsequent /api/events call failed.
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_run_checksum", (q) =>
        q.eq("runId", runId).eq("checksum", args.checksum)
      )
      .unique();

    if (existing !== null) {
      return existing;
    }

    const eventId = args.eventId ? (args.eventId as Id<"events">) : undefined;

    // Validate that the eventId belongs to the same run when provided.
    if (eventId !== undefined) {
      const event = await ctx.db.get(eventId);
      if (!event || event.runId !== runId) {
        throw new Error("Event not found or does not belong to the given run");
      }
    }

    const artifactId = await ctx.db.insert("artifacts", {
      runId,
      orgId: run.orgId,
      eventId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      storageKey: args.storageKey,
      storageBucket: args.storageBucket,
      checksum: args.checksum,
      createdAt: Date.now(),
    });

    const artifact = await ctx.db.get(artifactId);
    if (!artifact) throw new Error("Failed to create artifact");
    return artifact;
  },
});
