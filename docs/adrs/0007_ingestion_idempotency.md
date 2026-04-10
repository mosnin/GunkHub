# ADR-0007: Ingestion Idempotency for Duplicate Events

## Status

Accepted

## Date

2026-04-10

## Context

The Agent Flight Recorder SDK sends events to the backend via the `/api/events` endpoint. Like any distributed system, the SDK may encounter transient failures (network timeouts, server errors) during event submission.

When a flush operation (batch event submission) fails, the SDK retries with the same batch of events. This is the correct behavior for reliability, but it introduces the risk of duplicate events being inserted if the first attempt partially succeeded.

The question is: how should the backend handle a request to insert an event that was already inserted in a previous request?

## Decision

The `sdkCreateEvents` mutation is **idempotent**: if an event with the same `(runId, sequenceNumber)` already exists, the mutation returns the existing event's ID instead of inserting a duplicate.

The idempotency key is the tuple `(runId, sequenceNumber)`. The Convex index `by_run` is defined as `["runId", "sequenceNumber"]` to enable O(1) lookup of existing events.

When the mutation processes an event:

1. **Query for existing**: Check if an event with the same `(runId, sequenceNumber)` already exists using the `by_run` index.
2. **If found**: Return the existing event's ID without inserting or modifying anything.
3. **If not found**: Insert the event and return the new event's ID.

No error is thrown on duplicate. The caller receives the same event ID whether the event was newly inserted or already existed.

## Rationale

### SDK retry semantics match event semantics

The SDK sends events in order with contiguous sequence numbers starting from 1. Each event is uniquely identified within a run by its `sequenceNumber`. The SDK never intentionally sends the same event twice; duplicates only occur due to retry logic after a transient failure.

By making the mutation idempotent, we align the backend behavior with the SDK's retry semantics: retrying a failed flush is safe and produces the same outcome as if the flush had succeeded on the first attempt.

### Convex index enables efficient duplicate detection

The `by_run` index on `["runId", "sequenceNumber"]` allows a unique lookup in O(1) time. Without this index, detecting duplicates would require a scan of all events in the run, which is O(n) and costly.

The index is defined during schema setup and is automatically maintained by Convex as events are inserted.

### No corruption or data loss

Idempotency is a safety measure: if a flush fails and is retried, the customer's run is not corrupted by duplicate events or inconsistent state. The event log remains clean and append-only.

### Retry behavior is not visible to the user

The application and replay logic do not need to know about or handle retries. The mutation ensures that retries are transparent: the customer's run looks the same whether the SDK's first attempt succeeded or required a retry.

### Handles SDK transient failures without requiring coordination

The SDK does not need to track which flushes have succeeded or maintain a deduplication table. It simply retries on failure, and the backend's idempotency ensures no duplicates are created. This simplifies the SDK and reduces its operational burden.

## Consequences

### Positive

- SDK retries are safe and transparent. Transient failures do not corrupt the run.
- The `by_run` index is simple and efficient.
- Idempotency is implemented close to the event source (in the mutation), reducing the surface area for bugs.
- No additional coordination or state tracking is required in the SDK.
- The event log remains clean and append-only, with no duplicate records.
- If the SDK retries with the same sequence number, the application always sees a consistent view of the run.

### Negative

- The mutation must perform an index lookup before every insert, adding a small latency cost even for non-duplicate events.
- If the SDK sends the same `sequenceNumber` for two logically different events (a bug in the SDK), the second will be silently ignored. This could mask a serious SDK bug. (See mitigations below.)

### Risk: Silent SDK bugs

If the SDK has a bug that causes it to reuse `sequenceNumber` values incorrectly (e.g., two different events with the same sequence number in the same run), idempotency will silently ignore the second event. This could result in a corrupted or incomplete event log that is difficult to debug.

Mitigations:

1. **SDK unit tests**: The SDK should have tests that verify `sequenceNumber` is unique and contiguous for each run.
2. **Application validation**: The web application should validate that `sequenceNumber` is contiguous when replaying or analyzing a run. A gap or duplicate should log a warning.
3. **Run integrity check**: A periodic background job (v1.1) could check all runs for sequence number gaps or duplicates and alert on anomalies.

## Alternatives Considered

### 1. Error on duplicate — return HTTP 409 Conflict

**Rejected.** Returning an error on duplicate would force the SDK to handle duplicates specially:
- The SDK would need to track which events were already submitted and avoid retrying them.
- If the SDK does not track state correctly, it could get stuck in an error loop.
- The caller (user code) would need to handle the 409 response, adding complexity.
- For transient failures (the normal case), this approach requires the SDK to retry until success, which is more complex than simply retrying the entire batch.

### 2. Unique constraint in Convex schema

**Rejected.** Convex does not support unique constraints in the traditional database sense. The `by_run` index allows efficient lookup but does not enforce uniqueness at the schema level.
- Adding unique constraint validation in the mutation handler is the Convex-compatible approach.
- The idempotent approach is semantically equivalent to a unique constraint but is explicit and testable.

### 3. Skip idempotency validation

**Rejected.** Relying on the SDK to never send duplicates is unsafe:
- SDKs can have bugs. Network failures are unpredictable.
- Without idempotency, a transient failure that partially succeeds could corrupt the event log.
- The cost of idempotency (one index lookup per event) is small compared to the cost of data corruption.

### 4. Idempotency key based on event content hash

**Rejected.** Using a hash of the entire event payload as the idempotency key would be more flexible but adds complexity:
- Calculating the hash is computationally more expensive than a simple `(runId, sequenceNumber)` lookup.
- The hash could change due to field ordering or serialization differences, leading to false negatives.
- The SDK's sequence number is already a unique, stable identifier within a run. Using it is simpler and sufficient.

## Idempotency Semantics and Ordering

This idempotency design assumes that the SDK sends events in order and does not reorder them. If a flush fails and is retried, all events in the flush are retried together, maintaining the original order.

The idempotency check does **not** handle out-of-order delivery of different events (e.g., event B arriving before event A). This is not a concern because:

1. The SDK sends events in order in a single flush.
2. Network delivery is typically in-order for a single TCP connection.
3. If out-of-order delivery were to occur, it would indicate a more serious infrastructure failure, not a transient retry scenario.

If out-of-order delivery becomes a concern in the future, the idempotency logic can be extended to detect and handle reordering (deferred to v1.1 with a specific use case).

## Related ADRs

- ADR-0002: Event Log Is Canonical and Append-Only
- ADR-0005: On-Demand Replay and Diff Projection Strategy
- ADR-0006: Artifact Externalization Policy
