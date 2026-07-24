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
import { recordAuditEvent, SYSTEM_ACTOR } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import { MAX_RESOLUTION_NOTE_LENGTH, MAX_RESOLUTION_REF_LENGTH } from "./helpers/pagination.js";
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
/** failure_patterns.affectedAgentIds cap (ADR-006 cycle 2). */
export const MAX_AFFECTED_AGENT_IDS = 20;
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
// Resolution-evidence constants (ADR-006 cycle 2 — "prove the fix held").
// ---------------------------------------------------------------------------

/**
 * Trailing window, in UTC-agnostic milliseconds, over which `resolvePattern`
 * snapshots a BASELINE run count (`resolvedAtRunCount`) for the pattern's
 * affected agents. Deliberately the same 14 days as TREND_WINDOW_DAYS so the
 * "before" number a reader compares live post-resolution exposure against is
 * measured over the same horizon as the pattern's own trend chart.
 *
 * Why a trailing WINDOW rather than an all-time cumulative run count: no
 * monotonic per-agent run counter exists in this schema, so an all-time count
 * would mean an unbounded scan inside a mutation. A bounded trailing window
 * is both cheap and the more useful comparison anyway — "this agent was doing
 * N runs a fortnight before we called it fixed" is an exposure RATE, which is
 * what tells you whether M runs since resolution is meaningful evidence or
 * barely any evidence at all.
 */
export const RESOLUTION_BASELINE_WINDOW_MS = TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on how many `runs` rows a single exposure count may read,
 * across ALL of a pattern's affected agents combined. Both the baseline
 * snapshot (inside resolvePattern, a mutation) and the live post-resolution
 * count (inside getPatternResolutionEvidence, a query) respect it, and both
 * report a `truncated` flag when they hit it rather than silently returning a
 * capped number as if it were exact. This is what keeps these counts
 * OBSERVABILITY-GRADE by construction (CLAUDE.md / ADR-002): approximate for
 * very high-volume agents, never a substitute for the event log.
 */
export const RESOLUTION_RUN_SCAN_CAP = 2000;

/** Bounded number of `failure_pattern.*` audit rows getPatternResolutionEvidence returns as lifecycle transitions. */
export const MAX_PATTERN_LIFECYCLE_TRANSITIONS = 100;

/** Bounded occurrence read used ONLY to derive a pre-cycle-2 rollup's agent set (rows written before `affectedAgentIds` existed). */
export const MAX_AGENT_SET_OCCURRENCE_SCAN = 200;

/**
 * The ONE message every rejected `resolvePattern` `versionId` produces —
 * whether the id is unknown, belongs to another org, or belongs to an agent
 * this pattern has never been observed on.
 *
 * DELIBERATELY IDENTICAL ACROSS ALL THREE CASES: a caller who can distinguish
 * "no such version" from "that version exists but is not yours" has an
 * existence oracle for another org's agent_versions ids. One message, one
 * code, no distinguishable behavior.
 *
 * DELIBERATELY FREE OF THE PHRASE "not found": apps/web's
 * `resolveApiError` (apps/web/src/lib/apiErrorMapping.ts) has a prose
 * fallback that maps any message merely CONTAINING that phrase to a 404. The
 * `INVALID_ARGUMENT:` code prefix is matched earlier than that fallback today,
 * so this is belt-and-braces — but the phrase buys nothing here and its
 * absence removes any chance of this degrading from a 422 to a 404 if that
 * resolver's ordering ever changes.
 */
