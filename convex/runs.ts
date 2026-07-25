// Status transitions: pending -> running -> completed|failed|cancelled|timed_out

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { recordAuditEvent } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./helpers/pagination.js";
import {
  buildSearchText,
  validateEnvironment,
  validateLabels,
  validateSessionId,
} from "./helpers/run_fields.js";
import { incrementUsageCounters } from "./usage.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

// ADR-004 — "Why did this fail?" run explanations. updateRunStatus is an
// admin-driven terminal transition that does NOT go through convex/events.ts's
// run.failed event path, so it must independently schedule explanation
// generation for any transition landing on failed/timed_out/cancelled — see
// convex/run_explanations.ts.
const _generateRunExplanationRef = makeFunctionReference<"action">(
  "run_explanations:generateRunExplanation",
);
const EXPLAINABLE_STATUSES = new Set(["failed", "timed_out", "cancelled"]);

/**
 * List runs scoped to the caller's org, with optional filters.
 */
export const listRuns = query({
  args: {
    orgId: v.id("organizations"),
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled"),
        v.literal("timed_out"),
      ),
    ),
    startedAfter: v.optional(v.number()),
    // ADR-002: environment filter. Only applied via the dedicated
    // by_org_environment_started index when agentId/projectId are NOT also
    // supplied (those take precedence, as before); otherwise it is applied
    // as an in-memory secondary filter, same pattern as listRunsByVerification.
    environment: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // TENANCY: the agent/project filters use NON-org-scoped indexes
    // (by_agent_started / by_project_started), so validate that the supplied id
    // actually belongs to the caller's org BEFORE querying — mirroring
    // createRun's reference validation. The post-hoc orgId filter below would
    // already return zero rows for a foreign id, but failing loudly here makes
    // a cross-org probe indistinguishable from a missing record.
    if (args.agentId !== undefined) {
      const agent = await ctx.db.get(args.agentId);
      if (!agent || agent.orgId !== args.orgId) {
        throw afrError("NOT_FOUND", "Agent not found in this organization");
      }
    }
    if (args.projectId !== undefined) {
      const project = await ctx.db.get(args.projectId);
      if (!project || project.orgId !== args.orgId) {
        throw afrError("NOT_FOUND", "Project not found in this organization");
      }
    }

    let runsQuery;

    if (args.agentId !== undefined) {
      // Agent filter — use by_agent_started for date range support
      if (args.startedAfter !== undefined) {
        runsQuery = ctx.db.query("runs").withIndex("by_agent_started", (q) =>
          q.eq("agentId", args.agentId!).gte("startedAt", args.startedAfter!),
        );
      } else {
        runsQuery = ctx.db.query("runs").withIndex("by_agent_started", (q) =>
          q.eq("agentId", args.agentId!),
        );
      }
    } else if (args.projectId !== undefined) {
      // Project filter — use by_project_started for date range support
      if (args.startedAfter !== undefined) {
        runsQuery = ctx.db.query("runs").withIndex("by_project_started", (q) =>
          q.eq("projectId", args.projectId!).gte("startedAt", args.startedAfter!),
        );
      } else {
        runsQuery = ctx.db.query("runs").withIndex("by_project_started", (q) =>
          q.eq("projectId", args.projectId!),
        );
      }
    } else if (args.status !== undefined && args.startedAfter !== undefined) {
      // Combined status + date range — use new compound index
      runsQuery = ctx.db.query("runs").withIndex("by_org_status_started", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status!).gte("startedAt", args.startedAfter!),
      );
    } else if (args.status !== undefined) {
      // Status filter only
      runsQuery = ctx.db.query("runs").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status!),
      );
    } else if (args.startedAfter !== undefined) {
      // Date range only — use existing by_org_started
      runsQuery = ctx.db.query("runs").withIndex("by_org_started", (q) =>
        q.eq("orgId", args.orgId).gte("startedAt", args.startedAfter!),
      );
    } else if (args.environment !== undefined) {
      // ADR-002: environment filter only, no agent/project/status — use the
      // dedicated index instead of a full org scan.
      runsQuery = ctx.db.query("runs").withIndex("by_org_environment_started", (q) =>
        q.eq("orgId", args.orgId).eq("environment", args.environment),
      );
    } else {
      // No filters — all runs for org
      runsQuery = ctx.db.query("runs").withIndex("by_org", (q) =>
        q.eq("orgId", args.orgId),
      );
    }

    // Keep orgId safety check only — other conditions are now covered by index selection.
    // This prevents cross-org data leakage in case an invalid agentId or projectId is passed.
    // ADR-002: when the environment filter couldn't drive index selection above
    // (agentId/projectId/status/startedAfter took precedence), apply it here as
    // an in-memory secondary filter — same overfetch-then-filter tradeoff already
    // accepted elsewhere (listRunsByVerification) rather than adding yet more
    // compound indexes for every filter combination.
    //
    // AUDIT FIX (cycle 4): `status` needs the exact same secondary-filter
    // treatment. When `agentId` (or `projectId`) is supplied, the branches
    // above select `by_agent_started`/`by_project_started`, which does NOT
    // encode `status` — so `status` was silently dropped whenever it was
    // combined with `agentId`/`projectId` (e.g. `?agentId=X&status=failed`
    // used to return ALL of agent X's runs, not just its failed ones, with
    // no error). Re-applying it here is redundant-but-harmless in the
    // branches where the index already encoded it (by_org_status /
    // by_org_status_started) and load-bearing in the agentId/projectId
    // branches where it didn't.
    const filtered = runsQuery
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
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
      // Number of runs in THIS page — NOT a grand total across all pages. Renamed
      // from the misleading `total` (which UI read as a full count).
      pageSize: page.page.length,
    };
  },
});

