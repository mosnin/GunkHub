# ADR-0020: Scheduled Projection Integrity Verification Scope

## Status

Accepted

## Date

2026-04-11

## Context

Agent Flight Recorder stores runs as immutable, append-only event logs (ADR-0002). The
replay projection (ADR-0005) is computed on-demand from the event log by the pure function
`buildReplayProjection`. If the event log for a run contains sequence gaps or duplicates,
the projection will be computed over corrupt input, producing misleading replay frames or
silently skipping events.

Before Prompt 19, integrity was only verifiable via an on-demand CLI tool
(`scripts/rebuild-projection.ts`). An engineer had to know a specific run ID and invoke
the script manually. There was no proactive signal that corruption had occurred in
production.

The on-demand script (`rebuild-projection.ts`) calls
`verifyProjectionIntegrity(run, events)` from `apps/web/src/lib/replay/verify.ts`, which
runs `buildReplayProjection` in addition to the sequence integrity checks. This is
correct for the CLI use case but not usable from a Convex scheduled action: Convex
actions cannot import modules from `apps/web` because the two runtimes are separate
deployment contexts.

## Decision

Add a Convex scheduled action (`convex/projection_verify.ts`) that runs daily at 04:30
UTC. The action verifies sequence integrity for up to **50** recent terminal runs (those
completed or failed within the past **48 hours**). On each run it checks:

- **Sequence gaps**: monotonically increasing integers starting at 1 must be contiguous
  up to the maximum sequence number.
- **Duplicate sequence numbers**: no two events in the same run may share a sequence
  number.

Results (per-run pass/fail, gap list, duplicate list, summary string) are stored in a
`verification_results` table in Convex for operator inspection.

The bounded scope means the action touches at most 50 runs per execution, regardless of
how many runs exist. The 48-hour window ensures that problems are caught before they age
out of the actionable window.

### What is verified

| Check | Verified? |
|-------|-----------|
| Sequence gaps (missing integers in 1..max) | Yes |
| Duplicate sequence numbers | Yes |
| Event ordering correctness | Implied by gap check |

### What is NOT verified and why

| Check | Reason not verified |
|-------|---------------------|
| `buildReplayProjection` does not throw | The function lives in `apps/web/src/lib/replay/projection.ts`. Convex actions cannot import from `apps/web`. This check is covered by unit tests in `tests/unit/replay.test.ts` and `tests/unit/projection-verify.test.ts`. |
| `buildFailureSummary` does not throw | Same reason as above. Covered by `tests/unit/failure.test.ts`. |
| Frame count matches event count | Requires running the projection. Same import constraint applies. |
| Cross-run structural integrity | Out of scope; runs are independent. |

The sequence gap and duplicate checks are sufficient to detect the class of corruption
that can realistically occur: dropped events from a failed Convex mutation batch, or
duplicate events from an SDK retry storm that bypasses the idempotency key check.

## Rationale

### Bounded scope prevents unbounded scans

The cron touches at most 50 runs per execution (BATCH_LIMIT = 50). Without this bound, a
large number of terminal runs could cause the action to exceed Convex's per-action
timeout. The 50-run bound keeps each cron execution predictable and fast regardless of
run volume.

### 48-hour window catches issues before they age out

Sequence corruption is most actionable immediately after a run completes. A 48-hour
window ensures that if corruption occurs during any given day, the next morning's
(04:30 UTC) cron will detect it. Beyond 48 hours, the run's event log is still correct
and immutable; verification is simply less operationally urgent at that point. The window
prevents the cron from scanning arbitrarily old runs.

### 04:30 UTC timing avoids peak traffic

The cron runs in the low-traffic window between midnight US/Pacific and morning
EU/London. This minimizes contention with live ingestion traffic.

### Inline logic avoids cross-runtime import

The sequence integrity check (`checkSequenceIntegrity`) is implemented inline in
`convex/projection_verify.ts` rather than imported from `apps/web`. This is a deliberate
and documented trade-off: the logic is duplicated into the Convex action to work within
the separate-deployment constraint. The unit tests in `tests/unit/scheduled_verify.test.ts`
inline the same function and assert its behavior, so both copies stay in sync by test
coverage rather than by import.

### verification_results table is the persistence mechanism

The Convex schema includes a `verification_results` table to store per-run outcomes. This
allows operators to query results via the Convex dashboard without needing to parse cron
logs. The table is append-only from the cron's perspective (one record per run per daily
execution).

## Consequences

### Positive

- Proactive daily signal if event log corruption occurs; no manual invocation required.
- Bounded execution time per cron run (at most 50 runs × events per run).
- Results are queryable from the Convex dashboard.
- The sequence integrity logic is fully unit-tested independent of Convex or network
  infrastructure.
- The 48-hour window is shorter than typical on-call response cycles, meaning issues are
  surfaced before they become invisible.

### Negative

- The `checkSequenceIntegrity` function is duplicated: once in
  `convex/projection_verify.ts` and once in `tests/unit/scheduled_verify.test.ts`. If
  the algorithm changes, both files must be updated in the same commit.
- `buildReplayProjection` is NOT called from the cron. If a bug in the projection
  algorithm itself causes exceptions for certain event sequences, the cron will not
  surface it. That class of bug is only caught by unit tests.
- The cron verifies only the 50 most recent terminal runs in the 48-hour window. If more
  than 50 runs complete in a 24-hour period, only the 50 most recent are checked. At v1
  scale this is acceptable.

### Hard to reverse

The `verification_results` table is written into the Convex schema. Once deployed, the
table is a permanent fixture in the Convex database. Removing it requires a Convex schema
migration (dropping the table definition and running a migration to drop existing records)
coordinated with a deployment. Do not add this table unless the cron action is being
deployed in the same change set.

The `listComments` Convex query signature change (adding `orgId` as a required argument)
is a breaking change to the query API surface. Any caller that invoked `listComments`
without `orgId` will receive a validation error after this change. All callers in
`apps/web` have been updated in the same Prompt 19 change set. External callers, if any,
must also be updated.

### Risk: Logic duplication

The `checkSequenceIntegrity` function exists in two places:
1. `convex/projection_verify.ts` — the runtime implementation in the Convex action.
2. `tests/unit/scheduled_verify.test.ts` — inlined for unit testing.

If one copy is updated without the other, the tests will pass but the production behavior
will diverge from the tested behavior. Mitigate: always update both files in the same PR
and include a comment in each file pointing to the other.

## Related ADRs

- **ADR-0002** — Event Log Is Canonical and Append-Only. The verification action reads
  from but never writes to the event log. The `verification_results` table is a separate
  observability store, not a modification of the event log.
- **ADR-0005** — On-Demand Replay and Diff Projection Strategy. The scheduled cron does
  not materialize projections; it only verifies sequence integrity. This is consistent
  with the on-demand projection decision.
- **ADR-0008** — Projection Execution Model. The cron skips running `buildReplayProjection`
  because the function is in `apps/web` context and cannot be imported by a Convex action.
  Unit tests cover the projection execution model instead.
