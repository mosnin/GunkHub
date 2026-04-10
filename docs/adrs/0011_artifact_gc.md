# ADR-0011: Artifact Garbage Collection

**Status:** Accepted
**Date:** 2026-04-10
**Authors:** Prompt 8 implementation

## Context

ADR-0010 documented a residual risk: if a blob upload to Vercel Blob storage succeeds
and the Convex artifact record is inserted, but the subsequent `POST /api/events` call
fails permanently and is never retried (e.g. process crash), the artifact record exists
in Convex with no event record referencing it. Over time, such orphaned artifact records
accumulate in both Convex document storage and Vercel Blob storage, incurring costs and
adding noise to the data model.

This scenario is distinct from the retry-duplicate case addressed in ADR-0010: that ADR
handles the case where the SDK retries and creates a second artifact record for the same
content. ADR-0011 handles the case where no retry occurs at all — the artifact was
created, but the event that would have referenced it was never written.

A 24-hour safety margin is required because blob upload and event flush are not
atomic: an artifact can legitimately exist without a referencing event for the duration
of one SDK flush cycle (blob upload precedes event insertion by design). Any GC window
shorter than this would risk deleting artifacts that belong to in-progress runs.

## Decision

### Daily scheduled action at 02:00 UTC

A Convex `cronJobs` entry in `convex/crons.ts` runs `artifact_gc:cleanOrphanedArtifacts`
once per day at 02:00 UTC. The job is implemented as a Convex `internalAction` because
it must issue outbound HTTP requests (Vercel Blob storage DELETE) in addition to querying
and mutating Convex tables.

### Orphan definition

An artifact record is considered an orphan if both of the following are true:

1. `artifact._creationTime < Date.now() - 24h` — the record is older than 24 hours.
2. No event in the same run has `payload.type === "_externalized"` and
   `payload._artifact.artifactId === artifact._id`.

Condition 1 (the 24-hour buffer) is the primary safety guard. An artifact younger than
24 hours must never be considered an orphan regardless of event state, because its run
may still be actively recording.

Condition 2 checks whether the artifact is reachable from the event log. The check
iterates events for the artifact's run using the `by_run` index, inspecting the `payload`
field for an `_externalized` type marker and a matching `artifactId`. This is a full
scan of the run's events, which is acceptable given that GC runs once daily at off-peak
hours.

### GC algorithm

```
1. getOrphanCandidates — internalQuery: returns all artifacts with _creationTime < now - 24h
2. For each candidate:
   a. isArtifactReferenced — internalQuery: scan the run's events for a reference
   b. If referenced → skip (increment skipped counter)
   c. If not referenced and BLOB_STORE_TOKEN is set:
      → DELETE https://blob.vercel-storage.com/{storageKey}
        with Authorization: Bearer {BLOB_STORE_TOKEN}
      → If DELETE fails (non-404 status) → log error, leave Convex record, continue
      → 404 on DELETE is treated as success (blob already gone)
   d. deleteArtifactRecord — internalMutation: hard-delete the Convex record
3. Log summary: candidates / cleaned / skipped / errors
```

### BLOB_STORE_TOKEN configuration

`BLOB_STORE_TOKEN` must be set as a Convex environment variable in the Convex deployment
settings (dashboard or `npx convex env set BLOB_STORE_TOKEN <value>`). This is separate
from the Next.js `.env.local` / Vercel environment variables. The Convex runtime does not
inherit Next.js environment variables.

If `BLOB_STORE_TOKEN` is not set in the Convex environment:
- A warning is logged at the start of each GC run.
- Blob deletion is skipped entirely.
- Orphaned Convex artifact records are still deleted, preventing metadata accumulation.
- The blobs remain in Vercel Blob storage and continue to incur storage charges.

Operators must set `BLOB_STORE_TOKEN` in both Next.js and Convex environments to enable
full cleanup.

### Failure modes and retry behavior

**Blob DELETE fails (non-404):** The Convex artifact record is preserved. The error is
logged. The next daily GC run will attempt blob deletion again. This is the conservative
choice — it is safer to leave an orphaned blob than to delete the Convex record and then
fail to delete the blob (which would leave an unreachable blob with no tracking record).

**Reference check fails (internalQuery throws):** The artifact is skipped and the error
is logged. The next GC run will retry the full check.

**Convex record delete fails (internalMutation throws):** The error is logged and the
artifact is counted as an error. The next GC run will re-evaluate the artifact (the blob
will already be deleted at this point, so a second blob DELETE attempt will receive a 404,
which is treated as success, and the record delete will be retried).

## Residual risks

**Blob storage charges during repeated DELETE failures.** If a blob DELETE consistently
fails (e.g., due to Vercel Blob API issues or an incorrect storage key), the orphaned
blob will accumulate charges indefinitely. The GC log will contain repeated error entries
for the same artifact ID, which should alert operators.

**Full table scan for orphan candidates.** `getOrphanCandidates` calls
`ctx.db.query("artifacts").collect()` and filters in memory. This is a full table scan.
At high artifact volumes, this may approach Convex query document limits. A future
optimization could add an index on `_creationTime` or `createdAt` to enable a range
query. For v1 volumes this is acceptable.

**24-hour window does not cover crashes during long runs.** If a run lasts more than 24
hours and a blob is uploaded near the start of the run, the artifact could be incorrectly
flagged as a candidate after 24 hours if no event has referenced it yet. The `referenced`
check (condition 2) prevents deletion in this case: as long as no event has been written
for this artifact, it will pass the reference check and be skipped — but only if the
run is still active and events are still being written. If the run crashed permanently
after the blob upload but before any event insert, the artifact is a genuine orphan
and will be correctly deleted after 24 hours.

## Consequences

- Orphaned artifact records no longer accumulate indefinitely in Convex or Vercel Blob.
- `BLOB_STORE_TOKEN` must be configured in Convex deployment settings in addition to
  Next.js environment variables. This is documented in `.env.example` and `README.md`.
- The GC job runs as an `internalAction` — it is not callable from outside the Convex
  deployment, providing a safety boundary.
- Convex cron scheduling means GC timing is approximate (Convex schedules with
  best-effort delivery; the job may fire slightly after 02:00 UTC under load).
- The `convex/crons.ts` file must be deployed alongside `convex/artifact_gc.ts` for
  the scheduled job to activate.

## Related ADRs

- ADR-0006: Artifact externalization policy
- ADR-0009: SDK-side externalization and the original retry risk documentation
- ADR-0010: Artifact deduplication key strategy (addresses retry-duplicate case)
