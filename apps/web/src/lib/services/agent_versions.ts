import type { AgentVersion } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

function mapAgentVersion(doc: Record<string, unknown>): AgentVersion {
  return {
    id: doc._id as string,
    agentId: doc.agentId as string,
    orgId: doc.orgId as string,
    version: doc.version as string,
    createdAt: doc.createdAt as number,
    ...(doc.changelog !== undefined && { changelog: doc.changelog as string }),
    ...(doc.configSnapshot !== undefined && {
      configSnapshot: doc.configSnapshot as Record<string, unknown>,
    }),
  }
}

/**
 * List all versions for the given agent, newest first.
 */
export async function listAgentVersions(agentId: string): Promise<AgentVersion[]> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const docs = await client.query(convex.agent_versions.listAgentVersions, { agentId })

  return ((docs as Record<string, unknown>[]) ?? []).map(mapAgentVersion)
}

/**
 * Get a single agent version by its Convex document ID.
 */
export async function getAgentVersion(versionId: string): Promise<AgentVersion | null> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.query(convex.agent_versions.getAgentVersion, { versionId })

  if (!doc) return null
  return mapAgentVersion(doc as Record<string, unknown>)
}

/**
 * Create a new agent version. Requires admin role in Convex.
 */
export async function createAgentVersion(input: {
  agentId: string
  version: string
  changelog?: string
  configSnapshot?: Record<string, unknown>
}): Promise<AgentVersion> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.agent_versions.createAgentVersion, {
    agentId: input.agentId,
    version: input.version.trim(),
    ...(input.changelog !== undefined && { changelog: input.changelog }),
    ...(input.configSnapshot !== undefined && { configSnapshot: input.configSnapshot }),
  })

  return mapAgentVersion(doc as Record<string, unknown>)
}
