// SDK ingest mutations — called from Next.js API routes WITHOUT Clerk JWT auth.
// Authentication here is via pre-hashed API key only. Do NOT call getAuthContext
// or requireOrgMembership in this file — those require a Clerk JWT.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";
import { afrError } from "./helpers/errors.js";
import { validateEvalFields } from "./helpers/eval_fields.js";
import {
  MAX_ARTIFACTS_PER_RUN,
  MAX_EVENTS_PER_RUN,
} from "./helpers/pagination.js";
import {
  addModelSeen,
  buildSearchText,
  extractErrorMessage,
  extractModel,
  extractTokenUsage,
  validateEnvironment,
  validateLabels,
  validateSessionId,
} from "./helpers/run_fields.js";
import { incrementUsageCounters } from "./usage.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

// Scope required to write to the ingest API (create runs/events/artifacts, update
// status). A key with no `scopes` array has full access (back-compat).
const INGEST_WRITE = "ingest:write";

// Only refresh api_keys.lastUsedAt when the stamp is older than this, to keep the
// key document off the ingest write hot path (see resolveApiKey).
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Resolve and authorize an API key for ingest. Centralizes the credential checks
 * that every ingest mutation must perform: existence, revocation, expiration, and
 * scope. Throws "Unauthorized"/"Forbidden" on any failure. Also stamps lastUsedAt.
 */
