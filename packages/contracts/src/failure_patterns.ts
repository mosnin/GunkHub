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
}

/** Failure pattern lifecycle state (docs/adr/006-failure-resolution.md). Absent on the rollup means "open". */
export type FailurePatternStatus = "open" | "acknowledged" | "resolved";

/** `getFailurePattern`'s full detail shape: the rollup, a bounded recent-occurrences sample, and a 14-day trend. */
export interface FailurePatternDetail {
  pattern: FailurePattern;
  recentOccurrences: FailurePatternOccurrence[];
  /** Daily counts for the trailing 14 UTC calendar days (inclusive of today), oldest first. */
  trend: FailurePatternTrendPoint[];
}
