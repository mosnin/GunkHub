// ---------------------------------------------------------------------------
// FLEET HEALTH & CROSS-AGENT CORRELATION — Convex query surface.
//
// "Which of my agents are degrading, is the same failure hitting several of
// them, and did a group of them start failing at the same moment?"
//
// All analysis lives in the PURE engine, convex/helpers/fleet.ts, which
// implements `packages/contracts/src/fleet_health.ts`. This file is only:
// authorize -> read bounded facts -> call the engine -> report coverage
// honestly. Same division as convex/divergence.ts.
//
// READ-ONLY. Every function here is a `query`. Nothing writes, and in
// particular nothing writes a fleet report back: it is a DERIVED PROJECTION
// over recorded occurrence rows (CLAUDE.md Event Log Rule 2), recomputed on
// demand, never stored. `analyzedAt` is stamped from the server clock here (the
// engine takes it as data) so the report is self-evidently a snapshot.
//
// ===========================================================================
// TENANCY
// ===========================================================================
// Every function resolves and authorizes the CALLER first (getAuthContext +
// requireOrgMembership) and only THEN reads anything.
//
// THIS SURFACE TAKES NO ENTITY IDs AT ALL — no runId, no agentId, no
// versionId. That is deliberate and it is the strongest available form of the
// property this repo keeps having to re-establish: with no id to probe there is
// no cross-org EXISTENCE ORACLE to open, because there is nothing to observe
// the existence of. This repo has closed 25 such oracles
// (convex/tenancy_oracle.test.ts); the cheapest way not to open a 26th is to
// have no door.
//
// The one string a caller may pass is `fingerprintHash` in
// {@link fleetPatternReach}, and it is a CONTENT HASH, not an id: it is looked
// up only through `by_org_fingerprint` under the caller's own org, so a hash
// belonging to another org returns exactly what a hash belonging to nobody
// returns, on the same code path.
//
// ===========================================================================
// WHY THIS COSTS ZERO EVENT READS
// ===========================================================================
// `MAX_EVENTS_PER_RUN` is 50,000, `events` has no index on `type`, and an org
// may have thousands of runs. Any design that reads events to answer a
// fleet-level question is dead on arrival, and worse, truncates hardest during
// the incident it exists to explain.
//
// It is not necessary. `failure_pattern_occurrences` is ALREADY the fact table
// this feature needs: one idempotent row per failing run, carrying
// (orgId, fingerprintHash, agentId, agentVersionId, runId, occurredAt), indexed
// `by_org_occurredAt`. Cross-agent correlation is a GROUP BY over that index
// and burst detection is a sliding window over it. Neither touches `events`.
//
// WHAT IS DELIBERATELY NOT USED: `failure_patterns.affectedAgentIds`. It looks
// like exactly the field this feature wants and it is a trap — `v.optional`,
// absent on rollups written before it existed, capped at 20 most-recent-first,
// and (until this cycle) carrying no truncation marker at all. Reading fleet
// reach off it would UNDERCOUNT precisely on the widest-spreading failures,
// which are the only ones this feature exists to find. Agent sets here are
// derived from occurrence rows that were actually read.
//
// ===========================================================================
// THE CORRELATION PASS IS NOT PAGED. THIS IS THE LOAD-BEARING DESIGN CHOICE.
// ===========================================================================
// A cross-agent correlation does not compose across pages. A burst of twelve
// agents split four-and-eight across two pages is two sub-threshold clusters —
// invisible on each page and invisible in any merge, because the twelve onsets
// were already discarded by two threshold tests before any merge could happen.
// The failure is silent and total.
//
// So there is NO `.paginate()` in this file and no cursor over occurrences. The
// correlation pass reads the whole window for the whole roster in ONE
// execution, and `scan.correlationBasis` declares where it ran: `whole_roster`
// only when BOTH the roster and the occurrence scan were read to completion.
// `page_local` can never satisfy `isFleetHealthScanComplete`.
//
// Only the ROSTER LISTING is bounded by `limit`, and bounding it does not
// affect the correlation pass or `agentsFailing` — both are computed over every
// assessed agent. A caller wanting more rows raises `limit`; there is no cursor
// to walk, deliberately.
//
// ===========================================================================
// THE FOUR READS, AND WHY EACH USES THE SOURCE IT DOES
// ===========================================================================
//   ANALYSIS OCCURRENCES  Bounded `.take()` over the window. The correlation
//                         substrate.
//   BASELINE OCCURRENCES  A SEPARATE bounded `.take()` over an EARLIER range of
//                         the same index. Separate on purpose: if the baseline
//                         shared the analysis scan's budget, a large incident
//                         would consume it and the engine would report the
//                         incident as unprecedented on the strength of a row
//                         cap. See helpers/fleet.ts PART 4.
//   ANALYSIS RUNS         Live `.take()` on `runs.by_org_started`.
//                         Authoritative for the recent window, where rollups do
//                         not exist yet. Denominators, and the agent versions
//                         whose declarations feed base rates.
//   BASELINE RUN VOLUME   `daily_rollups`. Cron-written, therefore STALE for
//                         the recent window and RELIABLE for a days-old
//                         baseline — precisely inverted from a live run scan,
//                         which is unaffordable across weeks. Each window uses
//                         the source that is sound for it.
// ---------------------------------------------------------------------------

