// Insight Engine (Team B) — cycle 3 (cohesion) + Explainability Layer cycle 1.
// Cycle 2 wired the pure engines from cycle 1
// (convex/helpers/{analytics,pricing,evals}.ts) into org-scoped Convex
// queries + the eval-execution internal mutation. Cycle 3 makes the query
// set EXACT and COHESIVE against schema Team A landed this same cycle:
// `runs.by_agent_version_started` (exact per-version compareVersions,
// replacing the bounded overfetch-and-filter scan) and `runs.modelsSeen`
// (event-scan-free cost attribution in getAgentCostStats). It also adds
// getPerAgentDashboardStats (single-pass per-agent dashboard breakdown, for
// Team E) and getRunEvalSummary (run-detail Evals panel header), and teaches
// listEvalsForVersion to distinguish "no rules configured" from "rules
// configured, zero evals in range". See docs/design/insight_engine.md for
// the original design/plan this file implements.
//
// Explainability Layer cycle 1 (NEW): adds `buildHeuristicExplanation` (and
// the `classifyFailure` sub-unit it's built from) — a PURE, deterministic,
// zero-LLM heuristic engine that answers "why did this run fail?" from the
// event trace + derived failure summary + eval results alone. Every claim it
// makes is grounded in a real event/eval; see the GROUNDING GUARANTEE
// doc-comment above that section. Team A's `generateRunExplanation` (its own
// file/query) is expected to call this function directly.
//
// FILE OWNERSHIP: this file (+ insights.test.ts, and the pure helpers in
// convex/helpers/{analytics,pricing}.ts) is the ONLY convex surface Team B
// owns this cycle. Everything else (schema.ts, auth.ts, runs.ts, events.ts,
// evals.ts, agent_versions.ts, rollups.ts, helpers/run_fields.ts, etc.)
// belongs to Team A — read-only from here. Any date-math helpers below
// duplicate (rather than import) the tiny pure equivalents in
// convex/rollups.ts on purpose: importing another team's internal helper
// during their own active cycle risks a break if they refactor it, and the
// duplicated logic is a two-line, stable, side-effect-free calculation.

import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server.js";
import { requireOrgMembership } from "./auth.js";
import {
  compareCohorts,
  computeRunStats,
  type RunSummary,
} from "./helpers/analytics.js";
import { afrError } from "./helpers/errors.js";
import {
  evaluateRules,
  type EvalEventLike,
  type EvalRule,
  type EvalRunLike,
} from "./helpers/evals.js";
import { estimateCostUsd } from "./helpers/pricing.js";
import { extractModel, extractTokenUsage } from "./helpers/run_fields.js";

import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

// ---------------------------------------------------------------------------
// Shared range/date helpers
// ---------------------------------------------------------------------------

type InsightRange = "7d" | "30d";

const RANGE_DAYS: Record<InsightRange, number> = { "7d": 7, "30d": 30 };

function rangeCutoffMs(range: InsightRange, now: number = Date.now()): number {
  return now - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
}

