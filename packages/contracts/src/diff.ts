import type { Event } from "./entities.js";

export type DiffKind = "added" | "removed" | "changed" | "same";

export interface FieldChange {
  path: string;
  left: unknown;
  right: unknown;
}

export interface EventDiff {
  kind: DiffKind;
  sequenceNumber: number;
  leftEvent?: Event;
  rightEvent?: Event;
  changes?: FieldChange[];
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  same: number;
  statusChanged: boolean;
}

export interface RunDiff {
  leftRunId: string;
  rightRunId: string;
  eventDiffs: EventDiff[];
  summary: DiffSummary;
}
