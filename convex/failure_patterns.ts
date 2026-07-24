// Failure Patterns (PREVENTION, cycle 1 + cycle 2) — a durable, org-scoped
// memory of recurring failure fingerprints derived from failed runs. See
// docs/adr/005-failure-patterns.md for the full design rationale.
//
// CYCLE 2 (deepen): closes the two gaps cycle 1 left open. (1) The 14-day
// trend is now read from the ACCURATE `failure_pattern_daily_counts` table
// (an exact per-day counter, incremented alongside every occurrence) instead
// of bucketing a bounded, most-recent-first occurrence sample — see that
// table's schema doc comment and `readAccurateTrend` below. (2)
// `assessPatternSpikesCron` now actually FIRES a `pattern_spike` alert (via
// `convex/alerts.ts`'s `firePatternSpikeAlert`) the moment a pattern
// transitions from not-spiking to spiking, gated by
// `assessPatternSpikeTransition` (Team B interface, guarded dynamic lookup +
// local fallback, same discipline as `assessPatternSpike`) plus a per-pattern
// cooldown (`lastPatternSpikeAlertFiredAt`) so a pattern hovering at the
// threshold cannot fire every 15-minute tick.
//
// OBSERVABILITY-GRADE DERIVED DATA, NEVER SOURCE OF TRUTH (mirrors ADR-002's
// constraint language for daily_rollups/usage_counters): a `failure_patterns`
// rollup and its `failure_pattern_occurrences` are computed FROM the run's own
// event log + `run_explanations` classification, they never replace either.
// Deleting/regenerating every row in both tables would only mean "we forget
// which failures recurred," never "the underlying facts about what happened
// on any run changed."
//
// APPEND-ONLY OCCURRENCES: `failure_pattern_occurrences` follows the same
// discipline as `events`/`evals`/`audit_log` — insert-only, no update/delete
// mutation exists for it. `failure_patterns` (the rollup) is NOT append-only —
// same category as `daily_rollups`/`run_explanations`: a generated aggregate,
// upserted (patch-in-place on the count/lastSeenAt/representative-sample
// fields) as new occurrences land.
//
// FILE OWNERSHIP: this file (+ failure_patterns.test.ts, the two new tables in
// schema.ts, the contracts in packages/contracts/src/failure_patterns.ts, and
// the one cron entry in crons.ts) is Team A's Cycle 1 "Failure Patterns"
// surface. convex/insights.ts (Team B) is expected to eventually export real
// `deriveFailureFingerprint`/`assessPatternSpike` implementations — this file
// calls them via a guarded dynamic lookup (same pattern
// convex/run_explanations.ts uses for `buildHeuristicExplanation`) and falls
// back to a thin local implementation with the SAME signature when they are
// not yet present, so this file typechecks and ships independently of
// exactly when Team B's exports land. See the "Team B coordination" section
// below for the agreed interface.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { recordAuditEvent } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import * as insightsModule from "./insights.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

// ---------------------------------------------------------------------------
// Write ceilings (local to this file — see the module doc comment for why
// these aren't added to helpers/pagination.ts this cycle: keeping this
// feature's constants self-contained avoids touching a file every other
// Convex module also edits).
// ---------------------------------------------------------------------------

/** failure_patterns.representativeRunIds cap. */
export const MAX_REPRESENTATIVE_RUN_IDS = 5;
/** failure_patterns.affectedAgentVersionIds cap. */
export const MAX_AFFECTED_AGENT_VERSION_IDS = 20;
/** Default / max rows returned by listFailurePatterns. */
export const DEFAULT_FAILURE_PATTERN_PAGE_SIZE = 50;
export const MAX_FAILURE_PATTERN_PAGE_SIZE = 200;
/** Bounded sample of an individual pattern's recent occurrences (getFailurePattern). */
export const MAX_RECENT_OCCURRENCES = 50;
/** Trend window length, in UTC calendar days (inclusive of today). */
export const TREND_WINDOW_DAYS = 14;
/** Bounded number of patterns the spike-rollup cron assesses per invocation. */
export const SPIKE_ROLLUP_MAX_PATTERNS_PER_RUN = 200;
/**
 * Anti-flap cooldown (cycle 2 pattern-spike alerting): the minimum time that
 * must elapse since a pattern's LAST fired pattern_spike alert before another
 * spike-transition for the SAME pattern is allowed to fire again. Without
 * this, a fingerprint whose count hovers right at the spike threshold could
 * flip isSpiking false/true across consecutive 15-minute cron ticks and fire
 * an alert every single tick. 6 hours is long enough to absorb that kind of
 * threshold jitter while still re-arming well within the same day if the
 * pattern genuinely regresses again.
 */
export const DEFAULT_PATTERN_SPIKE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Team B coordination — deriveFailureFingerprint / assessPatternSpike
// ---------------------------------------------------------------------------

