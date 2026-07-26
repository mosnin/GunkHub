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

import type { ValidatedResolveFields } from '@/lib/services/resolutionFieldValidation'
import type {
  FailurePattern,
  FailurePatternDetail,
  FailurePatternOccurrence,
  FailurePatternSpikeAssessment,
  FailurePatternTrendPoint,
  FixConfidenceLimit,
  FixConfidenceResult,
  FixConfidenceState,
  FixVersionAttribution,
  PatternLifecycleTransition,
  PatternResolutionEvidence,
  PatternResolutionExposure,
  PatternResolutionMetadata,
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
    // Resolution lifecycle (docs/adr/006-failure-resolution.md, cycle 1):
    // acknowledgePattern/resolvePattern/reopenPattern (Team A, member-gated,
    // audited) patch these fields onto the rollup. Same "only emit when
    // actually present" discipline as muted/mutedAt above — an "open"
    // pattern (the default, absent `status`) omits every one of these keys
    // rather than sending explicit `status: undefined`/`0`-ish placeholders.
    // `NonNullable<...>`, not `FailurePattern['status']`: the latter includes
    // `undefined` (the field is optional), which under the tests project's
    // `exactOptionalPropertyTypes` is not assignable to an omitted-or-string
    // property. The guard above already proves this branch has a real string.
    ...(typeof doc['status'] === 'string' && {
      status: doc['status'] as NonNullable<FailurePattern['status']>,
    }),
    ...(typeof doc['acknowledgedAt'] === 'number' && { acknowledgedAt: doc['acknowledgedAt'] }),
    ...(typeof doc['acknowledgedByUserId'] === 'string' && {
      acknowledgedByUserId: doc['acknowledgedByUserId'],
    }),
    ...(typeof doc['resolvedAt'] === 'number' && { resolvedAt: doc['resolvedAt'] }),
    ...(typeof doc['resolvedByUserId'] === 'string' && { resolvedByUserId: doc['resolvedByUserId'] }),
    ...(typeof doc['resolutionNote'] === 'string' && { resolutionNote: doc['resolutionNote'] }),
    ...(typeof doc['resolutionRef'] === 'string' && { resolutionRef: doc['resolutionRef'] }),
    ...(typeof doc['regressedAt'] === 'number' && { regressedAt: doc['regressedAt'] }),
    // Resolution EVIDENCE (docs/adr/006-failure-resolution.md, cycle 2 —
    // "prove the fix held"). `resolvedInVersionId` is the agent version the
    // operator claimed contains the fix; resolvedAtRunCount/
    // resolvedAtOccurrenceCount are the point-in-time snapshots captured at
    // resolution so post-resolution exposure is computable later. Same
    // "only emit when actually present" discipline as every field above —
    // a never-resolved pattern omits all of these rather than sending
    // explicit `undefined`/`0` placeholders, which would make "resolved with
    // a zero baseline" indistinguishable from "never resolved".
    ...(Array.isArray(doc['affectedAgentIds']) && {
      affectedAgentIds: stringArray(doc['affectedAgentIds']),
    }),
    ...(typeof doc['resolvedInVersionId'] === 'string' && {
      resolvedInVersionId: doc['resolvedInVersionId'],
    }),
    ...(typeof doc['resolvedAtRunCount'] === 'number' && {
      resolvedAtRunCount: doc['resolvedAtRunCount'],
    }),
    ...(typeof doc['resolvedAtOccurrenceCount'] === 'number' && {
      resolvedAtOccurrenceCount: doc['resolvedAtOccurrenceCount'],
    }),
  }
}

// ---------------------------------------------------------------------------
// Resolution evidence mappers (cycle 2). Each returns `null` for a missing or
// non-object input rather than a zero-filled placeholder: "no resolution to
// evidence" and "a resolution with all-zero evidence" are completely
// different claims, and only the former may render as absent.
// ---------------------------------------------------------------------------

