/**
 * `FlightReader` — a typed, read-only client for the Agent Flight Recorder
 * public v1 read API (`docs/api_reference.md`), shipped from the SDK so
 * "record with `Recorder`, read back with `FlightReader`" is a single-package
 * story instead of requiring a separate HTTP client.
 *
 * v1 endpoints (all GET, `x-api-key` auth with the `read` scope):
 *   GET /api/v1/runs                 -> listRuns()
 *   GET /api/v1/runs/:id             -> getRun()
 *   GET /api/v1/runs/:id/events      -> getRunEvents() / iterateEvents()
 *   GET /api/v1/runs/:id/replay      -> getReplay()
 *
 * Every response is wrapped in an envelope: `{ apiVersion, data }` on
 * success, `{ apiVersion, error: { code, message } }` on failure — parsed
 * tolerantly by the shared {@link fetchV1} helper in `./v1-client.js` (the
 * ONE source of truth this class shares with `@agent-flight-recorder/cli`'s
 * `apiClient.ts`).
 *
 * Uses only the native `fetch` — no HTTP framework dependency, consistent
 * with the rest of the SDK.
 */
import { warnIfInsecureEndpoint } from './transport.js'
import { fetchV1, V1ApiError } from './v1-client.js'

import type { V1ApiConfig, V1FetchLike } from './v1-client.js'
import type {
  Event,
  FailurePattern,
  FailurePatternStatus,
  FailureSummary,
  FixConfidenceState,
  PatternResolutionEvidence,
  ReplayProjection,
  Run,
  RunExplanation,
  RunExplanationQueryStatus,
  RunStatus,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// v1 response data shapes (entity types reused from contracts — read-only)
// ---------------------------------------------------------------------------

export interface V1ListRunsData {
  runs: Run[]
  nextCursor?: string
  /** Current page's length. Kept alongside `total` for the Clerk-authed-route naming compatibility documented in `docs/api_reference.md`. */
  pageSize?: number
  total?: number
}

export interface V1GetRunData {
  run: Run
  eventCount: number
  artifactCount: number
}

export interface V1ListEventsData {
  events: Event[]
  nextCursor?: string
}

export interface V1ReplayData {
  projection: ReplayProjection
  failureSummary: FailureSummary
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/:id/explanation — the "explainability layer" root-cause
// read (ADR-004, `docs/adr/004-run-explanations.md`). See getExplanation()
// below for the full contract writeup, including the known coarse-null gap.
// ---------------------------------------------------------------------------

/**
 * Response shape for the run-explanation read, mirroring the Clerk-authed
 * `GET /api/runs/:id/explanation` exactly: `explanation` is `null` when there
 * is nothing to show yet.
 *
 * **The coarse-null gap is closed, but only where `status` is present.**
 * `explanation: null` on its own covers BOTH "this run will never have an
 * explanation" (not failed/timed_out/cancelled) AND "eligible, but generation
 * hasn't landed yet." `status` is the explicit discriminant that separates
 * them (`'not_eligible' | 'pending' | 'ready'`, matching contracts'
 * `RunExplanationQueryResult`), and `runStatus`/`runEndedAt` let a caller
 * apply a grace period without a second round-trip.
 *
 * `status`, `runStatus` and `runEndedAt` are OPTIONAL on this type rather
 * than required, because a consumer pinned to an older deployment (whose
 * `apiGetExplanation` predates the discriminant) still has to typecheck.
 * Branch on `status` when it is present; fall back to pairing `null` with
 * the run's own status from {@link FlightReader.getRun} when it is not —
 * which is what `@agent-flight-recorder/cli`'s `afr explain` does.
 */
export interface V1GetExplanationData {
  explanation: RunExplanation | null
  /** Explicit discriminant. Absent on deployments older than the coarse-null fix. */
  status?: RunExplanationQueryStatus
  /** The run's own status, carried so a caller need not re-fetch the run. */
  runStatus?: string
  /** The run's `endedAt`, for grace-period logic. Absent for a run still in flight. */
  runEndedAt?: number
}

// ---------------------------------------------------------------------------
// GET /api/v1/patterns — Failure Patterns (PREVENTION cycle 1, ADR-005): a
// durable, org-scoped memory of recurring failure fingerprints, ranked by
// recency. See `getFailurePatterns()` below for the full contract.
// ---------------------------------------------------------------------------

// PREVENTION cycle 3 ("mute reflection"): `FailurePattern` (contracts) now
// carries `muted`/`mutedAt` — admin-gated, org-wide suppression of alert
// firing for a fingerprint, set via a separate Clerk-authed admin route.
// This read surface (`FlightReader` / `afr patterns`) only ever REFLECTS that
// state (it comes through unchanged as part of `FailurePattern`); it never
// mutates it — there is deliberately no key-authed "mute" write here (see
// `getFailurePatterns`'s doc and `packages/cli/src/commands/patterns.ts` for
// the full reasoning).
//
// Resolution cycle 1 (docs/adr/006-failure-resolution.md, Team A's
// lifecycle fields): `FailurePattern` now also carries `status` ('open' |
// 'acknowledged' | 'resolved', absent meaning 'open'), `acknowledgedAt`/
// `acknowledgedByUserId`, `resolvedAt`/`resolvedByUserId`/`resolutionNote`/
// `resolutionRef`, and `regressedAt` (set by the backend's regression guard
// the moment a resolved pattern gets a new occurrence — cleared on a manual
// reopen). Exactly like `muted`, this surface only ever REFLECTS lifecycle
// state — `status`/`regressed` below are read-side filters only. There is no
// method here to acknowledge/resolve/reopen a pattern: those are member-
// gated, audited, Clerk-authed org actions (a separate team's routes). A
// key-authed write here would bypass both the member-gate and the audit
// log — same reasoning as the no-CLI-mute decision, see
// `packages/cli/src/commands/patterns.ts` for the full writeup.

/**
 * One confidence view per returned pattern (ADR-006 cycle 3), in the same
 * order as `patterns`.
 *
 * `stale` and `basis: 'none'` mean DIFFERENT things and must not be collapsed:
 * a stale entry has a real verdict that has simply aged, while `basis: 'none'`
 * has no verdict at all. Rendering either one identically to a fresh verdict
 * reintroduces exactly the false confidence this whole feature exists to
 * remove.
 */
export interface FixConfidenceEntry {
  fingerprintHash: string
  /** Null when there is no usable snapshot (never resolved, reopened, superseded, or not yet snapshotted). */
  state: FixConfidenceState | null
  score: number | null
  /** When the served verdict was computed. Null when there is no snapshot. */
  computedAt: number | null
  /** `now - computedAt`, per the SERVER clock. Null when there is no snapshot. */
  ageMs: number | null
  /**
   * True when `ageMs` exceeds `stalenessBoundMs`. Always false when there is
   * no snapshot — absent is not stale, it is unknown.
   *
   * A stale verdict is still the best available answer and is served rather
   * than dropped: soak and exposure only accumulate, so an aging snapshot can
   * UNDER-report (say `proving` where live says `confirmed`) but never
   * over-report, and the one downgrade a verdict can take — `regressed` — is
   * written eagerly by the regression guard and never waits for a cron tick.
   */
  stale: boolean
  /** `'snapshot'` — served from a stored verdict. `'none'` — no usable snapshot. */
  basis: 'snapshot' | 'none'
}

/**
 * Honesty envelope accompanying every pattern list, filtered or not, so a
 * client can mark a stale verdict without asking for it and without
 * hardcoding the bound.
 */
export interface V1ListFixConfidenceEnvelope {
  /** Age at which a snapshot is considered stale. Transported, never hardcoded by the client. */
  stalenessBoundMs: number
  /** One entry per returned pattern, in the same order as `patterns`. */
  entries: FixConfidenceEntry[]
  /** How many returned entries are served from a snapshot older than the bound. */
  staleCount: number
  /**
   * Fingerprints on this page that have a live resolution but NO usable
   * snapshot, so they could not be graded at all.
   *
   * These are excluded from a `state`-filtered result because they genuinely
   * do not match a known state — but they are named here rather than silently
   * dropped, because "we could not evaluate these" is a materially different
   * answer from "these do not match", and a caller that conflates the two is
   * treating unknown as no.
   */
  unevaluated: string[]
}

export interface V1ListFailurePatternsData {
  patterns: FailurePattern[]
  nextCursor?: string
  /**
   * Present since ADR-006 cycle 3. Optional on this type so a consumer
   * pinned to an older deployment still typechecks.
   */
  fixConfidence?: V1ListFixConfidenceEnvelope
}

// ---------------------------------------------------------------------------
// Fix confidence (ADR-006 cycle 2 — "prove the fix held").
//
// The scoring ENGINE is convex/insights.ts §12; the canonical TYPES are in
// `@agent-flight-recorder/contracts` (>= 0.9.0) and are re-exported here so
// SDK consumers get them from one import, exactly as `FailurePattern` and
// `FailurePatternStatus` already are.
//
// These were briefly mirrored locally in this file, because a published npm
// package cannot import a Convex module and contracts did not yet carry them.
// That duplication is gone: one declaration, in contracts, per CLAUDE.md.
// tests/unit/fix_confidence_vocab.test.ts pins the contracts literals against
// convex/insights.ts, since that seam is still hand-maintained.
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/patterns/:fingerprintHash/evidence` — the full "did the fix
 * hold?" projection. Structurally identical to the Clerk-authed
 * `getPatternResolutionEvidence` shape, so both doors return the same thing.
 *
 * Reading the numbers correctly: `confidence.score` is a 0-1 fraction capped
 * at 0.95 (never a percentage, never 1.0); `exposure.runCount` is a FLOOR
 * when `exposure.runCountTruncated` is true; `exposure.baselineRunCount` is a
 * 14-day TRAILING baseline for comparison and must never be subtracted from
 * `runCount`; and `heldSoFar: true` with `runCount: 0` means untested, which
 * `confidence.state` reports as `'unproven'`.
 */
export type V1PatternEvidenceData = PatternResolutionEvidence

export interface ListFailurePatternsParams {
  /** Narrow to patterns that have been seen on at least one version of this agent. */
  agentId?: string
  /**
   * Narrow to patterns whose most recent spike assessment flagged them as
   * currently spiking (`lastSpikeAssessment.isSpiking === true`) — the
   * proactive-prevention filter (PREVENTION cycle 2, "make spikes
   * actionable"). Patterns with no assessment yet, or a non-spiking one, are
   * excluded when this is `true`. Omit (or pass `false`) to see all patterns.
   */
  spiking?: boolean
  /**
   * Mute-aware filter (PREVENTION cycle 3): pass `true` to see only muted
   * patterns, `false` to see only active (unmuted) ones. Omit to see all
   * patterns regardless of mute state. This is purely a read-side filter —
   * it has no effect on whether alerts fire; that is governed entirely by
   * the `muted` flag an org admin sets through the (Clerk-authed) admin
   * route, not by this parameter.
   */
  muted?: boolean
  /**
   * Resolution-lifecycle filter (docs/adr/006-failure-resolution.md): narrow
   * to patterns whose `status` exactly matches ('open' | 'acknowledged' |
   * 'resolved'). A pattern with no `status` field set is treated as 'open'
   * (the documented default for every pre-lifecycle row). Omit to see
   * patterns of any status. Purely a read-side filter — it has no effect on
   * lifecycle state, which only changes through the member-gated,
   * Clerk-authed acknowledge/resolve/reopen routes.
   */
  status?: FailurePatternStatus
  /**
   * Narrow to patterns that currently have `regressedAt` set — i.e. a
   * RESOLVED pattern that received a new occurrence after it was resolved
   * ("your fix didn't hold"), per the backend's regression guard. Omit (or
   * pass `false`) to see patterns regardless of regression state.
   */
  regressed?: boolean
  /**
   * FIX-CONFIDENCE state filter (ADR-006 cycle 2) — a different axis from
   * {@link ListFailurePatternsParams.status}: `status` is what a human
   * ASSERTED about a pattern, `state` is what the EVIDENCE supports.
   *
   * ALL FOUR STATES are answerable as of ADR-006 cycle 3. The three that
   * depend on post-resolution run exposure are served from a periodically
   * refreshed per-pattern snapshot rather than a per-request scan, so the
   * filter no longer needs a scan it cannot afford. (Cycle 2 rejected those
   * three outright rather than answer them wrongly; the param's name, type
   * and meaning are unchanged by the widening.)
   *
   * Snapshot-backed answers come with their age: read
   * {@link V1ListFixConfidenceEnvelope} on the response for per-pattern
   * `stale` flags, and for `unevaluated` — patterns with a live resolution
   * but no usable snapshot, which cannot match any state and are named rather
   * than silently dropped.
   *
   * `'regressed'` additionally keeps an exact, snapshot-independent path and
   * matches if EITHER that or the snapshot says so, so it is never weaker
   * than before snapshots existed and never depends on cron liveness.
   *
   * PREFER THIS OVER `regressed` FOR CI. `regressed: true` matches any
   * pattern with `regressedAt` set — including one whose regression PREDATES
   * its current resolution (it regressed, was genuinely re-fixed, and was
   * re-resolved; `resolvePattern` deliberately preserves `regressedAt` as
   * history). `state: 'regressed'` matches only a recurrence strictly after
   * the live `resolvedAt` — a fix that actually did not hold. A build gate
   * built on the boolean will fail on patterns that are already fixed again.
   */
  state?: FixConfidenceState
  limit?: number
  cursor?: string
}

export interface ListRunsParams {
  status?: RunStatus
  agentId?: string
  environment?: string
  sessionId?: string
  limit?: number
  cursor?: string
}

export interface ListEventsParams {
  limit?: number
  cursor?: string
}

/**
 * Window size used by {@link FlightReader.getRunEventWindow} when the caller
 * gives an `aroundSequence` without an explicit `limit`. Centering needs a
 * known width, and the server's own page default is not knowable client-side,
 * so the window read picks one rather than guessing at the server's.
 */
export const DEFAULT_EVENT_WINDOW_SIZE = 100

/**
 * Parameters for {@link FlightReader.getRunEventWindow} — a BOUNDED slice of
 * a run's event log addressed by `sequenceNumber` instead of by an opaque
 * cursor walked from the start of the log.
 *
 * Exactly one of `fromSequence` / `aroundSequence` may be given (both is a
 * caller error and throws). Omitting both reads from the head of the log,
 * i.e. `fromSequence: 1`.
 */
export interface EventWindowParams {
  /**
   * Lower bound (inclusive) on `sequenceNumber`. Positive integer.
   * Continue forward by re-calling with `fromSequence = last.sequenceNumber + 1` —
   * a stateless, restartable continuation that needs no cursor.
   */
  fromSequence?: number
  /**
   * Center the window on this `sequenceNumber` — e.g. an event cited by a
   * `RunExplanation`'s `citedSequenceNumbers`, read with its preceding
   * context. Resolved client-side to
   * `fromSequence = max(1, aroundSequence - floor(limit / 2))`, so it needs
   * no second server primitive beyond the sequence floor.
   */
  aroundSequence?: number
  /** Window width. Defaults to {@link DEFAULT_EVENT_WINDOW_SIZE} when `aroundSequence` is used; otherwise to the server's page default. Server-capped. */
  limit?: number
}

/** Result of {@link FlightReader.getRunEventWindow}. */
export interface V1EventWindowData {
  /** The events in the window, in `sequenceNumber` order. */
  events: Event[]
  /**
   * The sequence floor actually requested — echoed back because with
   * `aroundSequence` it is computed here, and a caller reasoning about
   * coverage needs the number that was really asked for.
   */
  fromSequence: number
  /**
   * The server's own forward cursor, when it sent one. Prefer continuing with
   * `fromSequence = last.sequenceNumber + 1`: it survives a process restart
   * and cannot silently point at a different position.
   */
  nextCursor?: string
}

/** Constructor options for {@link FlightReader}. */
export interface FlightReaderConfig {
  /** Base URL of the Agent Flight Recorder deployment (e.g. `https://afr.example.com`). */
  baseUrl: string
  /** An API key carrying the `read` scope (see `docs/api_reference.md` — a write-only `ingest:write` key is rejected with 403). */
  apiKey: string
  /**
   * Suppress the one-time console warning emitted when `baseUrl` uses plain
   * HTTP to a non-localhost host (the read-scoped API key would transit in
   * cleartext) — same warning, and same opt-out, as `RecorderConfig.options.
   * allowInsecureEndpoint` / `FlightRecorderConfig.allowInsecureEndpoint`.
   * Default: false.
   */
  allowInsecureEndpoint?: boolean
}

/**
 * Reject a non-positive / non-integer window bound before a request is made.
 * Sequence numbers are positive contiguous integers (CLAUDE.md event-log rule
 * 4), so `fromSequence: 0` or `limit: 2.5` is a caller bug, not something to
 * forward to the server and let it interpret.
 */
function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`getRunEventWindow: ${name} must be a positive integer, got ${value}.`)
  }
}