export const INVALID_RESOLUTION_VERSION_MESSAGE =
  "versionId must reference an agent version in this organization that belongs to an agent this pattern has been observed on";

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

    const rollupResult = await upsertRollup(ctx, {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      class: args.class,
      label: args.label,
      salientKey: args.salientKey,
      runId: args.runId,
      agentId: args.agentId,
      agentVersionId: args.agentVersionId,
      occurredAt,
    });

    await incrementDailyCount(ctx, {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      day: dayKeyOf(occurredAt),
    });

    // REGRESSION GUARD (docs/adr/006-failure-resolution.md): a RESOLVED
    // pattern that just received a new occurrence dated after its
    // resolvedAt was auto-reopened by upsertRollup above. Fire a
    // pattern_regressed alert — UNLESS the pattern is muted (mute silences
    // alerts, it does not disable the lifecycle: the reopen above still
    // happened regardless of this branch). Idempotent by construction: the
    // rollup's status is now "open", so no later occurrence on this same
    // (still-open) episode can re-enter this branch until a human resolves
    // it again.
    // ADR-006 cycle 2: record the AUTOMATIC reopen in the append-only audit
    // log, so getPatternResolutionEvidence can reconstruct the FULL lifecycle
    // transition history — including the transitions no human made — without
    // a mutable per-pattern history table. Deliberately OUTSIDE the mute
    // check below: muting suppresses ALERTS, never the paper trail. Written
    // with SYSTEM_ACTOR because there is no human actor on this path.
    if (rollupResult.regressedFire) {
      await recordAuditEvent(ctx, {
        orgId: args.orgId,
        actorClerkUserId: SYSTEM_ACTOR,
        action: "failure_pattern.regressed",
        targetType: "failure_pattern",
        targetId: args.fingerprintHash,
        metadata: {
          fingerprintHash: args.fingerprintHash,
          class: args.class,
          label: args.label,
          resolvedAt: rollupResult.regressedFire.resolvedAt,
          regressedAt: rollupResult.regressedFire.regressedAt,
          runId: args.runId,
          muted: rollupResult.regressedFire.muted,
        },
      });
    }

    if (rollupResult.regressedFire && !rollupResult.regressedFire.muted) {
      await ctx.runMutation(_firePatternRegressionAlertRef, {
        orgId: rollupResult.regressedFire.orgId,
        fingerprintHash: rollupResult.regressedFire.fingerprintHash,
        class: rollupResult.regressedFire.class,
        label: rollupResult.regressedFire.label,
        resolvedAt: rollupResult.regressedFire.resolvedAt,
        regressedAt: rollupResult.regressedFire.regressedAt,
        representativeRunId: rollupResult.regressedFire.representativeRunId,
      });
    }

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

/** What recordFailurePatternOccurrence needs from upsertRollup to (maybe) fire a regression alert, outside the DB transaction's own concerns. */
interface RollupUpsertResult {
  regressedFire?: {
    orgId: Id<"organizations">;
    fingerprintHash: string;
    class: string;
    label: string;
    resolvedAt: number;
    regressedAt: number;
    representativeRunId: Id<"runs">;
    muted: boolean;
  };
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
    agentId: Id<"agents">;
    agentVersionId: Id<"agent_versions"> | undefined;
    occurredAt: number;
  },
): Promise<RollupUpsertResult> {
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
      affectedAgentIds: [args.agentId],
    });
    return {};
  }

  const representativeRunIds = dedupCapMostRecentFirst(
    existing.representativeRunIds,
    args.runId,
    MAX_REPRESENTATIVE_RUN_IDS,
  );
  const affectedAgentVersionIds = args.agentVersionId
    ? dedupCapMostRecentFirst(existing.affectedAgentVersionIds, args.agentVersionId, MAX_AFFECTED_AGENT_VERSION_IDS)
    : existing.affectedAgentVersionIds;
  // ADR-006 cycle 2: maintain the agent set the same bounded/deduped/
  // most-recent-first way. `existing.affectedAgentIds` is absent on every
  // pre-this-cycle row — treated as an empty starting set, so the field
  // self-heals on the next occurrence without any backfill, and readers that
  // find it still empty fall back to `deriveAgentIdsFromOccurrences`.
  const affectedAgentIds = dedupCapMostRecentFirst(
    existing.affectedAgentIds ?? [],
    args.agentId,
    MAX_AFFECTED_AGENT_IDS,
  );

  // REGRESSION GUARD (docs/adr/006-failure-resolution.md): this fingerprint
  // was marked RESOLVED by a human, and a new occurrence just landed dated
  // AFTER that resolution — the fix didn't hold. Auto-reopen: status flips
  // back to "open" and regressedAt is stamped with THIS occurrence's
  // timestamp (not `Date.now()` — occurredAt may be caller-supplied, e.g. in
  // tests or a backfill, and this is "when the regressing failure actually
  // happened", mirroring how lastSeenAt/firstSeenAt already use occurredAt
  // rather than wall-clock time).
  const isRegression =
    existing.status === "resolved" &&
    existing.resolvedAt !== undefined &&
    args.occurredAt > existing.resolvedAt;

  const patch: Partial<Doc<"failure_patterns">> = {
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
    affectedAgentIds,
  };

  let regressedFire: RollupUpsertResult["regressedFire"];
  if (isRegression) {
    patch.status = "open";
    patch.regressedAt = args.occurredAt;
    regressedFire = {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      class: args.class,
      label: args.label,
      resolvedAt: existing.resolvedAt as number,
      regressedAt: args.occurredAt,
      representativeRunId: args.runId,
      muted: existing.muted === true,
    };
  }

  await ctx.db.patch(existing._id, patch);
  return { regressedFire };
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
// Resolution lifecycle (docs/adr/006-failure-resolution.md) — acknowledge /
// resolve / reopen. MEMBER-gated (not admin-only): this is a human
// annotation on the rollup, the same tier as commenting/resolving a comment
// (convex/comments.ts's resolveComment) — not org-wide alerting config like
// mutePattern/unmutePattern above. All three are AUDITED and return the
// updated rollup doc, or `null` when `fingerprintHash` does not exist IN THIS
// ORG — same "never existed" / "belongs to a different org" collapse every
// other lookup-by-fingerprint mutation in this file already uses.
// ---------------------------------------------------------------------------

