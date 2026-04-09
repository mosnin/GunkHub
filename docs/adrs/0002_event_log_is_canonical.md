# ADR 0002: Event Log is the Canonical Source of Truth

**Status:** Accepted  
**Date:** 2026-04-09

---

## Context

Agent Flight Recorder's core purpose is to make agent failures explainable. This requires that the recorded execution data be trustworthy — engineers must be able to rely on the fact that what they're looking at is exactly what happened.

The key question: should the event log be mutable (allowing corrections and updates) or immutable (append-only)?

---

## Decision

**The event log is append-only and immutable. It is the canonical source of truth for all agent execution data.**

Rules that follow from this decision:
1. No `updateEvent` or `deleteEvent` operations exist or will ever exist.
2. Replay and diff are derived projections computed from the event log — they are never stored back.
3. Run status is the only mutable state (pending → running → completed/failed/etc.).
4. Large payloads are externalized to blob storage; the pointer is immutable once stored.
5. If a run needs annotation or correction, use the `comments` table — never modify events.

---

## Rationale

1. **Trust**: If engineers cannot trust that the event log reflects what actually happened, the tool has no value. Mutable events would allow accidental or malicious modification of the historical record.

2. **Correctness of derived views**: Replay and diff depend on events being in a stable, ordered sequence. If events could be modified, cached projections could become stale or incorrect.

3. **Audit semantics**: Agent execution is audit-trail data. "What happened" and "what we think happened" must be the same. Immutability is the correct model.

4. **Simplicity**: Immutable append-only logs eliminate a large class of consistency bugs. There is no need for optimistic locking, conflict resolution, or invalidation of cached projections.

5. **Debuggability**: When investigating a failure, engineers need to know that the sequence they're reading is the actual sequence. Mutations would undermine this confidence.

---

## Consequences

- **Projections must be computed on read**: Replay and diff are computed from events each time. This is acceptable for v1 volumes; caching can be added later without changing the contract.
- **Corrections go in comments**: If an event has incorrect data (e.g., due to an SDK bug), the correct workflow is to add a comment explaining the discrepancy, not to edit the event.
- **SDK must not emit duplicate events**: Because events can't be deleted, the SDK must handle deduplication before submission. Sequence numbers provide ordering guarantees.
- **Storage grows monotonically**: Events are never deleted. TTL/archiving policies can be added in v2 but must preserve immutability during the retention window.

---

## Enforcement Mechanisms

1. **Convex schema comment**: `// IMMUTABILITY: Events must never be updated or deleted.`
2. **CLAUDE.md rule**: Future prompts are forbidden from adding updateEvent or deleteEvent.
3. **Test**: No test should ever call an event mutation other than createEvent.
4. **Code review**: The `.claude/agents/data.md` forbidden behaviors list explicitly prohibits `updateEvent`/`deleteEvent`.

---

## Alternatives Considered

### Option A: Mutable events with history
- **Rejected**: Version history adds complexity and still doesn't achieve the same level of trust. The latest version could still be wrong.

### Option B: Event sourcing with snapshots
- **Rejected**: Snapshots add invalidation complexity and don't provide meaningful benefit at v1 scale.

### Option C: Allow event deletion for PII/GDPR compliance
- **Deferred to v2**: If required, implement a separate redaction mechanism that stores a tombstone rather than deleting. Do not implement in v1.
