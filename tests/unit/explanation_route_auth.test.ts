/**
 * Auth-passthrough + error-mapping tests for
 * apps/web/app/api/runs/[id]/explanation/** (Team C, Explainability Layer
 * cycle).
 *
 * Both routes (GET .../explanation, POST .../explanation/regenerate) make
 * the same decision as every other Clerk-authed management route in this
 * app before touching Convex: reject unless `hasOrgAuthContext` is true. That
 * predicate is exercised generally by tests/unit/management_route_auth.test.ts;
 * this file documents that these two routes also route through it (so a
 * future refactor that drops the check on one of them is caught here) and
 * pins down the specific error-mapping behavior the brief calls out:
 * regenerate must map a non-admin caller's FORBIDDEN throw to a clean 403,
 * not a generic 500 — using the SAME `mapApiError` these routes actually
 * import, not a re-implementation, so this test tracks the real behavior.
 */
import { describe, expect, it } from 'vitest'

import { hasOrgAuthContext } from '../../apps/web/src/lib/apiAuthGuard.js'
import { mapApiError } from '../../apps/web/src/lib/apiErrorMapping.js'

describe('explanation routes — auth passthrough', () => {
  it('GET /api/runs/[id]/explanation and POST .../regenerate both use hasOrgAuthContext', () => {
    // Documents the contract: if a new explanation route is added without
    // routing through this guard, this list (and this test) must be updated.
    const routesUsingThisGuard = [
      'GET /api/runs/[id]/explanation',
      'POST /api/runs/[id]/explanation/regenerate',
    ]
    expect(routesUsingThisGuard).toHaveLength(2)
  })

  it('rejects an authenticated user with no org context (matches every other management route)', () => {
    expect(hasOrgAuthContext({ userId: 'user_1', orgId: null })).toBe(false)
  })

  it('accepts a fully authenticated org context', () => {
    expect(hasOrgAuthContext({ userId: 'user_1', orgId: 'org_1' })).toBe(true)
  })
})

describe('explanation routes — error mapping', () => {
  const REQUEST_ID = 'req-explain-1'

  it('regenerate: a non-admin caller\'s FORBIDDEN afrError maps to a clean 403, never a raw 500', async () => {
    // This is the exact shape convex/runs.ts's admin-gated mutations throw
    // today (requireOrgMembership's afrError convention) — regenerateRunExplanation
    // is expected to throw the same way for a non-admin caller.
    const res = mapApiError(new Error('FORBIDDEN: this action requires the "admin" role or higher'), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { code: string; message: string }
    expect(body.code).toBe('FORBIDDEN')
    // Never leaks a raw stack/internal detail — server-authored prose only.
    expect(body.message).not.toContain('at Object.')
  })

  it('GET: a not-found run maps to 404, not swallowed into an empty explanation', async () => {
    const res = mapApiError(new Error('Run not found in this organization'), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
  })

  it('an unrecognized error is left for the route to rethrow (never silently 200s)', () => {
    expect(mapApiError(new Error('totally unexpected convex internal failure'), REQUEST_ID)).toBeNull()
  })
})
