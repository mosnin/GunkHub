# Architecture — Agent Flight Recorder

This document describes the system as it exists in this repository today. Every claim
below is cited against a file path — if the code changes, update this document in the
same PR (see `CLAUDE.md`).

---

## 1. System Diagram

```mermaid
flowchart TB
    SDK["Agent code<br/>@agent-flight-recorder/sdk<br/>(Recorder / FlightRecorder)"]
    Browser["Browser<br/>Next.js UI + Clerk"]
    Clerk["Clerk<br/>(identity provider)"]

    subgraph Web["apps/web (Next.js 14 App Router)"]
      APIRoutes["Ingestion API routes<br/>/api/runs, /api/events,<br/>/api/artifacts/upload, /api/runs/:id/status"]
      Webhook["/api/webhooks/clerk"]
      UI["React pages + Convex React hooks<br/>(direct read path)"]
    end

    Convex["Convex backend<br/>schema.ts, runs.ts, events.ts,<br/>sdk_ingest.ts, auth.ts, audit.ts"]
    Blob["Blob storage<br/>(payloads > 10 KB, via convex/helpers/storage.ts)"]
    Crons["Convex crons<br/>artifact_gc, stale_runs,<br/>retention, projection_verify"]

    SDK -- "x-api-key, batched JSON" --> APIRoutes
    Browser -- "Clerk session" --> UI
    Clerk -- "JWT" --> Browser
    Clerk -- "org.created / org.deleted /<br/>membership.created webhook" --> Webhook
    APIRoutes -- "convex mutation<br/>(apiKeyHash auth)" --> Convex
    UI -- "useQuery/useMutation<br/>(Clerk JWT)" --> Convex
    Webhook -- "upsertOrganization /<br/>upsertMembership" --> Convex
    APIRoutes -- "upload/read blob" --> Blob
    Convex -- "artifact record:<br/>storageKey + SHA-256 checksum" --> Blob
    Crons -- "scheduled actions" --> Convex
```

**Two read/write seams, by design:**

- **SDK -> Next.js API routes -> Convex** — the ingestion surface. Authenticated by
  `x-api-key` (hashed and matched against `convex/api_keys`), never by a Clerk session.
  `convex/sdk_ingest.ts` explicitly does not call `getAuthContext`/`requireOrgMembership`.
- **Browser -> Convex directly** — the UI reads and writes via Convex React hooks using
  the Clerk JWT (`ConvexProviderWithClerk`). Next.js API routes are not a general-purpose
  API for the UI.

---

## 2. Entity Hierarchy

```
Organization
  └── Project
        └── Agent
              └── AgentVersion
                    └── Run
                          └── Event
```

- **Artifact** hangs off **Run** (and optionally a specific **Event**) — a pointer to an
  externalized large payload in blob storage, never the payload itself
  (`convex/schema.ts` `artifacts` table).
- **Comment** hangs off either a **Run** or an **Event** (`targetType: "run" | "event"`)
  — human annotation on recorded data (`convex/schema.ts` `comments` table).
- `AgentVersion` is immutable once created (`convex/schema.ts` `agent_versions` has no
  update mutation path in `convex/agent_versions.ts`); a new version is required for any
  change to an agent's configuration, system prompt, or tool list.
- Every table except `user_memberships`/`api_keys`/`audit_log` carries an `orgId` field
  and is indexed `by_org` (or a composite starting with `orgId`) — see `convex/schema.ts`.

Both `packages/contracts/src/entities.ts` (the shared TypeScript shapes) and
`convex/schema.ts` (the Convex validators) define this hierarchy; per `CLAUDE.md` the
two must stay shape-aligned even though they are separate type systems.

---

## 3. Event Log Invariants

Enforced in two places for defense in depth: the SDK (best-effort, client-side) and
Convex (authoritative, server-side, in `convex/sdk_ingest.ts` `sdkCreateEvents` and the
Clerk-session path `convex/events.ts`).

1. **Append-only, immutable.** `events` table has no update/delete mutation. Comment in
   `convex/schema.ts`: `"IMMUTABILITY: Events must never be updated or deleted."`
2. **Sequence contiguity.** `sequenceNumber` must be a positive integer, monotonically
   increasing per run, starting at 1, with no gaps and no repeats. Server-side check in
   `sdk_ingest.ts` compares against `state.maxSeq + 1` and throws the stable code
   `SEQUENCE_CONFLICT` on mismatch. A duplicate resend of an already-stored
   `(runId, sequenceNumber)` pair is idempotent — it returns the existing event's id
   rather than erroring (this is what makes SDK retries safe).
3. **`run.started` first, a terminal event last.** The first event of a run must be
   `run.started` (`RUN_STARTED_TYPE` check in `sdk_ingest.ts`); once `run.completed` or
   `run.failed` is stored, no further events may be appended (`RUN_NOT_ACTIVE`). A run
   with no terminal event is in-progress (`status: "running"`); storing the terminal
   event also patches the run's `status`/`endedAt` directly, so the run record and the
   event log can never disagree.
