// Failure Patterns (PREVENTION, cycle 1) — a durable, org-scoped memory of
// recurring failure fingerprints derived from failed runs. OBSERVABILITY-GRADE
// DERIVED DATA, never source of truth (mirrors ADR-002's constraint language
// for daily_rollups/usage_counters — see docs/adr/005-failure-patterns.md):
// the event log + `RunExplanation` remain the only facts about what happened
// on any single run. A `FailurePattern` is a rollup over `run_explanations`-
// derived fingerprints, always additive/regeneratable, never a substitute for
// replaying the real event log.

/** Mirrors run_explanations' free-form classifier vocabulary — not a closed enum, since it can grow without a schema change. */
export type FailurePatternClass = string;

/** APPEND-ONLY fact: one fingerprinted failure observed on one run. At most one per `runId` (enforced at write time, not by a database constraint). */
export interface FailurePatternOccurrence {
  id: string;
  orgId: string;
  fingerprintHash: string;
  runId: string;
  agentId: string;
  agentVersionId?: string;
  occurredAt: number;
  heuristicClass: FailurePatternClass;
  salientKey: string;
}

/** One daily count bucket in a fingerprint's trend, for the spike detector and the trend chart. */
export interface FailurePatternTrendPoint {
  /** "YYYY-MM-DD", UTC. */
  day: string;
  count: number;
}

/** The most recent spike assessment computed by the periodic spike-rollup cron over a pattern's daily trend. */
export interface FailurePatternSpikeAssessment {
  assessedAt: number;
  isSpiking: boolean;
  recentCount: number;
  baselineMean: number;
  z: number;
}

/** Rollup: exactly one row per (orgId, fingerprintHash), upserted as occurrences are recorded. Derived/observability-grade — never source of truth. */
export interface FailurePattern {
  id: string;
  orgId: string;
  fingerprintHash: string;
  class: FailurePatternClass;
  label: string;
  salientKey: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Bounded (<= 5), deduped, most-recent-first sample of runIds. */
  representativeRunIds: string[];
  /** Bounded (<= 20), deduped set of agent versions this fingerprint has been seen on. */
  affectedAgentVersionIds: string[];
  /**
   * Bounded (<= 20), deduped, most-recent-first set of AGENTS this
   * fingerprint has been observed on (docs/adr/006-failure-resolution.md
   * cycle 2). Not derivable from `affectedAgentVersionIds` — a run's
   * `agentVersionId` is optional, so a fingerprint can have occurrences and
   * no versions at all. OPTIONAL: absent on every rollup written before this
   * cycle; it self-heals on that pattern's next occurrence, and backend
   * readers fall back to deriving the set from occurrences meanwhile.
   */
  affectedAgentIds?: string[];
  /**
   * True when {@link FailurePattern.affectedAgentIds} hit its cap and the set
   * is a FLOOR, not the whole blast radius.
   *
   * ---------------------------------------------------------------------
   * WHY THIS FIELD HAD TO EXIST
   * ---------------------------------------------------------------------
   *
   * The set is capped on write at 20, most-recent-first — so a saturated
   * "20" is indistinguishable from a real 20 to everything downstream, and
   * the number an operator reads mid-incident is the blast radius. It
   * UNDERCOUNTS PRECISELY ON THE WIDEST-SPREADING FAILURES, which are the
   * ones worth knowing about: the more agents a failure reaches, the more
   * confidently this field understates it.
   *
   * It also CHURNS, which is the less obvious half. Most-recent-first dedup
   * means two reads seconds apart can return different members, so a
   * saturated set is not merely incomplete, it is UNSTABLE — a list an
   * operator is comparing against a screenshot from five minutes ago.
   *
   * The same interface already carries `runCountTruncated` for the run scan
   * (see {@link PatternResolutionExposure}), which is what made the absence
   * here an inconsistency rather than a considered omission of the whole
   * design.
   *
   * Absent means "not known to be truncated" — every row written before this
   * field existed, which self-heals on that pattern's next occurrence. It
   * therefore may NOT be read as "definitely complete"; use
   * {@link affectedAgentCountLabel}, which renders the honest string in both
   * cases rather than leaving each surface to remember.
   */
  affectedAgentIdsTruncated?: boolean;
  lastSpikeAssessment?: FailurePatternSpikeAssessment;
  /** Epoch ms of the last time a `pattern_spike` alert was fired for this pattern (cooldown state — see docs/adr/005-failure-patterns.md Cycle 2). */
  lastPatternSpikeAlertFiredAt?: number;
  /**
   * Cycle 3: admin-gated, org-wide suppression of alert-firing for this
   * fingerprint. Does NOT stop occurrence recording or spike assessment —
   * only suppresses `assessPatternSpikesCron`'s call to fire an alert on a
   * spike transition. Absent/false = not muted.
   */
  muted?: boolean;
  /** Epoch ms of the most recent mute. Not cleared on unmute (a "last muted at" marker, not "muted since"). */
  mutedAt?: number;

