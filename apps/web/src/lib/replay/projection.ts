import type { Event, FrameStatus, ReplayActor, ReplayFrame, ReplayProjection, Run } from "@agent-flight-recorder/contracts";

/**
 * Maximum parent-chain depth traversal to prevent runaway cycles.
 * Events nested deeper than this will be capped at this depth value.
 */
export const MAX_REPLAY_DEPTH = 20;

/**
 * Truncates a string to at most `maxLen` characters, appending "..." if truncated.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

/**
 * Derives the ReplayActor category from an event type string.
 *
 * Mapping rules (prefix-based, case-sensitive on prefix):
 * - llm.* / LLM_*       → "llm"
 * - tool.* / TOOL_*     → "tool"
 * - memory.* / MEMORY_* → "memory"
 * - retrieval.* / RETRIEVAL_* → "retrieval"
 * - http.* / HTTP_*     → "http"
 * - run.* / RUN_*       → "system"
 * - anything else       → "unknown"
 */
function deriveActor(type: string): ReplayActor {
  if (type.startsWith("llm.") || type.startsWith("LLM_")) return "llm";
  if (type.startsWith("tool.") || type.startsWith("TOOL_")) return "tool";
  if (type.startsWith("memory.") || type.startsWith("MEMORY_")) return "memory";
  if (type.startsWith("retrieval.") || type.startsWith("RETRIEVAL_")) return "retrieval";
  if (type.startsWith("http.") || type.startsWith("HTTP_")) return "http";
  if (type.startsWith("run.") || type.startsWith("RUN_")) return "system";
  return "unknown";
}

/**
 * Derives the FrameStatus from an event type string.
 *
 * Rules (in priority order):
 * 1. Contains ".error" or "_ERROR" (case-insensitive) → "error"
 * 2. Is a terminal run event (completed/failed/cancelled) → "terminal"
 * 3. Otherwise → "ok"
 */
function deriveStatus(type: string): FrameStatus {
  const lower = type.toLowerCase();
  if (lower.includes(".error") || lower.includes("_error")) return "error";
  if (
    type === "run.completed" ||
    type === "RUN_COMPLETED" ||
    type === "run.failed" ||
    type === "RUN_FAILED" ||
    type === "run.cancelled" ||
    type === "RUN_CANCELLED"
  ) {
    return "terminal";
  }
  return "ok";
}

/**
 * Extracts a short, human-readable preview string (≤80 chars) from an event payload.
 *
 * Per-type extraction rules are applied. The payload is accessed via an unsafe cast
 * since the discriminated union type does not carry type narrowing at this call site.
 * All field accesses use optional-chain guards to remain safe at runtime.
 */
function derivePayloadPreview(type: string, payload: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload shape is unknown at this callsite; we guard all accesses below
  const p = payload as Record<string, any>;

  let preview = "";

  switch (type) {
    case "llm.request":
    case "LLM_REQUEST": {
      const model = typeof p["model"] === "string" ? p["model"] : "";
      const msgCount =
        Array.isArray(p["messages"]) ? (p["messages"] as unknown[]).length : 0;
      preview = `${model} — ${msgCount} messages`;
      break;
    }
    case "llm.response":
    case "LLM_RESPONSE": {
      const model = typeof p["model"] === "string" ? p["model"] : "";
      const usage = p["usage"] as Record<string, unknown> | undefined;
      const tokens =
        typeof usage?.["total_tokens"] === "number"
          ? usage["total_tokens"]
          : "?";
      preview = `${model} — ${String(tokens)} tokens`;
      break;
    }
    case "llm.error":
    case "LLM_ERROR": {
      const error = p["error"] as Record<string, unknown> | undefined;
      const msg = typeof error?.["message"] === "string" ? error["message"] : "";
      preview = `Error: ${msg}`;
      break;
    }
    case "tool.call":
    case "TOOL_CALL": {
      preview = typeof p["name"] === "string" ? p["name"] : "";
      break;
    }
    case "tool.result":
    case "TOOL_RESULT": {
      const durationMs =
        typeof p["duration_ms"] === "number" ? p["duration_ms"] : "?";
      preview = `${String(durationMs)}ms`;
      break;
    }
    case "tool.error":
    case "TOOL_ERROR": {
      const error = p["error"] as Record<string, unknown> | undefined;
      const msg = typeof error?.["message"] === "string" ? error["message"] : "";
      preview = `Error: ${msg}`;
      break;
    }
    case "run.failed":
    case "RUN_FAILED": {
      const error = p["error"] as Record<string, unknown> | undefined;
      const msg = typeof error?.["message"] === "string" ? error["message"] : "";
      preview = `Failed: ${msg}`;
      break;
    }
    case "http.request":
    case "HTTP_REQUEST": {
      const method = typeof p["method"] === "string" ? p["method"] : "";
      const url = typeof p["url"] === "string" ? p["url"] : "";
      preview = `${method} ${url}`;
      break;
    }
    case "http.response":
    case "HTTP_RESPONSE": {
      const status =
        typeof p["status"] === "number" ? p["status"] : "?";
      const durationMs =
        typeof p["duration_ms"] === "number" ? p["duration_ms"] : "?";
      preview = `HTTP ${String(status)} — ${String(durationMs)}ms`;
      break;
    }
    default: {
      // Extract the first string-valued field from the payload as a fallback.
      for (const key of Object.keys(p)) {
        if (key === "type") continue;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const val = p[key];
        if (typeof val === "string" && val.length > 0) {
          preview = val;
          break;
        }
      }
      break;
    }
  }

  return truncate(preview, 80);
}

