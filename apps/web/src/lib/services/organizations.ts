import { auth } from '@clerk/nextjs/server'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId, withConvexTimeout } from '@/lib/convexServer'

export interface OrganizationSettings {
  retentionDays: number | null
  pendingDeletionAt: number | null
}

interface OrganizationSettingsDoc {
  retentionDays?: number
  pendingDeletionAt?: number
}

/** Org membership role — mirrors the closed union on the `user_memberships` table. */
export type MembershipRole = 'admin' | 'member' | 'viewer'

export interface Membership {
  id: string
  clerkUserId: string
  role: MembershipRole
  joinedAt: number
}

interface MembershipDoc {
  _id: string
  clerkUserId: string
  role: MembershipRole
  joinedAt: number
}

/**
 * Read the authenticated org's retention window (ADR 001) and pending-deletion
 * marker. `retentionDays: null` means "retain forever" (no window set).
 * Server-render-safe: no client-side fetch, used to seed RetentionSection.
 */
export async function getOrganizationSettings(): Promise<OrganizationSettings> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const convexOrgId = await resolveConvexOrgId(clerkOrgId)
  const client = await getAuthedClient()

  const doc = (await withConvexTimeout(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    client.query(convex.organizations.getOrganizationSettings, { orgId: convexOrgId }),
  )) as OrganizationSettingsDoc

  return {
    retentionDays: doc.retentionDays ?? null,
    pendingDeletionAt: doc.pendingDeletionAt ?? null,
  }
}

/**
 * List the authenticated org's memberships (roster for /settings/members).
 * Backed by the NEW `organizations:listMemberships` Convex query (added this
 * cycle — see convex/organizations.ts) which gates the read at default
 * "viewer" membership rank. Role changes are Clerk-authoritative and are not
 * writable from this seam — see MembersSection for the link-out note.
 */
export async function listMemberships(): Promise<Membership[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const convexOrgId = await resolveConvexOrgId(clerkOrgId)
  const client = await getAuthedClient()

  const memberships = (await withConvexTimeout(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    client.query(convex.organizations.listMemberships, { orgId: convexOrgId }),
  )) as MembershipDoc[]

  return (memberships ?? []).map((m) => ({
    id: m._id,
    clerkUserId: m.clerkUserId,
    role: m.role,
    joinedAt: m.joinedAt,
  }))
}
