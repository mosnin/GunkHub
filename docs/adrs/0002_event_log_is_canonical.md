# ADR 0002: Event Log Is the Canonical Source of Truth

**Status:** Accepted
**Date:** April 2026
**Deciders:** Team A (Platform), Team B (Data)

---

## Context

Agent Flight Recorder records agent executions. A "run" produces structured records of what happened: LLM requests, tool calls, errors, outputs. These records need to be stored and later queried for inspection, replay, and comparison.

There are two broad approaches to storing agent execution data:

1. **State-based storage:** Store the current state of the run (status, output, error), and update it as the run progresses. Events are secondary or derived.
2. **Event-sourced storage:** Store an immutable sequence of events. Derived data (run status, output, eventCount) is a projection computed from the event log.

We need to decide which approach is canonical — i.e., which data is the truth that all other data is derived from.

---

## Decision

**The event log is the canonical source of truth.** All other data about a run (status, output, error, duration, event count) is a projection derived from the event sequence.

Concretely:
- The `events` table in Convex is **append-only and immutable**. No mutation may delete, update, or backfill an event record after it is written.
- Sequence numbers (`seq`) are monotonically increasing per run, starting at 1.
- The `runs` table is a **mutable projection**. Its fields (status, completedAt, output, error, eventCount) are updated by Convex mutations that process incoming events. If the projection is ever inconsistent with the event log, the event log wins.
- **Replay is a read-only operation.** It reads the event sequence and simulates execution in the UI. It does not write new events.
- **Diff is a read-only comparison.** It reads two event sequences and computes differences. It does not write new events.

---

## Alternatives Considered

### Option A: State-based with event log as secondary

Store the run state as the primary record (a mutable `runs` document with status, output, error). Log events as a secondary record for debugging purposes only.

**Rejected because:**
- The run state can be updated independently of the event log, creating silent inconsistencies
- "Debugging purposes only" records tend to be neglected — they become incomplete and untrustworthy
- Replay and diff require the full event sequence; if events are secondary, they may be incomplete

### Option B: Pure event sourcing with no projection

Store only events. Compute all read models on-the-fly by replaying the event sequence.

**Rejected for v1 because:**
- Convex does not have built-in event sourcing / CQRS infrastructure
- Listing runs filtered by status would require replaying all events — prohibitively expensive
- The projection (runs table) is small and simple in v1; keeping it is the right trade-off

### Option C (chosen): Event log canonical, runs table as projection

The event log is the truth. The runs table is a maintained projection. This combines the integrity guarantees of event sourcing with the query efficiency of a materialized view.

---

## Consequences

### Positive

- **Audit trail:** The event log is a complete, tamper-evident audit trail of every agent execution. Regulators, customers, and post-mortem teams can trust it.
- **Replay and diff are natural:** Both features are pure read operations on the event sequence. They never require writing new data.
- **Decoupled:** The runs projection can be rebuilt from the event log if it is ever corrupted. The reverse is not possible.
- **Debugging is easier:** Engineers inspecting a failure can always go to the raw event sequence, even if the run summary is wrong.

### Negative / Trade-offs

- **Two sources of data to keep in sync:** The ingest mutation must update both the events table and the runs table. A bug could leave them inconsistent.
- **No event deletion:** Even if an agent records sensitive data in an event payload, we cannot delete the event. Mitigations: payload encryption, or stripping sensitive fields before writing (SDK responsibility).
- **Schema changes require care:** Adding a field to the Event type is safe (old events won't have it). Removing or renaming a field is a breaking change that affects all historical events.

### Invariants Established by This Decision

- No Convex mutation may `db.delete()` or `db.patch()` a record in the `events` table.
- The `seq` field on events must be validated as monotonically increasing (per run) by the ingest mutation.
- Any projection computed from events (runs table, aggregations) must be derivable from the event log alone.
- Adding a new `EventKind` value requires an ADR (to ensure all switch statements are updated).
- Replay and diff features are implemented as pure read paths — zero writes.

### Implementation Notes

The ingest mutation in Convex must:
1. Fetch the current max `seq` for the run.
2. Validate that incoming events have contiguous `seq` values starting from `maxSeq + 1`.
3. Insert all events atomically in a single Convex transaction.
4. Update the runs projection (status, completedAt, eventCount) in the same transaction.

This ensures the event log and the projection are always updated together and are never out of sync due to partial writes.
