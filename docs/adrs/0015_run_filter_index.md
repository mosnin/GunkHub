# ADR-0015: Run Filter Compound Index for Status + Date Range Queries

**Status:** Accepted  
**Date:** 2026-04-10  
**Deciders:** Team A

---

## Context

The `listRuns` query in `convex/runs.ts` supports filtering by `orgId`, `projectId`,
`agentId`, `status`, and `startedAfter` (a date range lower bound). Before this change,
`startedAfter` was always applied as an in-memory `.filter()` call, even when the
database could satisfy the predicate via an index range scan.

This means that for a query combining `status` and `startedAfter`, the database would:

1. Locate all runs for the org with the given status via the `by_org_status` index.
2. Load every matching document into memory.
3. Discard all documents where `startedAt < startedAfter`.

The cost of step 2 is O(org runs with that status), not O(result set). For an org with
10,000 "completed" runs, a query for "completed runs started in the last 24 hours" would
load all 10,000 documents even if only 5 match the date predicate.

The existing indexes `by_agent_started` and `by_project_started` already supported range
queries on `startedAt`, but the `listRuns` implementation did not use the range component
— it used these indexes only for the equality prefix and then applied `startedAfter`
in-memory.

---

## Decision

1. **Add a compound index** `by_org_status_started = ["orgId", "status", "startedAt"]`
   to the `runs` table in `convex/schema.ts`. This index supports equality on `orgId`
   and `status` followed by a range scan on `startedAt` — exactly the pattern needed
   for the combined `status + startedAfter` filter.

2. **Rewrite the `listRuns` query branching logic** to select the most specific index
   for the given filter combination and push `startedAfter` into the index range rather
   than the in-memory filter. The priority order is:
   - `agentId` present → `by_agent_started` (range on `startedAt` if provided)
   - `projectId` present → `by_project_started` (range on `startedAt` if provided)
   - `status` + `startedAfter` → `by_org_status_started` (equality + range)
   - `status` only → `by_org_status`
   - `startedAfter` only → `by_org_started` (range on `startedAt`)
   - no filters → `by_org`

3. **Retain the `orgId` safety filter** in the `.filter()` call for all branches. This
   provides a defense-in-depth check against cross-org data leakage when a caller
   supplies an `agentId` or `projectId` that belongs to a different org.

---

## Consequences

### Write overhead

Every run insert now writes one additional index entry (`by_org_status_started`) on top
of the existing seven indexes. This is a fixed, small constant per insert — acceptable
at all expected scale.

### Read performance

| Filter combination | Before | After |
|--------------------|--------|-------|
| No filters | O(org runs) | O(org runs) — unchanged |
| status only | O(org runs with status) | O(org runs with status) — unchanged |
| startedAfter only | O(org runs) | O(org runs after date) |
| status + startedAfter | O(org runs with status) | O(result set) |
| agentId only | O(agent runs) | O(agent runs) — unchanged |
| agentId + startedAfter | O(agent runs) | O(agent runs after date) |
| projectId + startedAfter | O(project runs) | O(project runs after date) |

### Known limitations

- **`agentId + status + startedAfter`**: There is no compound index covering all three
  fields. The `agentId` branch uses `by_agent_started` and relies on in-memory filtering
  for `status`. This is acceptable because agent run sets are typically small (hundreds,
  not millions) and adding a third compound index was judged premature.

- **`projectId + status + startedAfter`**: Same situation as above. If this becomes a
  hot query pattern, a `by_project_status_started` index can be added in a follow-up.

### Why now

Compound indexes are harder to add retroactively once a table is large because Convex
must backfill the index synchronously before it can serve queries. Adding the index at
schema definition time, before any org exceeds ~1,000 runs, avoids a future migration
window. The performance benefit is already observable for orgs with hundreds of runs
and will be necessary for any org operating at production scale.

---

## Alternatives considered

**In-memory filtering (status quo):** Simple but degrades linearly with org run count.
Rejected because the product goal is debuggability at scale.

**Single `by_org_status_started` without rewriting the branching logic:** Would add the
index but not use it. Rejected — the index cost is only justified if the query uses it.

**Full `by_org_status_started` for all status queries (dropping `by_org_status`):**
A range-capable index subsumes the equality-only index in Convex. However, removing
`by_org_status` would be a schema breaking change requiring a migration plan. Deferred.
