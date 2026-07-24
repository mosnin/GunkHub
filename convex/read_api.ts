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
// Constants ONLY — deliberately not this module's mutations/queries. Those are
// Clerk-authed and cannot be called from this key-authed surface (see header).
// Cycle 1 avoided importing convex/failure_patterns.ts at all because it was
// another team's in-flight deliverable; it has since landed, and the exposure
// bounds below MUST be the same numbers on both surfaces — a `read_api` that
// scanned to a different ceiling than `getPatternResolutionEvidence` would
// report a different exposure count for the same pattern depending on which
// door you came in, which is a silent correctness bug of exactly the kind
// this cycle exists to eliminate. Importing the constants makes that drift
// impossible; duplicating them would only make it invisible.
import {
  MAX_AFFECTED_AGENT_IDS,
  MAX_AGENT_SET_OCCURRENCE_SCAN,
  MAX_PATTERN_LIFECYCLE_TRANSITIONS,
  RESOLUTION_RUN_SCAN_CAP,
} from "./failure_patterns.js";
import { afrError } from "./helpers/errors.js";
import { DEFAULT_PAGE_SIZE, MAX_EVENTS_PER_REPLAY, MAX_PAGE_SIZE } from "./helpers/pagination.js";
import { buildReplayProjectionMirror } from "./helpers/replay_projection.js";
import { fixConfidence } from "./insights.js";
import { enforceRateLimit, resolveApiKey } from "./sdk_ingest.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type {
  PatternLifecycleTransition,
  PatternResolutionExposure,
  PatternResolutionMetadata,
} from "./failure_patterns.js";
import type { FixConfidenceResult } from "./insights.js";

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

// Key-authed (read scope) counterpart to the Failure Patterns rollup
// (PREVENTION, cycle 1 — docs/adr/005-failure-patterns.md, schema.ts's
// `failure_patterns` table). Powers `afr patterns` / the SDK's read client:
// a durable, org-scoped memory of recurring failure fingerprints, ranked by
// recency. This queries the `failure_patterns` rollup table directly (same
// "mirror the shape, don't cross-import an in-progress owner's function"
// approach apiListRuns/apiGetRun/apiGetReplay already take here) rather than
// depending on convex/failure_patterns.ts, which is a separate team's
// same-cycle deliverable and may not exist yet.
//
// `agentId`, when supplied, is validated org-scoped exactly like apiListRuns'
// `agentId` filter, then resolved to that agent's `agent_versions` ids so the
// (already org-scoped, already paginated) page of patterns can be narrowed to
// ones whose `affectedAgentVersionIds` intersects — an in-memory filter over
// the fetched page, same overfetch-then-filter pattern apiListRuns uses for
// its own secondary filters.
//
// `spiking`, when `true` (PREVENTION cycle 2 — proactive filtering), narrows
// the same fetched page further to patterns whose most recent spike
// assessment flagged them as currently spiking
// (`lastSpikeAssessment?.isSpiking === true`). Same overfetch-then-filter
// in-memory approach as `agentId` above — there is no secondary index on
// `lastSpikeAssessment.isSpiking` (it's an optional nested field on a rollup
// row, not worth a dedicated index for what is an observability-grade,
// derived filter). `spiking: false` (or omitted) returns all patterns,
// unfiltered by spike status.
//
// `muted` (PREVENTION cycle 3, "mute reflection" — sdk_quality) is the same
// shape of filter again, this time over the `muted` flag an org admin sets
// via the (separate, Clerk-authed, audited) admin mute route — NOT a write
// this key-authed surface exposes. `muted: true` narrows to muted patterns,
// `muted: false` to active/unmuted ones, omitted returns all regardless of
// mute state.
function isPatternMuted(pattern: Doc<"failure_patterns">): boolean {
  return pattern.muted === true;
}

// `status`/`regressed` (Resolution cycle 1 — docs/adr/006-failure-resolution.md,
// Team A's lifecycle fields on `failure_patterns`): same overfetch-then-filter,
// in-memory approach as `spiking`/`muted` above — no secondary index on
// `status`/`regressedAt`, both are read-side-only narrowings over the already
// org-scoped page. `status`, when supplied, matches exactly against the
// pattern's `status` field, treating an absent field as `"open"` (the
// documented default for every pre-lifecycle row). `regressed: true` narrows
// to patterns that currently have `regressedAt` set. Neither param sets
// lifecycle state — that only changes via the member-gated, audited
// acknowledge/resolve/reopen mutations (not owned by this file), exactly
// like `muted` is never set here.
function patternStatus(pattern: Doc<"failure_patterns">): string {
  return pattern.status ?? "open";
}

