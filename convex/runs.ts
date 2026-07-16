// Status transitions: pending -> running -> completed|failed|cancelled|timed_out

import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./helpers/pagination.js";

/**
 * List runs scoped to the caller's org, with optional filters.
 */
export const listRuns = query({
  args: {
    orgId: v.id("organizations"),
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled"),
        v.literal("timed_out"),
      ),
    ),
    startedAfter: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    let runsQuery;

    if (args.agentId !== undefined) {
      // Agent filter — use by_agent_started for date range support
      if (args.startedAfter !== undefined) {
        runsQuery = ctx.db.query("runs").withIndex("by_agent_started", (q) =>
          q.eq("agentId", args.agentId!).gte("startedAt", args.startedAfter!),
        );
      } else {
        runsQuery = ctx.db.query("runs").withIndex("by_agent_started", (q) =>
          q.eq("agentId", args.agentId!),
        );
      }
    } else if (args.projectId !== undefined) {
      // Project filter — use by_project_started for date range support
      if (args.startedAfter !== undefined) {
        runsQuery = ctx.db.query("runs").withIndex("by_project_started", (q) =>
          q.eq("projectId", args.projectId!).gte("startedAt", args.startedAfter!),
        );
      } else {
        runsQuery = ctx.db.query("runs").withIndex("by_project_started", (q) =>
          q.eq("projectId", args.projectId!),
        );
      }
    } else if (args.status !== undefined && args.startedAfter !== undefined) {
      // Combined status + date range — use new compound index
      runsQuery = ctx.db.query("runs").withIndex("by_org_status_started", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status!).gte("startedAt", args.startedAfter!),
      );
    } else if (args.status !== undefined) {
      // Status filter only
      runsQuery = ctx.db.query("runs").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status!),
      );
    } else if (args.startedAfter !== undefined) {
      // Date range only — use existing by_org_started
      runsQuery = ctx.db.query("runs").withIndex("by_org_started", (q) =>
        q.eq("orgId", args.orgId).gte("startedAt", args.startedAfter!),
      );
    } else {
      // No filters — all runs for org
      runsQuery = ctx.db.query("runs").withIndex("by_org", (q) =>
        q.eq("orgId", args.orgId),
      );
    }

    // Keep orgId safety check only — other conditions are now covered by index selection.
    // This prevents cross-org data leakage in case an invalid agentId or projectId is passed.
    const filtered = runsQuery.filter((q) => q.eq(q.field("orgId"), args.orgId));

    const page = await filtered.paginate({ numItems: limit, cursor: args.cursor ?? null });

    return {
      runs: page.page,
      nextCursor: page.isDone ? undefined : page.continueCursor,
      total: page.page.length,
    };
  },
});

/**
 * Get a single run by ID.  Throws if not found or caller lacks access.
 */
export const getRun = query({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      throw new Error("Run not found");
    }
    await requireOrgMembership(ctx, run.orgId);
    return run;
  },
});

/**
 * Create a new run record.  Validates org membership before inserting.
 */
export const createRun = mutation({
  args: {
    orgId: v.id("organizations"),
    projectId: v.id("projects"),
    agentId: v.id("agents"),
    agentVersionId: v.optional(v.id("agent_versions")),
    metadata: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
    triggeredBy: v.optional(v.string()),
    sdkVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "member" });

    const now = Date.now();
    const runId = await ctx.db.insert("runs", {
      orgId: args.orgId,
      projectId: args.projectId,
      agentId: args.agentId,
      agentVersionId: args.agentVersionId,
      status: "pending",
      startedAt: now,
      endedAt: undefined,
      metadata: args.metadata ?? {},
      tags: args.tags ?? [],
      triggeredBy: args.triggeredBy,
      sdkVersion: args.sdkVersion,
    });

    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Failed to create run");
    return run;
  },
});

/**
 * Update the status of a run, enforcing valid terminal-state transitions.
 * Transitions: pending -> running -> completed | failed | cancelled | timed_out
 */
export const updateRunStatus = mutation({
  args: {
    runId: v.id("runs"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("timed_out"),
    ),
    endedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    await requireOrgMembership(ctx, run.orgId);

    const TERMINAL_STATUSES = new Set([
      "completed",
      "failed",
      "cancelled",
      "timed_out",
    ]);

    // Prevent mutation of already-terminal runs
    if (TERMINAL_STATUSES.has(run.status)) {
      throw new Error(
        `Cannot transition run from terminal status "${run.status}"`,
      );
    }

    // Validate forward-only transitions
    const VALID_TRANSITIONS: Record<string, string[]> = {
      pending: ["running", "cancelled"],
      running: ["completed", "failed", "cancelled", "timed_out"],
    };

    const allowed = VALID_TRANSITIONS[run.status] ?? [];
    if (!allowed.includes(args.status)) {
      throw new Error(
        `Invalid status transition from "${run.status}" to "${args.status}"`,
      );
    }

    await ctx.db.patch(args.runId, {
      status: args.status,
      endedAt: TERMINAL_STATUSES.has(args.status)
        ? (args.endedAt ?? Date.now())
        : args.endedAt,
    });

    return await ctx.db.get(args.runId);
  },
});

/**
 * Update the tags on a run. Caller must be a member of the run's org.
 * Tags are replaced wholesale — pass the full desired tag array.
 */
export const updateRunTags = mutation({
  args: {
    runId: v.id("runs"),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    await requireOrgMembership(ctx, run.orgId, { minimumRole: "admin" });

    // Normalize: trim whitespace, deduplicate, discard empty strings
    const normalized = [...new Set(args.tags.map((t) => t.trim()).filter(Boolean))];

    await ctx.db.patch(args.runId, { tags: normalized });

    const updated = await ctx.db.get(args.runId);
    if (!updated) throw new Error("Run not found after update");
    return updated;
  },
});
