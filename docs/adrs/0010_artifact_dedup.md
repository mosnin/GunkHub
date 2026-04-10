# ADR-0010: Artifact Deduplication Key Strategy

**Status:** Accepted
**Date:** 2026-04-10
**Authors:** Prompt 7 implementation

## Context

ADR-0009 documented a known v1 risk: if `_uploadArtifact` succeeds but the subsequent
`POST /api/events` call fails permanently, a retry flush will upload the same blob a
second time and call `sdkCreateArtifact` again, inserting a duplicate Convex artifact
record. The blob content is identical, but the Convex `artifacts` table accumulates
extra rows pointing to the same storage key.

## Decision

### Dedup key: `(runId, checksum)`

`sdkCreateArtifact` now queries the `by_run_checksum` index (added to `artifacts` in
`convex/schema.ts`) before every insert. If an artifact record already exists with
the same `runId` and `checksum`, the existing record is returned immediately — no
duplicate insert.

**Why `(runId, checksum)` and not just `checksum`?**

- The same large payload *could* legitimately appear in two different runs (e.g., a
  canonical system prompt used in every run). Those artifacts are separate Convex
  records by design — they belong to different runs and may have different `eventId`
  linkages.
- Scoping by `runId` keeps dedup within the retry scenario (same run, same payload)
  and does not accidentally merge cross-run artifacts.

**Why not `(runId, storageKey)`?**

- Storage key is derived from `checksum` (the key contains the checksum prefix), so
  either field would work. `checksum` is more explicit about the equality criterion
  (content identity) and is already the field passed into the mutation args.

### Index added

`artifacts.index("by_run_checksum", ["runId", "checksum"])` in `convex/schema.ts`.
This is a simple two-field compound index that enables O(1) dedup lookup per
`sdkCreateArtifact` call.

### Residual risk: blob storage duplicates

The dedup guard prevents duplicate **Convex records**, but it does not prevent a
second `PUT` call to blob storage from the SDK transport (since the blob upload
happens in the SDK before the Convex mutation). On retry, the blob is re-uploaded
(idempotent overwrite at the same checksum-derived key), consuming one extra blob API
call. This is acceptable for v1 — the blob content is deduplicated by storage key,
only the API call is redundant. A future prompt can add a client-side upload-once
guard in `HttpTransport._uploadArtifact`.

### Residual risk: orphaned blobs

If the blob upload succeeds and the Convex artifact insert succeeds, but the
subsequent `POST /api/events` call fails permanently and is never retried (process
crash), the artifact record exists but no event references it. This orphaned artifact
is not addressed by this ADR — see ADR-0009 for the GC mitigation path (Prompt 8).

## Consequences

- `sdkCreateArtifact` is now idempotent for the same `(runId, checksum)` pair
- Retry flushes in the SDK no longer produce duplicate artifact rows
- One extra index query per artifact insert (negligible overhead)
- The `artifacts` table has a new compound index — schema must be re-deployed
- Orphaned blobs (no event reference) remain a v1 risk — addressed in GC job (Prompt 8)

## Related ADRs

- ADR-0006: Artifact externalization policy
- ADR-0007: Ingestion idempotency for events (same pattern: `(runId, sequenceNumber)`)
- ADR-0009: SDK-side externalization and the original retry risk documentation
