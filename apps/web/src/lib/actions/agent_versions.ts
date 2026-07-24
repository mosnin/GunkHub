'use server'

import { auth } from '@clerk/nextjs/server'

import type { AgentVersion } from '@agent-flight-recorder/contracts'

import { resolveConvexOrgId } from '@/lib/convexServer'
import {
  compareVersions,
  createAgentVersion,
  getVersionCompareNarrative,
  type VersionCompareResult,
} from '@/lib/services/agent_versions'

/** Server action backing VersionCompare.tsx's picker — resolves the caller's
    Convex orgId then delegates to services/agent_versions.ts `compareVersions`.
    Also fetches the "what changed" narrative (Team C's `versionNarrative.ts`
    pipeline) alongside the cohort numbers — additive and non-fatal, a
    missing or failed narrative fetch never blocks the cohort comparison
    itself. */
export async function compareVersionsAction(
  versionAId: string,
  versionBId: string,
): Promise<VersionCompareResult> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return { available: false }
  try {
    const convexOrgId = await resolveConvexOrgId(clerkOrgId)
    const result = await compareVersions(convexOrgId, versionAId, versionBId)
    if (!result.available) return result
    const narrative = await getVersionCompareNarrative(convexOrgId, versionAId, versionBId)
    return { ...result, narrative }
  } catch {
    return { available: false }
  }
}

export async function createAgentVersionAction(
  agentId: string,
  version: string,
  changelog?: string,
  configSnapshot?: Record<string, unknown>,
  evalRules?: Record<string, unknown>[],
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
      ...(evalRules !== undefined ? { evalRules } : {}),
    })
    return { agentVersion }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create agent version'
    return { error: msg }
  }
}
