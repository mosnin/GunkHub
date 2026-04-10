# Next Steps — Prompt 7 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 6 complete.
**This document:** Defines what Prompt 7 should accomplish, based on remaining gaps after Prompt 6.

---

## 1. What Was Accomplished in Prompt 6

Prompt 6 completed SDK auto-externalization and added targeted test coverage:

- **`HttpTransport.sendEvents()` auto-externalization**: for each event whose payload
  serializes to > 10,240 bytes, the SDK calls `POST /api/artifacts/upload`, gets an
  artifact pointer, replaces the event payload with an `ExternalizedPayload` pointer,
  then ships the compact event to `POST /api/events`. Upload failures return
  `{ success: false, retryable: false }` immediately; the events call is skipped.
- **`ExternalizedPayload` in `packages/contracts`**: the pointer shape is now a member
  of the `EventPayload` discriminated union, making it type-safe for all consumers.
- **`PAYLOAD_EXTERNALIZATION_THRESHOLD`** imported from `packages/contracts/src/artifacts.ts`
  — SDK and backend now share the exact same threshold value.
- **`apps/web/src/lib/health.ts`**: shared health data function extracted to eliminate
  the server-side loopback HTTP call in `SystemHealthPanel`.
- **26 new unit tests** in `tests/unit/transport-externalization.test.ts`: small payload
  passthrough (6), large payload externalization (8), mixed batches (4), upload failure
  handling (4), pointer shape correctness (4).
- **ADR-0009**: decision record for SDK-side externalization, pointer representation,
  upload-outside-retry-loop rationale, and the known duplicate-artifact retry risk.
- **Test count**: 382 passing in `tests/` workspace + 260 SDK tests = 642 total.

---

## 2. What Prompt 7 Should Accomplish

### 2A. ADR-0009 cleanup: artifact deduplication on retry (CRITICAL)

The retry risk documented in ADR-0009: if `_uploadArtifact` succeeds but `POST /api/events`
fails permanently, a subsequent flush call uploads the same blob a second time and inserts
a duplicate artifact record in Convex.

Fix: add `(runId, checksum)` deduplication to `sdkCreateArtifact` in `convex/sdk_ingest.ts`.

Specifically:
1. Add a `by_run_checksum` index to the `artifacts` table in `convex/schema.ts`:
   `by_run_checksum: ["runId", "checksum"]`.
2. In `sdkCreateArtifact`, before inserting, query the `by_run_checksum` index for an
   existing record with the same `(runId, checksum)`. If found, return the existing
   `artifactId` instead of inserting a new record.
3. Update `docs/adrs/0009_payload_externalization_sdk.md` to mark the retry risk as
   "mitigated in Prompt 7".

### 2B. Artifact garbage collection job

Artifacts can be orphaned when a blob upload succeeds but the subsequent event insert
fails permanently and is never retried. These orphaned records accumulate in Convex and
the corresponding blobs occupy paid blob storage.

Add a Convex scheduled job in `convex/crons.ts`:
1. Run daily (use Convex's `crons.daily(...)` API).
2. Query `artifacts` records older than 24 hours.
3. For each, check whether any event in the same run references `_artifact.artifactId`
   matching this artifact record's `_id`. (Query `events` where
   `payload._artifact.artifactId === artifact._id`.)
4. If no referencing event is found, delete the blob from Vercel Blob via
   `DELETE https://blob.vercel-storage.com/{storageKey}` using `BLOB_STORE_TOKEN`.
5. Delete the orphaned artifact record from Convex.
6. Log how many records were cleaned up (Convex `console.log` is visible in the dashboard).

Document the retention policy in `docs/adrs/0010_artifact_gc.md`.

### 2C. Run list filtering UI

The runs list (`apps/web/app/(app)/runs/page.tsx`) shows all runs without filtering.
Add:

- **Status filter**: dropdown — All | pending | running | completed | failed | cancelled | timed_out.
- **Date range filter**: buttons for Last 24h | Last 7 days | Last 30 days (with active state).
- **Agent filter**: dropdown listing distinct agents in the org (only if the org has > 1 agent).
- Keyboard shortcut `Cmd+K` to focus the filter bar.

Required backend change: update `convex/runs.ts → listRuns` to accept optional
`status: RunStatus | undefined` and `startedAfter: number | undefined` parameters.
Update the existing query — do not add a new query function.

### 2D. Tags and metadata display

Runs have `tags: string[]` and `metadata: Record<string, unknown>` stored in Convex
but not displayed anywhere.

