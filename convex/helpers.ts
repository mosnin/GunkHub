import { MutationCtx, QueryCtx } from "./_generated/server";

// SECURITY: Every query/mutation must call requireAuth and use the returned orgId for all DB queries.
// Never query data without org-scoping. This is the tenancy boundary.

export async function requireAuth(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Authentication required");
  }
  // Clerk puts the org ID in the JWT as orgId claim
  const orgId = identity.orgId as string | undefined;
  if (!orgId) {
    throw new Error("No active organization. Select an organization to continue.");
  }
  return {
    identity,
    orgId,
    clerkUserId: identity.subject,
  };
}

export async function requireOrgAccess(
  ctx: QueryCtx | MutationCtx,
  resourceOrgId: string
) {
  const auth = await requireAuth(ctx);
  if (auth.orgId !== resourceOrgId) {
    throw new Error("Access denied: resource belongs to a different organization");
  }
  return auth;
}
