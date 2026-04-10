# ADR-0008: On-Demand Projection Execution Model

## Status

Accepted

## Date

2026-04-10

## Context

Agent Flight Recorder computes three derived views over its canonical event log:

1. **ReplayProjection** — a frame-by-frame walk through the event sequence, with actor categorization, timestamps, nesting depth, and payload previews.
2. **FailureSummary** — a deterministic heuristic analysis of which events caused a run to fail.
3. **RunDiff** — a position-aligned comparison of two runs' event logs showing what changed between them.

ADR-0005 established that these projections are computed on-demand at request time and never materialized. As the project approaches its v1 release candidate stage (Prompt 5), this decision requires a formal document that:

- Explicitly names "on-demand only" as the v1 architecture commitment, not merely the default.
- Defines what "rebuild" means operationally so tooling can be written against a stable contract.
- Records the alternatives considered and why they were rejected, so future contributors understand the tradeoff space.

Three execution models were evaluated:

### Option A: On-demand (chosen)

Projection functions are called at request time on the canonical events fetched from Convex. Nothing is stored. "Rebuilding" a projection means calling the pure function again on the same inputs.

### Option B: Materialized Convex snapshots

When a run completes (or when each new event arrives), a Convex mutation computes and stores the projection as a Convex document. Reads become a single document fetch rather than an event list fetch plus computation.

### Option C: Hybrid — HTTP response cache

