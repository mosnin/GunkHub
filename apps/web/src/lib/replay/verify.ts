import { buildFailureSummary } from "./failure";
import { buildReplayProjection } from "./projection";

import type { Event, FailureSummary, ReplayProjection, Run } from "@agent-flight-recorder/contracts";

export interface ProjectionVerifyResult {
  runId: string;
  eventCount: number;
  isValid: boolean;
  /** Sequence numbers that are missing (gaps in 1..max) */
  sequenceGaps: number[];
  /** Sequence numbers that appear more than once */
  duplicateSequenceNumbers: number[];
  projection: ReplayProjection | null;
  failureSummary: FailureSummary | null;
  /** Errors encountered during verification */
  errors: string[];
  /** Human-readable summary of the verification result */
  summary: string;
}

/**
 * Verify the integrity of a run's projection by checking:
 * 1. Sequence numbers are contiguous starting from 1
 * 2. No duplicate sequence numbers
 * 3. buildReplayProjection produces a valid result (doesn't throw)
 * 4. buildFailureSummary produces a valid result (doesn't throw)
 * 5. Frame count matches event count
 * 6. Total events in projection matches input events length
 *
 * This function is PURE — no side effects, no network calls.
 * It can be run on any set of events to verify their integrity.
 */
export function verifyProjectionIntegrity(run: Run, events: Event[]): ProjectionVerifyResult {
  const errors: string[] = [];
  const sequenceGaps: number[] = [];
  const duplicateSequenceNumbers: number[] = [];

  // --- 1. Check for duplicate sequence numbers ---
  const seqCounts = new Map<number, number>();
  for (const event of events) {
    const count = seqCounts.get(event.sequenceNumber) ?? 0;
    seqCounts.set(event.sequenceNumber, count + 1);
  }
  for (const [seq, count] of seqCounts) {
    if (count > 1) {
      duplicateSequenceNumbers.push(seq);
    }
  }
  duplicateSequenceNumbers.sort((a, b) => a - b);

  // --- 2. Check for sequence number gaps (1..max must be contiguous) ---
  if (events.length > 0) {
    let maxSeq = 0;
    for (const event of events) {
      if (event.sequenceNumber > maxSeq) maxSeq = event.sequenceNumber;
    }
    for (let n = 1; n <= maxSeq; n++) {
      if (!seqCounts.has(n)) {
        sequenceGaps.push(n);
      }
    }
  }

  if (duplicateSequenceNumbers.length > 0) {
    errors.push(
      `Duplicate sequence numbers: [${duplicateSequenceNumbers.join(", ")}]`
    );
  }
  if (sequenceGaps.length > 0) {
    errors.push(
      `Sequence gaps: [${sequenceGaps.join(", ")}]`
    );
  }

  // --- 3. Build replay projection (safe) ---
  let projection: ReplayProjection | null = null;
  try {
    projection = buildReplayProjection(run, events);

    // 5. Frame count must match event count
    if (projection.frames.length !== events.length) {
      errors.push(
        `Frame count mismatch: projection has ${projection.frames.length} frames but ${events.length} events were provided`
      );
    }

    // 6. totalEvents must match input length
    if (projection.totalEvents !== events.length) {
      errors.push(
        `totalEvents mismatch: projection reports ${projection.totalEvents} but ${events.length} events were provided`
      );
    }
  } catch (err) {
    errors.push(
      `buildReplayProjection threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // --- 4. Build failure summary (safe) ---
  let failureSummary: FailureSummary | null = null;
  try {
    failureSummary = buildFailureSummary(run, events);
  } catch (err) {
    errors.push(
      `buildFailureSummary threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const isValid =
    sequenceGaps.length === 0 &&
    duplicateSequenceNumbers.length === 0 &&
    errors.length === 0;

  // --- Build human-readable summary ---
  let summary: string;
  if (isValid) {
    summary = `OK: ${events.length} events, no gaps, projection valid`;
  } else {
    const parts: string[] = [];
    if (sequenceGaps.length > 0) {
      parts.push(
        `${sequenceGaps.length} sequence gap${sequenceGaps.length === 1 ? "" : "s"} [${sequenceGaps.join(", ")}]`
      );
    }
    if (duplicateSequenceNumbers.length > 0) {
      parts.push(
        `${duplicateSequenceNumbers.length} duplicate${duplicateSequenceNumbers.length === 1 ? "" : "s"} [${duplicateSequenceNumbers.join(", ")}]`
      );
    }
    // Include any other errors (throw, mismatch) not already covered above
    const otherErrors = errors.filter(
      (e) => !e.startsWith("Duplicate sequence") && !e.startsWith("Sequence gaps")
    );
    for (const e of otherErrors) {
      parts.push(e);
    }
    summary = `INVALID: ${parts.join(", ")}`;
  }

  return {
    runId: run.id,
    eventCount: events.length,
    isValid,
    sequenceGaps,
    duplicateSequenceNumbers,
    projection,
    failureSummary,
    errors,
    summary,
  };
}
