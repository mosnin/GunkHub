import { auth } from '@clerk/nextjs/server'

import type { Agent } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

function mapAgent(doc: Record<string, unknown>): Agent {
  return {
    id: doc._id as string,
    orgId: doc.orgId as string,
    projectId: doc.projectId as string,
    name: doc.name as string,
    slug: doc.slug as string,
    createdAt: doc.createdAt as number,
    updatedAt: doc.updatedAt as number,
    ...(doc.description !== undefined && { description: doc.description as string }),
  }
}

/**
 * Return agents that have at least one run in the authenticated org.
 * Used for the agent filter dropdown on the runs list page.
 */
export async function listDistinctAgents(): Promise<Agent[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found — run onboarding first')

  const orgDoc = org as Record<string, unknown>

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.agents.listDistinctAgents, {
    orgId: orgDoc._id,
  })

  return ((result as Record<string, unknown>[]) ?? []).map(mapAgent)
}
