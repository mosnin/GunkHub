// Cycle 2 (docs/design/action_layer.md) — the key-authed READ counterpart to
// sdk_ingest.ts's writes. These are the Convex functions the CLI and other
// external, API-key-authenticated consumers call directly (no Clerk JWT —
// same API-key-hash authentication model as sdk_ingest.ts). Do NOT call
// getAuthContext or requireOrgMembership here, for the same reason
// sdk_ingest.ts doesn't: those require a Clerk JWT this caller does not have.
//
// Every function here requires the "read" scope specifically (see ADR-002 —
// api_keys.scopes gained "read" alongside "ingest:write"/"ingest:read"). A
// write-only key (scopes: ["ingest:write"], no "read") must NOT be able to
// read through these functions — resolveApiKey's scope check (shared with
// sdk_ingest.ts) enforces this: a key with a non-empty scopes array lacking
// the required scope is rejected. A key with NO scopes array at all keeps
// its pre-ADR-002 full-access back-compat behavior, exactly as it does for
// ingest.
//
// Implemented as `mutation`s (not `query`s) even though they only read
// business data: enforcing the per-key rate limit and stamping lastUsedAt —
// both REQUIRED by this cycle's scope — need write access to the api_keys
// document, which a Convex `query` cannot have. This mirrors how
// sdk_ingest.ts's write endpoints already couple business logic to that same
// bookkeeping.

import { v } from "convex/values";

import { mutation } from "./_generated/server.js";
import { DEFAULT_PAGE_SIZE, MAX_EVENTS_PER_REPLAY, MAX_PAGE_SIZE } from "./helpers/pagination.js";
import { buildReplayProjectionMirror } from "./helpers/replay_projection.js";
import { enforceRateLimit, resolveApiKey } from "./sdk_ingest.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

const READ_SCOPE = "read";

/** Shared entry: resolve + authorize the key for the "read" scope, count 1 rate-limit unit. */
async function resolveReadApiKey(ctx: MutationCtx, apiKeyHash: string): Promise<Doc<"api_keys">> {
  const apiKey = await resolveApiKey(ctx, apiKeyHash, READ_SCOPE);
  await enforceRateLimit(ctx, apiKey, 1);
  return apiKey;
}

const RUN_STATUS = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("timed_out"),
);

/**
 * List runs for the key's org, with the same filter shape as convex/runs.ts
 * listRuns (status/agentId/environment/session), paginated. Cross-org
 * references (a foreign agentId) are validated the same way listRuns does.
 */
export const apiListRuns = mutation({
  args: {
    apiKeyHash: v.string(),
    status: v.optional(RUN_STATUS),
    agentId: v.optional(v.string()),
    environment: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    let agentId: Id<"agents"> | undefined;
    if (args.agentId !== undefined) {
      agentId = args.agentId as Id<"agents">;
      const agent = await ctx.db.get(agentId);
      if (!agent || agent.orgId !== apiKey.orgId) {
        throw new Error("Agent not found in this organization");
      }
    }

    if (args.sessionId !== undefined) {
      const runs = await ctx.db
        .query("runs")
        .withIndex("by_org_session", (q) => q.eq("orgId", apiKey.orgId).eq("sessionId", args.sessionId))
        .order("desc")
        .take(limit);
      return { runs, nextCursor: undefined, pageSize: runs.length };
    }

    let runsQuery;
    if (agentId !== undefined) {
      runsQuery = ctx.db.query("runs").withIndex("by_agent_started", (q) => q.eq("agentId", agentId));
    } else if (args.status !== undefined) {
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_org_status", (q) => q.eq("orgId", apiKey.orgId).eq("status", args.status!));
    } else if (args.environment !== undefined) {
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_org_environment_started", (q) =>
          q.eq("orgId", apiKey.orgId).eq("environment", args.environment),
        );
    } else {
      runsQuery = ctx.db.query("runs").withIndex("by_org", (q) => q.eq("orgId", apiKey.orgId));
    }

    // Tenancy safety net, mirroring runs.ts listRuns.
    //
    // AUDIT FIX (cycle 4): when `agentId` is supplied, the branch above
    // selects `by_agent_started`, which encodes neither `status` nor
    // `environment` — both used to be silently dropped whenever combined
    // with `agentId` (e.g. `agentId=X&status=failed` returned ALL of agent
    // X's runs, not just its failed ones, with no error). Re-applied here as
    // in-memory secondary filters, same overfetch-then-filter pattern
    // already used by runs.ts listRuns/listRunsByVerification — redundant
    // but harmless in the branches where the index already encoded the
    // condition (by_org_status / by_org_environment_started).
    const filtered = runsQuery
      .filter((q) => q.eq(q.field("orgId"), apiKey.orgId))
      .filter((q) =>
        args.status === undefined ? q.eq(q.field("_id"), q.field("_id")) : q.eq(q.field("status"), args.status),
      )
      .filter((q) =>
        args.environment === undefined
          ? q.eq(q.field("_id"), q.field("_id"))
          : q.eq(q.field("environment"), args.environment),
      );
    const page = await filtered.paginate({ numItems: limit, cursor: args.cursor ?? null });

    return {
      runs: page.page,
      nextCursor: page.isDone ? undefined : page.continueCursor,
      pageSize: page.page.length,
    };
  },
});