  // ---------------------------------------------------------------------
  // Resolution lifecycle (docs/adr/006-failure-resolution.md). A human
  // annotation on the rollup, exactly like Comments hang off runs/events —
  // NEVER source of truth, same observability-grade posture as every other
  // field above. Written by acknowledgePattern/resolvePattern/reopenPattern
  // (member-gated, audited) and by the regression guard inside
  // recordFailurePatternOccurrence.
  // ---------------------------------------------------------------------

  /** Absent means "open" — the default for every pre-cycle-6 row and every freshly-created rollup. */
  status?: FailurePatternStatus;
  acknowledgedAt?: number;
  acknowledgedByUserId?: string;
  resolvedAt?: number;
  resolvedByUserId?: string;
  /** Bounded free text describing how/why this fingerprint was resolved. */
  resolutionNote?: string;
  /**
   * Bounded free-form reference — e.g. an agentVersionId or a URL. Plain
   * string only: if a caller renders it as a link, that is a UI-layer
   * decision; this layer never auto-fetches it.
   */
  resolutionRef?: string;
  /**
   * Set by the regression guard the moment a RESOLVED pattern receives a new
   * occurrence dated after `resolvedAt` — "your fix didn't hold." Cleared by
   * `reopenPattern` (a human manually reopening is not itself a regression).
   */
  regressedAt?: number;

  // ---------------------------------------------------------------------
  // Resolution EVIDENCE (docs/adr/006-failure-resolution.md cycle 2 —
  // "prove the fix held"). A resolution on its own is an unearned human
  // assertion; these three fields are the point-in-time snapshot that lets a
  // later reader judge how much the claimed fix has actually been exercised
  // since. Written ONLY by `resolvePattern`. OBSERVABILITY-GRADE like every
  // other field on this rollup — snapshots of derived counters, never facts
  // about any single run.
  //
  // Everything derivable from these plus live data — exposure SINCE
  // resolution, recurrences since resolution, the lifecycle transition
  // history — is computed at query time by `getPatternResolutionEvidence`
  // and is NOT stored on the rollup. See `PatternResolutionEvidence` below.
  // ---------------------------------------------------------------------

  /**
   * The agent version the operator believes contains the fix. Validated at
   * resolve time to exist, to belong to the caller's org, and to belong to an
   * agent this pattern has been observed on — a cross-org or cross-agent id
   * is rejected, never silently dropped. Distinct from `resolutionRef`, which
   * is unvalidated free text.
   */
  resolvedInVersionId?: string;
  /**
   * BASELINE EXPOSURE: runs started for this pattern's affected agents in the
   * 14 days immediately BEFORE `resolvedAt` — the denominator to compare live
   * post-resolution exposure against. Bounded, therefore approximate for very
   * high-volume agents.
   */
  resolvedAtRunCount?: number;
  /** The rollup's own `count` at the instant of resolution. Post-resolution recurrences are exactly `count - resolvedAtOccurrenceCount`. */
  resolvedAtOccurrenceCount?: number;

  // ---------------------------------------------------------------------
  // FIX-CONFIDENCE SNAPSHOT (docs/adr/006-failure-resolution.md cycle 3 —
  // "make the honest answer cheap"). The live verdict needs a bounded but
  // real post-resolution run-exposure scan per pattern, which is affordable
  // on a detail page and impossible across a list page. These two fields
  // are the periodically-refreshed snapshot that lets a list FILTER on the
  // verdict without re-measuring it.
  //
  // OBSERVABILITY-GRADE, like every other field on this rollup: the LIVE
  // computation stays the source of truth (both evidence endpoints still
  // compute it), and the event log remains the only fact about what
  // happened. Never render one of these as "current" without checking
  // `computedAt` against the documented staleness bound.
  // ---------------------------------------------------------------------

  /** Last computed fix-confidence verdict. Absent when the pattern has never been resolved, was manually reopened, or has not yet been snapshotted. */
  lastFixConfidence?: FixConfidenceSnapshot;
  /** Scheduling state for the snapshot cron: epoch ms at or after which this pattern is due for recomputation. Absent when there is nothing to grade. */
  fixConfidenceRefreshAt?: number;
}

