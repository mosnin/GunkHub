# ADR-0019 — Agent Version Identity Model

**Status:** Accepted  
**Date:** 2026-04-10

## Context

Agent Flight Recorder records every run against a specific agent version. For
debuggability, it must be possible to determine exactly what configuration was
active when a run was executed. This requires a stable identity model for agent
versions.

Three design questions needed answers before implementing the `agent_versions`
table and its surrounding backend:

1. How is version uniqueness enforced?
2. What shape does the configuration snapshot take?
3. How does a run know which version it ran against?

---

## Decision 1 — Version string is unique per agent; enforced in the mutation, not as a DB index

Version uniqueness within an agent is checked at mutation time by querying the
`by_agent` index, collecting all existing versions, and comparing the trimmed
version string. A Convex DB-level unique index is not used.

### Rationale

Convex does not support compound unique indexes across multiple columns in its
current stable API. A unique index on `["agentId", "version"]` is not expressible
in the schema validator DSL. The mutation-level check is therefore the only
available mechanism without adding a separate dedup table.

The check is safe because Convex mutations run serially within a project. There
is no window for a concurrent insert to slip through between the uniqueness check
and the insert in normal operation.

### Consequences

- A future Convex release that supports compound unique indexes could replace
  this with a schema-level constraint and remove the query-inside-mutation pattern.
- Tests for duplicate version creation must use sequential (not concurrent) calls.
- If this codebase is ever ported to a backend with true concurrent mutations
  (e.g., PostgreSQL), a unique index must be added at the database level.

---

## Decision 2 — Config snapshot is `v.any()` — free-form JSON for v1

The `configSnapshot` field on `agent_versions` is `v.optional(v.any())` in the
Convex schema and `Record<string, unknown>` in the contracts type.

### Rationale

Agent configurations are heterogeneous. A Python tool-calling agent has a
different configuration shape than a document retrieval agent. Locking the
snapshot into a rigid schema would force every agent author to conform to a
structure that may not match their architecture.

`v.any()` is used here as a justified exception to the general rule (which
reserves `v.any()` for `events.payload`). Unlike event payloads — which have
a well-known discriminated union shape the validator DSL cannot express — the
agent config snapshot is genuinely unstructured in v1 and no union is being
elided.

In `packages/contracts`, `configSnapshot` is typed as `Record<string, unknown>`
rather than `unknown` to require callers to provide an object (not a scalar) and
to allow property access without casts on the receiving end.

### Consequences

- Callers can store arbitrary JSON under `configSnapshot`. No schema validation
  occurs beyond "it must be a JSON-serializable value."
- If a future version needs to query or index specific sub-fields of
  `configSnapshot`, a migration will be required to add typed fields alongside
  or instead of the free-form snapshot.
- The field is optional. Runs that self-attribute to an agent version without a
  snapshot are valid; the missing snapshot simply means the configuration was not
  captured at version creation time.

---

## Decision 3 — No "active version" marker on the agent record; runs self-attribute at creation time

There is no `activeVersionId` or `latestVersionId` field on the `agents` table.
Instead, each `Run` record stores an optional `agentVersionId` that was supplied
by the SDK at run creation time.

### Rationale

An "active version" pointer on the agent creates a sync problem: if the pointer
is updated concurrently with a run being created, the run might be attributed to
a version that was not in effect when it started. Runs are the ground truth for
which version was executing. Letting the SDK supply the version ID at `createRun`
time makes the attribution a fact set at the moment the run begins, not derived
from a pointer that could change afterward.

Showing "the current version" in the UI is a read-time computation: query
`agent_versions` ordered descending by `createdAt` for the given agent, and take
the first result. This is cheap and always correct.

### Consequences

- The UI cannot display "runs on active version" vs "runs on stale version"
  without a query-time comparison. This is acceptable for v1.
- If a future release adds a concept of promoted/pinned versions, an
  `activeVersionId` field can be added to the `agents` table at that point as an
  optional field, with a documented promotion mutation. This ADR should be
  revisited at that time.
- SDK authors must capture and supply the version ID when starting a run. If they
  omit it, the run is stored with `agentVersionId: undefined` and appears as
  "version unknown" in the UI.
