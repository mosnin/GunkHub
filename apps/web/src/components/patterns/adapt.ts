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