/** "YYYY-MM-DD" for UTC calendar day `n` days before `now`. n=0 is today. */
function dateNDaysAgoUtc(n: number, now: number = Date.now()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** [start, end) epoch-ms bounds for a "YYYY-MM-DD" UTC calendar day. */
function dayBoundsUtc(date: string): { start: number; end: number } {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

// ---------------------------------------------------------------------------
// 1. getDashboardStats
// ---------------------------------------------------------------------------

/**
 * Bounded cap on daily_rollups rows read per call (days * agents-with-rollups
 * that day). 2000 comfortably covers a 30-day window even for orgs with
 * hundreds of agents; a caller with more should filter by agentId.
 */
const DASHBOARD_ROLLUP_ROW_CAP = 2000;

/**
 * Bounded fallback sample used ONLY for a calendar day that has zero
 * daily_rollups coverage (the computeDailyRollups cron hasn't run yet for
 * that day — most commonly "today", or a brand-new org before its first
 * cron tick). Mirrors ROLLUP_MAX_RUNS_SAMPLE (convex/helpers/pagination.ts),
 * the same bound the cron itself uses per agent/day, applied here per
 * org (or org+agent) per day. A day exceeding this bound gets an
 * approximate fallback stat rather than an unbounded scan — documented via
 * the `truncated` flag on that day's series point.
 */
const DASHBOARD_FALLBACK_MAX_RUNS = 5_000;

interface DashboardDailyPoint {
  date: string;
  runsTotal: number;
  runsFailed: number;
  runsCompleted: number;
  runsCancelled: number;
  runsTimedOut: number;
  tokensIn: number;
  tokensOut: number;
  /** (failed + timedOut) / terminal runs that day. Null if no terminal runs. */
  failureRate: number | null;
  /** Whether this day came from the daily_rollups cron or a live fallback query. */
  source: "rollup" | "fallback";
  /** Only meaningful for source==="fallback": true if the live sample hit DASHBOARD_FALLBACK_MAX_RUNS. */
  truncated: boolean;
}

export interface DashboardStats {
  range: InsightRange;
  agentId: Id<"agents"> | null;
  totals: {
    runsTotal: number;
    runsFailed: number;
    runsCompleted: number;
    runsCancelled: number;
    runsTimedOut: number;
    failureRate: number | null;
    tokensIn: number;
    tokensOut: number;
  };
  series: DashboardDailyPoint[];
  /**
   * Top-level, easy-to-check mirror of `series[series.length - 1].source`
   * (today's date is always the last entry in `series`). Exists so a caller
   * doesn't have to know that convention or grovel through the series array
   * just to answer "is today's number finalized or still moving?" — see
   * `partialToday` for the boolean shorthand of the same fact. `"no_data"`
   * covers the (should-never-normally-happen, but possible for a request
   * whose `range` window somehow excludes today) case where the series has
   * no entry for today at all.
   */
  todaySource: "rollup" | "fallback" | "no_data";
  /**
   * True iff today's totals were computed via the bounded live fallback scan
   * (see getDashboardStats's doc comment) rather than the finalized
   * daily_rollups cron output. When true, `totals` and today's series point
   * reflect only the runs that existed AT READ TIME today — more runs may
   * start or finish later today and will not retroactively appear until the
   * next cron tick recomputes and stores today's rollup (early tomorrow,
   * UTC). This is the per-view "honest bound" flag the dashboard UI should
   * use to render something like "today's numbers are live/partial" instead
   * of presenting them with the same confidence as a finalized day.
   */
  partialToday: boolean;
}

interface RollupAgg {
  runsTotal: number;
  runsFailed: number;
  runsCompleted: number;
  runsCancelled: number;
  runsTimedOut: number;
  tokensIn: number;
  tokensOut: number;
}

const EMPTY_AGG: RollupAgg = {
  runsTotal: 0,
  runsFailed: 0,
  runsCompleted: 0,
  runsCancelled: 0,
  runsTimedOut: 0,
  tokensIn: 0,
  tokensOut: 0,
};

function addAgg(a: RollupAgg, b: RollupAgg): RollupAgg {
  return {
    runsTotal: a.runsTotal + b.runsTotal,
    runsFailed: a.runsFailed + b.runsFailed,
    runsCompleted: a.runsCompleted + b.runsCompleted,
    runsCancelled: a.runsCancelled + b.runsCancelled,
    runsTimedOut: a.runsTimedOut + b.runsTimedOut,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
  };
}

function failureRateOf(agg: RollupAgg): number | null {
  const terminal = agg.runsFailed + agg.runsCompleted + agg.runsCancelled + agg.runsTimedOut;
  return terminal > 0 ? (agg.runsFailed + agg.runsTimedOut) / terminal : null;
}

/**
 * Org-scoped (or org+agent, if `agentId` given) dashboard stats over the
 * trailing 7 or 30 UTC calendar days (inclusive of today).
 *
 * Reads daily_rollups for the range first. Any day with ZERO rollup rows
 * (the cron hasn't run for it yet — this is normal for "today", and for a
 * brand-new org before its first cron tick) falls back to a bounded live
 * query over `runs` for that single day, run through the same
 * `computeRunStats` engine the cron itself uses. A day with PARTIAL rollup
 * coverage (some but not all agents rolled up) is treated as fully rolled
 * up — a documented simplification; see docs/design/insight_engine.md.
 *
 * PER-VIEW COST OF THE LIVE FALLBACK (M5, documented precisely rather than
 * hand-waved, since this is the one part of this query that scales with
 * traffic, not with range):
 *
 *   - The `computeDailyRollups` cron (Team A, convex/rollups.ts) runs once
 *     daily at 05:00 UTC and only ever rolls up the PRECEDING UTC calendar
 *     day. That means "today" has zero daily_rollups coverage for the
 *     entire current UTC day, by construction — every single call to this
 *     query, from every viewer, for every org, takes the live-fallback
 *     branch for exactly one date: today. Already-rolled-up days (yesterday
 *     and earlier) are NEVER re-scanned live — the loop above only takes
 *     the fallback branch when `rollupsByDate.get(date)` is empty, and that
 *     is true only for today (or, for a brand-new org, a short backlog
 *     before its first cron tick — see note above).
 *   - That one live query IS already bounded and indexed: it takes at most
 *     `DASHBOARD_FALLBACK_MAX_RUNS` (5,000) rows via `by_org_started`
 *     (org-wide) or `by_agent_started` (agent-scoped), i.e. it can never
 *     scan more than 5,000 run documents no matter how large the org or how
 *     many runs started today, and reads no other table (no per-run event
 *     reads, unlike getAgentCostStats's fallback path).
 *   - The real cost this doc-comment is calling out is not "this one call is
 *     unbounded" (it isn't) but "this bounded, indexed scan reruns on EVERY
 *     dashboard view with zero caching," because a Convex `query` cannot
 *     memoize across calls. At N concurrent viewers of the same org's
 *     dashboard, that is N independent up-to-5,000-row scans of today's
 *     runs, all reading the same underlying rows, once per page view/poll.
 *     For a single large org (hundreds+ agents, thousands of runs/day) with
 *     several people watching the dashboard, that is the multiplier worth
 *     watching, not per-call cost.
 *   - Nothing here can fix that within this file: a query has no cache to
 *     write to, and a per-day incremental rollup for "today" (updated as
 *     runs land, so this call could read a same-day daily_rollups-like row
 *     instead of re-scanning `runs`) needs either a schema addition (a
 *     `today`/intraday rollup table or a mutable row Team A would own) or a
 *     much higher-frequency cron — both out of scope for this cycle (Team A
 *     owns schema/crons). See docs/design/insight_engine.md, "Future work:
 *     same-day incremental rollup," for the concrete recommendation.
 *   - The `todaySource`/`partialToday` fields on the return value make this
 *     bound visible to callers: `partialToday: true` means today's numbers
 *     came from this live, capped scan and are not yet finalized.
 */
export const getDashboardStats = query({
  args: {
    orgId: v.id("organizations"),
    range: v.union(v.literal("7d"), v.literal("30d")),
    agentId: v.optional(v.id("agents")),
  },
  handler: async (ctx, args): Promise<DashboardStats> => {
    await requireOrgMembership(ctx, args.orgId);

    if (args.agentId !== undefined) {
      const agent = await ctx.db.get(args.agentId);
      if (!agent || agent.orgId !== args.orgId) {
        throw afrError("NOT_FOUND", "Agent not found in this organization");
      }
    }

    const days = RANGE_DAYS[args.range];
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) dates.push(dateNDaysAgoUtc(i));
    const startDate = dates[0]!;
    const endDate = dates[dates.length - 1]!;

    // TENANCY: by_agent_date is not itself org-scoped, but args.agentId was
    // validated above to belong to args.orgId, so this is safe.
    const rollupRows =
      args.agentId !== undefined
        ? await ctx.db
            .query("daily_rollups")
            .withIndex("by_agent_date", (q) =>
              q.eq("agentId", args.agentId!).gte("date", startDate).lte("date", endDate),
            )
            .take(DASHBOARD_ROLLUP_ROW_CAP)
        : await ctx.db
            .query("daily_rollups")
            .withIndex("by_org_date", (q) =>
              q.eq("orgId", args.orgId).gte("date", startDate).lte("date", endDate),
            )
            .take(DASHBOARD_ROLLUP_ROW_CAP);

    const rollupsByDate = new Map<string, RollupAgg[]>();
    for (const row of rollupRows) {
      const arr = rollupsByDate.get(row.date) ?? [];
      arr.push(row);
      rollupsByDate.set(row.date, arr);
    }

    const series: DashboardDailyPoint[] = [];
    for (const date of dates) {
      const rows = rollupsByDate.get(date);
      if (rows && rows.length > 0) {
        const agg = rows.reduce(addAgg, EMPTY_AGG);
        series.push({
          date,
          ...agg,
          failureRate: failureRateOf(agg),
          source: "rollup",
          truncated: false,
        });
        continue;
      }

      // Fallback: no rollup coverage for this day at all — compute it live.
      const { start, end } = dayBoundsUtc(date);
      const runs =
        args.agentId !== undefined
          ? await ctx.db
              .query("runs")
              .withIndex("by_agent_started", (q) =>
                q.eq("agentId", args.agentId!).gte("startedAt", start).lt("startedAt", end),
              )
              .take(DASHBOARD_FALLBACK_MAX_RUNS)
          : await ctx.db
              .query("runs")
              .withIndex("by_org_started", (q) =>
                q.eq("orgId", args.orgId).gte("startedAt", start).lt("startedAt", end),
              )
              .take(DASHBOARD_FALLBACK_MAX_RUNS);

      const summaries: RunSummary[] = runs.map((r) => ({
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
      }));
      const stats = computeRunStats(summaries);

      series.push({
        date,
        runsTotal: stats.totalRuns,
        runsFailed: stats.countsByStatus.failed,
        runsCompleted: stats.countsByStatus.completed,
        runsCancelled: stats.countsByStatus.cancelled,
        runsTimedOut: stats.countsByStatus.timed_out,
        tokensIn: stats.tokensInSum,
        tokensOut: stats.tokensOutSum,
        failureRate: stats.failureRate,
        source: "fallback",
        truncated: runs.length >= DASHBOARD_FALLBACK_MAX_RUNS,
      });
    }

    const totals = series.reduce(addAgg, EMPTY_AGG);

    // "Today" is always dates[dates.length - 1] (the loop above pushes dates
    // oldest-first), and therefore always series[series.length - 1] too,
    // since series is built in the same order. Surfaced as a top-level flag
    // so callers don't need to know/rely on that ordering convention
    // themselves — see the DashboardStats field docs and the PER-VIEW COST
    // note on this function above.
    const todayPoint = series[series.length - 1];
    const todaySource: DashboardStats["todaySource"] = todayPoint ? todayPoint.source : "no_data";

    return {
      range: args.range,
      agentId: args.agentId ?? null,
      totals: { ...totals, failureRate: failureRateOf(totals) },
      series,
      todaySource,
      partialToday: todaySource === "fallback",
    };
  },
});

// ---------------------------------------------------------------------------
// 1b. getPerAgentDashboardStats — single-pass per-agent breakdown for orgs
//     with multiple agents (replaces N per-agent getDashboardStats calls).
// ---------------------------------------------------------------------------

/**
 * Bounded daily_rollups rows read per call, org-wide (all agents, one date
 * range). Larger than DASHBOARD_ROLLUP_ROW_CAP (which is per-agent-or-org for
 * a single series) because this query fans out over every agent in the org
 * in one pass; still bounded rather than an unbounded `.collect()`.
 */
const PER_AGENT_DASHBOARD_ROLLUP_ROW_CAP = 10_000;

/** Bound on distinct agents summarized in one getPerAgentDashboardStats call. */
const PER_AGENT_DASHBOARD_MAX_AGENTS = 500;

export interface PerAgentDashboardStat {
  agentId: Id<"agents">;
  agentName: string | undefined;
  runsTotal: number;
  runsFailed: number;
  failureRate: number | null;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Per-agent dashboard breakdown for an org over the trailing 7/30 UTC
 * calendar days, computed in ONE org-scoped pass over `daily_rollups`
 * (grouped by `agentId` in memory) instead of the UI calling
 * `getDashboardStats` once per agent (N queries, N index scans over the same
 * date range). Replaces that N-query pattern for any view that renders a
 * per-agent breakdown (e.g. an org-level agents table).
 *
 * DOCUMENTED SIMPLIFICATION (unlike getDashboardStats): this query does NOT
 * fall back to a live `runs` query for a day with zero rollup coverage (e.g.
 * "today", before the daily cron has run). It only reflects whatever
 * `daily_rollups` has for the range. A per-agent view that needs today's
 * still-uncommitted numbers should still call getDashboardStats for that one
 * agent; this query is for "give me every agent's trend at a glance," where a
 * few hours of lag on the current day is an acceptable, documented tradeoff
 * for avoiding N live-fallback queries.
 */
export const getPerAgentDashboardStats = query({
  args: {
    orgId: v.id("organizations"),
    range: v.union(v.literal("7d"), v.literal("30d")),
  },
  handler: async (ctx, args): Promise<PerAgentDashboardStat[]> => {
    await requireOrgMembership(ctx, args.orgId);

    const days = RANGE_DAYS[args.range];
    const startDate = dateNDaysAgoUtc(days - 1);
    const endDate = dateNDaysAgoUtc(0);

    const rows = await ctx.db
      .query("daily_rollups")
      .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId).gte("date", startDate).lte("date", endDate))
      .take(PER_AGENT_DASHBOARD_ROLLUP_ROW_CAP);

    const byAgent = new Map<Id<"agents">, RollupAgg>();
    for (const row of rows) {
      const agg = byAgent.get(row.agentId) ?? EMPTY_AGG;
      byAgent.set(row.agentId, addAgg(agg, row));
    }

    // Bound the number of agents summarized (a pathological org with more
    // distinct agents in daily_rollups than this cap gets the first
    // PER_AGENT_DASHBOARD_MAX_AGENTS in insertion order, rather than an
    // unbounded name-lookup fan-out below).
    const agentIds = [...byAgent.keys()].slice(0, PER_AGENT_DASHBOARD_MAX_AGENTS);

    // One doc read per distinct agent, in parallel — bounded by the slice
    // above, and each agent's own document is a cheap point read (not a
    // scan). Names are best-effort: an agent that has since been deleted
    // (its runs/rollups outliving it, e.g. mid-retention-purge) is still
    // included with `agentName: undefined` rather than dropped, since its
    // historical rollup numbers remain meaningful.
    const agentDocs = await Promise.all(agentIds.map((id) => ctx.db.get(id)));
    const nameById = new Map<Id<"agents">, string>();
    for (const doc of agentDocs) {
      if (doc && doc.orgId === args.orgId) nameById.set(doc._id, doc.name);
    }

    return agentIds.map((agentId) => {
      const agg = byAgent.get(agentId)!;
      return {
        agentId,
        agentName: nameById.get(agentId),
        runsTotal: agg.runsTotal,
        runsFailed: agg.runsFailed,
        failureRate: failureRateOf(agg),
        tokensIn: agg.tokensIn,
        tokensOut: agg.tokensOut,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// 2. getAgentCostStats
// ---------------------------------------------------------------------------

/**
 * Bounded sample of an agent's runs considered for cost. Cost requires
 * reading each run's events (to recover the LLM model string, which lives in
 * event payloads, not on the run) — see AGENT_COST_MAX_EVENTS_PER_RUN below —
 * so this is deliberately smaller than a pure runs-table scan bound.
 */
const AGENT_COST_MAX_RUNS_SAMPLE = 300;

/**
 * Bounded per-run event read for cost extraction. Only `llm.request` (source
 * of the model string) and `llm.response` (source of token usage) events
 * matter; 200 comfortably covers most agent runs' LLM-call count while
 * keeping total reads bounded (worst case 300 * 200 = 60,000 event reads).
 */
const AGENT_COST_MAX_EVENTS_PER_RUN = 200;

interface ModelCostBreakdown {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** False if `model` could not be resolved to a known PRICING_TABLE entry (cost is $0 for this bucket). */
  matched: boolean;
}

export interface AgentCostStats {
  agentId: Id<"agents">;
  range: InsightRange;
  sampleSize: number;
  /** True if the run sample hit AGENT_COST_MAX_RUNS_SAMPLE — totals may understate a very high-volume agent. */
  truncated: boolean;
  totalCostUsd: number;
  byModel: ModelCostBreakdown[];
  /** Exact sums from runs.tokensIn/tokensOut (denormalized counters) across the sampled runs. */
  tokensIn: number;
  tokensOut: number;
  /** Distinct model keys that contributed tokens but $0 cost (unresolved pricing, or no model string found — reported as "unknown"). */
  unmatchedModels: string[];
  /**
   * Count of sampled runs whose `modelsSeen` recorded MORE THAN ONE distinct
   * model. Those runs' tokensIn/tokensOut are still attributed in full to
   * `modelsSeen[0]` (the first model observed on the run, in insertion
   * order) — see the ATTRIBUTION DECISION note on getAgentCostStats below.
   * This count exists so the UI can render "N runs used multiple models;
   * cost is attributed to the primary model only" instead of silently
   * presenting a single-model breakdown as if it were exact for every run.
   */
  unattributedMultiModel: number;
  /**
   * How the sampled runs were attributed. `viaModelsSeen` runs used the
   * denormalized `runs.modelsSeen` field (Team A, cycle 3) — no event reads
   * needed. `viaEventScan` runs predate that field (or had no LLM calls
   * recorded on it) and fell back to walking the run's events directly, as
   * this query did prior to cycle 3. The two counts sum to `sampleSize`.
   */
  costAttribution: {
    viaModelsSeen: number;
    viaEventScan: number;
  };
}

/**
 * Cost stats for one agent over the trailing 7/30 days, broken down by
 * model. `runs.tokensIn`/`tokensOut` (exact, denormalized counters — see
 * ADR-002) give the top-level token totals.
 *
 * ATTRIBUTION DECISION (cycle 3): as of this cycle, `runs.modelsSeen` (Team
 * A) denormalizes the deduped, insertion-ordered list of model strings a run
 * observed across its `llm.request`/`llm.response` events. That field records
 * WHICH models a run used, but not a PER-MODEL token split — tokensIn/tokensOut
 * are run-level counters, not per-LLM-call. Proportionally splitting a run's
 * tokens across N models would require per-model token counts we don't have
 * without re-reading every event (defeating the point of denormalizing
 * modelsSeen in the first place). So the honest choice made here is:
 *
 *   - A run with exactly one model in `modelsSeen`: attribute its full
 *     tokensIn/tokensOut to that model. This is EXACT.
 *   - A run with >1 model in `modelsSeen`: still attribute its full
 *     tokensIn/tokensOut to `modelsSeen[0]` (the first-observed model) —
 *     this is a documented APPROXIMATION, not exact — and count the run in
 *     `unattributedMultiModel` so callers can see how many runs' numbers are
 *     approximate rather than silently trusting a per-model total that may
 *     overstate the primary model's cost and understate any secondary
 *     model's.
 *   - A run with no `modelsSeen` (older run, predates cycle 3, or no LLM
 *     calls recorded on the field yet): fall back to the pre-cycle-3
 *     behavior — walk the run's events (bounded by
 *     AGENT_COST_MAX_EVENTS_PER_RUN) and pair each `llm.response`'s token
 *     usage with the nearest preceding `llm.request`'s model.
 *
 * See docs/design/insight_engine.md section 1 for why cost is never
 * persisted (always recomputed at query time from PRICING_TABLE).
 */
export const getAgentCostStats = query({
  args: {
    orgId: v.id("organizations"),
    agentId: v.id("agents"),
    range: v.union(v.literal("7d"), v.literal("30d")),
  },
  handler: async (ctx, args): Promise<AgentCostStats> => {
    await requireOrgMembership(ctx, args.orgId);

    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.orgId !== args.orgId) {
      throw afrError("NOT_FOUND", "Agent not found in this organization");
    }

    const cutoff = rangeCutoffMs(args.range);
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_agent_started", (q) => q.eq("agentId", args.agentId).gte("startedAt", cutoff))
      .take(AGENT_COST_MAX_RUNS_SAMPLE);

    let tokensIn = 0;
    let tokensOut = 0;
    let unattributedMultiModel = 0;
    let viaModelsSeen = 0;
    let viaEventScan = 0;
    const byModel = new Map<string, { tokensIn: number; tokensOut: number; costUsd: number; matched: boolean }>();
    const unmatchedModels = new Set<string>();

    const attribute = (model: string | undefined, inTok: number, outTok: number): void => {
      const key = model ?? "unknown";
      const estimate = model
        ? estimateCostUsd(model, inTok, outTok)
        : { costUsd: 0, matched: false as const };
      const entry = byModel.get(key) ?? { tokensIn: 0, tokensOut: 0, costUsd: 0, matched: false };
      entry.tokensIn += inTok;
      entry.tokensOut += outTok;
      entry.costUsd += estimate.costUsd;
      entry.matched = entry.matched || estimate.matched;
      byModel.set(key, entry);
      if (!estimate.matched) unmatchedModels.add(key);
    };

    for (const run of runs) {
      const runTokensIn = run.tokensIn ?? 0;
      const runTokensOut = run.tokensOut ?? 0;
      tokensIn += runTokensIn;
      tokensOut += runTokensOut;

      const modelsSeen = run.modelsSeen;
      if (modelsSeen !== undefined && modelsSeen.length > 0) {
        // Exact, event-scan-free path (cycle 3): attribute the run's counters
        // to its primary (first-observed) model. See ATTRIBUTION DECISION above.
        viaModelsSeen += 1;
        if (modelsSeen.length > 1) unattributedMultiModel += 1;
        attribute(modelsSeen[0], runTokensIn, runTokensOut);
        continue;
      }

      // Fallback: no modelsSeen recorded on this run — walk its events, same
      // as the pre-cycle-3 behavior.
      viaEventScan += 1;
      const events = await ctx.db
        .query("events")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .order("asc")
        .take(AGENT_COST_MAX_EVENTS_PER_RUN);

      let lastRequestModel: string | undefined;
      for (const event of events) {
        if (event.type === "llm.request") {
          const m = extractModel(event.payload);
          if (m) lastRequestModel = m;
          continue;
        }
        if (event.type !== "llm.response") continue;

        const { tokensIn: inTok, tokensOut: outTok } = extractTokenUsage(event.payload);
        if (inTok === 0 && outTok === 0) continue;

        const model = extractModel(event.payload) ?? lastRequestModel;
        attribute(model, inTok, outTok);
      }
    }

    const byModelArr: ModelCostBreakdown[] = [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd);
    const totalCostUsd = byModelArr.reduce((sum, m) => sum + m.costUsd, 0);

    return {
      agentId: args.agentId,
      range: args.range,
      sampleSize: runs.length,
      truncated: runs.length >= AGENT_COST_MAX_RUNS_SAMPLE,
      totalCostUsd,
      byModel: byModelArr,
      tokensIn,
      tokensOut,
      unmatchedModels: [...unmatchedModels],
      unattributedMultiModel,
      costAttribution: { viaModelsSeen, viaEventScan },
    };
  },
});

// ---------------------------------------------------------------------------
// 3. compareVersions
// ---------------------------------------------------------------------------

/** Bounded per-side sample size for a version comparison. */
const VERSION_COMPARE_MAX_RUNS_PER_SIDE = 1000;

/**
 * How many total run documents the FALLBACK path (see below) is willing to
 * scan via by_agent_started while looking for matches for ONE side of the
 * comparison, expressed as a multiple of VERSION_COMPARE_MAX_RUNS_PER_SIDE.
 * Only exercised if `by_agent_version_started` is ever unavailable (kept as a
 * defense-in-depth fallback — see collectRunSummariesForVersion below).
 */
const VERSION_COMPARE_SCAN_MULTIPLIER = 5;

interface VersionRunSample {
  summaries: RunSummary[];
  scanned: number;
  /** True if we stopped before exhausting the version's (or, in the fallback path, the agent's) run history — hit the sample cap or the scan budget. */
  truncated: boolean;
  /**
   * True when `summaries` is an EXACT set of this version's runs (subject
   * only to the `truncated` sample cap above) — i.e. sourced via the
   * `by_agent_version_started` index, which is keyed on `agentVersionId`
   * directly. False means `summaries` came from the legacy overfetch-and-filter
   * fallback (see below) and is a best-effort, most-recent-first
   * approximation rather than a guaranteed-exact per-version sample.
   */
  exact: boolean;
}

/**
 * EXACT per-version run sample (cycle 3): `runs.by_agent_version_started`
 * (Team A, `[agentVersionId, startedAt]`) lets us query this version's runs
 * directly instead of overfetching the agent's full history and filtering in
 * memory. Every row read here already belongs to `agentVersionId` — there is
 * no wasted scan over other versions' runs, so `scanned === summaries.length`
 * (mod the bounded sample cap) and `exact` is always `true`. The sample cap
 * (`maxMatches`) still applies for a version with more runs than that: this
 * is EXACT up to `maxMatches`, most-recent-first, with `truncated: true`
 * flagging that a very high-volume version's totals reflect only its most
 * recent `maxMatches` runs.
 */
async function collectRunSummariesForVersion(
  ctx: QueryCtx,
  agentVersionId: Id<"agent_versions">,
  maxMatches: number,
): Promise<VersionRunSample> {
  const rows = await ctx.db
    .query("runs")
    .withIndex("by_agent_version_started", (q) => q.eq("agentVersionId", agentVersionId))
    .order("desc")
    .take(maxMatches + 1);

  const truncated = rows.length > maxMatches;
  const bounded = truncated ? rows.slice(0, maxMatches) : rows;
  const summaries: RunSummary[] = bounded.map((run) => ({
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
  }));

  return { summaries, scanned: summaries.length, truncated, exact: true };
}

/**
 * FALLBACK ONLY — legacy pre-cycle-3 path, kept as defense-in-depth in case
 * `by_agent_version_started` is ever missing or fails at runtime (e.g. a
 * schema rollback). Overfetches the agent's most-recent runs via
 * `by_agent_started` (NOT version-scoped) and filters to `agentVersionId` in
 * memory — a best-effort, most-recent-first APPROXIMATION, not an exact
 * per-version sample. `compareVersions` only reaches this path if the exact
 * query above throws.
 */
async function collectRunSummariesForVersionFallback(
  ctx: QueryCtx,
  agentId: Id<"agents">,
  agentVersionId: Id<"agent_versions">,
  maxMatches: number,
): Promise<VersionRunSample> {
  const maxScan = maxMatches * VERSION_COMPARE_SCAN_MULTIPLIER;
  const candidates = await ctx.db
    .query("runs")
    .withIndex("by_agent_started", (q) => q.eq("agentId", agentId))
    .order("desc")
    .take(maxScan);

  const matches: RunSummary[] = [];
  for (const run of candidates) {
    if (run.agentVersionId === agentVersionId) {
      matches.push({
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
      });
      if (matches.length >= maxMatches) break;
    }
  }

  return {
    summaries: matches,
    scanned: candidates.length,
    truncated: matches.length >= maxMatches || candidates.length >= maxScan,
    exact: false,
  };
}

/**
 * Collect one version's run sample, preferring the EXACT
 * `by_agent_version_started` path and falling back to the legacy
 * overfetch-and-filter approximation ONLY if the exact query throws at
 * runtime (defense-in-depth — see collectRunSummariesForVersionFallback).
 */
async function collectRunSummariesForVersionSafe(
  ctx: QueryCtx,
  agentId: Id<"agents">,
  agentVersionId: Id<"agent_versions">,
  maxMatches: number,
): Promise<VersionRunSample> {
  try {
    return await collectRunSummariesForVersion(ctx, agentVersionId, maxMatches);
  } catch {
    return await collectRunSummariesForVersionFallback(ctx, agentId, agentVersionId, maxMatches);
  }
}

export interface VersionCohortSummary {
  id: Id<"agent_versions">;
  version: string;
  sampleSize: number;
  scanned: number;
  truncated: boolean;
  /** See VersionRunSample.exact — true means this side's sample is guaranteed exact (mod the sample cap). */
  exact: boolean;
  countsByStatus: Record<string, number>;
}

/**
 * The flagship "did version B regress vs version A" query. As of cycle 3,
 * each side's run sample is EXACT (see collectRunSummariesForVersion) via
 * `runs.by_agent_version_started` — no more most-recent-N overfetch-and-filter
 * approximation in the common case. The samples are run through
 * `compareCohorts` (convex/helpers/analytics.ts), which returns per-metric
 * deltas plus a plain-language significance hint on failure rate (backed by a
 * two-proportion z-test with a small-n guard — see that module for the exact
 * statistical caveats).
 */
export const compareVersions = query({
  args: {
    orgId: v.id("organizations"),
    agentVersionIdA: v.id("agent_versions"),
    agentVersionIdB: v.id("agent_versions"),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const versionA = await ctx.db.get(args.agentVersionIdA);
    const versionB = await ctx.db.get(args.agentVersionIdB);
    if (!versionA || versionA.orgId !== args.orgId) {
      throw afrError("NOT_FOUND", "Agent version A not found in this organization");
    }
    if (!versionB || versionB.orgId !== args.orgId) {
      throw afrError("NOT_FOUND", "Agent version B not found in this organization");
    }
    if (versionA.agentId !== versionB.agentId) {
      throw afrError("INVALID_ARGUMENT", "Both versions must belong to the same agent");
    }

    const [a, b] = await Promise.all([
      collectRunSummariesForVersionSafe(ctx, versionA.agentId, versionA._id, VERSION_COMPARE_MAX_RUNS_PER_SIDE),
      collectRunSummariesForVersionSafe(ctx, versionB.agentId, versionB._id, VERSION_COMPARE_MAX_RUNS_PER_SIDE),
    ]);

    const comparison = compareCohorts(a.summaries, b.summaries);
    const statsA = computeRunStats(a.summaries);
    const statsB = computeRunStats(b.summaries);

    const versionASummary: VersionCohortSummary = {
      id: versionA._id,
      version: versionA.version,
      sampleSize: a.summaries.length,
      scanned: a.scanned,
      truncated: a.truncated,
      exact: a.exact,
      countsByStatus: statsA.countsByStatus,
    };
    const versionBSummary: VersionCohortSummary = {
      id: versionB._id,
      version: versionB.version,
      sampleSize: b.summaries.length,
      scanned: b.scanned,
      truncated: b.truncated,
      exact: b.exact,
      countsByStatus: statsB.countsByStatus,
    };

    return {
      agentId: versionA.agentId,
      versionA: versionASummary,
      versionB: versionBSummary,
      comparison,
    };
  },
});

// ---------------------------------------------------------------------------
// 4. listEvalsForVersion
// ---------------------------------------------------------------------------

const EVAL_LIST_MAX_SAMPLE = 500;
const RECENT_FAILURES_LIMIT = 10;

export interface EvalFailureSummary {
  evalId: Id<"evals">;
  runId: Id<"runs">;
  name: string;
  kind: "rule" | "llm_judge" | "manual";
  details: string | undefined;
  createdAt: number;
}

export interface VersionEvalStats {
  agentVersionId: Id<"agent_versions">;
  range: InsightRange;
  sampleSize: number;
  passed: number;
  failed: number;
  passRate: number | null;
  recentFailures: EvalFailureSummary[];
  /** True if the underlying (pre-range-filter) evals sample hit EVAL_LIST_MAX_SAMPLE. */
  truncated: boolean;
  /**
   * True if this agent version has at least one eval rule configured
   * (`agent_versions.evalRules`). Distinguishes "no rules were ever defined
   * for this version" (rulesConfigured: false, sampleSize: 0 — nothing to
   * show, not a signal of health) from "rules are configured but this
   * version simply has zero evals in range yet" (rulesConfigured: true,
   * sampleSize: 0 — e.g. a brand-new version with no completed runs yet).
   * The eval-panel UI should render distinct empty states for these two
   * cases rather than one generic "no data" message.
   */
  rulesConfigured: boolean;
}

/**
 * Pass/fail rollup for one agent version's evals over the trailing 7/30
 * days, plus the most recent failures for quick triage. Reads a bounded,
 * newest-first sample via the `by_org_version` index and filters to the
 * requested range in memory (the index has no `createdAt` component).
 */
export const listEvalsForVersion = query({
  args: {
    orgId: v.id("organizations"),
    agentVersionId: v.id("agent_versions"),
    range: v.union(v.literal("7d"), v.literal("30d")),
  },
  handler: async (ctx, args): Promise<VersionEvalStats> => {
    await requireOrgMembership(ctx, args.orgId);

    const version = await ctx.db.get(args.agentVersionId);
    if (!version || version.orgId !== args.orgId) {
      throw afrError("NOT_FOUND", "Agent version not found in this organization");
    }

    const cutoff = rangeCutoffMs(args.range);
    const rows = await ctx.db
      .query("evals")
      .withIndex("by_org_version", (q) => q.eq("orgId", args.orgId).eq("agentVersionId", args.agentVersionId))
      .order("desc")
      .take(EVAL_LIST_MAX_SAMPLE);

    const inRange = rows.filter((r) => r.createdAt >= cutoff);
    const passed = inRange.filter((r) => r.passed).length;
    const failed = inRange.length - passed;

    const recentFailures: EvalFailureSummary[] = inRange
      .filter((r) => !r.passed)
      .slice(0, RECENT_FAILURES_LIMIT)
      .map((r) => ({
        evalId: r._id,
        runId: r.runId,
        name: r.name,
        kind: r.kind,
        details: r.details,
        createdAt: r.createdAt,
      }));

    const rulesConfigured = Array.isArray(version.evalRules) && version.evalRules.length > 0;

    return {
      agentVersionId: args.agentVersionId,
      range: args.range,
      sampleSize: inRange.length,
      passed,
      failed,
      passRate: inRange.length > 0 ? passed / inRange.length : null,
      recentFailures,
      truncated: rows.length >= EVAL_LIST_MAX_SAMPLE,
      rulesConfigured,
    };
  },
});

// ---------------------------------------------------------------------------
// 4b. getRunEvalSummary — compact pass/fail/score rollup for ONE run, for the
//     run-detail Evals panel header (alongside the per-eval list).
// ---------------------------------------------------------------------------

/** Bounded read of a single run's evals — generous relative to any real rule-set size (MAX_EVAL_RULES_PER_VERSION=20 plus one summary row). */
const RUN_EVAL_SUMMARY_MAX_SAMPLE = 500;

export interface RunEvalItem {
  evalId: Id<"evals">;
  name: string;
  kind: "rule" | "llm_judge" | "manual";
  passed: boolean;
  score: number | undefined;
  details: string | undefined;
  createdAt: number;
}

export interface RunEvalSummary {
  runId: Id<"runs">;
  total: number;
  passed: number;
  failed: number;
  passRate: number | null;
  /** Mean of `score` across evals that reported one (undefined score is excluded, not treated as 0). Null if no eval in this run reported a score. */
  averageScore: number | null;
  overallPassed: boolean | null;
  evals: RunEvalItem[];
  /** True if this run's evals sample hit RUN_EVAL_SUMMARY_MAX_SAMPLE. */
  truncated: boolean;
}

/**
 * Compact pass/fail/score rollup for one run's evals, for the run-detail
 * Evals panel header. Complements the per-eval list (same `evals` rows,
 * already fetchable via `by_run`) with the summary numbers the header wants
 * so the UI doesn't have to recompute them client-side.
 */
export const getRunEvalSummary = query({
  args: {
    orgId: v.id("organizations"),
    runId: v.id("runs"),
  },
  handler: async (ctx, args): Promise<RunEvalSummary> => {
    await requireOrgMembership(ctx, args.orgId);

    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== args.orgId) {
      throw afrError("NOT_FOUND", "Run not found in this organization");
    }

    const rows = await ctx.db
      .query("evals")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      // Defensive: evals.by_run is not itself org-scoped, but every row for a
      // given runId is written by code that stamps orgId from the run itself
      // (see runEvalsForRun / recordEval) — this filter is belt-and-suspenders,
      // not load-bearing for tenancy (the runId itself was already validated
      // to belong to args.orgId above).
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .take(RUN_EVAL_SUMMARY_MAX_SAMPLE);

    const passed = rows.filter((r) => r.passed).length;
    const failed = rows.length - passed;
    const scored = rows.filter((r) => r.score !== undefined);
    const averageScore =
      scored.length > 0 ? scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length : null;

    return {
      runId: args.runId,
      total: rows.length,
      passed,
      failed,
      passRate: rows.length > 0 ? passed / rows.length : null,
      averageScore,
      overallPassed: rows.length > 0 ? failed === 0 : null,
      evals: rows.map((r) => ({
        evalId: r._id,
        name: r.name,
        kind: r.kind,
        passed: r.passed,
        score: r.score,
        details: r.details,
        createdAt: r.createdAt,
      })),
      truncated: rows.length >= RUN_EVAL_SUMMARY_MAX_SAMPLE,
    };
  },
});

// ---------------------------------------------------------------------------
// 5. runEvalsForRun — eval execution, scheduled by Team A from the
//    terminal-event path (ctx.scheduler.runAfter(0, internal.insights.runEvalsForRun, ...)).
// ---------------------------------------------------------------------------

/** Bounded event read for eval-rule evaluation. */
const EVAL_RUN_MAX_EVENTS = 2000;

/** Sentinel `evals.createdBy` value written ONLY by this function — powers the idempotency check. */
const EVAL_SOURCE = "system:runEvalsForRun";

/** Stay well under MAX_EVAL_DETAILS_BYTES (4KB, helpers/pagination.ts) even for multi-byte explanations. */
const EVAL_DETAIL_MAX_CHARS = 1000;

function truncateDetails(s: string): string {
  return s.length > EVAL_DETAIL_MAX_CHARS ? s.slice(0, EVAL_DETAIL_MAX_CHARS) : s;
}

export type RunEvalsResult =
  | { skipped: true; reason: "run_not_found" | "already_evaluated" | "no_agent_version" | "version_not_found" | "no_rules" }
  | { skipped: false; insertedCount: number; overallPassed: boolean };

/**
 * Evaluate an agent version's eval rules against one run's outcome + events,
 * and record ONE `evals` row per rule result plus a summary row (append-only
 * — evals are never updated in place, matching audit_log/events).
 *
 * IDEMPOTENT: if any `evals` row for this run already has
 * `createdBy === EVAL_SOURCE`, this is a no-op (`{ skipped: true, reason:
 * "already_evaluated" }`) — safe to call more than once for the same run
 * (e.g. a scheduler retry).
 *
 * COORDINATION NOTE (see cycle report): `agent_versions.evalRules` does not
 * exist on the schema yet — Team A is adding it (ADR-002, cycle 2 plan in
 * docs/design/insight_engine.md section 3). This file cannot edit
 * schema.ts, so the field is read via a guarded cast
 * (`?? []`) that compiles today and picks up the real field with zero code
 * change once it lands.
 */
export const runEvalsForRun = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args): Promise<RunEvalsResult> => {
    const run = await ctx.db.get(args.runId);
    if (!run) return { skipped: true, reason: "run_not_found" };

    const existingSystemEval = await ctx.db
      .query("evals")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .filter((q) => q.eq(q.field("createdBy"), EVAL_SOURCE))
      .first();
    if (existingSystemEval) {
      return { skipped: true, reason: "already_evaluated" };
    }

    if (!run.agentVersionId) {
      return { skipped: true, reason: "no_agent_version" };
    }
    const version = await ctx.db.get(run.agentVersionId);
    if (!version || version.orgId !== run.orgId) {
      return { skipped: true, reason: "version_not_found" };
    }

    // Team A landed agent_versions.evalRules as `v.array(v.any())` this cycle
    // (the EvalRule discriminated union can't be expressed in the validator
    // DSL — same justified exception as events.payload). Cast to the real
    // EvalRule[] shape here at the query-layer boundary.
    const rules: EvalRule[] = ((version.evalRules as EvalRule[] | undefined) ?? []);
    if (rules.length === 0) {
      return { skipped: true, reason: "no_rules" };
    }

    const events = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .order("asc")
      .take(EVAL_RUN_MAX_EVENTS);

    const runLike: EvalRunLike = {
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
    };
    const eventLikes: EvalEventLike[] = events.map((e) => ({
      type: e.type,
      sequenceNumber: e.sequenceNumber,
      timestamp: e.timestamp,
      payload: e.payload,
    }));

    const result = evaluateRules(rules, runLike, eventLikes);
    const now = Date.now();
    const agentVersionId = run.agentVersionId;

    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i]!;
      await ctx.db.insert("evals", {
        orgId: run.orgId,
        runId: args.runId,
        agentVersionId,
        name: `rule:${i}:${r.rule.kind}`.slice(0, 80),
        kind: "rule",
        passed: r.passed,
        score: r.passed ? 1 : 0,
        details: truncateDetails(r.explanation),
        createdAt: now,
        createdBy: EVAL_SOURCE,
      });
    }

    const passedCount = result.results.filter((r) => r.passed).length;
    await ctx.db.insert("evals", {
      orgId: run.orgId,
      runId: args.runId,
      agentVersionId,
      name: "eval_summary",
      kind: "rule",
      passed: result.overallPassed,
      score: result.results.length > 0 ? passedCount / result.results.length : undefined,
      details: truncateDetails(`${passedCount}/${result.results.length} rules passed`),
      createdAt: now,
      createdBy: EVAL_SOURCE,
    });

    return {
      skipped: false,
      insertedCount: result.results.length + 1,
      overallPassed: result.overallPassed,
    };
  },
});

