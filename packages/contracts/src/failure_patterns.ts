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
}

/** `getFailurePattern`'s full detail shape: the rollup, a bounded recent-occurrences sample, and a 14-day trend. */
export interface FailurePatternDetail {
  pattern: FailurePattern;
  recentOccurrences: FailurePatternOccurrence[];
  /** Daily counts for the trailing 14 UTC calendar days (inclusive of today), oldest first. */
  trend: FailurePatternTrendPoint[];
}
