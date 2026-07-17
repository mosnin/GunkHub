import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { requireOrgMembership } from "./auth.js";

/**
 * List all agents belonging to an organization (not filtered by project).
 * Returns full agent docs (id + name + slug + ...), which is a superset of what
 * the runs-page agent filter dropdown needs. Replaces the deleted
 * listDistinctAgents, which did a full runs-table scan + N+1 agent fetch.
 */
export const listAgentsByOrg = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const agents = await ctx.db
      .query("agents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    return agents;
  },
});

/**
 * List all agents belonging to a project.
 */
export const listAgents = query({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    await requireOrgMembership(ctx, project.orgId);

    const agents = await ctx.db
      .query("agents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    return agents;
  },
});

/**
 * Get a single agent by ID.  Verifies org membership.
 */
export const getAgent = query({
  args: {
    agentId: v.id("agents"),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) {
      throw new Error("Agent not found");
    }
    await requireOrgMembership(ctx, agent.orgId);
    return agent;
  },
});

/**
 * Create a new agent within a project.
 */
export const createAgent = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    await requireOrgMembership(ctx, project.orgId);

    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
      orgId: project.orgId,
      projectId: args.projectId,
      name: args.name,
      slug: args.slug,
      description: args.description,
      createdAt: now,
      updatedAt: now,
    });

    const agent = await ctx.db.get(agentId);
    if (!agent) throw new Error("Failed to create agent");
    return agent;
  },
});