function mapResolutionMetadata(v: unknown): PatternResolutionMetadata | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  // `resolvedAt` is the one non-optional field; without it there is no
  // point-in-time claim to describe, so this is not a resolution.
  if (typeof r['resolvedAt'] !== 'number') return null
  return {
    resolvedAt: r['resolvedAt'],
    ...(typeof r['resolvedByUserId'] === 'string' && { resolvedByUserId: r['resolvedByUserId'] }),
    ...(typeof r['resolutionNote'] === 'string' && { resolutionNote: r['resolutionNote'] }),
    ...(typeof r['resolutionRef'] === 'string' && { resolutionRef: r['resolutionRef'] }),
    ...(typeof r['resolvedInVersionId'] === 'string' && {
      resolvedInVersionId: r['resolvedInVersionId'],
    }),
    ...(typeof r['resolvedInVersion'] === 'string' && {
      resolvedInVersion: r['resolvedInVersion'],
    }),
    ...(typeof r['resolvedAtOccurrenceCount'] === 'number' && {
      resolvedAtOccurrenceCount: r['resolvedAtOccurrenceCount'],
    }),
    ...(typeof r['resolvedAtRunCount'] === 'number' && {
      resolvedAtRunCount: r['resolvedAtRunCount'],
    }),
  }
}

/**
 * Map post-resolution exposure. Two fields are deliberately mapped
 * PESSIMISTICALLY — when the backend did not say, this layer must not invent
 * the flattering answer:
 *
 * - `heldSoFar` defaults to FALSE when absent/non-boolean. An unverified
 *   pattern must never render as a fix that held.
 * - `runCount` defaults to 0, which (with `heldSoFar` false) reads as
 *   "no exposure measured" — the `unproven` state — never as success.
 *
 * `runCountTruncated: true` means `runCount` is a FLOOR, not an exact total
 * (the backend hit its scan ceiling). It is passed through verbatim so the UI
 * can render "2000+"; this layer never rounds it off or drops it, because
 * silently presenting a floor as exact would overstate the evidence.
 *
 * NOTE `baselineRunCount` is a 14-day TRAILING BASELINE captured before the
 * resolution — the run volume this pattern's agents saw in the window leading
 * up to the fix. It is NOT a cumulative total and must never be subtracted
 * from `runCount`; the two are a "before" and a "since" measurement of two
 * different windows, and are only meaningful side by side.
 */
function mapResolutionExposure(v: unknown): PatternResolutionExposure | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  if (typeof e['since'] !== 'number') return null
  return {
    since: e['since'],
    runCount: typeof e['runCount'] === 'number' ? e['runCount'] : 0,
    runCountTruncated: e['runCountTruncated'] === true,
    recurrenceCount: typeof e['recurrenceCount'] === 'number' ? e['recurrenceCount'] : 0,
    ...(typeof e['baselineRunCount'] === 'number' && {
      baselineRunCount: e['baselineRunCount'],
    }),
    agentIds: stringArray(e['agentIds']),
    heldSoFar: e['heldSoFar'] === true,
  }
}

const FIX_CONFIDENCE_STATES: readonly FixConfidenceState[] = [
  'unproven',
  'proving',
  'confirmed',
  'regressed',
]
const FIX_VERSION_ATTRIBUTIONS: readonly FixVersionAttribution[] = [
  'matched',
  'mismatched',
  'unknown',
]
const FIX_CONFIDENCE_LIMITS: readonly FixConfidenceLimit[] = [
  'recurrence',
  'no-resolution',
  'version-mismatch',
  'no-exposure',
  'accumulating',
  'none',
]

