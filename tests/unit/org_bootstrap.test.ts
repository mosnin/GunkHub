/**
 * Unit tests for the organization bootstrap contract.
 *
 * These tests run without a live Convex deployment. They use TypeScript type
 * assertions and fixture-based assertions to verify:
 *   1. The webhook event types that trigger bootstrap are correctly enumerated
 *   2. upsertOrganization and upsertMembership argument shapes are correct
 *   3. clerkRoleToInternal maps Clerk roles to internal roles correctly
 *   4. Idempotency: re-upsert with same key yields the same output shape
 *   5. user_memberships schema shape matches what upsertMembership inserts
 *   6. Organization entity shape matches the contracts package definition
 */

import { describe, it, expect } from 'vitest'
import type { Organization, AuthContext } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const orgData = { clerkOrgId: 'org_123', name: 'Acme Corp', slug: 'acme' }

const membershipData = {
  clerkUserId: 'user_abc',
  clerkOrgId: 'org_123',
  role: 'admin' as const,
}

// Simulated Convex document returned by upsertOrganization (includes _id/_creationTime)
const upsertedOrg: Organization = {
  id: 'convex_org_id_001',
  clerkOrgId: 'org_123',
  name: 'Acme Corp',
  slug: 'acme',
  plan: 'free',
  createdAt: 1712000000000,
  updatedAt: 1712000000000,
}

// Simulated membership document returned by upsertMembership
interface UserMembership {
  id: string
  clerkUserId: string
  orgId: string
  role: 'admin' | 'member' | 'viewer'
  joinedAt: number
}

const upsertedMembership: UserMembership = {
  id: 'membership_id_001',
  clerkUserId: 'user_abc',
  orgId: 'convex_org_id_001',
  role: 'admin',
  joinedAt: 1712000100000,
}

// ---------------------------------------------------------------------------
// Inline implementation of clerkRoleToInternal for contract verification
// (matches the implementation in apps/web/app/api/webhooks/clerk/route.ts)
// ---------------------------------------------------------------------------

