// Insight Engine (Team B) — cycle 2. Wires the pure engines from cycle 1
// (convex/helpers/{analytics,pricing,evals}.ts) into org-scoped Convex
// queries + the eval-execution internal mutation. See
// docs/design/insight_engine.md for the design/plan this file implements.
//
// FILE OWNERSHIP: this file (+ insights.test.ts) is the ONLY convex file
// Team B owns this cycle. Everything else (schema.ts, auth.ts, runs.ts,
// events.ts, evals.ts, agent_versions.ts, rollups.ts, helpers/*) belongs to
// Team A / was landed by prior cycles — read-only from here. Any date-math
// helpers below duplicate (rather than import) the tiny pure equivalents in
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
import { extractTokenUsage } from "./helpers/run_fields.js";

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

    return {
      range: args.range,
      agentId: args.agentId ?? null,
      totals: { ...totals, failureRate: failureRateOf(totals) },
      series,
    };
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
}

/**
 * Tolerant, best-effort extraction of an LLM model string from an event
 * payload. Tries top-level `model`, then `request.model` / `response.model`
 * nesting. Never throws. See docs/design/insight_engine.md section 1 — a run
 * may span multiple models, so cost is computed PER LLM CALL, not per run.
 */
function extractModelFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const nested = (key: string): unknown =>
    p[key] && typeof p[key] === "object" ? (p[key] as Record<string, unknown>)["model"] : undefined;
  const candidates = [p["model"], nested("request"), nested("response")];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

/**
 * Cost stats for one agent over the trailing 7/30 days, broken down by
 * model. `runs.tokensIn`/`tokensOut` (exact, denormalized counters — see
 * ADR-002) give the top-level token totals; the per-model breakdown requires
 * walking each sampled run's events to pair an `llm.response`'s token usage
 * with the model recorded on the nearest preceding `llm.request` (falling
 * back to a model field on the response itself, if present). This is
 * BEST-EFFORT: a payload shape this extractor doesn't recognize contributes
 * its tokens to the "unknown" bucket rather than being silently dropped or
 * guessed. See docs/design/insight_engine.md section 1 for why cost is never
 * persisted.
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
    const byModel = new Map<string, { tokensIn: number; tokensOut: number; costUsd: number; matched: boolean }>();
    const unmatchedModels = new Set<string>();

    for (const run of runs) {
      tokensIn += run.tokensIn ?? 0;
      tokensOut += run.tokensOut ?? 0;

      const events = await ctx.db
        .query("events")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .order("asc")
        .take(AGENT_COST_MAX_EVENTS_PER_RUN);

      let lastRequestModel: string | undefined;
      for (const event of events) {
        if (event.type === "llm.request") {
          const m = extractModelFromPayload(event.payload);
          if (m) lastRequestModel = m;
          continue;
        }
        if (event.type !== "llm.response") continue;

        const { tokensIn: inTok, tokensOut: outTok } = extractTokenUsage(event.payload);
        if (inTok === 0 && outTok === 0) continue;

        const model = extractModelFromPayload(event.payload) ?? lastRequestModel;
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
    };
  },
});

// ---------------------------------------------------------------------------
// 3. compareVersions
// ---------------------------------------------------------------------------

/** Bounded per-side sample size for a version comparison. */
const VERSION_COMPARE_MAX_RUNS_PER_SIDE = 1000;

/**
 * How many total run documents we're willing to scan (via by_agent_started,
 * which is not itself version-scoped — see note below) while looking for
 * matches for ONE side of the comparison, expressed as a multiple of
 * VERSION_COMPARE_MAX_RUNS_PER_SIDE. There is no `by_agent_version_started`
 * (or similar) index today, so this query must overfetch-and-filter the
 * agent's full run history in descending recency order. See the coordination
 * note in this cycle's report: an index keyed on agentVersionId would make
 * this exact instead of a bounded, most-recent-first best-effort sample.
 */
const VERSION_COMPARE_SCAN_MULTIPLIER = 5;

interface VersionRunSample {
  summaries: RunSummary[];
  scanned: number;
  /** True if we stopped before exhausting the agent's run history (hit the sample cap or the scan budget). */
  truncated: boolean;
}

async function collectRunSummariesForVersion(
  ctx: QueryCtx,
  agentId: Id<"agents">,
  agentVersionId: Id<"agent_versions">,
  maxMatches: number,
): Promise<VersionRunSample> {
  // A single bounded, most-recent-first read (NOT `.paginate()` — Convex
  // allows only one `.paginate()` call per function execution, and
  // compareVersions runs two of these concurrently via Promise.all, so a
  // manual pagination loop here would violate that limit at runtime). The
  // scan cap is generous enough (maxMatches * VERSION_COMPARE_SCAN_MULTIPLIER)
  // that a single `.take()` is the simpler, equally-bounded choice.
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
  };
}

export interface VersionCohortSummary {
  id: Id<"agent_versions">;
  version: string;
  sampleSize: number;
  scanned: number;
  truncated: boolean;
  countsByStatus: Record<string, number>;
}

/**
 * The flagship "did version B regress vs version A" query. Bounded,
 * best-effort samples of each version's runs (see
 * collectRunSummariesForVersion) are run through `compareCohorts`
 * (convex/helpers/analytics.ts), which returns per-metric deltas plus a
 * plain-language significance hint on failure rate (backed by a
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
      collectRunSummariesForVersion(ctx, versionA.agentId, versionA._id, VERSION_COMPARE_MAX_RUNS_PER_SIDE),
      collectRunSummariesForVersion(ctx, versionB.agentId, versionB._id, VERSION_COMPARE_MAX_RUNS_PER_SIDE),
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
      countsByStatus: statsA.countsByStatus,
    };
    const versionBSummary: VersionCohortSummary = {
      id: versionB._id,
      version: versionB.version,
      sampleSize: b.summaries.length,
      scanned: b.scanned,
      truncated: b.truncated,
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

    return {
      agentVersionId: args.agentVersionId,
      range: args.range,
      sampleSize: inRange.length,
      passed,
      failed,
      passRate: inRange.length > 0 ? passed / inRange.length : null,
      recentFailures,
      truncated: rows.length >= EVAL_LIST_MAX_SAMPLE,
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