function validateResolutionFields(args: { note?: string; ref?: string }): void {
  if (args.note !== undefined && args.note.length > MAX_RESOLUTION_NOTE_LENGTH) {
    throw afrError(
      "INVALID_ARGUMENT",
      `resolutionNote must be at most ${String(MAX_RESOLUTION_NOTE_LENGTH)} characters`,
    );
  }
  if (args.ref !== undefined && args.ref.length > MAX_RESOLUTION_REF_LENGTH) {
    throw afrError(
      "INVALID_ARGUMENT",
      `resolutionRef must be at most ${String(MAX_RESOLUTION_REF_LENGTH)} characters`,
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution evidence helpers (ADR-006 cycle 2). Shared by resolvePattern
// (which snapshots the BEFORE numbers) and getPatternResolutionEvidence
// (which derives the AFTER numbers live).
// ---------------------------------------------------------------------------

/**
 * The set of agents this fingerprint has been observed on.
 *
 * Prefers the rollup's own maintained `affectedAgentIds` (bounded, O(1) to
 * read). Falls back to a BOUNDED scan of the pattern's occurrences for rows
 * written before that field existed — a pre-this-cycle rollup has no agent
 * set until its next occurrence lands, and neither cross-agent validation nor
 * exposure counting should be silently wrong (or silently reject everything)
 * in the meantime.
 *
 * Org-scoped by construction: both sources are reached only via this
 * fingerprint's own org-scoped rollup / `by_org_fingerprint` occurrence
 * index, so no agent from another org can enter this set.
 */
async function resolveAgentIdsForPattern(
  ctx: QueryCtx | MutationCtx,
  pattern: Doc<"failure_patterns">,
): Promise<Id<"agents">[]> {
  if (pattern.affectedAgentIds && pattern.affectedAgentIds.length > 0) {
    return pattern.affectedAgentIds;
  }

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

/** A bounded run-exposure count, explicit about whether it hit the scan ceiling. */
export interface RunExposureCount {
  count: number;
  /** True when RESOLUTION_RUN_SCAN_CAP was reached — `count` is a floor, not an exact total. */
  truncated: boolean;
}

/**
 * Count runs started for `agentIds` after `afterExclusive` (and, when
 * `untilInclusive` is supplied, up to and including it), across all of them
 * combined, capped at RESOLUTION_RUN_SCAN_CAP.
 *
 * `untilInclusive` is OPTIONAL because the two callers want genuinely
 * different upper bounds, and the difference is semantic rather than
 * incidental:
 *   - The BASELINE read (resolvePattern) passes `resolvedAt`: the upper bound
 *     IS the thing being measured — runs strictly BEFORE the resolution.
 *   - The EXPOSURE read (getPatternResolutionEvidence) passes nothing: "runs
 *     since resolution" is open-ended by definition. Clamping it to
 *     `Date.now()` would buy nothing except silently dropping any run whose
 *     `startedAt` sits marginally ahead of the reader's clock — SDK-supplied
 *     timestamps and clock skew make that a real way to undercount exposure,
 *     which is the one direction this number must never err in (undercounted
 *     exposure makes an untested fix look better tested than it is).
 *
 * Uses the existing `runs.by_agent_started` index — no new index — so the read
 * is proportional to the window's run volume, not the agent's lifetime run
 * count. `truncated` is reported rather than hidden, so a caller can render
 * "2000+" instead of a wrong exact number.
 */
async function countRunsStartedInWindow(
  ctx: QueryCtx | MutationCtx,
  agentIds: Id<"agents">[],
  afterExclusive: number,
  untilInclusive?: number,
): Promise<RunExposureCount> {
  let count = 0;
  for (const agentId of agentIds) {
    const remaining = RESOLUTION_RUN_SCAN_CAP - count;
    if (remaining <= 0) return { count, truncated: true };

    // take(remaining + 1) so hitting the ceiling is DETECTABLE (a full page
    // plus one) rather than indistinguishable from "exactly `remaining` runs".
    const rows = await ctx.db
      .query("runs")
      .withIndex("by_agent_started", (q) => {
        const lower = q.eq("agentId", agentId).gt("startedAt", afterExclusive);
        return untilInclusive === undefined ? lower : lower.lte("startedAt", untilInclusive);
      })
      .take(remaining + 1);

    if (rows.length > remaining) return { count: RESOLUTION_RUN_SCAN_CAP, truncated: true };
    count += rows.length;
  }
  return { count, truncated: false };
}

/**
 * Validate an operator-supplied `resolvedInVersionId`. Throws
 * INVALID_ARGUMENT — with ONE message for every rejection reason, see
 * INVALID_RESOLUTION_VERSION_MESSAGE — when the version does not exist, is not
 * in the caller's org, or belongs to an agent this pattern has never been
 * observed on. Never silently ignores a bad id: the whole point of this field
 * is to make a resolution claim checkable, and a silently-dropped claim is
 * worse than no claim at all.
 */
async function validateResolutionVersion(
  ctx: MutationCtx,
  pattern: Doc<"failure_patterns">,
  versionId: Id<"agent_versions">,
): Promise<void> {
  const version = await ctx.db.get(versionId);
  if (!version || version.orgId !== pattern.orgId) {
    throw afrError("INVALID_ARGUMENT", INVALID_RESOLUTION_VERSION_MESSAGE);
  }

  const agentIds = await resolveAgentIdsForPattern(ctx, pattern);
  if (!agentIds.includes(version.agentId)) {
    throw afrError("INVALID_ARGUMENT", INVALID_RESOLUTION_VERSION_MESSAGE);
  }
}

/**
 * Acknowledge a fingerprint: status -> "acknowledged". A normal member
 * action (like commenting) — signals "someone is looking at this," distinct
 * from mute (which is admin-gated alert-suppression config). Does not touch
 * resolvedAt/resolutionNote/resolutionRef/regressedAt.
 *
 * Contract for other teams:
 *   `failure_patterns:acknowledgePattern({ orgId, fingerprintHash }) => Doc<"failure_patterns"> | null`
 */
export const acknowledgePattern = mutation({
  args: { orgId: v.id("organizations"), fingerprintHash: v.string() },
  handler: async (ctx, args): Promise<Doc<"failure_patterns"> | null> => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "member" });

    const pattern = await findRollup(ctx, args.orgId, args.fingerprintHash);
    if (!pattern) return null;

    const acknowledgedAt = Date.now();
    await ctx.db.patch(pattern._id, {
      status: "acknowledged",
      acknowledgedAt,
      acknowledgedByUserId: userId,
    });

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "failure_pattern.acknowledged",
      targetType: "failure_pattern",
      targetId: args.fingerprintHash,
      metadata: { fingerprintHash: args.fingerprintHash, class: pattern.class, label: pattern.label },
    });

    return await ctx.db.get(pattern._id);
  },
});

