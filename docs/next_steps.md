# Next Steps — Prompt 5 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 4 (Hardening) complete.
**This document:** Defines what Prompt 5 should accomplish, based on remaining gaps after Prompt 4.

---

## 1. What Was Accomplished in Prompt 4

Prompt 4 hardened the ingestion pipeline and blob storage layer:

- **Payload size enforcement**: Events with JSON payload > 10 KB are rejected at the API boundary (HTTP 413). Documented in ADR-0006.
- **Ingestion idempotency**: `sdkCreateEvents` now deduplicates by `(runId, sequenceNumber)` — safe retries return the existing event ID. Documented in ADR-0007.
- **Blob storage interface**: `BlobStorageAdapter` interface, `sha256Hex` checksum helper, `PAYLOAD_EXTERNALIZATION_THRESHOLD` constant. Stub adapter for dev/test.
- **Artifact upload endpoint**: `POST /api/artifacts/upload` — externalizes large payloads, records artifact in Convex, returns pointer.
- **Artifact service + UI**: `listArtifacts`, `getArtifactUrl` wired to Convex; ArtifactList renders real data.
- **Event detail page**: Full payload viewer with breadcrumb, metadata panel, parent event link.
- **28 new unit tests** for storage layer (288 total, all passing).
- **Two new ADRs** (0006, 0007) documenting the externalization and idempotency decisions.

---

## 2. What Prompt 5 Should Accomplish

### 2A. Vercel Blob production adapter (CRITICAL PATH for production)

The `StubBlobStorageAdapter` is in-memory — data is lost on process restart. To run in production:

1. Implement `VercelBlobAdapter` in `apps/web/src/lib/storage/vercel.ts`:
   - Uses `@vercel/blob` package (`put()` for upload, `url()` for signed URL)
   - `BLOB_READ_WRITE_TOKEN` env var must be set
2. Wire it into `getStorageAdapter()` when `BLOB_STORAGE_PROVIDER=vercel`
3. Add `BLOB_READ_WRITE_TOKEN` and `BLOB_STORAGE_PROVIDER` to `.env.example`
4. Add SDK helper: when payload exceeds threshold, auto-upload before shipping event
   - This lives in `packages/sdk/src/transport.ts` — check payload size in `flushEvents()`
   - If > threshold, call `/api/artifacts/upload` first, replace payload with pointer

### 2B. SDK auto-externalization

Currently the SDK does nothing special for large payloads — the API route rejects them. The SDK should detect large payloads and automatically externalize them:

- In `HttpTransport.flushEvents()`, for each event whose payload serializes to > 10 KB:
  1. Call `POST /api/artifacts/upload` with the full payload
  2. Replace the event's `payload` with a compact `{ _artifact: { id, storageKey, storageBucket, checksum, size } }` pointer
  3. Ship the compact event via the normal `/api/events` route
- Unit tests in `packages/sdk/tests/transport.test.ts`

### 2C. Run search and filtering UI

The runs list (`apps/web/app/(app)/runs/page.tsx`) currently shows all runs without filtering. Add:

- Status filter dropdown: pending | running | completed | failed | cancelled | timed_out | (all)
- Date range filter: last 24h | last 7 days | last 30 days | custom
- Agent filter (if multiple agents in org)
- Keyboard shortcut to focus search

Requires updating `convex/runs.ts → listRuns` to accept optional status and date range parameters.

### 2D. Run tagging and metadata display

Runs have `tags: string[]` and `metadata: Record<string, unknown>` fields stored in Convex but not displayed anywhere in the UI. Add:

- Tags displayed as chips on the run list and run detail header
- Metadata displayed in a collapsible panel on the run detail page
- Ability to add/edit tags from the run detail page (Convex mutation: `updateRunTags`)

### 2E. API key management UI (if not in Prompt 2/3)

`apps/web/app/(app)/settings/page.tsx` should include:

- List of API keys for the org: name, created date, last used, revocation status
- Create new key: enter name → receive key value once → show masked prefix thereafter
- Revoke key button with confirmation dialog

This requires:
- `convex/api_keys.ts` — `listApiKeys`, `createApiKey`, `revokeApiKey` (check if already implemented from Prompt 2)
- The raw key value is shown exactly once after creation (then only the hash is stored)

### 2F. Integration test environment

`tests/integration/api.test.ts` currently tests API response shapes against static fixtures. Real integration tests should test the full SDK → API routes → Convex path. This requires:

- A Convex dev deployment (not possible without live credentials in CI)
- Alternative: mock the Convex client in integration tests to verify route handler logic end-to-end
- At minimum: test the artifact upload route, the events route (including 413 on large payload), and the replay route

### 2G. Operational scripts

Add `scripts/benchmark.ts` to measure projection computation at scale:
- Generate N events (configurable, default 1000)
- Run `buildReplayProjection`, `buildFailureSummary`, `buildRunDiff` and report timing
- Used to verify ADR-0005 assumption ("small event counts, computation dominated by fetch latency")

---

## 3. What Must NOT Be Done in Prompt 5

- Do not add real-time event streaming.
- Do not add analytics dashboards.
- Do not add webhooks or external integrations.
- Do not change the event log immutability rules.
- Do not add AI-powered failure analysis.
- Do not implement multi-region ingestion.

---

## 4. Acceptance Criteria for Prompt 5

1. `StubBlobStorageAdapter` replaced with `VercelBlobAdapter` for `BLOB_STORAGE_PROVIDER=vercel`.
2. SDK auto-externalizes payloads > 10 KB before calling `/api/events`.
3. Run list supports status and date range filtering.
4. Tags and metadata visible in run list and detail.
5. `pnpm typecheck` passes with zero errors.
6. `./scripts/validate.sh` passes all three checks.
7. All tests pass (≥ 288 passing, no regressions).

---

## 5. Known Technical Debt After Prompt 4

1. **`StubBlobStorageAdapter` is in-memory.** Not suitable for production. Data is lost on restart. Implement Vercel Blob adapter in Prompt 5.
2. **SDK does not auto-externalize large payloads.** The API route enforces the limit, but the SDK will get 413 errors and fail instead of self-healing. Add auto-externalization in SDK transport.
3. **`payload` field comparison is order-sensitive.** JSON.stringify in the diff algorithm treats `{a:1,b:2}` and `{b:2,a:1}` as different. Acceptable for v1 — documented in ADR-0005.
4. **No request timeout on Convex event pagination.** Very large runs (>10,000 events) will block the replay endpoint indefinitely. Mitigate with `Cache-Control` headers or projection timeout.
5. **`comments` mutations are minimal.** `createComment` exists but `resolveComment` is not wired into the UI.
