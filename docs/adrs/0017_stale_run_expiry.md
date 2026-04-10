# ADR-0017 — Stale Run Expiry via Daily Cron

**Status:** Accepted  
**Date:** 2026-04-10

## Context

Runs that crash without calling `run.complete()` or `run.fail()` remain in `running`
status indefinitely. Operators had to patch these manually via the Convex dashboard.

## Decision

A daily cron job (`expire-stale-runs`, 03:00 UTC) transitions runs stuck in `running`
for more than 24 hours to `timed_out`. The cron uses an `internalAction` that:

1. Queries runs with `status = "running"` and `startedAt < (now - 24h)` via a full-table
   filter scan (no global status index exists; at v1 scale this is acceptable).
2. For each stale run, calls `markRunTimedOut` (internalMutation), which safely patches
   only runs still in `running` status — idempotent for already-terminal runs.
3. Processes at most `STALE_RUN_BATCH_SIZE` (100) runs per invocation. Larger backlogs
   clear over subsequent daily runs.

The cron runs at 03:00 UTC, distinct from the artifact GC cron at 02:00 UTC.

## Consequences

- Operators no longer need to manually patch stuck runs.
- The 24-hour threshold matches the artifact GC orphan threshold for consistency.
- Full-table scan is acceptable at v1 run volumes; if the runs table grows large,
  a `by_status` index would eliminate the scan overhead.
