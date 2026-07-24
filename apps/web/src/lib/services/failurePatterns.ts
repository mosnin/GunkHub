/**
 * services/failurePatterns.ts — Clerk-authed service layer backing
 * /api/patterns/**, wrapping convex/failure_patterns.ts (data agent — Team A,
 * "Failure Patterns" / PREVENTION feature, cycle 1).
 *
 * Mirrors services/alerts.ts: resolves the Clerk org to a Convex orgId, then
 * calls the org-scoped, member-gated Convex queries
 * `failure_patterns:listFailurePatterns` / `failure_patterns:getFailurePattern`.
 * Convex itself enforces org-scoping and membership — this layer does not
 * duplicate that logic, it only surfaces whatever Convex returns/throws and
 * maps the raw Convex documents onto the shared `@agent-flight-recorder/
 * contracts` entity types.
 *
 * The Convex documents are already shaped like the contracts entities
 * (packages/contracts/src/failure_patterns.ts) — the only translation is
 * `_id` -> `id` and dropping Convex's `_creationTime`. `getFailurePattern`
 * returns `{ pattern, recentOccurrences, trend }` with `trend` already keyed
 * by a `"YYYY-MM-DD"` day string, matching `FailurePatternTrendPoint`.
 */
import { auth } from '@clerk/nextjs/server'

import type {
  FailurePattern,
  FailurePatternDetail,
  FailurePatternOccurrence,
  FailurePatternSpikeAssessment,
  FailurePatternTrendPoint,
} from '@agent-flight-recorder/contracts'


import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId, withConvexTimeout } from '@/lib/convexServer'

// ---------------------------------------------------------------------------
// Mapping helpers — tolerant of unknown/partial Convex doc shapes, same
// "coarse null" caution as services/explanations.ts: this module never
// invents required fields, it maps what's there and lets obviously-wrong
// shapes surface as thrown errors from the route rather than silently
// rendering empty/garbage data.
// ---------------------------------------------------------------------------

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function mapSpikeAssessment(v: unknown): FailurePatternSpikeAssessment | undefined {
  if (!v || typeof v !== 'object') return undefined
  const s = v as Record<string, unknown>
  return {
    assessedAt: typeof s['assessedAt'] === 'number' ? s['assessedAt'] : 0,
    isSpiking: s['isSpiking'] === true,
    recentCount: typeof s['recentCount'] === 'number' ? s['recentCount'] : 0,
    baselineMean: typeof s['baselineMean'] === 'number' ? s['baselineMean'] : 0,
    z: typeof s['z'] === 'number' ? s['z'] : 0,
  }
}

function mapFailurePattern(doc: Record<string, unknown>): FailurePattern {
  const spike = mapSpikeAssessment(doc['lastSpikeAssessment'])
  return {
    id: (doc['_id'] ?? doc['id']) as string,
    orgId: doc['orgId'] as string,
    fingerprintHash: doc['fingerprintHash'] as string,
    class: typeof doc['class'] === 'string' ? doc['class'] : 'unknown',
    label: typeof doc['label'] === 'string' ? doc['label'] : 'Unlabeled failure pattern',
    salientKey: typeof doc['salientKey'] === 'string' ? doc['salientKey'] : '',
    count: typeof doc['count'] === 'number' ? doc['count'] : 0,
    firstSeenAt: typeof doc['firstSeenAt'] === 'number' ? doc['firstSeenAt'] : 0,
    lastSeenAt: typeof doc['lastSeenAt'] === 'number' ? doc['lastSeenAt'] : 0,
    representativeRunIds: stringArray(doc['representativeRunIds']),
    affectedAgentVersionIds: stringArray(doc['affectedAgentVersionIds']),
    ...(spike !== undefined && { lastSpikeAssessment: spike }),
    // Mute state (cycle 3): the admin-gated mutePattern/unmutePattern
    // mutations (convex/failure_patterns.ts) patch `muted`/`mutedAt` onto the
    // rollup doc; the contract declares both as optional (0.7.9). Surface them
    // so list/detail responses (and the mute route's own echo) carry the muted
    // state the UI/CLI render. Only emit `muted` when actually true — an
    // unmuted pattern omits the key rather than sending `muted: false`.
    ...(doc['muted'] === true && { muted: true }),
    ...(typeof doc['mutedAt'] === 'number' && { mutedAt: doc['mutedAt'] }),
    ...(typeof doc['lastPatternSpikeAlertFiredAt'] === 'number' && {
      lastPatternSpikeAlertFiredAt: doc['lastPatternSpikeAlertFiredAt'],
    }),
  }
}

function mapOccurrence(doc: Record<string, unknown>): FailurePatternOccurrence {
  return {
    id: (doc['_id'] ?? doc['id']) as string,
    orgId: doc['orgId'] as string,
    fingerprintHash: doc['fingerprintHash'] as string,
    runId: doc['runId'] as string,
    agentId: typeof doc['agentId'] === 'string' ? doc['agentId'] : '',
    ...(typeof doc['agentVersionId'] === 'string' && { agentVersionId: doc['agentVersionId'] }),
    occurredAt: typeof doc['occurredAt'] === 'number' ? doc['occurredAt'] : 0,
    heuristicClass: typeof doc['heuristicClass'] === 'string' ? doc['heuristicClass'] : 'unknown',
    salientKey: typeof doc['salientKey'] === 'string' ? doc['salientKey'] : '',
  }
}

