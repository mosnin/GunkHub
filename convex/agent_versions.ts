import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { requireOrgMembership } from "./auth.js";

/**
 * Create a new version for an agent. Requires admin role.
 * Version strings must be unique per agent.
 */
export const createAgentVersion = mutation({
  args: {
    agentId: v.id("agents"),
    version: v.string(),
    changelog: v.optional(v.string()),
    configSnapshot: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");

    await requireOrgMembership(ctx, agent.orgId, { minimumRole: "admin" });

    const trimmedVersion = args.version.trim();
    if (!trimmedVersion) throw new Error("version is required");
    if (trimmedVersion.length > 64) {
      throw new Error("version must be 64 characters or fewer");
    }

    // Uniqueness check within the agent
    const existing = await ctx.db
      .query("agent_versions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .collect();

    const duplicate = existing.find((v) => v.version === trimmedVersion);
    if (duplicate) {
      throw new Error(`Version "${trimmedVersion}" already exists for this agent`);
    }

    const id = await ctx.db.insert("agent_versions", {
      agentId: args.agentId,
      orgId: agent.orgId,
      version: trimmedVersion,
      createdAt: Date.now(),
      ...(args.changelog !== undefined && { changelog: args.changelog }),
      ...(args.configSnapshot !== undefined && {
        configSnapshot: args.configSnapshot,
      }),
    });

    const doc = await ctx.db.get(id);
    if (!doc) throw new Error("Failed to create agent version");
    return doc;
  },
});

/**
 * List all versions for an agent, newest first.
 */
export const listAgentVersions = query({
  args: {
    agentId: v.id("agents"),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");

    await requireOrgMembership(ctx, agent.orgId);

    return await ctx.db
      .query("agent_versions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .collect();
  },
});

/**
 * List agent versions with cursor-based pagination, newest first.
 * Default page size is 20 — agents rarely have more.
 */
export const paginateAgentVersions = query({
  args: {
    agentId: v.id("agents"),
    numItems: v.optional(v.number()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");
    await requireOrgMembership(ctx, agent.orgId);

    const numItems = Math.min(args.numItems ?? 20, 100);
    const page = await ctx.db
      .query("agent_versions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .paginate({ numItems, cursor: args.cursor });

    return {
      versions: page.page,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Get a single agent version by ID. Verifies org membership.
 */
export const getAgentVersion = query({
  args: {
    versionId: v.id("agent_versions"),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return null;

    await requireOrgMembership(ctx, version.orgId);

    return version;
  },
});
