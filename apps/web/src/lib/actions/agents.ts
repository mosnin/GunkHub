'use server'

import { auth } from '@clerk/nextjs/server'

import type { Agent } from '@agent-flight-recorder/contracts'

import { createAgent } from '@/lib/services/agents'

/**
 * Server action: create an agent within a project.
 * Requires org membership (enforced by Convex createAgent mutation).
 */
export async function createAgentAction(
  projectId: string,
  name: string,
  description?: string,
): Promise<{ agent: Agent } | { error: string }> {
  const { orgId } = auth()
  if (!orgId) return { error: 'Not authenticated' }

  const trimmed = name.trim()
  if (!trimmed) return { error: 'Agent name is required' }
  if (trimmed.length > 80) return { error: 'Agent name must be 80 characters or fewer' }

  try {
    const agent = await createAgent({ projectId, name: trimmed, description })
    return { agent }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create agent'
    return { error: msg }
  }
}
