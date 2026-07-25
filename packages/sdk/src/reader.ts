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
import {
  causalTraversalVerdict,
  divergenceReportVerdict,
  fleetDivergenceVerdict,
  SHARED_ATTRIBUTE_HYPOTHESIS_KINDS,
  fleetHealthReportVerdict,
  fleetReportIncoherences,
  fleetReportUnusableFields,
  orphanHypotheses,
  traversalClaimContradictions,
  traversalIncoherences,
  traversalUnusableFields,
} from '@agent-flight-recorder/contracts'

import { warnIfInsecureEndpoint } from './transport.js'
import { fetchV1, V1ApiError } from './v1-client.js'

import type { V1ApiConfig, V1FetchLike } from './v1-client.js'
import type {
  CausalDirection,
  CausalTraversal,
  DivergenceReport,
  Event,
  FailurePattern,
  FailurePatternStatus,
  FailureSummary,
  FixConfidenceState,
  FleetDivergenceReport,
  FleetHealthReport,
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
  /**
   * `true` when the server's scan stopped on its row ceiling
   * ({@link scanRowCeiling}) rather than on the end of the table.
   *
   * **This is the difference between "nothing matched" and "nothing matched
   * in the slice I could afford to look at."** A filtered request overfetches
   * a bounded window and then filters it, so a short — or entirely empty —
   * page can be produced purely by the ceiling. While this is `true`, an
   * empty `patterns` array is NOT evidence that nothing matches; follow
   * {@link nextCursor} until a page comes back with `scanTruncated: false`,
   * or report the question as unanswered.
   *
   * `false` is the assertion a gate is entitled to act on: the page is the
   * complete answer up to `limit`, and an empty page really does mean nothing
   * matched, anywhere.
   *
   * Same contract as `exposure.runCountTruncated` on the evidence endpoint:
   * the bound is declared, never silent.
   *
   * **Absent** means the deployment predates the marker (added in the scan-
   * window cycle after ADR-006) and therefore never declares truncation. It
   * is optional here so a consumer pinned to an older deployment still
   * typechecks — see {@link isPatternScanComplete} for the one place that
   * decides what absence means, so three callers do not each guess.
   */
  scanTruncated?: boolean
  /** Rows the server examined to produce this page. Absent on older deployments. */
  scannedRows?: number
  /** The ceiling that bounded {@link scannedRows} (2,000). Absent on older deployments. */
  scanRowCeiling?: number
}

/**
 * Whether a pattern page is the *complete* answer to the question that was
 * asked, or merely the part of it the server could afford to look at.
 *
 * Read this instead of touching {@link V1ListFailurePatternsData.scanTruncated}
 * directly, because the field has three states and only two of them are
 * obvious:
 *
 * - `false` — a full scan. Complete. An empty page means nothing matched.
 * - `true`  — the ceiling stopped the scan. **Not** complete.
 * - absent  — the deployment is older than the marker and never declares
 *   truncation. Reported as complete.
 *
 * That last case is a deliberate, and slightly uncomfortable, choice. Treating
 * absence as incomplete would make every request against an older deployment
 * permanently inconclusive, which turns a gate into noise and teaches people
 * to disable it — the same end state as the bug this field exists to fix, by a
 * longer road. Treating it as complete restores exactly the behaviour those
 * deployments already had. The honest reading is "this deployment does not
 * answer the question", and a caller that needs to distinguish it can test
 * `data.scanTruncated === undefined` itself.
 */
