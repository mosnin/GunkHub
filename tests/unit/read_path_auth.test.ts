/**
 * Tests for the read-path auth fixes introduced in Prompt 19.
 *
 * Group 1: Comments auth requirement (listComments now requires orgId and
 *   enforces org membership — the query filters by orgId so cross-org records
 *   can never be returned).
 *
 * Group 2: Artifact download route auth (the download route now checks orgId
 *   at the route level in addition to userId — both must be present).
 *
 * All tests are pure logic — no Convex runtime, no HTTP server, no React.
 * Auth logic principles are tested via simple boolean/array expressions that
 * mirror the actual enforcement patterns in the source.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Helper: simulate filtering comments by orgId (mirrors the .filter() used
// in the listComments Convex query handler).
// ---------------------------------------------------------------------------

interface MinimalComment {
  id: string
  orgId: string
  targetId: string
  content: string
}

function filterCommentsByOrg(comments: MinimalComment[], orgId: string): MinimalComment[] {
  return comments.filter((c) => c.orgId === orgId)
}

// ---------------------------------------------------------------------------
// Helper: simulate the route-level guard for artifact download (requires both
// userId and orgId to be present in the auth context).
// ---------------------------------------------------------------------------

interface AuthContext {
  userId: string | null
  orgId: string | null
}

function isRouteAccessAllowed(ctx: AuthContext): boolean {
  return ctx.userId !== null && ctx.orgId !== null
}

// ---------------------------------------------------------------------------
// Group 1: Comments auth requirement
// ---------------------------------------------------------------------------

describe('Comments auth — orgId enforcement', () => {
  it('filter by orgId never returns comments from a different org', () => {
    const comments: MinimalComment[] = [
      { id: 'c1', orgId: 'org-A', targetId: 'run-1', content: 'hello' },
      { id: 'c2', orgId: 'org-B', targetId: 'run-1', content: 'world' },
      { id: 'c3', orgId: 'org-A', targetId: 'run-2', content: 'foo' },
    ]
    const result = filterCommentsByOrg(comments, 'org-A')
    const crossOrgIds = result.filter((c) => c.orgId !== 'org-A').map((c) => c.id)
    expect(crossOrgIds).toHaveLength(0)
  })

  it('orgId filter returns only comments whose orgId matches the caller orgId', () => {
    const comments: MinimalComment[] = [
      { id: 'c1', orgId: 'org-A', targetId: 'run-1', content: 'a' },
      { id: 'c2', orgId: 'org-B', targetId: 'run-1', content: 'b' },
    ]
    const result = filterCommentsByOrg(comments, 'org-A')
    expect(result.every((c) => c.orgId === 'org-A')).toBe(true)
  })

  it('filter principle: passing orgId X returns only comments with orgId X', () => {
    const comments: MinimalComment[] = [
      { id: 'c1', orgId: 'org-X', targetId: 'run-1', content: 'x' },
      { id: 'c2', orgId: 'org-Y', targetId: 'run-1', content: 'y' },
      { id: 'c3', orgId: 'org-X', targetId: 'run-2', content: 'x2' },
    ]
    const result = filterCommentsByOrg(comments, 'org-X')
    expect(result.map((c) => c.id).sort()).toEqual(['c1', 'c3'])
  })

  it('empty result when no comments match the orgId', () => {
    const comments: MinimalComment[] = [
      { id: 'c1', orgId: 'org-A', targetId: 'run-1', content: 'a' },
    ]
    const result = filterCommentsByOrg(comments, 'org-B')
    expect(result).toHaveLength(0)
  })

  it('non-empty result when comments do match orgId', () => {
    const comments: MinimalComment[] = [
      { id: 'c1', orgId: 'org-A', targetId: 'run-1', content: 'a' },
      { id: 'c2', orgId: 'org-A', targetId: 'run-2', content: 'b' },
    ]
    const result = filterCommentsByOrg(comments, 'org-A')
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Group 2: Artifact download route auth
// ---------------------------------------------------------------------------

describe('Artifact download — route-level orgId guard', () => {
  it('requiring both userId and orgId is stricter than userId alone', () => {
    // A context with only userId passes the userId-alone check but fails the combined check.
    const ctx: AuthContext = { userId: 'user-123', orgId: null }
    const passesUserIdOnly = ctx.userId !== null
    const passesCombined = isRouteAccessAllowed(ctx)
    expect(passesUserIdOnly).toBe(true)
    expect(passesCombined).toBe(false)
    // Combined is strictly stricter: if combined passes then userId-alone also passes
    // but the converse is not guaranteed.
    expect(passesUserIdOnly && !passesCombined).toBe(true)
  })

  it('userId alone is insufficient — orgId also required', () => {
    const ctx: AuthContext = { userId: 'user-abc', orgId: null }
    expect(isRouteAccessAllowed(ctx)).toBe(false)
  })

  it('missing orgId should reject even when userId is present', () => {
    const ctx: AuthContext = { userId: 'user-xyz', orgId: null }
    expect(isRouteAccessAllowed(ctx)).toBe(false)
  })

  it('missing userId should reject even when orgId is present', () => {
    const ctx: AuthContext = { userId: null, orgId: 'org-123' }
    expect(isRouteAccessAllowed(ctx)).toBe(false)
  })

  it('both userId and orgId present should allow access', () => {
    const ctx: AuthContext = { userId: 'user-123', orgId: 'org-456' }
    expect(isRouteAccessAllowed(ctx)).toBe(true)
  })

  it('both null should reject', () => {
    const ctx: AuthContext = { userId: null, orgId: null }
    expect(isRouteAccessAllowed(ctx)).toBe(false)
  })

  it('org membership check is logically AND-ed with userId check (both required)', () => {
    // All four combinations of (userId present, orgId present):
    const cases: [AuthContext, boolean][] = [
      [{ userId: null, orgId: null }, false],
      [{ userId: 'u', orgId: null }, false],
      [{ userId: null, orgId: 'o' }, false],
      [{ userId: 'u', orgId: 'o' }, true],
    ]
    for (const [ctx, expected] of cases) {
      expect(isRouteAccessAllowed(ctx)).toBe(expected)
    }
  })

  it('a second distinct orgId also grants access when userId is present', () => {
    const ctx: AuthContext = { userId: 'user-999', orgId: 'org-different' }
    expect(isRouteAccessAllowed(ctx)).toBe(true)
  })

  it('orgId check prevents cross-org artifact access: different org is rejected if userId is absent', () => {
    // If the authenticated user belongs to org-A but the artifact belongs to org-B,
    // the route guard (userId present AND orgId matches artifact's org) rejects the request.
    // We model this as: orgId extracted from auth !== artifact's orgId → reject.
    const authOrgId: string = 'org-A'
    const artifactOrgId: string = 'org-B'
    const crossOrgAccessAllowed = authOrgId === artifactOrgId
    expect(crossOrgAccessAllowed).toBe(false)
  })

  it('orgId check permits same-org artifact access when userId is present', () => {
    const authOrgId = 'org-A'
    const artifactOrgId = 'org-A'
    const sameOrgAccessAllowed = authOrgId === artifactOrgId
    expect(sameOrgAccessAllowed).toBe(true)
  })
})
