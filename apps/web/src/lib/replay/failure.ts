import type { FailureSummary, FailurePoint, FailureReason } from "@agent-flight-recorder/contracts";
import type { Event, Run } from "@agent-flight-recorder/contracts";

/**
 * Extracts an error message string from an event payload using a best-effort
 * heuristic. Checks `payload.error.message` first, then `payload.message`.
 * Returns undefined when no message is found, per the "never invent" rule.
 */
function extractErrorMessage(payload: unknown): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload shape is unknown at runtime; all field accesses are guarded
  const p = payload as Record<string, any>;

  const errorMsg = (p["error"] as Record<string, unknown> | undefined)?.["message"];
  if (typeof errorMsg === "string" && errorMsg.length > 0) return errorMsg;

  const directMsg = p["message"];
  if (typeof directMsg === "string" && directMsg.length > 0) return directMsg;

  return undefined;
}

/**
 * Returns true if the event type is a specific LLM error variant.
 */
function isLlmError(type: string): boolean {
  return type === "llm.error" || type === "LLM_ERROR";
}

/**
 * Returns true if the event type is a specific tool error variant.
 */
function isToolError(type: string): boolean {
  return type === "tool.error" || type === "TOOL_ERROR";
}

/**
 * Returns true if the event type is the terminal run-failed event.
 */
function isRunFailed(type: string): boolean {
  return type === "run.failed" || type === "RUN_FAILED";
}

/**
 * Returns true if the event type contains ".error" or "_ERROR" (case-insensitive),
 * indicating a generic error event.
 */
function isErrorEvent(type: string): boolean {
  const lower = type.toLowerCase();
  return lower.includes(".error") || lower.includes("_error");
}

/**
 * Determines the FailureReason for a given event type.
 *
 * Priority order (highest to lowest specificity):
 * 1. "failed_llm"  — llm.error / LLM_ERROR
 * 2. "failed_tool" — tool.error / TOOL_ERROR
 * 3. "error_event" — any *.error or *_ERROR event
 * 4. "run_failed"  — run.failed / RUN_FAILED terminal event
 *
 * Returns null if the event is not a failure indicator.
 */
function resolveReason(type: string): FailureReason | null {
  if (isLlmError(type)) return "failed_llm";
  if (isToolError(type)) return "failed_tool";
  if (isErrorEvent(type)) return "error_event";
  if (isRunFailed(type)) return "run_failed";
  return null;
}

/**
 * Builds a deterministic failure summary from a run and its event log.
 *
 * All conclusions are derived exclusively from the canonical event sequence.
 * No AI inference or probability is involved. The function never fabricates
 * error messages or failure causes that aren't present in the event data.
 *
 * @param run - The run record, used for status and ID context.
 * @param events - The full event log for the run. May arrive out of order.
 * @returns A FailureSummary describing the failure landscape of the run.
 *
 * Edge cases:
 * - Empty event array with a "failed" run status: hasFailure=true, cannotInfer=true.
 * - In-progress run (status "running"/"pending"): isIncomplete=true, no primaryFailure.
 * - Multiple error events: all are collected; the first (by sequenceNumber) is primary.
 * - run.failed with no payload error message: cannotInfer=true if no other failure found.
 */
export function buildFailureSummary(run: Run, events: Event[]): FailureSummary {
  // 1. Sort by sequenceNumber ascending.
  const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  // 2–3. Identify all failure points.
  // run.failed is tracked separately for priority logic but is still in allFailurePoints.
  const allFailurePoints: FailurePoint[] = [];
  let runFailedPoint: FailurePoint | null = null;

  for (const event of sorted) {
    const reason = resolveReason(event.type);
    if (reason === null) continue;

    const errorMessage = extractErrorMessage(event.payload);

    const point: FailurePoint = {
      eventId: event.id,
      sequenceNumber: event.sequenceNumber,
      type: event.type,
      reason,
      ...(errorMessage !== undefined && { errorMessage }),
      ...(event.parentEventId !== undefined && { parentEventId: event.parentEventId }),
    };

    allFailurePoints.push(point);

    if (reason === "run_failed") {
      runFailedPoint = point;
    }
  }

  // 4. primaryFailure: first non-run_failed failure point (by sequenceNumber),
  // falling back to run.failed if no other failure exists.
  const nonRunFailedPoints = allFailurePoints.filter((p) => p.reason !== "run_failed");
  const primaryFailure: FailurePoint | null =
    nonRunFailedPoints[0] ?? runFailedPoint ?? null;

  // 5. isIncomplete: run is still active (no terminal status).
  const isIncomplete = run.status === "running" || run.status === "pending";

  // 6. cannotInfer: run status is "failed" but no failure events were found in the log.
  const cannotInfer = run.status === "failed" && allFailurePoints.length === 0;

  // 7. hasFailure: any failure points found, or run.status is "failed".
  const hasFailure = allFailurePoints.length > 0 || run.status === "failed";

  return {
    hasFailure,
    primaryFailure,
    allFailurePoints,
    isIncomplete,
    cannotInfer,
    runId: run.id,
    runStatus: run.status,
  };
}