export async function resolveApiKey(
  ctx: MutationCtx,
  apiKeyHash: string,
  requiredScope: string,
): Promise<Doc<"api_keys">> {
  const apiKey = await ctx.db
    .query("api_keys")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", apiKeyHash))
    .unique();

  if (!apiKey || apiKey.revokedAt !== undefined) {
    throw new Error("Unauthorized");
  }
  if (apiKey.expiresAt !== undefined && apiKey.expiresAt <= Date.now()) {
    throw new Error("Unauthorized: API key has expired");
  }
  if (
    apiKey.scopes !== undefined &&
    apiKey.scopes.length > 0 &&
    !apiKey.scopes.includes(requiredScope)
  ) {
    throw new Error(`Forbidden: API key lacks required scope "${requiredScope}"`);
  }

  // Usage tracking, THROTTLED. Patching lastUsedAt on every ingest call serializes
  // all ingest for a single high-throughput key on one document (Convex serializes
  // writes to the same doc) — a scale bottleneck for busy autonomous agents. Only
  // write when the stamp is stale, so the hot path stays read-only on the key.
  const now = Date.now();
  if (apiKey.lastUsedAt === undefined || now - apiKey.lastUsedAt > LAST_USED_THROTTLE_MS) {
    await ctx.db.patch(apiKey._id, { lastUsedAt: now });
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Per-key fixed-window rate limiting (shared by sdkCreateRun, sdkCreateEvents,
// and sdkCreateArtifact — one counter per key across all ingest write surfaces).
//
// HOT-KEY CONTENTION MITIGATION: Convex serializes writes to a document, so
// patching the api_key doc on every ingest call would serialize all ingest for
// a busy key. The counter is therefore APPROXIMATE for single-unit calls:
//   - The counter doc is always patched when the minute window CHANGES.
//   - Within a window, single-unit calls flush the counter only on ~1 in
//     RATE_FLUSH_STRIDE calls, adding RATE_FLUSH_STRIDE units per flush
//     (unbiased in expectation, à la Morris counting). Between flushes the
//     stored count lags by at most ~RATE_FLUSH_STRIDE units per concurrent
//     stream, so the effective limit is `rateLimitPerMin ± O(RATE_FLUSH_STRIDE)`
//     — accurate enough for abuse protection, which is what this limit is for.
//   - SMALL limits (≤ RATE_EXACT_THRESHOLD) are counted exactly, because there
//     a stride-sized error would swallow the whole budget (and exact tests
//     stay deterministic).
//   - Batch calls (sdkCreateEvents) always flush exactly: one patch per batch
//     is already amortized over the batch's events.
// ---------------------------------------------------------------------------
const RATE_FLUSH_STRIDE = 25;
const RATE_EXACT_THRESHOLD = 4 * RATE_FLUSH_STRIDE; // ≤100/min: exact counting

/**
 * Enforce the key's fixed one-minute-window rate limit, counting `units` against
 * it. Throws a stable RATE_LIMITED error when the limit would be exceeded. The
 * whole mutation is transactional, so on rejection nothing is committed.
 */
export async function enforceRateLimit(
  ctx: MutationCtx,
  apiKey: Doc<"api_keys">,
  units: number,
): Promise<void> {
  const limit = apiKey.rateLimitPerMin;
  if (limit === undefined) return;

  const window = Math.floor(Date.now() / 60_000);
  const inSameWindow = apiKey.rateWindowStart === window;
  const currentCount = inSameWindow ? apiKey.rateWindowCount ?? 0 : 0;
  const newCount = currentCount + units;

  if (newCount > limit) {
    throw afrError(
      "RATE_LIMITED",
      `Rate limit exceeded: ${limit} ingest units/min for this API key`,
    );
  }

  const exact = units > 1 || limit <= RATE_EXACT_THRESHOLD;
  if (!inSameWindow) {
    // Window rolled over — always persist the reset.
    await ctx.db.patch(apiKey._id, {
      rateWindowStart: window,
      rateWindowCount: units,
    });
  } else if (exact) {
    await ctx.db.patch(apiKey._id, {
      rateWindowStart: window,
      rateWindowCount: newCount,
    });
  } else if (Math.random() < 1 / RATE_FLUSH_STRIDE) {
    // Approximate flush: account for the ~RATE_FLUSH_STRIDE unflushed calls
    // this one statistically represents. Cap at the limit so a lucky double
    // flush cannot push the stored count past it spuriously.
    await ctx.db.patch(apiKey._id, {
      rateWindowStart: window,
      rateWindowCount: Math.min(currentCount + units * RATE_FLUSH_STRIDE, limit),
    });
  }
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

// Event types that, per CLAUDE.md Event Log Rule 5, must be the LAST event in a
// run. Once one is stored, no further events may be appended.
const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed"]);

// Event Log Rule 5: the first event of every run must be RUN_STARTED.
const RUN_STARTED_TYPE = "run.started";

// Closed set of accepted event types. MUST stay in sync with the `EventType` union
// in packages/contracts/src/events.ts (the source of truth). Convex cannot import
// the contracts package (no path resolution / not a dependency), so the union is
// mirrored here — same rationale as events.ts. Rejecting unknown types prevents a
// typo'd terminal event (e.g. "run.complete") from persisting as a non-terminal
// event, which would leave the run permanently open.
const VALID_EVENT_TYPES = new Set<string>([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "llm.request",
  "llm.response",
  "llm.error",
  "tool.call",
  "tool.result",
  "tool.error",
  "memory.read",
  "memory.write",
  "retrieval.query",
  "retrieval.result",
  "http.request",
  "http.response",
  "custom",
]);

// CLAUDE.md Event Log Rule 3: payloads over 10 KB must be externalized to blob
// storage; the event stores only a pointer. Enforced server-side (defense in
// depth) so a direct Convex call or an SDK bug cannot bloat the document store.
const MAX_INLINE_PAYLOAD_BYTES = 10 * 1024;

// Cycle 2 (docs/design/action_layer.md) — see convex/events.ts for the full
// rationale on makeFunctionReference-by-name here. AUDIT FIX (cycle 4): a
// single action (alert_engine.runEvalsThenEvaluateAlerts) is scheduled now,
// instead of independently scheduling alert_engine.evaluateAlertsForRun and
// insights.runEvalsForRun — the former used to be able to race the latter's
// auto-run eval inserts, causing an "eval_failed" alert rule to silently
// never fire for the run whose eval had just failed. See that action's doc
// comment in convex/alert_engine.ts for the full rationale.
const _runEvalsThenEvaluateAlertsRef = makeFunctionReference<"action">(
  "alert_engine:runEvalsThenEvaluateAlerts",
);

// ADR-004 — "Why did this fail?" run explanations. Scheduled ALONGSIDE the
// eval/alert wrapper above (no ordering dependency on it). See
// convex/run_explanations.ts.
const _generateRunExplanationRef = makeFunctionReference<"action">(
  "run_explanations:generateRunExplanation",
);

/**
 * Throws if a payload exceeds the 10 KB inline limit (UTF-8 bytes). Applied to
 * EVERY payload with no type-based exemption: a genuine externalized pointer is a
 * few hundred bytes and passes naturally, while exempting by a client-supplied
 * `type: "_externalized"` field would let an attacker spoof the type to smuggle a
 * multi-MB payload past the guard.
 */
function assertPayloadWithinInlineLimit(payload: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? null)).length;
  if (bytes > MAX_INLINE_PAYLOAD_BYTES) {
    throw new Error(
      `Event payload is ${bytes} bytes, exceeding the ${MAX_INLINE_PAYLOAD_BYTES}-byte inline limit. ` +
        `Payloads over 10 KB must be externalized to blob storage (store a pointer, not the data).`,
    );
  }
}

/**
 * Read-only ingest authorization check. Verifies the API key (existence,
 * revocation, expiration, ingest:write scope) AND that it owns the given run,
 * WITHOUT mutating anything. The artifact-upload route calls this BEFORE writing
 * the caller's payload to blob storage, so an unauthenticated/cross-org caller
 * cannot write arbitrary blobs. Throws Unauthorized/Forbidden on any failure.
 */
export const checkIngestAuth = query({
  args: { apiKeyHash: v.string(), runId: v.string() },
  handler: async (ctx: QueryCtx, args) => {
    const apiKey = await ctx.db
      .query("api_keys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.apiKeyHash))
      .unique();
    if (!apiKey || apiKey.revokedAt !== undefined) {
      throw new Error("Unauthorized");
    }
    if (apiKey.expiresAt !== undefined && apiKey.expiresAt <= Date.now()) {
      throw new Error("Unauthorized: API key has expired");
    }
    if (
      apiKey.scopes !== undefined &&
      apiKey.scopes.length > 0 &&
      !apiKey.scopes.includes(INGEST_WRITE)
    ) {
      throw new Error(`Forbidden: API key lacks required scope "${INGEST_WRITE}"`);
    }
    // TENANCY (CLAUDE.md Tenancy Rule 3). The key's org is already resolved
    // above from the key alone, so the collapse costs nothing. This previously
    // threw "Run not found" for a missing run but "Unauthorized" for a run in
    // another org — and because this is a side-effect-free, unrate-limited
    // pre-flight query, that made it a free run-ID existence oracle across
    // every tenant in the deployment. Both cases are now one outcome.
    const run = await ctx.db.get(args.runId as Id<"runs">);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found");
    }
    return { ok: true as const };
  },
});

/**
 * Create a new run from an SDK call.  Authenticates via API key hash.
 * The run is created immediately in the "running" state because SDK callers
 * invoke startRun() at the very beginning of execution.
 */
export const sdkCreateRun = mutation({
  args: {
    apiKeyHash: v.string(),
    agentId: v.string(),
    agentVersionId: v.optional(v.string()),
    metadata: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
    triggeredBy: v.optional(v.string()),
    sdkVersion: v.optional(v.string()),
    // ADR-002 additions — all optional/additive.
    parentRunId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    environment: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveApiKey(ctx, args.apiKeyHash, INGEST_WRITE);
    // Run creation counts one unit against the same per-key ingest window.
    await enforceRateLimit(ctx, apiKey, 1);

    const agentId = args.agentId as Id<"agents">;
    // TENANCY (CLAUDE.md Tenancy Rule 3). Cross-org protection: the agent must
    // belong to the same org as the API key. The missing case and the foreign
    // case are collapsed into one outcome so this cannot be used to enumerate
    // other orgs' agent IDs — matching the agentVersionId and parentRunId
    // checks immediately below, which already had the correct shape.
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.orgId !== apiKey.orgId) {
      throw new Error("Agent not found");
    }

    const agentVersionId = args.agentVersionId
      ? (args.agentVersionId as Id<"agent_versions">)
      : undefined;

    // Cross-org protection: a supplied agent version must belong to the same org
    // and agent, so a valid key cannot stamp a run with a foreign version id.
    if (agentVersionId !== undefined) {
      const version = await ctx.db.get(agentVersionId);
      if (!version || version.orgId !== apiKey.orgId || version.agentId !== agent._id) {
        throw new Error("Agent version not found for this agent");
      }
    }

    // ADR-002: parentRunId must belong to the SAME org AND project as the
    // child being created. Cycles are structurally impossible — see
    // convex/runs.ts validateParentRun for the full rationale.
    const parentRunId = args.parentRunId ? (args.parentRunId as Id<"runs">) : undefined;
    if (parentRunId !== undefined) {
      const parent = await ctx.db.get(parentRunId);
      if (!parent || parent.orgId !== apiKey.orgId || parent.projectId !== agent.projectId) {
        throw afrError(
          "INVALID_ARGUMENT",
          "parentRunId must reference an existing run in the same organization and project",
        );
      }
    }
    validateSessionId(args.sessionId);
    validateEnvironment(args.environment);
    validateLabels(args.labels);

    // ADR-002: a key's own `environment` stamps every run it creates, unless
    // the caller explicitly supplies one on this call.
    const environment = args.environment ?? apiKey.environment;

    const now = Date.now();
    const searchText = buildSearchText([agent.name, ...(args.tags ?? []), args.triggeredBy]);
    const runId = await ctx.db.insert("runs", {
      orgId: apiKey.orgId,
      projectId: agent.projectId,
      agentId: agent._id,
      agentVersionId,
      status: "running",
      startedAt: now,
      endedAt: undefined,
      metadata: args.metadata ?? {},
      tags: args.tags ?? [],
      triggeredBy: args.triggeredBy,
      sdkVersion: args.sdkVersion,
      parentRunId,
      sessionId: args.sessionId,
      environment,
      labels: args.labels,
      searchText,
    });

    await incrementUsageCounters(ctx, apiKey.orgId, { runsStarted: 1 });

    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Failed to create run");

    // Return with _id aliased to id for SDK consumers
    const { _id, ...rest } = run;
    return { id: _id, ...rest };
  },
});

/**
 * Batch-insert events for one or more runs.  Authenticates via API key hash.
 * Events are inserted individually in the order provided by the SDK.
 * The run must be in "running" state; events for terminal runs are rejected.
 */
export const sdkCreateEvents = mutation({
  args: {
    apiKeyHash: v.string(),
    events: v.array(
      v.object({
        runId: v.string(),
        type: v.string(),
        sequenceNumber: v.number(),
        timestamp: v.number(),
        payload: v.any(),
        parentEventId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveApiKey(ctx, args.apiKeyHash, INGEST_WRITE);

    // Fixed-window ingest rate limiting (runaway-agent / abuse protection). The
    // whole mutation is transactional, so if the limit is exceeded nothing —
    // including the events and the lastUsedAt stamp — is committed.
    await enforceRateLimit(ctx, apiKey, args.events.length);

    const eventIds: string[] = [];
    // ADR-002 usage metering: accumulated across the batch and flushed ONCE
    // after the loop (batch calls always flush exactly — see convex/usage.ts).
    let insertedCount = 0;
    let insertedBytes = 0;

    // Per-run ingest state, established lazily and advanced as we insert. Lets us
    // validate CLAUDE.md Event Log Rule 4 (contiguous, non-repeating sequence
    // numbers) and Rule 5 (terminal event is last) without re-querying per event.
    const runState = new Map<
      string,
      { maxSeq: number; hasTerminal: boolean }
    >();

    const loadRunState = async (
      runId: Id<"runs">,
    ): Promise<{ maxSeq: number; hasTerminal: boolean }> => {
      const cached = runState.get(runId);
      if (cached) return cached;
      // Highest stored sequence number for this run (by_run is [runId, seq]).
      const latest = await ctx.db
        .query("events")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .order("desc")
        .first();
      const state = {
        maxSeq: latest ? latest.sequenceNumber : 0,
        hasTerminal: latest ? TERMINAL_EVENT_TYPES.has(latest.type) : false,
      };
      runState.set(runId, state);
      return state;
    };

    for (const evt of args.events) {
      const runId = evt.runId as Id<"runs">;
      // TENANCY (CLAUDE.md Tenancy Rule 3). Cross-org protection, collapsed
      // into one outcome with the missing-run case. This loop walks a
      // caller-supplied array, so a split here would let one call probe a whole
      // batch of foreign run IDs at once.
      const run = await ctx.db.get(runId);

      if (!run || run.orgId !== apiKey.orgId) {
        throw new Error(`Run not found: ${evt.runId}`);
      }

      // Idempotency FIRST: a retry of an already-stored event must return its ID
      // regardless of the run's current status (a late retry after the run has
      // terminated is still idempotent, not an error).
      const existing = await ctx.db
        .query("events")
        .withIndex("by_run", (q) =>
          q.eq("runId", runId).eq("sequenceNumber", evt.sequenceNumber)
        )
        .unique();

      if (existing !== null) {
        eventIds.push(existing._id);
        continue;
      }

      // A genuinely new event may only be appended while the run is running.
      if (run.status !== "running") {
        throw afrError(
          "RUN_NOT_ACTIVE",
          `Cannot append event to run with status "${run.status}". Run must be in "running" state.`,
        );
      }

      // --- Reject unknown event types (closed set from contracts EventType) ---
      // Without this, a typo'd terminal event persists as a non-terminal event and
      // the run never closes.
      if (!VALID_EVENT_TYPES.has(evt.type)) {
        throw new Error(
          `Unknown event type "${evt.type}" for run ${evt.runId}. ` +
            `Must be one of the contracts EventType union.`,
        );
      }

      // --- Event Log Rule 4: sequence numbers are positive, integral, contiguous ---
      if (!Number.isInteger(evt.sequenceNumber) || evt.sequenceNumber < 1) {
        throw new Error(
          `Invalid sequenceNumber ${evt.sequenceNumber}: must be a positive integer`,
        );
      }

      // --- Write ceiling: sequences are contiguous from 1, so the sequence ---
      // number IS the event count — an exact O(1) per-run cap check.
      if (evt.sequenceNumber > MAX_EVENTS_PER_RUN) {
        throw afrError(
          "EVENT_LIMIT_EXCEEDED",
          `Run ${evt.runId} has reached the maximum of ${MAX_EVENTS_PER_RUN} events`,
        );
      }

      const state = await loadRunState(runId);

      // --- Event Log Rule 5: nothing may follow a terminal event ---
      if (state.hasTerminal) {
        throw afrError(
          "RUN_NOT_ACTIVE",
          `Cannot append event to run ${evt.runId}: a terminal event has already been recorded`,
        );
      }

      const expected = state.maxSeq + 1;
      if (evt.sequenceNumber !== expected) {
        throw afrError(
          "SEQUENCE_CONFLICT",
          `Non-contiguous sequenceNumber for run ${evt.runId}: expected ${expected}, got ${evt.sequenceNumber}`,
        );
      }

      // --- Event Log Rule 5: RUN_STARTED must be the FIRST event ---
      if (state.maxSeq === 0 && evt.type !== RUN_STARTED_TYPE) {
        throw new Error(
          `First event of a run must be "${RUN_STARTED_TYPE}", got "${evt.type}"`,
        );
      }

      // --- Event Log Rule 3: enforce payload externalization threshold ---
      assertPayloadWithinInlineLimit(evt.payload);

      const parentEventId = evt.parentEventId
        ? (evt.parentEventId as Id<"events">)
        : undefined;

      const eventId = await ctx.db.insert("events", {
        runId,
        orgId: run.orgId,
        type: evt.type,
        sequenceNumber: evt.sequenceNumber,
        timestamp: evt.timestamp,
        payload: evt.payload,
        parentEventId,
      });

      // Sticky-reference backfill for artifact GC: an `_externalized` payload
      // points at an artifact record; stamp that artifact with this event's id
      // so it permanently leaves the GC's orphan-candidate set. Patching the
      // ARTIFACT (metadata) — never the event — so event-log immutability holds.
      // Best-effort: a malformed/foreign pointer is simply not stamped (the GC
      // pointer scan remains the fallback).
      const payloadPtr = evt.payload as {
        type?: unknown;
        _artifact?: { artifactId?: unknown };
      } | null;
      if (
        payloadPtr !== null &&
        typeof payloadPtr === "object" &&
        payloadPtr.type === "_externalized" &&
        typeof payloadPtr._artifact?.artifactId === "string"
      ) {
        const normalized = ctx.db.normalizeId(
          "artifacts",
          payloadPtr._artifact.artifactId,
        );
        if (normalized !== null) {
          const artifact = await ctx.db.get(normalized);
          if (
            artifact &&
            artifact.runId === runId &&
            artifact.referencedByEventId === undefined
          ) {
            await ctx.db.patch(normalized, { referencedByEventId: eventId });
          }
        }
      }

      // ADR-002: incremental token-usage counters from llm.response payloads,
      // updated at event-insert time (the log remains the source of truth for
      // the underlying payloads themselves).
      if (evt.type === "llm.response") {
        const { tokensIn, tokensOut } = extractTokenUsage(evt.payload);
        if (tokensIn > 0 || tokensOut > 0) {
          // Re-fetch: a prior iteration in THIS batch may have already patched
          // tokensIn/tokensOut for the same run (read-your-writes within a
          // single Convex mutation execution makes this safe).
          const current = await ctx.db.get(runId);
          await ctx.db.patch(runId, {
            tokensIn: (current?.tokensIn ?? 0) + tokensIn,
            tokensOut: (current?.tokensOut ?? 0) + tokensOut,
          });
        }
      }

      // Cycle 3 (cost accuracy): denormalize the model onto runs.modelsSeen,
      // same tolerant-extraction/bounded-dedup approach as convex/events.ts.
      // Re-fetch for the same read-your-writes reason as the tokensIn/Out
      // patch above — a prior iteration in this batch may have already
      // appended to modelsSeen for the same run.
      if (evt.type === "llm.request" || evt.type === "llm.response") {
        const model = extractModel(evt.payload);
        if (model !== undefined) {
          const current = await ctx.db.get(runId);
          const updated = addModelSeen(current?.modelsSeen, model);
          if (updated !== undefined) {
            await ctx.db.patch(runId, { modelsSeen: updated });
          }
        }
      }

      // Reconcile run.status with the terminal event so the event log (source of
      // truth) and the run's status never disagree. A run.completed/run.failed
      // event immediately transitions the run to the matching terminal status;
      // the SDK's separate updateRunStatus call is then an idempotent no-op.
      if (TERMINAL_EVENT_TYPES.has(evt.type)) {
        const patch: {
          status: "failed" | "completed";
          endedAt: number;
          searchText?: string;
        } = {
          status: evt.type === "run.failed" ? "failed" : "completed",
          endedAt: evt.timestamp,
        };
        // ADR-002: terminal reconcile — append the extracted error message to
        // runs.searchText so a failed run's error text is searchable.
        if (evt.type === "run.failed") {
          const errorMessage = extractErrorMessage(evt.payload);
          if (errorMessage) {
            const current = await ctx.db.get(runId);
            patch.searchText = buildSearchText([current?.searchText, errorMessage]);
          }
        }
        await ctx.db.patch(runId, patch);

        // Cycle 2 (docs/design/action_layer.md): schedule eval auto-run +
        // alert evaluation on the terminal event, NON-BLOCKING. See
        // convex/events.ts createEvent for the identical Clerk-authenticated
        // path. AUDIT FIX (cycle 4): scheduled as ONE action that sequences
        // the two mutations with a real ordering guarantee (see the
        // module-level comment above).
        await ctx.scheduler.runAfter(0, _runEvalsThenEvaluateAlertsRef, { runId });

        // ADR-004: schedule explanation generation only for the failure path
        // (run.completed never gets one — see convex/run_explanations.ts).
        if (evt.type === "run.failed") {
          await ctx.scheduler.runAfter(0, _generateRunExplanationRef, { runId });
        }
      }

      // Advance in-memory state so the next event in the batch validates against it.
      state.maxSeq = evt.sequenceNumber;
      state.hasTerminal = TERMINAL_EVENT_TYPES.has(evt.type);

      insertedCount++;
      insertedBytes += new TextEncoder().encode(JSON.stringify(evt.payload ?? null)).length;

      eventIds.push(eventId);
    }

    if (insertedCount > 0) {
      await incrementUsageCounters(ctx, apiKey.orgId, {
        eventsIngested: insertedCount,
        bytesIngested: insertedBytes,
      });
    }

    return { eventIds };
  },
});

/**
 * Transition a run to a terminal status from an SDK call.
 * Authenticates via API key hash.  Prevents double-termination.
 */
export const sdkUpdateRunStatus = mutation({
  args: {
    apiKeyHash: v.string(),
    runId: v.string(),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    endedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveApiKey(ctx, args.apiKeyHash, INGEST_WRITE);

    const runId = args.runId as Id<"runs">;
    // TENANCY (CLAUDE.md Tenancy Rule 3). Cross-org protection, collapsed into
    // one outcome with the missing-run case.
    const run = await ctx.db.get(runId);

    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found");
    }

    if (TERMINAL_STATUSES.has(run.status)) {
      // Idempotent: transitioning to the SAME terminal status is a no-op (this
      // happens when sdkCreateEvents already reconciled status from the terminal
      // event, then the SDK's separate updateRunStatus call arrives). Only a
      // conflicting terminal transition is an error.
      if (run.status === args.status) {
        return;
      }
      throw new Error(
        `Cannot transition run from terminal status "${run.status}"`,
      );
    }

    await ctx.db.patch(runId, {
      status: args.status,
      endedAt: args.endedAt ?? Date.now(),
    });
  },
});

/**
 * Record an artifact whose content has already been uploaded to blob storage.
 * Authenticates via API key hash (same pattern as sdkCreateEvents).
 */
export const sdkCreateArtifact = mutation({
  args: {
    apiKeyHash: v.string(),
    runId: v.string(),
    eventId: v.optional(v.string()),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    storageKey: v.string(),
    storageBucket: v.string(),
    checksum: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveApiKey(ctx, args.apiKeyHash, INGEST_WRITE);
    // Artifact creation counts one unit against the same per-key ingest window.
    await enforceRateLimit(ctx, apiKey, 1);

    const runId = args.runId as Id<"runs">;
    // TENANCY (CLAUDE.md Tenancy Rule 3). Cross-org protection, collapsed into
    // one outcome with the missing-run case — and placed before the
    // deduplication read below, so a foreign key cannot learn which checksums
    // already exist on another org's run.
    const run = await ctx.db.get(runId);

    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found");
    }

    // Deduplication: if an artifact with the same (runId, checksum) already exists,
    // return it instead of inserting a duplicate. This guards against retry scenarios
    // where the blob upload succeeded but the subsequent /api/events call failed.
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_run_checksum", (q) =>
        q.eq("runId", runId).eq("checksum", args.checksum)
      )
      .unique();

    if (existing !== null) {
      return existing;
    }

    // Write ceiling: bounded count on the by_run index (cheap at this cap size).
    const existingForRun = await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(MAX_ARTIFACTS_PER_RUN);
    if (existingForRun.length >= MAX_ARTIFACTS_PER_RUN) {
      throw afrError(
        "ARTIFACT_LIMIT_EXCEEDED",
        `Run ${args.runId} has reached the maximum of ${MAX_ARTIFACTS_PER_RUN} artifacts`,
      );
    }

    const eventId = args.eventId ? (args.eventId as Id<"events">) : undefined;

    // Validate that the eventId belongs to the same run when provided.
    if (eventId !== undefined) {
      const event = await ctx.db.get(eventId);
      if (!event || event.runId !== runId) {
        throw new Error("Event not found or does not belong to the given run");
      }
    }

    const artifactId = await ctx.db.insert("artifacts", {
      runId,
      orgId: run.orgId,
      eventId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      storageKey: args.storageKey,
      storageBucket: args.storageBucket,
      checksum: args.checksum,
      createdAt: Date.now(),
    });

    await incrementUsageCounters(ctx, apiKey.orgId, { artifactBytes: args.size });

    const artifact = await ctx.db.get(artifactId);
    if (!artifact) throw new Error("Failed to create artifact");
    return artifact;
  },
});

/**
 * Record an eval against a run from an API-key-authenticated caller (e.g. an
 * automated eval pipeline). Requires ingest:write, same as the other ingest
 * mutations. See convex/evals.ts recordEval for the Clerk-authenticated path.
 */
export const sdkRecordEval = mutation({
  args: {
    apiKeyHash: v.string(),
    runId: v.string(),
    agentVersionId: v.optional(v.string()),
    name: v.string(),
    kind: v.union(v.literal("rule"), v.literal("llm_judge"), v.literal("manual")),
    passed: v.boolean(),
    score: v.optional(v.number()),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveApiKey(ctx, args.apiKeyHash, INGEST_WRITE);

    const runId = args.runId as Id<"runs">;
    // TENANCY (CLAUDE.md Tenancy Rule 3). Cross-org protection, collapsed into
    // one outcome with the missing-run case — matching the Clerk-auth twin of
    // this mutation, evals.ts's recordEval.
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found");
    }

    validateEvalFields(args);

    const agentVersionId = args.agentVersionId
      ? (args.agentVersionId as Id<"agent_versions">)
      : undefined;
    if (agentVersionId !== undefined) {
      const version = await ctx.db.get(agentVersionId);
      if (!version || version.orgId !== apiKey.orgId) {
        throw new Error("Agent version not found for this organization");
      }
    }

    const evalId = await ctx.db.insert("evals", {
      orgId: apiKey.orgId,
      runId,
      agentVersionId,
      name: args.name,
      kind: args.kind,
      passed: args.passed,
      score: args.score,
      details: args.details,
      createdAt: Date.now(),
      createdBy: "system",
    });

    const created = await ctx.db.get(evalId);
    if (!created) throw new Error("Failed to record eval");
    return created;
  },
});
