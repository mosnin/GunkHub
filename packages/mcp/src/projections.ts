/**
 * Pure projections from the v1 read API's full response shapes onto the
 * deliberately small shapes the MCP tools return.
 *
 * THIS FILE IS THE PRODUCT. The tools are a thin shell around it.
 *
 * A 50-step agent run dumped raw is 100k+ tokens and useless to an agent that
 * has to reason inside a context window. So the tool surface is four tiers,
 * each one a cheap decision point:
 *
 *   Tier 1  afr_list_failure_patterns  ~25 tokens/pattern  "what is broken?"
 *   Tier 2  afr_get_pattern_evidence   ~300 tokens         "did the fix hold?"
 *   Tier 3  afr_explain_run            ~200 tokens         "why did this run fail?"
 *   Tier 4  afr_get_run_events         expensive, windowed "show me the actual events"
 *
 * The rule every function here obeys: the DEFAULT response is the smallest
 * thing that answers the tier's question, and it always carries the handle
 * (fingerprintHash / runId / sequenceNumber) needed to buy the next tier. An
 * agent that only needs to know what is broken never pays for a trace.
 *
 * Two anti-patterns these functions exist to prevent:
 *   - Returning representative runs, payloads, trends, or spike detail from a
 *     LIST. That is what turns a 25-token row into a 400-token one, and it is
 *     paid for every row whether or not the caller cares.
 *   - Inlining an artifact payload. Externalized payloads are externalized
 *     precisely because they were over 10 KB; re-inlining one here would put a
 *     10 KB+ blob into a context window to answer a question the pointer
 *     already answers.
 *
 * THE PROJECTIONS HERE ARE A BACKSTOP, NOT DEAD CODE. As of the server-side
 * `fields` work (convex/read_api.ts §FIELD PROJECTION) each tool ALSO asks the
 * read API for exactly the columns it will emit, so the unwanted fields are no
 * longer paid for on the wire. That does not make these functions redundant and
 * they must not be deleted as such:
 *
 *   - `fields` is opt-in and a deployment that predates it IGNORES the
 *     parameter and returns the full document. The projection is what keeps the
 *     response budgeted against such a server.
 *   - The byte budgets (payload previews, prose caps, transition cap) are
 *     enforced HERE and nowhere else. No server-side field selection bounds the
 *     size of a field it did return.
 *   - Several emitted columns are not document fields at all (confidence state
 *     is joined from a separate envelope; the artifact pointer is read out of
 *     an externalized payload), so the shaping has to happen client-side
 *     regardless.
 *
 * Server-side projection is defense in depth's cheap half. This file is the
 * half that is load-bearing.
 */
import {
  divergenceByDimension,
  isDerivedProvenance,
  isDivergenceAnalysisComplete,
  isDivergenceCoverageComplete,
  isFleetDivergenceAnalysisComplete,
  isFleetScanComplete,
  readTemporalOrder,
} from '@agent-flight-recorder/contracts'
import {
  columnsOf,
  isPatternScanComplete,
  requestFieldsOf,
  truncateProse,
} from '@agent-flight-recorder/sdk'

import type {
  DivergenceCoverage,
  DivergenceReport,
  DivergenceVerdict,
  Event,
  EventProvenance,
  ExternalizedPayload,
  FailurePattern,
  FleetDivergenceReport,
  IndeterminateDivergence,
  ProvenDivergence,
  SpeculativeDivergence,
  OtelMappingLossReason,
  PatternResolutionEvidence,
  Run,
  RunExplanation,
} from '@agent-flight-recorder/contracts'
import type {
  FixConfidenceEntry,
  ProjectedColumn,
  V1ListFailurePatternsData,
  V1ListFixConfidenceEnvelope,
} from '@agent-flight-recorder/sdk'

// The generic projection primitives now live in the SDK (see the notes at
// their former definition sites below). Re-exported from here so every
// existing importer of this module — and `index.ts`'s
// `export * from './projections.js'` — keeps working unchanged.
export { columnsOf, requestFieldsOf, truncateProse }
export type { ProjectedColumn }

// ---------------------------------------------------------------------------
// Columnar encoding — LIST tools only
// ---------------------------------------------------------------------------

/**
 * A list encoded as a field header plus positional rows.
 *
 * WHY THE LIST TOOLS DO NOT RETURN ARRAYS OF OBJECTS. In JSON, every object row
 * repeats every key name. On a tier-1 row the key names (`fingerprintHash`,
 * `lastSeenAt`, `confidenceState`, …) are roughly HALF the bytes, and that cost
 * multiplies by row count — it is paid 10 times on a 10-row page, 100 times on
 * a 100-row page, to transmit the same eight words over and over. Naming the
 * fields once and sending positional rows removes it outright: the same field
 * list that costs ~467 tokens as objects costs ~215 columnar.
 *
 * APPLIED TO LIST TOOLS ONLY. Tiers 2, 3 and 4 return a single item (or a
 * capped window), so key repetition does not compound there, and self-describing
 * objects are worth more than the bytes. Columnar is a compression for
 * repetition, not a house style.
 *
 * `fields` is part of the contract: read values by looking up their index in
 * `fields`, never by assuming a fixed position, so adding a column later is not
 * a breaking change.
 */
export interface Columnar {
  /** Column names, in the order the values appear in each row. */
  fields: string[]
  /** One array per record, positionally aligned with `fields`. `null` where a value is absent. */
  rows: (string | number | boolean | null)[][]
}

/**
 * Encode uniform records as {@link Columnar}.
 *
 * Absent values become `null` rather than being omitted, because a row must
 * stay positionally aligned with `fields` — a "helpfully" shortened row would
 * silently shift every value after the gap into the wrong column.
 */
export function toColumnar<T extends object>(records: T[], fields: readonly (keyof T & string)[]): Columnar {
  const cell = (record: T, field: keyof T & string): string | number | boolean | null => {
    const value = record[field]
    if (value === undefined || value === null) return null
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    return JSON.stringify(value)
  }

  // Drop columns that are null in EVERY row. An all-null column carries no
  // information and costs a null per row plus its name in the header — and
  // `fields` is what a reader indexes by, so its absence is unambiguous rather
  // than a positional hazard.
  const present = fields.filter((field) => records.some((record) => cell(record, field) !== null))

  return {
    fields: [...present],
    rows: records.map((record) => present.map((field) => cell(record, field))),
  }
}

// ---------------------------------------------------------------------------
// Column tables — the single declaration of what each projection emits AND
// what it therefore asks the server for
// ---------------------------------------------------------------------------

/**
 * MOVED TO `@agent-flight-recorder/sdk` and re-exported here.
 *
 * `ProjectedColumn` / `columnsOf` / `requestFieldsOf` are generic — nothing
 * about them is MCP-shaped — and `afr triage` in the CLI needs the same ranking
 * this package has, which is built on them. `packages/mcp` is a leaf
 * application (a `bin`), not a shared library, so the primitives were SPLIT out
 * to the SDK rather than copied. See `packages/sdk/src/projection.ts` for why
 * split rather than copy is load-bearing here.
 *
 * Re-exported so every existing importer of this module keeps working
 * unchanged, and so `index.ts`'s `export * from './projections.js'` still
 * carries them.
 */

// ---------------------------------------------------------------------------
// Tier 1 — failure pattern rows
// ---------------------------------------------------------------------------

/**
 * One pattern row. Six or seven scalars, no nesting. Everything a caller needs
 * to decide "do I care about this one?" and nothing else — the
 * `fingerprintHash` is the handle into tier 2.
 */
export interface PatternRow {
  fingerprintHash: string
  class: string
  label: string
  count: number
  lastSeenAt: number
  /** Absent `status` on the rollup means 'open' — resolved here so the caller does not have to know the rule. */
  status: string
  /** Present only when a fix-confidence verdict exists for this pattern. */
  confidenceState?: string
  /**
   * Present, and only ever `true`, when the verdict above is served from a
   * snapshot older than the deployment's staleness bound. A stale verdict can
   * under-report but never over-report, so it is still served — but silently
   * presenting it as fresh is exactly the false confidence this product exists
   * to remove.
   */
  confidenceStale?: true
}

/**
 * Project one `FailurePattern` plus its optional confidence entry into a row.
 *
 * @param pattern - the rollup as returned by the v1 API.
 * @param confidence - the matching entry from the response's `fixConfidence`
 *   envelope, matched BY FINGERPRINT rather than by array index (the envelope
 *   documents index alignment, but matching on the identifier cannot silently
 *   mislabel a verdict if that ever drifts).
 */
export function toPatternRow(pattern: FailurePattern, confidence?: FixConfidenceEntry): PatternRow {
  const row: PatternRow = {
    fingerprintHash: pattern.fingerprintHash,
    class: pattern.class,
    label: pattern.label,
    count: pattern.count,
    lastSeenAt: pattern.lastSeenAt,
    status: pattern.status ?? 'open',
  }
  if (confidence?.state != null) {
    row.confidenceState = confidence.state
    if (confidence.stale) row.confidenceStale = true
  }
  return row
}

/** How many `unevaluated` fingerprints to name before falling back to a bare count. */
export const UNEVALUATED_SAMPLE_CAP = 10

/**
 * Tier 1's column table. Append-only — never reorder (a caller indexes by name,
 * but the header order is still part of what it reads).
 *
 * The `null` sources are load-bearing, not omissions:
 *   - `fingerprintHash` is the `failure_patterns` identity field, which the
 *     read API returns whether or not it was requested (rule 3).
 *   - `confidenceState` / `confidenceStale` are joined from the response's
 *     `fixConfidence` envelope, which is not part of the pattern document and
 *     is not selectable through `fields`.
 */
export const PATTERN_COLUMNS = [
  { column: 'fingerprintHash', source: null },
  { column: 'class', source: 'class' },
  { column: 'label', source: 'label' },
  { column: 'count', source: 'count' },
  { column: 'lastSeenAt', source: 'lastSeenAt' },
  { column: 'status', source: 'status' },
  { column: 'confidenceState', source: null },
  { column: 'confidenceStale', source: null },
] as const satisfies readonly ProjectedColumn<keyof PatternRow>[]

/** Column order for the tier-1 columnar response. DERIVED from {@link PATTERN_COLUMNS}. */
export const PATTERN_FIELDS: readonly (keyof PatternRow)[] = columnsOf(PATTERN_COLUMNS)

/**
 * The `fields` selection `afr_list_failure_patterns` sends. DERIVED from
 * {@link PATTERN_COLUMNS} — it cannot drift from the header above.
 */
export const PATTERN_REQUEST_FIELDS: readonly string[] = requestFieldsOf(PATTERN_COLUMNS)