export function isPatternScanComplete(data: Pick<V1ListFailurePatternsData, 'scanTruncated'>): boolean {
  return data.scanTruncated !== true
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

export interface ListFailurePatternsParams extends ProjectionParams {
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

// ---------------------------------------------------------------------------
// Field projection (`?fields=a,b,c`) — shared by every document-returning read
// ---------------------------------------------------------------------------

/**
 * The identity field(s) a projected document carries back whether or not they
 * were requested — the server adds them so a projected row is always
 * re-identifiable (`docs/api_reference.md` §`fields`, `convex/read_api.ts`
 * §FIELD PROJECTION rule 3).
 *
 * IT IS NOT `id` EVERYWHERE, which is the whole reason this is a table:
 * a run is keyed by its document id, an EVENT by its `sequenceNumber` within
 * its run (CLAUDE.md event-log rule 4), and a failure pattern by its
 * `fingerprintHash` (the key every pattern-scoped endpoint takes).
 *
 * EACH ENTRY IS A SET, NOT A NAME, and that is deliberate. The v1 surface has
 * historically exposed a run's key as `id` while the backend projects on the
 * raw Convex document, whose key is `_id`; `docs/api_reference.md` records
 * that naming as explicitly unresolved. This table is consumed by
 * {@link FlightReader}'s ignored-projection check ONLY — it decides which
 * unrequested keys are legitimate rather than evidence of an ignored
 * parameter — so listing every plausible identity spelling costs nothing and
 * a false accusation costs a working call. Detection is unweakened: a server
 * that dropped `?fields=` returns the entire document, not one extra key.
 */
export const PROJECTION_IDENTITY_FIELDS = {
  runs: ['id', '_id'],
  events: ['sequenceNumber', 'id', '_id'],
  patterns: ['fingerprintHash', 'id', '_id'],
} as const satisfies Record<string, readonly string[]>

/** Resources {@link ProjectionParams.fields} can project. */
export type ProjectableResource = keyof typeof PROJECTION_IDENTITY_FIELDS

/**
 * Opt-in field projection, mixed into every `FlightReader` read that returns
 * stored documents ({@link FlightReader.listRuns}, {@link FlightReader.getRun},
 * {@link FlightReader.getRunEvents}, {@link FlightReader.getRunEventWindow},
 * {@link FlightReader.getFailurePatterns}).
 *
 * Ask for less and less comes back — the point is bytes off the wire for a
 * caller that only needs `status` and `startedAt` out of a 25-field run, or
 * `type` and `sequenceNumber` out of a page of events whose payloads dominate
 * the response.
 */
export interface ProjectionParams {
  /**
   * Request only these fields on each returned document, forwarded verbatim as
   * `?fields=a,b,c`.
   *
   * **Omit it for the full document.** Omitting is the backward-compatible
   * default and is what every pre-projection caller already does.
   *
   * **THE IDENTITY FIELD ALWAYS COMES BACK**, whether or not you name it —
   * the server adds it so a projected row is always re-identifiable. Do not
   * spend a slot asking for it. It is NOT `id` on every resource: see
   * {@link PROJECTION_IDENTITY_FIELDS} — runs are keyed by their document id,
   * events by `sequenceNumber` (event-log rule 4), failure patterns by
   * `fingerprintHash`.
   *
   * **The field vocabulary is the SERVER's, and is never re-validated here.**
   * This SDK does not hold a second copy of the projectable field list to
   * check yours against: a client-side copy inevitably drifts from the
   * server's and starts rejecting fields a newer deployment supports. An
   * unknown field is answered by the server with HTTP 400 `INVALID_ARGUMENT`,
   * naming the offender, which surfaces as a {@link V1ApiError} with
   * `kind: 'invalid_response'` and `status: 400` — the same bad-request
   * mapping every other 4xx gets.
   *
   * **Malformed lists are REJECTED, never repaired**, matching the wire
   * contract exactly (`docs/api_reference.md` §`fields`): an empty list, an
   * empty or whitespace-padded entry, an entry containing a comma, or a
   * duplicate all throw a `RangeError` before any request goes out. These are
   * SHAPE rules, not vocabulary — silently trimming `' status '` or deduping
   * would hide a caller whose field list was built wrong, and the server
   * rejects the same inputs anyway. Rejecting here just fails sooner and says
   * so more clearly.
   *
   * **Typing caveat:** the returned documents are still typed as the full
   * entity (`Run`, `Event`, `FailurePattern`) so that adding this parameter
   * broke no existing signature. When you project, treat the result as
   * `Partial<T>` plus the identity field — the fields you did not ask for are
   * absent at runtime even though the type says otherwise.
   */
  fields?: readonly string[]
}

export interface ListRunsParams extends ProjectionParams {
  status?: RunStatus
  agentId?: string
  environment?: string
  sessionId?: string
  limit?: number
  cursor?: string
}

/** Options for {@link FlightReader.getRun} — projection only, so far. */
export type GetRunParams = ProjectionParams

export interface ListEventsParams extends ProjectionParams {
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
export interface EventWindowParams extends ProjectionParams {
  /**
   * Project the returned events down to these fields — see
   * {@link ProjectionParams.fields} for the general contract (the identity
   * field always comes back; the vocabulary is the server's; omit for the
   * full document).
   *
   * **`sequenceNumber` is always requested alongside your fields, whether or
   * not you name it.** This method's ignored-floor check reads
   * `events[0].sequenceNumber` to prove the server honored `fromSequence`;
   * projecting it away would silently disarm that check and hand back the head
   * of the log as though it were the requested window — the exact failure this
   * method exists to refuse. It is also the events resource's identity field,
   * so the server returns it anyway; asking explicitly means this method's own
   * guarantee does not rest on that.
   */
  fields?: readonly string[]
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
function assertPositiveInteger(value: number | undefined, name: string, method = 'getRunEventWindow'): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${method}: ${name} must be a positive integer, got ${value}.`)
  }
}

/**
 * Check a caller's `fields` list for the malformations the `?fields=` wire
 * contract rejects, before spending a request to be told so.
 *
 * SHAPE ONLY. This deliberately does NOT look at what the field NAMES are:
 * the projectable vocabulary belongs to the server (it derives it from the
 * live schema), and a second copy of it living here would drift and start
 * rejecting fields a newer deployment happily supports. An unknown name is the
 * server's 400 to give, not ours.
 *
 * REJECT, NEVER REPAIR — the same stance the route takes
 * (`apps/web/app/api/v1/_lib/fieldsParam.ts`), for the same reason. Trimming
 * `' status '`, dropping an empty slot, or deduping would accept a field list
 * the caller's code built WRONG and hide the bug behind a plausible-looking
 * response. An entry containing a comma is rejected for the sharper version of
 * that: joined into the query string it would silently become two fields.
 *
 * @returns the list, or `undefined` when no projection was requested.
 */
function assertWellFormedFields(
  fields: readonly string[] | undefined,
  method: string
): readonly string[] | undefined {
  if (fields === undefined) return undefined
  if (fields.length === 0) {
    throw new RangeError(
      `${method}: fields must name at least one field — omit it entirely to request the full document.`
    )
  }
  const seen = new Set<string>()
  for (const field of fields) {
    if (field.length === 0 || field.trim() !== field) {
      throw new RangeError(
        `${method}: fields entries must not be empty or whitespace-padded (got ${JSON.stringify(field)}). ` +
          `The server rejects the same list; nothing is trimmed for you, because a padded name usually means ` +
          `the list was built or joined wrong.`
      )
    }
    if (field.includes(',')) {
      throw new RangeError(
        `${method}: a fields entry must not contain a comma (got ${JSON.stringify(field)}) — entries are ` +
          `joined into ?fields=a,b,c, so an embedded comma would silently become two field names. Pass them ` +
          `as separate array entries.`
      )
    }
    if (seen.has(field)) {
      throw new RangeError(
        `${method}: fields must not repeat a name (got ${JSON.stringify(field)} twice). The server rejects ` +
          `duplicates rather than deduping them, because a repeat usually means two field sets were merged wrong.`
      )
    }
    seen.add(field)
  }
  return fields
}

/**
 * Prove the server actually applied the projection, instead of trusting that
 * it did.
 *
 * A deployment that predates `?fields=` silently DROPS the unknown query
 * parameter and returns the full document — which is indistinguishable, to a
 * caller reading `run.status`, from a projection that happened to include
 * everything it looked at. That is the same silent-wrong-answer class
 * {@link FlightReader.getRunEventWindow} refuses for `fromSequence`, and it is
 * refused the same way here: if a returned document carries any field OUTSIDE
 * `requested ∪ identity` (see {@link PROJECTION_IDENTITY_FIELDS}), the server
 * did not honor the request, and we say so.
 *
 * The check is one-directional on purpose, because only one direction is
 * evidence:
 *   - EXTRA fields are proof the projection was ignored. A server that applied
 *     it cannot emit a field nobody asked for.
 *   - MISSING fields are NOT proof of anything and are never flagged. Most
 *     entity fields are optional (`endedAt`, `sessionId`, `muted`, ...), so a
 *     correctly projected document routinely lacks fields that were requested.
 *
 * And it stays silent where it has no evidence at all:
 *   - no `fields` requested — nothing to verify;
 *   - an empty page / absent document — an old server returns the FULL
 *     document, so zero documents means zero information either way;
 *   - a non-object entry — nothing to inspect.
 */
function assertProjectionHonored(
  fields: readonly string[] | undefined,
  resource: ProjectableResource,
  documents: readonly unknown[],
  context: string,
  endpoint: string
): void {
  if (fields === undefined) return
  const allowed = new Set<string>([...PROJECTION_IDENTITY_FIELDS[resource], ...fields])

  for (const doc of documents) {
    if (doc === null || typeof doc !== 'object') continue
    const unrequested = Object.keys(doc as Record<string, unknown>).filter((key) => !allowed.has(key))
    if (unrequested.length === 0) continue
    throw new V1ApiError(
      'invalid_response',
      `${context}: requested fields=[${fields.join(', ')}] but the response carried unrequested ` +
        `field(s) [${unrequested.join(', ')}]. This deployment's ${endpoint} does not support field ` +
        `projection yet — an older deployment silently drops an unknown query parameter and returns the ` +
        `full document, which looks exactly like a projection that included everything. Refusing to ` +
        `return a full document as though it were the requested projection.`
    )
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/:id/divergence  and  GET /api/v1/agents/:id/divergence
//
// "Would this recorded run still have been possible on version X?" — and the
// same question across an agent's recent history. The report types are
// contracts' (`packages/contracts/src/divergence.ts`); the engine is Team A's
// (`convex/helpers/`). This is the read door onto it.
//
// SERVER SUPPORT: neither route exists yet at the time of writing. Both
// methods are written against the exact contract shape above, so wiring the
// routes should require no SDK change — the same position `getExplanation()`
// shipped in. Until then, calling either surfaces a `V1ApiError` with
// `kind: 'not_found'`.
// ---------------------------------------------------------------------------

/** Parameters for {@link FlightReader.getRunDivergence}. */
export interface RunDivergenceParams {
  /**
   * The `AgentVersion` id to test the recorded run against. REQUIRED — there
   * is no "compare against the latest" default, because a gate whose subject
   * is implicit is a gate that silently changes meaning when someone publishes
   * a new version.
   */
  targetVersionId: string
}

/** Parameters for {@link FlightReader.getAgentDivergence}. */
export interface AgentDivergenceParams {
  /** The `AgentVersion` id to test the agent's recent runs against. REQUIRED, same reasoning as {@link RunDivergenceParams.targetVersionId}. */
  targetVersionId: string
  /**
   * Lower bound (inclusive) on `run.startedAt`, epoch ms. Echoed back in
   * `window.since`, and VERIFIED — see {@link FlightReader.getAgentDivergence}.
   */
  since?: number
  /** Max runs to scan in this page. Server-capped; hitting the cap sets `window.scanTruncated`. */
  limit?: number
  /**
   * Continue a previous page's scan — pass `window.nextCursor` back.
   *
   * A fleet scan is a BOUNDED BATCH, not a whole-history query, so a complete
   * fleet answer is assembled from pages. Merge them with
   * `mergeFleetDivergenceReports` (contracts) rather than by hand: reason keys
   * are run-independent and pages partition the run set, so the merge is
   * exact — but only if everyone does it the same way.
   */
  cursor?: string
}

/** Response shape for `GET /api/v1/runs/:runId/divergence`. */
export interface V1RunDivergenceData {
  report: DivergenceReport
}

/** Response shape for `GET /api/v1/agents/:agentId/divergence`. */
export interface V1AgentDivergenceData {
  report: FleetDivergenceReport
}

/**
 * Refuse a divergence report that cannot be trusted with a deploy decision.
 *
 * THE FAILURE THIS EXISTS TO PREVENT IS A FALSE CLEAN. Every check below is
 * one where the wrong answer looks exactly like the right one to a caller
 * reading `report.proven.length === 0` — which is the whole reason this class
 * checks rather than trusts (same posture as
 * {@link FlightReader.getRunEventWindow}'s ignored-floor check and
 * {@link assertProjectionHonored}: servers lie by omission, and a dropped
 * query parameter is the most common lie).
 *
 * 1. IGNORED `targetVersionId`. A deployment that predates this route's
 *    parameter — or a proxy that strips it — answers about SOME version, quite
 *    possibly the run's own, against which a recorded run is trivially
 *    compatible. "No divergence found" is then not just wrong, it is wrong in
 *    the direction that authorises the deploy. The echo is checked exactly:
 *    absent is as fatal as mismatched, because absence proves nothing was
 *    honored either.
 *
 * 2. MISSING `coverage`. `proven: []` means "safe" or "checked nothing" and
 *    coverage is the only thing that distinguishes them. A report without it
 *    is not a weaker answer; it is an unreadable one.
 *
 * 3. A SPECULATIVE FINDING IN `proven[]`. The type system makes this
 *    impossible in OUR code (contracts' `ProvenDivergence` and
 *    `SpeculativeDivergence` are mutually unassignable, by construction — see
 *    `packages/contracts/src/divergence.ts`). It cannot make it impossible in
 *    a JSON body: TypeScript's guarantee stops at the wire. So the same
 *    segregation is re-checked here at runtime, on the response, before any
 *    caller can render an unprovable concern as proof. A `proven` entry with
 *    an empty `provenBy` is the same defect in its purest form — a claim of
 *    proof with no proof attached.
 *
 * 4. A `verdict` THAT CONTRADICTS THE REPORT'S OWN CONTENTS. The verdict is
 *    the field an operator (and a script) actually reads. Recomputing it from
 *    the arrays and comparing costs nothing, and a server that says
 *    `compatible` while carrying proven divergences is a server whose other
 *    fields have earned no benefit of the doubt either.
 *
 * NOT CHECKED, deliberately: an incomplete `coverage`, or `scanTruncated`.
 * Those are the server TELLING THE TRUTH in a field, and the correct response
 * is a verdict of `indeterminate` — which the contract already produces — plus
 * a gate that declines to pass it. That decision belongs to the gate, not the
 * client; `afr compat` makes it (exit 11), exactly as `afr patterns` does for
 * a truncated pattern scan.
 */
function assertDivergenceReportTrustworthy(
  report: DivergenceReport,
  requestedTargetVersionId: string,
  runId: string
): void {
  const context = `getRunDivergence(${runId})`
  assertEchoedTarget(report as { targetVersionId?: unknown }, requestedTargetVersionId, context)

  const coverage = (report as { coverage?: unknown }).coverage
  if (
    coverage === null ||
    typeof coverage !== 'object' ||
    !Array.isArray((coverage as { assessed?: unknown }).assessed) ||
    !Array.isArray((coverage as { unassessed?: unknown }).unassessed) ||
    typeof (coverage as { eventHistoryComplete?: unknown }).eventHistoryComplete !== 'boolean'
  ) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the report carried no usable \`coverage\`. Without it, an empty \`proven\` list cannot be ` +
        `distinguished from an analysis that examined nothing — and the two answers differ by an entire ` +
        `production deploy. Refusing to report an unmeasured run as clean.`
    )
  }

  assertFindingsSegregated(report.proven, report.speculative, report.indeterminate, context)
  assertVerdictConsistent(report.verdict, divergenceReportVerdict(report), context)
}

/**
 * The fleet counterpart of {@link assertDivergenceReportTrustworthy}, plus one
 * check that only applies to a scan.
 *
 * IGNORED `since`. A server that drops the window parameter scans a different
 * — usually older, usually larger — set of runs and reports reasons that may
 * have nothing to do with the period the operator asked about. Unlike a
 * dropped `targetVersionId`, this can fail in either direction (findings that
 * are stale, or a clean answer over runs that predate the change), and both
 * are answers to a question nobody asked. `window.since` is checked exactly
 * against what was requested, and only when a bound was requested — an absent
 * `since` on an unbounded scan is correct, not evidence.
 */
function assertFleetDivergenceReportTrustworthy(
  report: FleetDivergenceReport,
  params: AgentDivergenceParams,
  agentId: string
): void {
  const context = `getAgentDivergence(${agentId})`
  assertEchoedTarget(report as { targetVersionId?: unknown }, params.targetVersionId, context)

  const window = (report as { window?: unknown }).window
  if (
    window === null ||
    typeof window !== 'object' ||
    typeof (window as { scanTruncated?: unknown }).scanTruncated !== 'boolean' ||
    typeof (window as { runsUnassessable?: unknown }).runsUnassessable !== 'number'
  ) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the report carried no usable \`window\`. Without it there is no way to tell a scan that ` +
        `examined the agent's history from one that examined nothing, and "no reasons found" would read as ` +
        `a fleet-wide all-clear. Refusing.`
    )
  }

  if (params.since !== undefined && (window as { since?: unknown }).since !== params.since) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: requested since=${params.since} but the scan window reports since=` +
        `${JSON.stringify((window as { since?: unknown }).since)}. This deployment ignored the window bound and ` +
        `scanned a different set of runs, so these reasons do not answer the question that was asked. ` +
        `Refusing to return an unrequested window as though it were the requested one.`
    )
  }

  for (const reason of report.provenReasons ?? []) {
    assertFindingsSegregated([reason.exemplar], [], [], `${context} provenReasons[${reason.reasonKey}]`)
    if (reason.certainty !== 'proven') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a grouped reason in \`provenReasons\` declares certainty ${JSON.stringify(reason.certainty)}.`
      )
    }
  }
  for (const reason of report.speculativeReasons ?? []) {
    assertFindingsSegregated([], [reason.exemplar], [], `${context} speculativeReasons[${reason.reasonKey}]`)
    if (reason.certainty !== 'speculative') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a grouped reason in \`speculativeReasons\` declares certainty ${JSON.stringify(reason.certainty)}.`
      )
    }
  }
  for (const reason of report.indeterminateReasons ?? []) {
    assertFindingsSegregated([], [], [reason.exemplar], `${context} indeterminateReasons[${reason.reasonKey}]`)
    if (reason.certainty !== 'indeterminate') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a grouped reason in \`indeterminateReasons\` declares certainty ${JSON.stringify(reason.certainty)}.`
      )
    }
  }

  assertVerdictConsistent(report.verdict, fleetDivergenceVerdict(report), context)
}