4. **10 KB inline payload ceiling.** `MAX_INLINE_PAYLOAD_BYTES = 10 * 1024` in
   `sdk_ingest.ts`. Applied uniformly — there is no type-based exemption for a
   client-claimed `_externalized` payload, precisely so a spoofed `type` field cannot
   smuggle an oversized payload past the guard. Over the limit, the event must be
   replaced with an `ExternalizedPayload` pointer (`packages/contracts/src/events.ts`):
   `{ type: "_externalized", originalType, _artifact: { artifactId, storageKey,
   storageBucket, checksum, size } }`.
5. **Closed event-type set.** `EventType` in `packages/contracts/src/events.ts` is the
   source of truth. It is mirrored (not imported — Convex cannot resolve the contracts
   package path) as `VALID_EVENT_TYPES` in both `convex/events.ts` and
   `convex/sdk_ingest.ts`; both carry a `MUST stay in sync` comment. Adding an event type
   means updating all three plus the SDK's `Events` builders in
   `packages/sdk/src/events.ts` — see `CONTRIBUTING.md`.

---

## 4. Tenancy Model

- **Clerk organization is the tenancy boundary.** Clerk's `org_id` JWT claim maps 1:1 to
  a Convex `organizations` record via the `clerkOrgId` field
  (`organizations.by_clerk_org_id` index).
- **Every Clerk-session query/mutation** calls `getAuthContext(ctx)`
  (`convex/auth.ts`) first, which throws `"Unauthorized"` if there is no identity or no
  `org_id` claim, then resolves the Convex `orgId`. Mutations that need a minimum
  privilege additionally call `requireOrgMembership(ctx, orgId, { minimumRole })`.
- **Role tiers.** `user_memberships.role` is one of `viewer` / `member` / `admin`, ranked
  0/1/2 in `convex/auth.ts` (`ROLE_RANK`). `requireOrgMembership` defaults to
  `minimumRole: "viewer"` and rejects callers ranked below the requested minimum.
- **The SDK ingest path is a separate authorization path entirely** — see Section 5. It
  never calls `getAuthContext`; it resolves and scopes to an org via the API key's
  `orgId` field instead. Every ingest mutation in `sdk_ingest.ts` checks
  `run.orgId !== apiKey.orgId` (or the agent/version equivalent) before touching data —
  this is the cross-org leak guard for the ingest surface.
- **Guarantee:** because every code path resolves an `orgId` before querying, and every
  index/filter includes it, a query for org A can never surface org B's records —
  provided every new query/mutation follows this pattern (`CLAUDE.md` Tenancy Rule 3).

---

## 5. Ingest Paths and the Error-Code Contract

Two distinct ingest paths exist, authenticated differently:

| Path | Auth | Entry point | Convex functions |
|------|------|-------------|-------------------|
| Clerk-session (web UI) | Clerk JWT, `getAuthContext` + `requireOrgMembership` | Convex React hooks called directly from `apps/web` | `convex/runs.ts`, `convex/events.ts`, `convex/comments.ts`, etc. |
| SDK ingest | `x-api-key` header, hashed and matched against `convex/api_keys` | `apps/web/app/api/{runs,events,artifacts,runs/[id]/status}/route.ts` | `convex/sdk_ingest.ts`: `sdkCreateRun`, `sdkCreateEvents`, `sdkCreateArtifact`, `sdkUpdateRunStatus`, `checkIngestAuth` |

Every SDK ingest mutation calls `resolveApiKey` first, which checks existence,
revocation (`revokedAt`), expiration (`expiresAt`), and scope (`scopes` — a key with no
`scopes` array has full ingest access for back-compat), then throttled-stamps
`lastUsedAt`. `resolveApiKey` also enforces the fixed one-minute-window rate limit
(`api_keys.rateLimitPerMin` / `rateWindowStart` / `rateWindowCount`) — approximated for
high-throughput single-unit calls via a Morris-style stride counter
(`RATE_FLUSH_STRIDE = 25`) to avoid serializing every ingest call on one document, exact
for small limits and for batch calls.

### Error-code contract

Convex throws `Error("CODE: human text")` via `afrError()` (`convex/helpers/errors.ts`).
The codes that cross the SDK boundary are the closed set in
`packages/contracts/src/api_errors.ts` (`AFR_API_ERROR_CODES`) — **append-only; a
deployed SDK matches on the exact string, so an existing code must never be renamed or
removed**:

| Code | Meaning | HTTP status (`apiHandler.ts` `AFR_CODE_TO_STATUS`) |
|------|---------|------|
| `RUN_NOT_ACTIVE` | Event append attempted on a terminal/cancelled run | 409 |
| `SEQUENCE_CONFLICT` | Non-contiguous or otherwise invalid `sequenceNumber` | 409 |
| `EVENT_LIMIT_EXCEEDED` | Run hit `MAX_EVENTS_PER_RUN` | 422 |
| `ARTIFACT_LIMIT_EXCEEDED` | Run hit `MAX_ARTIFACTS_PER_RUN` | 422 |
| `COMMENT_LIMIT_EXCEEDED` | Target hit its comment cap | 422 |
| `RATE_LIMITED` | Per-API-key ingest rate limit exceeded | 429 (with `Retry-After: 60`) |

