// Cycle 2 (docs/design/action_layer.md) — Convex-side mirror of the PURE
// `buildReplayProjection` in `apps/web/src/lib/replay/projection.ts`, so
// `convex/read_api.ts`'s `apiGetReplay` (a Convex function called directly by
// the CLI/external consumers, not through a Next.js route) can build the
// same replay projection without an import across the apps/web <-> convex
// deployment boundary (convex/projection_verify.ts already documents that
// buildReplayProjection is "not importable from Convex actions" — same
// constraint applies here).
//
// KEEP IN SYNC with apps/web/src/lib/replay/projection.ts: actor/status
// derivation rules, payload preview extraction, depth computation, and the
// truncation/duration semantics must all agree. A fix to one must be
// mirrored in the other.
//
// Operates on plain Convex Doc<"events">/Doc<"runs"> shapes rather than the
// contracts Event/Run types (Convex ids are branded strings, not the
// contracts' plain `id: string`), so this is a light re-implementation, not
// a byte-for-byte port — see tests/unit/replay.test.ts vs. this module's
// tests for the parity checks.

export type ReplayActor = "agent" | "llm" | "tool" | "memory" | "retrieval" | "http" | "system" | "unknown";
export type FrameStatus = "ok" | "error" | "terminal" | "in_progress";

export interface MinimalEvent {
  id: string;
  type: string;
  sequenceNumber: number;
  timestamp: number;
  payload: unknown;
  parentEventId?: string;
}

export interface ReplayFrame {
  event: MinimalEvent;
  index: number;
  elapsed_ms: number;
  actor: ReplayActor;
  status: FrameStatus;
  payloadPreview: string;
  depth: number;
}

export interface ReplayProjection {
  runId: string;
  frames: ReplayFrame[];
  totalEvents: number;
  duration_ms: number;
  isComplete: boolean;
  isFailed: boolean;
  truncated?: boolean;
}

const MAX_REPLAY_DEPTH = 20;
const MAX_EVENTS_PER_REPLAY = 10_000;

function truncateStr(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function deriveActor(type: string): ReplayActor {
  if (type.startsWith("llm.")) return "llm";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("memory.")) return "memory";
  if (type.startsWith("retrieval.")) return "retrieval";
  if (type.startsWith("http.")) return "http";
  if (type.startsWith("run.")) return "system";
  return "unknown";
}

function deriveStatus(type: string): FrameStatus {
  const lower = type.toLowerCase();
  if (lower.includes(".error")) return "error";
  if (type === "run.completed" || type === "run.failed" || type === "run.cancelled") return "terminal";
  return "ok";
}

function derivePayloadPreview(type: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  let preview = "";
  switch (type) {
    case "llm.request": {
      const model = typeof p["model"] === "string" ? p["model"] : "";
      const msgCount = Array.isArray(p["messages"]) ? p["messages"].length : 0;
      preview = `${model} — ${String(msgCount)} messages`;
      break;
    }
    case "llm.response": {
      const model = typeof p["model"] === "string" ? p["model"] : "";
      const usage = p["usage"] as Record<string, unknown> | undefined;
      const tokens = typeof usage?.["total_tokens"] === "number" ? usage["total_tokens"] : "?";
      preview = `${model} — ${String(tokens)} tokens`;
      break;
    }
    case "llm.error":
    case "tool.error": {
      const error = p["error"] as Record<string, unknown> | undefined;
      const msg = typeof error?.["message"] === "string" ? error["message"] : "";
      preview = `Error: ${msg}`;
      break;
    }
    case "tool.call": {
      preview = typeof p["name"] === "string" ? p["name"] : "";
      break;
    }
    case "tool.result": {
      const durationMs = typeof p["duration_ms"] === "number" ? p["duration_ms"] : "?";
      preview = `${String(durationMs)}ms`;
      break;
    }
    case "run.failed": {
      const error = p["error"] as Record<string, unknown> | undefined;
      const msg = typeof error?.["message"] === "string" ? error["message"] : "";
      preview = `Failed: ${msg}`;
      break;
    }
    case "http.request": {
      const method = typeof p["method"] === "string" ? p["method"] : "";
      const url = typeof p["url"] === "string" ? p["url"] : "";
      preview = `${method} ${url}`;
      break;
    }
    case "http.response": {
      const status = typeof p["status"] === "number" ? p["status"] : "?";
      const durationMs = typeof p["duration_ms"] === "number" ? p["duration_ms"] : "?";
      preview = `HTTP ${String(status)} — ${String(durationMs)}ms`;
      break;
    }
    default: {
      for (const key of Object.keys(p)) {
        if (key === "type") continue;
        const val = p[key];
        if (typeof val === "string" && val.length > 0) {
          preview = val;
          break;
        }
      }
    }
  }
  return truncateStr(preview, 80);
}

function computeDepth(eventId: string, idToIndex: Map<string, number>, events: MinimalEvent[]): number {
  const visited = new Set<string>();
  let currentId: string | undefined = eventId;
  let depth = 0;
  while (depth < MAX_REPLAY_DEPTH) {
    if (currentId === undefined || visited.has(currentId)) break;
    visited.add(currentId);
    const idx = idToIndex.get(currentId);
    if (idx === undefined) break;
    const event = events[idx];
    if (event === undefined || event.parentEventId === undefined) break;
    currentId = event.parentEventId;
    depth++;
  }
  return depth;
}

/** Builds a deterministic, read-only replay projection. See module header for parity notes. */
export function buildReplayProjectionMirror(runId: string, events: MinimalEvent[]): ReplayProjection {
  if (events.length === 0) {
    return { runId, frames: [], totalEvents: 0, duration_ms: 0, isComplete: false, isFailed: false };
  }

  const allSorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const truncated = allSorted.length > MAX_EVENTS_PER_REPLAY;
  const sorted = truncated ? allSorted.slice(0, MAX_EVENTS_PER_REPLAY) : allSorted;

  const firstEvent = sorted[0];
  const lastEvent = sorted[sorted.length - 1];
  const firstTimestamp = firstEvent !== undefined ? firstEvent.timestamp : 0;
  const lastTimestamp = lastEvent !== undefined ? lastEvent.timestamp : 0;
  const duration_ms = sorted.length > 1 ? lastTimestamp - firstTimestamp : 0;

  const idToIndex = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev !== undefined) idToIndex.set(ev.id, i);
  }

  const frames: ReplayFrame[] = sorted.map((event, index) => ({
    event,
    index,
    elapsed_ms: event.timestamp - firstTimestamp,
    actor: deriveActor(event.type),
    status: deriveStatus(event.type),
    payloadPreview: derivePayloadPreview(event.type, event.payload),
    depth: computeDepth(event.id, idToIndex, sorted),
  }));

  const isComplete = frames.some((f) => f.status === "terminal");
  const isFailed = sorted.some((e) => e.type.toLowerCase().includes("failed"));

  return {
    runId,
    frames,
    totalEvents: sorted.length,
    duration_ms,
    isComplete,
    isFailed,
    ...(truncated && { truncated: true }),
  };
}
