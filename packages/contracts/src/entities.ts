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
  /**
   * ADR-007: the W3C trace id this run was DERIVED from, when it was derived
   * from OpenTelemetry spans rather than recorded by the SDK.
   *
   * This field IS the trace->run ruling: one trace is exactly one run, keyed
   * `(orgId, otelTraceId)`. Set only by `otelIngestSpans`
   * (convex/otel_ingest.ts) and never by the SDK ingest path.
   *
   * Absent means "not derived from a trace". It is NOT a substitute for
   * per-event provenance: a reader asking whether a given EVENT is our
   * interpretation of somebody else's telemetry must read
   * {@link Event.provenance}, which cannot be forged by the SDK path. This is
   * the run-level correlation key, nothing more.
   */
  otelTraceId?: string;
  /**
   * ADR-007: the trace's true root span, recorded the first time one is
   * observed CLOSED. Present only on OTel-derived runs.
   *
   * Its presence is what makes a derived run eligible to be settled — closed
   * with a terminal event after a quiet period. Its absence means the root
   * never arrived closed and the run's outcome is genuinely unknown, which
   * Event Log Rule 5 already defines as in-progress.
   */
  otelRoot?: {
    spanId: string;
    spanName: string;
    status: "unset" | "ok" | "error";
    /** Root's end instant, epoch NANOSECONDS as a decimal string. */
    endUnixNano: string;
  };
  /**
   * ADR-007: the chosen root's START instant, epoch nanoseconds as a decimal
   * string. Root selection is `min(start, spanId)` over the whole TRACE, and
   * comparing a later batch's candidate against the recorded one needs it.
   */
  otelRootStartNano?: string;
  /**
   * ADR-007: the latest temporal instant of any event in this run, epoch
   * nanoseconds as a decimal string. Monotonic max, add-only. Guarantees the
   * synthesized terminal event sorts after everything it terminates.
   */
  otelMaxInstantNano?: string;
  /**
   * ADR-007: count of events on this run whose provenance is `otel`. Add-only,
   * written at ingest. `0` (or absent) means every event was recorded
   * first-party, so `sequenceNumber` IS temporal order.
   */
  derivedEventCount?: number;
  /**
   * ADR-007: count of DERIVED events stored without a usable temporal key.
   * Add-only. Non-zero means the run can only be rendered in arrival order and
   * must be LABELLED `ingest-unverified` rather than presented as a timeline.
   *
   * Together with {@link derivedEventCount} this gives the same three-way
   * verdict as {@link analyzeRunOrdering} in O(1) instead of O(run) — which is
   * what lets a paged consumer (MCP, CLI) state the verdict at all, rather than
   * only the one-sided alarm a window can support.
   *
   * OBSERVABILITY-GRADE, per ADR-002. The event log remains the source of truth
   * for the ordering itself; use {@link orderEventsForProjection} to actually
   * order events.
   */
  otelUnkeyedDerivedCount?: number;
  /** ADR-007: wall clock of the most recent derived append. Drives the settle window. */
  otelLastAppendAt?: number;
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
  /**
   * How this event came to exist — first-party SDK recording, or DERIVED from
   * an ingested OpenTelemetry span. See packages/contracts/src/provenance.ts
   * for the full argument.
   *
   * OPTIONAL ON THE STORED ENTITY, REQUIRED ON THE DERIVED WRITE PATH
   * ({@link OtelDerivedEventWrite}). The asymmetry is the whole design, and it
   * is deliberate:
   *
   *  - Making it required HERE would break every existing consumer and, worse,
   *    every existing ROW — the events table is append-only, so there is no
   *    backfill that does not amount to rewriting history. It would also buy
   *    less than it appears to: a required field forces every PRODUCER of an
   *    `Event` value to make a claim, but TypeScript never forces a READER to
   *    look at a field, so it would not have made any UI render a "derived"
   *    badge.
   *
   *  - The hole a required field would actually close is on the WRITE side — a
   *    derived event stored with no provenance. That hole is closed instead by
   *    {@link OtelDerivedEventWrite}, the only contract describing a derived
   *    write, where provenance is required and non-nullable. Nothing can write
   *    a derived event without one, so `undefined` here provably means "native".
   *
   * Absent = recorded natively. That reading is sound because every row
   * written before OTel ingestion existed came from the first-party SDK path,
   * there being no other writer. Use `resolveEventProvenance` to apply it
   * explicitly rather than assuming it inline at each call site.
   */
  provenance?: EventProvenance;
  /**
   * The TEMPORAL truth for a derived event, carried separately from
   * `sequenceNumber`.
   *
   * On the OTel ingest path `sequenceNumber` is THE ORDER WE LEARNED ABOUT THE
   * EVENT, not the order it happened. Within one OTLP batch the two coincide;
   * across batches they cannot, because a span arriving later that occurred
   * earlier can only be APPENDED — inserting it would require renumbering, and
   * renumbering an append-only log is permanent corruption (Event Log Rule 1).
   *
   * OPTIONAL, and absent by construction on native runs: an SDK-recorded event
   * has no span, no clamp, and its `sequenceNumber` IS its temporal order.
   * Absent on a DERIVED event means the ordering is unverifiable — see
   * {@link OrderingBasis}'s `ingest-unverified`, which must be LABELLED rather
   * than silently rendered as a timeline.
   *
   * Read it with {@link readTemporalOrder} (which validates before trusting)
   * and sort with {@link orderEventsForProjection}. Do not compare the raw
   * decimal-nanosecond strings — string order is wrong across differing
   * lengths.
   */
  temporalOrder?: TemporalOrderKey;
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
import type { EventProvenance, OtelEventProvenance } from "./provenance.js";
import type { RunStatus, RunTriageState } from "./status.js";
import type { TemporalOrderKey } from "./temporal.js";

/**
 * An `Event` KNOWN to have been derived from an OTel span.
 *
 * Use this as the parameter type anywhere a function only makes sense for
 * derived events (rendering the source-span link, re-running a mapping,
 * auditing a mapper bug). Narrow into it with `isDerivedProvenance`.
 */
export type DerivedEvent = Event & { provenance: OtelEventProvenance };
