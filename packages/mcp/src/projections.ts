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
import { isDerivedProvenance } from '@agent-flight-recorder/contracts'
import {
  columnsOf,
  isPatternScanComplete,
  requestFieldsOf,
  truncateProse,
} from '@agent-flight-recorder/sdk'

import type {
  Event,
  EventProvenance,
  ExternalizedPayload,
  FailurePattern,
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

/** The `fields` selection `afr_get_run_events` sends. DERIVED from {@link EVENT_COLUMNS}. */
export const EVENT_REQUEST_FIELDS: readonly string[] = requestFieldsOf(EVENT_COLUMNS)

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
): { rows: EventRow[]; truncated: boolean; derived: boolean } {
  let spent = 0
  let truncated = false
  let derived = false
  const rows = events.map((event) => {
    const row = toEventRow(event, options)
    if (row.derived !== undefined) derived = true
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
  return { rows, truncated, derived }
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
