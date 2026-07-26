/**
 * Reconciliation adapter — Failure Patterns UI (Team E).
 *
 * TODO(reconcile-with-team-c): `@/lib/services/failurePatterns` (Team C's
 * file, not ours) currently exports a LOCAL `FailurePattern`/
 * `FailurePatternDetail` shape (`title`/`failureClass`/`occurrenceCount`,
 * no `salientKey`/`representativeRunIds`/`affectedAgentVersionIds`/
 * `lastSpikeAssessment`, trend buckets keyed by `bucketStart` epoch-ms
 * instead of a `day` string) that predates and does not match the REAL
 * `FailurePattern` / `FailurePatternDetail` / `FailurePatternTrendPoint`
 * types Team A landed in `@agent-flight-recorder/contracts` (see
 * packages/contracts/src/failure_patterns.ts, backed by
 * convex/schema.ts's `failure_patterns` / `failure_pattern_occurrences`
 * tables). Per CLAUDE.md, component props that accept entity data must use
 * the contracts types, not a local re-definition — so this file adapts
 * WHATEVER the service currently returns into the real contract shape,
 * tolerating either the current stub shape or the real one once Team C's
 * service is reconciled to match Team A's contracts. Nothing downstream of
 * this adapter should ever see Team C's stub field names.
 *
 * The orchestrator should delete this adapter once
 * services/failurePatterns.ts itself returns real `FailurePattern` /
 * `FailurePatternDetail` objects — at that point this file becomes a no-op
 * pass-through and isn't needed.
 */
import type {
  FailurePattern,
  FailurePatternDetail,
  FailurePatternOccurrence,
  FailurePatternStatus,
  FailurePatternTrendPoint,
  PatternLifecycleTransition,
  PatternResolutionExposure,
  PatternResolutionMetadata,
} from '@agent-flight-recorder/contracts'

/**
 * A `FailurePattern` plus flags recording which fields this adapter had to
 * default because the current service doesn't supply them yet. The UI uses
 * these to render an honest "not available" placeholder instead of a
 * dishonest zero/empty count for data the backend simply hasn't wired up.
 */
export interface AdaptedFailurePattern extends FailurePattern {
  /** True when `representativeRunIds` came from the service, not a default. */
  hasRepresentativeRuns: boolean
  /** True when `affectedAgentVersionIds` came from the service, not a default. */
  hasAffectedVersions: boolean
  /** True when `lastSpikeAssessment` came from the service, not a default (a missing assessment must never render as "not spiking" with false confidence — it renders as "spike status unknown" instead). */
  hasSpikeAssessment: boolean
  /**
   * True when an admin has muted alerts for this pattern (cycle 3 mute
   * control — POST/DELETE `/api/patterns/[fingerprint]/mute`, Team C; the
   * `muted`/`mutedAt` fields on the contract itself, Team A). Declared here
   * on the ADAPTED type rather than relying on the base `FailurePattern`
   * contract already having landed them, so this UI doesn't hard-depend on
   * contract/service timing this cycle — defaults to `false` (never muted)
   * when the field isn't present on the raw object yet, which is the honest
   * "alerts are not known to be muted" reading, not a fabricated state.
   */
  muted: boolean
  /** Epoch ms the pattern was muted, when known. Undefined if never muted or the service doesn't supply it yet. */
  mutedAt?: number

  /**
   * Resolution lifecycle (cycle 1 of the Resolution feature — see
   * docs/adr/006-failure-resolution.md, Team A's `status`/`resolvedAt`/etc.
   * fields on the `FailurePattern` contract). Absent on the raw object means
   * "open" — the honest default for every pre-lifecycle row, matching the
   * contract's own "absent means open" convention, not a fabricated value.
   */
  status: FailurePatternStatus
  acknowledgedAt?: number
  acknowledgedByUserId?: string
  resolvedAt?: number
  resolvedByUserId?: string
  resolutionNote?: string
  resolutionRef?: string
  /**
   * Set the moment a RESOLVED pattern receives a new occurrence dated after
   * `resolvedAt` — "your fix didn't hold." A pattern is considered
   * REGRESSED for display purposes when `status` is `open` (the regression
   * guard reopens it) AND `regressedAt` is set; see `isRegressed` below.
   */
  regressedAt?: number