/**
 * A single run plus cheap derived counts. eventCount is read from the
 * highest stored sequenceNumber (O(1) via the by_run index) rather than a
 * `.collect()` — sequence numbers are contiguous from 1 (Event Log Rule 4),
 * so the max sequence number IS the event count. artifactCount is bounded by
 * MAX_ARTIFACTS_PER_RUN already, so a direct count is cheap.
 */
export const apiGetRun = mutation({
  args: { apiKeyHash: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found in this organization");
    }

    const latestEvent = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .order("desc")
      .first();
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();

    return {
      run,
      eventCount: latestEvent ? latestEvent.sequenceNumber : 0,
      artifactCount: artifacts.length,
    };
  },
});

/** Paginated event log for a run, same shape as convex/events.ts listEvents. */
export const apiGetRunEvents = mutation({
  args: {
    apiKeyHash: v.string(),
    runId: v.string(),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found in this organization");
    }

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const page = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .paginate({ numItems: limit, cursor: args.cursor ?? null });

    return {
      events: page.page,
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
  },
});

/**
 * Replay projection for a run, built via the read_api's own mirror of
 * apps/web's buildReplayProjection (see helpers/replay_projection.ts header
 * for why this is a mirror, not a cross-boundary import).
 */
export const apiGetReplay = mutation({
  args: { apiKeyHash: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found in this organization");
    }

    const events = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(MAX_EVENTS_PER_REPLAY);

    return buildReplayProjectionMirror(
      String(runId),
      events.map((e) => ({
        id: String(e._id),
        type: e.type,
        sequenceNumber: e.sequenceNumber,
        timestamp: e.timestamp,
        payload: e.payload,
        parentEventId: e.parentEventId !== undefined ? String(e.parentEventId) : undefined,
      })),
    );
  },
});

// Key-authed (read scope) counterpart to run_explanations.getRunExplanation —
// the "Why did this fail?" root-cause for the v1 API / `afr explain`. Org is
// derived from the key, never a client arg.
//
// AUDIT FIX (Cycle 3, MEDIUM — coarse-null, same finding as
// run_explanations.getRunExplanation): this used to return
// `{ explanation: null }` for both "will never have one" (not
// failed/timed_out/cancelled) and "not generated yet" (eligible, still in
// flight). `status` is the explicit discriminant now, mirroring
// run_explanations.ts's `RunExplanationQueryStatus` exactly, so `afr explain`
// (packages/cli, sdk_quality-owned) can print "not applicable" vs "still
// analyzing, try again shortly" instead of the same blank result for both.
// `explanation` is kept (rather than removed) for backward compatibility
// with any existing caller that only checked truthiness of that field.
const V1_EXPLAINABLE_STATUSES = new Set(["failed", "timed_out", "cancelled"]);

export const apiGetExplanation = mutation({
  args: { apiKeyHash: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found in this organization");
    }
    if (!V1_EXPLAINABLE_STATUSES.has(run.status)) {
      return { status: "not_eligible" as const, explanation: null, runStatus: run.status, runEndedAt: run.endedAt };
    }
    const explanation = await ctx.db
      .query("run_explanations")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .first();
    if (!explanation || explanation.orgId !== run.orgId) {
      return { status: "pending" as const, explanation: null, runStatus: run.status, runEndedAt: run.endedAt };
    }
    return { status: "ready" as const, explanation, runStatus: run.status, runEndedAt: run.endedAt };
  },
});