const RUN_STATUS = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("timed_out"),
);

/**
 * `listRunsByVerification`'s own cursor format (opaque to callers — just a
 * string they pass back unmodified).
 *
 * Why not just `page.continueCursor` from the underlying index query: that
 * query's page can contain MORE matches (after in-memory secondary filtering)
 * than `limit`, because of the overfetch multiplier below. If we trimmed to
 * `limit` and the underlying page happened to be `isDone`, the untrimmed
 * remainder would be silently dropped — a real, observed bug (a page of 4
 * overfetched rows containing 2 matches, with `limit: 1`, would return 1 match
 * and `nextCursor: undefined`, losing the second match forever). `skip` lets
 * us resume mid-batch by re-reading the same underlying page and skipping the
 * matches already delivered, instead of only being able to resume at the next
 * underlying page boundary.
 */
interface VerifyCursor {
  underlyingCursor: string | null;
  skip: number;
}

function decodeVerifyCursor(cursor: string | undefined): VerifyCursor {
  if (!cursor) return { underlyingCursor: null, skip: 0 };
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (
      parsed && typeof parsed === "object" &&
      "skip" in parsed && typeof (parsed as { skip: unknown }).skip === "number"
    ) {
      const p = parsed as { underlyingCursor: string | null; skip: number };
      return { underlyingCursor: p.underlyingCursor ?? null, skip: p.skip };
    }
  } catch {
    // fall through to defensive fallback below
  }
  // Defensive fallback: treat an unparsable cursor as a raw underlying cursor
  // (should not happen for cursors this query itself produced).
  return { underlyingCursor: cursor, skip: 0 };
}

function encodeVerifyCursor(c: VerifyCursor): string {
  return JSON.stringify(c);
}

