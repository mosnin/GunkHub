# ADR-0014: Artifact GC Indexed Range Query and Bounded Batch Processing

- **Date:** 2026-04-10
- **Status:** Accepted

---

## Context

The original `getOrphanCandidates` query calls `.collect()` on the entire `artifacts` table and filters in-process:

```typescript
const all = await ctx.db.query("artifacts").collect();
return all.filter((a) => a._creationTime < cutoff);
```

As artifact volume grows, this becomes a full table scan that could exceed Convex query limits and slow down GC. The 24-hour orphan window means the overwhelming majority of artifacts are NOT candidates on any given day — we are scanning the entire table to find a small, time-bounded subset.

Additionally, calling `.collect()` loads every artifact document into memory before filtering. Convex imposes document count and bandwidth limits per query. A sufficiently large artifact table will cause this query to fail outright.

---

## Decision

### 1. Add a `by_created_at` index to the `artifacts` table

```typescript
.index("by_created_at", ["createdAt"])
```

This allows `getOrphanCandidates` to query only artifacts older than the cutoff, using an index range scan instead of a full table scan.

### 2. Use `withIndex` + `paginate` in `getOrphanCandidates`

```typescript
const page = await ctx.db
  .query("artifacts")
  .withIndex("by_created_at", (q) => q.lt("createdAt", cutoff))
  .paginate({
    numItems: GC_CANDIDATE_PAGE_SIZE,
    cursor: args.cursor ?? null,
  });
```

Oldest artifacts are returned first (ascending `createdAt`). Only `GC_CANDIDATE_PAGE_SIZE` (100) candidates are returned per call.

### 3. Add `GC_CANDIDATE_PAGE_SIZE = 100` to `convex/helpers/pagination.ts`

Centralises the batch size constant next to the existing pagination constants (`DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `MAX_EVENTS_PER_REPLAY`). The value 100 is a round number that provides bounded, predictable work per GC run without leaving orphans to accumulate for unreasonable periods at v1 scale.

### 4. Update `cleanOrphanedArtifacts` to destructure the new return shape

The action now receives `{ candidates, nextCursor }` instead of a bare array. For this prompt the action processes one page per daily invocation and does not follow the cursor — subsequent daily runs drain any remaining backlog naturally.

The final log line and return value change from `candidates=N` to `batch=N` to communicate that processing is intentionally bounded.

---

## Why `createdAt` and not `_creationTime`

Convex user-defined indexes can only index schema-declared fields. The `_creationTime` system field is set by Convex automatically but is not available as an index key in `defineTable` index definitions. The `createdAt` field on the `artifacts` table is set to `Date.now()` at insert time and is functionally equivalent to `_creationTime` for GC purposes.

---

## Bounded Batch Rationale

Processing 100 artifacts per day is sufficient at v1 scale. If orphan accumulation rate exceeds 100/day, the same oldest artifacts remain as candidates on the next run — they are old and unreferenced, so the `by_created_at` index range query will return them again. Over multiple daily runs the backlog is drained.

The `GC_CANDIDATE_PAGE_SIZE` constant is defined in `convex/helpers/pagination.ts` so it can be increased without touching query logic. The value satisfies:

- Greater than 0 (meaningful batch)
- Multiple of 10 (legible, intentional round number)
- At most 500 (prevents accidental timeout of the daily cron action)
- Much less than `MAX_EVENTS_PER_REPLAY = 10,000` (each artifact check scans its run's events)

---

## Consequences

**Positive:**
- GC query is now O(batch_size) instead of O(total_artifacts). At 100 candidates/day and millions of total artifacts, this is a several-orders-of-magnitude improvement.
- Memory usage per GC run is bounded. Previously `.collect()` would load all artifact documents before filtering.
- Consistent query execution time regardless of total artifact volume.

**Neutral / Negative:**
- Schema migration required: the `by_created_at` index must be deployed before the new query runs. Convex handles this automatically in a single `convex deploy` — there is no manual migration step.
- `cleanOrphanedArtifacts` return shape changes: the key `candidates` becomes `batch` in log output and the returned object. This is an internal action return value, not exposed to callers; the change is non-breaking.
- If orphan accumulation significantly exceeds 100/day, cleanup lags behind creation. This is acceptable for v1.

---

## Known Risks

- **Backlog accumulation:** If the orphan accumulation rate sustains above 100/day (e.g., due to a bug that repeatedly uploads blobs without writing events), cleanup will lag. Recommendation: monitor the `batch=100 cleaned=N` log line in the Convex dashboard. If `cleaned` is consistently near `batch`, increase `GC_CANDIDATE_PAGE_SIZE` or add a multi-page loop to `cleanOrphanedArtifacts`.
- **Schema and code deployment ordering:** The new `by_created_at` index must exist before the `withIndex` call runs. Convex deploys schema and functions atomically in a single `convex deploy`, so this is handled correctly as long as schema and function changes are deployed together.
- **`_creationTime` vs `createdAt` drift:** If an artifact insert sets `createdAt` to a value other than `Date.now()` (e.g., a backdated timestamp), the GC age check would use the wrong time. The current `artifacts` mutation sets `createdAt: Date.now()` consistently.