/**
 * The stored subset of `FixConfidenceResult` (below).
 *
 * DELIBERATELY NOT THE FULL RESULT. `elapsedMs`, `soakCredit` and
 * `exposureCredit` are omitted because they are exactly recomputable from
 * what is stored here, and the first two are "as of now" quantities that
 * would be definitionally wrong the moment the snapshot aged — storing them
 * would invite a consumer to render a stale duration as a live one.
 * `hasResolution`/`exposureMeasured` are omitted as trivially derivable. What
 * IS stored is precisely the measurement that cannot be recovered without
 * redoing the expensive exposure scan, so the snapshot stays inspectable
 * rather than being a bare number to trust.
 */
export interface FixConfidenceSnapshot {
  /** Server clock at the moment this verdict was computed. The input to the staleness bound. */
  computedAt: number;
  /**
   * The `resolvedAt` this verdict was computed against. Readers MUST compare
   * it to the rollup's current `resolvedAt` and discard the snapshot when
   * they differ — a reopen + re-resolve begins a new evidence episode, and
   * grading it with the previous episode's verdict is exactly the
   * list-says-`confirmed`/detail-says-`regressed` disagreement this snapshot
   * design exists to make impossible.
   */
  basisResolvedAt: number;
  state: FixConfidenceState;
  score: number;
  /** Runs credited as exposure (zeroed on version mismatch) as measured at `computedAt`. */
  exposureRuns: number;
  /** Runs measured before version attribution was applied. */
  observedRuns: number;
  /** True when the exposure scan hit its ceiling — the counts above are floors, not exact totals. */
  exposureTruncated: boolean;
  versionAttribution: FixVersionAttribution;
  recurred: boolean;
  limitingFactor: FixConfidenceLimit;
}

/** Failure pattern lifecycle state (docs/adr/006-failure-resolution.md). Absent on the rollup means "open". */
export type FailurePatternStatus = "open" | "acknowledged" | "resolved";

// ---------------------------------------------------------------------------
// Resolution evidence (docs/adr/006-failure-resolution.md cycle 2) — the
// DERIVED "did the fix hold?" projection returned by
// `failure_patterns:getPatternResolutionEvidence`. None of this is stored:
// it is computed at query time from `runs`, the rollup's own `count`, and the
// append-only `audit_log`, exactly like replay/diff are derived projections
// over the event log and never source of truth.
// ---------------------------------------------------------------------------

/** One lifecycle transition, reconstructed from the append-only audit log rather than a mutable history table. */
export interface PatternLifecycleTransition {
  /** A `failure_pattern.*` audit action, e.g. "failure_pattern.resolved". `failure_pattern.regressed` is the regression guard's automatic reopen. */
  action: string;
  /** Clerk user id, or the literal "system" for transitions the backend applied on its own. */
  actorClerkUserId: string;
  timestamp: number;
  metadata?: unknown;
}

/** The point-in-time claim a human made when resolving. */
export interface PatternResolutionMetadata {
  resolvedAt: number;
  resolvedByUserId?: string;
  resolutionNote?: string;
  resolutionRef?: string;
  resolvedInVersionId?: string;
  /** The `version` string of `resolvedInVersionId`, resolved live for display only — never stored. */
  resolvedInVersion?: string;
  resolvedAtOccurrenceCount?: number;
  resolvedAtRunCount?: number;
}

/** How much the claimed fix has actually been exercised since it was claimed. */
export interface PatternResolutionExposure {
  /** The `resolvedAt` every count below is measured from. */
  since: number;
  /** Runs started for the pattern's affected agents since `since`. Bounded — see `runCountTruncated`. */
  runCount: number;
  /** True when the scan ceiling was hit: `runCount` is a floor ("2000+"), not an exact total. */
  runCountTruncated: boolean;
  /** EXACT recurrences since resolution: `count - resolvedAtOccurrenceCount`. */
  recurrenceCount: number;
  /** The pre-resolution baseline (`resolvedAtRunCount`) for comparison, when it was captured. */
  baselineRunCount?: number;
  /** The agents `runCount` was measured across. */
  agentIds: string[];
  /**
   * Whether the fix has held SO FAR — zero recurrences since resolution.
   * NOT a claim that the fix is correct: `runCount` is what says whether
   * "held so far" is meaningful evidence. `heldSoFar: true` with
   * `runCount: 0` means the fix is simply untested.
   */
  heldSoFar: boolean;
}

