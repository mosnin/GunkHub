# Next Steps — Prompt 6 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 5 (Release Candidate) complete.
**This document:** Defines what Prompt 6 should accomplish, based on remaining gaps after Prompt 5.

---

## 1. What Was Accomplished in Prompt 5

Prompt 5 completed the production storage layer and prepared for release:

- **VercelBlobAdapter**: production blob storage via native fetch — no `@vercel/blob` package. Activated by `BLOB_STORE_TOKEN` env var presence.
- **`verifyProjectionIntegrity`**: pure function for checking run event sequence integrity (contiguity, duplicates, projection validity). Used by CLI script and future background jobs.
- **`scripts/rebuild-projection.ts`**: CLI tool for on-demand integrity checks.
- **`GET /api/health`**: operator endpoint reporting storage adapter and configuration status.
- **SystemHealthPanel**: web UI component surfacing health endpoint data.
- **ADR-0008**: decision record for VercelBlobAdapter design.
- **Deployment docs**: `deployment_checklist.md`, `release_readiness.md`, `operations_runbook.md`.
- **68 new tests** for `verifyProjectionIntegrity` (356 total in tests/ workspace, all passing).
- **2 storage tests fixed** to reflect the updated `getStorageAdapter()` behavior.

---

## 2. What Prompt 6 Should Accomplish

### 2A. SDK auto-externalization (CRITICAL PATH)

Currently the SDK does nothing special for large payloads — `/api/events` returns
HTTP 413 and the SDK surfaces that as an error to the caller. The SDK must self-heal:

1. In `packages/sdk/src/transport.ts` → `HttpTransport.flushEvents()`, for each event
   whose payload serializes to > 10,240 bytes (the `PAYLOAD_EXTERNALIZATION_THRESHOLD`):
   a. Call `POST /api/artifacts/upload` with the full payload as the body.
   b. Store the returned `{ storageKey, storageBucket, checksum, size }` pointer.
   c. Replace the event's `payload` with a compact pointer object:
      `{ _artifact: { id, storageKey, storageBucket, checksum, size } }`
   d. Ship the compact event via the normal `POST /api/events` route.
2. Add the `/api/artifacts/upload` URL to `RecorderConfig` or derive it from `baseUrl`.
3. Unit tests in `tests/unit/` (or `packages/sdk/tests/`) using mock fetch:
   - Large payload triggers upload call before events call.
   - Small payload does NOT trigger upload call.
   - Upload failure surfaces correctly in `FlushResult.errors`.

### 2B. Artifact garbage collection

Artifacts can be orphaned when:
- An upload to `/api/artifacts/upload` succeeds but the subsequent `/api/events` call fails.
- A run is aborted before the artifact pointer event is sent.

Add a Convex scheduled job (`convex/crons.ts`) that runs daily and:
1. Queries `artifacts` records older than 24 hours with no matching event referencing their `id`.
2. Deletes the orphaned blob from Vercel Blob storage via the REST API.
3. Removes the orphaned artifact record from Convex.

Document the retention policy in `docs/adrs/0009_artifact_gc.md`.

### 2C. Run search and filtering UI

The runs list (`apps/web/app/(app)/runs/page.tsx`) shows all runs without filtering.
Add:

- **Status filter**: dropdown with options: All | pending | running | completed | failed | cancelled | timed_out.
- **Date range filter**: buttons for Last 24h | Last 7 days | Last 30 days, plus a custom date range picker.
- **Agent filter**: dropdown listing distinct agents in the org (only if the org has > 1 agent).
- Keyboard shortcut `Cmd+K` to focus the filter bar.

Requires updating `convex/runs.ts → listRuns` to accept optional `status: RunStatus | undefined` and `startedAfter: number | undefined` parameters. Update the existing `listRuns` query — do not add a new query function.

### 2D. Tags and metadata display

Runs have `tags: string[]` and `metadata: Record<string, unknown>` stored in Convex
but not displayed anywhere.

- **Run list**: display tags as small chips on each run row (max 3 visible, "+N more" overflow).
- **Run detail header**: display all tags as chips, expandable.
- **Run detail**: add a collapsible "Metadata" panel below the run header showing metadata as a key-value table.
- **Edit tags**: on the run detail page, allow adding and removing tags. Requires a new Convex mutation `updateRunTags(runId, tags)` in `convex/runs.ts`.

### 2E. Integration tests with real Convex

`tests/integration/api.test.ts` currently tests response shapes against static
fixtures. Replace the stubs with real integration tests:

- Use a Convex test deployment (the `CONVEX_DEPLOY_KEY` for a test deployment).
- Test the full path: `POST /api/runs` → `POST /api/events` → `GET /api/runs/:id/replay`.
- Test the artifact upload path: `POST /api/artifacts/upload` → verify artifact record in Convex.
- Test the 413 path: submit an event with a payload > 10 KB → verify HTTP 413.
- Test idempotency: submit the same event twice → verify only one record in Convex.

These tests require `CONVEX_TEST_URL` and `TEST_API_KEY` env vars. Add them to `.env.example`.

### 2F. RBAC enforcement beyond basic membership

The `user_memberships` table stores `role: "admin" | "member" | "viewer"`. Currently
all authenticated members can perform all operations regardless of role.

Add role checks to the following mutations:
- `admin` only: `createApiKey`, `revokeApiKey`, `updateRunTags`, `createProject`
- `member` and above: `createRun`, `createEvent` (already via API key, so may not apply)
- `viewer`: read-only access — cannot call any write mutation

Enforce role checks in `convex/auth.ts → requireOrgMembership()` by adding an optional
`minimumRole` parameter. Update all mutations that should be admin-only to pass
`minimumRole: "admin"`.

---

## 3. What Must NOT Be Done in Prompt 6

- Do not add real-time event streaming.
- Do not add analytics dashboards or aggregate metrics.
- Do not add webhooks or external integrations.
- Do not change the event log immutability rules (no `updateEvent` or `deleteEvent`).
- Do not add AI-powered failure analysis.
- Do not implement multi-region ingestion.
- Do not add billing or usage metering.

---

## 4. Acceptance Criteria for Prompt 6

1. SDK auto-externalizes payloads > 10 KB — no more 413 errors for well-behaved callers.
2. Artifact GC job removes orphaned blobs older than 24 hours.
3. Run list supports status and date range filtering.
4. Tags displayed in run list and run detail; editable from run detail.
5. Integration tests run against a live Convex test deployment with no stubs.
6. Admin-only mutations enforce the `admin` role requirement.
7. `pnpm typecheck` passes with zero errors.
8. `./scripts/validate.sh` passes all three checks.
9. All tests pass (>= 356 in tests/ workspace + 260 SDK = 616 total, no regressions).

---

## 5. Known Technical Debt After Prompt 5

1. **SDK does not auto-externalize large payloads.** API returns 413. SDK callers must handle manually. Fix in Prompt 6 (see 2A).
2. **No artifact GC.** Orphaned blobs accumulate. Fix in Prompt 6 (see 2B).
3. **No RBAC enforcement beyond basic membership.** All members can write. Fix in Prompt 6 (see 2F).
4. **Integration tests are fixture-based stubs.** No real Convex coverage in CI. Fix in Prompt 6 (see 2E).
5. **`payload` field comparison is order-sensitive in diff.** JSON.stringify treats `{a:1,b:2}` and `{b:2,a:1}` as different. Acceptable for v1 — documented in ADR-0005.
6. **No request timeout on Convex event pagination.** Very large runs (> 10,000 events) will block the replay endpoint indefinitely.
7. **`comments` mutations are minimal.** `resolveComment` is not wired into the UI.
