// Convex scheduled jobs for Agent Flight Recorder.
// All jobs run on the UTC timezone defined by hourUTC/minuteUTC.

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

// Failure Patterns (PREVENTION, cycle 1) — periodic spike-rollup. Runs every
// 15 minutes: recomputes each of the most recently active patterns' 14-day
// daily trend and stores a fresh spike assessment on the rollup. Cheap,
// bounded (SPIKE_ROLLUP_MAX_PATTERNS_PER_RUN patterns/tick, each a bounded
// occurrences read) — see convex/failure_patterns.ts's
// assessPatternSpikesCron for the read bounds and the "no alert-firing seam
// yet" handoff note.
crons.interval(
  "assess-failure-pattern-spikes",
  { minutes: 15 },
  makeFunctionReference<"mutation">("failure_patterns:assessPatternSpikesCron"),
  {},
);

export default crons;