// ---------------------------------------------------------------------------
// 6. buildHeuristicExplanation — pure, deterministic "Why did this fail?"
//    heuristic engine (NEW this cycle). No `ctx`, no LLM, no external config.
//    Team A's `generateRunExplanation` (its own file) reads a run + its
//    events + evals, computes/derives a FailureSummary (apps/web's
//    buildFailureSummary shape — duplicated here as a minimal structural
//    type, per this file's existing convention of NOT importing another
//    team's in-flight module) and calls this function.
//
// GROUNDING GUARANTEE: every fact asserted in `summary`/`rootCause`/
// `suggestedFix` and every number in `citedSeqNums` is read directly off a
// real input event, the run, or a real eval row — never invented. Concretely:
//   - citedSeqNums is filtered, at the very end, down to sequenceNumbers that
//     actually appear in the `events` array passed in (see
//     VALID_SEQ_NUMS/clampCitedSeqNums below) — even a caller-supplied
//     failureSummary pointing at a bogus seq number cannot leak through.
//   - Tool/model names and error text are read from the actual event payload
//     found at that sequence number, tolerantly and defensively (never
//     JSON.stringify'd wholesale, never assumed present).
//   - If no such fact can be found, the field is either omitted (suggestedFix)
//     or replaced with an honest, generic phrase — never a fabricated
//     specific (no invented tool names, no invented durations).
//   - The whole function is wrapped so it NEVER throws: any unexpected shape
//     (missing run, malformed events, non-array evals, NaN sequence numbers,
//     circular payloads accessed only via typeof-guarded property reads)
//     degrades to failureClass "unknown" with an honest "couldn't determine
//     a specific cause" summary, still citing the terminal event when one
//     can be identified.
// ---------------------------------------------------------------------------

