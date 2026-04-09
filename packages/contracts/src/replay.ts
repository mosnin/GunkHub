import type { Event, Run } from "./entities.js";

// Replay is a READ-ONLY projection of the event log. Never writes events.
export interface ReplayState {
  readonly run: Run;
  readonly events: Event[];
  readonly currentSeq: number;
  readonly totalEvents: number;
  readonly isComplete: boolean;
}

export interface ReplayStep {
  readonly event: Event;
  readonly seq: number;
  readonly deltaMs: number;  // ms since previous event
  readonly cumulativeMs: number; // ms since run start
}

export type ReplayDirection = "forward" | "backward";

export interface ReplayConfig {
  readonly speed: number;         // 1 = realtime, 2 = 2x, 0.5 = half
  readonly startSeq?: number;
  readonly endSeq?: number;
  readonly pauseOnError: boolean;
}