/**
 * Resolve a fingerprint: status -> "resolved", stamping resolvedAt/By and an
 * optional bounded note/ref. This resolvedAt is exactly the timestamp the
 * regression guard (upsertRollup, above) compares every future occurrence's
 * `occurredAt` against — see that function's doc comment.
 *
 * `regressedAt` is deliberately left untouched by a resolve (even a
 * re-resolve after a prior regression) — it is cleared ONLY by `reopenPattern`
 * (a human explicitly reopening), so "when did this last regress" stays
 * visible as history through a subsequent resolve, the same "historical
 * marker, not a live flag" convention `mutedAt` already established in cycle
 * 3.
 *
 * EVIDENCE SNAPSHOT (ADR-006 cycle 2 — "prove the fix held"): a resolution is
 * otherwise an unearned human assertion, so this mutation also stamps the
 * three point-in-time numbers a later reader needs to judge how well-tested
 * the claimed fix actually is — `resolvedInVersionId` (the version the
 * operator believes contains the fix, VALIDATED, never silently dropped),
 * `resolvedAtOccurrenceCount` (exact, O(1)) and `resolvedAtRunCount` (a
 * bounded baseline exposure rate). Everything derivable from those plus live
 * data — exposure since resolution, recurrences since resolution, the
 * transition history — is computed at query time by
 * `getPatternResolutionEvidence`, never stored.
 *
 * Contract for other teams:
 *   `failure_patterns:resolvePattern({ orgId, fingerprintHash, note?, ref?, versionId? }) => Doc<"failure_patterns"> | null`
 * NOTE the arg is `versionId`, matching this mutation's existing short
 * `note`/`ref` arg naming; the FIELD it lands in is `resolvedInVersionId`.
 */