`apps/web/src/lib/apiHandler.ts` (`mapAfrErrorResponse`) parses the `CODE:` prefix out of
the Convex-wrapped error message (Convex re-wraps server errors in its own envelope, so
the parser scans every colon-delimited token, not just the first) and returns a JSON body
`{ code, message, details: { requestId } }` with the mapped status. Unrecognized errors
fall through to the route's own handling (401 for a bad/missing API key) or are rethrown
for `withApiHandler` to log and genericize.

---

## 6. Blob Storage / Payload Externalization

`convex/helpers/storage.ts` defines the storage abstraction Convex-side; the actual
upload for SDK-originated artifacts flows through
`apps/web/app/api/artifacts/upload/route.ts`, backed by Vercel Blob
(`BLOB_STORE_URL`/`BLOB_STORE_TOKEN` in `.env.example`). An artifact record
(`convex/schema.ts` `artifacts` table) stores `storageKey`, `storageBucket`, `size`, and
a SHA-256 `checksum` — never the payload bytes. Artifacts dedupe per `(runId, checksum)`
(`sdk_ingest.ts` `sdkCreateArtifact`), so a retried upload after a failed `/api/events`
call does not create a duplicate blob record.

**GC bookkeeping:** once an event's `_externalized` payload references an artifact, the
event's id is stamped onto `artifacts.referencedByEventId`
(`sdk_ingest.ts` — patching the artifact, never the event, so event-log immutability
holds) so the artifact permanently leaves the daily `artifact_gc` cron's
orphan-candidate scan (`convex/artifact_gc.ts`, scheduled in `convex/crons.ts`).

---

## 7. Durability Story (SDK -> Server)

The buffered `Recorder` (`packages/sdk/src/recorder.ts`) is the durability-hardened path
(the un-buffered `FlightRecorder` in `packages/sdk/src/flight-recorder.ts` sends each
event immediately instead, trading durability for simplicity):

1. **Buffer.** `recordEvent` assigns a local, per-run monotonic `sequenceNumber` and
   pushes the built event onto an in-memory `eventBuffer`. Terminal event types
   (`run.completed`/`run.failed`/`run.cancelled`) are protected from ever being dropped
   on overflow (`PROTECTED_EVENT_TYPES` in `recorder.ts`).
2. **Spool (optional, Node-only).** `FileSpool` (`packages/sdk/src/file-spool.ts`) is an
   append-only JSONL file. Appending resolves once data is handed to the OS page cache
   (survives a process crash, not a kernel panic/power loss unless `{ fsync: true }` is
   set). `Recorder.recover()` uses `peek()` -> send -> `clear()`, in that order, so a
   crash mid-recovery re-sends duplicates (safe — see idempotency below) rather than
   losing entries. The spool has no file locking; it is a single-process-per-path
   primitive by design.
3. **Per-run batching.** `flush()` groups the buffer `groupByRun` and ships each run's
   events together, preserving order within a run. Flushes are chained
   (`flushChain`) so two overlapping flush triggers (the flush timer and the
   max-batch-size trigger) can never reorder the buffer — a reordered flush would fail
   the server's contiguity check and permanently wedge the run.
4. **Server idempotency.** Because `sdk_ingest.ts`'s `sdkCreateEvents` treats a resend of
   an already-stored `(runId, sequenceNumber)` as a no-op returning the existing event
   id (rather than a conflict), retries from an unreliable network or a spool replay are
   always safe to resend — the worst case is redundant network calls, never a duplicate
   or corrupted event.

---

## 8. Scheduled Jobs

All defined in `convex/crons.ts`, running daily in UTC:

| Time (UTC) | Job | Action |
|------------|-----|--------|
| 01:00 | `enforce-retention` | `retention:enforceRetention` — deletes terminal runs (and their events/artifacts/comments/verification results) past an org's opt-in `retentionDays` window (ADR 001) |
| 02:00 | `artifact-gc` | `artifact_gc:cleanOrphanedArtifacts` — deletes artifacts older than 24h with no referencing event, from both blob storage and Convex |
| 03:00 | `expire-stale-runs` | `stale_runs:expireStaleRuns` — transitions runs stuck in `"running"` for >24h to `"timed_out"` |
| 04:30 | `verify-projection-integrity` | `projection_verify:verifyRecentRuns` — checks sequence contiguity for up to 50 recent terminal runs, recording a `verification_results` row |

Retention runs before artifact GC deliberately, so GC sees the post-retention state.

---

## 9. Where This Document Can Go Stale

This file describes source-of-truth code paths, not aspirations. When any of the
following change, update this document in the same PR: `convex/schema.ts`,
`convex/sdk_ingest.ts`, `convex/auth.ts`, `convex/crons.ts`,
`packages/contracts/src/{entities,events,api_errors}.ts`,
`packages/sdk/src/{recorder,flight-recorder,file-spool}.ts`,
`apps/web/src/lib/apiHandler.ts`.
