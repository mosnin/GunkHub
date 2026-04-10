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

export interface ListRunsRequest {
  projectId?: string;
  agentId?: string;
  status?: RunStatus;
  /** Unix ms timestamp. Only runs started at or after this time are returned. */
  startedAfter?: number;
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