// ---------------------------------------------------------------------------
// `state` (ADR-006 cycle 2) — the FIX-CONFIDENCE grade, Team B's vocabulary
// verbatim (`FixConfidenceState`, convex/insights.ts §12). A different axis
// from `status`: `status` is what a human ASSERTED, `state` is what the
// evidence SUPPORTS. Both are exposed, and they are deliberately not merged.
//
// WHY ONLY "regressed" IS ACCEPTED HERE, AND WHY THE REST THROW:
//
// Three of the four states ("unproven" / "proving" / "confirmed") are
// functions of POST-RESOLUTION EXPOSURE — how many runs have executed since
// the fix. Computing that for one pattern is a bounded scan of up to
// RESOLUTION_RUN_SCAN_CAP (2000) run rows across up to MAX_AFFECTED_AGENT_IDS
// agents. Doing it for a whole page of up to MAX_PAGE_SIZE patterns is a
// six-figure row read on a single request — not a slow endpoint, an endpoint
// that cannot exist. So this surface cannot answer those three, and it says
// so with a 422 (INVALID_ARGUMENT) that names the endpoint which CAN:
// apiGetFailurePatternEvidence, one pattern at a time.
//
// "regressed" is the exception because it is exposure-INDEPENDENT: it falls
// out of `recurred` alone, which is decided by two timestamps already on the
// rollup. Exact, O(1) per pattern, no scan.
//
// The alternative designs were both worse, and both are the failure mode this
// project keeps hitting:
//   - Accept all four and quietly return nothing for the expensive three:
//     that is a silently-dropped filter, the exact class of bug that shipped
//     unnoticed for weeks last cycle.
//   - Accept all four and compute them without exposure: every unrecurred
//     pattern reads "unproven" regardless of how well-tested it actually is —
//     a wrong answer dressed as a real one.
// Rejecting loudly is the only option that never lies. When a future cycle
// snapshots confidence onto the rollup, this restriction lifts without the
// param changing name or meaning.
//
// This is ALSO why `state=regressed` is not redundant with the existing
// `regressed` boolean, and why a CI job should prefer it: `regressed: true`
// matches any pattern with `regressedAt` SET, including one whose regression
// predates its current resolution (regressed, then genuinely re-fixed and
// re-resolved — `resolvePattern` deliberately preserves `regressedAt` as
// history). `state=regressed` matches only a recurrence STRICTLY AFTER the
// live `resolvedAt`, i.e. a fix that actually did not hold. Using the boolean
// for "fail the build if a confirmed-fixed pattern regressed" would fail
// builds on patterns that were already fixed again.
// ---------------------------------------------------------------------------
const EXPOSURE_DEPENDENT_STATE_MESSAGE =
  'state filter supports only "regressed" on this endpoint; "unproven"/"proving"/"confirmed" depend on post-resolution run exposure, which is measured per pattern by apiGetFailurePatternEvidence';

/**
 * The evidence state of a rollup, computed WITHOUT measuring exposure.
 *
 * Delegates to Team B's `fixConfidence` rather than reimplementing the
 * precedence rules, so the recurrence definition ("strictly after
 * `resolvedAt`", and a recurrence with no usable resolution still counts)
 * cannot drift from §12. Exposure is deliberately left unmeasured, which is
 * why only the `regressed` verdict from this call is trustworthy — every
 * other pattern necessarily reads `unproven` here.
 */
function recurredSinceResolution(pattern: Doc<"failure_patterns">, now: number): boolean {
  return (
    fixConfidence(
      {
        ...(pattern.resolvedAt !== undefined && { resolvedAt: pattern.resolvedAt }),
        ...(pattern.regressedAt !== undefined && { recurredAt: pattern.regressedAt }),
      },
      now,
    ).state === "regressed"
  );
}

