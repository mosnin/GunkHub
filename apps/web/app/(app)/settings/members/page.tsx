import type { Membership } from '@/lib/services/organizations'
import type { Metadata } from 'next'

import { MembersSection } from '@/components/settings/MembersSection'
import { getOrganizationSettings, listMemberships } from '@/lib/services/organizations'

export const metadata: Metadata = { title: 'Members — Settings' }

export default async function SettingsMembersPage() {
  // Server-rendered — no client-side useEffect fetch. Both calls are
  // independent reads scoped to the caller's org (see listMemberships in
  // convex/organizations.ts and getOrganizationSettings alongside it).
  let memberships: Membership[] = []
  let loadError: string | null = null
  try {
    memberships = await listMemberships()
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load members'
  }

  let pendingDeletionAt: number | null = null
  try {
    const settings = await getOrganizationSettings()
    pendingDeletionAt = settings.pendingDeletionAt
  } catch {
    // Non-fatal for this page — the pending-deletion banner is a courtesy,
    // not the primary content. Members list load errors are surfaced above.
  }

  return (
    <MembersSection
      memberships={memberships}
      loadError={loadError}
      pendingDeletionAt={pendingDeletionAt}
    />
  )
}