/** Finite-number guard: NaN/Infinity/non-numbers collapse to the fallback rather than reaching the UI. */
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Map Team B's fix-confidence verdict (convex/insights.ts, computed
 * server-side inside `getPatternResolutionEvidence`).
 *
 * THE FULL OBJECT IS MAPPED, not just `score`. The whole design of this
 * result is that a bare number is untrustworthy: an engineer stakes a deploy
 * on "0.42 because 21 runs over 2 days on the matching version, no
 * recurrence", and every one of those drivers is a field here. Dropping them
 * would leave the UI rendering a number nobody can check.
 *
 * This layer VALIDATES; it never re-derives. The score is passed through
 * untouched and deliberately NOT clamped or recomputed — Team B's engine is
 * the single source of truth for the math, and a web-side "correction" would
 * be a second, silently-diverging implementation of it. Only the *types* are
 * enforced here, which is the only validation this boundary gets.
 *
 * Unrecognized enum values fall back PESSIMISTICALLY (`unproven`, `unknown`)
 * rather than to anything that reads as success: a verdict this layer cannot
 * interpret must never render as a confirmed fix.
 *
 * NOTE `recurred` is AUTHORITATIVE for the regression signal — it is the
 * engine's verdict, and it can legitimately disagree with
 * `exposure.recurrenceCount` (Team A's crude count) for a late-arriving
 * occurrence dated before `resolvedAt`. Never derive the regression signal
 * from `recurrenceCount`; that is the count's known failure mode, and the
 * engine exists precisely to adjudicate it.
 */
function mapFixConfidence(v: unknown): FixConfidenceResult | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>

  const state = FIX_CONFIDENCE_STATES.find((s) => s === c['state']) ?? 'unproven'
  const versionAttribution =
    FIX_VERSION_ATTRIBUTIONS.find((a) => a === c['versionAttribution']) ?? 'unknown'
  // Explanatory only — `state`/`score` carry the actual verdict, so an
  // uninterpretable limiting factor degrades to "none" without softening it.
  const limitingFactor = FIX_CONFIDENCE_LIMITS.find((l) => l === c['limitingFactor']) ?? 'none'

  return {
    score: finiteOr(c['score'], 0),
    state,
    exposureRuns: finiteOr(c['exposureRuns'], 0),
    observedRuns: finiteOr(c['observedRuns'], 0),
    versionAttribution,
    elapsedMs: finiteOr(c['elapsedMs'], 0),
    recurred: c['recurred'] === true,
    hasResolution: c['hasResolution'] === true,
    exposureMeasured: c['exposureMeasured'] === true,
    exposureCredit: finiteOr(c['exposureCredit'], 0),
    soakCredit: finiteOr(c['soakCredit'], 0),
    limitingFactor,
  }
}

