'use server'

import type { AgentVersion } from '@agent-flight-recorder/contracts'

import { createAgentVersion } from '@/lib/services/agent_versions'

export async function createAgentVersionAction(
  agentId: string,
  version: string,
  changelog?: string,
  configSnapshot?: Record<string, unknown>,
): Promise<{ agentVersion: AgentVersion } | { error: string }> {
  if (!agentId) return { error: 'Agent ID is required' }
  const trimmed = (version ?? '').trim()
  if (!trimmed) return { error: 'Version is required' }
  if (trimmed.length > 64) return { error: 'Version must be 64 characters or fewer' }
  try {
    const agentVersion = await createAgentVersion({
      agentId,
      version: trimmed,
      ...(changelog !== undefined && changelog.trim() ? { changelog: changelog.trim() } : {}),
      ...(configSnapshot !== undefined ? { configSnapshot } : {}),
    })
    return { agentVersion }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create agent version'
    return { error: msg }
  }
}