/**
 * AGREED SIGNATURE (coordination with Team B, `convex/insights.ts`):
 *
 *   deriveFailureFingerprint(input: DeriveFailureFingerprintInput) => DerivedFailureFingerprint
 *   assessPatternSpike(trend: {day:string,count:number}[], opts?) => PatternSpikeAssessment
 *
 * Both PURE, never throw. This file does not call either via a static value
 * import — only via the guarded dynamic lookups below — so it keeps
 * typechecking and shipping regardless of exactly when/whether Team B's
 * exports land; today they are NOT present, so the thin local fallbacks
 * (below) are what actually runs. TODO(Team B): once
 * `deriveFailureFingerprint`/`assessPatternSpike` land in insights.ts with
 * this signature, this file picks them up with zero code change.
 */
export interface DeriveFailureFingerprintInput {
  heuristicClass: string;
  failingToolName?: string;
  terminalEventType?: string;
  errorSignature?: string;
}

export interface DerivedFailureFingerprint {
  hash: string;
  class: string;
  label: string;
  salientKey: string;
}

export interface PatternTrendPoint {
  day: string;
  count: number;
}

export interface PatternSpikeAssessment {
  isSpiking: boolean;
  recentCount: number;
  baselineMean: number;
  z: number;
}

type DeriveFailureFingerprintFn = (input: DeriveFailureFingerprintInput) => DerivedFailureFingerprint;
type AssessPatternSpikeFn = (
  trend: PatternTrendPoint[],
  opts?: { recentDays?: number; zThreshold?: number },
) => PatternSpikeAssessment;

function getDeriveFailureFingerprint(): DeriveFailureFingerprintFn {
  const candidate = (insightsModule as unknown as Record<string, unknown>)["deriveFailureFingerprint"];
  return typeof candidate === "function"
    ? (candidate as DeriveFailureFingerprintFn)
    : deriveFailureFingerprintFallback;
}

function getAssessPatternSpike(): AssessPatternSpikeFn {
  const candidate = (insightsModule as unknown as Record<string, unknown>)["assessPatternSpike"];
  return typeof candidate === "function" ? (candidate as AssessPatternSpikeFn) : assessPatternSpikeFallback;
}

/**
 * djb2 — a small, fast, dependency-free string hash. NOT cryptographic (no
 * `crypto` import here on purpose: this runs inside a Convex mutation, not an
 * action, so Node's `crypto` module is unavailable without a `"use node"`
 * action boundary this feature doesn't need). A fingerprint hash only needs
 * to be a stable, collision-resistant-enough grouping key for "same
 * heuristicClass + same salient signal" — not a security property — so a
 * non-cryptographic hash is the right, simple tool here.
 */