export const resolvePattern = mutation({
  args: {
    orgId: v.id("organizations"),
    fingerprintHash: v.string(),
    note: v.optional(v.string()),
    ref: v.optional(v.string()),
    versionId: v.optional(v.id("agent_versions")),
  },
  handler: async (ctx, args): Promise<Doc<"failure_patterns"> | null> => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "member" });
    validateResolutionFields({ note: args.note, ref: args.ref });

    const pattern = await findRollup(ctx, args.orgId, args.fingerprintHash);
    if (!pattern) return null;

    // Validated AFTER the rollup lookup so an unknown fingerprint still
    // returns the same plain `null` it always has — a caller cannot use a
    // deliberately-bad versionId to distinguish "this fingerprint exists in
    // my org" from "it does not".
    if (args.versionId !== undefined) {
      await validateResolutionVersion(ctx, pattern, args.versionId);
    }

    const resolvedAt = Date.now();
    const agentIds = await resolveAgentIdsForPattern(ctx, pattern);
    const baseline = await countRunsStartedInWindow(
      ctx,
      agentIds,
      resolvedAt - RESOLUTION_BASELINE_WINDOW_MS,
      resolvedAt,
    );

    await ctx.db.patch(pattern._id, {
      status: "resolved",
      resolvedAt,
      resolvedByUserId: userId,
      resolutionNote: args.note,
      resolutionRef: args.ref,
      resolvedInVersionId: args.versionId,
      resolvedAtOccurrenceCount: pattern.count,
      resolvedAtRunCount: baseline.count,
    });

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "failure_pattern.resolved",
      targetType: "failure_pattern",
      targetId: args.fingerprintHash,
      metadata: {
        fingerprintHash: args.fingerprintHash,
        class: pattern.class,
        label: pattern.label,
        hasNote: args.note !== undefined,
        hasRef: args.ref !== undefined,
        resolvedInVersionId: args.versionId,
        resolvedAtOccurrenceCount: pattern.count,
        resolvedAtRunCount: baseline.count,
      },
    });

    return await ctx.db.get(pattern._id);
  },
});

/**
 * Reopen a fingerprint: status -> "open". Used both for a human manually
 * reopening (e.g. "actually this is still happening") and is the terminal
 * state the regression guard's auto-reopen also lands on (though that path
 * writes the rollup directly from upsertRollup/recordFailurePatternOccurrence,
 * not via this mutation — see that function's doc comment).
 *
 * Clears `resolvedAt` and `regressedAt` (both are "currently resolved
 * since" / "currently regressed since" markers that stop being true once the
 * pattern is open again) but deliberately KEEPS `resolvedByUserId`/
 * `resolutionNote`/`resolutionRef`/`acknowledgedAt`/`acknowledgedByUserId` as
 * historical context about the most recent resolution/acknowledgement — the
 * same "don't erase the paper trail" posture `mutedAt` already established
 * (not cleared on unmute).
 *
 * Contract for other teams:
 *   `failure_patterns:reopenPattern({ orgId, fingerprintHash }) => Doc<"failure_patterns"> | null`
 */