/** Shared by both reports: the target version echo is the ignored-parameter tell. */
function assertEchoedTarget(report: { targetVersionId?: unknown }, requested: string, context: string): void {
  if (report.targetVersionId !== requested) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: asked about targetVersionId=${JSON.stringify(requested)} but the report describes ` +
        `${JSON.stringify(report.targetVersionId ?? null)}. This deployment ignored the parameter (an older ` +
        `deployment silently drops an unknown query parameter and answers about the run's own version, against ` +
        `which every recorded run is trivially compatible). Refusing to return an answer about a different ` +
        `version as though it were about the one you named.`
    )
  }
}

/**
 * Re-check contracts' compile-time proven/speculative segregation on the WIRE.
 *
 * See {@link assertDivergenceReportTrustworthy} point 3 for why a runtime copy
 * of a type-level guarantee is not redundant here.
 */
function assertFindingsSegregated(
  proven: readonly unknown[],
  speculative: readonly unknown[],
  indeterminate: readonly unknown[],
  context: string
): void {
  if (!Array.isArray(proven) || !Array.isArray(speculative) || !Array.isArray(indeterminate)) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the report's findings were not arrays. An absent \`proven\` list reads as "nothing proven", ` +
        `and an absent \`indeterminate\` list reads as "nothing went unanswered" — both are wrong in the one ` +
        `direction that authorises a deploy. Refusing.`
    )
  }

  for (const finding of proven) {
    const f = finding as { certainty?: unknown; provenBy?: unknown }
    if (f?.certainty !== 'proven') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a finding in \`proven\` declares certainty ${JSON.stringify(f?.certainty)}. A speculative ` +
          `finding served in the proven list would be rendered as evidence that a run could not have happened — ` +
          `the exact conflation the divergence contract is built to make impossible. Refusing.`
      )
    }
    if (!Array.isArray(f.provenBy) || f.provenBy.length === 0) {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a finding in \`proven\` carries no \`provenBy\` evidence. A proven divergence that cannot ` +
          `cite the recorded event it contradicts is not proven. Refusing to present it as such.`
      )
    }
  }

  for (const finding of speculative) {
    const f = finding as { certainty?: unknown; speculativeBecause?: unknown }
    if (f?.certainty !== 'speculative') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a finding in \`speculative\` declares certainty ${JSON.stringify(f?.certainty)}.`
      )
    }
    if (typeof f.speculativeBecause !== 'string' || f.speculativeBecause.length === 0) {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a finding in \`speculative\` does not state why it is unprovable (\`speculativeBecause\`). ` +
          `An unexplained speculative finding is indistinguishable from a proven one at a glance. Refusing.`
      )
    }
  }

  for (const finding of indeterminate) {
    const f = finding as { certainty?: unknown; unknownBecause?: unknown }
    if (f?.certainty !== 'indeterminate') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a finding in \`indeterminate\` declares certainty ${JSON.stringify(f?.certainty)}. An ` +
          `unanswered question filed as speculative reads as "we checked, and it is only a maybe" — the false ` +
          `clean this band exists to prevent. Refusing.`
      )
    }
    if (typeof f.unknownBecause !== 'string' || f.unknownBecause.length === 0) {
      throw new V1ApiError(
        'invalid_response',
        `${context}: a finding in \`indeterminate\` does not state what stopped the analysis ` +
          `(\`unknownBecause\`). An unexplained "unknown" is indistinguishable from laziness and gets ignored. Refusing.`
      )
    }
  }
}

/** A verdict that disagrees with the contents it summarises makes every other field suspect. */
function assertVerdictConsistent(served: unknown, computed: string, context: string): void {
  if (served === computed) return
  throw new V1ApiError(
    'invalid_response',
    `${context}: the server reported verdict ${JSON.stringify(served)}, but this report's own contents imply ` +
      `${JSON.stringify(computed)} (contracts' computeDivergenceVerdict is the single rule). A verdict that ` +
      `contradicts the findings it summarises cannot be used to gate a deploy, and neither can the rest of the ` +
      `response. Refusing.`
  )
}

// ---------------------------------------------------------------------------
// GET /api/v1/fleet/health
//
// "What is wrong across everything, and what is it that is actually wrong?" —
// the org-wide altitude. Report types are contracts'
// (`packages/contracts/src/fleet_health.ts`); the engine is Team A's.
//
// SERVER SUPPORT: the route does not exist yet at the time of writing. The
// method is written against the exact contract shape, so wiring the route
// should require no SDK change. Until then, calling it surfaces a
// `V1ApiError` with `kind: 'not_found'`.
// ---------------------------------------------------------------------------

/** Parameters for {@link FlightReader.getFleetHealth}. */
export interface FleetHealthParams {
  /**
   * Lower bound (inclusive) on the observation window, epoch ms. REQUIRED —
   * there is deliberately no implicit "last 24 hours". A monitoring loop whose
   * window is implicit changes meaning the day a server default is retuned,
   * and the change is invisible in the alert it produces.
   */
  since: number
  /** Upper bound (inclusive), epoch ms. REQUIRED, same reasoning. Echoed and verified. */
  until: number
  /**
   * Width, in ms, inside which failures on different agents count as
   * coincident. REQUIRED, echoed, and VERIFIED — see
   * {@link assertFleetHealthReportTrustworthy} point 2. A server that drops it
   * answers about a different window than the one asked about, and the answer
   * is a burst that may be a whole day of unrelated failures.
   */
  burstWindowMs: number
  /** Max agents in this roster page. Server-capped; hitting the cap sets `scan.scanTruncated`. */
  limit?: number
  /**
   * Continue a previous roster page.
   *
   * THERE IS NO MERGE HELPER, ON PURPOSE. Cross-agent correlation does not
   * compose across pages — see `CorrelationBasis` in contracts. Paging is for
   * seeing the whole ROSTER; a report whose `scan.correlationBasis` is
   * `page_local` can never be complete however many pages are fetched.
   */
  cursor?: string
}

/** Response shape for `GET /api/v1/fleet/health`. */
export interface V1FleetHealthData {
  report: FleetHealthReport
}

/**
 * Refuse a fleet health report that cannot be trusted at 3am.
 *
 * SAME POSTURE AS {@link assertDivergenceReportTrustworthy}, ONE ALTITUDE UP,
 * AND WITH HIGHER STAKES. A divergence report is read before a deploy by
 * someone with time to think. This one is read during an incident by someone
 * deciding what to roll back. Every check below is one where the wrong answer
 * looks exactly like the right one to a caller reading
 * `report.correlations.length === 0` or reading the top hypothesis aloud.
 *
 * 1. MISSING `scan`. `correlations: []` means "nothing is wrong across the
 *    fleet" or "we looked at nothing", and the scan record is the only thing
 *    that distinguishes them. A report without it is not a weaker answer; it
 *    is an unreadable one.
 *
 * 2. IGNORED WINDOW PARAMETERS (`since` / `until` / `burstWindowMs`). This is
 *    the ignored-parameter tell, the same lie {@link
 *    FlightReader.getRunEventWindow} catches on `fromSequence` and
 *    {@link assertFleetDivergenceReportTrustworthy} catches on `since`. The
 *    burst width is the dangerous one: a deployment that predates the
 *    parameter drops it and correlates over its own — typically far wider —
 *    default, so a "burst" it reports may be a day of ordinary background
 *    failure rendered as four minutes of one incident. That is a confidently
 *    worded wrong answer, produced at the exact moment someone is looking for
 *    permission to roll something back. Absent is as fatal as mismatched:
 *    absence proves nothing was honored either.
 *
 * 3. CONTENTS THAT ARE NOT USABLE AT ALL. Checked FIRST, because every check
 *    after it does arithmetic. A field being PRESENT is not the same as its
 *    contents being something arithmetic can be done with, and a guard written
 *    as a comparison (`x <= 0`, `if (x.truncated)`) does not reject a
 *    non-number — it silently takes the other branch, and whether that branch
 *    is the safe one is luck. That produced a base-rate measurement whose
 *    counts arrived as the STRINGS `'0'` and `'188'` and returned
 *    `discriminating`, and one whose `measurementTruncated` flag was simply
 *    DROPPED and so compared floors as totals — both promoting a guess to
 *    "read this first" from unvalidated wire data. Contracts'
 *    `fleetReportUnusableFields` asks the question directly, once, for every
 *    field that feeds a verdict, a gate or the ranking.
 *
 * 4. NUMBERS THAT DO NOT AGREE WITH EACH OTHER. This is a CLASS, not a check,
 *    and naming it is what closed four separate holes: verifying that a field
 *    is PRESENT and internally well-formed is not the same as verifying that
 *    the numbers it carries agree with the other numbers in the same report.
 *    Point 2 above confirms the server HONOURED `burstWindowMs`; it says
 *    nothing about whether the burst it returned actually FITS that width, and
 *    a "burst" echoing four minutes while spanning twenty-four hours passed
 *    every check this class was added to catch. Likewise `agentCount` — the
 *    number that decides what an operator reads first — was never compared to
 *    the agents listed or cited. All of it is decidable from the report's own
 *    contents at no extra request, and contracts'
 *    `fleetReportIncoherences` is the single enumeration of it.
 *
 * 5. A HYPOTHESIS SERVED AS AN OBSERVATION, or vice versa. The type system
 *    makes this impossible in OUR code (contracts' three certainty bands are
 *    mutually unassignable by construction). It cannot make it impossible in a
 *    JSON body: TypeScript's guarantee stops at the wire. So the segregation is
 *    re-checked here, before any caller can render a guess as a fact. An
 *    observation with an empty `observedBy` is the same defect in its purest
 *    form.
 *
 * 6. AN ORPHAN HYPOTHESIS — one resting on a `correlationKey` this report does
 *    not contain. On a dashboard a free-floating "model m-4 may be degrading"
 *    is pixel-identical to one backed by twelve cited occurrences. Refusing
 *    the response is the only place that difference can still be enforced.
 *
 * 7. A HYPOTHESIS WITH NO DENOMINATOR SHAPE. `sharedBy` is required by the
 *    contract; a wire body can omit it, and a hypothesis without a base rate
 *    is exactly the "all 12 failing agents use m-4" statement that reads as
 *    damning when 198 of 200 agents use m-4.
 *
 * 8. A `verdict` THAT CONTRADICTS THE REPORT'S OWN CONTENTS.
 *
 * NOT CHECKED, deliberately: `scanTruncated`, a `page_local`
 * `correlationBasis`, `nextCursor`, unmeasured base rates. Those are the
 * server TELLING THE TRUTH in a field, and the correct response is a verdict of
 * `indeterminate` — which the contract already produces — plus a gate that
 * declines to pass it. That decision belongs to the gate; `afr fleet` makes it
 * (exit 11).
 */