function mapTrendPoint(doc: Record<string, unknown>): FailurePatternTrendPoint {
  return {
    day: typeof doc['day'] === 'string' ? doc['day'] : '',
    count: typeof doc['count'] === 'number' ? doc['count'] : 0,
  }
}

async function requireOrgContext(): Promise<{ clerkOrgId: string; convexOrgId: string }> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Unauthorized: no organization context')
  const convexOrgId = await resolveConvexOrgId(clerkOrgId)
  return { clerkOrgId, convexOrgId }
}

/**
 * List the caller's org's recurring failure-fingerprint rollups, most
 * recently seen first (ordering is convex/failure_patterns.ts's contract —
 * this does not re-sort). `limit` is passed through as-is; the Convex query
 * applies its own defensive cap independent of what's passed.
 */
export async function listFailurePatterns(limit?: number): Promise<FailurePattern[]> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const rows = await withConvexTimeout(
    client.query(convex.failure_patterns.listFailurePatterns, {
      orgId: convexOrgId,
      ...(limit !== undefined && { limit }),
    }),
  )
  return (rows as Record<string, unknown>[]).map(mapFailurePattern)
}

/**
 * Fetch one failure pattern's detail (rollup + recent occurrences + trend)
 * by its fingerprint hash, scoped to the caller's org.
 *
 * Returns `null` when the fingerprint does not exist IN THIS ORG — this is
 * the load-bearing tenancy behavior the route relies on for cross-org
 * isolation: `getFailurePattern(orgId, fingerprintHash)` filters by `orgId`
 * server-side and returns nothing for a fingerprint that belongs to a
 * different org, rather than throwing a distinguishable "wrong org" error
 * that could leak existence. The route maps `null` to a generic 404,
 * identical to "never existed".
 */
export async function getFailurePatternDetail(
  fingerprintHash: string,
): Promise<FailurePatternDetail | null> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.query(convex.failure_patterns.getFailurePattern, {
      orgId: convexOrgId,
      fingerprintHash,
    }),
  )
  if (!result || typeof result !== 'object') return null

  const r = result as Record<string, unknown>
  const patternDoc = r['pattern']
  if (!patternDoc || typeof patternDoc !== 'object') return null

  const recentOccurrences = Array.isArray(r['recentOccurrences'])
    ? (r['recentOccurrences'] as Record<string, unknown>[]).map(mapOccurrence)
    : []
  const trend = Array.isArray(r['trend'])
    ? (r['trend'] as Record<string, unknown>[]).map(mapTrendPoint)
    : []

  return {
    pattern: mapFailurePattern(patternDoc as Record<string, unknown>),
    recentOccurrences,
    trend,
  }
}

/**
 * Mute a failure pattern by fingerprint hash, scoped to the caller's org
 * (cycle 3 — replaces the mute route/service removed in cycle 2 because the
 * Convex mutation didn't exist yet; "a throwing stub is worse than nothing").
 *
 * Calls `convex/failure_patterns.ts`'s `mutePattern({ orgId, fingerprintHash })`
 * — an org-scoped, ADMIN-GATED, AUDITED mutation (Team A). This service layer
 * does not duplicate the admin check or the audit-log write: it only resolves
 * the caller's org and surfaces whatever Convex returns/throws, exactly like
 * `getFailurePatternDetail` above and `updateAlertRule`/`deleteAlertRule` in
 * services/alerts.ts. A non-admin caller gets Convex's `FORBIDDEN: ...` throw,
 * which the route maps via `mapApiError` to a clean 403 (never a 500).
 *
 * Returns `null` for the same reason `getFailurePatternDetail` does: a
 * fingerprint that does not exist IN THIS ORG must be indistinguishable from
 * one that belongs to a different org, so the route can return an identical
 * generic 404 in both cases and never leak cross-org existence.
 */
export async function mutePattern(fingerprintHash: string): Promise<FailurePattern | null> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await withConvexTimeout(
    client.mutation(convex.failure_patterns.mutePattern, {
      orgId: convexOrgId,
      fingerprintHash,
    }),
  )
  if (!doc || typeof doc !== 'object') return null
  return mapFailurePattern(doc as Record<string, unknown>)
}

/** Unmute — same contract/tenancy posture as `mutePattern` above, see its doc comment. */
export async function unmutePattern(fingerprintHash: string): Promise<FailurePattern | null> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await withConvexTimeout(
    client.mutation(convex.failure_patterns.unmutePattern, {
      orgId: convexOrgId,
      fingerprintHash,
    }),
  )
  if (!doc || typeof doc !== 'object') return null
  return mapFailurePattern(doc as Record<string, unknown>)
}
