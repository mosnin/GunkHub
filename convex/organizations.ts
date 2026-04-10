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
 * Upsert an organization record. Creates the org if it does not exist;
 * updates name and slug if it does. Called from the Clerk webhook handler
 * for both organization.created and organization.updated events.
 */
export const upsertOrganization = mutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        slug: args.slug,
        updatedAt: now,
      });
      const updated = await ctx.db.get(existing._id);
      if (!updated) throw new Error("Failed to update organization");
      return updated;
    }

    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      slug: args.slug,
      plan: "free",
      createdAt: now,
      updatedAt: now,
    });

    const org = await ctx.db.get(orgId);
    if (!org) throw new Error("Failed to create organization");
    return org;
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

/**
 * Create or update a user membership record for an organization.
 * Called from the Clerk organizationMembership.created and
 * organizationMembership.updated webhook events.
 *
 * Idempotent: if a membership for (clerkUserId, orgId) already exists, the role
 * is updated if it changed. If the membership does not exist, it is created.
 *
 * Does NOT use Clerk JWT auth — the caller (Next.js webhook route) is authenticated
 * via Svix signature verification, not a Clerk session.
 */
export const upsertMembership = mutation({
  args: {
    clerkUserId: v.string(),
    clerkOrgId: v.string(),
    role: v.union(
      v.literal("admin"),
      v.literal("member"),
      v.literal("viewer"),
    ),
  },
  handler: async (ctx, args) => {
    // Resolve the org record
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();

    if (!org) {
      throw new Error(
        `Organization not found for clerkOrgId: ${args.clerkOrgId}`,
      );
    }

    // Look for an existing membership
    const existing = await ctx.db
      .query("user_memberships")
      .withIndex("by_clerk_user", (q) =>
        q.eq("clerkUserId", args.clerkUserId),
      )
      .filter((q) => q.eq(q.field("orgId"), org._id))
      .unique();

    if (existing) {
      // Idempotent: only patch if the role changed
      if (existing.role !== args.role) {
        await ctx.db.patch(existing._id, { role: args.role });
      }
      const updated = await ctx.db.get(existing._id);
      if (!updated) throw new Error("Membership record disappeared after patch");
      return updated;
    }

    const membershipId = await ctx.db.insert("user_memberships", {
      clerkUserId: args.clerkUserId,
      orgId: org._id,
      role: args.role,
      joinedAt: Date.now(),
    });

    const membership = await ctx.db.get(membershipId);
    if (!membership) throw new Error("Failed to create membership");
    return membership;
  },
});
