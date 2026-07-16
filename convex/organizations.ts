// Organization is created via Clerk webhook, not directly by users

import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";

/**
 * Shared-secret gate for webhook-only lifecycle mutations.
 *
 * upsertOrganization / createOrganization / upsertMembership are reachable on
 * the public Convex function surface, so possession of the deployment URL is not
 * a sufficient authorization signal. The Clerk webhook route (which has already
 * verified the Svix signature) proves it is the trusted caller by presenting the
 * shared secret configured in CONVEX_WEBHOOK_SECRET. Without this gate any client
 * could forge an org record or an admin membership row and defeat tenancy.
 *
 * NOTE: The long-term fix (tracked in ADR-0023) is to convert these to
 * internalMutation invoked from a Convex httpAction that performs Svix
 * verification in-backend. The shared secret closes the hole until that lands.
 */
function assertWebhookSecret(provided: string): void {
  const expected = process.env['CONVEX_WEBHOOK_SECRET'];
  if (!expected) {
    throw new Error(
      "CONVEX_WEBHOOK_SECRET is not configured on the Convex deployment",
    );
  }
  // Compare without an early content short-circuit so match/mismatch timing does
  // not vary with how many leading bytes are correct. (Length still affects the
  // loop bound, but the secret is a fixed-length random token, so that is moot.)
  let diff = provided.length ^ expected.length;
  const len = Math.max(provided.length, expected.length);
  for (let i = 0; i < len; i++) {
    diff |= (provided.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  if (diff !== 0) {
    throw new Error("Unauthorized");
  }
}

/**
 * Look up an organization by its Clerk org ID.
 * Called during auth resolution and webhook handlers.
 */
export const getOrganization = query({
  args: {
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Authorization: a caller may only resolve their OWN organization. Previously
    // this was a public query with no auth, letting anyone enumerate org metadata
    // (name/slug/plan) by guessing Clerk org IDs. Require an authenticated identity
    // whose org_id claim matches the requested org.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized");
    }
    const callerOrgId = (identity as Record<string, unknown>)["org_id"] as
      | string
      | undefined;
    if (callerOrgId !== args.clerkOrgId) {
      throw new Error("Unauthorized: cannot resolve another organization");
    }

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
    webhookSecret: v.string(),
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    assertWebhookSecret(args.webhookSecret);
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
    webhookSecret: v.string(),
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
    assertWebhookSecret(args.webhookSecret);
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
    webhookSecret: v.string(),
    clerkUserId: v.string(),
    clerkOrgId: v.string(),
    role: v.union(
      v.literal("admin"),
      v.literal("member"),
      v.literal("viewer"),
    ),
  },
  handler: async (ctx, args) => {
    assertWebhookSecret(args.webhookSecret);
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
