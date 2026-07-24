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
import { unavailableError, unavailableNoOrg } from '@/lib/services/serviceResult'

/** Static noun phrase for user-facing failure copy — never derived from an
    exception (see serviceResult.ts, "messages are safe by construction"). */
const COMPARE_SUBJECT = 'the version comparison'

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
  // Was `{ available: false }` — which rendered as "not enough runs recorded"
  // when the real cause was "you have no active organization". Both non-ok
  // exits now carry a status and an explanation.
  if (!clerkOrgId) return unavailableNoOrg(COMPARE_SUBJECT)
  try {
    const convexOrgId = await resolveConvexOrgId(clerkOrgId)
    const result = await compareVersions(convexOrgId, versionAId, versionBId)
    // Pass 'empty' and 'error' straight through — this action must not
    // relabel one as the other. The narrative spread below is guarded on 'ok'
    // because `narrative` does not exist on the unavailable branch.
    if (result.status !== 'ok') return result
    const narrative = await getVersionCompareNarrative(convexOrgId, versionAId, versionBId)
    return { ...result, narrative }
  } catch (err) {
    return unavailableError(COMPARE_SUBJECT, err, { action: 'compareVersionsAction' })
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