/**
 * List runs whose latest integrity verification matches `verifyFilter`, scoped
 * to the caller's org. This is the real server-side counterpart to the runs
 * page's "/runs?verify=failed|passed|unverified" filter — previously that
 * filter was applied client-side over a single page of `listRuns` results,
 * which silently understated failures beyond page 1. See the `by_org_isvalid`
 * index comment in schema.ts for why this table (not `runs`) is the query base
 * for "failed"/"passed".
 *
 * Design choice: a dedicated query rather than folding this into `listRuns`.
 * `listRuns` is driven entirely by indexes ON THE `runs` TABLE (by_org,
 * by_org_status, by_agent_started, ...); "failed"/"passed" are properties of a
 * SEPARATE table (`verification_results`), so answering them efficiently means
 * the base paginated cursor must walk `verification_results`, not `runs` — a
 * different iteration source with a different cursor space. Bolting that onto
 * `listRuns` would mean two incompatible pagination strategies live behind one
 * `cursor` argument (silently wrong if a caller flips `verifyFilter` mid-scroll
 * while reusing a cursor from the other source). A separate query makes the
 * cursor's origin unambiguous and keeps `listRuns` simple for the common case.
 *
 * Secondary filters (status/agentId/projectId/startedAfter) are checked
 * in-memory against each candidate run after the indexed base fetch, so a
 * bounded overfetch multiplier is used to improve the odds of filling a full
 * page — the same over-fetch-then-filter pattern already used in
 * projection_verify.ts (`_getRecentTerminalRuns`, `listRecentFailedVerifications`).
 * Precedence: the verify filter always wins — it selects the base result set;
 * the other filters only narrow within it, and (like `listRuns`) `pageSize` is
 * this page's match count, not a global total.
 */
export const listRunsByVerification = query({
  args: {
    orgId: v.id("organizations"),
    verifyFilter: v.union(v.literal("failed"), v.literal("passed"), v.literal("unverified")),
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    status: v.optional(RUN_STATUS),
    startedAfter: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    // Bounded overfetch: secondary filters are applied after the indexed base
    // fetch, so read more than `limit` candidates to improve the chance of
    // filling a full page. Still bounded (MAX_PAGE_SIZE * 4 at worst).
    const OVERFETCH = 4;

    // TENANCY: validate cross-org references up front, mirroring listRuns.
    if (args.agentId !== undefined) {
      const agent = await ctx.db.get(args.agentId);
      if (!agent || agent.orgId !== args.orgId) {
        throw afrError("NOT_FOUND", "Agent not found in this organization");
      }
    }
    if (args.projectId !== undefined) {
      const project = await ctx.db.get(args.projectId);
      if (!project || project.orgId !== args.orgId) {
        throw afrError("NOT_FOUND", "Project not found in this organization");
      }
    }

    function matchesSecondaryFilters(run: Doc<"runs">): boolean {
      // Tenancy safety net — every branch below already scopes by orgId, but
      // this makes cross-org leakage impossible even if that changes later.
      if (run.orgId !== args.orgId) return false;
      if (args.agentId !== undefined && run.agentId !== args.agentId) return false;
      if (args.projectId !== undefined && run.projectId !== args.projectId) return false;
      if (args.status !== undefined && run.status !== args.status) return false;
      if (args.startedAfter !== undefined && run.startedAt < args.startedAfter) return false;
      return true;
    }

    const { underlyingCursor, skip } = decodeVerifyCursor(args.cursor);

    if (args.verifyFilter === "unverified") {
      // Base source: the runs table (there is no row to index on for "absence
      // of a verification_results record"), reusing listRuns' org-scoped index
      // selection so status/agent/project stay indexed.
      let runsQuery;
      if (args.agentId !== undefined) {
        runsQuery = ctx.db.query("runs").withIndex("by_agent_started", (q) =>
          q.eq("agentId", args.agentId!),
        );
      } else if (args.projectId !== undefined) {
        runsQuery = ctx.db.query("runs").withIndex("by_project_started", (q) =>
          q.eq("projectId", args.projectId!),
        );
      } else if (args.status !== undefined) {
        runsQuery = ctx.db.query("runs").withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", args.status!),
        );
      } else {
        runsQuery = ctx.db.query("runs").withIndex("by_org", (q) => q.eq("orgId", args.orgId));
      }

      const filtered = runsQuery.filter((q) => q.eq(q.field("orgId"), args.orgId));
      const page = await filtered.paginate({ numItems: limit * OVERFETCH, cursor: underlyingCursor });

      const matches: Doc<"runs">[] = [];
      for (const run of page.page) {
        if (!matchesSecondaryFilters(run)) continue;
        const existing = await ctx.db
          .query("verification_results")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .first();
        if (existing) continue; // has a result -> not "unverified"
        matches.push(run);
      }

      const windowed = matches.slice(skip, skip + limit);
      let nextCursor: string | undefined;
      if (matches.length > skip + limit) {
        // More matches already fetched in THIS underlying batch — resume by
        // skipping further into it rather than advancing the underlying cursor.
        nextCursor = encodeVerifyCursor({ underlyingCursor, skip: skip + limit });
      } else if (!page.isDone) {
        nextCursor = encodeVerifyCursor({ underlyingCursor: page.continueCursor, skip: 0 });
      }

      return {
        runs: windowed,
        nextCursor,
        pageSize: windowed.length,
      };
    }

    // "failed" | "passed" — base source: verification_results, via the
    // by_org_isvalid index (see schema.ts for the justification).
    const isValid = args.verifyFilter === "passed";
    const vrQuery = ctx.db
      .query("verification_results")
      .withIndex("by_org_isvalid", (q) => q.eq("orgId", args.orgId).eq("isValid", isValid));
    const vrPage = await vrQuery.paginate({ numItems: limit * OVERFETCH, cursor: underlyingCursor });

    const matches: Doc<"runs">[] = [];
    for (const vr of vrPage.page) {
      // Tenancy safety net (index already scopes this, belt-and-suspenders).
      if (vr.orgId !== args.orgId) continue;
      const run = await ctx.db.get(vr.runId);
      if (!run) continue; // purged since the verification result was written
      if (!matchesSecondaryFilters(run)) continue;
      matches.push(run);
    }

    const windowed = matches.slice(skip, skip + limit);
    let nextCursor: string | undefined;
    if (matches.length > skip + limit) {
      nextCursor = encodeVerifyCursor({ underlyingCursor, skip: skip + limit });
    } else if (!vrPage.isDone) {
      nextCursor = encodeVerifyCursor({ underlyingCursor: vrPage.continueCursor, skip: 0 });
    }

    return {
      runs: windowed,
      nextCursor,
      pageSize: windowed.length,
    };
  },
});