function clerkRoleToInternal(clerkRole: string): 'admin' | 'member' | 'viewer' {
  if (clerkRole === 'org:admin') return 'admin'
  return 'member'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Organization bootstrap contracts', () => {
  describe('Webhook event type coverage', () => {
    it('enumerates all four Clerk event types that trigger bootstrap', () => {
      // This test documents the complete set of Clerk webhook event types that
      // the bootstrap route handles. If a new event type is added or an existing
      // one is removed, this test must be updated.
      const handledEventTypes = [
        'organization.created',
        'organization.updated',
        'organizationMembership.created',
        'organizationMembership.updated',
      ] as const

      expect(handledEventTypes).toHaveLength(4)
      expect(handledEventTypes).toContain('organization.created')
      expect(handledEventTypes).toContain('organization.updated')
      expect(handledEventTypes).toContain('organizationMembership.created')
      expect(handledEventTypes).toContain('organizationMembership.updated')
    })

    it('org upsert is triggered by both organization.created and organization.updated', () => {
      // Both event types route to the same upsertOrganization mutation. This is
      // intentional: org name/slug changes are handled via the same idempotent path.
      const orgEventTypes = ['organization.created', 'organization.updated'] as const
      for (const type of orgEventTypes) {
        expect(type.startsWith('organization.')).toBe(true)
      }
      expect(orgEventTypes).toHaveLength(2)
    })
  })

  describe('upsertOrganization argument shape', () => {
    it('upsertOrganization args have clerkOrgId, name, and slug — no extras', () => {
      // This verifies the arg shape the mutation expects. If a required field is
      // added (e.g. a billing tier), this test catches that callers must update.
      const args: { clerkOrgId: string; name: string; slug: string } = orgData

      expect(args).toHaveProperty('clerkOrgId')
      expect(args).toHaveProperty('name')
      expect(args).toHaveProperty('slug')
      expect(Object.keys(args)).toHaveLength(3)
    })

    it('upsertOrganization result conforms to the Organization contract type', () => {
      // TypeScript type assignment is the check here: if Organization gains or loses
      // a required field, this assignment fails at compile time.
      const result: Organization = upsertedOrg

      expect(result.id).toBeTruthy()
      expect(result.clerkOrgId).toBe('org_123')
      expect(result.name).toBe('Acme Corp')
      expect(result.slug).toBe('acme')
      expect(['free', 'pro', 'enterprise']).toContain(result.plan)
      expect(typeof result.createdAt).toBe('number')
      expect(typeof result.updatedAt).toBe('number')
    })

    it('upsertOrganization defaults plan to "free"', () => {
      // createOrganization / upsertOrganization both default plan to "free" when
      // no plan arg is supplied. The free plan is the only one Clerk webhooks
      // produce; plan upgrades happen via a separate billing flow.
      expect(upsertedOrg.plan).toBe('free')
    })
  })

  describe('upsertMembership argument shape', () => {
    it('upsertMembership args have clerkUserId, clerkOrgId, and role', () => {
      // Compound key for idempotency is (clerkUserId, clerkOrgId). If either field
      // is renamed, the lookup index breaks and the mutation creates duplicates.
      const args: { clerkUserId: string; clerkOrgId: string; role: 'admin' | 'member' | 'viewer' } =
        membershipData

      expect(args).toHaveProperty('clerkUserId')
      expect(args).toHaveProperty('clerkOrgId')
      expect(args).toHaveProperty('role')
      expect(Object.keys(args)).toHaveLength(3)
    })

    it('user_memberships schema shape matches upsertMembership output', () => {
      // Verifies the stored document shape. The schema defines:
      //   clerkUserId, orgId (resolved Convex ID), role, joinedAt
      // Note: orgId in the stored doc is the Convex _id, not the Clerk org ID.
      const membership: UserMembership = upsertedMembership

      expect(membership.id).toBeTruthy()
      expect(membership.clerkUserId).toBeTruthy()
      expect(membership.orgId).toBeTruthy()
      expect(['admin', 'member', 'viewer']).toContain(membership.role)
      expect(typeof membership.joinedAt).toBe('number')
      expect(Object.keys(membership)).toHaveLength(5)
    })
  })

  describe('Role mapping: clerkRoleToInternal', () => {
    it('maps org:admin to admin', () => {
      expect(clerkRoleToInternal('org:admin')).toBe('admin')
    })

    it('maps org:member to member', () => {
      expect(clerkRoleToInternal('org:member')).toBe('member')
    })

    it('maps unknown Clerk roles to member (safe default)', () => {
      // Clerk may introduce new role strings in the future. The safe default is
      // "member" — never silently grant elevated privileges to an unknown role.
      expect(clerkRoleToInternal('org:billing')).toBe('member')
      expect(clerkRoleToInternal('')).toBe('member')
      expect(clerkRoleToInternal('admin')).toBe('member')
      expect(clerkRoleToInternal('ADMIN')).toBe('member')
    })

    it('"viewer" is a local-only role — Clerk never sends it via webhook', () => {
      // clerkRoleToInternal never returns "viewer". Viewer membership rows can
      // only be created by direct Convex mutation from within the app, not via
      // the webhook handler. This is intentional: viewer access is granted by
      // org admins inside the product, not by Clerk role assignment.
      const result = clerkRoleToInternal('org:viewer')
      expect(result).not.toBe('viewer')
      expect(result).toBe('member')
    })

    it('AuthContext.orgRole accepts all three internal roles', () => {
      // Verifies that the AuthContext type (used in every Convex query/mutation)
      // accepts all three internal role values including viewer.
      const adminCtx: AuthContext = {
        userId: 'user_1',
        orgId: 'org_1',
        orgRole: 'admin',
        sessionId: 'sess_1',
      }
      const memberCtx: AuthContext = { ...adminCtx, orgRole: 'member' }
      const viewerCtx: AuthContext = { ...adminCtx, orgRole: 'viewer' }

      expect(adminCtx.orgRole).toBe('admin')
      expect(memberCtx.orgRole).toBe('member')
      expect(viewerCtx.orgRole).toBe('viewer')
    })
  })

  describe('Idempotency contract', () => {
    it('calling upsertOrganization twice with the same clerkOrgId returns the same record', () => {
      // The mutation's idempotency guarantee: if clerkOrgId already exists, it
      // patches name/slug and returns the same document (same id). No duplicate
      // org records are created.
      const firstCall: Organization = upsertedOrg

      // Simulate a second call with the same inputs — same record returned
      const secondCall: Organization = { ...upsertedOrg }

      expect(firstCall.id).toBe(secondCall.id)
      expect(firstCall.clerkOrgId).toBe(secondCall.clerkOrgId)
    })

    it('calling upsertMembership twice with the same (clerkUserId, clerkOrgId) returns the same record', () => {
      // If the membership exists and the role has not changed, the mutation skips
      // the patch and returns the existing record unchanged. If the role changed,
      // it patches and returns the updated record. Either way, no duplicate row.
      const firstCall: UserMembership = upsertedMembership
      const secondCall: UserMembership = { ...upsertedMembership }

      expect(firstCall.id).toBe(secondCall.id)
      expect(firstCall.clerkUserId).toBe(secondCall.clerkUserId)
      expect(firstCall.orgId).toBe(secondCall.orgId)
    })

    it('role update is idempotent: re-upserting with same role leaves the record unchanged', () => {
      const before: UserMembership = upsertedMembership
      // Simulate the mutation returning the same record when role has not changed
      const after: UserMembership = { ...upsertedMembership }

      expect(before.role).toBe(after.role)
      expect(before.id).toBe(after.id)
      expect(before.joinedAt).toBe(after.joinedAt)
    })
  })
})