/** Tier 1 response. Columnar — see {@link Columnar} for why. */
export interface ListPatternsResult extends Columnar {
  /** Pass back as `cursor` to page. Absent on the last page. */
  nextCursor?: string
  /**
   * Present, and only ever `true`, when the server's scan stopped on its row
   * ceiling rather than on the end of the table.
   *
   * **THIS IS THE DIFFERENCE BETWEEN "NOTHING MATCHED" AND "NOTHING MATCHED IN
   * THE SLICE I COULD AFFORD TO LOOK AT."** A filtered request overfetches a
   * bounded window and then filters it, so a short — or entirely EMPTY — page
   * can be produced purely by the ceiling. While this is `true`, an empty
   * `rows` array is NOT evidence that nothing matches: follow `nextCursor`
   * until a page comes back without this flag, or report the question as
   * unanswered.
   *
   * WHY IT IS HERE AT ALL. Convex computes the marker, the v1 route forwards
   * it, and the SDK types it — and this projection used to drop it at the last
   * hop, which made the whole chain worthless. **A marker nobody reads is the
   * same as no marker.** The consequence lands on an agent: it calls tier 1,
   * sees a short or empty list, and concludes the system is healthy. That is
   * the reassuring-empty-state failure this codebase has already removed from
   * the dashboard, the service layer and the CLI, and it must not survive in
   * the tool an agent is most likely to call first.
   *
   * Emitted only when true, so a complete scan costs zero bytes — tier 1's
   * budget is the tightest here (measured 284 against 300).
   *
   * ABSENCE MEANS "COMPLETE, OR A DEPLOYMENT THAT CANNOT SAY", and that
   * collapse is not decided here: {@link isPatternScanComplete} is the SDK's
   * single place for it, and it is called rather than re-implemented so three
   * layers do not each guess differently.
   */
  scanTruncated?: true
  /**
   * Patterns that have a live resolution but no usable confidence snapshot, so
   * they could not be graded at all. Named rather than dropped: "we could not
   * evaluate these" is a materially different answer from "these do not
   * match", and a `state` filter silently excludes them.
   */
  unevaluated?: { count: number; sample: string[] }
}

/**
 * Build the tier-1 response.
 *
 * @param patterns - the page of rollups.
 * @param envelope - the response's `fixConfidence` envelope, absent when the
 *   deployment predates it.
 * @param nextCursor - the page cursor, forwarded verbatim.
 * @param scan - the response's scan markers. OPTIONAL, and additive on
 *   purpose: an omitted argument reads as an undeclared marker, which
 *   {@link isPatternScanComplete} resolves to "complete" — exactly the
 *   behaviour every caller had before the marker existed.
 */
