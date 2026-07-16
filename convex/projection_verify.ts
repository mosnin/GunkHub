// convex/projection_verify.ts
// Scheduled integrity verification for replay projections.
// Checks sequence contiguity and duplicate detection for recent terminal runs.
// Does NOT call buildReplayProjection (not importable from Convex actions).
// See ADR-0020 for scope and cadence.

import { action, internalMutation, internalQuery, query } from "./_generated/server.js";
import { makeFunctionReference } from "convex/server";

// Internal function references (typed by name, matches the stale_runs.ts pattern).
const _getRecentTerminalRunsRef = makeFunctionReference<"query">("projection_verify:_getRecentTerminalRuns");
const _listEventSeqNumsRef = makeFunctionReference<"query">("projection_verify:_listEventSeqNums");
const _listEventsFullRef = makeFunctionReference<"query">("projection_verify:_listEventsFull");
const _upsertVerificationResultRef = makeFunctionReference<"mutation">("projection_verify:_upsertVerificationResult");
const _getRunForVerifyRef = makeFunctionReference<"query">("projection_verify:_getRunForVerify");
const _requireMembershipForReverifyRef = makeFunctionReference<"query">("projection_verify:_requireMembershipForReverify");
import { v } from "convex/values";
import { requireOrgMembership } from "./auth.js";

// ---------------------------------------------------------------------------
// Pure sequence integrity check (inline — mirrors verify.ts logic)
// ---------------------------------------------------------------------------

interface SeqCheckResult {
  isValid: boolean;
  sequenceGaps: number[];
  duplicateSeqNums: number[];
  summary: string;
  failureReason: string | undefined;
}