export type HeuristicFailureClass =
  | "tool_timeout"
  | "tool_error"
  | "llm_error"
  | "assertion_failed"
  | "terminal_error"
  | "incomplete"
  | "unknown";

/** Minimal run shape this engine needs. Duplicated (not imported) from contracts/schema per this file's convention. */
export interface HeuristicRunLike {
  status: string;
  startedAt: number;
  endedAt?: number;
}

/** Minimal event shape this engine needs — a superset of EvalEventLike (adds sequenceNumber as required, not optional). */
export interface HeuristicEventLike {
  type: string;
  sequenceNumber: number;
  timestamp?: number;
  payload?: unknown;
}

/** Mirrors apps/web's FailurePoint (packages/contracts/src/replay.ts) structurally — not imported, to avoid coupling to that team's module during their active cycle. */
export interface HeuristicFailurePointLike {
  sequenceNumber: number;
  type: string;
  errorMessage?: string;
  reason?: string;
}

/** Mirrors apps/web's FailureSummary structurally. */
export interface HeuristicFailureSummaryLike {
  hasFailure: boolean;
  primaryFailure: HeuristicFailurePointLike | null;
  allFailurePoints: HeuristicFailurePointLike[];
  isIncomplete: boolean;
  cannotInfer: boolean;
}

