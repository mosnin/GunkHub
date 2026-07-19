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

export default crons;
