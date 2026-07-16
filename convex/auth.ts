// All queries and mutations must call getAuthContext and scope to org

import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx, MutationCtx } from "./_generated/server.js";

export interface AuthContextResult {
  userId: string;
  orgId: Id<"organizations">;
  clerkOrgId: string;
}

/** Role rank for hierarchy checks: higher = more privileged. */
const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
};

/**
 * Extracts and validates the auth context from a Convex query or mutation ctx.
 * Throws "Unauthorized" if the caller is not authenticated.
 */
export async function getAuthContext(
  ctx: QueryCtx | MutationCtx,
): Promise<AuthContextResult> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthorized");
  }

  // Clerk embeds org info in the JWT token subject / tokenIdentifier
  // The orgId claim is typically available as a custom claim.
  const clerkUserId = identity.subject;
  const clerkOrgId = (identity as Record<string, unknown>)["org_id"] as
    | string
    | undefined;

  if (!clerkOrgId) {
    throw new Error("Unauthorized: no organization context");
  }

  // Look up the Convex organization record by the Clerk org ID
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();

  if (!org) {
    throw new Error("Unauthorized: organization not found");
  }

  return {
    userId: clerkUserId,
    orgId: org._id,
    clerkOrgId,
  };
}

/**
 * Verifies that the authenticated user is a member of the given organization.
 * Throws "Unauthorized" if membership cannot be confirmed.
 */
export async function requireOrgMembership(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  options?: { minimumRole?: "admin" | "member" | "viewer" },
): Promise<void> {
  const { userId } = await getAuthContext(ctx);

  const membership = await ctx.db
    .query("user_memberships")
    .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", userId))
    .filter((q) => q.eq(q.field("orgId"), orgId))
    .unique();

  if (!membership) {
    throw new Error("Unauthorized: not a member of this organization");
  }

  // Role enforcement: if a minimum role is specified, verify the caller meets it.
  const minimumRole = options?.minimumRole ?? "viewer";
  const actualRank = ROLE_RANK[membership.role] ?? 0;
  const minimumRank = ROLE_RANK[minimumRole] ?? 0;
  if (actualRank < minimumRank) {
    throw new Error(
      `Forbidden: this action requires the "${minimumRole}" role or higher`,
    );
  }
}