export function toListPatternsResult(
  patterns: FailurePattern[],
  envelope: V1ListFixConfidenceEnvelope | undefined,
  nextCursor: string | undefined,
  scan?: Pick<V1ListFailurePatternsData, 'scanTruncated'>,
): ListPatternsResult {
  const byHash = new Map<string, FixConfidenceEntry>()
  for (const entry of envelope?.entries ?? []) byHash.set(entry.fingerprintHash, entry)

  const rows = patterns.map((p) => toPatternRow(p, byHash.get(p.fingerprintHash)))
  const result: ListPatternsResult = toColumnar(rows, PATTERN_FIELDS)
  if (nextCursor !== undefined) result.nextCursor = nextCursor
  if (!isPatternScanComplete(scan ?? {})) result.scanTruncated = true

  const unevaluated = envelope?.unevaluated ?? []
  if (unevaluated.length > 0) {
    result.unevaluated = {
      count: unevaluated.length,
      sample: unevaluated.slice(0, UNEVALUATED_SAMPLE_CAP),
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Tier 2 — pattern evidence
// ---------------------------------------------------------------------------

/**
 * How many lifecycle transitions to return. Most recent N, then re-sorted
 * oldest-first, with `transitionsTruncated` set when any were dropped.
 *
 * `PatternResolutionEvidence` bounds `transitions` at 100. That is a UI bound —
 * a human scrolling a history panel — not an MCP bound. 100 transitions is
 * ~2 300 tokens, to answer a question ("did the fix hold?") that the recent
 * history already answers.
 *
 * 10 is a deliberate floor, not a number tuned to hit a budget. Lifecycle
 * history is the evidence a caller uses to distinguish "resolved once, held"
 * from "resolved, regressed, re-resolved, regressed again" — cutting it to make
 * a token target would be trading away the answer to buy the budget.
 */
export const TRANSITIONS_CAP = 10

/** Tier 2 response — the "did the fix hold?" answer. */
export interface PatternEvidenceResult {
  fingerprintHash: string
  class: string
  label: string
  count: number
  lastSeenAt: number
  status: string
  /** Null when there is no live resolution (never resolved, or manually reopened — which clears `resolvedAt`). */
  resolution: {
    resolvedAt: number
    resolvedByUserId?: string
    resolutionNote?: string
    resolutionRef?: string
    resolvedInVersionId?: string
    resolvedInVersion?: string
    resolvedAtOccurrenceCount?: number
    resolvedAtRunCount?: number
  } | null
  /**
   * Null exactly when `resolution` is null. Read `runCount` as a FLOOR when
   * `runCountTruncated` is true, and note that `heldSoFar: true` with
   * `runCount: 0` means untested, not proven.
   */
  exposure: {
    since: number
    runCount: number
    runCountTruncated: boolean
    recurrenceCount: number
    heldSoFar: boolean
  } | null
  /**
   * Null on the same condition as `resolution`. `score` is a 0-1 fraction
   * capped at 0.95 — never a percentage, never 1.0. For a CI gate, branch on
   * `state === 'regressed'`, not on `exposure.heldSoFar`.
   */
  confidence: {
    score: number
    state: string
    exposureRuns: number
    observedRuns: number
    elapsedMs: number
    recurred: boolean
    exposureCredit: number
    soakCredit: number
    limitingFactor: string
    versionAttribution: string
  } | null
  /** Oldest-first, the {@link TRANSITIONS_CAP} most recent. `metadata` is dropped — it is unbounded. */
  transitions: { action: string; actor: string; timestamp: number }[]
  /** True when transitions were dropped, so a caller knows the history is partial. */
  transitionsTruncated?: true
}

/** Project the full evidence projection onto the tier-2 response. */
export function toPatternEvidenceResult(evidence: PatternResolutionEvidence): PatternEvidenceResult {
  const { pattern, resolution, exposure, confidence, transitions } = evidence

  // transitions arrive oldest-first and bounded to 100; take the most recent
  // TRANSITIONS_CAP and restore oldest-first ordering.
  const recent = transitions.slice(Math.max(0, transitions.length - TRANSITIONS_CAP))

  const result: PatternEvidenceResult = {
    fingerprintHash: pattern.fingerprintHash,
    class: pattern.class,
    label: pattern.label,
    count: pattern.count,
    lastSeenAt: pattern.lastSeenAt,
    status: pattern.status ?? 'open',
    resolution:
      resolution === null
        ? null
        : {
            resolvedAt: resolution.resolvedAt,
            ...(resolution.resolvedByUserId !== undefined && { resolvedByUserId: resolution.resolvedByUserId }),
            ...(resolution.resolutionNote !== undefined && { resolutionNote: resolution.resolutionNote }),
            ...(resolution.resolutionRef !== undefined && { resolutionRef: resolution.resolutionRef }),
            ...(resolution.resolvedInVersionId !== undefined && { resolvedInVersionId: resolution.resolvedInVersionId }),
            ...(resolution.resolvedInVersion !== undefined && { resolvedInVersion: resolution.resolvedInVersion }),
            ...(resolution.resolvedAtOccurrenceCount !== undefined && {
              resolvedAtOccurrenceCount: resolution.resolvedAtOccurrenceCount,
            }),
            ...(resolution.resolvedAtRunCount !== undefined && { resolvedAtRunCount: resolution.resolvedAtRunCount }),
          },
    exposure:
      exposure === null
        ? null
        : {
            since: exposure.since,
            runCount: exposure.runCount,
            runCountTruncated: exposure.runCountTruncated,
            recurrenceCount: exposure.recurrenceCount,
            heldSoFar: exposure.heldSoFar,
          },
    confidence:
      confidence === null
        ? null
        : {
            score: confidence.score,
            state: confidence.state,
            exposureRuns: confidence.exposureRuns,
            observedRuns: confidence.observedRuns,
            elapsedMs: confidence.elapsedMs,
            recurred: confidence.recurred,
            exposureCredit: confidence.exposureCredit,
            soakCredit: confidence.soakCredit,
            limitingFactor: confidence.limitingFactor,
            versionAttribution: confidence.versionAttribution,
          },
    transitions: recent.map((t) => ({ action: t.action, actor: t.actorClerkUserId, timestamp: t.timestamp })),
  }
  if (recent.length < transitions.length) result.transitionsTruncated = true
  return result
}

// ---------------------------------------------------------------------------
// Tier 3 — run explanation
// ---------------------------------------------------------------------------

/**
 * Byte budgets for the three free-text fields on an explanation.
 *
 * `RunExplanation` caps `summary` at 2 KB and `rootCause`/`suggestedFix` at
 * 1 KB each. 4 KB of prose is ~1 000 tokens — FIVE TIMES this tier's budget. So
 * tier 3 would be cheap only by luck: it holds today because the generator
 * happens to write short explanations, which is a property of the generator,
 * not a guarantee of this layer. This layer enforces its own bound.
 *
 * The caps are set above the length of a realistic explanation, so ordinary
 * output passes through untouched and only a runaway one is cut.
 */
export const SUMMARY_BYTE_CAP = 230
export const ROOT_CAUSE_BYTE_CAP = 150
export const SUGGESTED_FIX_BYTE_CAP = 110

/**
 * Byte budget for the serialized `citedSequenceNumbers` array — THE SAME
 * ARGUMENT AS THE PROSE CAPS ABOVE, applied to the one field on this tier that
 * is an array, which is where it was left unfinished.
 *
 * `RunExplanation` documents the array's bound as up to 20 entries, and this
 * projection used to forward it VERBATIM: it capped the three prose fields and
 * nothing else. Measured against the contract-maximal explanation, the tier
 * cost 192 tokens at 5 citations, 196 at 10, 200 at 15 and 203 at 20 — so it
 * held its 200-token budget only because the generator happens to cite few
 * events. That is a property of the generator, not a guarantee of this layer.
 *
 * WHY BYTES AND NOT A COUNT. A count cap does not actually bound this field.
 * Sequence numbers are per-run integers starting at 1 (Event Log Rule 4), so
 * their WIDTH grows with run length: ten citations cost 30 bytes on a 50-step
 * run and 70 on a 100k-event one. A cap of "10 citations" is therefore the same
 * cheap-by-luck bound one level down — bounded count, unbounded width — and it
 * would have to be re-derived every time somebody records a longer run. The
 * three fields above are capped in BYTES for exactly this reason; so is this
 * one, and so the tier's ceiling holds for any run length.
 *
 * WHY 18. It is what fits under the tier's published 200-token budget once the
 * truncation marker below is paid for: worst case measures 198 tokens against
 * 200, for any citation count and any sequence-number width. It admits the
 * realistic explanation whole (the generator writes ~5 two-digit citations = 15
 * bytes, which passes through untouched and still costs the published 192), and
 * degrades sensibly as runs get longer — 5 citations at two digits, 4 at three,
 * 3 at four, 2 at six.
 *
 * Cutting it harder was rejected: a citation is a HANDLE into tier 4, and the
 * handles are the entire reason this tier boundary exists. Not cutting it at
 * all is the defect. Between those, the deciding argument for a small number is
 * that citations CLUSTER — they are contiguous around the failure more often
 * than not, and `afr_get_run_events(runId, aroundSequence)` returns a WINDOW, so
 * the second and third citation are usually already inside the window the first
 * one buys. The marginal handle is worth far less than the first, while each one
 * costs the same bytes.
 *
 * WHY THE HIGHEST, NOT THE FIRST. The earliest citations are not the most useful
 * ones. `RUN_COMPLETED`/`RUN_FAILED` is always the last event (Event Log Rule
 * 5), the root cause lands next to it, and the backend's own signal extraction
 * already says so out loud — `convex/failure_patterns.ts`
 * `extractFingerprintSignals` scans cited events "highest-sequence-first
 * (closest to the failure)". Keeping the FIRST few of a `[1, 14, 22 … 39]`
 * citation list would keep `RUN_STARTED` and throw away every event adjacent to
 * the failure. This is the same shape as {@link TRANSITIONS_CAP} above: keep the
 * most recent, then restore log order.
 *
 * Selected by sorting on VALUE rather than by slicing the array's tail, because
 * array order is GENERATOR order — `validateCitedSeqNums` in
 * `convex/run_explanations.ts` dedupes and slices but never sorts, so the last
 * element is not necessarily the highest sequence number. The sort runs on the
 * un-truncated path too, so the emitted order is log order either way rather
 * than depending on whether a cut happened.
 *
 * AND THE CUT IS ANNOUNCED, which is the half that matters. `citationsDropped`
 * carries how many were removed, for the same reason `truncateProse` emits an
 * in-band `…[truncated, N more chars]` marker and `budgetPayload` sets
 * `truncated`/`bytes`: a list silently shortened to five entries is a wrong
 * answer that looks like a right one, and this package exists to remove those.
 * It is emitted ONLY when something was actually dropped, so an explanation that
 * fits pays nothing for it.
 */
export const CITED_SEQUENCE_BYTE_CAP = 18

/**
 * MOVED TO `@agent-flight-recorder/sdk` and re-exported here — see the note on
 * the column primitives above. `truncateProse` emits an in-band
 * `…[truncated, N more chars]` marker that callers and tests both read, so two
 * copies of it could drift into disagreeing about what "truncated" looks like
 * on the wire. One declaration, imported by both.
 */

/**
 * Whether an explanation for this run is here, coming, or never coming.
 *
 * - `available` — it is in this response. (Never emitted; implied by `status: 'ready'`.)
 * - `not_yet`   — the run can still produce one. It failed and generation has
 *   not landed, or it is STILL IN FLIGHT and may yet fail. Retry later.
 * - `never`     — the run reached a terminal, non-failed state, so there is
 *   nothing to explain and nothing to wait for. Stop.
 * - `unknown`   — the two signals do not agree, or `runStatus` was not served
 *   (an older deployment). Reported as unknown rather than guessed: this is
 *   the one place where guessing `never` tells a caller to stop looking at
 *   something that may be broken.
 */
export type ExplanationAvailability = 'available' | 'not_yet' | 'never' | 'unknown'

/** Run statuses that mean the run is still going, so a failure — and an explanation — is still possible. */
const IN_FLIGHT_RUN_STATUSES: readonly string[] = ['pending', 'running']
/** Terminal run statuses that are not failures. A `not_eligible` on one of these is genuinely final. */
const TERMINAL_NON_FAILURE_RUN_STATUSES: readonly string[] = ['completed', 'cancelled', 'timed_out']

/**
 * Derive {@link ExplanationAvailability} from the two signals the server sends.
 *
 * The whole point is the `not_eligible` + in-flight case: the server means "not
 * eligible RIGHT NOW", the word reads as "not eligible EVER", and only
 * `runStatus` distinguishes them.
 *
 * @param status - the server's explanation discriminant.
 * @param runStatus - the run's own status, when the server supplied it.
 */
export function deriveAvailability(
  status: 'not_eligible' | 'pending' | 'ready',
  runStatus: string | undefined,
): ExplanationAvailability {
  if (status === 'ready') return 'available'
  // `pending` already means "it failed, generation has not landed". Bounded by
  // the repair sweep, so it is a claim about latency, not a permanent state.
  if (status === 'pending') return 'not_yet'
  if (runStatus === undefined) return 'unknown'
  if (IN_FLIGHT_RUN_STATUSES.includes(runStatus)) return 'not_yet'
  if (TERMINAL_NON_FAILURE_RUN_STATUSES.includes(runStatus)) return 'never'
  // `not_eligible` on a run that DID fail is a contradiction between the two
  // signals. Neither 'never' nor 'not_yet' is defensible, so say so rather than
  // pick one — telling a caller to stop looking at a failed run is the more
  // costly of the two possible mistakes.
  return 'unknown'
}

/**
 * Tier 3 response.
 *
 * `status` is the honest discriminant and must not be collapsed into a bare
 * null. `not_eligible` means the run did not fail and never will have an
 * explanation; `pending` means it failed and generation has not landed yet.
 * Those demand different behaviour from a caller (stop vs. retry later), and a
 * shared `null` would force it to guess.
 */
export interface ExplainRunResult {
  runId: string
  status: 'not_eligible' | 'pending' | 'ready'
  runStatus?: string
  /**
   * THE HONEST THREE-WAY ANSWER, derived from `status` AND `runStatus`
   * together. Emitted only when `status !== 'ready'` — for a ready
   * explanation the availability is trivially `available` and the explanation
   * is right there, so the field would be pure cost on the tier's most
   * expensive case.
   *
   * WHY IT EXISTS. `status: 'not_eligible'` is TRUE-BUT-MISLEADING for a run
   * that is still in flight. Read alone it says "this run did not fail and
   * never will have an explanation", and an agent that believes that concludes
   * "nothing to see here" about a run that is actively failing and will have
   * an explanation in thirty seconds. The information needed to tell the two
   * apart is already on the response — `runStatus` — but requiring every
   * caller to cross-reference two fields to avoid a wrong conclusion is a
   * defect, not an interface.
   *
   * The wire vocabulary is deliberately NOT widened to fix this. `status` is
   * validated against a hard-coded `not_eligible|pending|ready` in two places
   * (this package's `readStatus`, and `apps/web/src/lib/services/explanations.ts`)
   * which SILENTLY DOWNGRADE anything unrecognised to `pending` — so a new
   * server-side status would reach an agent as `pending`, the exact
   * un-actionable answer it would have been added to remove. Fixing that needs
   * a coordinated change across mcp + web + convex. This field is the
   * client-side derivation that is available today; `status` is unchanged.
   */
  availability?: ExplanationAvailability
  summary?: string
  rootCause?: string
  suggestedFix?: string
  failureClass?: string
  /** Kind of generator: 'heuristic' or 'llm'. Present when `status` is 'ready'. */
  kind?: string
  /**
   * Event `sequenceNumber`s in this run's log that the explanation cites — the
   * handle into tier 4. Pass one as `aroundSequence` to `afr_get_run_events`.
   *
   * Ascending, and bounded by {@link CITED_SEQUENCE_BYTE_CAP} to the HIGHEST
   * citations — the ones nearest the failure. When any were dropped,
   * {@link ExplainRunResult.citationsDropped} says how many.
   */
  citedSequenceNumbers?: number[]
  /**
   * How many citations were cut to fit {@link CITED_SEQUENCE_BYTE_CAP}. Present
   * ONLY when the list was truncated, and only ever a positive number.
   *
   * The explanation cited earlier events than the ones listed above. To reach
   * them, page backwards from the lowest emitted `sequenceNumber` with
   * `afr_get_run_events(runId, fromSequence)` — do not read the list as the
   * complete set of grounding events.
   */
  citationsDropped?: number
}

/**
 * Project a run explanation onto the tier-3 response.
 *
 * @param runId - echoed back so a batched caller can correlate.
 * @param status - the server's discriminant, already normalized by the caller.
 * @param explanation - the explanation, or null when not ready.
 * @param runStatus - the run's own status, when the server supplied it.
 */
export function toExplainRunResult(
  runId: string,
  status: 'not_eligible' | 'pending' | 'ready',
  explanation: RunExplanation | null,
  runStatus: string | undefined,
): ExplainRunResult {
  const result: ExplainRunResult = { runId, status }
  if (runStatus !== undefined) result.runStatus = runStatus
  // Only when it carries information — see the field's doc comment. A `ready`
  // response is the tier's most expensive case and gains nothing from being
  // told the explanation it contains is available.
  if (status !== 'ready') result.availability = deriveAvailability(status, runStatus)
  if (explanation === null) return result

  result.summary = truncateProse(explanation.summary, SUMMARY_BYTE_CAP)
  result.rootCause = truncateProse(explanation.rootCause, ROOT_CAUSE_BYTE_CAP)
  if (explanation.suggestedFix !== undefined) {
    result.suggestedFix = truncateProse(explanation.suggestedFix, SUGGESTED_FIX_BYTE_CAP)
  }
  result.failureClass = explanation.failureClass
  result.kind = explanation.kind
  // Highest-first into a byte budget, emitted in log order. See
  // CITED_SEQUENCE_BYTE_CAP for why bytes rather than a count, why the highest
  // rather than the first, and why this sorts on VALUE instead of slicing the
  // array's tail.
  const cited = [...explanation.citedSequenceNumbers].sort((a, b) => a - b)
  let kept: number[] = []
  for (let i = cited.length - 1; i >= 0; i--) {
    const seq = cited[i]
    if (seq === undefined) continue
    const candidate = [seq, ...kept]
    // The first citation is always kept, whatever it costs. A budget that can
    // empty the list entirely does not bound a field, it deletes one — and the
    // handles into tier 4 are what this tier is FOR.
    if (kept.length > 0 && Buffer.byteLength(JSON.stringify(candidate), 'utf8') > CITED_SEQUENCE_BYTE_CAP) break
    kept = candidate
  }
  result.citedSequenceNumbers = kept
  if (kept.length < cited.length) result.citationsDropped = cited.length - kept.length
  return result
}

// ---------------------------------------------------------------------------
// Tier 4 — event window
// ---------------------------------------------------------------------------

/** Pointer to an externalized payload. The blob itself is NEVER fetched or inlined. */
export interface ArtifactPointer {
  artifactId: string
  checksum: string
  size: number
  storageBucket: string
  storageKey: string
}

/**
 * Byte budget for a single inline payload.
 *
 * WHY AN EVENT CAP IS NOT ENOUGH. `MAX_LIMIT` caps EVENTS; an agent pays for
 * BYTES. Externalization only kicks in ABOVE 10 KB, so a payload of 10 239
 * bytes is never an artifact and would be inlined verbatim. Fifty of those is
 * ~500 KB — about 125 000 tokens in one tool result, MORE than the 100k raw
 * dump this whole package exists to prevent. The window would cost more than
 * the thing it was invented to replace.
 *
 * So the payload itself is budgeted, and anything over is replaced by a
 * labelled preview.
 */
export const PAYLOAD_PREVIEW_BYTE_CAP = 400

/** A payload too large to inline, replaced by a labelled preview of its serialization. */
export interface PayloadPreview {
  /** Always true — a caller must never mistake this for the whole payload. */
  truncated: true
  /** Full serialized size in bytes, so the caller knows what it is not seeing. */
  bytes: number
  /** The first {@link PAYLOAD_PREVIEW_BYTE_CAP} bytes of the serialized payload. */
  preview: string
}

// ---------------------------------------------------------------------------
// Provenance — projected DOWN by default, never projected AWAY
// ---------------------------------------------------------------------------

/**
 * Byte cap for the two free-text strings on an OTel provenance record.
 *
 * `traceId`, `spanId`, `semconvVersion`, `mapperVersion`, `receivedAt` and
 * `lossReasons` are all bounded by their own contracts (hex of fixed width, a
 * version string, an epoch integer, a CLOSED union of eight reasons). `spanName`
 * and `scopeName` are not: they are whatever the emitting instrumentation chose
 * to call the operation, preserved VERBATIM by design. An unbounded string on a
 * per-event field is the same cheap-by-luck bound {@link SUMMARY_BYTE_CAP} and
 * {@link CITED_SEQUENCE_BYTE_CAP} exist to close, one field further down — so it
 * is closed the same way, in bytes, with {@link truncateProse}'s in-band marker
 * so a cut name cannot be mistaken for a short one.
 *
 * 120 admits every realistic span name whole (`openinference.instrumentation.
 * langchain` is 44; the longest names in the OTel GenAI conventions are under
 * 80) and only cuts a pathological one.
 */
export const PROVENANCE_NAME_BYTE_CAP = 120

/** Full provenance of a first-party SDK recording, as the detail view emits it. */
export interface ProjectedNativeProvenance {
  source: 'sdk'
  sdkVersion?: string
}

/**
 * Full provenance of a DERIVED event, as the detail view emits it.
 *
 * Field-for-field `OtelEventProvenance`, with `spanName`/`scopeName` bounded by
 * {@link PROVENANCE_NAME_BYTE_CAP}. Nothing is dropped: a caller that has paid
 * for this is correlating against its own OTel backend, and a trace id with a
 * missing sibling field is not a correlation key, it is half of one.
 */
export interface ProjectedOtelProvenance {
  source: 'otel'
  traceId: string
  spanId: string
  parentSpanId?: string
  spanName: string
  scopeName?: string
  semconvVersion: string
  mapperVersion: string
  lossy: boolean
  lossReasons?: OtelMappingLossReason[]
  receivedAt: number
}

/** What `includeProvenance: true` puts on a row. */
export type ProjectedProvenance = ProjectedNativeProvenance | ProjectedOtelProvenance

/**
 * Project a stored provenance record onto the DETAIL shape.
 *
 * Switches on `source` rather than probing for `traceId`, as
 * `packages/contracts/src/provenance.ts` asks, so a third ingest source becomes
 * a compiler error here instead of a silently mis-projected row.
 */
export function toProvenanceDetail(provenance: EventProvenance): ProjectedProvenance {
  if (provenance.source === 'sdk') {
    return provenance.sdkVersion === undefined
      ? { source: 'sdk' }
      : { source: 'sdk', sdkVersion: provenance.sdkVersion }
  }
  return {
    source: 'otel',
    traceId: provenance.traceId,
    spanId: provenance.spanId,
    ...(provenance.parentSpanId !== undefined && { parentSpanId: provenance.parentSpanId }),
    spanName: truncateProse(provenance.spanName, PROVENANCE_NAME_BYTE_CAP),
    ...(provenance.scopeName !== undefined && {
      scopeName: truncateProse(provenance.scopeName, PROVENANCE_NAME_BYTE_CAP),
    }),
    semconvVersion: provenance.semconvVersion,
    mapperVersion: provenance.mapperVersion,
    lossy: provenance.lossy,
    ...(provenance.lossReasons !== undefined && { lossReasons: [...provenance.lossReasons] }),
    receivedAt: provenance.receivedAt,
  }
}

/**
 * Emitted ONCE per window, and only when the window actually contains a derived
 * event. Never per event — the same rule {@link TRUNCATION_NOTE} follows.
 *
 * WHY A NOTE AND NOT MORE FIELDS. The two facts an agent must have on every row
 * (`derived`, `derivedLossy`) are on every row. What this adds is the two things
 * a row cannot carry cheaply: what derivation MEANS for reading the window
 * (`sequenceNumber` is ingest order on a derived run, not necessarily temporal
 * order — replay and diff assume the opposite), and how to buy the detail. Both
 * are constant per window, so paying for them per event would be paying 50 times
 * for one sentence.
 */
export const PROVENANCE_NOTE =
  'Some events in this window were DERIVED from OpenTelemetry spans (derived:"otel") rather than recorded ' +
  'first-party by the SDK. Their payloads are this system’s interpretation of somebody else’s telemetry, and ' +
  'sequenceNumber on a derived run is ingest order — NOT necessarily the order the operations occurred in, which ' +
  'is what replay and diff assume. derivedLossy:true means the mapping dropped information. Call again with ' +
  'includeProvenance:true for trace/span ids, semconv and mapper versions, and the specific loss reasons.'
// DELIBERATELY SAYS NOTHING ABOUT `orderingBasis`. A clause here explaining the
// absent case measured +33 tokens on EVERY derived window; the identical
// explanation lives in the tool description, which an agent pays for once per
// session. Per-call bytes for once-per-session semantics is the trade this
// whole package exists to refuse — see ORDERING_UNVERIFIED_BASIS.

/**
 * The ONE ordering verdict this tier is entitled to state, and the reason it is
 * one and not three.
 *
 * `OrderingBasis` (packages/contracts/src/temporal.ts) is a RUN-level verdict:
 * `analyzeRunOrdering` reaches it by walking the whole event log. A tier-4
 * response is a WINDOW by construction — that is the entire point of the tier —
 * so computing the three-way verdict from what is in hand would be computing it
 * from a slice, and a slice can report `temporal` while a single unkeyed event
 * ten sequence numbers outside it has already forced the real answer to
 * `ingest-unverified`. Rendering a confident timeline that is wrong in an
 * unmarked place is worse than either honest option.
 *
 * ONE DIRECTION OF THE INFERENCE IS SOUND, and only one. `analyzeRunOrdering`
 * returns `ingest-unverified` iff `keyedCount !== derivedCount` over the FULL
 * set, so a single derived event with no usable key ANYWHERE forces it. A window
 * containing such an event therefore proves the run's verdict outright, no
 * matter what lies outside the window. Nothing about a window can prove
 * `temporal` or `sequence-native`, so this tier never says either.
 *
 * Emitted as a bare scalar rather than a sentence because the semantics belong
 * in the tool DESCRIPTION, which an agent pays for once per session, not in the
 * RESPONSE, which it pays for on every call.
 */
export const ORDERING_UNVERIFIED_BASIS = 'ingest-unverified'

/** One event in a window. */
export interface EventRow {
  sequenceNumber: number
  type: string
  timestamp: number
  /**
   * THE BADGE. Present, and only ever `'otel'`, when this event was DERIVED
   * from an OpenTelemetry span rather than recorded first-party by the SDK.
   * Absent means native (or unrecorded, which per
   * `packages/contracts/src/provenance.ts` reads as native — every row written
   * before OTel ingestion existed came from the SDK path, there being no other
   * writer).
   *
   * **THIS FIELD IS NOT OPTIONAL BEHAVIOUR.** The whole reason provenance was
   * made mandatory on the derived write path is that an agent must never see an
   * event that LOOKS first-party when it is our interpretation of somebody
   * else's telemetry. Projecting that away at the last hop would defeat the
   * chain end-to-end while every upstream layer stayed correct — which is
   * exactly how {@link ListPatternsResult.scanTruncated} was lost: computed by
   * Convex, forwarded by the route, typed by the SDK, and dropped here. A
   * marker nobody reads is the same as no marker.
   *
   * It costs nothing on a native run: absent fields are not serialized, so a
   * window with no derived events pays zero bytes for this.
   */
  derived?: 'otel'
  /**
   * Present, and only ever `true`, when the span→event mapping did NOT carry
   * over everything the span contained.
   *
   * A SEPARATE CLAIM FROM {@link EventRow.derived}, deliberately, and not
   * foldable into it. "This event is derived" and "this event is a derived
   * approximation that LOST information" are different statements about
   * evidentiary strength, and an agent reasoning about why a run failed needs
   * the second: a field it cannot find may be a field that was never there, or
   * a field the mapper dropped, and only this distinguishes them.
   *
   * Absent WITH `derived` present means lossless — unambiguously, because
   * `lossy` is a REQUIRED boolean on `OtelEventProvenance`, so "not stated" is
   * not a state the source record can be in. WHAT was lost is behind
   * `includeProvenance` (`lossReasons`); see {@link PROVENANCE_NOTE}.
   *
   * A PACKED ENCODING WAS REJECTED. `derived: 'otel-lossy'` would save ~21 B an
   * event, and it would make the more important of the two facts reachable only
   * by string-matching a value whose vocabulary is not the contract's. The
   * badge has to be readable without parsing.
   */
  derivedLossy?: true
  /**
   * The FULL provenance record. Present only when the caller passed
   * `includeProvenance: true`, and only when the stored event carries one.
   *
   * WHY IT IS OPT-IN. A full `OtelEventProvenance` projects to ~500 B of JSON
   * at the contract maximum (`lossReasons` is a closed union of EIGHT, and a
   * maximal record carries all of them); across a 50-event window that is
   * ~25 KB, which does not merely eat this tier's headroom, it BREACHES its
   * 10,000-token ceiling outright — measured 10,857. Paid on every window
   * whether or not anyone reads a trace id.
   *
   * The four-tier ladder exists to stop exactly that: a LIST needs the
   * badge, a DETAIL view needs the ids, and only when someone is actually
   * correlating against an OTel backend. The two facts that change how the log
   * must be READ are above and are never optional; the coordinates that let
   * somebody go LOOK are here and are bought deliberately.
   *
   * ABSENT DOES NOT MEAN NATIVE — read {@link EventRow.derived} for that. On a
   * derived event with `includeProvenance` unset this is simply not present.
   */
  provenance?: ProjectedProvenance
  /**
   * The inline payload, present only when the payload was NOT externalized.
   * Replaced by a {@link PayloadPreview} when it exceeds
   * {@link PAYLOAD_PREVIEW_BYTE_CAP}.
   */
  payload?: unknown
  /**
   * Present instead of `payload` when the original payload exceeded the
   * externalization threshold. The blob is not fetched: an agent that wanted
   * 10 KB+ of JSON in its context can fetch it deliberately with these
   * coordinates, but it never arrives by accident.
   */
  artifact?: ArtifactPointer
  /** The real event type when the payload was externalized (`type` still carries it too). */
  originalType?: string
  /** Short redacted failure summary the SDK attaches when an externalized payload was a `run.failed`. */
  errorSummary?: string
}

/**
 * Tier 4's column table.
 *
 * Tier 4 is not columnar (a window is a handful of self-describing objects, so
 * key names do not compound the way they do on a 100-row list), but the same
 * derivation applies: this is where the tier's `fields` selection comes from.
 *
 * `sequenceNumber` has a `null` source because it is the `events` identity
 * field — Event Log Rule 4 addresses an event by its sequence within a run, and
 * the read API returns it unconditionally (rule 3).
 *
 * `artifact`, `originalType` and `errorSummary` all read `payload`: an
 * externalized payload carries the pointer INSIDE itself, so the three columns
 * cost one field on the wire. {@link requestFieldsOf} dedupes them.
 *
 * `derived`, `derivedLossy` and `provenance` all read `provenance`, so the
 * badge, the loss flag and the opt-in detail cost ONE field on the wire.
 * {@link requestFieldsOf} dedupes them.
 *
 * REQUESTING `provenance` IS LOAD-BEARING, not bookkeeping. The read API's
 * `fields` selection is what the server serializes, so a column table that
 * omits `provenance` makes the server drop it — and then `toEventRow` reads
 * `undefined` on every row and emits no badge, on a deployment that had the
 * data all along. The badge would be lost server-side rather than in this file,
 * which is worse, not better: nothing here would look wrong.
 *
 * What is deliberately NOT requested: `runId` (the caller passed it in and it
 * is echoed from the argument), `orgId` (never emitted — the tenancy boundary
 * is the key's, not a value to hand an agent) and `parentEventId`.
 */
export const EVENT_COLUMNS = [
  { column: 'sequenceNumber', source: null },
  { column: 'type', source: 'type' },
  { column: 'timestamp', source: 'timestamp' },
  { column: 'payload', source: 'payload' },
  { column: 'artifact', source: 'payload' },
  { column: 'originalType', source: 'payload' },
  { column: 'errorSummary', source: 'payload' },
  { column: 'derived', source: 'provenance' },
  { column: 'derivedLossy', source: 'provenance' },
  { column: 'provenance', source: 'provenance' },
] as const satisfies readonly ProjectedColumn<keyof EventRow>[]

/** The columns tier 4 emits. DERIVED from {@link EVENT_COLUMNS}. */
export const EVENT_FIELDS: readonly (keyof EventRow)[] = columnsOf(EVENT_COLUMNS)

/**
 * Source fields the window projection READS but never EMITS.
 *
 * `ProjectedColumn` pairs an emitted column with its source, which is the right
 * shape for every column above — but `temporalOrder` is neither. It is read to
 * decide ONE window-level fact ({@link budgetEventRows}'s `orderUnverified`) and
 * is never returned to the caller, because a `TemporalOrderKey` is ~130 B per
 * event and this is the tier where per-event bytes are the whole problem.
 *
 * IT MUST BE REQUESTED ANYWAY, and getting this wrong is silent in the worst
 * direction. `fields` is a projection: a field not asked for comes back ABSENT,
 * not `null`. So if `temporalOrder` were left out of the request, every derived
 * event would read as unkeyed, and every derived run would be labelled
 * `ingest-unverified` — a confident alarm on healthy runs, which is how an
 * honesty marker becomes noise and then gets ignored.
 *
 * `temporalOrder` is a valid selection name without any change to the read API:
 * `validateFieldSelection` derives its vocabulary from the live Convex schema
 * (`convex/read_api.ts` → `validFieldsFor`), and `convex/schema.ts` declares the
 * column. `tests/unit/mcp_fields.test.ts` pins that agreement.
 */
export const EVENT_READ_ONLY_SOURCE_FIELDS: readonly string[] = ['temporalOrder']

/**
 * The `fields` selection `afr_get_run_events` sends. DERIVED from
 * {@link EVENT_COLUMNS}, plus {@link EVENT_READ_ONLY_SOURCE_FIELDS} — the
 * request is "what the projection READS", which is a superset of what it emits.
 */
export const EVENT_REQUEST_FIELDS: readonly string[] = [
  ...requestFieldsOf(EVENT_COLUMNS),
  ...EVENT_READ_ONLY_SOURCE_FIELDS,
]

function isExternalized(payload: unknown): payload is ExternalizedPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === '_externalized' &&
    typeof (payload as { _artifact?: unknown })._artifact === 'object'
  )
}

/**
 * Budget an inline payload, replacing an oversized one with a labelled preview.
 *
 * Note the failure this avoids: silently returning the first 400 bytes as if
 * they were the payload. `truncated` and `bytes` make the omission explicit, so
 * a caller reading a cut-off tool result knows it is cut off.
 */
export function budgetPayload(payload: unknown): unknown {
  const serialized = JSON.stringify(payload)
  if (serialized === undefined) return payload
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= PAYLOAD_PREVIEW_BYTE_CAP) return payload
  const preview: PayloadPreview = {
    truncated: true,
    bytes,
    preview: Buffer.from(serialized, 'utf8').subarray(0, PAYLOAD_PREVIEW_BYTE_CAP).toString('utf8'),
  }
  return preview
}

