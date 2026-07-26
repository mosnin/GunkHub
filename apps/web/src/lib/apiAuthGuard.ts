/**
 * apiAuthGuard.ts — pure auth-context predicate shared by every Clerk-authed
 * management route added this cycle (alerts/webhooks-config). Deliberately
 * dependency-free (no `next/server`, no `@clerk/nextjs/server` import) so it
 * can be unit-tested without any Next.js or Clerk runtime — see
 * tests/unit/management_route_auth.test.ts. This is the "auth passthrough"
 * decision every route makes BEFORE touching Convex; centralizing it here
 * means the decision itself, not just its 401 JSON rendering, is covered by
 * a pure test.
 */
export interface ClerkAuthResult {
  userId?: string | null | undefined
  orgId?: string | null | undefined
}

/**
 * True when Clerk's `auth()` returned both an authenticated user AND an org
 * context. Every route in this cycle's management API is org-scoped (alert
 * rules, webhook targets — both `orgId`-keyed Convex tables), so there is no
 * "authenticated but no org" success path: both must be present.
 */
export function hasOrgAuthContext(result: ClerkAuthResult): result is { userId: string; orgId: string } {
  return Boolean(result.userId) && Boolean(result.orgId)
}
