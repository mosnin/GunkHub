import type { RunDiff, EventDiff, FieldChange } from "@agent-flight-recorder/contracts";
import type { Event } from "@agent-flight-recorder/contracts";

/**
 * Performs deep equality comparison of two values using JSON.stringify.
 *
 * v1 payload comparison uses JSON.stringify deep equality. Field order matters.
 * Acceptable for v1: simple, deterministic, and debuggable without external libraries.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Computes the list of changed fields between two event payloads.
 *
 * Compares the `type` field and all top-level payload keys from either side.
 * Deep equality is determined via JSON.stringify (see note above).
 *
 * @param leftEvent - The event from the left (baseline) run.
 * @param rightEvent - The event from the right (comparison) run.
 * @returns An array of FieldChange entries for every mismatch found.
 */
function computeFieldChanges(leftEvent: Event, rightEvent: Event): FieldChange[] {
  const changes: FieldChange[] = [];

  // Compare the event type field.
  if (leftEvent.type !== rightEvent.type) {
    changes.push({ path: "type", left: leftEvent.type, right: rightEvent.type });
  }

  // Compare top-level payload fields from both sides.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload shape is unknown; we iterate keys and guard accesses below
  const leftPayload = leftEvent.payload as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  const rightPayload = rightEvent.payload as Record<string, any>;

  const allKeys = new Set([
    ...Object.keys(leftPayload),
    ...Object.keys(rightPayload),
  ]);

  for (const key of allKeys) {
    const leftVal: unknown = leftPayload[key];
    const rightVal: unknown = rightPayload[key];
    if (!deepEqual(leftVal, rightVal)) {
      changes.push({ path: `payload.${key}`, left: leftVal, right: rightVal });
    }
  }

  return changes;
}

/**
 * Returns the last event in a sorted event array, or undefined for an empty array.
 * Used to determine the terminal event for statusChanged comparison.
 */
function lastEvent(sorted: Event[]): Event | undefined {
  return sorted[sorted.length - 1];
}

/**
 * Builds a deterministic position-aligned diff of two runs' event logs.
 *
 * Alignment is by sequence position (index), not by event ID or type.
 * sequenceNumber 1 in left corresponds to sequenceNumber 1 in right.
 * This reflects the intent to compare two runs that should have executed
 * the same logical steps, making positional drift visible.
 *
 * @param leftRunId - The ID of the baseline (left) run.
 * @param rightRunId - The ID of the comparison (right) run.
 * @param leftEvents - Event log for the left run. May arrive out of order.
 * @param rightEvents - Event log for the right run. May arrive out of order.
 * @returns A RunDiff describing every position-level difference.
 *
 * Edge cases:
 * - One or both event arrays empty: all events in the non-empty side are "added"/"removed".
 * - "changed" events: both type and payload fields are compared individually.
 * - statusChanged: compares the type of the last event in each run; true when they differ.
 */
export function buildRunDiff(
  leftRunId: string,
  rightRunId: string,
  leftEvents: Event[],
  rightEvents: Event[]
): RunDiff {
  // 1. Sort both arrays by sequenceNumber ascending.
  const leftSorted = [...leftEvents].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const rightSorted = [...rightEvents].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  const maxLen = Math.max(leftSorted.length, rightSorted.length);
  const eventDiffs: EventDiff[] = [];

  let added = 0;
  let removed = 0;
  let changed = 0;
  let same = 0;

  // 3. Align by position up to the longer of the two arrays.
  for (let i = 0; i < maxLen; i++) {
    const leftEvent = leftSorted[i];
    const rightEvent = rightSorted[i];
    // sequenceNumber for labelling: prefer left, then right.
    const sequenceNumber = leftEvent?.sequenceNumber ?? rightEvent?.sequenceNumber ?? i + 1;

    if (leftEvent !== undefined && rightEvent !== undefined) {
      // Both sides present — compare.
      const typeMatch = leftEvent.type === rightEvent.type;
      // v1 payload comparison uses JSON.stringify deep equality. Field order matters. Acceptable for v1.
      const payloadMatch = deepEqual(leftEvent.payload, rightEvent.payload);

      if (typeMatch && payloadMatch) {
        // 3a. Identical.
        eventDiffs.push({ kind: "same", sequenceNumber, leftEvent, rightEvent });
        same++;
      } else {
        // 3b. Structurally different — record field-level changes.
        const changes = computeFieldChanges(leftEvent, rightEvent);
        eventDiffs.push({ kind: "changed", sequenceNumber, leftEvent, rightEvent, changes });
        changed++;
      }
    } else if (leftEvent !== undefined) {
      // 3c. Present in left only.
      eventDiffs.push({ kind: "removed", sequenceNumber, leftEvent });
      removed++;
    } else if (rightEvent !== undefined) {
      // 3d. Present in right only.
      eventDiffs.push({ kind: "added", sequenceNumber, rightEvent });
      added++;
    }
  }

  // 5. statusChanged: compare terminal events (last event of each run).
  const leftLast = lastEvent(leftSorted);
  const rightLast = lastEvent(rightSorted);
  const statusChanged = leftLast?.type !== rightLast?.type;

  const summary = { added, removed, changed, same, statusChanged };

  return { leftRunId, rightRunId, eventDiffs, summary };
}