Projections are computed on-demand but the HTTP response is cached at the edge (e.g., Vercel's CDN or `Cache-Control: max-age=60`) for reads of completed runs. Compute still happens on cache miss; repeat reads are served from cache without Convex involvement.

## Decision

**On-demand computation only for v1.** Projections are never materialized, never cached, never stored. Every request that needs a projection calls the pure function on the canonical events retrieved from Convex.

The projection functions live in `apps/web/src/lib/replay/`:

- `projection.ts` — `buildReplayProjection(run, events): ReplayProjection`
- `failure.ts` — `buildFailureSummary(run, events): FailureSummary`
- `diff.ts` — `buildRunDiff(leftRunId, rightRunId, leftEvents, rightEvents): RunDiff`
- `verify.ts` — `verifyProjectionIntegrity(run, events): ProjectionVerifyResult`

All four are pure functions: given the same inputs, they always produce the same outputs. They have no side effects and make no network calls.

### Rebuild semantics

"Rebuilding" a projection is the act of calling the pure function on the canonical event log. There is no stored projection to invalidate, recompute, or migrate. A rebuild is operationally identical to a first-time computation. The `scripts/rebuild-projection.ts` script demonstrates this: it accepts a run and its events, calls `verifyProjectionIntegrity`, and prints a formatted report. No Convex connection is required.

## Rationale

### Event counts are small in v1

The typical v1 run has fewer than 500 events. Sorting 500 events and computing a projection takes microseconds on any modern server. The Convex fetch latency dominates, not the computation. Optimization is premature at this scale.

### Avoids cache invalidation

Even with an append-only event log, a run in progress receives new events as it executes. Any materialized projection would be stale by the time the next event arrives. Invalidation logic adds complexity and a new failure mode (stale reads) for no user-visible benefit at v1 scale.

### Event log remains the sole source of truth

ADR-0002 establishes that the event log is the canonical source of truth and that derived views must never be stored back. Materializing a projection creates a second copy of the same information. When the projection algorithm changes — and it will, as actor mappings and payload previews are refined — stored projections would be stale until explicitly recomputed. On-demand computation means every request reflects the latest algorithm without any migration.

### Pure functions are testable without infrastructure

All four projection functions are testable with `vitest` and fixture data. No Convex deployment, no Next.js server, no HTTP layer required. This is critical for fast iteration on algorithm correctness. The test suite in `tests/unit/` can validate projection behavior in milliseconds.

### Materialized projections add write-path coupling near the event log

ADR-0002 treats the event log as the most critical invariant in the system. Any mutation that triggers projection materialization on event insertion adds complexity at the write path closest to that invariant. This increases the surface area for bugs near the least tolerant part of the codebase.

### Integrity verification confirms the model is self-consistent

The `verifyProjectionIntegrity` function added in this prompt provides explicit proof that on-demand computation is reliable: given the canonical events, the projection can be independently verified at any time, on any machine, without a running server. This eliminates the need for stored checksums or materialized snapshots as integrity signals.

## Consequences

### Positive

- Projection logic is simple, self-contained, and fully covered by unit tests.
- No cache invalidation, no migration tooling, no snapshot lifecycle management.
- Changing projection logic takes effect immediately for all runs without a deployment migration.
- "Rebuild" is a pure function call — the CLI script in `scripts/rebuild-projection.ts` can verify any run exported from the Convex dashboard without a live system.
- Event log integrity is independently verifiable via `verifyProjectionIntegrity`, which checks sequence contiguity, duplicate detection, and projection correctness in one pass.

### Negative

- Projection computation happens on every request. For runs with >1,000 events, Convex pagination adds round-trips that increase latency.
- Runs with >10,000 events will experience noticeable latency before a page renders. This is the risk boundary for the on-demand model.

## Risk: Runs with Many Events

For runs exceeding 10,000 events, on-demand computation adds meaningful latency:

1. Convex pagination: fetching 10,000 events requires multiple paginated queries.
2. Sorting and iterating: O(n) across 10,000 events is fast but not free.

**Mitigation before investing in materialization:** Add `Cache-Control: max-age=60` (or `s-maxage=60` for CDN caching) to GET endpoints for completed runs. A completed run's event log is immutable, so the cached projection is always correct until evicted. This adds edge-layer caching with zero backend complexity and defers the need for materialization until runs routinely exceed 10,000 events.

**Threshold for revisiting this ADR:** If p95 projection latency for completed runs exceeds 2 seconds after HTTP caching is in place, write a new ADR proposing materialized snapshots. Do not implement materialization speculatively.

## Alternatives Considered

### Option B: Materialized Convex snapshots

**Rejected for v1.** Storing projections in Convex would:

- Require a Convex mutation to compute and store a projection whenever a new event arrives, adding write-path coupling near the append-only event log.
- Create stale projections whenever the projection algorithm changes, requiring a migration job to recompute all stored projections.
- Introduce a second source of truth for the same information, violating ADR-0002.
- Add infrastructure and operational complexity (migration tooling, snapshot lifecycle, invalidation logic) for no user-visible improvement at v1 scale.

Materialized snapshots are a valid v2 strategy if event counts grow beyond the HTTP caching threshold. An additive migration path exists: compute projections on demand, write them to a new `projection_snapshots` table, and read from the snapshot if present. This does not require changing the event log or the existing mutation surface.

### Option C: Redis cache

**Rejected.** Redis is not in the v1 stack. Adding Redis as an infrastructure dependency solely for projection caching is premature optimization. The correct first step is HTTP response caching at the edge, which requires no new infrastructure. Redis would be appropriate only if HTTP caching proves insufficient and before materializing to Convex.

### Option D: Compute projections in Convex queries

**Rejected.** Convex query functions run in the Convex runtime, which constrains compute time and lacks the full JavaScript standard library. Moving projection logic to Convex would:

- Make algorithms harder to test (requires a running Convex dev deployment).
- Constrain algorithm choices to what the Convex runtime supports.
- Couple the projection logic to the backend infrastructure, making it harder to port or replace in the future.

The web app service layer (`apps/web/src/lib/replay/`) is the correct location for derived computation over fetched data.

## Related ADRs

- ADR-0002: Event Log Is Canonical and Append-Only — establishes that derived views must never be stored back; this ADR operationalizes that rule for projections specifically.
- ADR-0005: On-Demand Replay and Diff Projection Strategy — the prior decision this ADR formalizes as an explicit v1 commitment with rebuild semantics defined.