import { v } from "convex/values";

import { query } from "./_generated/server.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import {
  FLEET_DEFAULT_BURST_WINDOW_MS,
  FLEET_MAX_BURST_WINDOW_MS,
  FLEET_MIN_BURST_WINDOW_MS,
  FLEET_MIN_DISTINCT_AGENTS,
  foldFleetCorrelation,
  type FleetAgentDeclarationInput,
  type FleetAgentInput,
  type FleetOccurrenceInput,
  type FleetPatternInput,
  type FleetRunInput,
} from "./helpers/fleet.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

// ---------------------------------------------------------------------------
// Bounds. Each is an HONESTY bound as much as a cost bound: when one is hit the
// result says so, and the claims that depend on it are WITHHELD rather than
// weakened.
// ---------------------------------------------------------------------------

/** Agents read per call. Hitting this makes the correlation basis `page_local`. */
export const FLEET_ROSTER_CAP = 200;

/** Occurrence rows read across the analysis window, for the whole roster. */
export const FLEET_OCCURRENCE_CAP = 5_000;

/**
 * Occurrence rows read for the BASELINE. Its own budget, never shared with the
 * analysis scan — that separation is the entire mitigation for the trap in
 * helpers/fleet.ts PART 4.
 */
export const FLEET_BASELINE_OCCURRENCE_CAP = 2_000;

/** Runs read live inside the analysis window. */
export const FLEET_RUN_SCAN_CAP = 2_000;

/** `daily_rollups` rows read for baseline run volume. agents x days. */
export const FLEET_ROLLUP_CAP = 2_000;

/** Distinct fingerprints resolved to their `failure_patterns` rollup. */
export const FLEET_PATTERN_LOOKUP_CAP = 300;

/** Distinct agent versions whose `configSnapshot` is read for shared-attribute analysis. */
export const FLEET_DECLARATION_CAP = 250;

/** Default analysis window: the last 24 hours. */
export const FLEET_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FLEET_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Default baseline: the 7 days preceding the analysis window. */
export const FLEET_DEFAULT_BASELINE_DAYS = 7;
export const FLEET_MAX_BASELINE_DAYS = 30;

/** Occurrence rows returned by {@link fleetPatternReach}. */
export const FLEET_PATTERN_REACH_CAP = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD", UTC — the key format `daily_rollups.date` uses. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Bounded reads. Each returns its own truncation flag; none are folded together.
// ---------------------------------------------------------------------------

