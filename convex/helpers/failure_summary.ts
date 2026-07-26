/**
 * ADR-004 / mirrors `apps/web/src/lib/replay/failure.ts`'s `buildFailureSummary`
 * (UI-owned, pure, operates on `@agent-flight-recorder/contracts` `Run`/`Event`
 * types). Convex cannot import from `apps/web` (cross-package boundary — same
 * rationale documented in `convex/helpers/notifier.ts` and
 * `convex/helpers/delivery.ts`: a `convex/` -> `apps/web/` import is fragile
 * and untested), so this file duplicates the deterministic derivation logic
 * against a minimal, dependency-free run/event shape (same pattern as
 * `EvalRunLike`/`EvalEventLike` in `convex/helpers/evals.ts`).
 *
 * KEEP IN SYNC with `apps/web/src/lib/replay/failure.ts`. All conclusions are
 * derived exclusively from the canonical event sequence — this function never
 * fabricates an error message or failure cause that isn't present in the
 * event data, which is the load-bearing property the "Why did this fail?"
 * feature depends on (ADR-004: "grounded ... never assert beyond the trace").
 */

export type FailureRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface FailureRunLike {
  id: string;
  status: FailureRunStatus;
}

export interface FailureEventLike {
  id: string;
  sequenceNumber: number;
  type: string;
  payload?: unknown;
  parentEventId?: string;
}

export type FailureReason = "failed_llm" | "failed_tool" | "error_event" | "run_failed";

export interface FailurePoint {
  eventId: string;
  sequenceNumber: number;
  type: string;
  reason: FailureReason;
  errorMessage?: string;
  parentEventId?: string;
}

export interface FailureSummary {
  hasFailure: boolean;
  primaryFailure: FailurePoint | null;
  allFailurePoints: FailurePoint[];
  isIncomplete: boolean;
  cannotInfer: boolean;
  runId: string;
  runStatus: FailureRunStatus;
}

/** Best-effort error-message extraction. Mirrors failure.ts's extractErrorMessage exactly. */
function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;

  const err = p["error"];
  if (err && typeof err === "object") {
    const msg = (err as Record<string, unknown>)["message"];
    if (typeof msg === "string" && msg.length > 0) return msg;
  }

  const directMsg = p["message"];
  if (typeof directMsg === "string" && directMsg.length > 0) return directMsg;

  return undefined;
}

function isLlmError(type: string): boolean {
  return type === "llm.error" || type === "LLM_ERROR";
}

function isToolError(type: string): boolean {
  return type === "tool.error" || type === "TOOL_ERROR";
}

function isRunFailed(type: string): boolean {
  return type === "run.failed" || type === "RUN_FAILED";
}

function isErrorEvent(type: string): boolean {
  const lower = type.toLowerCase();
  return lower.includes(".error") || lower.includes("_error");
}

function resolveReason(type: string): FailureReason | null {
  if (isLlmError(type)) return "failed_llm";
  if (isToolError(type)) return "failed_tool";
  if (isErrorEvent(type)) return "error_event";
  if (isRunFailed(type)) return "run_failed";
  return null;
}

/**
 * Builds a deterministic failure summary from a run and its (bounded) event
 * log. See the module doc comment — this is a dependency-free mirror of
 * `apps/web/src/lib/replay/failure.ts`'s `buildFailureSummary`.
 */
export function buildFailureSummary(
  run: FailureRunLike,
  events: FailureEventLike[],
): FailureSummary {
  const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

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
    if (reason === "run_failed") runFailedPoint = point;
  }

  const nonRunFailedPoints = allFailurePoints.filter((p) => p.reason !== "run_failed");
  const primaryFailure: FailurePoint | null = nonRunFailedPoints[0] ?? runFailedPoint ?? null;

  const isIncomplete = run.status === "running" || run.status === "pending";
  const cannotInfer = run.status === "failed" && allFailurePoints.length === 0;
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
