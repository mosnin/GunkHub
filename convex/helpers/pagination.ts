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

// ---------------------------------------------------------------------------
// ADR-002 — data model expansion. See docs/adr/002-data-model-expansion.md.
// ---------------------------------------------------------------------------

/** Write ceilings for runs.labels (distinct from tags — see ADR-002). */
export const MAX_LABELS_PER_RUN = 10;
export const MAX_LABEL_LENGTH = 40;

/**
 * runs.environment: well-known values (see below) or any custom string up to
 * this length. Not a closed set — see helpers/run_fields.ts.
 */
export const MAX_ENVIRONMENT_LENGTH = 32;
export const KNOWN_ENVIRONMENTS = [
  "production",
  "staging",
  "development",
  "preview",
] as const;

/** runs.sessionId — opaque correlation key, bounded to prevent abuse. */
export const MAX_SESSION_ID_LENGTH = 200;

/** runs.searchText byte budget (UTF-8), enforced by helpers/run_fields.ts. */
export const MAX_SEARCH_TEXT_BYTES = 2 * 1024;

/** Write ceilings for the evals table. */
export const MAX_EVAL_NAME_LENGTH = 80;
export const MAX_EVAL_DETAILS_BYTES = 4 * 1024;

/** Write ceilings for alert_rules.channels. */
export const MAX_ALERT_CHANNELS = 5;

/** Closed set size for webhook_targets.events (run.completed/run.failed/eval.failed/alert.fired). */
export const MAX_WEBHOOK_EVENTS = 4;

/**
 * computeDailyRollups cron bounds: orgs examined per sweep, agents examined
 * per org, and the bounded runs-per-agent-per-day sample used to compute
 * counts and (approximate, for oversized samples) duration percentiles.
 */
export const ROLLUP_MAX_ORGS_PER_SWEEP = 1_000;
export const ROLLUP_MAX_AGENTS_PER_ORG = 200;
export const ROLLUP_MAX_RUNS_SAMPLE = 5_000;

/**
 * Approximate usage-counter flush stride (usage_counters), mirroring
 * sdk_ingest.ts's RATE_FLUSH_STRIDE: single-unit ingest calls flush the
 * counter only ~1-in-STRIDE times (scaled up by STRIDE when flushed); batch
 * calls always flush exactly.
 */
export const USAGE_FLUSH_STRIDE = 10;

// ---------------------------------------------------------------------------
// Cycle 2 — action layer (docs/design/action_layer.md): alert evaluation,
// webhook delivery, the key-authed read API, and eval auto-run.
// ---------------------------------------------------------------------------

/**
 * Bounded sample of recent runs examined by the `failure_rate` alert-rule
 * condition (convex/alert_engine.ts). Mirrors ROLLUP_MAX_RUNS_SAMPLE's
 * rationale: an approximate rate computed from a bounded window is
 * sufficient for an alert threshold, and avoids an unbounded scan of a busy
 * org's run history.
 */
export const ALERT_FAILURE_RATE_SAMPLE_SIZE = 1_000;

/** Batch size for one deliverPendingWebhooks cron invocation (convex/webhook_engine.ts). */
export const WEBHOOK_DELIVERY_BATCH_SIZE = 50;

/**
 * Maximum delivery attempts before a webhook_deliveries row is marked
 * terminally "failed" (no further retries scheduled). Attempt 1 is the
 * initial send; attempts 2-6 are retries with computeBackoff delay.
 */
export const WEBHOOK_MAX_ATTEMPTS = 6;

/** Write ceiling for agent_versions.evalRules (ADR-002 follow-up / Cycle 2). */
export const MAX_EVAL_RULES_PER_VERSION = 20;

// ---------------------------------------------------------------------------
// Cycle 3 — cross-wiring & cohesion (read-scope keys, exact version compare,
// cost-accuracy model denormalization, the deferred alert-email path).
// ---------------------------------------------------------------------------

/**
 * Write ceiling for runs.modelsSeen: bounded, deduped list of model strings
 * extracted from this run's llm.request/llm.response payloads. A run legit­
 * imately touching more than 10 distinct models in one execution is already
 * far outside normal usage; the cap exists so a pathological/malformed
 * payload stream cannot grow the field without bound.
 */
export const MAX_MODELS_SEEN_PER_RUN = 10;

/** Batch size for one deliverPendingEmails cron invocation (convex/email_engine.ts). */
export const EMAIL_DELIVERY_BATCH_SIZE = 50;

/**
 * Maximum delivery attempts before an email_deliveries row is marked
 * terminally "failed" (no further retries scheduled). Mirrors
 * WEBHOOK_MAX_ATTEMPTS's rationale.
 */
export const EMAIL_MAX_ATTEMPTS = 6;