/**
 * Read-only client over the v1 read API.
 *
 * ```ts
 * const reader = new FlightReader({ baseUrl: 'https://afr.example.com', apiKey: process.env.AFR_READ_KEY! })
 * const { runs } = await reader.listRuns({ status: 'failed', limit: 25 })
 * const { run, eventCount } = await reader.getRun(runs[0].id)
 * for await (const event of reader.iterateEvents(run.id)) {
 *   console.log(event.type, event.sequenceNumber)
 * }
 * ```
 */
export class FlightReader {
  private readonly config: V1ApiConfig
  private readonly fetchImpl: V1FetchLike | undefined

  /**
   * @param config - `{ baseUrl, apiKey }`. The API key must carry the `read` scope.
   * @param fetchImpl - injectable fetch, defaults to the global `fetch`. Tests
   *   inject a mock here — never make a real HTTP call in a unit test.
   */
  constructor(config: FlightReaderConfig, fetchImpl?: V1FetchLike) {
    this.config = { baseUrl: config.baseUrl, apiKey: config.apiKey }
    this.fetchImpl = fetchImpl
    // Same cleartext-transit warning as the write paths (HttpTransport /
    // FlightRecorder) — a read-scoped key sent over plain HTTP to a
    // non-localhost host is just as exposed as a write-scoped one.
    warnIfInsecureEndpoint(config.baseUrl, config.allowInsecureEndpoint)
  }

