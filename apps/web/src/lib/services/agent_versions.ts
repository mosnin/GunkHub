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
 * Fetch a page of agent versions, newest first.
 * Returns versions array and cursor for next page (null if done).
 */
export async function listAgentVersionsPaginated(
  agentId: string,
  cursor: string | null = null,
  numItems = 20,
): Promise<{ versions: AgentVersion[]; nextCursor: string | null }> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.agent_versions.paginateAgentVersions, {
    agentId,
    numItems,
    cursor,
  })

  const raw = result as { versions: Record<string, unknown>[]; nextCursor: string | null }
  return {
    versions: (raw.versions ?? []).map(mapAgentVersion),
    nextCursor: raw.nextCursor,
  }
}

/**
 * Create a new agent version. Requires admin role in Convex.
 */
export async function createAgentVersion(input: {
  agentId: string
  version: string
  changelog?: string
  configSnapshot?: Record<string, unknown>
  /** Optional eval-auto-run rules (see convex/helpers/evals.ts `EvalRule`),
      authored via the JSON editor in CreateVersionModal.tsx. Validated
      client-side (lib/evalRulesValidation.ts) before reaching here; Convex
      re-validates on write against the same shape. */
  evalRules?: Record<string, unknown>[]
}): Promise<AgentVersion> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.agent_versions.createAgentVersion, {
    agentId: input.agentId,
    version: input.version.trim(),
    ...(input.changelog !== undefined && { changelog: input.changelog }),
    ...(input.configSnapshot !== undefined && { configSnapshot: input.configSnapshot }),
    ...(input.evalRules !== undefined && input.evalRules.length > 0 && { evalRules: input.evalRules }),
  })

  return mapAgentVersion(doc as Record<string, unknown>)
}

/**
 * A version's configured eval-auto-run rule set (schema.ts `agent_versions.evalRules`,
 * validated at write time by convex/helpers/agent_version_fields.ts against the
 * `EvalRule` discriminated union in convex/helpers/evals.ts). Not part of the
 * shared `AgentVersion` contract type — read here as a loosely-typed array of
 * records for read-only display (this cycle's requirement); each rule's
 * `kind` field plus its remaining fields are rendered generically rather than
 * importing the convex-internal union type into apps/web.
 */
export async function getAgentVersionEvalRules(versionId: string): Promise<Record<string, unknown>[]> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.query(convex.agent_versions.getAgentVersion, { versionId })
  if (!doc) return []
  const rules = (doc as Record<string, unknown>).evalRules
  return Array.isArray(rules) ? (rules as Record<string, unknown>[]) : []
}

// ---------------------------------------------------------------------------
// Version comparison (cohort A/B) — Team B's convex/insights.ts `compareVersions`.
// ---------------------------------------------------------------------------
//
// Real request:  { orgId, agentVersionIdA, agentVersionIdB }
// Real response: {
//   agentId,
//   versionA: { id, version, sampleSize, scanned, truncated, countsByStatus },
//   versionB: { id, version, sampleSize, scanned, truncated, countsByStatus },
//   comparison: CohortComparison,  // includes the significance verdict
// }
//
// `comparison.verdict` is one of likely_regression / likely_improvement /
// inconclusive / insufficient_data. `truncated: true` on either cohort means
// the underlying scan was capped — surfaced in the UI as "sampled" rather
// than a full-population comparison.

export interface VersionCohortStats {
  id: string
  version: string
  sampleSize: number
  scanned: number
  truncated: boolean
  countsByStatus: Record<string, number>
}

export type VersionCompareVerdict =
  | 'likely_regression'
  | 'likely_improvement'
  | 'inconclusive'
  | 'insufficient_data'

export interface CohortComparison {
  verdict: VersionCompareVerdict
  /** Remaining fields (failure-rate deltas, statistical detail, etc.) — shape
      is owned by insights.ts and rendered generically where not explicitly typed. */
  [key: string]: unknown
}

export interface VersionCompareResultAvailable {
  available: true
  agentId: string
  versionA: VersionCohortStats
  versionB: VersionCohortStats
  comparison: CohortComparison
}

export interface VersionCompareResultUnavailable {
  available: false
}

export type VersionCompareResult = VersionCompareResultAvailable | VersionCompareResultUnavailable

export async function compareVersions(
  orgId: string,
  agentVersionIdA: string,
  agentVersionIdB: string,
): Promise<VersionCompareResult> {
  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.insights.compareVersions, {
      orgId,
      agentVersionIdA,
      agentVersionIdB,
    })
    if (!result) return { available: false }
    const r = result as Omit<VersionCompareResultAvailable, 'available'>
    return { available: true, ...r }
  } catch {
    return { available: false }
  }
}