/**
 * Get a single run by ID.
 *
 * Throws "Run not found" when the run does not exist AND when it belongs to
 * another organization. Those two cases are deliberately indistinguishable.
 *
 * TENANCY (CLAUDE.md Tenancy Rule 3). This previously threw "Run not found" for
 * a missing run but "Unauthorized: not a member of this organization" for a run
 * owned by another org, which made it an existence oracle: any authenticated
 * caller could present well-formed run IDs and learn which ones were real in
 * organizations they cannot see. apps/web's export route mapped that same
 * distinction onto 404-vs-500, promoting the oracle to an HTTP status code.
 *
 * The caller's org is now resolved from auth ALONE, before args.runId is
 * observed at all, so every authorization throw is a statement about the caller
 * and reveals nothing about which runs exist.
 *
 * NOT swallowed: genuine failures (unauthenticated caller, no org context,
 * caller not a member of their own active org) still throw as before.
 */
export const getRun = query({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    // Resolve and authorize the CALLER first. runId-independent throws only.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    // Cross-org run and nonexistent run collapse to one outcome on one path.
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) {
      throw new Error("Run not found");
    }
    return run;
  },
});

/**
 * Create a new run record.  Validates org membership before inserting.
 */
/**
 * ADR-002: validate that parentRunId (if given) references an existing run in
 * the SAME org and project as the child. Cycles are structurally impossible
 * here: the parent must already exist at the moment the child is created, and
 * parentRunId is never mutated after creation, so no traversal check is needed.
 */
async function validateParentRun(
  ctx: MutationCtx,
  parentRunId: Id<"runs"> | undefined,
  orgId: Id<"organizations">,
  projectId: Id<"projects">,
): Promise<void> {
  if (parentRunId === undefined) return;
  const parent = await ctx.db.get(parentRunId);
  if (!parent || parent.orgId !== orgId || parent.projectId !== projectId) {
    throw afrError(
      "INVALID_ARGUMENT",
      "parentRunId must reference an existing run in the same organization and project",
    );
  }
}