/**
 * Total inline-payload byte budget across ONE window.
 *
 * The per-event cap alone still multiplies: 50 events x 400 B is 20 KB of
 * payload before anything else. This is the second half of the byte budget —
 * once the window has spent it, remaining payloads are dropped to a marker
 * rather than previewed, so total cost is bounded by the window and not by the
 * number of events in it.
 */
export const WINDOW_PAYLOAD_BYTE_BUDGET = 8_000

/** How to get what a byte budget cut. Emitted once per window, never per event. */
export const TRUNCATION_NOTE =
  'Some payloads exceeded this tool’s byte budget and were truncated or dropped. Request a narrower window ' +
  '(fewer events via limit, or a closer aroundSequence) to see more of them, or read the artifact pointer ' +
  'directly for externalized payloads.'

/**
 * Apply the per-event and whole-window byte budgets across a window.
 *
 * The event-count cap (`MAX_LIMIT`) caps EVENTS; an agent pays for BYTES, and
 * only this function caps those. Events are budgeted in order, so the events
 * nearest the window start — the ones the caller aimed at — keep their payloads.
 *
 * @returns the rows plus whether anything was cut, so the caller can emit
 *   {@link TRUNCATION_NOTE} exactly when it is true. A caller that is not told
 *   its result was trimmed will read a partial payload as a complete one.
 */
