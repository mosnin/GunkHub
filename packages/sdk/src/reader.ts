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
 * Response shape for the run-explanation read, mirroring the existing
 * Clerk-authed `GET /api/runs/:id/explanation`
 * (`apps/web/app/api/runs/[id]/explanation/route.ts`) exactly: `explanation`
 * is `null` when there is nothing to show yet.
 *
 * **Known gap (`docs/design/explanations.md` "Known gap: coarse null
 * state"):** `null` covers BOTH "this run hasn't failed — nothing to
 * explain" AND "this run failed but generation hasn't completed/been
 * triggered yet." This shape cannot distinguish them on its own — pair a
 * `null` result with the run's own `status` (e.g. via {@link
 * FlightReader.getRun}) if you need to tell those two apart, the same way
 * `@agent-flight-recorder/cli`'s `afr explain` does.
 */
export interface V1GetExplanationData {
  explanation: RunExplanation | null
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

export interface V1ListFailurePatternsData {
  patterns: FailurePattern[]
  nextCursor?: string
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
   * Only `'regressed'` is answerable on the list endpoint. The other three
   * states depend on per-pattern post-resolution run exposure, which cannot
   * be measured across a whole page of patterns; passing them raises a
   * `V1ApiError` (`kind: 'server'`, HTTP 422) rather than silently returning
   * an unfiltered or empty page. Use
   * {@link FlightReader.getFailurePatternEvidence} for those, one pattern at
   * a time.
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