function mapLifecycleTransition(doc: Record<string, unknown>): PatternLifecycleTransition {
  return {
    action: typeof doc['action'] === 'string' ? doc['action'] : 'unknown',
    // "system" is the documented actor for backend-applied transitions (the
    // regression guard's auto-reopen), so it is also the safest fallback for
    // a row whose actor is missing — never attribute an automatic transition
    // to an arbitrary human.
    actorClerkUserId:
      typeof doc['actorClerkUserId'] === 'string' ? doc['actorClerkUserId'] : 'system',
    timestamp: typeof doc['timestamp'] === 'number' ? doc['timestamp'] : 0,
    ...(doc['metadata'] !== undefined && { metadata: doc['metadata'] }),
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

// ---------------------------------------------------------------------------
// Resolution lifecycle (docs/adr/006-failure-resolution.md, cycle 1) —
// acknowledge / resolve / reopen. Unlike mutePattern/unmutePattern (admin-
// gated org-wide alert suppression), Team A's acknowledgePattern/
// resolvePattern/reopenPattern are MEMBER-gated — this is normal triage, the
// same tier as commenting. This service layer does not duplicate that gate
// (or the audit write): it only resolves the caller's org and surfaces
// whatever Convex returns/throws. A non-member/insufficient-role caller gets
// Convex's `FORBIDDEN: ...` throw, which the route maps via `mapApiError` to
// a clean 403. Same null-on-not-found-in-org tenancy posture as every other
// fingerprint-scoped mutation in this file.
// ---------------------------------------------------------------------------

/** Acknowledge a failure pattern — status -> "acknowledged". See `resolvePattern`'s doc comment for the shared tenancy/error posture. */
export async function acknowledgePattern(fingerprintHash: string): Promise<FailurePattern | null> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await withConvexTimeout(
    client.mutation(convex.failure_patterns.acknowledgePattern, {
      orgId: convexOrgId,
      fingerprintHash,
    }),
  )
  if (!doc || typeof doc !== 'object') return null
  return mapFailurePattern(doc as Record<string, unknown>)
}

/**
 * Resolve a failure pattern — status -> "resolved", stamping an optional
 * bounded `note`/`ref`. Both are opaque plain text as far as this layer (and
 * Convex) are concerned — `ref` is never parsed as a URL or fetched, even
 * when it looks like one; rendering it as a link (if ever) is a UI-layer
 * decision made elsewhere. Server-side length validation
 * (MAX_RESOLUTION_NOTE_LENGTH / MAX_RESOLUTION_REF_LENGTH, both 2048 chars)
 * lives in convex/failure_patterns.ts's `resolvePattern` and throws
 * `afrError("INVALID_ARGUMENT", ...)` on violation, which mapApiError maps to
 * 422 — the route also validates client-side for a fast, clear rejection
 * before ever calling Convex (see fingerprintValidation.ts-style split).
 *
 * CYCLE 2 — `versionId` (optional): the agent version the operator believes
 * contains the fix. Forwarded as a FLAT fourth optional arg and stored by
 * Convex on `resolvedInVersionId`. This layer validates SHAPE ONLY (see
 * resolutionFieldValidation.ts); whether the version exists, is in this org,
 * and belongs to an agent this pattern was observed on is decided solely by
 * Convex's `validateResolutionVersion`.
 *
 * A rejected versionId throws `afrError("INVALID_ARGUMENT", ...)`, which
 * `mapApiError` maps to a real 422 carrying Convex's own actionable message
 * ("versionId must reference an agent version in this organization that
 * belongs to an agent this pattern has been observed on"). That error must
 * NOT be swallowed and must NOT be collapsed into the 404 below: an
 * unknown FINGERPRINT is a 404, an unusable VERSION is a 422, and the two are
 * different failures the operator fixes differently. Note the Convex-side
 * message is deliberately worded to avoid the phrase "not found" so
 * `resolveApiError`'s prose fallback cannot degrade the 422 into a 404 —
 * do not reword it web-side.
 *
 * The version rejection is also uniform by construction: unknown, cross-org,
 * and cross-agent ids all throw the SAME message, and the check runs AFTER
 * the rollup lookup, so a deliberately-bad versionId cannot be used to probe
 * whether a fingerprint exists in this org.
 *
 * Returns `null` for the same reason every fingerprint-scoped mutation above
 * does: "never existed" and "belongs to a different org" must be
 * indistinguishable, collapsing to one generic 404 at the route.
 */
export async function resolvePattern(
  fingerprintHash: string,
  fields: ValidatedResolveFields,
): Promise<FailurePattern | null> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // NOTE — every key declared on `ValidatedResolveFields` must appear in this
  // spread. `versionId` is a FLAT fourth optional arg on Team A's mutation
  // (not nested under an options object), and it lands on the rollup's
  // `resolvedInVersionId` field. This spread crosses the unchecked
  // `makeFunctionReference` string-ref seam, so TypeScript cannot catch a
  // dropped key here — tests/unit/failure_patterns_resolve_args.test.ts is
  // table-driven over `keyof ValidatedResolveFields` precisely so that it can.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await withConvexTimeout(
    client.mutation(convex.failure_patterns.resolvePattern, {
      orgId: convexOrgId,
      fingerprintHash,
      ...(fields.note !== undefined && { note: fields.note }),
      ...(fields.ref !== undefined && { ref: fields.ref }),
      ...(fields.versionId !== undefined && { versionId: fields.versionId }),
    }),
  )
  if (!doc || typeof doc !== 'object') return null
  return mapFailurePattern(doc as Record<string, unknown>)
}

