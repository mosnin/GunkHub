import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth } from "./helpers";

/**
 * Upsert an organization by clerkOrgId.
 * Called after Clerk org creation/sync to ensure the org record exists in Convex.
 */
export const getOrCreateOrg = mutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    plan: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"))),
  },
  handler: async (ctx, args) => {
    await requireAuth(ctx);

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (existing) {
      // Update name/slug if they've changed
      await ctx.db.patch(existing._id, {
        name: args.name,
        slug: args.slug,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    const now = Date.now();
    return await ctx.db.insert("organizations", {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      slug: args.slug,
      plan: args.plan ?? "free",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Get an organization by its Convex document id.
 * Requires auth and verifies the authenticated org matches.
 */
export const getOrgById = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const org = await ctx.db.get(args.orgId);
    if (!org) return null;

    // Verify the authenticated org matches the requested org via clerkOrgId
    if (org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return org;
  },
});

/**
 * Get an organization by Clerk org ID.
 * Requires auth and verifies the authenticated org matches.
 */
export const getOrgByClerkId = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    if (auth.orgId !== args.clerkOrgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
  },
});
