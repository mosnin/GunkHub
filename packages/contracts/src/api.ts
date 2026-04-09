import type { Run, Event, Comment } from "./entities.js";

// POST /api/runs
export interface CreateRunRequest {
  agentId: string;
  agentVersionId?: string;
  projectId: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}
export interface CreateRunResponse { runId: string; }

// GET /api/runs
export interface ListRunsRequest { projectId?: string; agentId?: string; status?: string; limit?: number; cursor?: string; }
export interface ListRunsResponse { runs: Run[]; nextCursor?: string; total: number; }

// GET /api/runs/[id]
export interface GetRunResponse { run: Run; eventCount: number; }

// GET /api/runs/[id]/events
export interface ListEventsRequest { limit?: number; cursor?: string; afterSeq?: number; }
export interface ListEventsResponse { events: Event[]; nextCursor?: string; hasMore: boolean; }

// POST /api/events
export interface IngestEventsRequest {
  runId: string;
  events: IngestEvent[];
}
export interface IngestEvent {
  type: string;
  category: string;
  sequence: number;
  timestamp: number;
  payload: unknown;
  parentEventId?: string;
  metadata?: Record<string, unknown>;
}
export interface IngestEventsResponse { accepted: number; runId: string; }

// POST /api/comments
export interface CreateCommentRequest { runId: string; eventId?: string; content: string; }
export interface CreateCommentResponse { comment: Comment; }

// Shared error shape
export interface ApiError { error: string; code: string; details?: unknown; }
