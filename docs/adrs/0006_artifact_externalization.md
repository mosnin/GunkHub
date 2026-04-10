# ADR-0006: Artifact Externalization Policy

## Status

Accepted

## Date

2026-04-10

## Context

The Agent Flight Recorder stores event payloads in Convex as part of the immutable event log. As runs grow longer and generate more detailed logs, payload size becomes a concern. Convex documents have size limits, and storing very large payloads inline with events creates operational friction.

The system must support large event payloads (e.g., detailed tool outputs, logs, or structured data) without hitting storage limits or incurring excessive payload transmission costs.

The question is: how should large payloads be handled? Should they be stored inline in the event record, or externalized to a separate blob storage system?

## Decision

Event payloads exceeding **10 KB** (measured as the byte length of `JSON.stringify(payload)`) must be externalized to blob storage before the event is shipped to the backend. The event record stores only a pointer reference (`ArtifactPointer`) containing:

- `storageKey` — the unique identifier in the blob store
- `storageBucket` — the bucket or namespace (provider-agnostic)
- `checksum` — SHA-256 hex digest of the raw content for integrity verification
- `size` — the byte size of the externalized payload

The externalization workflow is:

1. **SDK detects large payloads**: Before calling `/api/events`, the SDK checks if any event payload exceeds 10 KB.
2. **SDK uploads to `/api/artifacts/upload`**: If a payload is too large, the SDK uploads it first and receives an `ArtifactPointer`.
3. **SDK calls `/api/events`**: The event is submitted with the `ArtifactPointer` instead of the inline payload.
4. **API enforces the threshold**: The `/api/events` route returns HTTP 413 Payload Too Large if a payload exceeds 10 KB, which should not happen if the SDK correctly externalizes first.
5. **Blob storage is provider-agnostic**: The `BlobStorageAdapter` interface allows concrete implementations (Vercel Blob in production, in-memory stub in tests) to be swapped without changing the API routes.

## Rationale

### Convex document size limits

Convex enforces document size limits (typically 1 MB per document). For very large event payloads, storing them inline would waste the document limit and risk hitting size constraints. Externalizing large payloads keeps individual event records small and predictable.

### Separation of concerns

Event records should be lightweight and optimized for querying and indexing. Large binary or text content does not need to be stored alongside the event metadata. By separating concerns, we make the event log queryable and the artifact storage independently scalable.

### Cost efficiency

Storing large payloads inline in a transactional database (Convex) is more expensive than storing them in object storage (e.g., Vercel Blob). Object storage is optimized for large, infrequent access patterns and is cheaper per GB.

### Integrity verification

By storing a SHA-256 checksum on the artifact pointer, we enable the client to verify that the retrieved artifact has not been corrupted or tampered with. This is a security and reliability best practice.

### Provider flexibility

The `BlobStorageAdapter` interface abstracts away the specific blob storage provider. In v1, a stub in-memory adapter is used for development and testing. In v1.1 or later, a Vercel Blob adapter can be swapped in without changing any API routes or event ingestion logic.

## Consequences

### Positive

- Event records remain small and queryable.
- Large payloads do not contribute to Convex document size limits.
- Blob storage can be independently scaled or replaced (e.g., from in-memory stub to Vercel Blob).
- Checksum verification ensures integrity of externalized content.
- The 10 KB threshold is a clear, measurable boundary for SDK and API validation.
- Backup and archival of large payloads is decoupled from event log backup.

### Negative

- SDK developers must be aware of the externalization policy and ensure their SDK correctly detects and uploads large payloads.
- An event with an externalized payload requires two API calls (one to `/api/artifacts/upload`, one to `/api/events`), increasing latency and complexity compared to inline payloads.
- If the artifact upload succeeds but the subsequent event submission fails, the SDK must handle orphaned artifacts (not yet addressed in v1).
- Blob storage availability becomes a critical path dependency; if the blob store is down, the SDK cannot externalize large payloads.

### Risk: Orphaned artifacts

If an SDK uploads an artifact but then fails to create the corresponding event, the artifact remains stored in blob storage but is never referenced. This could leak storage costs over time. Mitigations include:

1. SDK retry logic: retry the event submission before considering it failed.
2. Garbage collection: periodically delete artifacts that are not referenced by any event (deferred to v1.1).
3. Artifact TTL: artifacts automatically expire after N days if not referenced (deferred to v1.1).

## Alternatives Considered

### 1. No externalization — store all payloads inline

**Rejected.** Inline storage works for small payloads but does not scale:
- Very large payloads (e.g., megabytes of logs) would hit Convex document size limits.
- Storing large payloads in Convex is more expensive than object storage.
- Querying the event log would require deserializing large blobs even when only metadata is needed.

### 2. Inline base64 encoding in the event record

**Rejected.** This avoids a separate blob store but does not solve the underlying problems:
- Base64-encoded content is ~33% larger than the raw data, making the payload size problem worse.
- The event record still grows linearly with payload size.
- Convex document limits are still hit at smaller payloads.

### 3. Configurable threshold per-event (no global 10 KB limit)

**Rejected.** A per-event threshold would add complexity:
- The SDK would need additional metadata for each event to specify whether it should be externalized.
- The API would need additional validation logic.
- A fixed, global threshold is simpler and sufficient for v1; if exceptions are needed, they can be added in v1.1 with a specific use case justification.

### 4. Store artifacts in Convex as separate table with foreign key

**Rejected.** While Convex supports large fields and can store documents up to 1 MB, this still couples large payload storage to the transactional database:
- Does not improve query performance or reduce cost compared to inline storage.
- Does not enable independent scaling or backup of artifacts.
- External blob storage is the standard pattern for this use case.

## Related ADRs

- ADR-0002: Event Log Is Canonical and Append-Only
- ADR-0004: Shared Contracts Package as Single Type Source
- ADR-0005: On-Demand Replay and Diff Projection Strategy
