import { query, mutation } from "convex/server";
import { v } from "convex/values";
import { requireOrgMembership } from "./auth.js";

/**
 * List all projects belonging to an organization.
 */
export const listProjects = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    return projects;
  },
});

/**
 * Get a single project by ID. Verifies org membership.
 */
export const getProject = query({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    await requireOrgMembership(ctx, project.orgId);
    return project;
  },
});

/**
 * Create a new project within an organization.
 */
export const createProject = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    // Enforce slug uniqueness within the org
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("orgId", args.orgId).eq("slug", args.slug),
      )
      .unique();

    if (existing) {
      throw new Error(
        `A project with slug "${args.slug}" already exists in this organization.`,
      );
    }

    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      orgId: args.orgId,
      name: args.name,
      slug: args.slug,
      description: args.description,
      createdAt: now,
      updatedAt: now,
    });

    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("Failed to create project");
    return project;
  },
});

/**
 * Update a project's mutable fields. Slug is intentionally excluded — it is
 * immutable after creation to preserve stable URL references.
 */
export const updateProject = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    await requireOrgMembership(ctx, project.orgId);

    const patch: { name?: string; description?: string; updatedAt: number } = {
      updatedAt: Date.now(),
    };
    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description;

    await ctx.db.patch(args.projectId, patch);

    return await ctx.db.get(args.projectId);
  },
});