function assertFleetHealthReportTrustworthy(report: FleetHealthReport, params: FleetHealthParams): void {
  const context = 'getFleetHealth'

  const scan = (report as { scan?: unknown }).scan
  if (
    scan === null ||
    typeof scan !== 'object' ||
    typeof (scan as { scanTruncated?: unknown }).scanTruncated !== 'boolean' ||
    typeof (scan as { agentsAssessed?: unknown }).agentsAssessed !== 'number' ||
    typeof (scan as { correlationBasis?: unknown }).correlationBasis !== 'string'
  ) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the report carried no usable \`scan\`. Without it there is no way to tell a sweep that ` +
        `assessed the whole roster from one that assessed nothing, and "no correlations found" would read as a ` +
        `fleet-wide all-clear. Refusing to report an unmeasured fleet as healthy.`
    )
  }

  assertEchoedWindow(scan as Record<string, unknown>, 'since', params.since, context)
  assertEchoedWindow(scan as Record<string, unknown>, 'until', params.until, context)
  assertEchoedWindow(scan as Record<string, unknown>, 'burstWindowMs', params.burstWindowMs, context)

  if (!Array.isArray(report.correlations) || !Array.isArray(report.hypotheses) || !Array.isArray(report.unanswered)) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the report's findings were not arrays. An absent \`correlations\` list reads as "nothing is ` +
        `wrong across the fleet", and an absent \`unanswered\` list reads as "nothing went unchecked" — both ` +
        `wrong in the one direction that ends an incident investigation early. Refusing.`
    )
  }

  for (const correlation of report.correlations) {
    const c = correlation as { certainty?: unknown; observedBy?: unknown; correlationKey?: unknown }
    if (c?.certainty !== 'observed') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: an entry in \`correlations\` declares certainty ${JSON.stringify(c?.certainty)}. A hypothesis ` +
          `served in the observed list would be rendered as something that demonstrably happened across the ` +
          `fleet — the exact conflation this contract is built to make impossible, and the one that gets a ` +
          `healthy dependency rolled back. Refusing.`
      )
    }
    if (!Array.isArray(c.observedBy) || c.observedBy.length === 0) {
      throw new V1ApiError(
        'invalid_response',
        `${context}: the correlation ${JSON.stringify(c.correlationKey)} cites no evidence (\`observedBy\`). An ` +
          `observed co-occurrence that cannot cite the recorded failures it is made of is not an observation. Refusing.`
      )
    }
  }

  for (const hypothesis of report.hypotheses) {
    const h = hypothesis as {
      certainty?: unknown
      kind?: unknown
      restingOn?: unknown
      sharedBy?: unknown
      hypothesisKey?: unknown
    }
    if (h?.certainty !== 'hypothesis') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: an entry in \`hypotheses\` declares certainty ${JSON.stringify(h?.certainty)}. An observation ` +
          `filed as a hypothesis buries a fact among the guesses; a guess filed as an observation is worse. Refusing.`
      )
    }
    if (!Array.isArray(h.restingOn) || h.restingOn.length === 0) {
      throw new V1ApiError(
        'invalid_response',
        `${context}: the hypothesis ${JSON.stringify(h.hypothesisKey)} rests on no observation. A free-floating ` +
          `explanation renders identically to one backed by twelve cited occurrences, and nothing on the screen ` +
          `tells them apart. Refusing.`
      )
    }
    // THE MOOD OF THE SENTENCE IS A PROPERTY OF THE TYPE, AND THE WIRE MUST
    // NOT REOPEN IT. Contracts removed the free-prose headline so that
    // `hypothesisQuestion()` composes an always-interrogative sentence from
    // `kind` + `sharedValue` — an engine can no longer write "model m-4 is
    // failing", which is a compiling, contract-valid hypothesis that reads as
    // a finding no matter what chrome surrounds it. A JSON body can still
    // carry an extra prose field and tempt a consumer into rendering it, so
    // the absence is checked here, at the one layer every consumer passes
    // through (the CLI, the MCP tool and any SDK caller get the raw object;
    // only the web surface had a local defence).
    for (const banned of ['candidateExplanation', 'message', 'summary', 'title', 'description', 'headline']) {
      if (banned in (hypothesis as unknown as Record<string, unknown>)) {
        throw new V1ApiError(
          'invalid_response',
          `${context}: the hypothesis ${JSON.stringify(h.hypothesisKey)} carries a prose headline ` +
            `(\`${banned}\`). A hypothesis has no headline field: its sentence is COMPOSED by contracts' ` +
            `hypothesisQuestion() from \`kind\` and \`sharedValue\`, so it is always a question. A transmitted ` +
            `sentence is the one route left by which an engine — rather than a forgetful consumer — turns a ` +
            `guess into a finding, and during an incident that sentence is what someone acts on. Refusing.`
        )
      }
    }
    if (
      (SHARED_ATTRIBUTE_HYPOTHESIS_KINDS as readonly unknown[]).includes(h.kind) &&
      typeof (hypothesis as { sharedValue?: unknown }).sharedValue !== 'string'
    ) {
      throw new V1ApiError(
        'invalid_response',
        `${context}: the hypothesis ${JSON.stringify(h.hypothesisKey)} is about a shared attribute but names no ` +
          `\`sharedValue\`. It would compose to "Could the shared model explain this?" — a question about nothing ` +
          `in particular, spending the one line an operator will read. Refusing.`
      )
    }
    if (h.sharedBy === null || typeof h.sharedBy !== 'object') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: the hypothesis ${JSON.stringify(h.hypothesisKey)} carries no base-rate measurement ` +
          `(\`sharedBy\`). "All 12 failing agents use model m-4" is not evidence when 198 of the org's 200 agents ` +
          `use model m-4, and the denominator is the only thing that separates those two readings. Refusing.`
      )
    }
  }

  // USABILITY BEFORE ANY ARITHMETIC. Everything below this line — the
  // coherence sweep, the completeness predicates, the verdict recomputation —
  // computes with these numbers, and arithmetic on a string or a NaN does not
  // throw, it quietly produces an answer. This is the check that makes the
  // others mean anything. It runs AFTER the structural checks above so that a
  // conflated finding is reported as the conflation it is, rather than as the
  // missing-field symptom of one — an operator debugging a bad deployment
  // needs the cause, and "hypotheses[h1].sharedBy (unusable_measurement)" is a
  // worse answer than "a hypothesis was served in the observed list".
  const unusable = fleetReportUnusableFields(report)
  if (unusable.length > 0) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the report carries fields whose contents cannot be used — ` +
        unusable.map((f) => `${f.path} (${f.reason})`).join('; ') +
        `. A field being present is not the same as its contents being a number: a base rate whose counts arrive ` +
        `as strings compares as though it were measured, and a dropped truncation flag reads as "not truncated" ` +
        `and compares floors as totals. Both promote a guess to the top of an incident screen from data nothing ` +
        `vouched for. Refusing.`
    )
  }

  // The whole cross-field arithmetic sweep, checked against the SCAN — which
  // is the half `isCorrelationSelfConsistent` structurally cannot see, and
  // therefore the half where the burst-span lie lives.
  const incoherences = fleetReportIncoherences(report)
  if (incoherences.length > 0) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the report's own numbers contradict each other — ` +
        incoherences.map((f) => `${f.correlationKey}: ${f.incoherence}`).join('; ') +
        `. A correlation whose declared span is wider than the burst width it was computed under is a day of ` +
        `ordinary background failure wearing an incident's clothes; one whose claimed breadth exceeds the agents ` +
        `it lists or cites is an unvalidated number deciding what gets read first at 3am. Both are wrong in the ` +
        `direction that gets something rolled back. Refusing.`
    )
  }

  const orphans = orphanHypotheses(report)
  if (orphans.length > 0) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: ${orphans.length} hypothes${orphans.length === 1 ? 'is rests' : 'es rest'} on correlation ` +
        `key(s) [${orphans.flatMap((h) => h.restingOn).join(', ')}] that this report does not contain. An ` +
        `explanation whose observation is missing cannot be checked by the person reading it. Refusing.`
    )
  }

  assertVerdictConsistent(report.verdict, fleetHealthReportVerdict(report), context)
}

/** The window echo is the ignored-parameter tell — see {@link assertFleetHealthReportTrustworthy} point 2. */
function assertEchoedWindow(scan: Record<string, unknown>, field: string, requested: number, context: string): void {
  if (scan[field] === requested) return
  throw new V1ApiError(
    'invalid_response',
    `${context}: asked for ${field}=${requested} but the scan reports ${JSON.stringify(scan[field] ?? null)}. This ` +
      `deployment ignored the parameter (an older deployment silently drops an unknown query parameter and ` +
      `answers over its own default window), so this report describes a different question than the one asked. ` +
      `A burst measured over the wrong width is ordinary background failure rendered as one incident. Refusing.`
  )
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/:id/causality
//
// "What caused this, and what did it break?" — the cross-run altitude.
// Traversal types are contracts' (`packages/contracts/src/causality.ts`); the
// engine is Team A's.
//
// SERVER SUPPORT: the route does not exist yet at the time of writing. The
// method is written against the exact contract shape, so wiring the route
// should require no SDK change. Until then, calling it surfaces a
// `V1ApiError` with `kind: 'not_found'`.
// ---------------------------------------------------------------------------

/** Parameters for {@link FlightReader.getCausalTrace}. */
export interface CausalTraceParams<D extends CausalDirection = CausalDirection> {
  /** The run to trace from. */
  runId: string
  /**
   * Which way to walk. REQUIRED — there is deliberately no default. "What
   * caused this" and "what did this break" are opposite questions with opposite
   * operational consequences, and a default would let a monitoring loop change
   * which one it asks the day a server is retuned.
   *
   * ---------------------------------------------------------------------
   * TYPED `D`, NOT `CausalDirection`, AND THIS IS THE TOKEN THE WHOLE
   * PLACEMENT RESTS ON
   * ---------------------------------------------------------------------
   *
   * Passing the literal `'component'` narrows the returned traversal to one
   * whose frontiers cannot be origins (contracts' `ComponentTerminus`): a
   * component walk closed both sides, so "nothing produced this" is a claim it
   * structurally cannot establish.
   *
   * IT WAS WRITTEN AS `CausalDirection`, WHICH MADE `D` PHANTOM. Nothing in the
   * parameter object mentioned `D`, so `getCausalTrace<D>` had no site to infer
   * from; `D` fell back to its default, and `TerminusFor<CausalDirection>`
   * widens to the full `ChainTerminus` — origin included. The barrier existed
   * and was never reached. It also left this legal:
   *
   *   getCausalTrace<'upstream'>({ direction: 'component', ... })
   *
   * which is the origin/component conflation spelled out in full, returning a
   * traversal whose termini include `RecordedOrigin`. With `D` here, the literal
   * flows from the argument and that call no longer typechecks.
   *
   * `tests/unit/causal_reader_honesty.test.ts` pins the INFERENCE path
   * specifically. The earlier proof did not: it read `.originRunId` off the
   * result under `@ts-expect-error`, which errors on the ordinary three-band
   * union whether or not `D` infers — a proof that passes whether or not the
   * mechanism works.
   */
  direction: D
  /**
   * Hop ceiling. REQUIRED, echoed, and VERIFIED. A server that drops it walks to
   * its own — typically much shallower — default and reports a
   * `depth_limit_reached` at a depth nobody chose, which is indistinguishable
   * from an honest bounded answer.
   */
  maxDepth: number
  /** Max nodes in this page. Server-capped; hitting the cap sets `scan.scanTruncated`. */
  limit?: number
  /**
   * Continue a previous node page.
   *
   * THERE IS NO MERGE HELPER, ON PURPOSE. Paging is for listing the NODES of a
   * graph the engine already walked whole; it is not a way to assemble a
   * traversal out of fragments. An outstanding cursor keeps the traversal
   * incomplete however many pages are fetched.
   */
  cursor?: string
}

/** Response shape for `GET /api/v1/runs/:id/causality`. */
export interface V1CausalTraceData<D extends CausalDirection = CausalDirection> {
  traversal: CausalTraversal<D>
}

/** Prose fields a {@link SuspectedLink} must never carry. See ground 7. */
const BANNED_SUSPICION_HEADLINES = [
  'message',
  'summary',
  'title',
  'description',
  'headline',
  'explanation',
  'causedBy',
] as const

/** Direction fields a {@link SuspectedLink} must never carry. See ground 6. */
const BANNED_SUSPICION_DIRECTION_FIELDS = [
  'producerRunId',
  'consumerRunId',
  'fromRunId',
  'toRunId',
  'causeRunId',
  'effectRunId',
] as const

/**
 * Refuse a causal traversal that cannot be trusted.
 *
 * SAME POSTURE AS {@link assertFleetHealthReportTrustworthy}, applied to a
 * different and in one respect sharper danger. A fleet report can put a wrong
 * hypothesis at the top of a screen; a causal traversal draws ARROWS, and an
 * arrow is the most persuasive object this product can produce. Nobody reads a
 * confidence badge next to an arrow — they follow it, read the run it lands on,
 * and act.
 *
 * ELEVEN GROUNDS. The first five are the fleet gate's, restated for this shape,
 * because the failures they catch are shape-independent. The last five are new,
 * and four of them exist because of invariants the type system enforces in OUR
 * code and cannot enforce on a JSON body.
 *
 * 1. MISSING `scan`. `edges: []` means "this run is an island" or "we walked
 *    nothing", and the scan record is the only thing that distinguishes them. A
 *    traversal without it is not a weaker answer; it is an unreadable one.
 *
 * 2. IGNORED PARAMETERS (`subjectRunId` / `direction` / `maxDepthRequested`).
 *    The ignored-parameter tell. `direction` is the one that has no analogue
 *    anywhere else in this client: a deployment that silently walks upstream
 *    when asked to walk downstream returns a perfectly well-formed answer to the
 *    OPPOSITE question — "here is what caused it" rendered under a heading that
 *    says "here is what it broke". Absent is as fatal as mismatched.
 *
 * 3. CONTENTS THAT ARE NOT USABLE AT ALL. Checked before any arithmetic, for
 *    the reason written up in contracts: a guard written as a comparison does
 *    not reject a non-number, it takes the other branch, and whether that branch
 *    is safe is luck.
 *
 * 4. CONTENTS THAT DO NOT AGREE WITH EACH OTHER — a self-loop, an arrow to a run
 *    the traversal never reached, or (the serious one) an edge whose cited
 *    record was written in NEITHER of its endpoints. That last is exactly what
 *    an inference engine produces when it dresses a correlation up as a record:
 *    a third-party row that mentions both runs and establishes nothing.
 *
 * 5. A SUSPECTED LINK SERVED AS A RECORDED EDGE, or vice versa. The type system
 *    makes this impossible in our code; TypeScript's guarantee stops at the
 *    wire. An edge with an empty `recordedBy` is the same defect in its purest
 *    form — an arrow with nothing behind it.
 *
 * 6. A SUSPECTED LINK CARRYING A DIRECTION. NEW, AND THE CENTRAL ONE FOR THIS
 *    FEATURE'S FIRST INVARIANT. Contracts gives `SuspectedLink` no from/to field
 *    of any name, so a coincidence is not merely marked unwalkable, it is
 *    unwalkable. A JSON body can add `fromRunId` back, and a consumer reading
 *    raw objects would then have everything it needs to draw the arrow. The
 *    absence is therefore re-checked here, at the one layer every consumer
 *    passes through.
 *
 * 7. A SUSPECTED LINK CARRYING A PROSE HEADLINE. Its sentence is COMPOSED by
 *    contracts' `suspicionQuestion()` from `kind` and `sharedValue`, so it is
 *    always a question and never directional. A transmitted sentence is the one
 *    route by which an ENGINE — rather than a forgetful consumer — turns "these
 *    ran close together" into "run_a caused run_b".
 *
 * 8. AN UNPROVEN ORIGIN. THE GROUND THIS WHOLE FEATURE TURNS ON. "The origin is
 *    run X" and "we lost the trail at run X" are opposite claims about the same
 *    run id: the first ends an investigation, the second says it is unfinished,
 *    and the second is the more common case in production because the SDK may
 *    simply not have recorded the edge. Contracts makes an unproven origin
 *    UNSPELLABLE — `OriginProof.inboundReadComplete` is the literal type `true`
 *    and `inboundEdgesFound` the literal type `0`, so a truncated or non-empty
 *    read cannot be typed as an origin. A wire body has no such constraint, and
 *    a `terminus: 'recorded_origin'` with no proof behind it is a LOST TRAIL
 *    WEARING AN ORIGIN'S CLOTHES — the single output that tells an operator to
 *    stop looking. Contracts' `traversalUnusableFields` reports it as
 *    `unproven_origin`; ground 3 is what makes this one bite.
 *
 *    THE SAME APPLIES TO THE OTHER COMPLETE DISPOSITION. A `cycle_reentry` also
 *    terminates a frontier cleanly and also lets a trace exit 0, and it is the
 *    EASIER forgery — a `trail_lost` an engine cannot be bothered to explain is
 *    one relabel away from "oh, it looped". So its `cyclePath` must be a closed
 *    loop naming the run it claims to re-enter, reported as `unclosed_cycle`.
 *
 * 9. AN EMPTY `termini`. NEW, AND IT IS A VACUITY, WHICH IS WHY IT NEEDS ITS OWN
 *    GROUND RATHER THAN FALLING OUT OF GROUND 8. The natural completeness check
 *    — "did every frontier reach an origin?" — is `termini.every(...)`, and
 *    `.every()` OVER AN EMPTY ARRAY IS TRUE. A server returning no frontiers at
 *    all would therefore read as a fully-traced graph to the most obvious code
 *    anyone would write. Contracts' `isCausalTraversalComplete` has the
 *    positive clause; this refuses the response outright, because a walk that
 *    reports stopping nowhere did not happen.
 *
 * 10. A CLAIM THE TRAVERSAL'S OWN EDGE SET REFUTES. NEW, AND IT IS A CLASS
 *     RATHER THAN A CHECK — the same class this codebase has now met three
 *     times: verifying that a claim is PRESENT and INTERNALLY WELL-FORMED is not
 *     verifying that it AGREES WITH THE DATA BESIDE IT. Four holes came from it
 *     here, every one decidable from the edges already in hand and every one
 *     producing `complete: true`:
 *
 *       - an origin whose proof asserts an empty adjacency set WHILE THE SAME
 *         TRAVERSAL CARRIES AN EDGE INTO THAT RUN (a lost trail certifying as an
 *         origin — the exact distinction this feature exists to preserve,
 *         defeated by a self-reported claim nobody audited);
 *       - a cycle of length >= 2, invisible to every per-edge rule because only
 *         a self-loop is decidable from a SINGLE edge;
 *       - a `cyclePath` naming hops that are not recorded edges, buying an
 *         all-clear from a COMPLETING disposition;
 *       - an edge citing nothing at all, which graded BETTER than an edge with
 *         one bad citation.
 *
 *     Contracts' `traversalClaimContradictions` is the single enumeration, and
 *     it is driven by a TOTAL table over the claim kinds so a new claim cannot
 *     ship unaudited. This gate calls it rather than re-implementing an
 *     emptiness check of its own — three layers each had one, all three caught
 *     the empty-citation case, and the redundancy is precisely what hid the hole
 *     in the shared primitive underneath them.
 *
 * 11. A `verdict` THAT CONTRADICTS THE TRAVERSAL'S OWN CONTENTS.
 *
 * (The count in this list has outgrown its heading twice. It is eleven grounds,
 * and the number is not the point — the ordering is: structure, then usability,
 * then arithmetic, then claims against data, then the verdict.)
 *
 * NOT CHECKED, deliberately: `scanTruncated`, `edgeSetsComplete: false`,
 * `nextCursor`, and a `trail_lost` terminus. Those are the server TELLING THE
 * TRUTH in a field, and the correct response is a verdict of `indeterminate` —
 * which the contract already produces — plus a gate that declines to call it a
 * finished trace. That decision belongs to the gate; `afr cause` makes it
 * (exit 11).
 */
function assertCausalTraversalTrustworthy(traversal: CausalTraversal, params: CausalTraceParams<CausalDirection>): void {
  const context = 'getCausalTrace'

  const scan = (traversal as { scan?: unknown })?.scan
  if (
    scan === null ||
    typeof scan !== 'object' ||
    typeof (scan as { scanTruncated?: unknown }).scanTruncated !== 'boolean' ||
    typeof (scan as { runsVisited?: unknown }).runsVisited !== 'number' ||
    typeof (scan as { edgeSetsComplete?: unknown }).edgeSetsComplete !== 'boolean'
  ) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the traversal carried no usable \`scan\`. Without it there is no way to tell a walk that ` +
        `reached every frontier from one that walked nothing, and "no edges found" would read as "this run has no ` +
        `causal neighbours". Refusing to report an unwalked graph as an island.`
    )
  }

  const record = scan as Record<string, unknown>
  assertEchoedParam(record, 'subjectRunId', params.runId, context)
  assertEchoedParam(record, 'direction', params.direction, context)
  assertEchoedParam(record, 'maxDepthRequested', params.maxDepth, context)

  if (
    !Array.isArray(traversal.edges) ||
    !Array.isArray(traversal.termini) ||
    !Array.isArray(traversal.suspected) ||
    !Array.isArray(traversal.unanswered)
  ) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the traversal's collections were not arrays. An absent \`edges\` list reads as "this run is an ` +
        `island", an absent \`termini\` list reads as "the walk finished", and an absent \`unanswered\` list reads ` +
        `as "nothing went unchecked" — all three wrong in the one direction that ends an investigation early. ` +
        `Refusing.`
    )
  }

  // GROUND 9, AND IT IS CHECKED BEFORE ANYTHING ELSE READS `termini`. An empty
  // frontier set satisfies `every(...)` by vacuity, so the most natural
  // completeness check anyone writes would read "the walk stopped nowhere" as
  // "the walk finished everywhere".
  if (traversal.termini.length === 0) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the traversal reports NO termini. A walk always stops somewhere — at an established origin or ` +
        `at a lost trail — and an empty frontier list is not a walk that finished, it is a walk that did not say. ` +
        `It is also the shape that defeats the obvious check: \`termini.every(t => t.terminus === ` +
        `'recorded_origin')\` is TRUE on an empty array, so this would read as a fully-traced graph. Refusing.`
    )
  }

  for (const edge of traversal.edges) {
    const e = edge as { basis?: unknown; recordedBy?: unknown; edgeKey?: unknown }
    if (e?.basis !== 'recorded') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: an entry in \`edges\` declares basis ${JSON.stringify(e?.basis)}. A suspected link served in ` +
          `the edge list would be WALKED and DRAWN AS AN ARROW — the exact conflation this contract is built to ` +
          `make impossible. Two runs adjacent in time, sharing a session, or touching the same resource are not ` +
          `thereby causally linked, and an operator follows an arrow to a run and acts on it. Refusing.`
      )
    }
    if (!Array.isArray(e.recordedBy) || e.recordedBy.length === 0) {
      throw new V1ApiError(
        'invalid_response',
        `${context}: the edge ${JSON.stringify(e.edgeKey)} cites no record (\`recordedBy\`). A causal edge is ` +
          `RECORDED, never inferred: an edge that cannot cite the event, artifact or run field that captured the ` +
          `handoff is an inference wearing an edge's clothes. Refusing.`
      )
    }
  }

  for (const link of traversal.suspected) {
    const l = link as { basis?: unknown; linkKey?: unknown }
    if (l?.basis !== 'suspected') {
      throw new V1ApiError(
        'invalid_response',
        `${context}: an entry in \`suspected\` declares basis ${JSON.stringify(l?.basis)}. A recorded edge filed ` +
          `as a suspicion buries a fact among the guesses; a guess filed as an edge is worse. Refusing.`
      )
    }
    const raw = link as unknown as Record<string, unknown>
    // GROUND 6. Contracts gives a suspicion no direction, which is what makes
    // it unwalkable rather than merely marked-do-not-walk. The wire can put one
    // back, and then a consumer reading raw objects has everything it needs to
    // draw the arrow.
    for (const banned of BANNED_SUSPICION_DIRECTION_FIELDS) {
      if (banned in raw) {
        throw new V1ApiError(
          'invalid_response',
          `${context}: the suspected link ${JSON.stringify(l.linkKey)} carries a DIRECTION (\`${banned}\`). A ` +
            `suspicion has no direction in this contract, and that is not an oversight: "these two runs are ` +
            `related" is sometimes computable, "this one caused that one" never is. A directed coincidence is ` +
            `walkable and drawable, and it is indistinguishable on screen from a recorded handoff. Refusing.`
        )
      }
    }
    // GROUND 7.
    for (const banned of BANNED_SUSPICION_HEADLINES) {
      if (banned in raw) {
        throw new V1ApiError(
          'invalid_response',
          `${context}: the suspected link ${JSON.stringify(l.linkKey)} carries a prose headline ` +
            `(\`${banned}\`). A suspicion has no headline field: its sentence is COMPOSED by contracts' ` +
            `suspicionQuestion() from \`kind\` and \`sharedValue\`, so it is always a question and never names one ` +
            `run as the cause of another. A transmitted sentence is the route by which an engine, rather than a ` +
            `forgetful consumer, turns a coincidence into a finding. Refusing.`
        )
      }
    }
  }

  // USABILITY BEFORE ANY ARITHMETIC — and this is also GROUND 8, because
  // `unproven_origin` is reported here. It runs AFTER the structural checks
  // above so that a conflated entry is reported as the conflation it is rather
  // than as the missing-field symptom of one.
  const unusable = traversalUnusableFields(traversal)
  if (unusable.length > 0) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the traversal carries fields whose contents cannot be used — ` +
        unusable.map((f) => `${f.path} (${f.reason})`).join('; ') +
        `. Note \`unproven_origin\` in particular: a terminus claiming \`recorded_origin\` without a complete, ` +
        `empty adjacency read behind it is a LOST TRAIL WEARING AN ORIGIN'S CLOTHES. "The origin is run X" ends ` +
        `an investigation; "we lost the trail at run X" says it is unfinished, and in production the second is ` +
        `the common case because the SDK may never have recorded the edge. Refusing.`
    )
  }

  const incoherences = traversalIncoherences(traversal)
  if (incoherences.length > 0) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the traversal's own contents contradict each other — ` +
        incoherences.map((f) => `${f.edgeKey}: ${f.incoherence}`).join('; ') +
        `. An edge whose cited record was written in NEITHER of its endpoints is a third-party row that mentions ` +
        `both runs and establishes nothing — which is precisely what an inference engine produces when it dresses ` +
        `a correlation up as a record. An arrow to a run the traversal never reached is one nobody can check. ` +
        `Refusing.`
    )
  }

  const contradictions = traversalClaimContradictions(traversal)
  if (contradictions.length > 0) {
    throw new V1ApiError(
      'invalid_response',
      `${context}: the traversal makes claims about its own shape that its own edges refute — ` +
        contradictions.map((f) => `${f.at} (${f.contradiction})`).join('; ') +
        `. A COMPONENT walk claiming an origin asked a direction-free scan a directional question — it closed both ` +
        `sides, so "nothing produced this" is not a claim it can establish; run an upstream walk instead. An ` +
        `origin whose proof says "nothing is adjacent" while an edge into that very run sits in the same ` +
        `response is a LOST TRAIL CERTIFYING AS AN ORIGIN, which is the one output that ends an investigation on ` +
        `the wrong run. An undeclared cycle, a cycle path naming hops that are not recorded edges, and an edge ` +
        `citing nothing at all each certify a finished investigation over data that contradicts it. Refusing.`
    )
  }

  assertVerdictConsistent(traversal.verdict, causalTraversalVerdict(traversal), context)
}