export function budgetEventRows(
  events: Event[],
  options: EventRowOptions = {},
): { rows: EventRow[]; truncated: boolean; derived: boolean; orderUnverified: boolean } {
  let spent = 0
  let truncated = false
  let derived = false
  let orderUnverified = false
  const rows = events.map((event) => {
    const row = toEventRow(event, options)
    if (row.derived !== undefined) derived = true
    // THE ONE-DIRECTIONAL ORDERING PROOF — see ORDERING_UNVERIFIED_BASIS.
    // `analyzeRunOrdering` returns `ingest-unverified` for the whole run iff ANY
    // derived event lacks a usable key, so observing one HERE proves it for the
    // run, even though this is only a window. The converse does not hold and is
    // not claimed.
    if (isDerivedProvenance(event.provenance) && readTemporalOrder(event) === undefined) orderUnverified = true
    if (row.payload === undefined) return row
    const bytes = Buffer.byteLength(JSON.stringify(row.payload) ?? '', 'utf8')
    if (spent + bytes > WINDOW_PAYLOAD_BYTE_BUDGET) {
      truncated = true
      row.payload = { truncated: true, bytes, preview: '' } satisfies PayloadPreview
      return row
    }
    spent += bytes
    if (typeof row.payload === 'object' && row.payload !== null && 'truncated' in row.payload) truncated = true
    return row
  })
  return { rows, truncated, derived, orderUnverified }
}

/** Per-window options for {@link toEventRow} / {@link budgetEventRows}. */
export interface EventRowOptions {
  /**
   * Emit the FULL provenance record on every event that has one. Default
   * `false` — the badge (`derived` / `derivedLossy`) is emitted either way and
   * is not affected by this flag. See {@link EventRow.provenance}.
   */
  includeProvenance?: boolean
}

/**
 * Project one event, replacing an externalized payload with its pointer and an
 * oversized inline payload with a labelled preview.
 *
 * This is the single place the "never inline an artifact payload" rule is
 * enforced. Do not add a branch that reads the blob.
 *
 * @param event - the stored event.
 * @param options - see {@link EventRowOptions}. Optional and additive: an
 *   omitted argument is the default projection, which is what every caller had
 *   before provenance existed.
 */