/**
 * Reopen a failure pattern — status -> "open", clearing `regressedAt` (Team
 * A's `reopenPattern` also clears `resolvedAt` but keeps
 * resolvedByUserId/resolutionNote/resolutionRef/acknowledgedAt as history —
 * see that mutation's doc comment). Same tenancy/error posture as
 * `acknowledgePattern`/`resolvePattern` above.
 */
export async function reopenPattern(fingerprintHash: string): Promise<FailurePattern | null> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await withConvexTimeout(
    client.mutation(convex.failure_patterns.reopenPattern, {
      orgId: convexOrgId,
      fingerprintHash,
    }),
  )
  if (!doc || typeof doc !== 'object') return null
  return mapFailurePattern(doc as Record<string, unknown>)
}

/**
 * Fetch the "did the fix actually hold?" evidence for one fingerprint
 * (docs/adr/006-failure-resolution.md cycle 2), scoped to the caller's org.
 *
 * Wraps `failure_patterns:getPatternResolutionEvidence({ orgId,
 * fingerprintHash })`. Everything it returns is a DERIVED projection computed
 * at query time from `runs`, the rollup's own `count`, and the append-only
 * `audit_log` — never stored, never source of truth, exactly like replay/diff
 * over the event log. This layer maps it and nothing else: it computes no
 * counts, derives no state, and re-orders no transitions (they arrive
 * oldest-first, bounded to the 100 most recent, and are passed through in
 * that order).
 *
 * `confidence` is Team B's graded verdict over that evidence, computed
 * server-side against the SERVER clock. The query takes no time argument at
 * all — that is what stops a caller minting a `confirmed` verdict by claiming
 * a future date, and it is why this layer neither sends a timestamp nor
 * recomputes the score.
 *
 * THE STATE COMBINATION THAT MATTERS: `resolution`/`exposure` are null after
 * a MANUAL reopen (which clears `resolvedAt`), but NON-NULL after the
 * regression guard's automatic reopen — which deliberately keeps `resolvedAt`
 * so the "your fix didn't hold" evidence stays computable. A pattern with
 * `status === "open"` AND a non-null `exposure` is therefore valid and is the
 * entire point of this query; nothing in this mapper keys resolution/exposure
 * off `status`, precisely so that combination survives the round-trip intact.
 * `confidence` follows exactly the same rule — non-null after an auto-reopen,
 * carrying `state: "regressed"`, `score: 0`, `limitingFactor: "recurrence"`
 * with real `observedRuns` behind it.
 *
 * Returns `null` for a fingerprint that does not exist IN THIS ORG — the same
 * tenancy collapse every other function in this file uses, so the route can
 * return one generic 404 for "never existed" and "belongs to another org"
 * alike and this query can never become an existence oracle.
 */
export async function getPatternResolutionEvidence(
  fingerprintHash: string,
): Promise<PatternResolutionEvidence | null> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.query(convex.failure_patterns.getPatternResolutionEvidence, {
      orgId: convexOrgId,
      fingerprintHash,
    }),
  )
  if (!result || typeof result !== 'object') return null

  const r = result as Record<string, unknown>
  const patternDoc = r['pattern']
  if (!patternDoc || typeof patternDoc !== 'object') return null

  const transitions = Array.isArray(r['transitions'])
    ? (r['transitions'] as Record<string, unknown>[]).map(mapLifecycleTransition)
    : []

  return {
    pattern: mapFailurePattern(patternDoc as Record<string, unknown>),
    resolution: mapResolutionMetadata(r['resolution']),
    exposure: mapResolutionExposure(r['exposure']),
    confidence: mapFixConfidence(r['confidence']),
    transitions,
  }
}
