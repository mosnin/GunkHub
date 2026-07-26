// Stale run expiry — scheduled job that transitions runs stuck in "running"
// to "timed_out" after STALE_RUN_TIMEOUT_MS (24 hours).
//
// Runs that crash before calling run.complete() or run.fail() never transition
// to a terminal status. This daily job detects them and closes them out.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { STALE_RUN_TIMEOUT_MS, STALE_RUN_BATCH_SIZE } from "./helpers/pagination.js";

import type { Id } from "./_generated/dataModel.js";


const _listStaleRuns = makeFunctionReference<"query">("stale_runs:listStaleRuns");
const _markRunTimedOut = makeFunctionReference<"mutation">("stale_runs:markRunTimedOut");

// ADR-004 — "Why did this fail?" run explanations. A stale run marked
// timed_out never appends a run.failed event, so this cron must
// independently schedule explanation generation — see convex/run_explanations.ts.
const _generateRunExplanationRef = makeFunctionReference<"action">(
  "run_explanations:generateRunExplanation",
);

export const listStaleRuns = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_RUN_TIMEOUT_MS;
    // Index-driven: walk only "running" runs with startedAt < cutoff. The
    // by_status_started index is ordered [status, startedAt], so the range scan
    // touches at most STALE_RUN_BATCH_SIZE rows instead of the entire runs table.
    const staleRuns = await ctx.db
      .query("runs")
      .withIndex("by_status_started", (q) =>
        q.eq("status", "running").lt("startedAt", cutoff),
      )
      .take(STALE_RUN_BATCH_SIZE);
    return { runs: staleRuns };
  },
});

export const markRunTimedOut = internalMutation({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    if (run.status !== "running") return; // already transitioned
    await ctx.db.patch(args.runId, {
      status: "timed_out",
      endedAt: Date.now(),
    });

    // ADR-004: schedule explanation generation, NON-BLOCKING.
    await ctx.scheduler.runAfter(0, _generateRunExplanationRef, { runId: args.runId });
  },
});

export const expireStaleRuns = internalAction({
  args: {},
  handler: async (ctx) => {
    const { runs } = await ctx.runQuery(_listStaleRuns, {});

    let expired = 0;
    let errors = 0;

    for (const run of runs) {
      try {
        await ctx.runMutation(_markRunTimedOut, { runId: run._id as Id<"runs"> });
        expired++;
      } catch (err) {
        console.error(
          `Stale run expiry: failed to expire run ${String(run._id)}: ${String(err)}`,
        );
        errors++;
      }
    }

    console.log(
      `Stale run expiry: batch=${runs.length} expired=${expired} errors=${errors}`,
    );
    return { batch: runs.length, expired, errors };
  },
});
