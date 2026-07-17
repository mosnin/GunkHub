import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { recordAuditEvent } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { MAX_PAGE_SIZE } from "./helpers/pagination.js";

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

    // Bounded: at most MAX_PAGE_SIZE agents returned (no unbounded .collect()).
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_PAGE_SIZE);

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

    // Bounded: at most MAX_PAGE_SIZE agents returned (no unbounded .collect()).
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_PAGE_SIZE);

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
    // P0 authorization gate: creating an agent is a structural change, gated to
    // "admin" like createProject (above it in the hierarchy) and
    // createAgentVersion (below it). Previously this defaulted to viewer.
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, project.orgId, { minimumRole: "admin" });

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

    await recordAuditEvent(ctx, {
      orgId: project.orgId,
      actorClerkUserId: userId,
      action: "agent.created",
      targetType: "agent",
      targetId: String(agentId),
      metadata: { name: args.name, slug: args.slug, projectId: String(args.projectId) },
    });

    return agent;
  },
});