// ---------------------------------------------------------------------------
// Fix confidence (docs/adr/006-failure-resolution.md cycle 2). The scoring
// ENGINE lives in convex/insights.ts §12 and is the single source of truth for
// the math; these are the CANONICAL type declarations for its vocabulary and
// result shape, per CLAUDE.md ("all shared entity types live in
// packages/contracts only"). The SDK, CLI, and web forwarder previously each
// mirrored these unions locally because they cannot import a Convex module —
// those mirrors should now collapse onto these types.
//
// Keep the literals here EXACTLY in step with convex/insights.ts. They are not
// decoration: build gates are written against them (e.g. `state !==
// "regressed"`), and a lagging mirror stays self-consistent — and therefore
// silently type-checks — while no longer matching what it was written to
// catch.
// ---------------------------------------------------------------------------

/**
 * Lifecycle verdict on a claimed fix.
 * - `unproven`  — asserted, but nothing has exercised the path yet.
 * - `proving`   — real exposure is accumulating without recurrence.
 * - `confirmed` — enough clean exposure to act on.
 * - `regressed` — the pattern came back after the resolution.
 */
export type FixConfidenceState = "unproven" | "proving" | "confirmed" | "regressed";

/** Whether the exposure runs can be attributed to the version the fix shipped in. */
export type FixVersionAttribution = "matched" | "mismatched" | "unknown";

/** Why the score is not higher. For UI explanation; ordered by the engine's precedence. */
export type FixConfidenceLimit =
  | "recurrence"
  | "no-resolution"
  | "version-mismatch"
  | "no-exposure"
  | "accumulating"
  | "none";

/**
 * The inspectable result of the fix-confidence engine. The score is
 * deliberately accompanied by every input that produced it: an engineer must
 * be able to read "0.42 because 21 runs over 2 days on the matching version,
 * no recurrence" rather than being handed a bare number to trust. Consumers
 * should render the drivers, not just `score`.
 */
export interface FixConfidenceResult {
  /** 0..0.95, rounded to 4 decimals. Never NaN. */
  score: number;
  state: FixConfidenceState;
  /** Runs that actually count as exposure — sanitized, and ZEROED on version mismatch. */
  exposureRuns: number;
  /** Sanitized post-resolution run count BEFORE version attribution was applied. */
  observedRuns: number;
  versionAttribution: FixVersionAttribution;
  /** `now - resolvedAt`, clamped to >= 0. `0` when there is no usable resolution. */
  elapsedMs: number;
  recurred: boolean;
  /** Whether a usable (finite) `resolvedAt` was supplied at all. */
  hasResolution: boolean;
  /** Whether exposure was measured at all (vs. left undefined). */
  exposureMeasured: boolean;
  /** 0..1 — share of the exposure bar filled. */
  exposureCredit: number;
  /** 0..1 — share of the soak bar filled. */
  soakCredit: number;
  limitingFactor: FixConfidenceLimit;
}

/** `getPatternResolutionEvidence`'s full shape. */
export interface PatternResolutionEvidence {
  pattern: FailurePattern;
  /** Null when there is no live resolution to evidence (never resolved, or manually reopened — which clears `resolvedAt`). */
  resolution: PatternResolutionMetadata | null;
  /** Null exactly when `resolution` is null — exposure is always measured from a `resolvedAt`. */
  exposure: PatternResolutionExposure | null;
  /**
   * The full inspectable fix-confidence verdict — score AND every driver
   * behind it. Computed server-side against the SERVER clock (soak credit is
   * time-dependent, so a client-supplied clock would be forgeable into a
   * `confirmed` verdict).
   *
   * Null on precisely the same condition as `resolution`/`exposure`: no
   * resolution means there is nothing to score. NOT null after an automatic
   * regression reopen — that path keeps `resolvedAt`, so this carries a
   * `state: "regressed"`, `score: 0` verdict with real numbers behind it.
   */
  confidence: FixConfidenceResult | null;
  /** Oldest-first, bounded to the 100 most recent transitions. */
  transitions: PatternLifecycleTransition[];
}

/** `getFailurePattern`'s full detail shape: the rollup, a bounded recent-occurrences sample, and a 14-day trend. */
export interface FailurePatternDetail {
  pattern: FailurePattern;
  recentOccurrences: FailurePatternOccurrence[];
  /** Daily counts for the trailing 14 UTC calendar days (inclusive of today), oldest first. */
  trend: FailurePatternTrendPoint[];
}

