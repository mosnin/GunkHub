import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth } from "./helpers";

/**
 * List agents for a given project. Verifies the project belongs to the authenticated org.
 */
export const listAgents = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const project = await ctx.db.get(args.projectId);
    if (!project) return [];

    // Verify project belongs to authenticated org
    const org = await ctx.db.get(project.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return await ctx.db
      .query("agents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

/**
 * Get a single agent by id. Verifies org ownership.
 */
export const getAgent = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const agent = await ctx.db.get(args.agentId);
    if (!agent) return null;

    const org = await ctx.db.get(agent.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return agent;
  },
});

/**
 * Create a new agent in a project.
 */
export const createAgent = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");

    const org = await ctx.db.get(project.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    const now = Date.now();
    return await ctx.db.insert("agents", {
      projectId: args.projectId,
      orgId: project.orgId,
      name: args.name,
      description: args.description,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Create a new version snapshot for an agent.
 */
export const createAgentVersion = mutation({
  args: {
    agentId: v.id("agents"),
    version: v.string(),
    metadata: v.any(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");

    const org = await ctx.db.get(agent.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return await ctx.db.insert("agentVersions", {
      agentId: args.agentId,
      orgId: agent.orgId,
      version: args.version,
      metadata: args.metadata,
      createdAt: Date.now(),
    });
  },
});

/**
 * List all versions for an agent, ordered by creation time.
 */
export const listAgentVersions = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const agent = await ctx.db.get(args.agentId);
    if (!agent) return [];

    const org = await ctx.db.get(agent.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return await ctx.db
      .query("agentVersions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .collect();
  },
});