export const createRun = mutation({
  args: {
    orgId: v.id("organizations"),
    projectId: v.id("projects"),
    agentId: v.id("agents"),
    agentVersionId: v.optional(v.id("agent_versions")),
    metadata: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
    triggeredBy: v.optional(v.string()),
    sdkVersion: v.optional(v.string()),
    // ADR-002 additions — all optional/additive.
    parentRunId: v.optional(v.id("runs")),
    sessionId: v.optional(v.string()),
    environment: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "member" });

    // TENANCY: the run's foreign references must belong to the caller's org.
    // Without this, a member of org A could stamp a run with org B's
    // project/agent id (a cross-org reference that later leaks via agent listings).
    const project = await ctx.db.get(args.projectId);
    if (!project || project.orgId !== args.orgId) {
      throw new Error("Project not found in this organization");
    }
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.orgId !== args.orgId) {
      throw new Error("Agent not found in this organization");
    }
    if (agent.projectId !== args.projectId) {
      throw new Error("Agent does not belong to the given project");
    }
    if (args.agentVersionId !== undefined) {
      const version = await ctx.db.get(args.agentVersionId);
      if (!version || version.orgId !== args.orgId || version.agentId !== args.agentId) {
        throw new Error("Agent version not found for this agent/organization");
      }
    }

    await validateParentRun(ctx, args.parentRunId, args.orgId, args.projectId);
    validateSessionId(args.sessionId);
    validateEnvironment(args.environment);
    validateLabels(args.labels);

    const now = Date.now();
    const searchText = buildSearchText([agent.name, ...(args.tags ?? []), args.triggeredBy]);
    const runId = await ctx.db.insert("runs", {
      orgId: args.orgId,
      projectId: args.projectId,
      agentId: args.agentId,
      agentVersionId: args.agentVersionId,
      status: "pending",
      startedAt: now,
      endedAt: undefined,
      metadata: args.metadata ?? {},
      tags: args.tags ?? [],
      triggeredBy: args.triggeredBy,
      sdkVersion: args.sdkVersion,
      parentRunId: args.parentRunId,
      sessionId: args.sessionId,
      environment: args.environment,
      labels: args.labels,
      searchText,
    });

    await incrementUsageCounters(ctx, args.orgId, { runsStarted: 1 });

    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Failed to create run");
    return run;
  },
});

/**
 * Update the status of a run, enforcing valid terminal-state transitions.
 * Transitions: pending -> running -> completed | failed | cancelled | timed_out
 */
export const updateRunStatus = mutation({
  args: {
    runId: v.id("runs"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("timed_out"),
    ),
    endedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Resolve and authorize the CALLER
    // before observing args.runId. Changing a run's lifecycle status requires
    // "admin" (matches updateRunTags); the role gate is applied to the caller's
    // OWN org, so a viewer's "Forbidden" is also runId-independent.
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "admin" });

    // Cross-org run and nonexistent run collapse to one outcome on one path.
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("Run not found");

    const TERMINAL_STATUSES = new Set([
      "completed",
      "failed",
      "cancelled",
      "timed_out",
    ]);

    // Prevent mutation of already-terminal runs
    if (TERMINAL_STATUSES.has(run.status)) {
      throw new Error(
        `Cannot transition run from terminal status "${run.status}"`,
      );
    }

    // Validate forward-only transitions
    const VALID_TRANSITIONS: Record<string, string[]> = {
      pending: ["running", "cancelled"],
      running: ["completed", "failed", "cancelled", "timed_out"],
    };

    const allowed = VALID_TRANSITIONS[run.status] ?? [];
    if (!allowed.includes(args.status)) {
      throw new Error(
        `Invalid status transition from "${run.status}" to "${args.status}"`,
      );
    }

    await ctx.db.patch(args.runId, {
      status: args.status,
      endedAt: TERMINAL_STATUSES.has(args.status)
        ? (args.endedAt ?? Date.now())
        : args.endedAt,
    });

    await recordAuditEvent(ctx, {
      orgId: run.orgId,
      actorClerkUserId: userId,
      action: "run.status_updated",
      targetType: "run",
      targetId: String(args.runId),
      metadata: { from: run.status, to: args.status },
    });

    // ADR-004: schedule explanation generation, NON-BLOCKING, for any
    // admin-driven transition into a failure state.
    if (EXPLAINABLE_STATUSES.has(args.status)) {
      await ctx.scheduler.runAfter(0, _generateRunExplanationRef, { runId: args.runId });
    }

    return await ctx.db.get(args.runId);
  },
});