/** Minimal eval shape — mirrors evals table rows / RuleResult explanations. */
export interface HeuristicEvalLike {
  name: string;
  passed: boolean;
  details?: string;
}

export interface HeuristicExplanationInput {
  run: HeuristicRunLike;
  events: HeuristicEventLike[];
  failureSummary: HeuristicFailureSummaryLike;
  evals: HeuristicEvalLike[];
}

export interface ExplanationResult {
  /** Plain-English narrative, <= 2KB. */
  summary: string;
  /** The single most likely proximate cause, <= 1KB. */
  rootCause: string;
  /** Concrete, honest suggestion — omitted (not guessed) when none applies. */
  suggestedFix?: string;
  /** Real sequenceNumbers from `events`, <= 20, deduped, ascending. */
  citedSeqNums: number[];
  failureClass: HeuristicFailureClass;
}

const EXPLANATION_SUMMARY_MAX_CHARS = 2000; // ~2KB of plain ASCII/UTF-8 English text
const EXPLANATION_ROOT_CAUSE_MAX_CHARS = 1000; // ~1KB
const EXPLANATION_FIX_MAX_CHARS = 1000; // ~1KB
const EXPLANATION_MAX_CITED_SEQ_NUMS = 20;
/** Defensive bound: never let this pure function do unbounded work even if a caller hands it an enormous events array. Most-recent events matter most for failure context, so we keep the tail (plus the first event, for RUN_STARTED context) when trimming. */
const EXPLANATION_MAX_EVENTS_SCANNED = 1000;
/** Backward-search window (in array positions, not sequence-number distance) used when hunting for the tool.call/llm.request that preceded a failure. Generous relative to any realistic single-run event burst between a request and its failure. */
const EXPLANATION_BACKWARD_WINDOW = 100;

