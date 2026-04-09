import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth } from "./helpers";

/**
 * List all projects for the authenticated organization.
 */
export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    const auth = await requireAuth(ctx);

    // Resolve the Convex org document from the Clerk org ID
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", auth.orgId))
      .unique();

    if (!org) return [];

    return await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
  },
});

/**
 * Get a single project by id. Verifies org ownership.
 */
export const getProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    // Verify org ownership
    const org = await ctx.db.get(project.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return project;
  },
});

/**
 * Create a new project in the authenticated organization.
 */
export const createProject = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", auth.orgId))
      .unique();

    if (!org) {
      throw new Error("Organization not found. Ensure the org is synced.");
    }

    const now = Date.now();
    return await ctx.db.insert("projects", {
      orgId: org._id,
      name: args.name,
      slug: args.slug,
      description: args.description,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Update project name, slug, or description.
 */
export const updateProject = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
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

    const updates: Partial<{ name: string; slug: string; description: string; updatedAt: number }> = {
      updatedAt: Date.now(),
    };
    if (args.name !== undefined) updates.name = args.name;
    if (args.slug !== undefined) updates.slug = args.slug;
    if (args.description !== undefined) updates.description = args.description;

    await ctx.db.patch(args.projectId, updates);
    return args.projectId;
  },
});