  /**
   * Resolution EVIDENCE snapshot (cycle 2 — "prove the fix held"). These three
   * ride on the rollup itself so the LIST can distinguish an asserted
   * resolution from a proven one without a second query.
   *
   * `resolvedAtRunCount` is a 14-day trailing BASELINE — runs BEFORE
   * resolution. It is NOT a cumulative total, so it must never be subtracted
   * from post-resolution exposure; the two are labelled "before" and "since"
   * wherever they are rendered together.
   */
  resolvedInVersionId?: string
  resolvedAtRunCount?: number
  resolvedAtOccurrenceCount?: number
  /** Agents this fingerprint has been observed on (bounded). Exposure is measured across these. */
  affectedAgentIds: string[]
  /** True when `affectedAgentIds` came from the service, not a default. */
  hasAffectedAgents: boolean
}

/**
 * EXACT recurrences since the resolution, derived the one way the backend
 * defines it: `count - resolvedAtOccurrenceCount`. Returns `null` when no
 * baseline was captured (pre-cycle-2 resolution, or never resolved) — the
 * honest "we cannot say" rather than a fabricated zero, which would read as
 * "it held" for a pattern we simply have no baseline for.
 */
export function recurrencesSinceResolution(
  pattern: Pick<AdaptedFailurePattern, 'count' | 'resolvedAtOccurrenceCount'>,
): number | null {
  if (typeof pattern.resolvedAtOccurrenceCount !== 'number') return null
  return Math.max(0, pattern.count - pattern.resolvedAtOccurrenceCount)
}