function truncateText(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

/** Never throws — returns undefined for anything that isn't a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Tolerant string field read. Never throws. */
function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Tolerant model-name extraction from an llm.request/llm.response payload.
 * Deliberately duplicates (does not import) helpers/run_fields.ts's
 * extractModel — this file owns zero coupling to Team A's actively-changing
 * modules, matching the header note at the top of this file.
 */
function extractModelLoose(payload: unknown): string | undefined {
  const top = asRecord(payload);
  if (!top) return undefined;
  const direct = stringField(top, "model");
  if (direct) return direct;
  for (const key of ["request", "response", "body"]) {
    const nested = asRecord(top[key]);
    const m = stringField(nested, "model");
    if (m) return m;
  }
  return undefined;
}

/** Tolerant call_id extraction (tool.call / tool.result / tool.error payloads share this field). */
function extractCallId(payload: unknown): string | undefined {
  return stringField(asRecord(payload), "call_id");
}

/** Tolerant tool name extraction (tool.call payload). */
function extractToolName(payload: unknown): string | undefined {
  return stringField(asRecord(payload), "name");
}

/**
 * Sort ascending by sequenceNumber, dropping any entry whose sequenceNumber
 * isn't a finite number (hostile/malformed input) rather than letting it
 * corrupt the sort or downstream lookups. Then bound the result: keep the
 * first event (RUN_STARTED context) plus the most recent
 * EXPLANATION_MAX_EVENTS_SCANNED - 1, since a failure's evidence is almost
 * always near the end of the trace.
 */
function sanitizeAndBoundEvents(events: HeuristicEventLike[]): HeuristicEventLike[] {
  const valid = (Array.isArray(events) ? events : []).filter(
    (e): e is HeuristicEventLike =>
      !!e && typeof e === "object" && typeof e.sequenceNumber === "number" && Number.isFinite(e.sequenceNumber) && typeof e.type === "string",
  );
  valid.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (valid.length <= EXPLANATION_MAX_EVENTS_SCANNED) return valid;

  const first = valid[0]!;
  const tail = valid.slice(valid.length - (EXPLANATION_MAX_EVENTS_SCANNED - 1));
  return tail[0] === first ? tail : [first, ...tail];
}

function findEventBySeq(sorted: HeuristicEventLike[], seqNum: number): HeuristicEventLike | undefined {
  return sorted.find((e) => e.sequenceNumber === seqNum);
}

/** Nearest preceding event (by array position) matching `type`, searched within a bounded backward window from `fromIndex`. */
function findPrecedingEventOfType(
  sorted: HeuristicEventLike[],
  fromIndex: number,
  type: string,
): HeuristicEventLike | undefined {
  const start = Math.max(0, fromIndex - EXPLANATION_BACKWARD_WINDOW);
  for (let i = fromIndex - 1; i >= start; i--) {
    if (sorted[i]!.type === type) return sorted[i];
  }
  return undefined;
}

/** Nearest preceding tool.call event whose call_id matches, searched within a bounded backward window. */
function findPrecedingToolCall(
  sorted: HeuristicEventLike[],
  fromIndex: number,
  callId: string | undefined,
): HeuristicEventLike | undefined {
  const start = Math.max(0, fromIndex - EXPLANATION_BACKWARD_WINDOW);
  for (let i = fromIndex - 1; i >= start; i--) {
    const e = sorted[i]!;
    if (e.type !== "tool.call") continue;
    if (callId === undefined) return e; // best-effort: no call_id to match on, take the nearest tool.call
    if (extractCallId(e.payload) === callId) return e;
  }
  return undefined;
}

function looksLikeTimeout(text: string | undefined): boolean {
  if (!text) return false;
  return /\btime(d)?[\s-]?out\b/i.test(text);
}

export interface FailureClassification {
  failureClass: HeuristicFailureClass;
  /** The raw event that is the strongest evidence for this classification, or null if none applies/was found. */
  evidenceEvent: HeuristicEventLike | null;
}

/**
 * Classify the failure into one of the fixed `HeuristicFailureClass` values.
 * Pure, never throws (see buildHeuristicExplanation's top-level guard for the
 * outermost safety net; this function is defensive on its own too since it's
 * exported as an independently-testable unit).
 *
 * Priority order (highest to lowest):
 *   1. incomplete       — failureSummary says the run has no terminal event.
 *   2. tool_timeout/tool_error/llm_error/terminal_error — driven by
 *      failureSummary.primaryFailure's `reason`, refined by inspecting the
 *      actual event payload at that sequence number.
 *   3. assertion_failed — no execution-trace failure point, but at least one
 *      eval failed (a run can execute cleanly and still fail an eval).
 *   4. unknown          — cannotInfer, or nothing above matched.
 */
export function classifyFailure(input: HeuristicExplanationInput): FailureClassification {
  const { run, failureSummary, evals } = input;
  const sorted = sanitizeAndBoundEvents(input.events);

  if (failureSummary?.isIncomplete) {
    return { failureClass: "incomplete", evidenceEvent: null };
  }

  const primary = failureSummary?.primaryFailure ?? null;
  if (primary && typeof primary.sequenceNumber === "number" && Number.isFinite(primary.sequenceNumber)) {
    const evidenceEvent = findEventBySeq(sorted, primary.sequenceNumber) ?? null;
    const reason = primary.reason;

    if (reason === "failed_tool") {
      const isTimeout = looksLikeTimeout(primary.errorMessage) || looksLikeTimeout(stringField(asRecord(evidenceEvent?.payload), "message"));
      return { failureClass: isTimeout ? "tool_timeout" : "tool_error", evidenceEvent };
    }
    if (reason === "failed_llm") {
      return { failureClass: "llm_error", evidenceEvent };
    }
    if (reason === "run_failed" || reason === "error_event") {
      return { failureClass: "terminal_error", evidenceEvent };
    }
    // Unrecognized reason string (forward-compat / hostile input): fall through.
  }

  const hasFailedEval = Array.isArray(evals) && evals.some((e) => e && e.passed === false);
  if (hasFailedEval) {
    return { failureClass: "assertion_failed", evidenceEvent: null };
  }

  if (run?.status === "failed" && !primary) {
    // Run is marked failed but no failure point could be located at all —
    // honest "unknown", not a fabricated terminal_error.
    return { failureClass: "unknown", evidenceEvent: null };
  }

  return { failureClass: "unknown", evidenceEvent: null };
}

/** Collect the set of real, finite sequenceNumbers present in `events` — the sole source of truth citedSeqNums may draw from. */
function realSeqNumSet(events: HeuristicEventLike[]): Set<number> {
  const set = new Set<number>();
  for (const e of events) {
    if (typeof e.sequenceNumber === "number" && Number.isFinite(e.sequenceNumber)) set.add(e.sequenceNumber);
  }
  return set;
}

/** Dedupe, filter to real sequence numbers, sort ascending, cap length — the grounding enforcement point for citedSeqNums. */
function clampCitedSeqNums(candidates: Array<number | undefined | null>, validSeqNums: Set<number>): number[] {
  const seen = new Set<number>();
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && validSeqNums.has(c)) seen.add(c);
  }
  return [...seen].sort((a, b) => a - b).slice(0, EXPLANATION_MAX_CITED_SEQ_NUMS);
}

