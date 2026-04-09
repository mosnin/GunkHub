// Organization is created via Clerk webhook, not directly by users

import { query, mutation } from "convex/server";
import { v } from "convex/values";

/**
 * Look up an organization by its Clerk org ID.
 * Called during auth resolution and webhook handlers.
 */
export const getOrganization = query({
  args: {
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();

    return org ?? null;
  },
});

/**
 * Create an organization record. This mutation is called from the Clerk
 * organization.created webhook — not directly by end users.
 */
export const createOrganization = mutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    plan: v.optional(
      v.union(
        v.literal("free"),
        v.literal("pro"),
        v.literal("enterprise"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    // Idempotency guard: if the org already exists return it as-is
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();

    if (existing) {
      return existing;
    }

    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      slug: args.slug,
      plan: args.plan ?? "free",
      createdAt: now,
      updatedAt: now,
    });

    const org = await ctx.db.get(orgId);
    if (!org) throw new Error("Failed to create organization");
    return org;
  },
});
