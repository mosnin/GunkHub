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
  /**
   * ADR-007. REQUIRED IN PRACTICE for any run that may contain derived events:
   * these two fields are what decide whether the frames below are a timeline
   * or merely an arrival log. A caller that omits them reports every derived
   * run as `sequence-native`, which is a silent false claim of full
   * confidence — so `convex/read_api.ts` projects both, and any new caller
   * must too.
   */
  provenance?: { source?: string; lossReasons?: string[] } | undefined;
  temporalOrder?: TemporalOrderKey | undefined;
}

/**
 * MIRROR of `TemporalOrderKey` in packages/contracts/src/temporal.ts, which is
 * canonical. `convex/` has no dependency on the contracts package by design
 * (convex/package.json), so this is the ONE permitted copy — the comparator
 * that used to be duplicated in apps/web has been hoisted into contracts and
 * that copy deleted.
 */
export interface TemporalOrderKey {
  instantUnixNano: string;
  rawInstantUnixNano: string;
  phase: "open" | "close";
  depth: number;
  spanId: string;
}

export type OrderingBasis = "sequence-native" | "temporal" | "ingest-unverified";

const DECIMAL_NANOS = /^\d+$/;
const NANOS_PER_MS = BigInt(1_000_000);

function isTemporalOrderKey(value: unknown): value is TemporalOrderKey {
  if (typeof value !== "object" || value === null) return false;
  const k = value as Record<string, unknown>;
  if (typeof k["instantUnixNano"] !== "string" || !DECIMAL_NANOS.test(k["instantUnixNano"])) return false;
  if (typeof k["rawInstantUnixNano"] !== "string" || !DECIMAL_NANOS.test(k["rawInstantUnixNano"])) return false;
  if (k["phase"] !== "open" && k["phase"] !== "close") return false;
  if (typeof k["depth"] !== "number" || !Number.isInteger(k["depth"])) return false;
  if (typeof k["spanId"] !== "string") return false;
  return true;
}

/**
 * MIRROR of contracts `compareTemporalOrder`. See that file for the defence of
 * each of the four clauses. Every comparison goes through `BigInt` because
 * decimal-STRING comparison is wrong across differing lengths
 * (`'999999999' > '1750000000000000000'`) and `Number` loses ~256 ns of
 * resolution at epoch-nanosecond scale.
 */
function compareTemporalOrder(a: TemporalOrderKey, b: TemporalOrderKey): number {
  const ai = BigInt(a.instantUnixNano);
  const bi = BigInt(b.instantUnixNano);
  if (ai !== bi) return ai < bi ? -1 : 1;
  const aPhase = a.phase === "open" ? 0 : 1;
  const bPhase = b.phase === "open" ? 0 : 1;
  if (aPhase !== bPhase) return aPhase - bPhase;
  if (a.depth !== b.depth) return a.phase === "open" ? a.depth - b.depth : b.depth - a.depth;
  return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0;
}

function readTemporalOrder(event: MinimalEvent): TemporalOrderKey | undefined {
  if (isTemporalOrderKey(event.temporalOrder)) return event.temporalOrder;
  const nested = (event.provenance as { temporalOrder?: unknown } | undefined)?.temporalOrder;
  if (isTemporalOrderKey(nested)) return nested;
  return undefined;
}

/**
 * MIRROR of contracts `analyzeRunOrdering`, reduced to the basis (this module
 * does not render skew figures).
 */
export function analyzeOrderingBasis(events: readonly MinimalEvent[]): OrderingBasis {
  let derived = 0;
  let keyed = 0;
  for (const event of events) {
    if (event.provenance?.source !== "otel") continue;
    derived++;
    if (readTemporalOrder(event) !== undefined) keyed++;
  }
  if (derived === 0) return "sequence-native";
  return keyed === derived ? "temporal" : "ingest-unverified";
}

function synthesizeKey(event: MinimalEvent): TemporalOrderKey {
  const nanos = BigInt(Math.trunc(event.timestamp)) * NANOS_PER_MS;
  const clamped = nanos < BigInt(0) ? "0" : nanos.toString();
  return { instantUnixNano: clamped, rawInstantUnixNano: clamped, phase: "open", depth: 0, spanId: "" };
}

/**
 * MIRROR of contracts `orderEventsForProjection`.
 *
 * NATIVE RUNS TAKE A PHYSICALLY DIFFERENT BRANCH and get exactly the sort this
 * module used before temporal ordering existed, so the first-party path is
 * unregressed by construction rather than by inspection.
 *
 * `ingest-unverified` ALSO falls back to the sequence sort, and the difference
 * from the native case is the whole point: there, arrival order is all that
 * exists, and the caller is expected to surface `orderingBasis` so the user is
 * TOLD the order is unverified. Splicing the unkeyed events in by arrival while
 * temporally ordering the rest would produce a confident-looking timeline that
 * is wrong in an unmarked place, which is worse than either honest option.
 */
export function orderEventsForProjection(events: readonly MinimalEvent[]): MinimalEvent[] {
  const bySequence = (a: MinimalEvent, b: MinimalEvent): number => a.sequenceNumber - b.sequenceNumber;
  if (analyzeOrderingBasis(events) !== "temporal") return [...events].sort(bySequence);

  const keys = new Map<string, TemporalOrderKey>();
  for (const event of events) keys.set(event.id, readTemporalOrder(event) ?? synthesizeKey(event));

  return [...events].sort((a, b) => {
    const ka = keys.get(a.id);
    const kb = keys.get(b.id);
    if (ka === undefined || kb === undefined) return bySequence(a, b);
    const byTemporal = compareTemporalOrder(ka, kb);
    return byTemporal !== 0 ? byTemporal : bySequence(a, b);
  });
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
  /**
   * ADR-007: what this projection's frame order is entitled to CLAIM. Mirrors
   * contracts `ReplayProjection.orderingBasis`. `apiGetReplay` returns this
   * straight to the `afr` CLI and the MCP server, which otherwise could not
   * tell a verified timeline from collector flush order.
   */
  orderingBasis: OrderingBasis;
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
    // An empty run is `sequence-native`: there is nothing whose order could be wrong.
    return {
      runId, frames: [], orderingBasis: "sequence-native", totalEvents: 0,
      duration_ms: 0, isComplete: false, isFailed: false,
    };
  }

  // ADR-007. NOT `sort((a, b) => a.sequenceNumber - b.sequenceNumber)`. On the
  // OTel path `sequenceNumber` is the order the collector happened to FLUSH,
  // not the order things happened; sorting a derived run by it renders a
  // timeline that is confidently wrong. `orderEventsForProjection` takes the
  // pre-existing sequence branch for native runs, so nothing recorded by the
  // SDK changes.
  const orderingBasis = analyzeOrderingBasis(events);
  const allSorted = orderEventsForProjection(events);
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
    orderingBasis,
    isComplete,
    isFailed,
    ...(truncated && { truncated: true }),
  };
}