export const reopenPattern = mutation({
  args: { orgId: v.id("organizations"), fingerprintHash: v.string() },
  handler: async (ctx, args): Promise<Doc<"failure_patterns"> | null> => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "member" });

    const pattern = await findRollup(ctx, args.orgId, args.fingerprintHash);
    if (!pattern) return null;

    await ctx.db.patch(pattern._id, {
      status: "open",
      resolvedAt: undefined,
      regressedAt: undefined,
    });

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "failure_pattern.reopened",
      targetType: "failure_pattern",
      targetId: args.fingerprintHash,
      metadata: { fingerprintHash: args.fingerprintHash, class: pattern.class, label: pattern.label },
    });

    return await ctx.db.get(pattern._id);
  },
});

// ---------------------------------------------------------------------------
// Resolution evidence query (ADR-006 cycle 2) — "did the fix hold?"
// ---------------------------------------------------------------------------

/** One lifecycle transition, reconstructed from the append-only audit log. */
export interface PatternLifecycleTransition {
  /** A `failure_pattern.*` AUDIT_ACTIONS value, e.g. "failure_pattern.resolved". */
  action: string;
  /** Clerk user id, or `SYSTEM_ACTOR` ("system") for the regression guard's automatic reopen. */
  actorClerkUserId: string;
  timestamp: number;
  metadata?: unknown;
}

/** The point-in-time claim a human made when resolving. Null when the pattern has no live resolution. */
export interface PatternResolutionMetadata {
  resolvedAt: number;
  resolvedByUserId?: string;
  resolutionNote?: string;
  resolutionRef?: string;
  resolvedInVersionId?: Id<"agent_versions">;
  /** The `version` string of resolvedInVersionId, denormalized for display only — resolved live, never stored. */
  resolvedInVersion?: string;
  resolvedAtOccurrenceCount?: number;
  resolvedAtRunCount?: number;
}

/** How much the claimed fix has actually been exercised since it was claimed. */
export interface PatternResolutionExposure {
  /** The `resolvedAt` all counts below are measured from. */
  since: number;
  /** Runs started for the pattern's affected agents since `since`. Bounded — see `runCountTruncated`. */
  runCount: number;
  /** True when RESOLUTION_RUN_SCAN_CAP was hit: `runCount` is a floor ("2000+"), not an exact total. */
  runCountTruncated: boolean;
  /** EXACT recurrences since resolution: the rollup's `count` minus its `resolvedAtOccurrenceCount`. */
  recurrenceCount: number;
  /** The pre-resolution baseline (`resolvedAtRunCount`) for comparison, when it was captured. */
  baselineRunCount?: number;
  /** The agents `runCount` was measured across. */
  agentIds: Id<"agents">[];
  /**
   * Whether the fix has held SO FAR — i.e. zero recurrences since resolution.
   * Deliberately NOT a claim that the fix is correct: `runCount` is what says
   * whether "held so far" is meaningful evidence or no evidence at all. A
   * `heldSoFar: true` with `runCount: 0` means the fix is simply untested.
   */
  heldSoFar: boolean;
}

export interface PatternResolutionEvidenceResult {
  pattern: Doc<"failure_patterns">;
  /** Null when there is no live resolution to evidence (never resolved, or manually reopened — reopenPattern clears resolvedAt). */
  resolution: PatternResolutionMetadata | null;
  /** Null exactly when `resolution` is null — exposure is always measured from a resolvedAt. */
  exposure: PatternResolutionExposure | null;
  /** Oldest-first, bounded to MAX_PATTERN_LIFECYCLE_TRANSITIONS. */
  transitions: PatternLifecycleTransition[];
}