/**
 * Update the tags on a run. Caller must be a member of the run's org.
 * Tags are replaced wholesale — pass the full desired tag array.
 */
export const updateRunTags = mutation({
  args: {
    runId: v.id("runs"),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the run is observed only afterwards.
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "admin" });

    // Cross-org run and nonexistent run collapse to one outcome on one path.
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("Run not found");

    // Normalize: trim whitespace, deduplicate, discard empty strings
    const normalized = [...new Set(args.tags.map((t) => t.trim()).filter(Boolean))];

    await ctx.db.patch(args.runId, { tags: normalized });

    await recordAuditEvent(ctx, {
      orgId: run.orgId,
      actorClerkUserId: userId,
      action: "run.tags_updated",
      targetType: "run",
      targetId: String(args.runId),
      metadata: { tags: normalized },
    });

    const updated = await ctx.db.get(args.runId);
    if (!updated) throw new Error("Run not found after update");
    return updated;
  },
});

// ---------------------------------------------------------------------------
// ADR-002 — run hierarchy / sessions / environment / triage / search.
// ---------------------------------------------------------------------------

/**
 * Set the labels on a run (distinct from `tags` — see ADR-002). Labels are
 * replaced wholesale — pass the full desired array.
 */
export const setRunLabels = mutation({
  args: {
    runId: v.id("runs"),
    labels: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the run is observed only afterwards.
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "member" });

    // Cross-org run and nonexistent run collapse to one outcome on one path.
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("Run not found");

    validateLabels(args.labels);
    await ctx.db.patch(args.runId, { labels: args.labels });

    await recordAuditEvent(ctx, {
      orgId: run.orgId,
      actorClerkUserId: userId,
      action: "run.labels_updated",
      targetType: "run",
      targetId: String(args.runId),
      metadata: { labels: args.labels },
    });

    const updated = await ctx.db.get(args.runId);
    if (!updated) throw new Error("Run not found after update");
    return updated;
  },
});

// Linear triage workflow: open -> investigating -> resolved. `open` is also
// reachable from ANY state (reopen), per ADR-002.
const TRIAGE_FORWARD_TRANSITIONS: Record<string, string> = {
  open: "investigating",
  investigating: "resolved",
};

/**
 * Set a run's triage state. Only settable on failed/timed_out runs. Enforces
 * the linear state machine open -> investigating -> resolved (+ any -> open).
 */
export const setRunTriage = mutation({
  args: {
    runId: v.id("runs"),
    triageState: v.union(
      v.literal("open"),
      v.literal("investigating"),
      v.literal("resolved"),
    ),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the run is observed only afterwards. Note that the status/transition
    // errors below are reachable ONLY after the run has been confirmed visible
    // to the caller, so they cannot leak another org's run status either.
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "member" });

    // Cross-org run and nonexistent run collapse to one outcome on one path.
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw new Error("Run not found");

    if (run.status !== "failed" && run.status !== "timed_out") {
      throw afrError(
        "INVALID_ARGUMENT",
        `Triage state can only be set on failed or timed_out runs (current status "${run.status}")`,
      );
    }

    const current = run.triageState ?? "open";
    if (current !== args.triageState) {
      const allowedNext = args.triageState === "open" ? true : TRIAGE_FORWARD_TRANSITIONS[current] === args.triageState;
      if (!allowedNext) {
        throw afrError(
          "INVALID_ARGUMENT",
          `Invalid triage transition from "${current}" to "${args.triageState}"`,
        );
      }
    }

    await ctx.db.patch(args.runId, { triageState: args.triageState });

    await recordAuditEvent(ctx, {
      orgId: run.orgId,
      actorClerkUserId: userId,
      action: "run.triage_updated",
      targetType: "run",
      targetId: String(args.runId),
      metadata: { from: current, to: args.triageState },
    });

    return await ctx.db.get(args.runId);
  },
});

