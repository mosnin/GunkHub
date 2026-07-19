import type { Run, Event, Comment } from "./entities.js";
import type { EventType } from "./events.js";
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
