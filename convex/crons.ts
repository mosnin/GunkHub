// Convex scheduled jobs for Agent Flight Recorder.
// All jobs run on the UTC timezone defined by hourUTC/minuteUTC.

import { BREAKER_EVALUATION_CADENCE_MS } from "@agent-flight-recorder/contracts";
import { cronJobs , makeFunctionReference } from "convex/server";

const crons = cronJobs();

// Daily orphaned artifact cleanup. Runs at 02:00 UTC.
// The job detects artifacts older than 24 hours with no referencing event
// and deletes both the blob from Vercel Blob storage and the Convex record.
crons.daily(
  "artifact-gc",
  { hourUTC: 2, minuteUTC: 0 },
  makeFunctionReference<"action">("artifact_gc:cleanOrphanedArtifacts"),
);

// Daily stale run expiry. Runs at 03:00 UTC, one hour after artifact GC.
// Transitions runs stuck in "running" for > 24 hours to "timed_out".
crons.daily(
  "expire-stale-runs",
  { hourUTC: 3, minuteUTC: 0 },
  makeFunctionReference<"action">("stale_runs:expireStaleRuns"),
);

// Daily projection integrity verification. Runs at 04:30 UTC.
// Checks sequence contiguity for up to 50 recent terminal runs.
crons.daily(
  "verify-projection-integrity",
  { hourUTC: 4, minuteUTC: 30 },
  makeFunctionReference<"action">("projection_verify:verifyRecentRuns"),
);

// Daily retention enforcement (ADR 001). Runs at 01:00 UTC, before artifact GC,
// so GC sees the post-retention state. Deletes terminal runs older than an org's
// opt-in retentionDays window; orgs without retentionDays are never touched.
crons.daily(
  "enforce-retention",
  { hourUTC: 1, minuteUTC: 0 },
  makeFunctionReference<"action">("retention:enforceRetention"),
);

// Daily rollup computation (ADR-002). Runs at 05:00 UTC, after the other
// daily jobs, so it sees the day's post-retention/post-GC state. Computes
// yesterday's per-agent terminal-run counts, duration percentiles, and token
// totals into daily_rollups.
crons.daily(
  "compute-daily-rollups",
  { hourUTC: 5, minuteUTC: 0 },
  makeFunctionReference<"action">("rollups:computeDailyRollups"),
  {},
);

// Cycle 2 (docs/design/action_layer.md): drain due "pending" webhook
// deliveries (both alert-triggered and the standalone outbound-webhooks
// feature) every minute, in bounded batches (WEBHOOK_DELIVERY_BATCH_SIZE).
crons.interval(
  "deliver-pending-webhooks",
  { minutes: 1 },
  makeFunctionReference<"action">("webhook_engine:deliverPendingWebhooks"),
  {},
);

// Cycle 3 — the email counterpart. Drains due "pending" email_deliveries
// rows (alert-rule email channels) through whichever EmailNotifier
// convex/helpers/notifier.ts's getConfiguredEmailNotifier() resolves to
// (ConsoleEmailNotifier by default; AFR_EMAIL_PROVIDER=resend opts into a
// real send). See convex/email_engine.ts.
crons.interval(
  "deliver-pending-emails",
  { minutes: 1 },
  makeFunctionReference<"action">("email_engine:deliverPendingEmails"),
  {},
);

// Failure Patterns (PREVENTION, cycle 1 + cycle 2) — periodic spike-rollup +
// alerting. Runs every 15 minutes: recomputes each of the most recently
// active patterns' ACCURATE 14-day daily trend (from
// failure_pattern_daily_counts, cycle 2 — no longer a bounded occurrence
// sample), stores a fresh spike assessment on the rollup, and (cycle 2) fires
// a `pattern_spike` alert the moment a pattern transitions from not-spiking
// to spiking, gated by a per-pattern cooldown. Cheap, bounded
// (SPIKE_ROLLUP_MAX_PATTERNS_PER_RUN patterns/tick, each trend read is at
// most TREND_WINDOW_DAYS rows) — see convex/failure_patterns.ts's
// assessPatternSpikesCron and convex/alerts.ts's firePatternSpikeAlert.
crons.interval(
  "assess-failure-pattern-spikes",
  { minutes: 15 },
  makeFunctionReference<"mutation">("failure_patterns:assessPatternSpikesCron"),
  {},
);

// Failure Patterns (ADR-006 cycle 3) — fix-confidence snapshot refresh. Runs
// every 5 minutes and recomputes the stored `lastFixConfidence` verdict for
// the patterns that are DUE, so `read_api.apiListFailurePatterns`' `--state`
// filter can be answered from stored values instead of a per-pattern
// post-resolution exposure scan (which is affordable on one detail page and
// impossible across a 50-pattern list page).
//
// BOUNDED TWICE, never a sweep: at most
// FIX_CONFIDENCE_SNAPSHOT_MAX_PATTERNS_PER_RUN (25) patterns per tick AND at
// most FIX_CONFIDENCE_SNAPSHOT_RUN_ROW_BUDGET (4000) run rows scanned in
// total, whichever binds first. Its index range
// (`by_fix_confidence_refresh`, lower-bounded at 0) contains ONLY patterns
// with a live resolution, so a pattern whose confidence cannot change is
// never read on any tick. Ascending oldest-due-first ordering makes it
// resumable and starvation-free with no cursor: work a bounded tick could not
// reach is by definition the oldest due work next tick.
//
// Transitions that can change a verdict discontinuously — resolve, manual
// reopen, and the regression guard's auto-reopen — recompute EAGERLY and do
// not wait for this cron, so a regression is never stale in the UI between
// ticks. See convex/failure_patterns.ts's snapshotFixConfidenceCron.
crons.interval(
  "snapshot-fix-confidence",
  { minutes: 5 },
  makeFunctionReference<"mutation">("failure_patterns:snapshotFixConfidenceCron"),
  {},
);