/**
 * Full-text search over runs' searchText, scoped to the caller's org via the
 * search index's filterFields. Bounded like every other list query.
 */
export const searchRuns = query({
  args: {
    orgId: v.id("organizations"),
    searchTerm: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    if (args.searchTerm.trim().length === 0) {
      return { runs: [] };
    }

    const results = await ctx.db
      .query("runs")
      .withSearchIndex("search_runs", (q) =>
        q.search("searchText", args.searchTerm).eq("orgId", args.orgId),
      )
      .take(limit);

    return { runs: results };
  },
});

/** All runs sharing a sessionId, scoped to the caller's org, newest first. */
export const listSessionRuns = query({
  args: {
    orgId: v.id("organizations"),
    sessionId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const runs = await ctx.db
      .query("runs")
      .withIndex("by_org_session", (q) =>
        q.eq("orgId", args.orgId).eq("sessionId", args.sessionId),
      )
      .order("desc")
      .take(limit);

    return { runs };
  },
});

/**
 * Direct children of a run (one level of the parent hierarchy), org-checked.
 *
 * TWO DEFECTS FIXED HERE, and the second is the one that would fool a reader who
 * knew about the first.
 *
 * 1. IT TRUNCATED SILENTLY. The page was capped with no cursor and no marker, so
 *    a run with 500 children returned 200 and said nothing. A caller counting
 *    the result to decide a blast radius read 200 as the total.
 *
 * 2. IT FILTERED **AFTER** TAKING, which made "a short page is therefore
 *    complete" unsound as well. `by_parent` carries no `orgId`, so a foreign
 *    child (a data defect, but the whole point of defence in depth is not to
 *    assume there are none) was read into the page and then dropped — and the
 *    page came back short WITHOUT the ceiling having been reached. Every natural
 *    completeness test (`runs.length < limit`) then reports complete on a page
 *    that silently lost rows. The fix is structural: read through the
 *    ORG-PREFIXED `by_org_parent` index, so a foreign child is not in the range
 *    at all and there is nothing to filter out afterwards.
 *
 * `complete` is therefore an honest positive claim: the index range was
 * exhausted inside the ceiling, and no row was dropped after the fact.
 */
export const listChildRuns = query({
  args: {
    parentRunId: v.id("runs"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the parent run is observed only afterwards.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    // Cross-org parent and nonexistent parent collapse to one outcome.
    const parent = await ctx.db.get(args.parentRunId);
    if (!parent || parent.orgId !== orgId) throw new Error("Run not found");

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    // ORG-PREFIXED: a foreign child is not in the range, so nothing is dropped
    // after the take and a short page really does mean the range ended.
    // Overfetch by ONE — the only way to distinguish "exactly `limit` children"
    // from "at least `limit`, and there are more".
    const page = await ctx.db
      .query("runs")
      .withIndex("by_org_parent", (q) =>
        q.eq("orgId", orgId).eq("parentRunId", args.parentRunId),
      )
      .take(limit + 1);

    const truncated = page.length > limit;
    const runs = truncated ? page.slice(0, limit) : page;

    return {
      runs,
      /** POSITIVE claim: the range was exhausted, and no row was dropped after the take. */
      complete: !truncated,
      /** True when more children exist than this page carries. `runs.length` is then a FLOOR. */
      truncated,
      limit,
      /**
       * Cursor for the next page: the last child's id. Callers that need the
       * whole set should prefer `causality:traceRunImpact`, which walks the
       * hierarchy transitively and reports its own bounds as termini.
       */
      ...(truncated ? { nextCursor: runs[runs.length - 1]?._id } : {}),
    };
  },
});