function lastEventOf(sorted: HeuristicEventLike[]): HeuristicEventLike | undefined {
  return sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
}

/**
 * Build a grounded, plain-English explanation of why a run failed, from its
 * event trace + derived failure summary + eval results alone. Zero external
 * config, zero LLM calls — a fixed heuristic decision tree over real data.
 *
 * NEVER THROWS: the entire body is wrapped in try/catch; any unexpected
 * shape yields the "unknown" fallback (see buildUnknownFallback) rather than
 * propagating an exception to the caller (Team A's generateRunExplanation).
 */
export function buildHeuristicExplanation(input: HeuristicExplanationInput): ExplanationResult {
  try {
    return buildHeuristicExplanationInner(input);
  } catch {
    return buildUnknownFallback(input);
  }
}

function buildUnknownFallback(input: HeuristicExplanationInput): ExplanationResult {
  let sorted: HeuristicEventLike[] = [];
  try {
    sorted = sanitizeAndBoundEvents(input?.events ?? []);
  } catch {
    sorted = [];
  }
  const terminal = lastEventOf(sorted);
  const validSeqNums = realSeqNumSet(sorted);
  return {
    summary:
      "We couldn't determine a specific cause for this run from its recorded trace. The available event data was insufficient, malformed, or did not match any known failure pattern.",
    rootCause: "Unable to determine a root cause from the available trace data.",
    citedSeqNums: clampCitedSeqNums([terminal?.sequenceNumber], validSeqNums),
    failureClass: "unknown",
  };
}