export function toEventRow(event: Event, options: EventRowOptions = {}): EventRow {
  const row: EventRow = {
    sequenceNumber: event.sequenceNumber,
    type: event.type,
    timestamp: event.timestamp,
  }
  // THE BADGE IS UNCONDITIONAL. It is computed before anything else and is not
  // gated on `options`, because the one thing a caller must never be able to
  // turn off is being told that what it is reading is derived. `lossy` rides
  // with it for the same reason — see EventRow.derivedLossy.
  //
  // `isDerivedProvenance` is the contract's own predicate rather than a local
  // `=== 'otel'`: a third ingest source must become a compiler error at every
  // site, and a re-implemented check here would be the site that silently
  // classified it as native.
  if (isDerivedProvenance(event.provenance)) {
    row.derived = 'otel'
    if (event.provenance.lossy) row.derivedLossy = true
  }
  if (options.includeProvenance === true && event.provenance !== undefined) {
    row.provenance = toProvenanceDetail(event.provenance)
  }
  const payload: unknown = event.payload
  if (isExternalized(payload)) {
    row.artifact = {
      artifactId: payload._artifact.artifactId,
      checksum: payload._artifact.checksum,
      size: payload._artifact.size,
      storageBucket: payload._artifact.storageBucket,
      storageKey: payload._artifact.storageKey,
    }
    row.originalType = payload.originalType
    if (payload.errorSummary !== undefined) row.errorSummary = payload.errorSummary
  } else {
    row.payload = budgetPayload(payload)
  }
  return row
}

// ---------------------------------------------------------------------------
// Compact run rows (orientation)
// ---------------------------------------------------------------------------

/** One run row. Scalars only — no metadata bag, no tags, no labels, no counters. */
export interface RunRow {
  runId: string
  agentId: string
  status: string
  startedAt: number
  endedAt?: number
  environment?: string
  sessionId?: string
}

/**
 * `afr_list_runs`'s column table. Append-only — never reorder.
 *
 * `runId` has a `null` source for two reasons at once: it is the `runs`
 * identity field, which the read API always returns (rule 3), and it is also
 * RENAMED on the way out (`id` on the wire, `runId` in the response) — so the
 * emitted name is not a field name the server would recognize. Requesting it
 * would be both redundant and wrong.
 */
export const RUN_COLUMNS = [
  { column: 'runId', source: null },
  { column: 'agentId', source: 'agentId' },
  { column: 'status', source: 'status' },
  { column: 'startedAt', source: 'startedAt' },
  { column: 'endedAt', source: 'endedAt' },
  { column: 'environment', source: 'environment' },
  { column: 'sessionId', source: 'sessionId' },
] as const satisfies readonly ProjectedColumn<keyof RunRow>[]

/** Column order for the `afr_list_runs` columnar response. DERIVED from {@link RUN_COLUMNS}. */
export const RUN_FIELDS: readonly (keyof RunRow)[] = columnsOf(RUN_COLUMNS)

/** The `fields` selection `afr_list_runs` sends. DERIVED from {@link RUN_COLUMNS}. */
export const RUN_REQUEST_FIELDS: readonly string[] = requestFieldsOf(RUN_COLUMNS)

/** `afr_list_runs` response. Columnar for the same reason tier 1 is — see {@link Columnar}. */
export interface ListRunsResult extends Columnar {
  nextCursor?: string
}

/** Build the columnar run list. */
export function toListRunsResult(runs: Run[], nextCursor: string | undefined): ListRunsResult {
  const result: ListRunsResult = toColumnar(runs.map(toRunRow), RUN_FIELDS)
  if (nextCursor !== undefined) result.nextCursor = nextCursor
  return result
}

/** Project a run onto its compact row. */
export function toRunRow(run: Run): RunRow {
  const row: RunRow = {
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    startedAt: run.startedAt,
  }
  if (run.endedAt !== undefined) row.endedAt = run.endedAt
  if (run.environment !== undefined) row.environment = run.environment
  if (run.sessionId !== undefined) row.sessionId = run.sessionId
  return row
}

// ---------------------------------------------------------------------------
// Version divergence — `afr_assess_version` and `afr_get_run_divergence`
// ---------------------------------------------------------------------------
//
// "If I ship this version, what breaks?" See docs/adr/008-version-divergence-
// analysis.md for the decision record and docs/mcp.md for the caller-facing
// contract.
//
// THE ONE THING THESE PROJECTIONS MAY NOT DO IS FLATTEN PROOF INTO CONJECTURE.
// `packages/contracts/src/divergence.ts` separates the two structurally — two
// mutually-unassignable types, no shared `message` field, no exported union —
// and `packages/sdk/src/reader.ts` re-checks that segregation on the wire,
// because TypeScript's guarantee stops at the JSON boundary.
//
// This layer is where the guarantee is most fragile and most load-bearing. It
// is a TOKEN BUDGET applied to a safety claim, and every compression that would
// help is a compression that costs the distinction:
//
//   - merging the two lists (fits easily, destroys the feature)
//   - dropping `certainty` as redundant with the array it sits in
//   - dropping `coverage` as boring metadata
//   - keeping the prose and dropping the structure, or the reverse
//
// None of them is taken. Where a budget and the distinction conflict, the
// budget gives: cut a finding, cut a sample, cut a sentence — never the
// discriminant, never `coverage`, and never the separation of the arrays.
//
// AN MCP CALLER IS THE REASON THIS IS STRICTER HERE THAN ELSEWHERE. A human in
// the web UI who misreads a speculative finding can click into the run and see
// the difference. An agent holding a tool result cannot. It has these bytes and
// nothing else, and the decision it makes from them may be a deploy.

/**
 * Byte caps on the free-text fields of a finding.
 *
 * BYTES, NOT ITEMS, for the reason {@link CITED_SEQUENCE_BYTE_CAP} spells out
 * at length: an item cap bounds a field only for as long as items happen to be
 * small, and nothing bounds how long an engine-written claim can get. The
 * engine's own sentences are one line by construction, so these caps admit
 * realistic output untouched and cut only a runaway.
 *
 * `speculativeBecause` gets the smallest cap of the three deliberately: it is
 * the most formulaic of the sentences ("recorded history cannot show what a
 * different prompt would have produced") and the least likely to carry a
 * detail unique to this finding.
 */
export const PROVEN_CLAIM_BYTE_CAP = 180
export const SPECULATIVE_CONCERN_BYTE_CAP = 160
export const SPECULATIVE_BECAUSE_BYTE_CAP = 130
/**
 * The third bucket's two required strings.
 *
 * `undecidedQuestion` gets the LARGEST prose cap of any field on either tool,
 * and that is deliberate. It is the only field that tells a caller what it does
 * not know, and a truncated question is worse than a truncated claim: a claim
 * cut short is still a claim, whereas "whether the tool calls at sequences…"
 * with the sequences cut off is an unanswerable question about an unidentified
 * thing. If a budget has to give somewhere on this tier, it gives on a proven
 * claim — which the caller can re-read in full from the run — before it gives
 * here.
 */
export const UNDECIDED_QUESTION_BYTE_CAP = 200
export const UNKNOWN_BECAUSE_BYTE_CAP = 130
/** The action that would make an unanswerable question answerable. Generous: a remedy that is cut short is not a remedy. */
export const REMEDY_BYTE_CAP = 160
/** Cap on a coverage entry's optional elaboration. The `reason` code carries the fact; this only names the path. */
export const UNASSESSED_DETAIL_BYTE_CAP = 80

/**
 * How many findings of each kind one run's report emits.
 *
 * SEPARATE CAPS, NOT A SHARED ONE. A shared cap lets a flood of speculative
 * findings evict the proven ones — conjecture crowding out proof, which is this
 * feature's central defect arriving through the back door. With separate caps
 * that is not expressible.
 *
 * Three is not only a budget number. The FIRST proven break is the meaningful
 * one: once a run provably could not have taken a step it recorded, the rest of
 * the recorded trajectory is counterfactual, because the target version was
 * never going to be in that state. Findings are emitted in proof order
 * (earliest cited sequence number first) so the cut always falls on the tail,
 * never on the first break — and whatever is cut is counted, never silently
 * dropped.
 */
export const RUN_PROVEN_CAP = 3
export const RUN_SPECULATIVE_CAP = 3
/**
 * The indeterminate cap, and why it is not smaller than the other two.
 *
 * An indeterminate finding is COMPLETENESS-BEARING: one of them makes
 * `verdict: 'compatible'` unreachable. Cutting this list hardest to save bytes
 * would mean the response most likely to be over budget — a messy analysis — is
 * also the one that under-reports how messy it was. The dropped count is
 * emitted for the same reason.
 */
export const RUN_INDETERMINATE_CAP = 3

/**
 * How many distinct reasons the fleet answer ranks per kind.
 *
 * FOUR, NOT `afr_triage`'s FIVE, and the difference is the third bucket rather
 * than a byte squeeze. Triage ranks one list; this ranks three, so five per
 * kind is fifteen rows, and fifteen rows measured MORE than the per-run
 * drill-down this call exists to make unnecessary — an entry point that costs
 * more than the thing it saves you from is not an entry point. Four per kind
 * keeps twelve rows and keeps the ordering of the ladder true.
 *
 * SEPARATE CAPS PER KIND, for the same reason as {@link RUN_PROVEN_CAP}: a
 * shared cap of twelve would let a version with one broken tool and eleven
 * prompt tweaks push its single PROVEN reason off the end of the list.
 */
export const FLEET_REASON_CAP = 4

/**
 * The fleet tier's own prose cap, much tighter than the per-run caps above.
 *
 * NOT AN ARBITRARY SQUEEZE — the two tiers are answering different questions.
 * The fleet answer is a RANKED HEADLINE: what an agent needs from a row is the
 * certainty class, the kind, the subject, how many runs it accounts for, and
 * the way in. The sentence is a label on that, not the payload; the payload is
 * one hop away in `afr_get_run_divergence`, where the same finding is emitted
 * at four times this width with its proof attached.
 *
 * Fifteen rows at the per-run caps cost more than this entire tool's budget in
 * prose alone, and would buy the same fifteen facts spelled out at length.
 * A truncation marker is emitted in-band by `truncateProse`, so a cut sentence
 * announces itself rather than reading as a complete short one.
 */
export const FLEET_PROSE_BYTE_CAP = 96

/** One recorded event a proof cites, flattened. Positional handle into `afr_get_run_events`. */
interface ProjectedProof {
  /** `sequenceNumber` of the recorded event that could not have happened. */
  at: number
  eventType: string
  /** Path into the TARGET config that decides it. */
  targetPath: string
  /** What the run actually recorded. */
  recorded: string
  /** What the target declares there — `null` means ABSENT, which is itself the proof for every `*_removed` kind. */
  target: string | null
}