/**
 * Computes the nesting depth for an event by traversing its parentEventId chain.
 *
 * Traversal stops when:
 * - A parent is not found in the index map (root reached).
 * - The same event ID is visited twice (cycle guard).
 * - MAX_REPLAY_DEPTH hops have been counted.
 *
 * @param eventId - The ID of the event whose depth we are computing.
 * @param idToIndex - Map from event ID to position in the sorted event array.
 * @param events - Sorted event array.
 * @returns The depth (0 = root, no parent).
 */
function computeDepth(
  eventId: string,
  idToIndex: Map<string, number>,
  events: Event[]
): number {
  const visited = new Set<string>();
  let currentId: string | undefined = eventId;
  let depth = 0;

  while (depth < MAX_REPLAY_DEPTH) {
    if (currentId === undefined) break;
    if (visited.has(currentId)) break; // cycle detected
    visited.add(currentId);

    const idx = idToIndex.get(currentId);
    if (idx === undefined) break;

    const event = events[idx];
    if (event === undefined) break;
    if (event.parentEventId === undefined) break;

    currentId = event.parentEventId;
    depth++;
  }

  return depth;
}

/**
 * Builds a deterministic, read-only replay projection from a run and its event log.
 *
 * The projection is rebuilt on-demand from the canonical event sequence.
 * It must never be mutated back to the source.
 *
 * @param run - The run record providing `id` and metadata.
 * @param events - The full event log for the run. May arrive out of order.
 * @returns A ReplayProjection with one ReplayFrame per event, sorted by sequenceNumber.
 *
 * Edge cases:
 * - Empty event array: returns a projection with 0 frames, 0 duration, isComplete=false.
 * - Single event: elapsed_ms=0 for that event, duration_ms=0.
 * - Cyclic parentEventId chains are detected and capped at MAX_REPLAY_DEPTH.
 * - Events with missing or unknown type fields produce actor="unknown", status="ok".
 */
export function buildReplayProjection(run: Run, events: Event[]): ReplayProjection {
  if (events.length === 0) {
    return {
      runId: run.id,
      frames: [],
      totalEvents: 0,
      duration_ms: 0,
      isComplete: false,
      isFailed: false,
    };
  }

  // 1. Sort by sequenceNumber ascending.
  const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  // 2. Reference timestamp is the first event.
  // sorted is non-empty (checked above), so these accesses are safe.
  const firstEvent = sorted[0];
  const lastEvent = sorted[sorted.length - 1];
  const firstTimestamp = firstEvent !== undefined ? firstEvent.timestamp : 0;
  const lastTimestamp = lastEvent !== undefined ? lastEvent.timestamp : 0;

  // 4. Total duration.
  const duration_ms = sorted.length > 1 ? lastTimestamp - firstTimestamp : 0;

  // 5. Build an ID-to-index map for O(1) parent lookups.
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev !== undefined) idToIndex.set(ev.id, i);
  }

  // Build frames.
  const frames: ReplayFrame[] = sorted.map((event, index) => {
    const elapsed_ms = event.timestamp - firstTimestamp;
    const actor = deriveActor(event.type);
    const status = deriveStatus(event.type);
    const payloadPreview = derivePayloadPreview(event.type, event.payload);
    const depth = computeDepth(event.id, idToIndex, sorted);

    return {
      event,
      index,
      elapsed_ms,
      actor,
      status,
      payloadPreview,
      depth,
    };
  });

  // 10. isComplete: any frame with terminal status.
  const isComplete = frames.some((f) => f.status === "terminal");

  // 11. isFailed: any event type that includes "failed" or "FAILED" (case-insensitive).
  const isFailed = sorted.some((e) =>
    e.type.toLowerCase().includes("failed")
  );

  return {
    runId: run.id,
    frames,
    totalEvents: sorted.length,
    duration_ms,
    isComplete,
    isFailed,
  };
}