// ---------------------------------------------------------------------------
// Rendering the blast radius honestly
// ---------------------------------------------------------------------------

/** Cap applied to {@link FailurePattern.affectedAgentIds} on write. A set at this size may be a floor. */
export const MAX_AFFECTED_AGENT_IDS = 20;

/**
 * How many agents this fingerprint has been seen on, as a string an operator
 * can trust — `"20+"` when the set saturated, `"7"` when it did not.
 *
 * ONE IMPLEMENTATION, because this is a number read during an incident and a
 * CLI that says "20" while a dashboard says "20+" is two answers to one
 * question. Surfaces should call this rather than `affectedAgentIds.length`.
 *
 * Treats a set AT the cap as truncated even when `affectedAgentIdsTruncated`
 * is absent, and that conservatism is deliberate: the flag is optional and
 * missing on every row written before it existed, so trusting its absence
 * would render exactly the pre-existing rows as exact — the ones most likely
 * to be wrong.
 */
export function affectedAgentCountLabel(pattern: FailurePattern): string {
  const ids = pattern.affectedAgentIds ?? [];
  const saturated = pattern.affectedAgentIdsTruncated === true || ids.length >= MAX_AFFECTED_AGENT_IDS;
  return saturated ? `${ids.length}+` : String(ids.length);
}

// ---------------------------------------------------------------------------
// Org-level resolution health — and the one number that must be able to say
// "there is no number"
// ---------------------------------------------------------------------------

/**
 * The org-wide rollup over pattern lifecycle state, computed by
 * `convex/insights.ts`'s `summarizeResolutionHealth`.
 *
 * CANONICAL DECLARATION, per CLAUDE.md ("all shared entity types live in
 * packages/contracts only") — the engine previously declared this shape inline
 * at its return site, which is exactly how the `FixConfidence*` unions came to
 * be mirrored in four places.
 *
 * ---------------------------------------------------------------------------
 * `healthScore: number | null` — WHY THE NULL IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * An org with no patterns at all scored **100: PERFECT HEALTH**. An org whose
 * pattern ingestion is silently BROKEN presents identically to an org with
 * nothing wrong — and the broken one is the case you would most want the
 * number to shout about.
 *
 * There is no number that correctly represents "we have no data", and every
 * candidate fails in a direction:
 *   - `0` reads as catastrophe, and would page someone over an empty org.
 *   - `100` reads as perfect, which is the bug.
 *   - a sentinel (`-1`) gets rendered as a number by whoever forgets, which
 *     is the same failure with an extra step.
 *
 * So the type says there is no score. `null` is not a hedge and not a magic
 * value — it is the absence of a measurement, and a consumer cannot format it
 * as a percentage without deciding what to do about it.
 *
 * THIS IS THE SAME RULE AS `FleetShareMeasurement.unaffectedSharing` in
 * `fleet_health.ts`: **an unmeasured quantity is not a measured extreme.**
 * That distinction was the strongest thing in the fleet contract and it
 * generalises — it is worth reaching for whenever a summary statistic has an
 * empty input, because the empty input is the one nobody writes a test for and
 * the one ordinary operation produces most often.
 *
 * `total` remains the input a consumer should branch on; `null` is what makes
 * forgetting to impossible to render.
 */
export interface ResolutionHealthSummary {
  total: number;
  open: number;
  acknowledged: number;
  resolved: number;
  regressed: number;
  regressionRate: number;
  /** Null when no resolution has a measurable time-to-resolution. Already correct; the model for the scores below. */
  avgTimeToResolutionMs: number | null;
  medianTimeToResolutionMs: number | null;
  /** 0..100, or NULL when `total === 0` — there is no health score for an org with no patterns. */
  healthScore: number | null;
  confirmedResolutions: number;
  provingResolutions: number;
  unprovenResolutions: number;
  resolutionsWithoutEvidence: number;
  confirmationRate: number;
  /**
   * `healthScore` recomputed with each resolution contributing only the credit
   * its EVIDENCE earned. Null on exactly the same condition, for exactly the
   * same reason — and the GAP between the two numbers is only readable when
   * both are numbers.
   */
  provenHealthScore: number | null;
}

/**
 * Render a health score for a human, or say why there is none.
 *
 * Exists so no surface has to decide for itself what `null` looks like — the
 * decision that turns "no data" back into a number is exactly the one being
 * removed.
 */
export function healthScoreLabel(score: number | null): string {
  return score === null ? "no data" : String(score);
}
