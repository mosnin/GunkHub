import { query, mutation } from "convex/server";
import { v } from "convex/values";
import { requireOrgMembership } from "./auth.js";

/**
 * Return the distinct agents that have at least one run in the given org.
 * Used to populate the agent filter dropdown on the runs list page.
 */
export const listDistinctAgents = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    // Collect all runs for the org, then derive the distinct agent IDs.
    // This approach avoids a separate cross-table join and is acceptable
    // at v1 scale (orgId-scoped index keeps the scan bounded).
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const seenAgentIds = new Set<string>();
    const agentIds: string[] = [];
    for (const run of runs) {
      const id = run.agentId as string;
      if (!seenAgentIds.has(id)) {
        seenAgentIds.add(id);
        agentIds.push(id);
      }
    }

    // Fetch the agent records for each distinct agentId.
    const agents = await Promise.all(
      agentIds.map((id) => ctx.db.get(id as Parameters<typeof ctx.db.get>[0])),
    );

    // Filter out any stale IDs where the agent record no longer exists.
    return agents.filter(Boolean);
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