/**
 * The parameter echo is the ignored-parameter tell — see
 * {@link assertCausalTraversalTrustworthy} point 2. Generalised over string and
 * number parameters, because `direction` is a string and dropping it produces
 * a well-formed answer to the opposite question.
 */
function assertEchoedParam(scan: Record<string, unknown>, field: string, requested: unknown, context: string): void {
  if (scan[field] === requested) return
  throw new V1ApiError(
    'invalid_response',
    `${context}: asked for ${field}=${JSON.stringify(requested)} but the scan reports ` +
      `${JSON.stringify(scan[field] ?? null)}. This deployment ignored the parameter (an older deployment silently ` +
      `drops an unknown query parameter and answers over its own default), so this traversal describes a different ` +
      `question than the one asked. Walked the wrong way, it is a perfectly well-formed answer to the OPPOSITE ` +
      `question: "what caused this" rendered under a heading that says "what did this break". Refusing.`
  )
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
   * @param filters - optional `status`/`agentId`/`environment`/`sessionId` filters, `limit`/`cursor`
   *   pagination, and `fields` projection (see {@link ProjectionParams.fields} — `id` always comes
   *   back; omit for the full run).
   * @returns `{ runs, nextCursor }` — pass `nextCursor` back as `cursor` to page.
   * @throws {@link V1ApiError} on any auth/not-found/rate-limit/server/network failure.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if `fields` was requested and the
   *   server ignored it (deployment predates field projection).
   * @throws {RangeError} if `fields` is present but names nothing — a caller bug, before any request.
   */
  async listRuns(filters: ListRunsParams = {}): Promise<V1ListRunsData> {
    const fields = assertWellFormedFields(filters.fields, 'listRuns')
    const data = await fetchV1<V1ListRunsData>(
      this.config,
      '/api/v1/runs',
      {
        status: filters.status,
        agentId: filters.agentId,
        environment: filters.environment,
        sessionId: filters.sessionId,
        limit: filters.limit,
        cursor: filters.cursor,
        ...(fields !== undefined && { fields: fields.join(',') }),
      },
      this.fetchImpl
    )
    assertProjectionHonored(fields, 'runs', data.runs ?? [], 'listRuns', 'GET /api/v1/runs')
    return data
  }

  /**
   * Fetch a single run by id, along with its event and artifact counts.
   *
   * @param runId - the run's id.
   * @param options - optional `fields` projection applied to `run` (see
   *   {@link ProjectionParams.fields} — `id` always comes back; omit for the full run).
   *   `eventCount`/`artifactCount` are computed, not run fields, and are unaffected.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the run does not exist or does not belong to the key's org.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if `fields` was requested and the
   *   server ignored it (deployment predates field projection).
   */
  async getRun(runId: string, options: GetRunParams = {}): Promise<V1GetRunData> {
    const fields = assertWellFormedFields(options.fields, 'getRun')
    const data = await fetchV1<V1GetRunData>(
      this.config,
      `/api/v1/runs/${encodeURIComponent(runId)}`,
      { ...(fields !== undefined && { fields: fields.join(',') }) },
      this.fetchImpl
    )
    assertProjectionHonored(fields, 'runs', [data.run], 'getRun', 'GET /api/v1/runs/:id')
    return data
  }

  /**
   * Fetch one page of a run's event log, in `sequenceNumber` order.
   *
   * @param runId - the run's id.
   * @param options - `limit` (page size), `cursor` (opaque, from a previous page's `nextCursor`),
   *   and `fields` projection (see {@link ProjectionParams.fields} — `id` always comes back; omit
   *   for the full event). Projecting away `payload` is the cheap win here: it is the field that
   *   dominates an event page's size.
   * @returns `{ events, nextCursor }` — `nextCursor` is absent once the last page has been fetched.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if `fields` was requested and the
   *   server ignored it (deployment predates field projection).
   */
  async getRunEvents(runId: string, options: ListEventsParams = {}): Promise<V1ListEventsData> {
    const fields = assertWellFormedFields(options.fields, 'getRunEvents')
    const data = await fetchV1<V1ListEventsData>(
      this.config,
      `/api/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        ...(options.limit !== undefined && { limit: options.limit }),
        ...(options.cursor !== undefined && { cursor: options.cursor }),
        ...(fields !== undefined && { fields: fields.join(',') }),
      },
      this.fetchImpl
    )
    assertProjectionHonored(fields, 'events', data.events ?? [], 'getRunEvents', 'GET /api/v1/runs/:id/events')
    return data
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
   * **Field projection composes with the window** — `fields` narrows each
   * event in it, exactly as on {@link getRunEvents}, and is verified the same
   * way (see {@link ProjectionParams.fields}). One wrinkle, documented on
   * {@link EventWindowParams.fields}: `sequenceNumber` is always requested
   * alongside whatever you name, because the ignored-floor check below reads
   * it — a projection that removed it would silently disarm the very guarantee
   * this method is built around.
   *
   * @param runId - the run's id.
   * @param options - `fromSequence` OR `aroundSequence` (not both), plus `limit` and `fields`.
   * @returns `{ events, fromSequence, nextCursor? }`. An empty `events` means
   *   the run has nothing at or after the floor — not an error.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the run does not
   *   exist or does not belong to the key's org — the two are deliberately
   *   indistinguishable, exactly as on every other method here.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if the server
   *   ignored `fromSequence` (deployment predates windowed reads) or ignored
   *   `fields` (deployment predates field projection).
   * @throws {RangeError} if the arguments are self-contradictory or not
   *   positive integers, or `fields` is present but names nothing — a caller
   *   bug, surfaced before any request is made.
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

    // `sequenceNumber` is forced into the projection: the ignored-floor check
    // below reads it, and a caller who projected it away would silently get
    // that check disabled rather than get a smaller response. Deduped so the
    // wire form does not repeat a field the caller already named.
    const requestedFields = assertWellFormedFields(options.fields, 'getRunEventWindow')
    const fields =
      requestedFields === undefined
        ? undefined
        : requestedFields.includes('sequenceNumber')
          ? requestedFields
          : [...requestedFields, 'sequenceNumber']

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
        ...(fields !== undefined && { fields: fields.join(',') }),
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

    // Second capability check, same principle as the first: an ignored
    // `fields` is a full document wearing a projection's clothes.
    assertProjectionHonored(fields, 'events', events, 'getRunEventWindow', 'GET /api/v1/runs/:id/events')

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
   *   {@link ListFailurePatternsParams.regressed}) plus `limit`/`cursor` pagination
   *   and `fields` projection (see {@link ProjectionParams.fields} — `id` always comes back;
   *   omit for the full pattern). NOTE: the response's `fixConfidence.entries` are keyed by
   *   `fingerprintHash` and are NOT projected — keep `fingerprintHash` in your field list if you
   *   intend to join them back to the patterns they grade.
   * @returns `{ patterns, nextCursor }` — pass `nextCursor` back as `cursor` to page.
   *   Each pattern carries `muted`/`mutedAt` when set (PREVENTION cycle 3),
   *   and `status`/`acknowledgedAt`/`acknowledgedByUserId`/`resolvedAt`/
   *   `resolvedByUserId`/`resolutionNote`/`resolutionRef`/`regressedAt` when
   *   set (Resolution cycle 1, ADR-006) — there is no method on this class to
   *   change mute or lifecycle state; those are admin/member-only,
   *   Clerk-authed, audited writes on the web app, not part of this
   *   key-authed read surface.
   *
   * **Truncated scans are SURFACED, not refused.** The response carries
   * `scanTruncated` / `scannedRows` / `scanRowCeiling` (see
   * {@link V1ListFailurePatternsData.scanTruncated} and
   * {@link isPatternScanComplete}); a filtered request that hits the server's
   * row ceiling can return a short or empty page for that reason alone, and a
   * caller MUST NOT read an empty page as "nothing matched" while
   * `scanTruncated` is `true`.
   *
   * This method deliberately does **not** throw on truncation, which is the
   * opposite of what {@link getRunEventWindow} does for an ignored
   * `fromSequence` and what `assertProjectionHonored` does for an ignored
   * `fields`. Those two refuse because the server returned a WRONG answer
   * indistinguishable from a right one — the head of the log looks exactly
   * like the requested window, a full document looks exactly like a
   * projection that included everything, and there is no field in the
   * response that says otherwise. Truncation is the opposite situation: the
   * server told the truth, in a field, and the only defect was that nothing
   * read it. Throwing would also break the correct remedy — paging on
   * `nextCursor` — by turning a resumable, ordinary state into an exception,
   * and would fail an unfiltered browse where truncation is harmless. So the
   * SDK types it, names it, and hands it to the caller; deciding that an
   * incomplete scan is fatal is the *gate's* job, not the client's. `afr
   * patterns` makes exactly that decision (exit 11) for the CI path.
   *
   * @throws {@link V1ApiError} on any auth/rate-limit/server/network failure.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if `fields` was requested and the
   *   server ignored it (deployment predates field projection).
   */
  async getFailurePatterns(filters: ListFailurePatternsParams = {}): Promise<V1ListFailurePatternsData> {
    const fields = assertWellFormedFields(filters.fields, 'getFailurePatterns')
    const data = await fetchV1<V1ListFailurePatternsData>(
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
        ...(fields !== undefined && { fields: fields.join(',') }),
      },
      this.fetchImpl
    )
    assertProjectionHonored(fields, 'patterns', data.patterns ?? [], 'getFailurePatterns', 'GET /api/v1/patterns')
    return data
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

  /**
   * Would this RECORDED run still have been possible on a different agent
   * version? — the replay-test question, answered structurally, with nothing
   * executed.
   *
   * The report separates what is PROVEN (the run called a tool the target does
   * not declare: it could not have done this) from what is SPECULATIVE (the
   * system prompt changed: behaviour may differ). Those are two different
   * types in contracts, deliberately mutually unassignable, and this method
   * re-checks that separation on the response — see
   * {@link assertDivergenceReportTrustworthy}. Read `report.proven` to gate;
   * read `report.speculative` to think.
   *
   * **Never trusts a clean answer it cannot verify.** A missing
   * `targetVersionId` echo, a missing `coverage` record, a speculative finding
   * smuggled into `proven[]`, or a `verdict` that contradicts the report's own
   * contents each throw rather than resolve. All four have the same shape of
   * consequence: a report that reads as "safe to ship" without having
   * established it. The one thing NOT refused is an honestly-declared
   * incomplete coverage — that already produces a verdict of `indeterminate`,
   * and deciding whether an unfinished analysis blocks a deploy is the gate's
   * call, not the client's.
   *
   * **Server-side status:** `GET /api/v1/runs/:runId/divergence` does not
   * exist yet — the divergence engine lives in `convex/helpers/` and its v1
   * route is not wired. This method is written against the contract shape, so
   * no SDK change should be needed once it is. Calling it today surfaces a
   * {@link V1ApiError} with `kind: 'not_found'`.
   *
   * @param runId - the recorded run to analyse.
   * @param params - `{ targetVersionId }`. Required: there is no implicit
   *   "latest version" subject.
   * @returns `{ report }` — a {@link DivergenceReport}.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the run or the
   *   target version does not exist or does not belong to the key's org — the
   *   two are deliberately indistinguishable, as everywhere else here.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if the response
   *   cannot be trusted with a deploy decision (see above).
   * @throws {RangeError} if `targetVersionId` is empty — a caller bug, before
   *   any request is made.
   */
  async getRunDivergence(runId: string, params: RunDivergenceParams): Promise<V1RunDivergenceData> {
    assertNonEmptyTarget(params.targetVersionId, 'getRunDivergence')
    const data = await fetchV1<V1RunDivergenceData>(
      this.config,
      `/api/v1/runs/${encodeURIComponent(runId)}/divergence`,
      { targetVersionId: params.targetVersionId },
      this.fetchImpl
    )
    assertDivergenceReportTrustworthy(data.report, params.targetVersionId, runId)
    return data
  }

  /**
   * The same question across an agent's recent recorded history: can this
   * version ship at all?
   *
   * **Leads with DISTINCT REASONS, not affected runs.** `provenReasons` is the
   * headline: 340 broken runs with 12 root causes is a tractable morning, 340
   * individual reports is not. `runsWithProvenDivergence` is the scale of the
   * problem; the reasons are the problem.
   *
   * Verified exactly as {@link getRunDivergence} is, plus one check that only
   * a scan needs: an ignored `since` means the server scanned a different set
   * of runs than the one asked about, and the answer — clean or otherwise —
   * belongs to a different question.
   *
   * `window.scanTruncated` / `window.runsUnassessable` /
   * `window.runsSkippedForBudget` / `window.nextCursor` are NOT refused: an
   * incomplete scan is the server telling the truth, and it already forces
   * `verdict: 'indeterminate'`. Gate on that (`afr compat` exits 11), never on
   * an empty reason list alone.
   *
   * **ONE CALL RETURNS ONE PAGE, AND A PAGE IS NOT A FLEET ANSWER.** The scan
   * is a bounded batch — one paginated pass per execution, over runs whose
   * event logs run to `MAX_EVENTS_PER_RUN` — so a `window.nextCursor` means
   * the twelfth reason may be on page four. Continue with `cursor` and merge
   * with `mergeFleetDivergenceReports`; `isFleetScanComplete` counts an
   * outstanding cursor as incomplete precisely so a first page can never read
   * as `compatible`.
   *
   * **Server-side status:** `GET /api/v1/agents/:agentId/divergence` does not
   * exist yet — see {@link getRunDivergence}. Note this would be the first v1
   * endpoint scoped to an agent rather than a run or a pattern.
   *
   * @param agentId - the agent whose recent runs to analyse.
   * @param params - `{ targetVersionId, since?, limit? }`.
   * @returns `{ report }` — a {@link FleetDivergenceReport}.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the agent or target
   *   version is unknown to the key's org.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if the response
   *   cannot be trusted (ignored `targetVersionId`, ignored `since`, missing
   *   `window`, conflated findings, inconsistent verdict).
   * @throws {RangeError} on an empty `targetVersionId` or a non-positive
   *   `limit`/`since`.
   */
  async getAgentDivergence(agentId: string, params: AgentDivergenceParams): Promise<V1AgentDivergenceData> {
    assertNonEmptyTarget(params.targetVersionId, 'getAgentDivergence')
    assertPositiveInteger(params.limit, 'limit', 'getAgentDivergence')
    assertPositiveInteger(params.since, 'since', 'getAgentDivergence')
    const data = await fetchV1<V1AgentDivergenceData>(
      this.config,
      `/api/v1/agents/${encodeURIComponent(agentId)}/divergence`,
      {
        targetVersionId: params.targetVersionId,
        ...(params.since !== undefined && { since: params.since }),
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      },
      this.fetchImpl
    )
    assertFleetDivergenceReportTrustworthy(data.report, params, agentId)
    return data
  }

  /**
   * "What is wrong across everything, and what is it that is actually wrong?"
   * — the org-wide altitude, for an operator running hundreds of agents.
   *
   * Returns a roster of agents with a health state, plus CROSS-AGENT
   * correlations observed inside the window: the same failure fingerprint on N
   * agents, or N agents beginning to fail inside `burstWindowMs` of one
   * another. That second one is what catches a model provider degrading or a
   * shared tool changing shape, because those rarely produce one tidy
   * fingerprint — they produce twelve different ones at once, and every
   * per-agent view in this product shows twelve unrelated problems.
   *
   * **CORRELATION IS NOT CAUSATION, AND THE TYPES ENFORCE IT.**
   * `report.correlations` holds things that DEMONSTRABLY HAPPENED, each citing
   * the recorded failures it is made of. `report.hypotheses` holds proposed
   * READINGS of those — "these twelve all call model `m-4`" — and they are a
   * different, mutually unassignable type with no shared text field, each
   * carrying a required base-rate measurement (how many HEALTHY agents also
   * call `m-4`) and a required test that would refute it. A hypothesis cannot
   * move the verdict, cannot fail a monitoring loop, and cannot be handed to
   * anything expecting an observation. See
   * `packages/contracts/src/fleet_health.ts`.
   *
   * **Never trusts an answer it cannot verify.** An ignored window parameter,
   * a missing `scan` record, a correlation citing evidence outside its own
   * window, a hypothesis in the observed list, a hypothesis with no base rate
   * or no observation under it, or a `verdict` contradicting the report's own
   * contents each throw rather than resolve. The one thing NOT refused is an
   * honestly-declared incomplete scan — that already produces a verdict of
   * `indeterminate`, and deciding what an unfinished sweep means is the gate's
   * call, not the client's.
   *
   * **ONE CALL RETURNS ONE ROSTER PAGE, AND THERE IS NO MERGE HELPER.** Unlike
   * {@link getAgentDivergence}, whose reasons are run-independent and compose
   * exactly across pages, a cross-agent correlation does NOT compose: a burst
   * of twelve agents split across two roster pages is a cluster of four and a
   * cluster of eight to a page-local engine, both possibly under threshold, so
   * the incident is invisible on every page and in any merge of them. That is
   * why `scan.correlationBasis` is declared, and why `page_local` can never be
   * complete. Page to see the whole roster; do not page to assemble a verdict.
   *
   * **Server-side status:** `GET /api/v1/fleet/health` does not exist yet.
   * This method is written against the contract shape, so no SDK change should
   * be needed once it is wired. Calling it today surfaces a
   * {@link V1ApiError} with `kind: 'not_found'`.
   *
   * @param params - `{ since, until, burstWindowMs }` (all required — there is
   *   no implicit window, because a monitoring loop whose window is implicit
   *   changes meaning invisibly the day a server default is retuned), plus
   *   optional `limit` / `cursor`.
   * @returns `{ report }` — a `FleetHealthReport`.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the deployment does
   *   not serve this route.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if the response
   *   cannot be trusted (see above).
   * @throws {RangeError} if the window arguments are not positive integers or
   *   `until` precedes `since` — caller bugs, surfaced before any request.
   */
  async getFleetHealth(params: FleetHealthParams): Promise<V1FleetHealthData> {
    assertPositiveInteger(params.since, 'since', 'getFleetHealth')
    assertPositiveInteger(params.until, 'until', 'getFleetHealth')
    assertPositiveInteger(params.burstWindowMs, 'burstWindowMs', 'getFleetHealth')
    assertPositiveInteger(params.limit, 'limit', 'getFleetHealth')
    if (params.until < params.since) {
      throw new RangeError(
        `getFleetHealth: until (${params.until}) precedes since (${params.since}) — an inverted window would be ` +
          `served as an empty one, and an empty sweep reports every agent as unobserved rather than as healthy.`
      )
    }

    const data = await fetchV1<V1FleetHealthData>(
      this.config,
      '/api/v1/fleet/health',
      {
        since: params.since,
        until: params.until,
        burstWindowMs: params.burstWindowMs,
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      },
      this.fetchImpl
    )
    assertFleetHealthReportTrustworthy(data.report, params)
    return data
  }

  /**
   * Walk the recorded causal graph around one run: UP to what produced its
   * input, DOWN to what consumed its output, or OUTWARD to the whole connected
   * component for an incident.
   *
   * Traversal types are contracts' — see `packages/contracts/src/causality.ts`.
   *
   * **Every edge here was RECORDED, never inferred.** Two runs adjacent in time,
   * sharing a session, or touching the same resource are not thereby causally
   * linked; coincidences arrive in `traversal.suspected`, which carries no
   * direction of any kind and therefore cannot be walked.
   *
   * **ASKING FOR `'component'` NARROWS THE RESULT.** A component walk closed
   * both sides, so it cannot establish that nothing produced a run — "origin" is
   * a directional claim. Pass the literal and the returned traversal's frontiers
   * are `CycleReEntry | LostTrail`, so `termini[0].originRunId` does not
   * compile. To ask where a chain started, run an `'upstream'` walk; two
   * snapshots stated separately are honest, and one claim stitched out of the
   * other is not.
   *
   * **A CHAIN THAT ENDED, A CHAIN THAT LOOPED, AND A CHAIN WHOSE TRAIL WAS LOST
   * ARE DIFFERENT TYPES.** Read `traversal.termini` by narrowing on `terminus`:
   * a `RecordedOrigin` says the investigation is over and carries the proof, a
   * `CycleReEntry` says the chain loops and the walk closed it (also complete —
   * retry loops are ordinary, and reporting one as unfinished would mean no
   * retry chain could ever exit 0), and a `LostTrail` says the investigation is
   * unfinished and carries what would recover it. The three share no field but
   * the discriminant, so there is no template that renders any two — which is
   * the point. In production the lost trail is the most common terminus, because
   * the SDK may simply never have recorded the edge.
   *
   * **Never trusts an answer it cannot verify.** An ignored parameter (including
   * a walk in the wrong DIRECTION, which is a well-formed answer to the opposite
   * question), a missing `scan`, a suspected link served as an edge, a suspicion
   * carrying a direction or a prose headline, an edge citing a record written in
   * neither of its endpoints, an `artifact_handoff` with no recorded read by the
   * consumer (a shared SHA-256 found by an outside join is a coincidence, not a
   * handoff), an origin with no proof behind it, a cycle whose path does not
   * close, an EMPTY terminus list, or a `verdict` contradicting the traversal's
   * own contents each throw rather than resolve. The one thing NOT refused is an honestly-declared
   * lost trail — that already produces a verdict of `indeterminate`, and deciding
   * what an unfinished walk means is the gate's call, not the client's.
   *
   * **Server-side status:** `GET /api/v1/runs/:id/causality` does not exist yet.
   * This method is written against the contract shape, so no SDK change should be
   * needed once it is wired. Calling it today surfaces a {@link V1ApiError} with
   * `kind: 'not_found'`.
   *
   * @param params - `{ runId, direction, maxDepth }` (all required — a default
   *   direction would let a monitoring loop change which question it asks, and an
   *   implicit depth would report a `depth_limit_reached` at a depth nobody
   *   chose), plus optional `limit` / `cursor`.
   * @returns `{ traversal }` — a `CausalTraversal`.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the run does not exist,
   *   does not belong to the key's org, or the deployment does not serve this route.
   * @throws {@link V1ApiError} with `kind: 'invalid_response'` if the response
   *   cannot be trusted (see above).
   * @throws {RangeError} if `runId` is empty, `direction` is not one of the three
   *   legal values, or `maxDepth`/`limit` are not positive integers — caller bugs,
   *   surfaced before any request.
   */
  async getCausalTrace<D extends CausalDirection>(params: CausalTraceParams<D>): Promise<V1CausalTraceData<D>> {
    if (typeof params?.runId !== 'string' || params.runId.length === 0) {
      throw new RangeError(
        `getCausalTrace: runId is required and must be a non-empty run id. Forwarded as an empty path segment, a ` +
          `lenient server could answer about some other run entirely.`
      )
    }
    if (params.direction !== 'upstream' && params.direction !== 'downstream' && params.direction !== 'component') {
      throw new RangeError(
        `getCausalTrace: direction must be 'upstream', 'downstream' or 'component' — got ` +
          `${JSON.stringify(params.direction)}. There is deliberately no default: "what caused this" and "what did ` +
          `this break" are opposite questions with opposite operational consequences.`
      )
    }
    assertPositiveInteger(params.maxDepth, 'maxDepth', 'getCausalTrace')
    if (params.maxDepth === undefined) {
      throw new RangeError(
        `getCausalTrace: maxDepth is required. A walk whose ceiling is implicit reports "depth limit reached" at a ` +
          `depth nobody chose, and that is indistinguishable from an honest bounded answer.`
      )
    }
    assertPositiveInteger(params.limit, 'limit', 'getCausalTrace')

    const data = await fetchV1<V1CausalTraceData<D>>(
      this.config,
      `/api/v1/runs/${encodeURIComponent(params.runId)}/causality`,
      {
        direction: params.direction,
        maxDepth: params.maxDepth,
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      },
      this.fetchImpl
    )
    assertCausalTraversalTrustworthy(data.traversal as CausalTraversal, params)
    return data
  }
}

/**
 * An empty target version is a caller bug, and a dangerous one: forwarded as
 * `?targetVersionId=`, a lenient server could treat it as "unset" and answer
 * about the run's own version — a guaranteed clean report about a question
 * nobody asked. Caught before the request, like every other caller-bug check
 * on this class.
 */
function assertNonEmptyTarget(targetVersionId: string, method: string): void {
  if (typeof targetVersionId !== 'string' || targetVersionId.length === 0) {
    throw new RangeError(
      `${method}: targetVersionId is required and must be a non-empty agent version id — there is no ` +
        `"compare against the latest version" default, because a gate whose subject is implicit silently ` +
        `changes meaning the next time someone publishes a version.`
    )
  }
}
