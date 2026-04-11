// convex/projection_verify.ts
// Scheduled integrity verification for replay projections.
// Checks sequence contiguity and duplicate detection for recent terminal runs.
// Does NOT call buildReplayProjection (not importable from Convex actions).
// See ADR-0020 for scope and cadence.

import { action, internalMutation, internalQuery, query } from "convex/server";
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

    const verifyUrl = process.env.INTERNAL_VERIFY_URL as string | undefined;
    const verifySecret = process.env.INTERNAL_VERIFY_SECRET as string | undefined;
    const canRunDerivation = !!(verifyUrl && verifySecret);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const runs: Array<Record<string, unknown>> = await ctx.runInternalQuery(
      _getRecentTerminalRuns,
      { windowStart: now - WINDOW_MS, limit: BATCH_LIMIT }
    );

    let checked = 0;
    let passed = 0;
    let failed = 0;

    for (const run of runs) {
      const runId = run._id as string;
      const orgId = run.orgId as string;

      // Collect all sequence numbers by paginating through events
      const seqNums: number[] = [];
      let cursor: string | null = null;

      for (;;) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const page: { seqNums: number[]; nextCursor: string | null } =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await ctx.runInternalQuery(_listEventSeqNums, { runId: runId as any, cursor });
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
              await ctx.runInternalQuery(_listEventsFull, { runId: runId as any, cursor: evtCursor });
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

          await ctx.runInternalMutation(_upsertVerificationResult, {
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

      await ctx.runInternalMutation(_upsertVerificationResult, {
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
// Public query — read verification result for a specific run
// ---------------------------------------------------------------------------

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
