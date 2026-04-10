'use server'

import { auth } from '@clerk/nextjs/server'

import type { Project } from '@agent-flight-recorder/contracts'

import { createProject } from '@/lib/services/projects'

/**
 * Server action: create a project in the authenticated org.
 * Requires admin role (enforced by Convex createProject mutation).
 */
export async function createProjectAction(
  name: string,
  description?: string,
): Promise<{ project: Project } | { error: string }> {
  const { orgId } = auth()
  if (!orgId) return { error: 'Not authenticated' }

  const trimmed = name.trim()
  if (!trimmed) return { error: 'Project name is required' }
  if (trimmed.length > 80) return { error: 'Project name must be 80 characters or fewer' }

  try {
    const project = await createProject({ name: trimmed, description })
    return { project }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create project'
    return { error: msg }
  }
}
