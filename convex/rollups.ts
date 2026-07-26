// ADR-002 — daily_rollups. Written ONLY by this internal daily cron, never by
// a public mutation. A derived projection over yesterday's terminal runs per
// agent, computed from a bounded sample (see ROLLUP_MAX_RUNS_SAMPLE) using the
// existing by_agent_started index — no new index needed for the read side.
//
// Percentile/count math is delegated to Team B's (Insight Engine) pure
// `computeRunStats` in helpers/analytics.ts rather than re-implemented here —
// see docs/design/insight_engine.md, which anticipated this exact cron and
// documents computeRunStats's bounded-sample contract (<= ~5000 runs/call,
// matching ROLLUP_MAX_RUNS_SAMPLE below).

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { computeRunStats } from "./helpers/analytics.js";
import {
  ROLLUP_MAX_AGENTS_PER_ORG,
  ROLLUP_MAX_ORGS_PER_SWEEP,
  ROLLUP_MAX_RUNS_SAMPLE,
} from "./helpers/pagination.js";

import type { Id } from "./_generated/dataModel.js";
import type { RunSummary } from "./helpers/analytics.js";

const _listAgentsForRollup = makeFunctionReference<"query">("rollups:listAgentsForRollup");
const _computeAgentDayStats = makeFunctionReference<"query">("rollups:computeAgentDayStats");
const _upsertDailyRollup = makeFunctionReference<"mutation">("rollups:upsertDailyRollup");

/** "YYYY-MM-DD" for UTC yesterday relative to `now`. */
export function yesterdayUtc(now: number = Date.now()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** [start, end) epoch-ms bounds for a "YYYY-MM-DD" UTC calendar day. */
export function dayBoundsUtc(date: string): { start: number; end: number } {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  const end = start + 24 * 60 * 60 * 1000;
  return { start, end };
}

/**
 * All agents belonging to orgs, bounded per ADR-002's rollup cron limits.
 * Walks organizations -> agents via the existing by_org index (no full
 * unindexed table scan of `agents`).
 */
export const listAgentsForRollup = internalQuery({
  args: {},
  handler: async (ctx) => {
    const orgs = await ctx.db.query("organizations").take(ROLLUP_MAX_ORGS_PER_SWEEP);
    const agents: Array<{ _id: Id<"agents">; orgId: Id<"organizations"> }> = [];
    for (const org of orgs) {
      const orgAgents = await ctx.db
        .query("agents")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .take(ROLLUP_MAX_AGENTS_PER_ORG);
      for (const a of orgAgents) {
        agents.push({ _id: a._id, orgId: a.orgId });
      }
    }
    return { agents };
  },
});

/**
 * Terminal-run stats for one agent over [start, end), from a bounded sample
 * (ROLLUP_MAX_RUNS_SAMPLE). Duration percentiles are therefore approximate
 * for any agent/day exceeding the sample size — documented in ADR-002.
 */
export const computeAgentDayStats = internalQuery({
  args: { agentId: v.id("agents"), start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_agent_started", (q) =>
        q.eq("agentId", args.agentId).gte("startedAt", args.start).lt("startedAt", args.end),
      )
      .take(ROLLUP_MAX_RUNS_SAMPLE);

    const summaries: RunSummary[] = runs.map((run) => ({
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
    }));

    const stats = computeRunStats(summaries);

    return {
      runsTotal: stats.totalRuns,
      runsFailed: stats.countsByStatus.failed,
      runsCompleted: stats.countsByStatus.completed,
      runsCancelled: stats.countsByStatus.cancelled,
      runsTimedOut: stats.countsByStatus.timed_out,
      durationMsP50: stats.durationMs.p50 ?? undefined,
      durationMsP95: stats.durationMs.p95 ?? undefined,
      tokensIn: stats.tokensInSum,
      tokensOut: stats.tokensOutSum,
    };
  },
});

export const upsertDailyRollup = internalMutation({
  args: {
    orgId: v.id("organizations"),
    agentId: v.id("agents"),
    date: v.string(),
    runsTotal: v.number(),
    runsFailed: v.number(),
    runsCompleted: v.number(),
    runsCancelled: v.number(),
    runsTimedOut: v.number(),
    durationMsP50: v.optional(v.number()),
    durationMsP95: v.optional(v.number()),
    tokensIn: v.number(),
    tokensOut: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("daily_rollups")
      .withIndex("by_agent_date", (q) => q.eq("agentId", args.agentId).eq("date", args.date))
      .unique();

    const fields = {
      runsTotal: args.runsTotal,
      runsFailed: args.runsFailed,
      runsCompleted: args.runsCompleted,
      runsCancelled: args.runsCancelled,
      runsTimedOut: args.runsTimedOut,
      durationMsP50: args.durationMsP50,
      durationMsP95: args.durationMsP95,
      tokensIn: args.tokensIn,
      tokensOut: args.tokensOut,
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("daily_rollups", {
      orgId: args.orgId,
      agentId: args.agentId,
      date: args.date,
      ...fields,
    });
  },
});

/**
 * Daily rollup cron. Computes yesterday's per-agent terminal-run stats and
 * upserts one daily_rollups row per (agentId, date) with runsTotal > 0.
 */
export const computeDailyRollups = internalAction({
  args: { date: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const date = args.date ?? yesterdayUtc();
    const { start, end } = dayBoundsUtc(date);

    const { agents }: { agents: Array<{ _id: Id<"agents">; orgId: Id<"organizations"> }> } =
      await ctx.runQuery(_listAgentsForRollup, {});

    let written = 0;
    for (const agent of agents) {
      const stats = await ctx.runQuery(_computeAgentDayStats, {
        agentId: agent._id,
        start,
        end,
      });
      if (stats.runsTotal === 0) continue;
      await ctx.runMutation(_upsertDailyRollup, {
        orgId: agent.orgId,
        agentId: agent._id,
        date,
        ...stats,
      });
      written++;
    }

    console.log(
      `Daily rollups: date=${date} agentsConsidered=${agents.length} written=${written}`,
    );
    return { date, agentsConsidered: agents.length, written };
  },
});
