'use server'

import { auth } from '@clerk/nextjs/server'

import { updateRunTags } from '@/lib/services/runs'

/**
 * Server action: replace the tag list for a run.
 * Requires an active Clerk session. Role enforcement is applied at the Convex
 * mutation layer (admin role required).
 * Returns null on success, or an error message string on failure.
 */
export async function updateRunTagsAction(
  runId: string,
  tags: string[],
): Promise<string | null> {
  const { orgId } = auth()
  if (!orgId) return 'Not authenticated'

  try {
    await updateRunTags(runId, tags)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'Failed to update tags'
  }
}
