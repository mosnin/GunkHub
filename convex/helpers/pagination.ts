export interface PaginationOptions {
  limit: number;
  cursor?: string;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Maximum number of events to include in a single replay projection.
 * Runs exceeding this limit will have their projection truncated and
 * the ReplayProjection.truncated flag set to true.
 */
export const MAX_EVENTS_PER_REPLAY = 10_000;

/**
 * Maximum number of artifact orphan candidates to process in a single GC run.
 * Limits the number of blob DELETE calls and Convex mutations per daily cron invocation.
 * Older candidates (lowest createdAt) are processed first via the by_created_at index.
 */
export const GC_CANDIDATE_PAGE_SIZE = 100;

/**
 * Maximum age of a run in "running" status before it is expired by the daily cron.
 * Runs stuck in "running" for longer than this threshold are transitioned to "timed_out".
 */
export const STALE_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum number of stale runs to expire in a single cron invocation.
 * Mirrors GC_CANDIDATE_PAGE_SIZE for consistency.
 */
export const STALE_RUN_BATCH_SIZE = 100;

/**
 * Write ceiling: maximum events per run. Sequence numbers are contiguous from 1,
 * so `sequenceNumber > MAX_EVENTS_PER_RUN` is an exact, O(1) "run is full" check
 * enforced in both createEvent and sdkCreateEvents. A run at this size is far
 * beyond what the UI can usefully render (MAX_EVENTS_PER_REPLAY is 10k) — the cap
 * exists to stop a runaway agent from growing one run without bound.
 */
export const MAX_EVENTS_PER_RUN = 50_000;

/**
 * Write ceiling: maximum artifact records per run. Checked with a bounded
 * `.take(MAX_ARTIFACTS_PER_RUN)` count on the by_run index — cheap at this size
 * and requires no denormalized counter on the run document.
 */
export const MAX_ARTIFACTS_PER_RUN = 1_000;

/**
 * Default ingest rate limit (events/min) applied to newly created API keys when
 * the caller does not specify one. Explicit values override; pre-existing keys
 * with rateLimitPerMin unset remain unlimited (back-compat).
 */
export const DEFAULT_RATE_LIMIT_PER_MIN = 600;

/**
 * Maximum documents deleted per purge/retention internal-mutation batch
 * (ADR 001). Small enough to stay well inside Convex transaction limits.
 */
export const PURGE_BATCH_SIZE = 100;

/**
 * Write ceiling: maximum comments per target (run or event). Enforced in
 * createComment with a COMMENT_LIMIT_EXCEEDED typed error. Checked with a
 * bounded `.take(MAX_COMMENTS_PER_TARGET)` count on the by_target index.
 */
export const MAX_COMMENTS_PER_TARGET = 500;

/**
 * Artifact GC scan bounds. The GC's pointer scan reads a run's events in pages
 * of GC_EVENT_SCAN_PAGE_SIZE instead of `.collect()`ing them (a ~50k-event run
 * would blow the query read limit). GC_MAX_EVENTS_PER_INVOCATION caps the TOTAL
 * events examined across all candidates in one GC invocation; remaining
 * candidates carry over to the next scheduled run (they stay in the candidate
 * set until resolved).
 */
export const GC_EVENT_SCAN_PAGE_SIZE = 500;
export const GC_MAX_EVENTS_PER_CANDIDATE = 5_000;
export const GC_MAX_EVENTS_PER_INVOCATION = 100_000;

/**
 * Valid range for organizations.retentionDays (ADR 001), enforced by
 * updateRetentionPolicy.
 */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3_650;
