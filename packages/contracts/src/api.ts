import type { Run, Event, Comment } from "./entities.js";
import type { EventType } from "./events.js";
import type { OtelEventProvenance } from "./provenance.js";
import type { RunStatus } from "./status.js";

// ---------------------------------------------------------------------------
// Run endpoints
// ---------------------------------------------------------------------------

export interface CreateRunRequest {
  agentId: string;
  agentVersionId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  triggeredBy?: string;
  sdkVersion?: string;
}

export interface CreateRunResponse {
  run: Run;
}

/**
 * Server-side integrity filter for the runs list, backed by the
 * `verification_results` table (see convex/runs.ts `listRunsByVerification`).
 * "failed"/"passed" reflect the run's latest verification's `isValid`;
 * "unverified" means the run has never been verified. When set, this filter
 * selects the base result set (it wins over pagination source); the other
 * `ListRunsRequest` filters below still narrow within it.
 */
export type VerifyFilter = "failed" | "passed" | "unverified";

export interface ListRunsRequest {
  projectId?: string;
  agentId?: string;
  status?: RunStatus;
  /** Unix ms timestamp. Only runs started at or after this time are returned. */
  startedAfter?: number;
  /** Server-side integrity filter. Omit for no filtering (all runs). */
  verifyFilter?: VerifyFilter;
  limit?: number;
  cursor?: string;
}

export interface ListRunsResponse {
  runs: Run[];
  nextCursor?: string;
  total: number;
}

export interface GetRunResponse {
  run: Run;
  eventCount: number;
  artifactCount: number;
}

// ---------------------------------------------------------------------------
// Event endpoints
// ---------------------------------------------------------------------------

export interface CreateEventRequest {
  runId: string;
  type: EventType;
  sequenceNumber: number;
  timestamp: number;
  payload: import("./events.js").EventPayload;
  parentEventId?: string;
}

export interface CreateEventResponse {
  event: Event;
}

// ---------------------------------------------------------------------------
// OTel-derived event writes
//
// This is where "required" actually bites. `Event.provenance` is optional
// (existing rows have none and the log is append-only, so there is nothing to
// backfill); the invariant is held here instead, on the ONLY contract that
// describes writing a derived event. A derived event with no provenance is not
// a bug to be caught in review — it does not typecheck.
// ---------------------------------------------------------------------------

/**
 * One event derived from one OpenTelemetry span.
 *
 * THE SHAPE THE INGEST MUTATION PRODUCES INTERNALLY, retained because the
 * invariant it encodes is still live and still enforced: a derived event cannot
 * be written without provenance. It is NOT a request body — see
 * {@link IngestOtelSpansRequest} for why sending pre-mapped events is unsafe.
 *
 * `provenance` is REQUIRED and non-optional. Note also that it is typed as
 * {@link OtelEventProvenance}, not {@link EventProvenance}: this path cannot
 * even claim `source: "sdk"`. The ingest mapper is structurally incapable of
 * laundering a derived event into a first-party-looking one.
 *
 * Deliberately does NOT extend `CreateEventRequest`. Sharing the base would
 * let a future optional field added for the SDK path leak silently onto the
 * derived path; these two writers have different obligations and are typed
 * separately on purpose.
 */
export interface OtelDerivedEventWrite {
  runId: string;
  type: EventType;
  sequenceNumber: number;
  timestamp: number;
  payload: import("./events.js").EventPayload;
  parentEventId?: string;
  /** REQUIRED. See the block comment above. */
  provenance: OtelEventProvenance;
}

/**
 * A batch of events derived from one OTel export request.
 *
 * @deprecated NOT IMPLEMENTED, AND NOT IMPLEMENTABLE SAFELY. Use
 * {@link IngestOtelSpanBatchRequest}, which sends SPANS and maps them inside
 * the mutation.
 *
 * THE ARCHITECTURE THIS TYPE DESCRIBES WAS TRIED AND REJECTED, and the reason
 * is a correctness one rather than a preference. This shape presumes the
 * span->event mapping and the SEQUENCE SYNTHESIS happened UPSTREAM of the
 * write. But the mapper requires `PriorRunState` — the run's current maximum
 * sequence number and its already-recorded span ids — so mapping upstream means
 * reading that state in one transaction and writing in another. Two concurrent
 * batches for one trace then both read the same maximum and compute the SAME
 * sequence numbers. Under an append-only log that is not a recoverable lost
 * update; it is permanent corruption of the artifact the product exists to make
 * trustworthy.
 *
 * Doing the mapping inside the mutation is what closes it: the max-sequence
 * read and the append are in one transaction, so Convex's OCC invalidates the
 * loser's read set and re-executes it against the winner's writes.
 *
 * Kept only because it is referenced by existing type-level tests. It describes
 * an architecture we deliberately rejected, and a published type doing that is
 * worse than no type — nothing should be implemented against it.
 */
