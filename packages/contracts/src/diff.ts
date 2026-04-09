import type { Run, Event } from "./entities.js";

// Diff is a READ-ONLY comparison projection. Never writes events.
export interface DiffResult {
  readonly runA: Run;
  readonly runB: Run;
  readonly summary: DiffSummary;
  readonly eventDiffs: EventDiff[];
}

export interface DiffSummary {
  readonly addedEvents: number;
  readonly removedEvents: number;
  readonly changedEvents: number;
  readonly totalA: number;
  readonly totalB: number;
  readonly durationDeltaMs: number;
  readonly statusChanged: boolean;
}

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface EventDiff {
  readonly status: DiffStatus;
  readonly eventA?: Event;
  readonly eventB?: Event;
  readonly changes?: FieldChange[];
}

export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}