/**
 * Everything a "did the fix hold?" view needs for ONE pattern: the resolution
 * claim, how much that claim has actually been tested since, and the full
 * lifecycle transition history.
 *
 * DERIVED, NOT STORED. Only the three point-in-time snapshot fields
 * `resolvePattern` stamps are read from the rollup; exposure and recurrences
 * are computed live from `runs` and the rollup's own `count`, and the
 * transition history is reconstructed from the APPEND-ONLY `audit_log` (via
 * its `by_org_target` index) rather than from a mutable per-pattern history
 * table. Nothing here adds a second source of truth for the lifecycle, and
 * this query writes nothing.
 *
 * MEMBER-gated, matching the lifecycle mutations it evidences (ADR-006: this
 * is day-to-day triage, not org-wide config) and matching `getFailurePattern`,
 * which already exposes `resolvedByUserId`/`acknowledgedByUserId` to members.
 * NOTE this is deliberately a NARROWER exposure than `audit.ts`'s admin-only
 * `listAuditLog`: it returns audit rows for exactly ONE `failure_pattern`
 * target, never the org's audit log at large.
 *
 * Returns `null` — never an error — when the fingerprint does not exist IN
 * THIS ORG, the same "never existed" / "belongs to another org" collapse every
 * other lookup-by-fingerprint function in this file uses.
 *
 * Contract for other teams:
 *   `failure_patterns:getPatternResolutionEvidence({ orgId, fingerprintHash })
 *      => PatternResolutionEvidenceResult | null`
 */
export const getPatternResolutionEvidence = query({
  args: { orgId: v.id("organizations"), fingerprintHash: v.string() },
  handler: async (ctx, args): Promise<PatternResolutionEvidenceResult | null> => {
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "member" });

    const pattern = await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_fingerprint", (q) => q.eq("orgId", args.orgId).eq("fingerprintHash", args.fingerprintHash))
      .first();
    if (!pattern) return null;

    // Lifecycle transitions: newest-first from the index (so the bound keeps
    // the MOST RECENT transitions when a pattern has more than the cap), then
    // reversed to the oldest-first order a timeline renders in.
    const auditRows = await ctx.db
      .query("audit_log")
      .withIndex("by_org_target", (q) =>
        q.eq("orgId", args.orgId).eq("targetType", "failure_pattern").eq("targetId", args.fingerprintHash),
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

    // No live resolution to evidence. Note this is also the state after a
    // MANUAL reopenPattern (which clears resolvedAt) — but NOT after the
    // regression guard's auto-reopen, which keeps resolvedAt precisely so
    // the "your fix didn't hold" evidence below stays computable.
    if (pattern.resolvedAt === undefined) {
      return { pattern, resolution: null, exposure: null, transitions };
    }

    const resolvedInVersion =
      pattern.resolvedInVersionId !== undefined
        ? await ctx.db.get(pattern.resolvedInVersionId)
        : null;

    const resolution: PatternResolutionMetadata = {
      resolvedAt: pattern.resolvedAt,
      resolvedByUserId: pattern.resolvedByUserId,
      resolutionNote: pattern.resolutionNote,
      resolutionRef: pattern.resolutionRef,
      resolvedInVersionId: pattern.resolvedInVersionId,
      // Defensive org re-check: resolvePattern already validated this id, but
      // a version could in principle have been purged/replaced since, and a
      // cross-org string must never be rendered from here.
      resolvedInVersion:
        resolvedInVersion && resolvedInVersion.orgId === args.orgId ? resolvedInVersion.version : undefined,
      resolvedAtOccurrenceCount: pattern.resolvedAtOccurrenceCount,
      resolvedAtRunCount: pattern.resolvedAtRunCount,
    };

    const agentIds = await resolveAgentIdsForPattern(ctx, pattern);
    // No upper bound: "runs since resolution" is open-ended — see
    // countRunsStartedInWindow's doc comment for why clamping to Date.now()
    // would only ever undercount exposure.
    const exposureRuns = await countRunsStartedInWindow(ctx, agentIds, pattern.resolvedAt);

    // EXACT when the snapshot exists. When it does not (a row resolved before
    // this cycle shipped), fall back to 0 rather than inventing a number from
    // the all-time `count` — a pre-cycle resolution genuinely has no baseline
    // to subtract, and reporting `count` here would claim every occurrence
    // the pattern ever had as a post-resolution recurrence.
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
      heldSoFar: recurrenceCount === 0,
    };

    return { pattern, resolution, exposure, transitions };
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
const _firePatternRegressionAlertRef = makeFunctionReference<"mutation">("alerts:firePatternRegressionAlert");

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
