import type { Event } from "./entities.js";
import type { Run } from "./entities.js";

// ---------------------------------------------------------------------------
// Replay projection — derived read-only view over the event log.
// Never mutated back to the source. Rebuilt on demand from canonical events.
// ---------------------------------------------------------------------------

/**
 * Actor category derived from event type prefix.
 * Used for colour-coding and grouping in the replay UI.
 */
export type ReplayActor = "agent" | "llm" | "tool" | "memory" | "retrieval" | "http" | "system" | "unknown";

/**
 * Frame-level status derived from event type.
 * "error" means this event represents a failure.
 * "terminal" means this event ends the run.
 */
export type FrameStatus = "ok" | "error" | "terminal" | "in_progress";

/**
 * A single step in the replay projection.
 * All fields are derived from the canonical Event — none are stored separately.
 */
export interface ReplayFrame {
  /** The canonical event this frame represents */
  event: Event;
  /** Zero-based position in the frames array */
  index: number;
  /** Milliseconds since the first event in the run */
  elapsed_ms: number;
  /** Actor category derived from event.type prefix */
  actor: ReplayActor;
  /** Frame status derived from event.type */
  status: FrameStatus;
  /** Short human-readable summary of the event payload (≤80 chars) */
  payloadPreview: string;
  /**
   * Nesting depth based on parentEventId chain (root = 0).
   * Used for visual indentation. Capped at MAX_REPLAY_DEPTH.
   */
  depth: number;
}

/**
 * A read-only projection of a run's event stream for replay purposes.
 * This is a projection type only — it must never be mutated back to the source.
 */
export interface ReplayProjection {
  runId: string;
  frames: ReplayFrame[];
  totalEvents: number;
  /** Wall-clock duration from first event timestamp to last event timestamp */
  duration_ms: number;
  /** Whether the run has a terminal event (completed, failed, cancelled) */
  isComplete: boolean;
  /** Whether the run terminated with a failure */
  isFailed: boolean;
  /**
   * True when the event log exceeds the MAX_EVENTS_PER_REPLAY limit and only the
   * first N events were included in this projection. The caller should surface a
   * warning to the user. Non-breaking additive field — defaults to false/absent.
   */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Failure summary — deterministic heuristic, not AI inference.
// Identifies likely failure points from the canonical event sequence.
// ---------------------------------------------------------------------------

export type FailureReason =
  | "error_event"       // An *.error event type was found
  | "run_failed"        // run.failed or RUN_FAILED terminal event
  | "failed_llm"        // llm.error event
  | "failed_tool"       // tool.error event
  | "missing_completion"; // Run has started events but no terminal event

/**
 * A single identified failure point in the event log.
 */
export interface FailurePoint {
  /** Event ID from the canonical event log */
  eventId: string;
  sequenceNumber: number;
  type: string;
  /** Error message extracted from the event payload, if available */
  errorMessage?: string;
  /** Parent event ID from the canonical event, enabling causal chain tracing */
  parentEventId?: string;
  /** Why this was identified as a failure point */
  reason: FailureReason;
}

/**
 * Deterministic failure summary for a run.
 * All conclusions are derived from explicit event data only.
 * Never claims certainty beyond what the event log shows.
 */
export interface FailureSummary {
  /** True if any failure indicators were found */
  hasFailure: boolean;
  /**
   * The most likely primary failure point.
   * For failed runs: the first *.error event, or the run.failed event.
   * null when the run is still in progress or succeeded.
   */
  primaryFailure: FailurePoint | null;
  /** All identified failure points in sequence order */
  allFailurePoints: FailurePoint[];
  /** True if the run has no terminal event (still in progress or interrupted) */
  isIncomplete: boolean;
  /**
   * True when the system cannot infer a root cause.
   * Example: run.failed event exists but has no payload error message.
   */
  cannotInfer: boolean;
  /** Run metadata included for context */
  runId: string;
  runStatus: Run["status"];
}