  /**
   * List runs for the key's organization, most-recent-first.
   *
   * @param filters - optional `status`/`agentId`/`environment`/`sessionId` filters plus `limit`/`cursor` pagination.
   * @returns `{ runs, nextCursor }` — pass `nextCursor` back as `cursor` to page.
   * @throws {@link V1ApiError} on any auth/not-found/rate-limit/server/network failure.
   */
  listRuns(filters: ListRunsParams = {}): Promise<V1ListRunsData> {
    return fetchV1<V1ListRunsData>(
      this.config,
      '/api/v1/runs',
      {
        status: filters.status,
        agentId: filters.agentId,
        environment: filters.environment,
        sessionId: filters.sessionId,
        limit: filters.limit,
        cursor: filters.cursor,
      },
      this.fetchImpl
    )
  }

  /**
   * Fetch a single run by id, along with its event and artifact counts.
   *
   * @param runId - the run's id.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the run does not exist or does not belong to the key's org.
   */
  getRun(runId: string): Promise<V1GetRunData> {
    return fetchV1<V1GetRunData>(this.config, `/api/v1/runs/${encodeURIComponent(runId)}`, {}, this.fetchImpl)
  }

  /**
   * Fetch one page of a run's event log, in `sequenceNumber` order.
   *
   * @param runId - the run's id.
   * @param options - `limit` (page size) and `cursor` (opaque, from a previous page's `nextCursor`).
   * @returns `{ events, nextCursor }` — `nextCursor` is absent once the last page has been fetched.
   */
  getRunEvents(runId: string, options: ListEventsParams = {}): Promise<V1ListEventsData> {
    return fetchV1<V1ListEventsData>(
      this.config,
      `/api/v1/runs/${encodeURIComponent(runId)}/events`,
      { ...(options.limit !== undefined && { limit: options.limit }), ...(options.cursor !== undefined && { cursor: options.cursor }) },
      this.fetchImpl
    )
  }