- **Run list**: display tags as small chips on each run row (max 3 visible, "+N more" overflow).
- **Run detail header**: display all tags as chips, expandable.
- **Run detail**: collapsible "Metadata" panel below the run header showing metadata as a
  key-value table.
- **Edit tags**: on the run detail page, allow adding and removing tags. Requires a new
  Convex mutation `updateRunTags(runId: Id<"runs">, tags: string[])` in `convex/runs.ts`.
  Admin and member roles may edit tags; viewer role may not.

### 2E. RBAC enforcement beyond basic membership

The `user_memberships` table stores `role: "admin" | "member" | "viewer"`. Currently
all authenticated members can perform all operations regardless of role.

Add role checks to the following mutations:
- `admin` only: `createApiKey`, `revokeApiKey`, `updateRunTags`, `createProject`
- `member` and above: all existing write mutations (currently unrestricted — add explicit check)
- `viewer`: read-only — calling any write mutation returns an authorization error

Enforce role checks in `convex/auth.ts → requireOrgMembership()` by adding an optional
`minimumRole: "admin" | "member" | "viewer"` parameter. Default is `"viewer"` (any member
can read). Update all admin-only mutations to pass `minimumRole: "admin"`.

### 2F. Integration tests with real Convex

`tests/integration/api.test.ts` currently tests response shapes against static fixtures.
Replace the stubs with real integration tests:
- Use a Convex test deployment (`CONVEX_TEST_URL`, `TEST_API_KEY` env vars).
- Test the full create-run → send-events → get-replay path.
- Test the artifact upload path: `POST /api/artifacts/upload` → verify artifact record appears.
- Test the 413 path: event with payload > 10 KB → verify HTTP 413.
- Test idempotency: send the same event twice → verify only one record in Convex.

Add `CONVEX_TEST_URL` and `TEST_API_KEY` to `.env.example` with instructions.

---

## 3. What Must NOT Be Done in Prompt 7

- Do not add real-time event streaming.
- Do not add analytics dashboards or aggregate metrics.
- Do not add webhooks or external integrations (Slack, PagerDuty, etc.).
- Do not change the event log immutability rules — no `updateEvent` or `deleteEvent`.
- Do not add AI-powered failure analysis.
- Do not implement multi-region ingestion.
- Do not add billing or usage metering.
- Do not add a mobile application.
- Do not remove `ExternalizedPayload` from the `EventPayload` union or rename its fields.
  Stored events have this shape on disk — changing it requires a migration.

---

## 4. Acceptance Criteria for Prompt 7

1. `sdkCreateArtifact` returns the existing artifact record when `(runId, checksum)` already
   exists — no duplicate records on retry.
2. Convex daily cron cleans up orphaned artifact records (blob + Convex record deleted).
3. Run list supports status and date range filtering with keyboard-accessible filter bar.
4. Tags displayed in run list (chip, max 3) and run detail (all chips, expandable).
5. Tags editable from run detail page (admin/member only).
6. Admin-only mutations enforce the `admin` role via `requireOrgMembership({ minimumRole: "admin" })`.
7. Integration tests pass against a real Convex test deployment (no stubs).
8. `pnpm typecheck` passes with zero errors.
9. `./scripts/validate.sh` passes all three checks.
10. All prior tests still pass (>= 642 total, no regressions).

---

## 5. Known Technical Debt After Prompt 6

1. **Duplicate artifact records on retry** — `sdkCreateArtifact` has no `(runId, checksum)`
   upsert. A second flush of the same oversized event produces a second artifact record.
   Fix in Prompt 7 (see 2A).
2. **No artifact GC** — orphaned blobs accumulate in Vercel Blob and Convex. Fix in
   Prompt 7 (see 2B).
3. **No RBAC enforcement beyond basic membership** — all members can write. Fix in
   Prompt 7 (see 2E).
4. **Integration tests are fixture-based stubs** — no real Convex coverage in CI. Fix in
   Prompt 7 (see 2F).
5. **`payload` field comparison is order-sensitive in diff** — JSON.stringify treats
   `{a:1,b:2}` and `{b:2,a:1}` as different. Acceptable for v1 — documented in ADR-0005.
6. **No request timeout on Convex event pagination** — very large runs (> 10,000 events)
   will block the replay endpoint indefinitely.
7. **`comments` mutations are minimal** — `resolveComment` is not wired into the UI.
8. **`convex/organizations.ts` and `convex/projects.ts` are partially implemented** —
   `createOrg`, `getOrgByClerkId`, `createProject` stubs need real implementations.
