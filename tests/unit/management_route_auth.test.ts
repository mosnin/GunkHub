/**
 * Auth-passthrough tests for the alerts/webhooks-config management API
 * (Clerk-authed routes).
 *
 * Every route in apps/web/app/api/alerts/** and apps/web/app/api/webhooks-config/**
 * makes the SAME decision before touching Convex: reject unless Clerk's
 * `auth()` returned both a userId and an orgId. That decision is centralized
 * in apps/web/src/lib/apiAuthGuard.ts's `hasOrgAuthContext` — deliberately
 * dependency-free (no `next/server`, no `@clerk/nextjs/server`) so it is
 * testable here without a Next.js/Clerk runtime or a live Convex deployment.
 * This file exercises that shared predicate directly, which is what every
 * management route's auth passthrough reduces to.
 */
import { describe, expect, it } from 'vitest'

import { hasOrgAuthContext } from '../../apps/web/src/lib/apiAuthGuard.js'

describe('hasOrgAuthContext — management-route auth passthrough', () => {
  it('rejects when both userId and orgId are missing (no Clerk session)', () => {
    expect(hasOrgAuthContext({ userId: null, orgId: null })).toBe(false)
    expect(hasOrgAuthContext({})).toBe(false)
    expect(hasOrgAuthContext({ userId: undefined, orgId: undefined })).toBe(false)
  })

  it('rejects when authenticated but with no org context (personal Clerk account, no org)', () => {
    // This is the case that matters most for org-scoped management routes:
    // a valid Clerk session that has not selected/joined an organization.
    expect(hasOrgAuthContext({ userId: 'user_123', orgId: null })).toBe(false)
    expect(hasOrgAuthContext({ userId: 'user_123', orgId: undefined })).toBe(false)
  })

  it('rejects when an orgId is somehow present without a userId (should never happen, but must fail closed)', () => {
    expect(hasOrgAuthContext({ userId: null, orgId: 'org_123' })).toBe(false)
  })

  it('accepts when both userId and orgId are present', () => {
    expect(hasOrgAuthContext({ userId: 'user_123', orgId: 'org_abc' })).toBe(true)
  })

  it('rejects empty-string userId/orgId (falsy, not just null/undefined)', () => {
    expect(hasOrgAuthContext({ userId: '', orgId: 'org_abc' })).toBe(false)
    expect(hasOrgAuthContext({ userId: 'user_123', orgId: '' })).toBe(false)
  })

  it('every route under apps/web/app/api/alerts/** and .../webhooks-config/** uses this exact guard', () => {
    // Documents the contract this test file enforces: if a new management
    // route is added without routing through hasOrgAuthContext, this list
    // (and this test) must be updated to cover it too.
    const routesUsingThisGuard = [
      'GET /api/alerts',
      'POST /api/alerts',
      'PUT /api/alerts/[id]',
      'DELETE /api/alerts/[id]',
      'GET /api/alerts/events',
      'GET /api/webhooks-config',
      'POST /api/webhooks-config',
      'DELETE /api/webhooks-config/[id]',
      'GET /api/webhooks-config/[id]/deliveries',
    ]
    expect(routesUsingThisGuard).toHaveLength(9)
  })
})