function checkSequenceIntegrity(seqNums: number[]): SeqCheckResult {
  const gaps: number[] = [];
  const duplicates: number[] = [];

  const counts = new Map<number, number>();
  for (const n of seqNums) {
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  for (const [n, c] of counts) {
    if (c > 1) duplicates.push(n);
  }
  duplicates.sort((a, b) => a - b);

  if (seqNums.length > 0) {
    let max = 0;
    for (const n of seqNums) { if (n > max) max = n; }
    for (let i = 1; i <= max; i++) {
      if (!counts.has(i)) gaps.push(i);
    }
  }

  const isValid = gaps.length === 0 && duplicates.length === 0;

  let summary: string;
  let failureReason: string | undefined;
  if (isValid) {
    summary = `OK: ${seqNums.length} events, no gaps, sequence valid`;
  } else {
    const parts: string[] = [];
    if (gaps.length > 0) {
      const shown = gaps.slice(0, 5).join(", ");
      parts.push(`${gaps.length} sequence gap${gaps.length === 1 ? "" : "s"} [${shown}${gaps.length > 5 ? ", …" : ""}]`);
    }
    if (duplicates.length > 0) {
      const shown = duplicates.slice(0, 5).join(", ");
      parts.push(`${duplicates.length} duplicate${duplicates.length === 1 ? "" : "s"} [${shown}${duplicates.length > 5 ? ", …" : ""}]`);
    }
    summary = `INVALID: ${parts.join("; ")}`;
    failureReason = parts[0];
  }

  return { isValid, sequenceGaps: gaps, duplicateSeqNums: duplicates, summary, failureReason };
}

// ---------------------------------------------------------------------------
// Internal helpers (called by the scheduled action via runInternalQuery/Mutation)
// ---------------------------------------------------------------------------

/** Fetch recently terminal runs within a time window. No auth — internal only. */
export const _getRecentTerminalRuns = internalQuery({
  args: {
    windowStart: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

    // Scan runs ordered by endedAt descending, bounded by windowStart.
    // We use the _creationTime fallback since there is no global endedAt index.
    // The by_org_started index is per-org; for a cross-org daily job we do a
    // bounded table scan with filter — acceptable at v1 scale.
    const candidates = await ctx.db
      .query("runs")
      .order("desc")
      .filter((q) =>
        q.and(
          q.neq(q.field("endedAt"), undefined),
          q.gte(q.field("endedAt"), args.windowStart),
        )
      )
      .take(args.limit * 4); // over-fetch to allow status filtering

    return candidates
      .filter((r) => TERMINAL.has(r.status))
      .slice(0, args.limit);
  },
});

/** Fetch sequence numbers for all events in a run, one page at a time. */
export const _listEventSeqNums = internalQuery({
  args: {
    runId: v.id("runs"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .paginate({ numItems: 1000, cursor: args.cursor });

    return {
      seqNums: page.page.map((e) => e.sequenceNumber),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/** Fetch full event documents for a run (for derivation verification). Internal only. */
export const _listEventsFull = internalQuery({
  args: {
    runId: v.id("runs"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .paginate({ numItems: 500, cursor: args.cursor });

    return {
      events: page.page,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/** Upsert a verification result (delete + insert). Internal only. */
export const _upsertVerificationResult = internalMutation({
  args: {
    runId: v.id("runs"),
    orgId: v.id("organizations"),
    verifiedAt: v.number(),
    isValid: v.boolean(),
    summary: v.string(),
    sequenceGaps: v.array(v.number()),
    duplicateSeqNums: v.array(v.number()),
    failureReason: v.optional(v.string()),
    // Extended derivation check fields (absent for sequence-only verification)
    checksRan: v.optional(v.array(v.string())),
    replayPassed: v.optional(v.boolean()),
    failureSummaryPassed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Remove any existing result for this run
    const existing = await ctx.db
      .query("verification_results")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("verification_results", {
      runId: args.runId,
      orgId: args.orgId,
      verifiedAt: args.verifiedAt,
      isValid: args.isValid,
      summary: args.summary,
      sequenceGaps: args.sequenceGaps,
      duplicateSeqNums: args.duplicateSeqNums,
      failureReason: args.failureReason,
      checksRan: args.checksRan,
      replayPassed: args.replayPassed,
      failureSummaryPassed: args.failureSummaryPassed,
    });
  },
});

// ---------------------------------------------------------------------------
// Scheduled action — called daily by crons.ts
// ---------------------------------------------------------------------------

/**
 * Verify projection integrity for up to 50 recently completed runs.
 * Called daily by the cron scheduler. Safe to re-run — results are upserted.
 *
 * Scope: runs with terminal status that ended within the last 48 hours,
 * bounded to 50 runs per invocation (newest preferred via the desc order).
 *
 * What IS verified (always):
 *   - Sequence numbers are contiguous starting from 1 (no gaps)
 *   - No duplicate sequence numbers exist
 *
 * What IS verified (when INTERNAL_VERIFY_URL + INTERNAL_VERIFY_SECRET are set
 * and the run has ≤ DERIVATION_MAX_EVENTS events):
 *   - buildReplayProjection produces a valid result with matching frame count
 *   - buildFailureSummary produces a valid result without throwing
 *
 * Graceful degradation: if the web route is unreachable or unconfigured, the
 * result is stored as a sequence-only record (checksRan absent).
 */
export const verifyRecentRuns = action({
  args: {},
  handler: async (ctx): Promise<{ checked: number; passed: number; failed: number }> => {
    const WINDOW_MS = 48 * 60 * 60 * 1000;
    const BATCH_LIMIT = 50;
    const DERIVATION_MAX_EVENTS = 500;
    const now = Date.now();

    const verifyUrl = process.env['INTERNAL_VERIFY_URL'] as string | undefined;
    const verifySecret = process.env['INTERNAL_VERIFY_SECRET'] as string | undefined;
    const canRunDerivation = !!(verifyUrl && verifySecret);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const runs: Array<Record<string, unknown>> = await ctx.runQuery(_getRecentTerminalRunsRef,
      { windowStart: now - WINDOW_MS, limit: BATCH_LIMIT }
    );

    let checked = 0;
    let passed = 0;
    let failed = 0;

    for (const run of runs) {
      const runId = run['_id'] as string;
      const orgId = run['orgId'] as string;

      // Collect all sequence numbers by paginating through events
      const seqNums: number[] = [];
      let cursor: string | null = null;

      for (;;) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const page: { seqNums: number[]; nextCursor: string | null } =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await ctx.runQuery(_listEventSeqNumsRef, { runId: runId as any, cursor });
        seqNums.push(...page.seqNums);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      const seqResult = checkSequenceIntegrity(seqNums);
      checked++;

      // Attempt full derivation check via web route when configured and run is within size cap
      if (canRunDerivation && seqNums.length <= DERIVATION_MAX_EVENTS) {
        try {
          // Fetch full event documents for the web route
          const allEvents: Array<Record<string, unknown>> = [];
          let evtCursor: string | null = null;
          for (;;) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const page: { events: Array<Record<string, unknown>>; nextCursor: string | null } =
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await ctx.runQuery(_listEventsFullRef, { runId: runId as any, cursor: evtCursor });
            allEvents.push(...page.events);
            if (page.nextCursor === null) break;
            evtCursor = page.nextCursor;
          }

          const res = await fetch(`${verifyUrl}/api/internal/verify-derivation`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": verifySecret!,
            },
            body: JSON.stringify({ run, events: allEvents }),
          });

          if (!res.ok) throw new Error(`Verify route returned ${res.status}`);

          const ext = await res.json() as {
            isValid: boolean;
            summary: string;
            sequenceGaps: number[];
            duplicateSeqNums: number[];
            failureReason?: string;
            checksRan: string[];
            replayPassed: boolean;
            failureSummaryPassed: boolean;
          };

          if (ext.isValid) passed++;
          else failed++;

          await ctx.runMutation(_upsertVerificationResultRef, {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            runId: runId as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            orgId: orgId as any,
            verifiedAt: now,
            isValid: ext.isValid,
            summary: ext.summary,
            sequenceGaps: ext.sequenceGaps,
            duplicateSeqNums: ext.duplicateSeqNums,
            ...(ext.failureReason !== undefined && { failureReason: ext.failureReason }),
            checksRan: ext.checksRan,
            replayPassed: ext.replayPassed,
            failureSummaryPassed: ext.failureSummaryPassed,
          });
          continue; // skip sequence-only fallback below
        } catch {
          // Web route unavailable or parse failure — fall through to sequence-only result
        }
      }

      // Sequence-only path (no derivation check, or graceful degradation from above)
      if (seqResult.isValid) passed++;
      else failed++;

      await ctx.runMutation(_upsertVerificationResultRef, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runId: runId as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        orgId: orgId as any,
        verifiedAt: now,
        isValid: seqResult.isValid,
        summary: seqResult.summary,
        sequenceGaps: seqResult.sequenceGaps,
        duplicateSeqNums: seqResult.duplicateSeqNums,
        ...(seqResult.failureReason !== undefined && { failureReason: seqResult.failureReason }),
      });
    }

    return { checked, passed, failed };
  },
});

// ---------------------------------------------------------------------------
// Internal helpers for the per-run reverify action
// ---------------------------------------------------------------------------

/** Fetch a single run by ID. Returns null if not found. Internal only. */
export const _getRunForVerify = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => ctx.db.get(args.runId),
});

/**
 * Check that a Clerk user is a member (or admin) of the given organization.
 * Throws "Unauthorized" or "Forbidden" on failure. Internal only.
 */
export const _requireMembershipForReverify = internalQuery({
  args: {
    clerkUserId: v.string(),
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2 };

    const membership = await ctx.db
      .query("user_memberships")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .unique();

    if (!membership) throw new Error("Unauthorized: not a member of this organization");

    const actualRank = ROLE_RANK[membership.role] ?? 0;
    if (actualRank < (ROLE_RANK['member'] ?? 0)) {
      throw new Error("Forbidden: member or admin role required to re-run verification");
    }
  },
});

// ---------------------------------------------------------------------------
// Per-run reverify action — called on demand by the web UI
// ---------------------------------------------------------------------------

/**
 * Re-run derivation verification for a single run on demand.
 *
 * Auth: caller must be authenticated (Clerk JWT) and a member+ of the org
 * that owns the run. Viewer-only callers receive a "Forbidden" error.
 *
 * Verification scope mirrors verifyRecentRuns:
 *   - Sequence integrity (always)
 *   - Full derivation via web route when INTERNAL_VERIFY_URL/SECRET are set
 *     and the run has ≤ DERIVATION_MAX_EVENTS events (graceful degradation otherwise)
 *
 * Returns the verification result in the same shape as _upsertVerificationResult
 * so the caller can update UI state without a page reload.
 */
export const reverifyRun = action({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const DERIVATION_MAX_EVENTS = 500;
    const now = Date.now();

    // Auth: require authenticated Clerk identity
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    const clerkUserId = identity.subject;

    // Fetch the run — action cannot use ctx.db directly
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const run: Record<string, unknown> | null = await ctx.runQuery(_getRunForVerifyRef,
      { runId: args.runId },
    );
    if (!run) throw new Error("Run not found");

    const orgId = run['orgId'] as string;

    // Role check: member+ required
    await ctx.runQuery(_requireMembershipForReverifyRef, {
      clerkUserId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      orgId: orgId as any,
    });

    // Collect all sequence numbers
    const seqNums: number[] = [];
    let cursor: string | null = null;
    for (;;) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const page: { seqNums: number[]; nextCursor: string | null } =
        await ctx.runQuery(_listEventSeqNumsRef, { runId: args.runId, cursor });
      seqNums.push(...page.seqNums);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const seqResult = checkSequenceIntegrity(seqNums);

    const verifyUrl = process.env['INTERNAL_VERIFY_URL'] as string | undefined;
    const verifySecret = process.env['INTERNAL_VERIFY_SECRET'] as string | undefined;
    const canRunDerivation = !!(verifyUrl && verifySecret);

    // Attempt full derivation check via web route when configured and run is within size cap
    if (canRunDerivation && seqNums.length <= DERIVATION_MAX_EVENTS) {
      try {
        const allEvents: Array<Record<string, unknown>> = [];
        let evtCursor: string | null = null;
        for (;;) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const page: { events: Array<Record<string, unknown>>; nextCursor: string | null } =
            await ctx.runQuery(_listEventsFullRef, { runId: args.runId, cursor: evtCursor });
          allEvents.push(...page.events);
          if (page.nextCursor === null) break;
          evtCursor = page.nextCursor;
        }

        const res = await fetch(`${verifyUrl}/api/internal/verify-derivation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": verifySecret!,
          },
          body: JSON.stringify({ run, events: allEvents }),
        });

        if (!res.ok) throw new Error(`Verify route returned ${res.status}`);

        const ext = await res.json() as {
          isValid: boolean;
          summary: string;
          sequenceGaps: number[];
          duplicateSeqNums: number[];
          failureReason?: string;
          checksRan: string[];
          replayPassed: boolean;
          failureSummaryPassed: boolean;
        };

        await ctx.runMutation(_upsertVerificationResultRef, {
          runId: args.runId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          orgId: orgId as any,
          verifiedAt: now,
          isValid: ext.isValid,
          summary: ext.summary,
          sequenceGaps: ext.sequenceGaps,
          duplicateSeqNums: ext.duplicateSeqNums,
          ...(ext.failureReason !== undefined && { failureReason: ext.failureReason }),
          checksRan: ext.checksRan,
          replayPassed: ext.replayPassed,
          failureSummaryPassed: ext.failureSummaryPassed,
        });

        return {
          isValid: ext.isValid,
          verifiedAt: now,
          summary: ext.summary,
          sequenceGaps: ext.sequenceGaps,
          duplicateSeqNums: ext.duplicateSeqNums,
          failureReason: ext.failureReason,
          checksRan: ext.checksRan,
          replayPassed: ext.replayPassed,
          failureSummaryPassed: ext.failureSummaryPassed,
        };
      } catch {
        // Web route unavailable or parse failure — fall through to sequence-only result
      }
    }

    // Sequence-only path (no derivation check, or graceful degradation)
    await ctx.runMutation(_upsertVerificationResultRef, {
      runId: args.runId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      orgId: orgId as any,
      verifiedAt: now,
      isValid: seqResult.isValid,
      summary: seqResult.summary,
      sequenceGaps: seqResult.sequenceGaps,
      duplicateSeqNums: seqResult.duplicateSeqNums,
      ...(seqResult.failureReason !== undefined && { failureReason: seqResult.failureReason }),
    });

    return {
      isValid: seqResult.isValid,
      verifiedAt: now,
      summary: seqResult.summary,
      sequenceGaps: seqResult.sequenceGaps,
      duplicateSeqNums: seqResult.duplicateSeqNums,
      failureReason: seqResult.failureReason,
      checksRan: undefined as string[] | undefined,
      replayPassed: undefined as boolean | undefined,
      failureSummaryPassed: undefined as boolean | undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// Public queries — verification result reads
// ---------------------------------------------------------------------------

/**
 * Batch-fetch the most recent verification result for each of the given run IDs.
 * Results are returned in the same order as the input array.
 * Entries with no verification record are returned as null.
 * Enforces org membership and filters results by orgId for tenancy safety.
 * Bounded to 100 run IDs per call.
 */
export const batchGetVerificationResults = query({
  args: {
    orgId: v.id("organizations"),
    runIds: v.array(v.id("runs")),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    // Bound the batch size to prevent abuse
    const runIds = args.runIds.slice(0, 100);

    const results = await Promise.all(
      runIds.map(async (runId) => {
        const result = await ctx.db
          .query("verification_results")
          .withIndex("by_run", (q) => q.eq("runId", runId))
          .order("desc")
          .first();
        // Tenancy safety: only return results belonging to the requesting org
        const safeResult = result?.orgId === args.orgId ? result : null;
        return { runId, result: safeResult ?? null };
      }),
    );

    return results;
  },
});

/**
 * List the most recent failed verification results for the org.
 * Used by the dashboard to surface verification issues compactly.
 * Returns up to `limit` records (max 20) ordered by verifiedAt descending.
 * Enforces org membership.
 */
export const listRecentFailedVerifications = query({
  args: {
    orgId: v.id("organizations"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const limit = Math.min(args.limit ?? 5, 20);

    // by_org_verified orders by verifiedAt — scan most recent, filter for failures
    const recent = await ctx.db
      .query("verification_results")
      .withIndex("by_org_verified", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(200); // Over-fetch then filter (v1 scale: fine)

    const failed = recent.filter((r) => !r.isValid).slice(0, limit);

    return failed.map((r) => ({
      runId: r.runId,
      verifiedAt: r.verifiedAt,
      isValid: r.isValid,
      checksRan: r.checksRan ?? ([] as string[]),
      failureReason: r.failureReason,
      sequenceGaps: r.sequenceGaps,
      duplicateSeqNums: r.duplicateSeqNums,
    }));
  },
});



/**
 * Get the most recent verification result for a run.
 * Returns null if the run has never been verified.
 * Enforces org membership before returning.
 */
export const getVerificationResult = query({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    await requireOrgMembership(ctx, run.orgId);

    return await ctx.db
      .query("verification_results")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .order("desc")
      .first();
  },
});