export interface IngestOtelSpansRequest {
  /**
   * Mapped events, plus `otel.span.unmapped` events for spans that matched no
   * rule. Both kinds are ordinary appends carrying OTel provenance — the
   * unmapped ones are RECORDED, never dropped.
   */
  events: OtelDerivedEventWrite[];
}

/**
 * @deprecated Response half of {@link IngestOtelSpansRequest}. Use
 * {@link IngestOtelSpanBatchResponse}, which additionally reports the resolved
 * `runId`, the ordering-relevant diagnostics, and a CLOSED rejection-reason
 * union rather than a bare string.
 */
export interface IngestOtelSpansResponse {
  /** Ids of the events actually appended, in submission order. */
  eventIds: string[];
  /** How many of `eventIds` are `otel.span.unmapped` events. */
  unmappedCount: number;
  /**
   * Spans REJECTED before any append — malformed provenance, a run that is no
   * longer `running`, a sequence-number conflict. Distinct from unmapped: an
   * unmapped span was recorded, a rejected one was not, and a caller must be
   * able to tell those apart rather than inferring silence.
   */
  rejected: Array<{ spanId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// OTel span ingestion — the SPAN-IN request (ADR-007)
//
// {@link IngestOtelSpansRequest} above takes already-derived EVENTS, which
// presumes the span->event mapping and the sequence synthesis happened
// upstream of the write. That shape cannot be made correct: sequence
// allocation, span-level dedupe and trace->run resolution all have to read the
// run's current state, and they have to do it INSIDE the same transaction that
// performs the append, or a concurrent batch invalidates every one of them
// between the read and the write.
//
// So the shipped ingest (`otelIngestSpans`, convex/otel_ingest.ts) takes SPANS
// and does the mapping server-side. These are its types.
// {@link IngestOtelSpansRequest} is retained for the event-shaped contract it
// describes but is NOT the shape the backend accepts.
// ---------------------------------------------------------------------------

/**
 * @deprecated Alias of the canonical {@link OtelSpanInput} in
 * `packages/contracts/src/otel.ts`, kept for one release so existing imports
 * keep resolving. Import `OtelSpanInput` directly.
 */
export type OtelSpanIngestInput = import("./otel.js").OtelSpanInput;

/**
 * One decoded OTLP batch, for exactly ONE trace.
 *
 * `traceId` is explicit rather than inferred from the spans, because it is the
 * RUN KEY. Inferring it would make the key depend on which spans happened to
 * be in the batch, so one malformed batch could attach a trace's spans to a
 * brand-new run. Spans naming a different trace are rejected and reported in
 * {@link IngestOtelSpanBatchResponse.rejected}.
 *
 * There is no `runId`. The backend resolves `(orgId, traceId)` to a run and
 * materializes one on the trace's first batch. A caller-supplied run id would
 * be both unknowable to an OTLP exporter and a cross-org write surface.
 */
export interface IngestOtelSpanBatchRequest {
  /** W3C trace id — 32 lowercase hex chars. The run key, together with the caller's org. */
  traceId: string;
  /**
   * The Agent these spans belong to, in the API key's org. REQUIRED and never
   * derived from span attributes: deriving one from `gen_ai.agent.name` would
   * spray a new Agent per distinct agent string into the org's namespace,
   * keyed on an experimental attribute most instrumentation omits.
   */
  agentId: string;
  /**
   * Optional AgentVersion label, typically the exporter's resource-level
   * `service.version`. Get-or-created on the trace's first batch. When absent
   * the run simply has no version — nothing is synthesized, because an
   * invented "unknown" version would pollute version comparison with a bucket
   * that mixes every un-versioned trace together.
   */
  agentVersion?: string;
  /** Bounded by the backend's per-call span ceiling; an over-sized batch is rejected whole (`BATCH_TOO_LARGE`), never truncated. */
  spans: import("./otel.js").OtelSpanInput[];
}

/** Why a span in the batch was NOT recorded. */
export type OtelSpanRejectionReason =
  /** Span named a different `traceId` than the batch's. */
  | "foreign-trace"
  /** Span was already recorded in this run — a redelivery. Recording it again would permanently double the run. */
  | "already-known"
  /**
   * Arrived after the run was closed. Event Log Rule 5 forbids appending after
   * a terminal event and there is no update mutation, so the span is
   * PERMANENTLY unrecordable.
   *
   * DISTINCT from `already-known`, which is a harmless retry. This is data
   * loss, and it is the reason a caller should surface most loudly: the trace
   * is incomplete and nothing later can complete it.
   */
  | "after-terminal"
  /**
   * A redundant copy of the SAME operation (same name, start and parent). One
   * copy was kept by a deterministic, arrival-order-independent key. NOTHING
   * WAS LOST.
   */
  | "duplicate"
  /**
   * Shared a span id with a DIFFERENT operation. SOMETHING WAS LOST — kept
   * strictly separate from `duplicate` precisely so a lost operation cannot be
   * read as a harmless retry.
   */
  | "span-id-collision"
  /** Span or parent id was not W3C hex. Refused per span, so innocent spans in the batch still land. */
  | "malformed-id"
  /**
   * The span's derived payload exceeded the 10 KB inline limit (Event Log Rule
   * 3) even after the mapper's own attribute bounding, so the span was excluded
   * rather than allowed to refuse the whole batch. Externalize the span's
   * Opt-In content attributes to blob storage and resend.
   */
  | "payload-too-large";

/**
 * A mapper diagnostic, surfaced verbatim so a caller can tell WHY a batch
 * produced the events it did (clock-skew clamps, orphan spans, a missing root)
 * without reading the events back.
 */
export interface OtelIngestDiagnostic {
  code: string;
  /** True if this diagnostic means the batch was refused. */
  fatal: boolean;
  spanIds: string[];
  message: string;
}

export interface IngestOtelSpanBatchResponse {
  /** The run this trace resolved to. Stable across every batch of the trace. */
  runId: string;
  /** True when THIS call materialized the run (the trace's first batch). */
  runCreated: boolean;
  /** Ids of the events actually appended, in sequence order. EMPTY for a pure redelivery. */
  eventIds: string[];
  /** How many of `eventIds` are `otel.span.unmapped` events — RECORDED, never dropped. */
  unmappedCount: number;
  /**
   * Spans NOT recorded. Strictly distinct from unmapped: an unmapped span WAS
   * recorded (as an `otel.span.unmapped` event), a rejected one was not.
   * Conflating them is how a dropped span passes for a recorded one.
   */
  /**
   * CLOSED union, deliberately not widened with `| string`. A caller building
   * an OTLP `ExportTracePartialSuccess` switches on this, and a widened type
   * would let a new backend reason reach the wire as an unhandled default —
   * which is exactly how a lost span passes for a recorded one. Adding a reason
   * is a reviewed contracts change that breaks every incomplete switch, which
   * is the point.
   */
  rejected: Array<{ spanId: string; reason: OtelSpanRejectionReason }>;
  diagnostics: OtelIngestDiagnostic[];
  /** True when no terminal event was emitted — the run is in-progress per Event Log Rule 5. */
  runOpen: boolean;
  terminalType: "run.completed" | "run.failed" | null;
  /** Sequence range appended by this call. Both null for a pure redelivery. */
  firstSequenceNumber: number | null;
  lastSequenceNumber: number | null;
  stats: {
    spansIn: number;
    spansAccepted: number;
    spansMapped: number;
    spansUnmapped: number;
    spansRejected: number;
    eventsOut: number;
    clockSkewClamps: number;
  };
}

export interface ListEventsRequest {
  runId: string;
  limit?: number;
  cursor?: string;
  types?: EventType[];
}

export interface ListEventsResponse {
  events: Event[];
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Comment endpoints
// ---------------------------------------------------------------------------

export interface CreateCommentRequest {
  targetId: string;
  targetType: "run" | "event";
  content: string;
}

export interface CreateCommentResponse {
  comment: Comment;
}

// ---------------------------------------------------------------------------
// Replay and diff endpoints
// ---------------------------------------------------------------------------

export interface GetReplayResponse {
  projection: import("./replay.js").ReplayProjection;
  failureSummary: import("./replay.js").FailureSummary;
}

export interface GetDiffResponse {
  diff: import("./diff.js").RunDiff;
  /** True if the runs cannot be fairly compared (e.g. both in-progress) */
  incomparable: boolean;
  /** Human-readable explanation when incomparable is true */
  incomparableReason?: string;
}

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Cycle 2 (docs/design/action_layer.md) — key-authed read API. The response
// shapes for convex/read_api.ts's apiListRuns/apiGetRun/apiGetRunEvents/
// apiGetReplay, consumed by the CLI and other external, API-key-authenticated
// callers (as opposed to the Clerk-authenticated web UI's ListRunsResponse/
// GetRunResponse/ListEventsResponse/GetReplayResponse above, which these
// deliberately mirror the shape of).
// ---------------------------------------------------------------------------

export interface ApiListRunsRequest {
  status?: RunStatus;
  agentId?: string;
  environment?: string;
  sessionId?: string;
  limit?: number;
  cursor?: string;
}

export interface ApiListRunsResponse {
  runs: Run[];
  nextCursor?: string;
  pageSize: number;
}

export interface ApiGetRunResponse {
  run: Run;
  eventCount: number;
  artifactCount: number;
}

export interface ApiGetRunEventsRequest {
  runId: string;
  limit?: number;
  cursor?: string;
}

export interface ApiGetRunEventsResponse {
  events: Event[];
  nextCursor?: string;
}

export interface ApiGetReplayResponse {
  projection: import("./replay.js").ReplayProjection;
}
