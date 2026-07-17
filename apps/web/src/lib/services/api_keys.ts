import { auth } from '@clerk/nextjs/server'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId } from '@/lib/convexServer'

export interface ApiKeySummary {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
}

interface ApiKeyDoc {
  _id: string
  name: string
  createdAt: number
  lastUsedAt?: number
}

/**
 * List API keys for the authenticated org (safe fields only — never the raw key
 * or hash). Used to server-render the initial key list so the settings page does
 * not fetch on the client via useEffect.
 */
export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const convexOrgId = await resolveConvexOrgId(clerkOrgId)
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const keys = (await client.query(convex.api_keys.listApiKeys, {
    orgId: convexOrgId,
  })) as ApiKeyDoc[]

  return (keys ?? []).map((k) => ({
    id: k._id,
    name: k.name,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt ?? null,
  }))
}
