# ADR-0005: On-Demand Replay and Diff Projection Strategy

## Status

Accepted

## Date

2026-04-09

## Context

The Agent Flight Recorder system records runs as an immutable, append-only event log in Convex. The explainability layer — replay, failure summary, and diff — must present derived views over this canonical data for engineers debugging agent executions.

Three derived views are needed:

1. **ReplayProjection** — a frame-by-frame walk through the event sequence, with actor categorization, timestamps, nesting depth, and payload previews.
2. **FailureSummary** — a deterministic heuristic analysis of which events caused a run to fail.
3. **RunDiff** — a position-aligned comparison of two runs' event logs showing what changed.

The question is where and when to compute these projections: on-demand at request time, or materialized and stored when events are ingested.

## Decision

Compute replay, failure summary, and diff projections **on-demand at request time** in the web application service layer. Do not materialize or cache projection results.

The projection functions live in `apps/web/src/lib/replay/`:

- `projection.ts` — exports `buildReplayProjection(run, events): ReplayProjection`
- `failure.ts` — exports `buildFailureSummary(run, events): FailureSummary`
- `diff.ts` — exports `buildRunDiff(leftRunId, rightRunId, leftEvents, rightEvents): RunDiff`

All three are pure functions with no side effects. They read from the canonical event log and return a derived view. They never write back to Convex or any other store.

## Rationale

### Event counts are small in v1

For v1, the typical run has fewer than 500 events. At this scale, projection computation is dominated by the Convex fetch latency, not by the computation itself. Sorting 500 events and iterating over them is microseconds on any modern server.

### Avoids cache invalidation complexity

If projections were materialized, they would need to be invalidated and recomputed whenever the underlying events changed — even though the event log is append-only (not mutable), a new event being appended to a run would still require refreshing any cached projection. The invalidation logic would add complexity for no user-visible benefit at v1 scale.

### Canonical event log remains the single source of truth

The event log is described in ADR-0002 as append-only and immutable. Storing projections would create a second authoritative copy of the same information, which violates this principle. If the projection logic changes (e.g., depth calculation is refined, actor mapping is extended), the stored projections would be stale until recomputed. On-demand computation means the projection always reflects the latest logic.

### Pure functions are testable without a running server

All three projection functions are pure: given the same input, they always produce the same output. This makes them trivially testable with unit tests that inject fixture data (see `tests/unit/replay.test.ts`, `failure.test.ts`, `diff.test.ts`). No server, no database, no Convex deployment required to run the test suite.

### Materialized projections would require mutation paths near the event log

The Convex mutation that creates events would need to trigger projection materialization. This adds write-path coupling near the append-only event log, increasing the surface area for bugs near the most critical invariant in the system.

## Consequences

### Positive

- Projection logic is simple, self-contained, and fully tested.
- No cache invalidation logic required.
- Event log remains the only source of truth.
- Changing projection logic (e.g., new actor categories, better payload previews) takes effect immediately for all runs without a migration.
- Unit tests for projection algorithms run in milliseconds with no external dependencies.

### Negative

- Projection computation happens on every request. For v1 scale this is fine; at >10,000 events per run it could add meaningful latency.
- The Convex event fetch may require multiple paginated requests for large runs. This fetch latency, not the computation itself, will be the bottleneck if event counts grow.

### Risk: large runs

If event counts grow to >10,000 events per run, pagination becomes the bottleneck. At that point, HTTP-layer response caching (e.g., `Cache-Control: max-age=60` on GET endpoints) is the first mitigation to reach for, before investing in a materialization system.

## Diff Alignment Strategy

Events in two runs are aligned by position (zero-based array index after sorting by `sequenceNumber`). This means:

- `sequenceNumber = 1` in run A is compared to `sequenceNumber = 1` in run B.
- Position-based alignment is equivalent to sequence-number-based alignment for well-formed runs (where sequence numbers start at 1 and are contiguous).
- If the runs have different lengths, extra events in the longer run are surfaced as `kind = "added"` or `kind = "removed"`.

This strategy is simple and predictable. It is optimal when comparing two runs that executed the same logical steps. It produces noisy diffs when the step count differs significantly between runs — but this is informative, not wrong.

## Payload Comparison

v1 uses `JSON.stringify` deep equality for payload comparison in the diff algorithm. This is:

- **Deterministic**: given the same payload, always produces the same result.
- **Simple**: no external library dependencies.
- **Order-sensitive**: objects whose keys are in different orders will appear as different. This is an acceptable limitation for v1 — the SDK constructs payloads using typed builders that produce stable key order.

This limitation is documented in `diff.ts`. If field-order-insensitive comparison is needed, it can be added by sorting object keys before stringifying, or by switching to a deep-equality library.

## Alternatives Considered

### 1. Materialize projections to Convex on event ingestion

**Rejected.** This would require a Convex mutation to compute and store a projection whenever a new event arrives. This:
- Adds write-path complexity near the append-only event log.
- Creates stale projections when the projection algorithm changes.
- Introduces a second source of truth for the same information.
- Complicates the Convex function surface for no measurable benefit at v1 scale.

### 2. Cache projections in Redis

**Rejected.** No Redis is in the v1 stack. Adding Redis as an infrastructure dependency solely for projection caching is premature optimization. If caching becomes necessary, the HTTP response cache layer (e.g., Vercel Edge caching or `Cache-Control` headers) is the correct first step, not a separate stateful cache.

### 3. Compute projections in Convex queries

**Rejected.** Convex query functions run in the Convex runtime, which has constraints on compute time and does not have native JavaScript array utilities. Moving projection logic there would make it harder to test, harder to iterate on, and harder to port to a different backend in the future. The web app service layer is the right place for this derived computation.

## Related ADRs

- ADR-0002: Event Log Is Canonical and Append-Only
- ADR-0004: Shared Contracts Package as Single Type Source
