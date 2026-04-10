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
 * List all agents belonging to a project.
 */
export async function listAgents(projectId: string): Promise<Agent[]> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const docs = await client.query(convex.agents.listAgents, { projectId })

  return ((docs as Record<string, unknown>[]) ?? []).map(mapAgent)
}

/**
 * List all agents in the authenticated org (across all projects).
 */
export async function listAgentsByOrg(): Promise<Agent[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found')

  const orgDoc = org as Record<string, unknown>

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const docs = await client.query(convex.agents.listAgentsByOrg, { orgId: orgDoc._id })

  return ((docs as Record<string, unknown>[]) ?? []).map(mapAgent)
}

/** Derive a URL-safe slug from a name. */
function slugifyAgent(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Create a new agent within a project. Requires org membership.
 */
export async function createAgent(input: {
  projectId: string
  name: string
  description?: string
}): Promise<Agent> {
  const { orgId } = auth()
  if (!orgId) throw new Error('Not authenticated')

  const client = await getAuthedClient()
  const slug = slugifyAgent(input.name)

  if (!slug) throw new Error('Agent name must contain at least one letter or digit')

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.agents.createAgent, {
    projectId: input.projectId,
    name: input.name.trim(),
    slug,
    ...(input.description !== undefined && { description: input.description }),
  })

  return mapAgent(doc as Record<string, unknown>)
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
