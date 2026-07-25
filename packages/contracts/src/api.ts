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
 * Batched because OTLP arrives batched, and because the unmapped-span count
 * below is only meaningful per batch.
 */
export interface IngestOtelSpansRequest {
  /**
   * Mapped events, plus `otel.span.unmapped` events for spans that matched no
   * rule. Both kinds are ordinary appends carrying OTel provenance — the
   * unmapped ones are RECORDED, never dropped.
   */
  events: OtelDerivedEventWrite[];
}

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