  /**
   * Read a BOUNDED WINDOW of a run's event log, addressed by
   * `sequenceNumber` rather than by an opaque cursor walked from the start.
   *
   * This exists because {@link getRunEvents}/{@link iterateEvents} can only
   * page forward from the head: to reach sequence 5 000 with a cursor you
   * must fetch the 4 999 events before it. For a consumer that already knows
   * WHERE to look — a `RunExplanation`'s `citedSequenceNumbers`, a failing
   * tool call, the tail of a 20 000-event run — that is the whole log for a
   * hundred events of signal.
   *
   * **Never slices client-side.** This method does not fetch the run and cut
   * a window out of it; that would spend exactly the cost the window exists
   * to avoid. It asks the server for the window and, if the server did not
   * honor the request, says so (see below) instead of returning a wrong
   * answer that looks right.
   *
   * **SERVER SUPPORT REQUIRED — check your deployment.** The v1 events
   * endpoint accepts `limit`/`cursor` today; `fromSequence` is a newer
   * parameter. An older deployment IGNORES an unknown query parameter and
   * cheerfully returns the FIRST page of the log — events 1..N, presented as
   * though they were the window around 5 000. That silent wrong answer is the
   * failure mode this method refuses to have: when the returned page starts
   * below the requested floor, it throws a {@link V1ApiError} with
   * `kind: 'invalid_response'` naming the missing server support. The check is
   * exact, not heuristic — sequence numbers start at 1 and are contiguous, so
   * a server that honored the floor can never return an event below it, and a
   * server that ignored it always does whenever the run has events at all.
   *
   * Artifact payloads are never inlined by this (or any) reader method: an
   * event whose payload was externalized past the 10 KB limit carries its
   * artifact pointer and SHA-256 checksum in the payload, and the bytes are
   * fetched separately and deliberately.
   *
   * @param runId - the run's id.
   * @param options - `fromSequence` OR `aroundSequence` (not both), plus `limit`.
   * @returns `{ events, fromSequence, nextCursor? }`. An empty `events` means
   *   the run has nothing at or after the floor — not an error.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the run does not
   *   exist or does not belong to the key's org — the two are deliberately
   *   indistinguishable, exactly as on every other method here.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if the server
   *   ignored `fromSequence` (deployment predates windowed reads).
   * @throws {RangeError} if the arguments are self-contradictory or not
   *   positive integers — a caller bug, surfaced before any request is made.
   */
  async getRunEventWindow(runId: string, options: EventWindowParams = {}): Promise<V1EventWindowData> {
    const { fromSequence, aroundSequence, limit } = options

    if (fromSequence !== undefined && aroundSequence !== undefined) {
      throw new RangeError(
        'getRunEventWindow: pass either fromSequence or aroundSequence, not both — they specify the same window edge two different ways.'
      )
    }
    assertPositiveInteger(fromSequence, 'fromSequence')
    assertPositiveInteger(aroundSequence, 'aroundSequence')
    assertPositiveInteger(limit, 'limit')

    // `aroundSequence` is resolved to a floor here rather than sent as its own
    // server parameter: centering is pure arithmetic over a width the caller
    // already chose, so the backend only ever needs ONE new primitive (a
    // sequence floor on an index it already has), not two.
    const effectiveLimit = aroundSequence !== undefined ? (limit ?? DEFAULT_EVENT_WINDOW_SIZE) : limit
    const effectiveFrom =
      aroundSequence !== undefined
        ? Math.max(1, aroundSequence - Math.floor((effectiveLimit ?? DEFAULT_EVENT_WINDOW_SIZE) / 2))
        : (fromSequence ?? 1)

    const data = await fetchV1<V1ListEventsData>(
      this.config,
      `/api/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        fromSequence: effectiveFrom,
        ...(effectiveLimit !== undefined && { limit: effectiveLimit }),
      },
      this.fetchImpl
    )

    const events = data.events ?? []
    // Capability check. A floor of 1 is a no-op — honoring and ignoring it are
    // the same answer — so it is not evidence either way and is not checked.
    const first = events[0]
    if (effectiveFrom > 1 && first !== undefined && first.sequenceNumber < effectiveFrom) {
      throw new V1ApiError(
        'invalid_response',
        `getRunEventWindow(${runId}): the server ignored fromSequence=${effectiveFrom} and returned the log from sequence ` +
          `${first.sequenceNumber} instead. This deployment's GET /api/v1/runs/:id/events does not support windowed ` +
          `reads yet. Refusing to return the head of the log as though it were the requested window.`
      )
    }

