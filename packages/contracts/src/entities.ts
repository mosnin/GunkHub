export interface Organization {
  id: string;
  clerkOrgId: string;
  name: string;
  slug: string;
  plan: "free" | "pro" | "enterprise";
  createdAt: number;
  updatedAt: number;
  /**
   * Optional retention window in days (ADR 001). When set, terminal runs older
   * than the window are deleted by the daily retention cron. Unset = retain
   * forever.
   */
  retentionDays?: number;
  /**
   * Set when the identity provider reports the organization as deleted. The
   * actual erasure (ADR 001 purge) stays operator-invoked; this timestamp makes
   * the pending obligation visible.
   */
  pendingDeletionAt?: number;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Agent {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  slug: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  orgId: string;
  /** Semver string, e.g. "1.2.3" */
  version: string;
  changelog?: string;
  configSnapshot?: Record<string, unknown>;
  createdAt: number;
  /**
   * Cycle 2 (docs/design/action_layer.md) — optional eval auto-run rule set,
   * evaluated against every terminal run created against this version. Typed
   * loosely here (matches Convex's `v.array(v.any())` storage — the
   * `EvalRule` discriminated union lives in convex/helpers/evals.ts, a
   * Convex-only pure module, not currently re-exported through contracts).
   * Bounded to <= 20 entries at write time (createAgentVersion).
   */
  evalRules?: Record<string, unknown>[];
}

export interface Run {
  id: string;
  orgId: string;
  projectId: string;
  agentId: string;
  agentVersionId?: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  metadata: Record<string, unknown>;
  tags: string[];
  triggeredBy?: string;
  sdkVersion?: string;
  /** ADR-002: links a sub-run to its parent (same org + project). */
  parentRunId?: string;
  /** ADR-002: free-form correlation key grouping multiple runs. */
  sessionId?: string;
  /** ADR-002: well-known value or custom string up to 32 chars. */
  environment?: string;
  /** ADR-002: triage labels, distinct from `tags` — up to 10, each up to 40 chars. */
  labels?: string[];
  /** ADR-002: settable only on failed/timed_out runs via setRunTriage. */
  triageState?: RunTriageState;
  /** ADR-002: denormalized running counters, incremented from llm.response events. */
  tokensIn?: number;
  tokensOut?: number;
  /** ADR-002: search-index source field — not itself a canonical fact about the run. */
  searchText?: string;
  /**
   * Cycle 3 (cost accuracy): bounded (<= 10), deduped list of model
   * strings tolerantly extracted from this run's llm.request/llm.response
   * event payloads at insert time. Same denormalized-counter justification
   * as tokensIn/tokensOut — monotonic add-only, never a recomputed
   * aggregate, so it cannot drift out of sync with the event log.
   */
  modelsSeen?: string[];
}

export interface Event {
  id: string;
  runId: string;
  orgId: string;
  type: EventType;
  sequenceNumber: number;
  timestamp: number;
  payload: EventPayload;
  parentEventId?: string;
}

export interface Artifact {
  id: string;
  runId: string;
  orgId: string;
  eventId?: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  storageBucket: string;
  checksum: string;
  createdAt: number;
  /**
   * GC bookkeeping (sticky reference): the id of an event whose `_externalized`
   * payload points at this artifact. Once set, the artifact is permanently
   * excluded from orphan-candidate scans (events are immutable, so a reference
   * can never be un-made). Internal bookkeeping — not meaningful to display.
   */
  referencedByEventId?: string;
}

export interface Comment {
  id: string;
  orgId: string;
  targetId: string;
  targetType: "run" | "event";
  authorId: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

// Forward references resolved by importing from events.ts and status.ts
import type { EventType, EventPayload } from "./events.js";
import type { RunStatus, RunTriageState } from "./status.js";
