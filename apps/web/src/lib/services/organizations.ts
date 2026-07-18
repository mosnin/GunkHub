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