export const apiListFailurePatterns = mutation({
  args: {
    apiKeyHash: v.string(),
    agentId: v.optional(v.string()),
    spiking: v.optional(v.boolean()),
    muted: v.optional(v.boolean()),
    status: v.optional(v.union(v.literal("open"), v.literal("acknowledged"), v.literal("resolved"))),
    regressed: v.optional(v.boolean()),
    // Declared with Team B's FULL four-literal vocabulary (never a parallel
    // one), so the accepted values are self-documenting and the three this
    // endpoint cannot answer are rejected explicitly rather than by an
    // opaque validator error.
    state: v.optional(
      v.union(
        v.literal("unproven"),
        v.literal("proving"),
        v.literal("confirmed"),
        v.literal("regressed"),
      ),
    ),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Rejected BEFORE the key is resolved and the rate-limit unit is spent: an
    // argument this endpoint structurally cannot honor is a malformed request,
    // and it should not cost the caller a token of their per-minute budget.
    if (args.state !== undefined && args.state !== "regressed") {
      throw afrError("INVALID_ARGUMENT", EXPOSURE_DEPENDENT_STATE_MESSAGE);
    }

    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    // AUDIT FIX (cycle 3): clamp below 1 as well as above MAX_PAGE_SIZE — an
    // unclamped non-positive `limit` (e.g. `--limit -5`, or `0`) used to be
    // passed straight to `.paginate({ numItems })` unvalidated, which is at
    // best a confusing empty/degenerate page and at worst an unhandled
    // Convex-side error surfaced as a raw 500. Every caller-supplied `limit`
    // on this key-authed surface should produce either "the request was
    // rejected in a well-understood way" or "a valid, bounded page" — never
    // an unbounded or negative page size reaching the database layer.
    const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

    let agentVersionIds: Set<string> | undefined;
    if (args.agentId !== undefined) {
      const agentId = args.agentId as Id<"agents">;
      const agent = await ctx.db.get(agentId);
      if (!agent || agent.orgId !== apiKey.orgId) {
        throw new Error("Agent not found in this organization");
      }
      const versions = await ctx.db
        .query("agent_versions")
        .withIndex("by_agent", (q) => q.eq("agentId", agentId))
        .collect();
      agentVersionIds = new Set(versions.map((version) => String(version._id)));
    }

    const page = await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_lastSeenAt", (q) => q.eq("orgId", apiKey.orgId))
      .order("desc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });

    let patterns =
      agentVersionIds === undefined
        ? page.page
        : page.page.filter((pattern) =>
            pattern.affectedAgentVersionIds.some((versionId) => agentVersionIds.has(String(versionId))),
          );

    if (args.spiking === true) {
      patterns = patterns.filter((pattern) => pattern.lastSpikeAssessment?.isSpiking === true);
    }

    if (args.muted !== undefined) {
      patterns = patterns.filter((pattern) => isPatternMuted(pattern) === args.muted);
    }

    if (args.status !== undefined) {
      patterns = patterns.filter((pattern) => patternStatus(pattern) === args.status);
    }

    if (args.regressed === true) {
      patterns = patterns.filter((pattern) => pattern.regressedAt !== undefined);
    }

    if (args.state === "regressed") {
      const now = Date.now();
      patterns = patterns.filter((pattern) => recurredSinceResolution(pattern, now));
    }

    return {
      patterns,
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
  },
});

// ---------------------------------------------------------------------------
// Key-authed (read scope) counterpart to convex/failure_patterns.ts's
// `getPatternResolutionEvidence` (ADR-006 cycle 2, "prove the fix held").
// Powers `afr patterns evidence <fingerprint>` and the SDK reader's
// `getFailurePatternEvidence`.
//
// A MIRROR, not a call: `getPatternResolutionEvidence` is a Clerk-authed
// `query` gated on `requireOrgMembership`, which this surface has no JWT to
// satisfy (see this file's header). The two exposure helpers it uses are
// module-private there, so they are re-expressed below against the same
// tables, the same indexes, and — crucially — the SAME EXPORTED BOUNDS, so
// the two doors cannot report different numbers for the same pattern.
//
// STRICTLY READ-ONLY, exactly like every other function in this file. It
// reports the lifecycle and its evidence; it never sets any of it. ADR-006's
// acknowledge/resolve/reopen remain member-gated, Clerk-authed and audited,
// and are deliberately absent from this key-authed surface — an API key has
// no human actor to attribute a privileged state change to, and
// `audit_log.actorClerkUserId` exists precisely to answer "which person did
// this". Reading proof that a fix held needs no human actor; asserting that
// it held does. That asymmetry is why this endpoint exists and a key-authed
// `resolve` does not.
// ---------------------------------------------------------------------------

/** Mirror of failure_patterns.ts's private `resolveAgentIdsForPattern` — same sources, same bounds. */
async function resolveAgentIdsForPatternMirror(
  ctx: MutationCtx,
  pattern: Doc<"failure_patterns">,
): Promise<Id<"agents">[]> {
  if (pattern.affectedAgentIds && pattern.affectedAgentIds.length > 0) {
    return pattern.affectedAgentIds;
  }

  // Fallback for rollups written before `affectedAgentIds` existed. Org-scoped
  // by construction: reached only via this fingerprint's own org-scoped index.
  const occurrences = await ctx.db
    .query("failure_pattern_occurrences")
    .withIndex("by_org_fingerprint", (q) =>
      q.eq("orgId", pattern.orgId).eq("fingerprintHash", pattern.fingerprintHash),
    )
    .order("desc")
    .take(MAX_AGENT_SET_OCCURRENCE_SCAN);

  const seen: Id<"agents">[] = [];
  for (const occurrence of occurrences) {
    if (!seen.includes(occurrence.agentId)) seen.push(occurrence.agentId);
    if (seen.length >= MAX_AFFECTED_AGENT_IDS) break;
  }
  return seen;
}

/**
 * Mirror of failure_patterns.ts's private `countRunsStartedInWindow`, in the
 * open-ended ("runs since resolution") form this caller needs.
 *
 * Deliberately NOT clamped to `Date.now()`: SDK-supplied `startedAt` values
 * and clock skew mean a run can legitimately sit marginally ahead of the
 * reader's clock, and dropping it would UNDERCOUNT exposure — the one
 * direction this number must never err in, because undercounted exposure
 * makes an untested fix look better tested than it is.
 */
async function countRunsStartedSinceMirror(
  ctx: MutationCtx,
  agentIds: Id<"agents">[],
  afterExclusive: number,
): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  for (const agentId of agentIds) {
    const remaining = RESOLUTION_RUN_SCAN_CAP - count;
    if (remaining <= 0) return { count, truncated: true };

    // take(remaining + 1) so hitting the ceiling is DETECTABLE (a full page
    // plus one) rather than indistinguishable from "exactly `remaining` runs".
    const rows = await ctx.db
      .query("runs")
      .withIndex("by_agent_started", (q) => q.eq("agentId", agentId).gt("startedAt", afterExclusive))
      .take(remaining + 1);

    if (rows.length > remaining) return { count: RESOLUTION_RUN_SCAN_CAP, truncated: true };
    count += rows.length;
  }
  return { count, truncated: false };
}

export interface ApiPatternResolutionEvidence {
  pattern: Doc<"failure_patterns">;
  resolution: PatternResolutionMetadata | null;
  exposure: PatternResolutionExposure | null;
  /** Oldest-first, bounded to the MAX_PATTERN_LIFECYCLE_TRANSITIONS most recent. */
  transitions: PatternLifecycleTransition[];
  /**
   * Team B's graded verdict over the evidence above (convex/insights.ts §12).
   * Null exactly when `resolution` is null — with nothing asserted there is
   * nothing to grade, and a fabricated "unproven" would read as a judgment
   * about a fix rather than the absence of one.
   */
  confidence: FixConfidenceResult | null;
}

export const apiGetFailurePatternEvidence = mutation({
  args: { apiKeyHash: v.string(), fingerprintHash: v.string() },
  handler: async (ctx, args): Promise<ApiPatternResolutionEvidence | null> => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);

    const pattern = await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_fingerprint", (q) =>
        q.eq("orgId", apiKey.orgId).eq("fingerprintHash", args.fingerprintHash),
      )
      .first();
    // Null (not a throw) collapses "never existed" and "belongs to another
    // org" into one indistinguishable answer, exactly as every other
    // fingerprint-scoped lookup in this codebase does — a caller who could
    // tell those apart would have an existence oracle for another org's data.
    if (!pattern) return null;

    // Lifecycle transitions come from the APPEND-ONLY audit log, not a mutable
    // history table. Read newest-first so the bound keeps the most RECENT
    // transitions, then reversed into the oldest-first order a timeline
    // renders in. Includes the regression guard's own automatic
    // `failure_pattern.regressed` rows (actor "system").
    const auditRows = await ctx.db
      .query("audit_log")
      .withIndex("by_org_target", (q) =>
        q.eq("orgId", apiKey.orgId).eq("targetType", "failure_pattern").eq("targetId", args.fingerprintHash),
      )
      .order("desc")
      .take(MAX_PATTERN_LIFECYCLE_TRANSITIONS);

    const transitions: PatternLifecycleTransition[] = auditRows
      .map((row) => ({
        action: row.action,
        actorClerkUserId: row.actorClerkUserId,
        timestamp: row.timestamp,
        metadata: row.metadata as unknown,
      }))
      .reverse();

    // No live resolution to evidence. Also the state after a MANUAL reopen
    // (which clears `resolvedAt`) — but NOT after the regression guard's
    // auto-reopen, which KEEPS `resolvedAt` precisely so the "your fix didn't
    // hold" evidence below stays computable. A pattern with status "open" and
    // a non-null exposure is therefore valid and expected, not a bug.
    if (pattern.resolvedAt === undefined) {
      return { pattern, resolution: null, exposure: null, transitions, confidence: null };
    }

    const resolvedInVersion =
      pattern.resolvedInVersionId !== undefined ? await ctx.db.get(pattern.resolvedInVersionId) : null;

    const resolution: PatternResolutionMetadata = {
      resolvedAt: pattern.resolvedAt,
      resolvedByUserId: pattern.resolvedByUserId,
      resolutionNote: pattern.resolutionNote,
      resolutionRef: pattern.resolutionRef,
      resolvedInVersionId: pattern.resolvedInVersionId,
      // Defensive org re-check: resolvePattern validated this id at write
      // time, but a version could have been purged/replaced since, and a
      // cross-org string must never be rendered from here.
      resolvedInVersion:
        resolvedInVersion && resolvedInVersion.orgId === apiKey.orgId ? resolvedInVersion.version : undefined,
      resolvedAtOccurrenceCount: pattern.resolvedAtOccurrenceCount,
      resolvedAtRunCount: pattern.resolvedAtRunCount,
    };

    const agentIds = await resolveAgentIdsForPatternMirror(ctx, pattern);
    const exposureRuns = await countRunsStartedSinceMirror(ctx, agentIds, pattern.resolvedAt);

    // EXACT when the snapshot exists. When it does not (a row resolved before
    // this cycle shipped), 0 — NOT the all-time `count`, which would claim
    // every occurrence the pattern ever had as a post-resolution recurrence.
    const recurrenceCount =
      pattern.resolvedAtOccurrenceCount !== undefined
        ? Math.max(0, pattern.count - pattern.resolvedAtOccurrenceCount)
        : 0;

    const exposure: PatternResolutionExposure = {
      since: pattern.resolvedAt,
      runCount: exposureRuns.count,
      runCountTruncated: exposureRuns.truncated,
      recurrenceCount,
      baselineRunCount: pattern.resolvedAtRunCount,
      agentIds,
      // "Held SO FAR" — zero recurrences since resolution. NOT a claim the fix
      // is correct: `runCount` is what says whether this is meaningful
      // evidence. `heldSoFar: true` with `runCount: 0` means simply untested,
      // which is why `confidence.state` below reads "unproven" there and never
      // "confirmed".
      heldSoFar: recurrenceCount === 0,
    };

    // `recurredAt` prefers the regression guard's own stamp. The fallback
    // matters: a pattern can carry recurrences (count > resolvedAtOccurrence-
    // Count) while `regressedAt` is absent or stale — e.g. a rollup resolved
    // before the guard shipped. Without the fallback, fixConfidence would see
    // no counter-example and could grade a demonstrably-recurring pattern
    // "proving" or even "confirmed" while `exposure.heldSoFar` said false in
    // the very same response. `lastSeenAt` is the best available timestamp for
    // that most recent occurrence, and when recurrenceCount > 0 it is by
    // construction after `resolvedAt`.
    const recurredAt =
      pattern.regressedAt ?? (recurrenceCount > 0 ? pattern.lastSeenAt : undefined);

    const confidence = fixConfidence(
      {
        resolvedAt: pattern.resolvedAt,
        ...(pattern.resolvedInVersionId !== undefined && {
          resolvedInVersionId: pattern.resolvedInVersionId,
        }),
        // `exposureVersionId` is deliberately NOT supplied: exposure here is
        // counted per AGENT (runs started for the pattern's affected agents),
        // not per agent VERSION, so there is no single version the count can
        // honestly be attributed to. Omitting it yields
        // `versionAttribution: "unknown"`, which is the truth. Supplying
        // `resolvedInVersionId` for both sides would manufacture a "matched"
        // verdict out of nothing.
        postResolutionRuns: exposure.runCount,
        ...(recurredAt !== undefined && { recurredAt }),
      },
      Date.now(),
    );

    return { pattern, resolution, exposure, transitions, confidence };
  },
});
