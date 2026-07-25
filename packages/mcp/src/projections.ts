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
import type {
  Event,
  ExternalizedPayload,
  FailurePattern,
  PatternResolutionEvidence,
  Run,
  RunExplanation,
} from '@agent-flight-recorder/contracts'
import type { FixConfidenceEntry, V1ListFixConfidenceEnvelope } from '@agent-flight-recorder/sdk'

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
 * One column of a projection, paired with the SOURCE DOCUMENT FIELD it reads.
 *
 * WHY THE PAIRING EXISTS. Every tool here now asks the read API for exactly the
 * columns it will emit (`fields` — convex/read_api.ts §FIELD PROJECTION). The
 * requested list and the emitted list are the same fact stated twice, and two
 * lists that can disagree are precisely the drift this pairing exists to
 * prevent:
 *
 *   - a column added to the projection but not to the request reads
 *     `undefined` on every row, and an all-`undefined` column is dropped by
 *     {@link toColumnar} — so it disappears silently rather than failing;
 *   - a name that is wrong in the other direction is worse than silent: the
 *     read API's rule 2 makes an UNKNOWN FIELD A HARD ERROR, so a stale entry
 *     fails the whole call rather than one column.
 *
 * So the list is written ONCE, per projection, and both the columnar header
 * ({@link columnsOf}) and the request ({@link requestFieldsOf}) are derived
 * from it. Neither is ever written out by hand a second time.
 */
export interface ProjectedColumn<C extends string> {
  /** The column name this projection emits. */
  readonly column: C
  /**
   * The document field this column's value is read from, or `null` when the
   * value does not come from the projected document at all — an identity field
   * the server returns whether or not it was asked for (read API rule 3), or a
   * value joined in from a separate envelope. A `null` source is never
   * requested: asking for the identity field would be redundant, and asking for
   * a field the document does not have would be the hard error above.
   */
  readonly source: string | null
}

/** The emitted column names, in order. The columnar header. */
export function columnsOf<C extends string>(columns: readonly ProjectedColumn<C>[]): C[] {
  return columns.map((column) => column.column)
}

/**
 * The `fields` selection to send for a projection: every distinct non-null
 * source, deduped (several columns can read one field — the artifact pointer,
 * `originalType` and `errorSummary` all come out of `payload`).
 *
 * Order is declaration order, deduped. It is not sorted: the read API accepts
 * any order, and preserving declaration order keeps a request diff readable
 * against the column table it came from.
 */
export function requestFieldsOf(columns: readonly ProjectedColumn<string>[]): string[] {
  const sources = new Set<string>()
  for (const column of columns) {
    if (column.source !== null) sources.add(column.source)
  }
  return [...sources]
}

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
 */
export function toListPatternsResult(
  patterns: FailurePattern[],
  envelope: V1ListFixConfidenceEnvelope | undefined,
  nextCursor: string | undefined,
): ListPatternsResult {
  const byHash = new Map<string, FixConfidenceEntry>()
  for (const entry of envelope?.entries ?? []) byHash.set(entry.fingerprintHash, entry)

  const rows = patterns.map((p) => toPatternRow(p, byHash.get(p.fingerprintHash)))
  const result: ListPatternsResult = toColumnar(rows, PATTERN_FIELDS)
  if (nextCursor !== undefined) result.nextCursor = nextCursor

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
 * Truncate to a byte budget with an EXPLICIT, IN-BAND marker.
 *
 * Silent truncation is the failure mode to avoid: an agent reading a cut-off
 * root cause as a complete one draws a confident conclusion from half a
 * sentence. The marker states how much is missing, and `afr_get_run_events`
 * remains the way to get the underlying detail.
 */
export function truncateProse(text: string, byteCap: number): string {
  if (Buffer.byteLength(text, 'utf8') <= byteCap) return text
  // Slice by code points, then trim until the UTF-8 length fits, so a
  // multi-byte character is never cut in half.
  let cut = Array.from(text).slice(0, byteCap)
  while (Buffer.byteLength(cut.join(''), 'utf8') > byteCap) cut = cut.slice(0, -1)
  const kept = cut.join('')
  return `${kept}…[truncated, ${String(Array.from(text).length - cut.length)} more chars]`
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
  summary?: string
  rootCause?: string
  suggestedFix?: string
  failureClass?: string
  /** Kind of generator: 'heuristic' or 'llm'. Present when `status` is 'ready'. */
  kind?: string
  /**
   * Event `sequenceNumber`s in this run's log that the explanation cites — the
   * handle into tier 4. Pass one as `aroundSequence` to `afr_get_run_events`.
   */
  citedSequenceNumbers?: number[]
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
  if (explanation === null) return result

  result.summary = truncateProse(explanation.summary, SUMMARY_BYTE_CAP)
  result.rootCause = truncateProse(explanation.rootCause, ROOT_CAUSE_BYTE_CAP)
  if (explanation.suggestedFix !== undefined) {
    result.suggestedFix = truncateProse(explanation.suggestedFix, SUGGESTED_FIX_BYTE_CAP)
  }
  result.failureClass = explanation.failureClass
  result.kind = explanation.kind
  result.citedSequenceNumbers = explanation.citedSequenceNumbers
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

/** One event in a window. */
export interface EventRow {
  sequenceNumber: number
  type: string
  timestamp: number
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
export function budgetEventRows(events: Event[]): { rows: EventRow[]; truncated: boolean } {
  let spent = 0
  let truncated = false
  const rows = events.map((event) => {
    const row = toEventRow(event)
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
  return { rows, truncated }
}

/**
 * Project one event, replacing an externalized payload with its pointer and an
 * oversized inline payload with a labelled preview.
 *
 * This is the single place the "never inline an artifact payload" rule is
 * enforced. Do not add a branch that reads the blob.
 */
export function toEventRow(event: Event): EventRow {
  const row: EventRow = {
    sequenceNumber: event.sequenceNumber,
    type: event.type,
    timestamp: event.timestamp,
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