// ADR-004 — run explanation coverage repair. Runs every 30 minutes.
//
// Explanation generation is EAGER and fire-and-forget: the four terminal-
// failure sites (convex/events.ts, convex/sdk_ingest.ts, convex/runs.ts
// updateRunStatus, convex/stale_runs.ts) each call
// `ctx.scheduler.runAfter(0, "run_explanations:generateRunExplanation")` once,
// with no retry behind it. A dropped/failed action, a transient
// `heuristic_engine_unavailable` skip, or a run that failed before ADR-004
// shipped therefore leaves the run permanently without an explanation — and
// `getRunExplanation`/`apiGetExplanation` report that as `status: "pending"`,
// which tells the caller (packages/mcp's `afr_explain_run`, apps/web's
// ExplanationPanel) to RETRY LATER. Without this sweep that retry never
// terminates. This job is what makes "pending" a bounded, honest claim.
//
// BOUNDED TWICE, never a sweep, matching verify-projection-integrity's shape:
// the index range (`runs.by_status_started`) is narrowed to ONE terminal
// status AND lower-bounded at now - EXPLANATION_BACKFILL_WINDOW_MS (24h), and
// at most EXPLANATION_BACKFILL_SCAN_LIMIT (250) rows are read per status per
// tick, with at most EXPLANATION_BACKFILL_MAX_SCHEDULES (25) generations fanned
// out in total. Runs that ended within EXPLANATION_BACKFILL_GRACE_MS (10 min)
// are skipped — their eager generation is legitimately still in flight.
// Re-scheduling is harmless: generateRunExplanation is idempotent without
// `force`. See convex/run_explanations.ts's backfillMissingExplanations for
// the acknowledged limit (runs beyond the scan bound are not repaired).
crons.interval(
  "backfill-missing-explanations",
  { minutes: 30 },
  makeFunctionReference<"action">("run_explanations:backfillMissingExplanations"),
  {},
);

// BUDGET CIRCUIT BREAKERS — re-evaluate the stalest enabled breakers.
//
// EVERY MINUTE, and the interval is load-bearing rather than a taste. A budget
// check (`checkBudget` / `sdkCheckBudget`) reads the state THIS job wrote; a
// state older than the breaker's `maxStalenessMs` does not decide, it withholds
// (convex/helpers/budget.ts PART 4). The staleness floor is two minutes —
// deliberately TWICE this interval — so one missed tick does not flip every
// breaker in the deployment to "withhold" at once.
//
// THE FAILURE MODE IS INTENTIONALLY LOUD AND SAFE. If this job stops, budgets do
// not silently become permissive; they stop answering and every cooperating
// caller withholds. That costs honest work during an outage of ours, and it is
// the deliberate choice — the alternative is that our own downtime is the
// reliable way to defeat every budget in the system.
//
// BOUNDED: at most BUDGET_SWEEP_BATCH breakers per tick, taken oldest-evaluated
// first from `budget_breakers.by_enabled_evaluated` with `enabled = true`, so
// disabled breakers cost nothing and a never-evaluated breaker (which is
// currently withholding) is picked up first.
//
// N5 — THE INTERVAL IS DERIVED, NOT WRITTEN DOWN A SECOND TIME.
//
// A `{ minutes: 1 }` literal here and `BREAKER_EVALUATION_CADENCE_MS` in the
// contract are two spellings of one number that nothing forces to agree, and
// `breakerCadenceInvariant()` cannot catch the drift because it only relates
// contract constants to each other. Team D added a test that reads the schedule
// off this export and compares it — which turns the drift red the day someone
// edits one side.
//
// A test that catches drift is strictly worse than a registration that cannot
// drift, so the coupling lives HERE: the schedule is COMPUTED from the contract
// constant. There is now no second literal to get wrong, and Team D's check
// becomes a belt-and-braces confirmation of an equality that holds by
// construction. The assertion below fires at module load rather than letting a
// fractional interval reach the scheduler silently.
const BREAKER_SWEEP_SECONDS = BREAKER_EVALUATION_CADENCE_MS / 1000;
if (!Number.isInteger(BREAKER_SWEEP_SECONDS) || BREAKER_SWEEP_SECONDS <= 0) {
  throw new Error(
    `BREAKER_EVALUATION_CADENCE_MS (${BREAKER_EVALUATION_CADENCE_MS}) must be a positive whole number of seconds to be registrable as a cron interval.`,
  );
}
crons.interval(
  "evaluate-budget-breakers",
  { seconds: BREAKER_SWEEP_SECONDS },
  makeFunctionReference<"action">("budgets:sweepBudgetBreakers"),
  {},
);

export default crons;