function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Strip digits/quoted-values/whitespace runs so two errors that differ only by an id/timestamp/path collapse to the same signature. Never throws. */
function normalizeErrorSignature(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const normalized = raw
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/["'`][^"'`]{0,200}["'`]/g, "<str>")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized.slice(0, 200) : undefined;
}

function titleCaseWords(s: string): string {
  return s
    .split(/[_\-\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * FALLBACK ONLY — see the "Team B coordination" doc comment above. A
 * deterministic, pure fingerprint derivation: the salient key is whichever of
 * failingToolName / terminalEventType / a normalized errorSignature is
 * present, in that priority order (a specific tool name is the most useful
 * discriminator; a normalized error message is the least specific but still
 * better than nothing). The hash groups occurrences that share the same
 * (heuristicClass, salientKey) pair.
 */
export function deriveFailureFingerprintFallback(
  input: DeriveFailureFingerprintInput,
): DerivedFailureFingerprint {
  const heuristicClass = typeof input?.heuristicClass === "string" && input.heuristicClass.length > 0
    ? input.heuristicClass
    : "unknown";
  const salientKey =
    (typeof input?.failingToolName === "string" && input.failingToolName.trim().length > 0
      ? input.failingToolName.trim()
      : undefined) ??
    (typeof input?.terminalEventType === "string" && input.terminalEventType.trim().length > 0
      ? input.terminalEventType.trim()
      : undefined) ??
    normalizeErrorSignature(input?.errorSignature) ??
    "unspecified";

  const hash = djb2Hex(`${heuristicClass}::${salientKey}`);
  const label = `${titleCaseWords(heuristicClass)}: ${salientKey}`.slice(0, 200);

  return { hash, class: heuristicClass, label, salientKey };
}

/**
 * FALLBACK ONLY — see the "Team B coordination" doc comment above. Simple
 * z-score spike detector: compares the most recent day's count against the
 * mean/stddev of the preceding `trend.length - 1` days (the "baseline").
 * Never throws; returns a non-spiking, zero-z assessment for a trend with
 * fewer than 2 points (nothing to compare against) or a zero-variance
 * baseline (a z-score is undefined/infinite there — treated conservatively as
 * "not spiking" rather than reporting Infinity).
 */
export function assessPatternSpikeFallback(
  trend: PatternTrendPoint[],
  opts?: { recentDays?: number; zThreshold?: number },
): PatternSpikeAssessment {
  const zThreshold = opts?.zThreshold ?? 2;
  const sorted = Array.isArray(trend) ? [...trend].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)) : [];

  if (sorted.length < 2) {
    const recentCount = sorted.length === 1 ? sorted[0]!.count : 0;
    return { isSpiking: false, recentCount, baselineMean: 0, z: 0 };
  }

  const recent = sorted[sorted.length - 1]!;
  const baseline = sorted.slice(0, sorted.length - 1);
  const baselineMean = baseline.reduce((sum, p) => sum + p.count, 0) / baseline.length;
  const variance = baseline.reduce((sum, p) => sum + (p.count - baselineMean) ** 2, 0) / baseline.length;
  const stddev = Math.sqrt(variance);

  if (stddev === 0) {
    // No variance in the baseline: only call it a spike if the recent count
    // is strictly greater than a flat, non-zero baseline (otherwise a
    // constant-zero history would report a spike the first time a single
    // occurrence lands, which is noise, not a signal).
    const isSpiking = baselineMean > 0 && recent.count > baselineMean;
    return { isSpiking, recentCount: recent.count, baselineMean, z: isSpiking ? Infinity : 0 };
  }

  const z = (recent.count - baselineMean) / stddev;
  return { isSpiking: z >= zThreshold, recentCount: recent.count, baselineMean, z };
}

// ---------------------------------------------------------------------------
// Team B coordination — assessPatternSpikeTransition (cycle 2). Same guarded
// dynamic-lookup + local-fallback discipline as deriveFailureFingerprint /
// assessPatternSpike above.
// ---------------------------------------------------------------------------

/**
 * AGREED SIGNATURE (coordination with Team B, `convex/insights.ts`, cycle 2):
 *
 *   assessPatternSpikeTransition(
 *     prev: SpikeAssessmentLike | undefined,
 *     curr: SpikeAssessmentLike,
 *     opts?: { cooldownMs?: number; nowMs: number; lastFiredAt?: number },
 *   ) => { shouldFire: boolean; reason: string }
 *
 * PURE, never throws. Decides whether a freshly-computed spike assessment
 * (`curr`) represents a NEW spike episode worth alerting on, given the
 * PREVIOUSLY stored assessment (`prev`) and this pattern's own
 * anti-flap/cooldown state (`opts.lastFiredAt`) — i.e. hysteresis across
 * `assessPatternSpikesCron`'s 15-minute ticks, not a stateless per-tick
 * decision. As of this cycle Team B has not yet landed this export in
 * insights.ts (only `deriveFailureFingerprint`/`assessPatternSpike` are
 * Team-B-coordination interfaces from cycle 1) — `getAssessPatternSpikeTransition`
 * below falls back to `assessPatternSpikeTransitionFallback` and picks up
 * Team B's real implementation with zero code change the moment it lands.
 */
export interface SpikeAssessmentLike {
  isSpiking: boolean;
  recentCount: number;
  baselineMean: number;
  z: number;
}

export interface SpikeTransitionResult {
  shouldFire: boolean;
  reason: string;
}

export interface SpikeTransitionOptions {
  cooldownMs?: number;
  nowMs: number;
  lastFiredAt?: number;
}

type AssessPatternSpikeTransitionFn = (
  prev: SpikeAssessmentLike | undefined,
  curr: SpikeAssessmentLike,
  opts?: SpikeTransitionOptions,
) => SpikeTransitionResult;

function getAssessPatternSpikeTransition(): AssessPatternSpikeTransitionFn {
  const candidate = (insightsModule as unknown as Record<string, unknown>)["assessPatternSpikeTransition"];
  return typeof candidate === "function"
    ? (candidate as AssessPatternSpikeTransitionFn)
    : assessPatternSpikeTransitionFallback;
}

/**
 * FALLBACK ONLY — see the doc comment above. Fires only on a genuine
 * false/undefined -> true transition (never while already spiking, i.e. no
 * re-fire on every tick a pattern remains above threshold), and only if the
 * cooldown since the last fire (if any) has elapsed — so a pattern
 * oscillating right at the spike threshold across ticks cannot fire more
 * than once per `cooldownMs` window. A pattern that stops spiking and later
 * spikes again re-arms naturally: `wasSpiking` is computed fresh from `prev`
 * on every call, and once `curr.isSpiking` goes false the NEXT true reading
 * is again a false -> true transition, gated only by the cooldown (which by
 * then has typically long since elapsed).
 */
export function assessPatternSpikeTransitionFallback(
  prev: SpikeAssessmentLike | undefined,
  curr: SpikeAssessmentLike,
  opts?: SpikeTransitionOptions,
): SpikeTransitionResult {
  if (!curr || !curr.isSpiking) {
    return { shouldFire: false, reason: "not_spiking" };
  }

  const wasSpiking = prev?.isSpiking === true;
  if (wasSpiking) {
    return { shouldFire: false, reason: "already_spiking" };
  }

  const cooldownMs = opts?.cooldownMs ?? DEFAULT_PATTERN_SPIKE_ALERT_COOLDOWN_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  if (opts?.lastFiredAt !== undefined && nowMs - opts.lastFiredAt < cooldownMs) {
    return { shouldFire: false, reason: "cooldown_active" };
  }

  return { shouldFire: true, reason: "spike_transition_entry" };
}

// ---------------------------------------------------------------------------
// recordFailurePatternOccurrence — the only write path for occurrences, and
// the upsert path for the rollup.
// ---------------------------------------------------------------------------

function dedupCapMostRecentFirst<T>(existing: T[], incoming: T, cap: number): T[] {
  const rest = existing.filter((x) => x !== incoming);
  return [incoming, ...rest].slice(0, cap);
}

/**
 * Idempotent per `runId`: if an occurrence already exists for this run (any
 * fingerprint — a run fails once and gets exactly one recorded fingerprint),
 * this is a no-op. Safe against more than one terminal-transition path
 * scheduling this for the same run, and against a scheduler retry.
 *
 * Org-scoped: `orgId` is taken from the caller (expected to be the run's own
 * `orgId`, resolved by the scheduling site — see run_explanations.ts), never
 * re-derived here from anything client-controllable.
 */
export const recordFailurePatternOccurrence = internalMutation({
  args: {
    orgId: v.id("organizations"),
    runId: v.id("runs"),
    agentId: v.id("agents"),
    agentVersionId: v.optional(v.id("agent_versions")),
    fingerprintHash: v.string(),
    class: v.string(),
    label: v.string(),
    salientKey: v.string(),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("failure_pattern_occurrences")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .first();
    if (existing) {
      return { recorded: false as const, reason: "already_recorded" as const };
    }

    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== args.orgId) {
      // Defensive: the scheduling site (run_explanations.ts) already
      // resolved orgId from this exact run — this only fires if the run was
      // purged (ADR-001) between scheduling and execution.
      return { recorded: false as const, reason: "run_not_found" as const };
    }

    const occurredAt = args.occurredAt ?? Date.now();

    await ctx.db.insert("failure_pattern_occurrences", {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      runId: args.runId,
      agentId: args.agentId,
      agentVersionId: args.agentVersionId,
      occurredAt,
      heuristicClass: args.class,
      salientKey: args.salientKey,
    });

    await upsertRollup(ctx, {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      class: args.class,
      label: args.label,
      salientKey: args.salientKey,
      runId: args.runId,
      agentVersionId: args.agentVersionId,
      occurredAt,
    });

    await incrementDailyCount(ctx, {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      day: dayKeyOf(occurredAt),
    });

    return { recorded: true as const };
  },
});

/**
 * Upsert-increment the ACCURATE per-(org,fingerprint,day) counter (cycle 2 —
 * see failure_pattern_daily_counts' schema doc comment for why this replaces
 * the old bounded-occurrence-sample trend). Called exactly once per new
 * occurrence recorded (never on the idempotent no-op path above), so a day's
 * count here is always exactly the number of occurrences recorded on that
 * UTC calendar day — never a sample, never truncated.
 */
async function incrementDailyCount(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; fingerprintHash: string; day: string },
): Promise<void> {
  const existing = await ctx.db
    .query("failure_pattern_daily_counts")
    .withIndex("by_org_fingerprint_day", (q) =>
      q.eq("orgId", args.orgId).eq("fingerprintHash", args.fingerprintHash).eq("day", args.day),
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, { count: existing.count + 1 });
  } else {
    await ctx.db.insert("failure_pattern_daily_counts", {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      day: args.day,
      count: 1,
    });
  }
}

async function upsertRollup(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    fingerprintHash: string;
    class: string;
    label: string;
    salientKey: string;
    runId: Id<"runs">;
    agentVersionId: Id<"agent_versions"> | undefined;
    occurredAt: number;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("failure_patterns")
    .withIndex("by_org_fingerprint", (q) => q.eq("orgId", args.orgId).eq("fingerprintHash", args.fingerprintHash))
    .first();

  if (!existing) {
    await ctx.db.insert("failure_patterns", {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      class: args.class,
      label: args.label,
      salientKey: args.salientKey,
      count: 1,
      firstSeenAt: args.occurredAt,
      lastSeenAt: args.occurredAt,
      representativeRunIds: [args.runId],
      affectedAgentVersionIds: args.agentVersionId ? [args.agentVersionId] : [],
    });
    return;
  }

  const representativeRunIds = dedupCapMostRecentFirst(
    existing.representativeRunIds,
    args.runId,
    MAX_REPRESENTATIVE_RUN_IDS,
  );
  const affectedAgentVersionIds = args.agentVersionId
    ? dedupCapMostRecentFirst(existing.affectedAgentVersionIds, args.agentVersionId, MAX_AFFECTED_AGENT_VERSION_IDS)
    : existing.affectedAgentVersionIds;

  await ctx.db.patch(existing._id, {
    count: existing.count + 1,
    // label/class/salientKey may drift slightly between occurrences of the
    // "same" fingerprint hash in principle (e.g. a fallback fingerprinter
    // upgraded mid-flight) — always reflect the MOST RECENT classification,
    // same "latest wins" discipline as lastSeenAt.
    class: args.class,
    label: args.label,
    salientKey: args.salientKey,
    lastSeenAt: Math.max(existing.lastSeenAt, args.occurredAt),
    representativeRunIds,
    affectedAgentVersionIds,
  });
}

// ---------------------------------------------------------------------------
// Queries — member-gated, org-scoped.
// ---------------------------------------------------------------------------

export const listFailurePatterns = query({
  args: { orgId: v.id("organizations"), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<"failure_patterns">[]> => {
    await requireOrgMembership(ctx, args.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_FAILURE_PATTERN_PAGE_SIZE, MAX_FAILURE_PATTERN_PAGE_SIZE);
    return await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_lastSeenAt", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(limit);
  },
});

/** "YYYY-MM-DD" for UTC calendar day `n` days before `now`. n=0 is today. Duplicated (not imported) from insights.ts's dateNDaysAgoUtc per this repo's cross-team-file convention (see insights.ts's own header note on why it duplicates rollups.ts's date helpers). */
function dateNDaysAgoUtc(n: number, now: number = Date.now()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function dayKeyOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export interface FailurePatternDetailResult {
  pattern: Doc<"failure_patterns">;
  recentOccurrences: Doc<"failure_pattern_occurrences">[];
  trend: PatternTrendPoint[];
}

export const getFailurePattern = query({
  args: { orgId: v.id("organizations"), fingerprintHash: v.string() },
  handler: async (ctx, args): Promise<FailurePatternDetailResult | null> => {
    await requireOrgMembership(ctx, args.orgId);

    const pattern = await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_fingerprint", (q) => q.eq("orgId", args.orgId).eq("fingerprintHash", args.fingerprintHash))
      .first();
    if (!pattern) return null;

    // Recent-occurrences sample: a bounded, most-recent-first read, unrelated
    // to trend accuracy (see readAccurateTrend below) — this is just "show me
    // the last N raw occurrences," not an input to any aggregate count.
    const recentOccurrences = await ctx.db
      .query("failure_pattern_occurrences")
      .withIndex("by_org_fingerprint", (q) => q.eq("orgId", args.orgId).eq("fingerprintHash", args.fingerprintHash))
      .order("desc")
      .take(MAX_RECENT_OCCURRENCES);

    const trend = await readAccurateTrend(ctx, args.orgId, args.fingerprintHash);

    return { pattern, recentOccurrences, trend };
  },
});

/**
 * ACCURATE 14-day daily trend (cycle 2), read directly from
 * `failure_pattern_daily_counts` — an exact per-day counter incremented by
 * `incrementDailyCount` on every occurrence, not a bucketed bounded sample.
 * The index range (orgId, fingerprintHash, day-in-[start,end]) can return at
 * most `TREND_WINDOW_DAYS` (14) rows no matter how many total occurrences the
 * fingerprint has ever recorded, so this is both MORE ACCURATE and CHEAPER
 * than the old approach (which read up to 2,000 occurrence rows per call and
 * still silently undercounted anything past that sample's horizon).
 */
async function readAccurateTrend(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  fingerprintHash: string,
  now: number = Date.now(),
): Promise<PatternTrendPoint[]> {
  const startDay = dateNDaysAgoUtc(TREND_WINDOW_DAYS - 1, now);
  const endDay = dateNDaysAgoUtc(0, now);

  const rows = await ctx.db
    .query("failure_pattern_daily_counts")
    .withIndex("by_org_fingerprint_day", (q) =>
      q.eq("orgId", orgId).eq("fingerprintHash", fingerprintHash).gte("day", startDay).lte("day", endDay),
    )
    .collect();

  const countsByDay = new Map(rows.map((r) => [r.day, r.count]));
  const days: string[] = [];
  for (let i = TREND_WINDOW_DAYS - 1; i >= 0; i--) days.push(dateNDaysAgoUtc(i, now));
  return days.map((day) => ({ day, count: countsByDay.get(day) ?? 0 }));
}

/**
 * LEGACY / TEST-ONLY: buckets a caller-supplied occurrence sample into the
 * trailing TREND_WINDOW_DAYS UTC daily counts, oldest first. This is the
 * cycle-1 approach and is NO LONGER used by getFailurePattern or
 * assessPatternSpikesCron (both now use `readAccurateTrend`, backed by the
 * exact `failure_pattern_daily_counts` counters — see that table's schema
 * doc comment for why the bounded-sample approach undercounted high-volume
 * fingerprints past the sample horizon). Kept exported and covered by
 * existing tests as a pure, still-correct bucketing utility — useful for
 * anything that only has a raw occurrence list in hand (e.g. an ad hoc
 * script) and not the daily-counts table.
 */
export function buildTrendFromOccurrences(
  occurrences: Array<{ occurredAt: number }>,
  now: number = Date.now(),
): PatternTrendPoint[] {
  const days: string[] = [];
  for (let i = TREND_WINDOW_DAYS - 1; i >= 0; i--) days.push(dateNDaysAgoUtc(i, now));
  const counts = new Map<string, number>(days.map((d) => [d, 0]));

  for (const occ of occurrences) {
    const day = dayKeyOf(occ.occurredAt);
    if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  return days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Mute / unmute — Cycle 3 (docs/adr/005-failure-patterns.md "Cycle 3").
// ADMIN-gated (same tier as alert-rule mutations — muting suppresses
// org-wide alerting for this fingerprint) and AUDITED. Muting does NOT touch
// failure_pattern_occurrences (append-only, untouched) or stop
// recordFailurePatternOccurrence / assessPatternSpikesCron's own assessment
// bookkeeping — it only suppresses the one thing assessPatternSpikesCron does
// on a spike transition: calling alerts.ts's firePatternSpikeAlert. See that
// cron's doc comment below for the exact suppression point.
// ---------------------------------------------------------------------------

async function findRollup(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  fingerprintHash: string,
): Promise<Doc<"failure_patterns"> | null> {
  return await ctx.db
    .query("failure_patterns")
    .withIndex("by_org_fingerprint", (q) => q.eq("orgId", orgId).eq("fingerprintHash", fingerprintHash))
    .first();
}

/**
 * Mute a fingerprint: `assessPatternSpikesCron` will still compute and store
 * `lastSpikeAssessment` for this pattern on every tick (observability is
 * unaffected), but will never call `firePatternSpikeAlert` for it while
 * `muted` is true — no `alert_events` row, no webhook/email delivery.
 *
 * Returns the updated rollup doc, or `null` when `fingerprintHash` does not
 * exist IN THIS ORG. Deliberately a null return, not a thrown error — same
 * posture as `getFailurePattern` above: "never existed" and "belongs to a
 * different org" must be indistinguishable (both are just "not found for
 * this org"), so a caller-facing layer (apps/web's mute route) can collapse
 * both into one generic 404 without this mutation itself leaking which case
 * it was.
 *
 * Contract for other teams (Team C's mute route/service, Team E's mute UI,
 * Team D's CLI):
 *   `failure_patterns:mutePattern({ orgId, fingerprintHash }) => Doc<"failure_patterns"> | null`
 * (the full updated rollup — `muted`/`mutedAt` are on it, alongside every
 * other rollup field already exposed by listFailurePatterns/getFailurePattern).
 */
export const mutePattern = mutation({
  args: { orgId: v.id("organizations"), fingerprintHash: v.string() },
  handler: async (ctx, args): Promise<Doc<"failure_patterns"> | null> => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });

    const pattern = await findRollup(ctx, args.orgId, args.fingerprintHash);
    if (!pattern) return null;

    const mutedAt = Date.now();
    await ctx.db.patch(pattern._id, { muted: true, mutedAt });

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "failure_pattern.muted",
      targetType: "failure_pattern",
      targetId: args.fingerprintHash,
      metadata: { fingerprintHash: args.fingerprintHash, class: pattern.class, label: pattern.label },
    });

    return await ctx.db.get(pattern._id);
  },
});

/**
 * Unmute a fingerprint: re-enables `assessPatternSpikesCron` firing for
 * future spike transitions. `mutedAt` is intentionally left untouched — it
 * is a "last muted at" historical marker, not a "currently muted since"
 * field; `muted: false` alone is the live suppression flag.
 *
 * Same null-on-not-found / contract shape as mutePattern:
 *   `failure_patterns:unmutePattern({ orgId, fingerprintHash }) => Doc<"failure_patterns"> | null`
 */
export const unmutePattern = mutation({
  args: { orgId: v.id("organizations"), fingerprintHash: v.string() },
  handler: async (ctx, args): Promise<Doc<"failure_patterns"> | null> => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });

    const pattern = await findRollup(ctx, args.orgId, args.fingerprintHash);
    if (!pattern) return null;

    await ctx.db.patch(pattern._id, { muted: false });

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "failure_pattern.unmuted",
      targetType: "failure_pattern",
      targetId: args.fingerprintHash,
      metadata: { fingerprintHash: args.fingerprintHash, class: pattern.class, label: pattern.label },
    });

    return await ctx.db.get(pattern._id);
  },
});

// ---------------------------------------------------------------------------
// Spike-rollup cron — internalMutation, scheduled from convex/crons.ts.
// ---------------------------------------------------------------------------

/**
 * Internal read used only by the cron below, kept as a separate internalQuery
 * so the cron's own internalMutation body stays a simple read-then-patch loop
 * (mirrors the split already used by rollups.ts's computeDailyRollups).
 */
export const _listActivePatternsForSpikeAssessment = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"failure_patterns">[]> => {
    // Cross-org scan, same shape as stale_runs.ts / webhook_engine.ts's
    // bounded cross-org sweeps: this cron has no single org to scope to.
    // `by_org_lastSeenAt` is a compound [orgId, lastSeenAt] index, so it
    // cannot give a true cross-org "most recently active first" ordering
    // (Convex orders strictly by the index's field order) — this is a
    // bounded, unordered-across-orgs scan, same documented tradeoff as
    // ROLLUP_MAX_ORGS_PER_SWEEP. A pattern not reached in one tick is picked
    // up on a later one; the cron runs on an interval, not a one-shot sweep.
    return await ctx.db.query("failure_patterns").take(SPIKE_ROLLUP_MAX_PATTERNS_PER_RUN);
  },
});

/**
 * Periodic spike-rollup + alerting (cycle 2): for each of the most recently
 * active patterns (bounded — see SPIKE_ROLLUP_MAX_PATTERNS_PER_RUN),
 * recompute its ACCURATE 14-day daily trend (`readAccurateTrend`, backed by
 * `failure_pattern_daily_counts` — no longer a bounded occurrence sample) and
 * call Team B's `assessPatternSpike` (or the local fallback), storing the
 * result on `lastSpikeAssessment`.
 *
 * ALERT-FIRING (cycle 2 — closes the gap cycle 1 left open): compares the
 * FRESH assessment against the PREVIOUSLY stored one via
 * `assessPatternSpikeTransition` (or its local fallback), passing this
 * pattern's own `lastPatternSpikeAlertFiredAt` as the cooldown input. Only a
 * genuine not-spiking -> spiking transition, outside the cooldown window,
 * calls `convex/alerts.ts`'s `firePatternSpikeAlert` — which itself only
 * fires for orgs with at least one ENABLED `pattern_spike` alert_rule (an org
 * with no such rule gets its assessment stored, same as cycle 1, but no
 * alert_events row, exactly mirroring how every other alert kind is a no-op
 * when no matching enabled rule exists).
 *
 * AUDIT FIX (cycle 3): `lastPatternSpikeAlertFiredAt` (the cooldown clock) is
 * advanced ONLY when a fire was both attempted AND actually reached at least
 * one enabled rule (`firePatternSpikeAlert`'s own `{ fired }` count > 0) —
 * NOT merely when the pure transition said `shouldFire: true`. The previous
 * (cycle 2) behavior advanced the cooldown on every attempted fire
 * regardless of whether any rule existed to receive it, which meant an org
 * that spiked before configuring any `pattern_spike` rule would silently
 * start its cooldown timer — so the first rule an admin added later could
 * miss that still-ongoing spike for up to a full cooldown window. Now the
 * cooldown means exactly what it says: "an alert was actually fired this
 * recently." A muted pattern (cycle 3 — see mutePattern/unmutePattern above)
 * is treated the same way: the fire is skipped entirely (not attempted), so
 * the cooldown clock does not advance either — this is also what lets
 * unmuting, followed by a later genuine rising edge, fire again.
 */
export const assessPatternSpikesCron = internalMutation({
  // `now` is optional/injectable (default Date.now()) — same de-flake pattern
  // as convex/webhook_engine.ts's deliverPendingWebhooks — so tests can pin a
  // single wall-clock reading per invocation and assert cooldown/transition
  // behavior deterministically instead of racing the real clock.
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ assessed: number; spiking: number; fired: number }> => {
    const patterns = await ctx.runQuery(_listActivePatternsForSpikeAssessmentRef, {});
    const assessSpike = getAssessPatternSpike();
    const assessTransition = getAssessPatternSpikeTransition();
    const now = args.now ?? Date.now();
    let spiking = 0;
    let fired = 0;

    for (const pattern of patterns) {
      const trend = await readAccurateTrend(ctx, pattern.orgId, pattern.fingerprintHash, now);
      const assessment = assessSpike(trend);

      const transition = assessTransition(pattern.lastSpikeAssessment, assessment, {
        nowMs: now,
        lastFiredAt: pattern.lastPatternSpikeAlertFiredAt,
        cooldownMs: DEFAULT_PATTERN_SPIKE_ALERT_COOLDOWN_MS,
      });

      // MUTE SUPPRESSION (cycle 3, docs/adr/005-failure-patterns.md "Cycle
      // 3"): a muted pattern's spike assessment is still computed and stored
      // below exactly as normal — muting never affects OBSERVABILITY. Muting
      // suppresses exactly one thing: calling firePatternSpikeAlert on a
      // rising-edge transition. `firedForThisPattern` (not merely
      // `transition.shouldFire`) also gates whether the cooldown timestamp
      // advances — see the patch below.
      let firedForThisPattern = 0;
      if (transition.shouldFire && !pattern.muted) {
        const result = await ctx.runMutation(_firePatternSpikeAlertRef, {
          orgId: pattern.orgId,
          fingerprintHash: pattern.fingerprintHash,
          class: pattern.class,
          label: pattern.label,
          recentCount: assessment.recentCount,
          representativeRunId: pattern.representativeRunIds[0],
        });
        firedForThisPattern = result.fired;
        fired += result.fired;
      }

      await ctx.db.patch(pattern._id, {
        lastSpikeAssessment: {
          assessedAt: now,
          isSpiking: assessment.isSpiking,
          recentCount: assessment.recentCount,
          baselineMean: assessment.baselineMean,
          z: Number.isFinite(assessment.z) ? assessment.z : Number.MAX_SAFE_INTEGER,
        },
        // AUDIT FIX (cycle 3): only advance the cooldown clock when a fire
        // was genuinely ATTEMPTED AGAINST AT LEAST ONE ENABLED, UNMUTED RULE
        // (firedForThisPattern > 0) — not merely when the pure transition
        // said shouldFire. Previously this advanced on every
        // transition.shouldFire, even when the org had zero enabled
        // pattern_spike rules: an org that spikes before any rule is
        // configured would silently start its cooldown timer, so the FIRST
        // rule an admin adds later could miss the pattern's next rising edge
        // for up to a full cooldown window. The cooldown now only means what
        // it says: "a real alert was fired this recently." (Muting has the
        // same effect as "no rule": no fire attempted, no cooldown advance —
        // this is also what lets unmuting + a later genuine rising edge fire
        // again, see failure_patterns.test.ts.)
        ...(firedForThisPattern > 0 ? { lastPatternSpikeAlertFiredAt: now } : {}),
      });
      if (assessment.isSpiking) spiking += 1;
    }

    return { assessed: patterns.length, spiking, fired };
  },
});

// Function references by name (not bare value imports) — same established
// pattern as convex/alert_engine.ts / convex/projection_verify.ts /
// convex/run_explanations.ts (this repo's convex/_generated/api.ts is not a
// live codegen output).
const _listActivePatternsForSpikeAssessmentRef = makeFunctionReference<"query">(
  "failure_patterns:_listActivePatternsForSpikeAssessment",
);
const _firePatternSpikeAlertRef = makeFunctionReference<"mutation">("alerts:firePatternSpikeAlert");

// ---------------------------------------------------------------------------
// Terminal-failure wiring helper — exported for run_explanations.ts to call.
// ---------------------------------------------------------------------------

/** Minimal event shape needed to extract fingerprint signals — a subset of HeuristicEventLike. */
export interface FingerprintSignalEventLike {
  type: string;
  sequenceNumber: number;
  payload?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Tolerant tool-name extraction from a tool.call/tool.result/tool.error-shaped payload. Never throws. */
function extractToolNameLoose(payload: unknown): string | undefined {
  const rec = asRecord(payload);
  return stringField(rec, "name") ?? stringField(rec, "tool") ?? stringField(rec, "toolName");
}

/** Tolerant error-message extraction, mirroring run_explanations.ts's excerptForEvent. Never throws. */
function extractErrorMessageLoose(payload: unknown): string | undefined {
  const rec = asRecord(payload);
  if (!rec) return undefined;
  return stringField(rec, "message") ?? stringField(asRecord(rec["error"]), "message");
}

/**
 * Derive the four fingerprint signals (heuristicClass, failingToolName,
 * terminalEventType, errorSignature) from the same inputs
 * generateRunExplanation already has in hand: the heuristic engine's
 * `failureClass`, the citedSequenceNumbers it grounded its explanation in,
 * and the bounded event window. Looks up the event nearest to the LAST cited
 * sequence number (closest to the failure) for a tool name / error message,
 * falling back to the run's own terminal event's type. Never throws — every
 * extraction step is tolerant of missing/malformed shapes.
 */
export function extractFingerprintSignals(input: {
  failureClass: string;
  citedSequenceNumbers: number[];
  events: FingerprintSignalEventLike[];
}): DeriveFailureFingerprintInput {
  const events = Array.isArray(input.events) ? input.events : [];
  const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const terminalEvent = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;

  // Scan cited events highest-sequence-first (closest to the failure) for a
  // tool name / error message, rather than assuming the single
  // highest-numbered citation carries every signal — the terminal event
  // (typically the highest cited seq) often has an error MESSAGE but not a
  // tool NAME, which usually sits on an earlier tool.error/tool.result event.
  const citedSeqNums = Array.isArray(input.citedSequenceNumbers) ? input.citedSequenceNumbers : [];
  const citedEvents = [...citedSeqNums]
    .filter((n) => typeof n === "number" && Number.isFinite(n))
    .sort((a, b) => b - a)
    .map((seq) => sorted.find((e) => e.sequenceNumber === seq))
    .filter((e): e is FingerprintSignalEventLike => e !== undefined);

  let failingToolName: string | undefined;
  let errorSignature: string | undefined;
  for (const event of citedEvents) {
    if (failingToolName === undefined) failingToolName = extractToolNameLoose(event.payload);
    if (errorSignature === undefined) errorSignature = extractErrorMessageLoose(event.payload);
  }
  if (errorSignature === undefined && terminalEvent) {
    errorSignature = extractErrorMessageLoose(terminalEvent.payload);
  }

  return {
    heuristicClass: input.failureClass,
    failingToolName,
    terminalEventType: terminalEvent?.type,
    errorSignature,
  };
}

/**
 * Convenience wrapper: derive signals + fingerprint in one call, for
 * run_explanations.ts's terminal-failure wiring. Never throws (both steps
 * are individually tolerant; this just composes them).
 */
export function fingerprintExplanation(input: {
  failureClass: string;
  citedSequenceNumbers: number[];
  events: FingerprintSignalEventLike[];
}): DerivedFailureFingerprint {
  const signals = extractFingerprintSignals(input);
  return getDeriveFailureFingerprint()(signals);
}

export const _recordFailurePatternOccurrenceRef = makeFunctionReference<"mutation">(
  "failure_patterns:recordFailurePatternOccurrence",
);
