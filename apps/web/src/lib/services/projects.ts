import { auth } from '@clerk/nextjs/server'

import type { Project } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId } from '@/lib/convexServer'

function mapProject(doc: Record<string, unknown>): Project {
  return {
    id: doc._id as string,
    orgId: doc.orgId as string,
    name: doc.name as string,
    slug: doc.slug as string,
    createdAt: doc.createdAt as number,
    updatedAt: doc.updatedAt as number,
    ...(doc.description !== undefined && { description: doc.description as string }),
  }
}

/**
 * List all projects for the authenticated org.
 */
export async function listProjects(): Promise<Project[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const client = await getAuthedClient()
  const convexOrgId = await resolveConvexOrgId(clerkOrgId)

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const docs = await client.query(convex.projects.listProjects, { orgId: convexOrgId })

  return ((docs as Record<string, unknown>[]) ?? []).map(mapProject)
}

/**
 * Get a single project by its Convex document ID.
 */
export async function getProject(projectId: string): Promise<Project> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.query(convex.projects.getProject, { projectId })

  return mapProject(doc as Record<string, unknown>)
}

/** Derive a URL-safe slug from a name. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Create a new project in the authenticated org. Requires admin role.
 */
export async function createProject(input: {
  name: string
  description?: string
}): Promise<Project> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const client = await getAuthedClient()
  const convexOrgId = await resolveConvexOrgId(clerkOrgId)
  const slug = slugify(input.name)

  if (!slug) throw new Error('Project name must contain at least one letter or digit')

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.projects.createProject, {
    orgId: convexOrgId,
    name: input.name.trim(),
    slug,
    ...(input.description !== undefined && { description: input.description }),
  })

  return mapProject(doc as Record<string, unknown>)
}
