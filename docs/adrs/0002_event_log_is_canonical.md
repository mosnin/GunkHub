# ADR-0002: Append-Only Event Log is the Canonical Source of Truth

**Status:** Accepted
**Date:** 2026-04-09
**Deciders:** Initial foundation team (Prompt 1)

---

## Context

Agent Flight Recorder's core purpose is to make agent failures explainable. This requires that the recorded execution data be trustworthy — engineers must be able to rely on the fact that what they see in the UI is exactly what happened during execution.

The key question: should the event log be mutable (allowing corrections and updates after the fact) or immutable (append-only, never modified)?

The stakes are high: if the event log can be modified, engineers cannot trust it. A debug session that is based on a modified run trace is potentially worse than no trace at all — it gives false confidence while hiding the real root cause.

### The mutable events option

Allow `updateEvent` and `deleteEvent` mutations. Engineers could correct mistakes, remove sensitive data, or patch incorrect payloads submitted by a buggy SDK version.

### The immutable append-only option (CHOSEN)

Once an event is written, it is permanent. Corrections, annotations, and notes live in the `comments` table. Derived views (replay, diff) are computed fresh from the event log on each read.

---

## Decision

**The event log is append-only and immutable. It is the canonical source of truth for all agent execution data.**

Rules that follow from this decision — all non-negotiable:

1. **No `updateEvent` mutation exists or will ever exist.** If you want to add one, write an ADR first.
2. **No `deleteEvent` mutation exists or will ever exist.** Same rule.
3. **Replay and diff are derived projections computed from the event log on read.** They are never stored back into the database.
4. **Run status is the only mutable state.** The `runs` table is updated as a run progresses through its state machine. This is a special case — status reflects current reality, not historical fact.
5. **Large payloads are externalized via the `artifacts` table.** The Artifact record (blob pointer) is immutable once created — no update or delete.
6. **Corrections and annotations use `comments`.** If an event has incorrect data (e.g., due to a bug in the SDK), the engineer adds a comment explaining the discrepancy. The event record itself is never touched.

---

## Rationale

**Trust is the product's core value.** If an engineer cannot trust that the event log reflects what actually happened, Agent Flight Recorder has no value. A debugging tool that might show you modified data is dangerous. Immutability is a correctness requirement, not a preference.

**Derived views depend on stable input.** `ReplayProjection` and `RunDiff` are computed from the event sequence. If events could be modified after the fact, any cached projections would become stale. Immutable input means derived views are always correct — there is nothing to invalidate.

**Audit semantics are correct.** Agent execution is historical fact. The events table is an audit log of what the agent did. Audit logs are always append-only. This is not a novel idea — it is the established pattern for financial ledgers, medical records, and security logs.

**Simplicity.** Immutable append-only logs eliminate an entire class of consistency bugs: no optimistic locking, no conflict resolution, no "last write wins" races. A `createEvent` mutation either succeeds or fails. There is no partial update to worry about.

**Sequence number integrity.** Events within a run are ordered by monotonically increasing `sequenceNumber`. If events could be deleted or reordered, the sequence would have gaps. The replay timeline depends on a contiguous, gapless sequence. Immutability is the only way to guarantee this.

---

## Consequences

**Projections must be computed on read.** `ReplayProjection` and `RunDiff` are computed from the event list each time they are requested. For v1 run sizes (hundreds to low thousands of events), this is fast enough to compute synchronously. For very long runs (100K+ events, a v2+ scenario), a background projection cache can be added. This does not require changing the event log — it is an additive optimization.

**Corrections go in comments.** If a run has incorrect event data (e.g., a bug in the SDK caused malformed payloads), the engineer adds a `Comment` on the affected event explaining the discrepancy. The event record is not modified. This is the correct workflow: historical fact is preserved, human interpretation is recorded separately.

**SDK deduplication responsibility.** Because events cannot be deleted, the SDK must not emit duplicate events. If a network retry causes the same event to be submitted twice with the same `sequenceNumber`, the backend must detect and reject the duplicate. The `by_run` index on `(runId, sequenceNumber)` provides the enforcement point.

**Storage grows monotonically.** Events are never deleted. Data retention and archiving policies can be added in v2 (automatic TTL after 90 days, cold storage for runs older than 1 year), but must preserve immutability during the retention window. A tombstone pattern (mark as archived, do not delete) is the correct approach if deletion is ever required for compliance.

---

## Enforcement Mechanisms

1. **Convex schema comment:** `convex/schema.ts` has `// IMMUTABILITY: Events must never be updated or deleted.` in a comment above the events table definition.
2. **No mutations defined:** There is no `updateEvent` or `deleteEvent` function in `convex/events.ts`. The only mutation is `createEvent`.
3. **CLAUDE.md rule:** The project constitution explicitly forbids adding these mutations: "The event log is append-only and immutable. Once an event record is written, it is never updated or deleted."
4. **`.claude/agents/data.md` forbidden behavior:** "NEVER add updateEvent or deleteEvent mutations." This rule is visible to the data agent on every session.
5. **Code review expectation:** Any PR that adds an `updateEvent` or `deleteEvent` mutation must be rejected unless accompanied by an ADR that supersedes this one.

---

## Alternatives Considered

### Option A: Mutable events with version history

Allow events to be updated, but keep a history table of previous versions. Engineers could see what changed and when.

Rejected because: version history adds query complexity (which version is "current"?), still does not achieve the same level of trust (the current version could still be wrong relative to the actual execution), and adds infrastructure complexity without a clear v1 need.

### Option B: Event sourcing with materialized snapshots

Store events as the source of truth, but periodically materialize computed snapshots (replay checkpoints) to improve query performance.

Rejected for v1 because: snapshot invalidation is complex, v1 run sizes do not require it, and the snapshot infrastructure can be added additively in v2 without changing the event log model. The `ReplayProjection` type in `packages/contracts` is designed to accommodate a snapshot cache layer in the future.

### Option C: Allow event deletion for PII/GDPR compliance

Some regulated industries require the ability to delete personal data from audit logs. Could we add a `deleteEvent` for compliance?

Deferred to v2. If required, implement a separate redaction mechanism: replace the payload with a tombstone `{ "__redacted": true, "reason": "gdpr_request", "redactedAt": ... }`. This preserves the sequence number and the event's existence in the log while removing the personal data. This is better than deletion because it preserves audit trail integrity. Do not implement in v1.
