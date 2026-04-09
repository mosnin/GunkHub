export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/** All valid RunStatus values, useful for iteration and validation. */
export const RunStatusValues: RunStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Returns true if the given status is a terminal (non-resumable) state. */
export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