/** True when a pattern is a REGRESSED one — reopened by the automatic regression guard after having been resolved, as opposed to a plain manual reopen (which clears `regressedAt`, per the contract's own doc comment). */
export function isRegressedPattern(pattern: Pick<AdaptedFailurePattern, 'status' | 'regressedAt'>): boolean {
  return pattern.status === 'open' && typeof pattern.regressedAt === 'number'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Adapts one raw pattern object (either the real contract shape or Team C's current stub shape) into `AdaptedFailurePattern`. */
export function adaptFailurePattern(raw: unknown): AdaptedFailurePattern {
  const r = isRecord(raw) ? raw : {}

  // Real contract fields take priority; fall back to the stub's field names.
  const label = str(r['label']) || str(r['title']) || 'Unlabeled failure pattern'
  const cls = str(r['class']) || str(r['failureClass']) || 'unknown'
  const count = typeof r['count'] === 'number' ? num(r['count']) : num(r['occurrenceCount'])
  const salientKey = str(r['salientKey'])

  const representativeRunIds = Array.isArray(r['representativeRunIds'])
    ? (r['representativeRunIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const affectedAgentVersionIds = Array.isArray(r['affectedAgentVersionIds'])
    ? (r['affectedAgentVersionIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : []

  const rawSpike = r['lastSpikeAssessment']
  const lastSpikeAssessment = isRecord(rawSpike)
    ? {
        assessedAt: num(rawSpike['assessedAt']),
        isSpiking: rawSpike['isSpiking'] === true,
        recentCount: num(rawSpike['recentCount']),
        baselineMean: num(rawSpike['baselineMean']),
        z: num(rawSpike['z']),
      }
    : undefined

  const muted = r['muted'] === true
  const mutedAtRaw = r['mutedAt']
  const mutedAt = typeof mutedAtRaw === 'number' && Number.isFinite(mutedAtRaw) ? mutedAtRaw : undefined

  const rawStatus = r['status']
  const status: FailurePatternStatus =
    rawStatus === 'acknowledged' || rawStatus === 'resolved' || rawStatus === 'open' ? rawStatus : 'open'
  const acknowledgedAt = typeof r['acknowledgedAt'] === 'number' ? r['acknowledgedAt'] : undefined
  const acknowledgedByUserId = typeof r['acknowledgedByUserId'] === 'string' ? r['acknowledgedByUserId'] : undefined
  const resolvedAt = typeof r['resolvedAt'] === 'number' ? r['resolvedAt'] : undefined
  const resolvedByUserId = typeof r['resolvedByUserId'] === 'string' ? r['resolvedByUserId'] : undefined
  const resolutionNote = typeof r['resolutionNote'] === 'string' ? r['resolutionNote'] : undefined
  const resolutionRef = typeof r['resolutionRef'] === 'string' ? r['resolutionRef'] : undefined
  const regressedAt = typeof r['regressedAt'] === 'number' ? r['regressedAt'] : undefined

  const resolvedInVersionId = typeof r['resolvedInVersionId'] === 'string' ? r['resolvedInVersionId'] : undefined
  const resolvedAtRunCount = typeof r['resolvedAtRunCount'] === 'number' ? r['resolvedAtRunCount'] : undefined
  const resolvedAtOccurrenceCount =
    typeof r['resolvedAtOccurrenceCount'] === 'number' ? r['resolvedAtOccurrenceCount'] : undefined
  const affectedAgentIds = Array.isArray(r['affectedAgentIds'])
    ? (r['affectedAgentIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : []

  return {
    id: str(r['id']),
    orgId: str(r['orgId']),
    fingerprintHash: str(r['fingerprintHash']),
    class: cls,
    label,
    salientKey,
    count,
    firstSeenAt: num(r['firstSeenAt']),
    lastSeenAt: num(r['lastSeenAt']),
    representativeRunIds,
    affectedAgentVersionIds,
    ...(lastSpikeAssessment !== undefined && { lastSpikeAssessment }),
    hasRepresentativeRuns: Array.isArray(r['representativeRunIds']),
    hasAffectedVersions: Array.isArray(r['affectedAgentVersionIds']),
    hasSpikeAssessment: lastSpikeAssessment !== undefined,
    muted,
    ...(mutedAt !== undefined && { mutedAt }),
    status,
    ...(acknowledgedAt !== undefined && { acknowledgedAt }),
    ...(acknowledgedByUserId !== undefined && { acknowledgedByUserId }),
    ...(resolvedAt !== undefined && { resolvedAt }),
    ...(resolvedByUserId !== undefined && { resolvedByUserId }),
    ...(resolutionNote !== undefined && { resolutionNote }),
    ...(resolutionRef !== undefined && { resolutionRef }),
    ...(regressedAt !== undefined && { regressedAt }),
    ...(resolvedInVersionId !== undefined && { resolvedInVersionId }),
    ...(resolvedAtRunCount !== undefined && { resolvedAtRunCount }),
    ...(resolvedAtOccurrenceCount !== undefined && { resolvedAtOccurrenceCount }),
    affectedAgentIds,
    hasAffectedAgents: Array.isArray(r['affectedAgentIds']),
  }
}

/** Adapts one raw trend point (`{ day }` real shape, or `{ bucketStart }` stub shape) into the real `FailurePatternTrendPoint`. */
export function adaptTrendPoint(raw: unknown): FailurePatternTrendPoint {
  const r = isRecord(raw) ? raw : {}
  if (typeof r['day'] === 'string') {
    return { day: r['day'], count: num(r['count']) }
  }
  const bucketStart = num(r['bucketStart'])
  const day = bucketStart > 0 ? new Date(bucketStart).toISOString().slice(0, 10) : ''
  return { day, count: num(r['count']) }
}

/** Adapts one raw occurrence into the real `FailurePatternOccurrence`. Fields the current stub omits (`agentId`, `heuristicClass`, `salientKey`) default to empty strings — honest gaps, not invented data. */
export function adaptOccurrence(raw: unknown): FailurePatternOccurrence {
  const r = isRecord(raw) ? raw : {}
  return {
    id: str(r['id']) || str(r['runId']),
    orgId: str(r['orgId']),
    fingerprintHash: str(r['fingerprintHash']),
    runId: str(r['runId']),
    agentId: str(r['agentId']),
    ...(typeof r['agentVersionId'] === 'string' && { agentVersionId: r['agentVersionId'] }),
    occurredAt: num(r['occurredAt']),
    heuristicClass: str(r['heuristicClass']),
    salientKey: str(r['salientKey']),
  }
}

export interface AdaptedFailurePatternDetail {
  pattern: AdaptedFailurePattern
  recentOccurrences: FailurePatternOccurrence[]
  trend: FailurePatternTrendPoint[]
}

// ---------------------------------------------------------------------------
// Fix confidence (cycle 2) — "did the fix hold?"
//
// Team B's `fixConfidence()` and its result type live in `convex/insights.ts`,
// which this layer must NOT import: per CLAUDE.md components use the service
// seam, never Convex directly. The types below are therefore a UI-side MIRROR
// of `FixConfidenceResult` — deliberately structural, adapted defensively from
// `unknown`, so a shape change on Team B's side degrades to "not scored"
// rather than a crash or, worse, a confident-looking render of garbage.
//
// The MATH is never reimplemented here. This layer only ever ADAPTS a score
// that Team B computed; if the service does not supply one, the UI says so.
// ---------------------------------------------------------------------------

export type FixConfidenceState = 'unproven' | 'proving' | 'confirmed' | 'regressed'
export type FixVersionAttribution = 'matched' | 'mismatched' | 'unknown'
export type FixConfidenceLimit =
  | 'recurrence'
  | 'no-resolution'
  | 'version-mismatch'
  | 'no-exposure'
  | 'accumulating'
  | 'none'

/**
 * The confidence ceiling, mirrored from Team B's `FIX_CONFIDENCE_MAX`. It is
 * 0.95 and never 1.0 — no finite observation window proves the absence of a
 * rare failure — and the UI renders the score AGAINST this ceiling ("0.62 /
 * 0.95") rather than as a percentage, precisely so nothing ever reads as
 * "100% certain".
 */
export const FIX_CONFIDENCE_MAX = 0.95

/** UI-side mirror of Team B's `FixConfidenceResult`. Score is 0..0.95 (NOT 0-100 — `healthScore`/`provenHealthScore` are the 0-100 fields, a different unit). */
export interface AdaptedFixConfidence {
  score: number
  state: FixConfidenceState
  /** Runs that actually count as exposure — zeroed on version mismatch. */
  exposureRuns: number
  /** Raw post-resolution runs BEFORE version attribution was applied. */
  observedRuns: number
  versionAttribution: FixVersionAttribution
  elapsedMs: number
  recurred: boolean
  hasResolution: boolean
  exposureMeasured: boolean
  /** 0..1, intended for direct rendering as a bar fill. */
  exposureCredit: number
  /** 0..1, intended for direct rendering as a bar fill. */
  soakCredit: number
  limitingFactor: FixConfidenceLimit
}

function clamp01(v: unknown): number {
  const n = num(v)
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Adapts a raw fix-confidence result. Returns `null` when the object isn't
 * present or carries no usable `state` — absence means NOT APPLICABLE (the
 * pattern was never resolved, so there is nothing to prove), which is a
 * different fact from `unproven` and must never be rendered as one.
 */
export function adaptFixConfidence(raw: unknown): AdaptedFixConfidence | null {
  if (!isRecord(raw)) return null
  const s = raw['state']
  const state: FixConfidenceState | null =
    s === 'unproven' || s === 'proving' || s === 'confirmed' || s === 'regressed' ? s : null
  if (state === null) return null

  const attribution = raw['versionAttribution']
  const versionAttribution: FixVersionAttribution =
    attribution === 'matched' || attribution === 'mismatched' ? attribution : 'unknown'

  const limit = raw['limitingFactor']
  const limitingFactor: FixConfidenceLimit =
    limit === 'recurrence' ||
    limit === 'no-resolution' ||
    limit === 'version-mismatch' ||
    limit === 'no-exposure' ||
    limit === 'accumulating' ||
    limit === 'none'
      ? limit
      : 'accumulating'

  const score = num(raw['score'])
  return {
    score: score < 0 ? 0 : score > FIX_CONFIDENCE_MAX ? FIX_CONFIDENCE_MAX : score,
    state,
    exposureRuns: Math.max(0, num(raw['exposureRuns'])),
    observedRuns: Math.max(0, num(raw['observedRuns'])),
    versionAttribution,
    elapsedMs: Math.max(0, num(raw['elapsedMs'])),
    recurred: raw['recurred'] === true,
    hasResolution: raw['hasResolution'] === true,
    exposureMeasured: raw['exposureMeasured'] === true,
    exposureCredit: clamp01(raw['exposureCredit']),
    soakCredit: clamp01(raw['soakCredit']),
    limitingFactor,
  }
}

/** Adapts one raw lifecycle transition from the append-only audit log. */
export function adaptLifecycleTransition(raw: unknown): PatternLifecycleTransition {
  const r = isRecord(raw) ? raw : {}
  return {
    action: str(r['action']),
    actorClerkUserId: str(r['actorClerkUserId']),
    timestamp: num(r['timestamp']),
    ...(r['metadata'] !== undefined && { metadata: r['metadata'] }),
  }
}

function adaptResolutionMetadata(raw: unknown): PatternResolutionMetadata | null {
  if (!isRecord(raw)) return null
  const resolvedAt = raw['resolvedAt']
  if (typeof resolvedAt !== 'number' || !Number.isFinite(resolvedAt)) return null
  return {
    resolvedAt,
    ...(typeof raw['resolvedByUserId'] === 'string' && { resolvedByUserId: raw['resolvedByUserId'] }),
    ...(typeof raw['resolutionNote'] === 'string' && { resolutionNote: raw['resolutionNote'] }),
    ...(typeof raw['resolutionRef'] === 'string' && { resolutionRef: raw['resolutionRef'] }),
    ...(typeof raw['resolvedInVersionId'] === 'string' && { resolvedInVersionId: raw['resolvedInVersionId'] }),
    ...(typeof raw['resolvedInVersion'] === 'string' && { resolvedInVersion: raw['resolvedInVersion'] }),
    ...(typeof raw['resolvedAtOccurrenceCount'] === 'number' && {
      resolvedAtOccurrenceCount: raw['resolvedAtOccurrenceCount'],
    }),
    ...(typeof raw['resolvedAtRunCount'] === 'number' && { resolvedAtRunCount: raw['resolvedAtRunCount'] }),
  }
}

function adaptResolutionExposure(raw: unknown): PatternResolutionExposure | null {
  if (!isRecord(raw)) return null
  const since = raw['since']
  if (typeof since !== 'number' || !Number.isFinite(since)) return null
  return {
    since,
    runCount: Math.max(0, num(raw['runCount'])),
    runCountTruncated: raw['runCountTruncated'] === true,
    recurrenceCount: Math.max(0, num(raw['recurrenceCount'])),
    ...(typeof raw['baselineRunCount'] === 'number' && { baselineRunCount: raw['baselineRunCount'] }),
    agentIds: Array.isArray(raw['agentIds'])
      ? (raw['agentIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    heldSoFar: raw['heldSoFar'] === true,
  }
}

/** The adapted `getPatternResolutionEvidence` projection, plus the confidence score when the service supplied one. */
export interface AdaptedResolutionEvidence {
  /** Null when there is no live resolution to evidence — never resolved, or MANUALLY reopened (which clears `resolvedAt`). */
  resolution: PatternResolutionMetadata | null
  /** Null exactly when `resolution` is null. */
  exposure: PatternResolutionExposure | null
  /** Oldest-first lifecycle history reconstructed from the append-only audit log. */
  transitions: PatternLifecycleTransition[]
  /** Null when the service did not score this pattern (never resolved => not applicable, or confidence not wired yet). */
  confidence: AdaptedFixConfidence | null
}

/** Adapts a raw `getPatternResolutionEvidence` result. Returns `null` for a missing/unusable payload so callers render an explicit "no evidence" state. */
export function adaptResolutionEvidence(raw: unknown): AdaptedResolutionEvidence | null {
  if (!isRecord(raw)) return null
  return {
    resolution: adaptResolutionMetadata(raw['resolution']),
    exposure: adaptResolutionExposure(raw['exposure']),
    transitions: Array.isArray(raw['transitions']) ? raw['transitions'].map(adaptLifecycleTransition) : [],
    confidence: adaptFixConfidence(raw['confidence']),
  }
}

/**
 * Fetches resolution evidence across the service seam
 * (`failure_patterns:getPatternResolutionEvidence` via Team C's service).
 *
 * Returns a discriminated result rather than throwing, so the page renders an
 * honest "evidence unavailable" panel instead of a blank screen — and, in
 * particular, never renders a resolved pattern as if it were proven merely
 * because the evidence query failed. A silently omitted evidence section is
 * indistinguishable from a proven fix, which is the confusion this whole
 * cycle exists to remove.
 *
 * `unavailable` (a `null` result) is the tenancy-collapsed "no such
 * fingerprint in this org" outcome, deliberately indistinguishable from
 * "belongs to another org" — see the service function's own comment.
 */
export type ResolutionEvidenceFetch =
  | { status: 'ready'; evidence: AdaptedResolutionEvidence }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

export async function loadPatternResolutionEvidence(fingerprintHash: string): Promise<ResolutionEvidenceFetch> {
  try {
    const { getPatternResolutionEvidence } = await import('@/lib/services/failurePatterns')
    const raw = await getPatternResolutionEvidence(fingerprintHash)
    const evidence = adaptResolutionEvidence(raw)
    return evidence ? { status: 'ready', evidence } : { status: 'unavailable' }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'Failed to load resolution evidence' }
  }
}

/** Adapts a raw `getFailurePatternDetail`/`getFailurePattern` result into the real contract detail shape. */
export function adaptFailurePatternDetail(
  raw: FailurePatternDetail | { pattern: unknown; recentOccurrences?: unknown[]; trend?: unknown[] } | null | undefined,
): AdaptedFailurePatternDetail | null {
  if (!raw) return null
  return {
    pattern: adaptFailurePattern(raw.pattern),
    recentOccurrences: (raw.recentOccurrences ?? []).map(adaptOccurrence),
    trend: (raw.trend ?? []).map(adaptTrendPoint),
  }
}