function buildHeuristicExplanationInner(input: HeuristicExplanationInput): ExplanationResult {
  const run = input.run;
  const evals = Array.isArray(input.evals) ? input.evals : [];
  const failureSummary = input.failureSummary;
  const sorted = sanitizeAndBoundEvents(input.events);
  const validSeqNums = realSeqNumSet(sorted);
  const terminal = lastEventOf(sorted);

  // Guard: nothing to explain (healthy, completed run with no failed evals).
  // Not one of the documented failure classes to invent a new one for, so we
  // use "unknown" but with an honest, distinct message — this function is
  // documented as "shouldn't be called" for this case, but must still return
  // something sensible rather than throwing or fabricating a failure.
  const hasFailedEval = evals.some((e) => e && e.passed === false);
  if (!failureSummary?.hasFailure && !hasFailedEval && run?.status !== "failed" && !failureSummary?.isIncomplete) {
    return {
      summary: `This run completed with status "${String(run?.status)}" and no failure or eval failure was detected in its trace. There is nothing to explain.`,
      rootCause: "No failure detected.",
      citedSeqNums: clampCitedSeqNums([terminal?.sequenceNumber], validSeqNums),
      failureClass: "unknown",
    };
  }

  const { failureClass, evidenceEvent } = classifyFailure(input);

  if (failureClass === "incomplete") {
    return {
      summary: `This run has no terminal event recorded yet — its last observed event is ${terminal ? `#${terminal.sequenceNumber} (${terminal.type})` : "not available"}. It is either still in progress or the SDK failed to emit a completion event.`,
      rootCause: "The run has no RUN_COMPLETED/RUN_FAILED/RUN_CANCELLED terminal event in its trace.",
      suggestedFix:
        "If the agent process has actually exited, check whether the SDK's terminal-event flush ran (e.g. an uncaught exception before the finally/completion hook). Otherwise this run may simply still be in progress.",
      citedSeqNums: clampCitedSeqNums([terminal?.sequenceNumber], validSeqNums),
      failureClass,
    };
  }

  if (failureClass === "tool_timeout" || failureClass === "tool_error") {
    const primary = failureSummary?.primaryFailure ?? null;
    const failSeq = evidenceEvent?.sequenceNumber ?? primary?.sequenceNumber;
    const evidenceIndex = evidenceEvent ? sorted.indexOf(evidenceEvent) : -1;
    const callId = evidenceEvent ? extractCallId(evidenceEvent.payload) : undefined;
    const toolCallEvent =
      evidenceIndex >= 0 ? findPrecedingToolCall(sorted, evidenceIndex, callId) : undefined;
    const toolName = toolCallEvent ? extractToolName(toolCallEvent.payload) : undefined;
    const errorMessage = primary?.errorMessage ?? stringField(asRecord(evidenceEvent?.payload), "message");
    const toolLabel = toolName ? `\`${toolName}\`` : "a tool";
    const lastSuccessEvent = evidenceIndex >= 0 ? sorted[evidenceIndex - 1] : undefined;

    const stepsNote =
      lastSuccessEvent !== undefined
        ? `The agent had progressed to event #${lastSuccessEvent.sequenceNumber} (${lastSuccessEvent.type}) before things went wrong; `
        : "";
    const verb = failureClass === "tool_timeout" ? "timed out" : "failed";
    const summary = truncateText(
      `This run failed because the ${toolLabel} tool call ${verb}${failSeq !== undefined ? ` at event #${failSeq}` : ""}${errorMessage ? ` ("${truncateText(errorMessage, 300)}")` : ""}. ${stepsNote}the run was marked "${String(run.status)}"${terminal ? ` at event #${terminal.sequenceNumber}` : ""}.`,
      EXPLANATION_SUMMARY_MAX_CHARS,
    );
    const rootCause = truncateText(
      `The ${toolLabel} tool call ${verb}${errorMessage ? `: ${errorMessage}` : ", with no error message recorded on the event."}`,
      EXPLANATION_ROOT_CAUSE_MAX_CHARS,
    );
    const suggestedFix = truncateText(
      failureClass === "tool_timeout"
        ? `Consider raising the timeout configured for ${toolLabel}, or adding a fallback/retry path for it.`
        : `Check the inputs given to ${toolLabel}${failSeq !== undefined ? ` at event #${failSeq}` : ""} — the tool reported an error rather than timing out.`,
      EXPLANATION_FIX_MAX_CHARS,
    );

    return {
      summary,
      rootCause,
      suggestedFix,
      citedSeqNums: clampCitedSeqNums(
        [lastSuccessEvent?.sequenceNumber, toolCallEvent?.sequenceNumber, failSeq, terminal?.sequenceNumber],
        validSeqNums,
      ),
      failureClass,
    };
  }

  if (failureClass === "llm_error") {
    const primary = failureSummary?.primaryFailure ?? null;
    const failSeq = evidenceEvent?.sequenceNumber ?? primary?.sequenceNumber;
    const evidenceIndex = evidenceEvent ? sorted.indexOf(evidenceEvent) : -1;
    const requestEvent = evidenceIndex >= 0 ? findPrecedingEventOfType(sorted, evidenceIndex, "llm.request") : undefined;
    const model = requestEvent ? extractModelLoose(requestEvent.payload) : undefined;
    const errorMessage = primary?.errorMessage ?? stringField(asRecord(evidenceEvent?.payload), "message");
    const modelLabel = model ? `\`${model}\`` : "the model";
    const lastSuccessEvent = evidenceIndex >= 0 ? sorted[evidenceIndex - 1] : undefined;

    const summary = truncateText(
      `This run failed because a call to ${modelLabel} errored${failSeq !== undefined ? ` at event #${failSeq}` : ""}${errorMessage ? ` ("${truncateText(errorMessage, 300)}")` : ""}. The run was marked "${String(run.status)}"${terminal ? ` at event #${terminal.sequenceNumber}` : ""}.`,
      EXPLANATION_SUMMARY_MAX_CHARS,
    );
    const rootCause = truncateText(
      `The LLM call to ${modelLabel} errored${errorMessage ? `: ${errorMessage}` : ", with no error message recorded on the event."}`,
      EXPLANATION_ROOT_CAUSE_MAX_CHARS,
    );
    const suggestedFix = truncateText(
      `Review the request sent to ${modelLabel}${requestEvent ? ` at event #${requestEvent.sequenceNumber}` : ""} (prompt size, parameters, or provider-side incident) — the error was on the model call itself, not a tool.`,
      EXPLANATION_FIX_MAX_CHARS,
    );

    return {
      summary,
      rootCause,
      suggestedFix,
      citedSeqNums: clampCitedSeqNums(
        [lastSuccessEvent?.sequenceNumber, requestEvent?.sequenceNumber, failSeq, terminal?.sequenceNumber],
        validSeqNums,
      ),
      failureClass,
    };
  }

  if (failureClass === "assertion_failed") {
    const failedEval = evals.find((e) => e && e.passed === false);
    const evalName = failedEval?.name ?? "an eval";
    const details = failedEval?.details;
    const summary = truncateText(
      `This run's execution completed (status "${String(run.status)}"), but it failed the "${evalName}" eval${details ? `: ${truncateText(details, 300)}` : "."}${terminal ? ` The run's terminal event is #${terminal.sequenceNumber}.` : ""}`,
      EXPLANATION_SUMMARY_MAX_CHARS,
    );
    const rootCause = truncateText(
      `The "${evalName}" eval reported a failure${details ? `: ${details}` : ", with no further detail recorded."}`,
      EXPLANATION_ROOT_CAUSE_MAX_CHARS,
    );
    const suggestedFix = truncateText(
      `Review the "${evalName}" rule's expected condition against this run's actual behavior${details ? ` (${details})` : ""}, and adjust either the rule or the agent to close the gap.`,
      EXPLANATION_FIX_MAX_CHARS,
    );

    return {
      summary,
      rootCause,
      suggestedFix,
      citedSeqNums: clampCitedSeqNums([terminal?.sequenceNumber], validSeqNums),
      failureClass,
    };
  }

  if (failureClass === "terminal_error") {
    const primary = failureSummary?.primaryFailure ?? null;
    const failSeq = evidenceEvent?.sequenceNumber ?? primary?.sequenceNumber;
    const errorMessage = primary?.errorMessage ?? stringField(asRecord(evidenceEvent?.payload), "message");
    const evidenceIndex = evidenceEvent ? sorted.indexOf(evidenceEvent) : -1;
    const lastSuccessEvent = evidenceIndex >= 0 ? sorted[evidenceIndex - 1] : undefined;

    const summary = truncateText(
      `This run was marked "${String(run.status)}"${failSeq !== undefined ? ` at event #${failSeq}` : ""}${errorMessage ? ` with the reported error: "${truncateText(errorMessage, 400)}"` : ", with no error message recorded on the terminal event."}`,
      EXPLANATION_SUMMARY_MAX_CHARS,
    );
    const rootCause = truncateText(
      errorMessage
        ? `The run's terminal event reported: ${errorMessage}`
        : `The run ended with status "${String(run.status)}" but no error message was recorded on the terminal event.`,
      EXPLANATION_ROOT_CAUSE_MAX_CHARS,
    );
    const suggestedFix = errorMessage
      ? truncateText(
          `Investigate the reported error${failSeq !== undefined ? ` at event #${failSeq}` : ""}: "${truncateText(errorMessage, 300)}".`,
          EXPLANATION_FIX_MAX_CHARS,
        )
      : undefined;

    return {
      summary,
      rootCause,
      ...(suggestedFix !== undefined && { suggestedFix }),
      citedSeqNums: clampCitedSeqNums([lastSuccessEvent?.sequenceNumber, failSeq, terminal?.sequenceNumber], validSeqNums),
      failureClass,
    };
  }

  // failureClass === "unknown": either cannotInfer, or nothing matched.
  return {
    summary: failureSummary?.cannotInfer
      ? `This run was marked "${String(run.status)}", but no failure indicators (error events, a run.failed message, or a failed eval) were found in its trace to explain why.`
      : `We couldn't determine a specific cause for this run's "${String(run.status)}" status from its recorded trace.`,
    rootCause: "Unable to determine a root cause from the available trace data.",
    citedSeqNums: clampCitedSeqNums([terminal?.sequenceNumber], validSeqNums),
    failureClass: "unknown",
  };
}