    return {
      events,
      fromSequence: effectiveFrom,
      ...(data.nextCursor !== undefined && { nextCursor: data.nextCursor }),
    }
  }

  /**
   * Page transparently through a run's entire event log, yielding events in
   * `sequenceNumber` order. Fetches lazily, one page at a time, via
   * {@link getRunEvents} — a consumer that `break`s out of the loop early
   * simply stops paging.
   *
   * Guards against a misbehaving (or hostile) server hanging the caller
   * forever: if `nextCursor` is ever identical to the cursor just requested
   * (no pagination progress) or the loop exceeds `maxPages`, the generator
   * throws a {@link V1ApiError} with `kind: 'invalid_response'` instead of
   * looping without end.
   *
   * @param runId - the run's id.
   * @param options - `pageSize` controls the `limit` sent on each underlying
   *   request (server-capped). `maxPages` bounds total pages fetched
   *   (default: 100 000 — effectively unbounded for any real run, but finite).
   * @throws {@link V1ApiError} on a request failure, a non-advancing cursor, or `maxPages` exceeded.
   */
  async *iterateEvents(
    runId: string,
    options: { pageSize?: number; maxPages?: number } = {}
  ): AsyncGenerator<Event, void, void> {
    const maxPages = options.maxPages ?? 100_000
    let cursor: string | undefined
    let pages = 0
    do {
      if (pages >= maxPages) {
        throw new V1ApiError(
          'invalid_response',
          `iterateEvents(${runId}) aborted after ${maxPages} pages without reaching the end of the event log.`
        )
      }
      pages++
      const page = await this.getRunEvents(runId, {
        ...(options.pageSize !== undefined && { limit: options.pageSize }),
        ...(cursor !== undefined && { cursor }),
      })
      for (const event of page.events) {
        yield event
      }
      if (page.nextCursor !== undefined && page.nextCursor === cursor) {
        // The server returned the same cursor it was just given — pagination
        // is not advancing. Looping forever on a stalled cursor is worse than
        // failing loudly: it would hang the caller's process indefinitely.
        throw new V1ApiError(
          'invalid_response',
          `iterateEvents(${runId}): server returned a non-advancing cursor ("${page.nextCursor}") — refusing to loop forever.`
        )
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
  }

  /**
   * Fetch the server-computed replay projection for a run — the same
   * derivation the web UI's replay view uses (CLAUDE.md: replay is a derived
   * projection, never stored).
   *
   * @param runId - the run's id.
   */
  getReplay(runId: string): Promise<V1ReplayData> {
    return fetchV1<V1ReplayData>(this.config, `/api/v1/runs/${encodeURIComponent(runId)}/replay`, {}, this.fetchImpl)
  }

  /**
   * Fetch the cached root-cause explanation for a run — ADR-004's
   * "explainability layer" (CLAUDE.md's v1 outcome: "make failures
   * explainable"). Mirrors {@link getReplay}: a GET against a v1 read
   * endpoint, `x-api-key` auth, `{ apiVersion, data }` envelope.
   *
   * Resolves `{ explanation }`, where `explanation` is `null` when there is
   * nothing to show yet — see {@link V1GetExplanationData}'s doc for the
   * documented coarse-null gap (it cannot distinguish "run hasn't failed"
   * from "failed but not explained yet" on its own). This is a *successful*
   * resolution, not an error — never throws for a `null` result. `V1ApiError`
   * is still thrown for genuine failures (the run does not exist:
   * `kind: 'not_found'`; auth; rate limiting; network; malformed response).
   *
   * **Server-side status (as of this cycle):** `GET /api/v1/runs/:id/explanation`
   * (the key-authed v1 counterpart of the already-shipped Clerk-authed
   * `GET /api/runs/:id/explanation`) does not exist yet — this method is
   * written against the exact same response shape that route already
   * returns (`{ explanation: RunExplanation | null }`, backed by
   * `convex/run_explanations.ts`), so wiring the v1 route should be a thin
   * proxy with no SDK-side change required once it exists. Calling this
   * today surfaces a `V1ApiError` with `kind: 'not_found'` (no route
   * registered) until then.
   *
   * @param runId - the run's id.
   * @throws {@link V1ApiError} on any auth/not-found/rate-limit/server/network/parse failure.
   */
  getExplanation(runId: string): Promise<V1GetExplanationData> {
    return fetchV1<V1GetExplanationData>(
      this.config,
      `/api/v1/runs/${encodeURIComponent(runId)}/explanation`,
      {},
      this.fetchImpl
    )
  }

  /**
   * List recurring failure patterns for the key's organization, most-
   * recently-seen first — the "Failure Patterns" durable memory (ADR-005):
   * a rollup of fingerprinted, recurring failures derived from failed runs'
   * explanations, never source of truth on its own (the event log + each
   * run's own `RunExplanation` remain that).
   *
   * @param filters - optional `agentId` (narrows to patterns seen on at
   *   least one version of that agent), `spiking` (narrows to patterns whose
   *   `lastSpikeAssessment.isSpiking === true`), `muted` (narrows to
   *   muted/active patterns — a read-side filter only, see
   *   {@link ListFailurePatternsParams.muted}), `status` (narrows to an exact
   *   lifecycle status — 'open' | 'acknowledged' | 'resolved', see
   *   {@link ListFailurePatternsParams.status}), `regressed` (narrows to
   *   patterns with `regressedAt` set, see
   *   {@link ListFailurePatternsParams.regressed}) plus `limit`/`cursor` pagination.
   * @returns `{ patterns, nextCursor }` — pass `nextCursor` back as `cursor` to page.
   *   Each pattern carries `muted`/`mutedAt` when set (PREVENTION cycle 3),
   *   and `status`/`acknowledgedAt`/`acknowledgedByUserId`/`resolvedAt`/
   *   `resolvedByUserId`/`resolutionNote`/`resolutionRef`/`regressedAt` when
   *   set (Resolution cycle 1, ADR-006) — there is no method on this class to
   *   change mute or lifecycle state; those are admin/member-only,
   *   Clerk-authed, audited writes on the web app, not part of this
   *   key-authed read surface.
   * @throws {@link V1ApiError} on any auth/rate-limit/server/network failure.
   */
  getFailurePatterns(filters: ListFailurePatternsParams = {}): Promise<V1ListFailurePatternsData> {
    return fetchV1<V1ListFailurePatternsData>(
      this.config,
      '/api/v1/patterns',
      {
        agentId: filters.agentId,
        ...(filters.spiking !== undefined && { spiking: filters.spiking }),
        ...(filters.muted !== undefined && { muted: filters.muted }),
        ...(filters.status !== undefined && { status: filters.status }),
        ...(filters.regressed !== undefined && { regressed: filters.regressed }),
        ...(filters.state !== undefined && { state: filters.state }),
        limit: filters.limit,
        cursor: filters.cursor,
      },
      this.fetchImpl
    )
  }

  /**
   * Evidence that a failure pattern's fix actually held (ADR-006 cycle 2).
   *
   * A resolution on its own is an unearned human assertion: someone marked it
   * fixed and the product believed them. This returns what can be checked
   * against that claim — the resolution itself, the run exposure accumulated
   * since, the lifecycle transition history (from the append-only audit log,
   * including the regression guard's automatic reopens), and a graded
   * {@link FixConfidence} verdict over all of it.
   *
   * READ-ONLY, like everything on this class. There is no method here to
   * acknowledge, resolve, or reopen a pattern: those are member-gated,
   * audited, Clerk-authed actions in the web app. An API key has no human
   * actor, and the audit log exists to record which person made a privileged
   * change. Reading proof that a fix held needs no actor; asserting that it
   * held does.
   *
   * SCRIPTING THIS IN CI: `confidence.state === 'regressed'` is the
   * build-failing signal ("a fix we called done came back"). Do not gate on
   * `heldSoFar` alone — it is `true` for a fix nothing has exercised yet;
   * pair it with `exposure.runCount`, or just read `confidence.state`, which
   * already encodes that distinction as `'unproven'`.
   *
   * @param fingerprintHash - the pattern's fingerprint hash.
   * @returns the full evidence projection. `resolution`/`exposure`/
   *   `confidence` are all null together when the pattern has no live
   *   resolution to evidence.
   * @throws {@link V1ApiError} with `kind: 'not_found'` when the fingerprint
   *   is unknown to this key's organization — "never existed" and "belongs to
   *   another org" are deliberately indistinguishable.
   */
  getFailurePatternEvidence(fingerprintHash: string): Promise<V1PatternEvidenceData> {
    return fetchV1<V1PatternEvidenceData>(
      this.config,
      `/api/v1/patterns/${encodeURIComponent(fingerprintHash)}/evidence`,
      {},
      this.fetchImpl
    )
  }
}