async function readRoster(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<{ agents: FleetAgentInput[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("agents")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    // One extra row is the truthful truncation signal: if it comes back, the
    // correlation pass did NOT see the whole fleet and the basis is page_local.
    .take(FLEET_ROSTER_CAP + 1);
  return {
    agents: rows.slice(0, FLEET_ROSTER_CAP).map((a) => ({ agentId: a._id, name: a.name })),
    truncated: rows.length > FLEET_ROSTER_CAP,
  };
}

function toOccurrence(doc: Doc<"failure_pattern_occurrences">): FleetOccurrenceInput {
  return {
    occurrenceId: doc._id,
    runId: doc.runId,
    agentId: doc.agentId,
    ...(doc.agentVersionId ? { agentVersionId: doc.agentVersionId } : {}),
    fingerprintHash: doc.fingerprintHash,
    heuristicClass: doc.heuristicClass,
    occurredAt: doc.occurredAt,
  };
}

async function readOccurrences(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  startAt: number,
  endAt: number,
  cap: number,
  inclusiveEnd: boolean,
): Promise<{ occurrences: FleetOccurrenceInput[]; truncated: boolean }> {
  if (endAt <= startAt) return { occurrences: [], truncated: false };
  const rows = await ctx.db
    .query("failure_pattern_occurrences")
    .withIndex("by_org_occurredAt", (q) => {
      const lower = q.eq("orgId", orgId).gte("occurredAt", startAt);
      return inclusiveEnd ? lower.lte("occurredAt", endAt) : lower.lt("occurredAt", endAt);
    })
    .order("desc")
    .take(cap + 1);
  return { occurrences: rows.slice(0, cap).map(toOccurrence), truncated: rows.length > cap };
}

async function readRuns(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  startAt: number,
  endAt: number,
): Promise<{ runs: FleetRunInput[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("runs")
    .withIndex("by_org_started", (q) => q.eq("orgId", orgId).gte("startedAt", startAt).lte("startedAt", endAt))
    .order("desc")
    .take(FLEET_RUN_SCAN_CAP + 1);
  return {
    runs: rows.slice(0, FLEET_RUN_SCAN_CAP).map((r) => ({
      runId: r._id,
      agentId: r.agentId,
      ...(r.agentVersionId ? { agentVersionId: r.agentVersionId } : {}),
      startedAt: r.startedAt,
      status: r.status,
    })),
    truncated: rows.length > FLEET_RUN_SCAN_CAP,
  };
}

/**
 * Baseline run volume from `daily_rollups`.
 *
 * This exists for ONE purpose: to be the positive clause in
 * `isBaselineEstablished`. Without it, "zero failures across the baseline" is
 * vacuous — a fleet switched off last week did not fail last week, and
 * comparing today against an idle period manufactures an anomaly.
 *
 * Day granularity counts the boundary days whole. That OVER-counts run volume
 * at the edges, which is the safe direction for a `> 0` gate: it can only make
 * the engine willing to compare when the fleet demonstrably ran nearby, never
 * willing when it ran nowhere.
 */
async function readBaselineRunVolume(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  startAt: number,
  endAt: number,
): Promise<{ runsObserved: number; truncated: boolean }> {
  if (endAt <= startAt) return { runsObserved: 0, truncated: false };
  const rows = await ctx.db
    .query("daily_rollups")
    .withIndex("by_org_date", (q) => q.eq("orgId", orgId).gte("date", utcDay(startAt)).lte("date", utcDay(endAt)))
    .take(FLEET_ROLLUP_CAP + 1);
  const kept = rows.slice(0, FLEET_ROLLUP_CAP);
  return {
    runsObserved: kept.reduce((sum, r) => sum + r.runsTotal, 0),
    truncated: rows.length > FLEET_ROLLUP_CAP,
  };
}

async function readPatterns(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  hashes: readonly string[],
): Promise<{ patterns: FleetPatternInput[]; truncated: boolean }> {
  const distinct = [...new Set(hashes)].sort();
  const capped = distinct.slice(0, FLEET_PATTERN_LOOKUP_CAP);
  const out: FleetPatternInput[] = [];
  for (const hash of capped) {
    const row = await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_fingerprint", (q) => q.eq("orgId", orgId).eq("fingerprintHash", hash))
      .unique();
    if (row === null) continue;
    out.push({
      fingerprintHash: row.fingerprintHash,
      label: row.label,
      patternClass: row.class,
      muted: row.muted === true,
      status: row.status ?? "open",
      ...(row.lastSpikeAssessment
        ? { isSpiking: row.lastSpikeAssessment.isSpiking, spikeAssessedAt: row.lastSpikeAssessment.assessedAt }
        : {}),
      ...(row.regressedAt !== undefined ? { regressedAt: row.regressedAt } : {}),
      ...(row.lastFixConfidence ? { fixConfidenceState: row.lastFixConfidence.state } : {}),
    });
  }
  return { patterns: out, truncated: distinct.length > FLEET_PATTERN_LOOKUP_CAP };
}

/**
 * The DECLARED configuration behind each agent that ran in the window.
 *
 * From `agent_versions.configSnapshot` — immutable, and what the version
 * actually declared — rather than from `runs.modelsSeen`, which is optional and
 * add-only and where an absent value is indistinguishable from "used no model".
 * A shared-attribute claim built on that absence is a lead someone acts on
 * during an incident, manufactured out of a schema gap.
 *
 * One version per agent: the one its most recent in-window run recorded. Agents
 * with no in-window run contribute no declaration, which is correct — they are
 * `unobserved` and cannot be part of a comparison group either way.
 */
async function readDeclarations(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  runs: readonly FleetRunInput[],
): Promise<{ declarations: FleetAgentDeclarationInput[]; truncated: boolean }> {
  // `runs` is ordered most-recent-first, so the first version seen per agent is
  // the latest one it ran.
  const versionByAgent = new Map<string, Id<"agent_versions">>();
  for (const r of runs) {
    if (r.agentVersionId !== undefined && !versionByAgent.has(r.agentId)) {
      versionByAgent.set(r.agentId, r.agentVersionId as Id<"agent_versions">);
    }
  }
  const entries = [...versionByAgent.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const capped = entries.slice(0, FLEET_DECLARATION_CAP);

  const declarations: FleetAgentDeclarationInput[] = [];
  for (const [agentId, versionId] of capped) {
    const doc = await ctx.db.get(versionId);
    // Defense in depth: the version id came off an org-scoped run row.
    if (doc === null || doc.orgId !== orgId) continue;
    declarations.push({ agentId, agentVersionId: versionId, configSnapshot: doc.configSnapshot });
  }
  return { declarations, truncated: entries.length > FLEET_DECLARATION_CAP };
}

// ---------------------------------------------------------------------------
// THE FLEET QUERY
// ---------------------------------------------------------------------------

/**
 * Fleet roster with health state, cross-agent correlation, and burst detection.
 *
 * Returns a `FleetHealthReport` (packages/contracts/src/fleet_health.ts). Three
 * separate arrays — `correlations` (facts), `hypotheses` (guesses, each naming
 * the correlations it rests on and carrying its denominator), and `unanswered`
 * (questions the scan could not decide). A hypothesis cannot move the verdict:
 * `computeFleetHealthVerdict` has no parameter for one.
 *
 * COVERAGE IS PART OF THE ANSWER. `scan.correlationBasis` says where the
 * correlation pass ran, and `page_local` can never be complete. A truncated
 * baseline removes the "versus normal" sentence entirely rather than weakening
 * it, and says so in `unanswered`.
 */
export const fleetHealth = query({
  args: {
    /** Analysis window start (ms). Defaults to 24h before `until`. */
    since: v.optional(v.number()),
    /** Analysis window end (ms). Defaults to now. */
    until: v.optional(v.number()),
    /** Days of baseline preceding `since`. Defaults to 7. */
    baselineDays: v.optional(v.number()),
    /** Burst window W. Defaults to 1h. ECHOED EXACTLY into `scan.burstWindowMs`. */
    burstWindowMs: v.optional(v.number()),
    /** Minimum DISTINCT agents for a temporal burst. Defaults to 3, floor 2. */
    minDistinctAgents: v.optional(v.number()),
    /**
     * ROSTER LISTING size only. Does NOT bound the correlation pass, which
     * always runs over every assessed agent, and does NOT bound `agentsFailing`.
     * There is deliberately no cursor: raise this rather than paging.
     */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // TENANCY: caller resolved and authorized BEFORE anything is read.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const analyzedAt = Date.now();
    const until = args.until ?? analyzedAt;
    const requestedSince = args.since ?? until - FLEET_DEFAULT_WINDOW_MS;
    if (requestedSince >= until) {
      throw afrError("INVALID_ARGUMENT", "`since` must be strictly before `until`");
    }
    const since = Math.max(requestedSince, until - FLEET_MAX_WINDOW_MS);

    const baselineDays = Math.min(
      Math.max(args.baselineDays ?? FLEET_DEFAULT_BASELINE_DAYS, 0),
      FLEET_MAX_BASELINE_DAYS,
    );
    const baselineStart = since - baselineDays * DAY_MS;

    const burstWindowMs = Math.min(
      Math.max(args.burstWindowMs ?? FLEET_DEFAULT_BURST_WINDOW_MS, FLEET_MIN_BURST_WINDOW_MS),
      FLEET_MAX_BURST_WINDOW_MS,
    );
    const minDistinctAgents = Math.max(args.minDistinctAgents ?? FLEET_MIN_DISTINCT_AGENTS, 2);
    const rosterListingLimit = Math.min(Math.max(args.limit ?? FLEET_ROSTER_CAP, 1), FLEET_ROSTER_CAP);

    const roster = await readRoster(ctx, orgId);
    const analysis = await readOccurrences(ctx, orgId, since, until, FLEET_OCCURRENCE_CAP, true);
    // Separately budgeted. Sharing this budget with the scan above is the trap.
    const baseline = await readOccurrences(ctx, orgId, baselineStart, since, FLEET_BASELINE_OCCURRENCE_CAP, false);
    const baselineVolume = await readBaselineRunVolume(ctx, orgId, baselineStart, since);
    const runs = await readRuns(ctx, orgId, since, until);
    const declarations = await readDeclarations(ctx, orgId, runs.runs);
    const patterns = await readPatterns(ctx, orgId, [
      ...analysis.occurrences.map((o) => o.fingerprintHash),
      ...baseline.occurrences.map((o) => o.fingerprintHash),
    ]);

    const { report } = foldFleetCorrelation({
      analyzedAt,
      agents: roster.agents,
      occurrences: analysis.occurrences,
      baselineOccurrences: baseline.occurrences,
      runs: runs.runs,
      patterns: patterns.patterns,
      declarations: declarations.declarations,
      baseline: {
        baselineWindowStartAt: baselineStart,
        baselineWindowEndAt: since,
        baselineOccurrencesExamined: baseline.occurrences.length,
        baselineScanTruncated: baseline.truncated,
        baselineRunsObserved: baselineVolume.runsObserved,
        baselineRollupTruncated: baselineVolume.truncated,
      },
      burstWindowMs,
      minDistinctAgents,
      since,
      until,
      rosterTruncated: roster.truncated,
      occurrenceScanTruncated: analysis.truncated,
      declarationScanTruncated: declarations.truncated || runs.truncated,
      scanRowCeiling: FLEET_OCCURRENCE_CAP,
      rosterListingLimit,
    });

    // A fingerprint whose rollup was not resolved has no stored spike
    // assessment as far as the engine is concerned. Say so rather than let it
    // read as "not spiking".
    const unanswered = patterns.truncated
      ? [
          ...report.unanswered,
          {
            certainty: "unanswered" as const,
            kind: "engine_limit" as const,
            questionKey: "pattern_lookup_truncated",
            undecidedQuestion: "whether fingerprints beyond the lookup ceiling are spiking or regressed",
            unknownBecause: `more than ${FLEET_PATTERN_LOOKUP_CAP} distinct fingerprints were observed; rollups past the ceiling were not resolved, so their spike and fix-confidence state is unknown rather than negative`,
            remedy: "narrow the window",
          },
        ]
      : report.unanswered;

    return {
      ...report,
      unanswered,
      /**
       * ECHOED BACK DELIBERATELY. `scan.since` / `scan.until` /
       * `scan.burstWindowMs` are the contract's ignored-parameter detection: a
       * deployment that dropped `burstWindowMs` would correlate over its own far
       * wider default and present a day of ordinary background failure as a
       * four-minute incident. The SDK checks the echo exactly and refuses on a
       * mismatch, so this must be the value actually used.
       */
      requestedWindow: { requestedSince, baselineStart, baselineDays },
    };
  },
});

/**
 * Which agents recorded one fingerprint, and when. The drill-down behind a
 * `shared_failure_fingerprint` correlation.
 *
 * `fingerprintHash` is a CONTENT HASH, not an id, resolved only through
 * `by_org_fingerprint` under the caller's own org. A hash from another org and
 * a hash that never existed take the same code path and return the same
 * `{ found: false, agents: [] }`.
 */
export const fleetPatternReach = query({
  args: {
    fingerprintHash: v.string(),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const analyzedAt = Date.now();
    const until = args.until ?? analyzedAt;
    const since = args.since ?? until - FLEET_DEFAULT_WINDOW_MS;
    if (since >= until) throw afrError("INVALID_ARGUMENT", "`since` must be strictly before `until`");

    const rollup = await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_fingerprint", (q) => q.eq("orgId", orgId).eq("fingerprintHash", args.fingerprintHash))
      .unique();

    const rows = await ctx.db
      .query("failure_pattern_occurrences")
      .withIndex("by_org_fingerprint", (q) => q.eq("orgId", orgId).eq("fingerprintHash", args.fingerprintHash))
      .order("desc")
      .take(FLEET_PATTERN_REACH_CAP + 1);

    const truncated = rows.length > FLEET_PATTERN_REACH_CAP;
    const inWindow = rows
      .slice(0, FLEET_PATTERN_REACH_CAP)
      .filter((r) => r.occurredAt >= since && r.occurredAt <= until);

    const byAgent = new Map<string, { agentId: Id<"agents">; occurrences: number; firstAt: number; lastAt: number }>();
    for (const r of inWindow) {
      const cur = byAgent.get(r.agentId);
      if (cur === undefined) {
        byAgent.set(r.agentId, { agentId: r.agentId, occurrences: 1, firstAt: r.occurredAt, lastAt: r.occurredAt });
      } else {
        cur.occurrences += 1;
        cur.firstAt = Math.min(cur.firstAt, r.occurredAt);
        cur.lastAt = Math.max(cur.lastAt, r.occurredAt);
      }
    }

    const agents = [...byAgent.values()].sort((a, b) => a.firstAt - b.firstAt || (a.agentId < b.agentId ? -1 : 1));
    const named = await Promise.all(
      agents.map(async (a) => {
        const doc = await ctx.db.get(a.agentId);
        return { ...a, name: doc && doc.orgId === orgId ? doc.name : null };
      }),
    );

    return {
      analyzedAt,
      fingerprintHash: args.fingerprintHash,
      /** `false` for another org's hash AND for one that never existed. Same value, same path. */
      found: rollup !== null,
      label: rollup?.label ?? null,
      status: rollup?.status ?? null,
      muted: rollup?.muted === true,
      spiking: rollup?.lastSpikeAssessment?.isSpiking ?? null,
      spikeAssessedAt: rollup?.lastSpikeAssessment?.assessedAt ?? null,
      fixConfidenceState: rollup?.lastFixConfidence?.state ?? null,
      agents: named,
      distinctAgentCount: named.length,
      window: { since, until },
      /**
       * Read most-recent-first and capped. When true, OLDER occurrences — and
       * therefore possibly MORE agents — were not read, so `distinctAgentCount`
       * is a LOWER BOUND and an agent's absence from this list means nothing.
       */
      truncated,
    };
  },
});
