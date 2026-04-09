import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth } from "./helpers";

// STATUS TRANSITIONS: pending→running→completed|failed|cancelled only. No other transitions allowed.

/**
 * List runs for the authenticated org. Supports optional filters.
 * Returns runs ordered by startedAt descending.
 */
export const listRuns = query({
  args: {
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    status: v.optional(v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    )),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", auth.orgId))
      .unique();

    if (!org) return [];

    let runs;

    if (args.status) {
      runs = await ctx.db
        .query("runs")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", org._id).eq("status", args.status!)
        )
        .order("desc")
        .collect();
    } else {
      runs = await ctx.db
        .query("runs")
        .withIndex("by_org_started", (q) => q.eq("orgId", org._id))
        .order("desc")
        .collect();
    }

    // Apply optional filters
    if (args.projectId) {
      runs = runs.filter((r) => r.projectId === args.projectId);
    }
    if (args.agentId) {
      runs = runs.filter((r) => r.agentId === args.agentId);
    }

    const limit = args.limit ?? 50;
    return runs.slice(0, limit);
  },
});

/**
 * Get a single run by id. Verifies org ownership.
 */
export const getRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return run;
  },
});

/**
 * Create a new run with status "pending".
 */
export const createRun = mutation({
  args: {
    agentId: v.id("agents"),
    agentVersionId: v.optional(v.id("agentVersions")),
    projectId: v.id("projects"),
    metadata: v.any(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");

    const org = await ctx.db.get(agent.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    const project = await ctx.db.get(args.projectId);
    if (!project || project.orgId !== org._id) {
      throw new Error("Project not found or does not belong to this organization");
    }

    return await ctx.db.insert("runs", {
      agentId: args.agentId,
      agentVersionId: args.agentVersionId,
      projectId: args.projectId,
      orgId: org._id,
      status: "pending",
      startedAt: Date.now(),
      metadata: args.metadata,
      tags: args.tags,
      eventCount: 0,
    });
  },
});

/**
 * Transition a run from pending → running.
 */
export const startRun = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    if (run.status !== "pending") {
      throw new Error(`Invalid transition: run is in status "${run.status}", expected "pending"`);
    }

    await ctx.db.patch(args.runId, {
      status: "running",
      startedAt: Date.now(),
    });
  },
});

/**
 * Transition a run from running → completed.
 */
export const completeRun = mutation({
  args: {
    runId: v.id("runs"),
    completedAt: v.optional(v.number()),
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
      throw new Error(`Invalid transition: run is in status "${run.status}", expected "running"`);
    }

    const completedAt = args.completedAt ?? Date.now();
    const durationMs = completedAt - run.startedAt;

    await ctx.db.patch(args.runId, {
      status: "completed",
      completedAt,
      durationMs,
    });
  },
});

/**
 * Transition a run from running → failed.
 */
export const failRun = mutation({
  args: {
    runId: v.id("runs"),
    errorMessage: v.string(),
    errorCode: v.optional(v.string()),
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
      throw new Error(`Invalid transition: run is in status "${run.status}", expected "running"`);
    }

    const completedAt = Date.now();
    await ctx.db.patch(args.runId, {
      status: "failed",
      completedAt,
      durationMs: completedAt - run.startedAt,
      errorMessage: args.errorMessage,
      errorCode: args.errorCode,
    });
  },
});

/**
 * Transition a run from running → cancelled.
 */
export const cancelRun = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    if (run.status !== "running") {
      throw new Error(`Invalid transition: run is in status "${run.status}", expected "running"`);
    }

    const completedAt = Date.now();
    await ctx.db.patch(args.runId, {
      status: "cancelled",
      completedAt,
      durationMs: completedAt - run.startedAt,
    });
  },
});
