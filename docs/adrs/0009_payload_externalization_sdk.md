# ADR-0009: SDK-side Payload Externalization and Pointer Representation

**Status:** Accepted
**Date:** 2026-04-10
**Authors:** Prompt 6 implementation

## Context

Events with payloads larger than 10 KB are rejected by `/api/events` with HTTP 413.
The SDK previously had no self-healing behavior — callers would receive 413 errors
and lose the oversized events from the run trace. This is a correctness gap: large
LLM responses and retrieval results are the most informative events in a run, and
losing them defeats the product's core value proposition.

The threshold and the blob storage upload endpoint (`POST /api/artifacts/upload`)
already existed as of Prompt 4 (see ADR-0006). The missing piece was SDK-side
awareness: the SDK was shipping large payloads directly to `/api/events` and letting
the server reject them.

## Decision

### 1. Threshold ownership — `packages/contracts`

`PAYLOAD_EXTERNALIZATION_THRESHOLD = 10 * 1024` is defined in
`packages/contracts/src/artifacts.ts` as the single source of truth. Both the SDK
and the backend (`/api/events` route) import it from there. This eliminates any risk
of the two sides using different threshold values.

### 2. Pointer representation — `ExternalizedPayload` in `packages/contracts`

When the SDK externalizes a payload, the event's `payload` field is replaced with:

```typescript
{
  type: "_externalized",
  originalType: EventType,   // e.g. "llm.request"
  _artifact: {
    artifactId: string,
    storageKey: string,
    storageBucket: string,
    checksum: string,
    size: number,
  }
}
```

`ExternalizedPayload` is a member of the `EventPayload` union in `packages/contracts/src/events.ts`.
This makes the pointer shape type-safe and inspectable by any consumer (UI, Convex queries,
future analytics).

**Alternatives rejected:**

- **Type assertion without union extension**: undocumented shape, invisible to TypeScript
  consumers. Any consumer reading `event.payload` would have to know about the pointer shape
  out-of-band.
- **`CustomPayload` wrapper**: changes the event's semantic type from "llm.request" to
  "custom", which breaks timeline display and any filtering by event type.
- **Backend-side externalization**: conflicts with ADR-0006 which places externalization at
  the API boundary. The backend route already rejects oversized payloads with 413 — it does
  not silently externalize them. Moving externalization into Convex mutations would require
  the Convex runtime to call out to blob storage, adding a cross-service dependency inside
  the data layer.

### 3. Artifact pre-upload is outside the retry loop

The artifact upload happens *before* the `/api/events` retry loop. This means:

- On retry of `/api/events`, the artifact is NOT re-uploaded (correct behavior — idempotent
  retry of the events call without re-uploading the same blob).
- If the artifact upload itself fails, `sendEvents` returns an error immediately with
  `retryable: false`. The upload failure terminates the batch; the SDK does not attempt
  to send events whose payloads failed externalization.
- The artifact upload does not have its own retry loop. Blob upload failures are rare
  (the Vercel Blob API is highly available) and the SDK's retry budget is reserved for
  event ingestion, not artifact uploads.

### 4. Known retry risk (accepted for v1)

If `_uploadArtifact` succeeds but the subsequent `/api/events` call fails permanently
(e.g., after exhausting retries), the caller's flush loop may retry the entire batch.
The new flush attempt will attempt to externalize the same payload again. Because the
SDK does not cache the upload result between flush calls, it calls `POST /api/artifacts/upload`
a second time.

The blob storage layer (Vercel Blob) uses content-addressed storage, so the same bytes
will land at the same storage key. However, `sdkCreateArtifact` in `convex/sdk_ingest.ts`
always inserts a new Convex record, resulting in a duplicate artifact record pointing to
the same blob content.

This is a known v1 limitation. The artifact content is correct; only the record count
is inflated. Mitigation path: add `(runId, checksum)` deduplication to `sdkCreateArtifact`
in a future prompt so that a second upload for the same content returns the existing
artifact record instead of inserting a new one.

## Consequences

- SDK callers no longer receive 413 errors for large but valid payloads. Large LLM
  responses and retrieval results are preserved in the run trace.
- The canonical event log in Convex stays compact. Large payloads live in blob storage;
  only the pointer is in the Convex document.
- The event `type` field is unchanged. A "llm.request" event with an externalized payload
  is still type-queryable as "llm.request". Only `payload.type` changes to `"_externalized"`.
- UI components rendering event payloads must handle `payload.type === "_externalized"`.
  They should display an artifact link (storageKey, size, checksum) rather than attempting
  to inline-render the full payload.
- Duplicate artifact records on retry are a known v1 risk, documented here and in the
  build log. The fix is a `(runId, checksum)` upsert in `sdkCreateArtifact`.

## Related ADRs

- ADR-0006: Artifact externalization policy (threshold definition, blob storage interface,
  `ArtifactPointer` shape, checksum requirement)
- ADR-0007: Ingestion idempotency (`(runId, sequenceNumber)` dedup for events — the
  analogue of what we need for artifacts)
- ADR-0008: VercelBlobAdapter design (the concrete blob storage implementation activated
  by `BLOB_STORE_TOKEN`)