/**
 * A proven divergence, projected.
 *
 * `certainty` is emitted even though every element of a `proven` array is
 * trivially proven. THAT REDUNDANCY IS DELIBERATE AND MUST NOT BE OPTIMIZED
 * AWAY. The array name is context; the field is content, and only the field
 * survives an agent lifting one finding out of the response and carrying it
 * into its own reasoning, a log line, or another tool call — which is exactly
 * what an LLM consumer does with a structured result. `packages/contracts`
 * makes the same call on `ProvenDivergenceReason.certainty` and says so.
 *
 * It is also the field a future columnar encoding would delete first: a column
 * whose value is identical in every row looks like pure waste to a byte-counting
 * eye. It is not waste. It is the warrant.
 */
export interface ProjectedProvenDivergence {
  certainty: 'proven'
  kind: string
  /**
   * Which config dimension this belongs to. Emitted on all three finding types
   * so an agent can see that `tools` is provably broken WHILE `budgets` went
   * unanswered — a partial analysis attributed per dimension is actionable, and
   * the same analysis reported as one undifferentiated verdict is a shrug.
   */
  dimension: string
  reasonKey: string
  /** Past tense, about what WAS RECORDED. Safe to gate a deploy on. */
  claim: string
  /** The earliest proof. Further proofs of the same reason are counted, not listed. */
  provenBy: ProjectedProof
  /** Additional cited events beyond the first, when the engine found several. Omitted when there are none. */
  furtherProofs?: number
}

/**
 * A speculative divergence, projected.
 *
 * Note what is NOT here: no `provenBy`, no sequence number presented as
 * evidence, and no field named anything a proof-shaped consumer would read.
 * `possiblyAffectedSequenceNumbers` is dropped entirely at this tier — it is a
 * navigation aid on a surface with room to explain that, and on this surface it
 * is a list of sequence numbers sitting next to a claim, which is the visual
 * shape of a citation. Costing tokens to manufacture the appearance of evidence
 * is the worst available trade.
 */
export interface ProjectedSpeculativeDivergence {
  certainty: 'speculative'
  kind: string
  /** See {@link ProjectedProvenDivergence.dimension}. */
  dimension: string
  reasonKey: string
  /** Phrased as a possibility. Never the past tense. */
  concern: string
  /** Why this cannot be proven from recorded history. Required by the contract, kept here. */
  because: string
  changedPath: string
}

/**
 * A question the analysis could not answer.
 *
 * THE THIRD BUCKET, and the one a token budget is most tempted to delete —
 * it is neither a break nor a caveat, so it reads as metadata. It is not. With
 * only two buckets available an engine that cannot decide a question has three
 * places to put it and all three are lies: as proof (a guess rendered as
 * evidence), as speculation ("could not check" rendered as "checked, only a
 * maybe" — a lie in the safe-looking direction), or dropped. Dropping is the
 * worst, and dropping is exactly what a projection does when it decides two
 * arrays are enough.
 *
 * It is also completeness-bearing: one of these makes `verdict: 'compatible'`
 * unreachable, which means deleting the list here would leave a caller holding
 * an `indeterminate` verdict with nothing on the response explaining why.
 */
export interface ProjectedIndeterminateDivergence {
  certainty: 'indeterminate'
  kind: string
  reasonKey: string
  /** Phrased as the open question. Not a claim, not a concern. */
  question: string
  /** What specifically stopped the analysis. Required by the contract; an unexplained "unknown" gets ignored. */
  because: string
  dimension: string
  /**
   * What would make this answerable, as an action the caller can take.
   *
   * CARRIED, not dropped as advisory prose, and it is the field most worth its
   * bytes on this whole surface. Everything else here tells an autonomous
   * caller what it cannot know; this is the only field that tells it what to DO
   * about that. A dimension that is unanswerable because nobody ever declared
   * it is a FIXABLE state, and an agent that is told so can fix it and ask
   * again — which is the difference between a gate and a dead end. Absent when
   * the engine had no action to offer; never invented here.
   */
  remedy?: string
}

function toProjectedIndeterminate(finding: IndeterminateDivergence): ProjectedIndeterminateDivergence {
  const projected: ProjectedIndeterminateDivergence = {
    certainty: 'indeterminate',
    kind: finding.kind,
    reasonKey: finding.reasonKey,
    question: truncateProse(finding.undecidedQuestion, UNDECIDED_QUESTION_BYTE_CAP),
    because: truncateProse(finding.unknownBecause, UNKNOWN_BECAUSE_BYTE_CAP),
    dimension: finding.dimension,
  }
  if (finding.remedy !== undefined) projected.remedy = truncateProse(finding.remedy, REMEDY_BYTE_CAP)
  return projected
}

/** What the analysis actually examined. NEVER omitted — an empty `proven` list is meaningless without it. */
export interface ProjectedCoverage {
  /**
   * Whether every DIMENSION was reached. Narrower than the response's own
   * `complete` — see {@link RunDivergenceResult.complete} — because a dimension
   * can be fully reached and still leave a specific question unanswerable.
   * Forwards `isDivergenceCoverageComplete` rather than re-deriving it.
   */
  complete: boolean
  assessed: string[]
  unassessed: { dimension: string; reason: string; detail?: string }[]
  eventsExamined: number
  eventHistoryComplete: boolean
}

function toProjectedCoverage(coverage: DivergenceCoverage): ProjectedCoverage {
  return {
    complete: isDivergenceCoverageComplete(coverage),
    assessed: [...coverage.assessed],
    unassessed: coverage.unassessed.map((u) => {
      const entry: { dimension: string; reason: string; detail?: string } = {
        dimension: u.dimension,
        reason: u.reason,
      }
      if (u.detail !== undefined) entry.detail = truncateProse(u.detail, UNASSESSED_DETAIL_BYTE_CAP)
      return entry
    }),
    eventsExamined: coverage.eventsExamined,
    eventHistoryComplete: coverage.eventHistoryComplete,
  }
}

function toProjectedProven(finding: ProvenDivergence): ProjectedProvenDivergence {
  const [first, ...rest] = finding.provenBy
  const projected: ProjectedProvenDivergence = {
    certainty: 'proven',
    kind: finding.kind,
    dimension: finding.dimension,
    reasonKey: finding.reasonKey,
    claim: truncateProse(finding.provenClaim, PROVEN_CLAIM_BYTE_CAP),
    provenBy: {
      at: first.citedEvent.sequenceNumber,
      eventType: first.citedEvent.eventType,
      targetPath: first.targetConfigPath,
      recorded: first.recordedValue,
      target: first.targetValue,
    },
  }
  if (rest.length > 0) projected.furtherProofs = rest.length
  return projected
}

function toProjectedSpeculative(finding: SpeculativeDivergence): ProjectedSpeculativeDivergence {
  return {
    certainty: 'speculative',
    kind: finding.kind,
    dimension: finding.dimension,
    reasonKey: finding.reasonKey,
    concern: truncateProse(finding.speculativeConcern, SPECULATIVE_CONCERN_BYTE_CAP),
    because: truncateProse(finding.speculativeBecause, SPECULATIVE_BECAUSE_BYTE_CAP),
    changedPath: finding.changedConfigPath,
  }
}

/** Earliest cited sequence number on a proven finding — the ordering key, and the cut's safe end. */
function earliestProof(finding: ProvenDivergence): number {
  let earliest = finding.provenBy[0].citedEvent.sequenceNumber
  for (const proof of finding.provenBy) {
    if (proof.citedEvent.sequenceNumber < earliest) earliest = proof.citedEvent.sequenceNumber
  }
  return earliest
}

/** `afr_get_run_divergence` response. */
export interface RunDivergenceResult {
  runId: string
  targetVersionId: string
  /** The version the run actually ran under, or `null` — in which case every speculative dimension is unassessable. */
  baselineVersionId: string | null
  /**
   * `incompatible` | `compatible_with_caveats` | `compatible` | `indeterminate`.
   *
   * Forwarded from the report, which `FlightReader` has already cross-checked
   * against the report's own contents — a server whose verdict contradicts its
   * arrays never reaches this projection. NOT recomputed here: a second
   * derivation of the same rule is a second rule.
   *
   * `indeterminate` is the honest answer, not a hedge, and there is no
   * `"safe"` in the vocabulary at all.
   */
  verdict: DivergenceVerdict
  /** Proven-impossible steps, earliest first. Empty is meaningful ONLY alongside `coverage.complete`. */
  proven: ProjectedProvenDivergence[]
  /** How many proven findings were cut to fit. Present only when something was cut. */
  provenDropped?: number
  /** Config changes that may alter behaviour. Never a gate signal, never evidence. */
  speculative: ProjectedSpeculativeDivergence[]
  speculativeDropped?: number
  /** Questions the analysis could not answer. Non-empty makes `complete` false and `compatible` unreachable. */
  indeterminate: ProjectedIndeterminateDivergence[]
  indeterminateDropped?: number
  /**
   * THE ANTI-FALSE-CLEAN FIELD, pre-derived so no caller reconstructs it wrongly.
   *
   * `isDivergenceAnalysisComplete` in contracts is the single definition, and it
   * is deliberately STRICTER than `coverage.complete`: there are two ways not to
   * have looked — a dimension never reached, and a specific question reached but
   * unanswerable — and both count. A caller that read only `coverage.complete`
   * would call an analysis finished while holding a list of things it could not
   * decide, which is the exact false clean this whole feature is built against.
   *
   * `proven: []` is a statement about the target version ONLY when this is true.
   */
  complete: boolean
  /**
   * ONE OUTCOME PER DIMENSION: `{ tools: 'incompatible', model: 'clean',
   * budgets: 'undeclared', … }`.
   *
   * THE FIELD THAT STOPS A CALLER READING PAST THE VERDICT. A single global
   * verdict collapses six independent questions into one word, and the word is
   * almost always the worst of the six — so a version whose tools are provably
   * fine and whose budgets were never declared reads as one undifferentiated
   * failure, and an agent has no way to see that four dimensions passed
   * cleanly.
   *
   * The two states worth separating carefully are `undeclared` and
   * `unanswered`. Both mean "not checked", but only `undeclared` is the
   * CALLER'S to fix, by publishing a structured snapshot — see the class note
   * on `indeterminate` above. Telling them which is the difference between a
   * shrug and a next step.
   *
   * Derived by contracts' `divergenceByDimension`, never re-folded here: its
   * within-dimension precedence mirrors the global verdict rule (a proof
   * outranks an unanswered question, because a proof does not weaken because
   * something else went unchecked), and a second implementation of that rule
   * is a second rule.
   *
   * Emitted as a state map rather than as the contract's richer
   * `DimensionOutcome[]`: the per-dimension COUNTS are recoverable by filtering
   * the three arrays above on `dimension`, so carrying them here would be the
   * one genuinely redundant thing on this response. The STATE is not
   * recoverable — `undeclared` and `clean` both show zero findings — so the
   * state is what is kept. Every dimension is listed, including the clean ones:
   * an omitted dimension would be indistinguishable from an unlisted one.
   */
  byDimension: Record<string, string>
  coverage: ProjectedCoverage
  /**
   * The handle into tier 4, at the first proven break — the point where the
   * recorded trajectory becomes impossible. Present only when something is
   * proven, because a window around a speculative concern shows an agent a
   * perfectly ordinary event and invites it to read meaning into it.
   */
  next?: { tool: string; args: Record<string, unknown> }
}

