import type { Event } from "./entities.js";

export interface ReplayFrame {
  event: Event;
  index: number;
  elapsed_ms: number;
}

/**
 * A read-only projection of a run's event stream for replay purposes.
 * This is a projection type only — it must never be mutated back to the source.
 */
export interface ReplayProjection {
  runId: string;
  frames: ReplayFrame[];
  totalEvents: number;
  duration_ms: number;
}