/**
 * Project one run's divergence report.
 *
 * @param report - the report, already verified by `FlightReader`.
 */
export function toRunDivergenceResult(report: DivergenceReport): RunDivergenceResult {
  const provenOrdered = [...report.proven].sort((a, b) => earliestProof(a) - earliestProof(b))
  const provenKept = provenOrdered.slice(0, RUN_PROVEN_CAP)
  const speculativeKept = report.speculative.slice(0, RUN_SPECULATIVE_CAP)
  const indeterminateKept = report.indeterminate.slice(0, RUN_INDETERMINATE_CAP)

  const result: RunDivergenceResult = {
    runId: report.runId,
    targetVersionId: report.targetVersionId,
    baselineVersionId: report.baselineVersionId,
    verdict: report.verdict,
    proven: provenKept.map(toProjectedProven),
    speculative: speculativeKept.map(toProjectedSpeculative),
    indeterminate: indeterminateKept.map(toProjectedIndeterminate),
    complete: isDivergenceAnalysisComplete(report),
    byDimension: Object.fromEntries(divergenceByDimension(report).map((d) => [d.dimension, d.state])),
    coverage: toProjectedCoverage(report.coverage),
  }
  if (indeterminateKept.length < report.indeterminate.length) {
    result.indeterminateDropped = report.indeterminate.length - indeterminateKept.length
  }
  if (provenKept.length < provenOrdered.length) result.provenDropped = provenOrdered.length - provenKept.length
  if (speculativeKept.length < report.speculative.length) {
    result.speculativeDropped = report.speculative.length - speculativeKept.length
  }
  const firstBreak = provenOrdered[0]
  if (firstBreak !== undefined) {
    result.next = {
      tool: 'afr_get_run_events',
      args: { runId: report.runId, aroundSequence: earliestProof(firstBreak), limit: 10 },
    }
  }
  return result
}

/** One distinct proven reason across the fleet, projected. */
export interface ProjectedProvenReason {
  certainty: 'proven'
  kind: string
  /**
   * Which config dimension this reason belongs to.
   *
   * On every fleet row, including here, so a caller can group the fleet answer
   * the way an operator actually reads it — "tools is broken, model is fine,
   * budgets was never declared" — instead of scanning twelve reasons for a
   * pattern. There is deliberately NO pre-derived per-dimension roll-up on this
   * tool, unlike `afr_get_run_divergence`: `FleetDivergenceReport` carries no
   * coverage record, so the `undeclared` and `clean` states are not derivable
   * from it, and folding one anyway would mean inventing a second copy of the
   * precedence rule that contracts states must exist exactly once.
   */
  dimension: string
  reasonKey: string
  /** Analysed runs carrying a proven divergence with this `reasonKey`. The ranking key, and the actionable number. */
  runs: number
  /** The exemplar's claim — a real finding from a real run, not a synthesised summary. */
  claim: string
  /** Path into the target config that decides it. */
  targetPath: string
  /**
   * The drill-down, pre-built: one representative run, the same target version.
   * PROVEN REASONS ONLY — see {@link ProjectedSpeculativeReason}.
   */
  next: { tool: string; args: Record<string, unknown> }
}

/**
 * One distinct speculative reason, projected.
 *
 * NO `next`. Not an oversight and not a budget saving: drilling into a
 * representative run for a speculative reason returns the same unprovable
 * sentence one level down, having spent a whole tool call to do it. Handing an
 * agent a pointer implies there is something at the end of it, and here there
 * is not. The absence is the honest answer, and it is stated in the tool
 * description rather than as a per-row field.
 */
export interface ProjectedSpeculativeReason {
  certainty: 'speculative'
  kind: string
  /** See {@link ProjectedProvenReason.dimension}. */
  dimension: string
  reasonKey: string
  runs: number
  concern: string
  changedPath: string
}

/**
 * One distinct question the fleet scan could not answer.
 *
 * Grouped like the other two because "the tool list was unreadable on 300 runs"
 * is one fixable fact about the version, not 300 incidents. No `next`, for the
 * same reason speculative reasons have none — and more strongly here, since the
 * drill-down would return the same unanswerable question one level down.
 */
export interface ProjectedIndeterminateReason {
  certainty: 'indeterminate'
  kind: string
  reasonKey: string
  runs: number
  question: string
  dimension: string
  /** See {@link ProjectedIndeterminateDivergence.remedy}. The one field on a fleet row that is an instruction. */
  remedy?: string
}

/** What the fleet scan covered. Same anti-false-clean role as {@link ProjectedCoverage}. */
export interface ProjectedScanWindow {
  /**
   * From `isFleetScanComplete`: the SCAN neither truncated nor skipped a run.
   * Narrower than the response's own `complete`, which also requires that no
   * question went unanswered.
   */
  complete: boolean
  runsScanned: number
  runsAnalyzed: number
  /** Visited but not analysable. NOT clean — one of four separate ways of not having looked. */
  runsUnassessable: number
  /** Inside the window but never reached, because the execution's own budget ran out. Unexamined is not passed. */
  runsSkippedForBudget: number
  scanTruncated: boolean
  /**
   * PAGES REMAIN — pass it back to continue the scan.
   *
   * Carried because an agent told only "incomplete" can do nothing about it,
   * and this is the one field that turns that into an action. A full, clean
   * first page looks exactly like a finished scan; its presence alone is what
   * says otherwise, and it is already folded into `complete`.
   */
  nextCursor?: string
}

/** `afr_assess_version` response. */
export interface FleetDivergenceResult {
  agentId: string
  targetVersionId: string
  verdict: DivergenceVerdict
  /**
   * Runs with at least one PROVEN divergence.
   *
   * THERE IS NO COMBINED TOTAL HERE, AND THERE MUST NEVER BE ONE. Adding a run
   * count for speculative reasons to this one produces a single headline that
   * reads as proven breakage and mostly is not. The contract refuses to offer
   * the field; this projection refuses to compute it.
   */
  runsWithProvenDivergence: number
  /**
   * THE ANTI-FALSE-CLEAN FIELD for the fleet answer, from
   * `isFleetDivergenceAnalysisComplete` — the scan must be whole AND no
   * question may have gone unanswered. `provenReasons: []` authorises nothing
   * unless this is true.
   */
  complete: boolean
  window: ProjectedScanWindow
  /** Distinct proven reasons, most-affecting first. THE HEADLINE, and the tractable number. */
  provenReasons: ProjectedProvenReason[]
  provenReasonsDropped?: number
  /** Distinct speculative reasons. Not a gate signal. */
  speculativeReasons: ProjectedSpeculativeReason[]
  speculativeReasonsDropped?: number
  /** Distinct unanswerable questions. Non-empty makes `complete` false whatever the other two lists say. */
  indeterminateReasons: ProjectedIndeterminateReason[]
  indeterminateReasonsDropped?: number
}

/**
 * Project an agent's fleet divergence report.
 *
 * @param report - the report, already verified by `FlightReader`.
 */
export function toFleetDivergenceResult(report: FleetDivergenceReport): FleetDivergenceResult {
  const provenKept = report.provenReasons.slice(0, FLEET_REASON_CAP)
  const speculativeKept = report.speculativeReasons.slice(0, FLEET_REASON_CAP)
  const indeterminateKept = report.indeterminateReasons.slice(0, FLEET_REASON_CAP)

  const result: FleetDivergenceResult = {
    agentId: report.agentId,
    targetVersionId: report.targetVersionId,
    verdict: report.verdict,
    runsWithProvenDivergence: report.runsWithProvenDivergence,
    complete: isFleetDivergenceAnalysisComplete(report),
    window: {
      complete: isFleetScanComplete(report.window),
      runsScanned: report.window.runsScanned,
      runsAnalyzed: report.window.runsAnalyzed,
      runsUnassessable: report.window.runsUnassessable,
      runsSkippedForBudget: report.window.runsSkippedForBudget,
      scanTruncated: report.window.scanTruncated,
      ...(report.window.nextCursor !== undefined && { nextCursor: report.window.nextCursor }),
    },
    provenReasons: provenKept.map((reason) => ({
      certainty: 'proven' as const,
      kind: reason.kind,
      dimension: reason.exemplar.dimension,
      reasonKey: reason.reasonKey,
      runs: reason.affectedRunCount,
      claim: truncateProse(reason.exemplar.provenClaim, FLEET_PROSE_BYTE_CAP),
      targetPath: reason.exemplar.provenBy[0].targetConfigPath,
      next: {
        tool: 'afr_get_run_divergence',
        args: { runId: reason.representativeRunIds[0] ?? '', targetVersionId: report.targetVersionId },
      },
    })),
    speculativeReasons: speculativeKept.map((reason) => ({
      certainty: 'speculative' as const,
      kind: reason.kind,
      dimension: reason.exemplar.dimension,
      reasonKey: reason.reasonKey,
      runs: reason.affectedRunCount,
      concern: truncateProse(reason.exemplar.speculativeConcern, FLEET_PROSE_BYTE_CAP),
      changedPath: reason.exemplar.changedConfigPath,
    })),
    indeterminateReasons: indeterminateKept.map((reason) => {
      const row: ProjectedIndeterminateReason = {
        certainty: 'indeterminate',
        kind: reason.kind,
        reasonKey: reason.reasonKey,
        runs: reason.affectedRunCount,
        question: truncateProse(reason.exemplar.undecidedQuestion, FLEET_PROSE_BYTE_CAP),
        dimension: reason.exemplar.dimension,
      }
      if (reason.exemplar.remedy !== undefined) {
        row.remedy = truncateProse(reason.exemplar.remedy, FLEET_PROSE_BYTE_CAP)
      }
      return row
    }),
  }
  if (indeterminateKept.length < report.indeterminateReasons.length) {
    result.indeterminateReasonsDropped = report.indeterminateReasons.length - indeterminateKept.length
  }
  if (provenKept.length < report.provenReasons.length) {
    result.provenReasonsDropped = report.provenReasons.length - provenKept.length
  }
  if (speculativeKept.length < report.speculativeReasons.length) {
    result.speculativeReasonsDropped = report.speculativeReasons.length - speculativeKept.length
  }
  return result
}
