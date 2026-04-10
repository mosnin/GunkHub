# Next Steps — Prompt 8 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 7 complete.
**This document:** Defines what Prompt 8 should accomplish, based on remaining gaps after Prompt 7.

---

## 1. What Was Accomplished in Prompt 7

Prompt 7 completed artifact deduplication, externalized payload rendering, run list
filtering, and tags display:

- **Artifact dedup (`sdkCreateArtifact` idempotency)**: `by_run_checksum` compound index
  added to `artifacts` table in `convex/schema.ts`. `sdkCreateArtifact` now queries the
  index before inserting — if an artifact with the same `(runId, checksum)` exists, returns
  the existing record. Duplicate artifact rows on retry are eliminated.
- **`by_org_started` index** on `runs` table for efficient date-range queries.
- **`listRuns` filter params**: optional `startedAfter: number` wired through contracts
  (`ListRunsRequest` 0.4.0), service layer, and Convex query.
- **`updateRunTags` mutation**: new Convex mutation in `convex/runs.ts` for admin/member
  tag editing.
- **Run list filter bar**: status dropdown + date range buttons (Last 24h / Last 7 days /
  Last 30 days) with keyboard-accessible active state on the runs page.
- **Tags in RunList**: chips column with max 3 visible and "+N more" overflow.
- **Tags and metadata in RunHeader**: expandable tag chips and collapsible metadata
  key-value panel.
- **`ExternalizedPayload` rendering in `EventInspector`**: detects `_externalized` payload
  type and renders `ExternalizedPayloadView` with artifact metadata and download link.
- **11 new unit tests** in `tests/unit/artifact-dedup.test.ts`: threshold constant,
  checksum consistency, SDK retry idempotency (same payload body on second send), boundary
  tests (exact threshold not externalized; threshold+1 is externalized).
- **ADR-0010**: decision record for `(runId, checksum)` dedup key strategy.
- **Test count**: 393 passing in `tests/` workspace + 260 SDK tests = 653 total.

---

## 2. What Prompt 8 Should Accomplish

Items are listed in priority order. Items 1 and 2 directly address documented residual
risks. Items 3–5 round out the v1 hardening surface.

### 2A. Artifact GC job (CRITICAL)

Artifacts can be orphaned when a blob upload succeeds but the subsequent event insert
fails permanently and is never retried. Orphaned records accumulate in Convex and the
corresponding blobs occupy paid storage indefinitely.

Add a Convex scheduled job in `convex/crons.ts`:

1. Run daily using Convex's `crons.daily(...)` API.
2. Query `artifacts` records with `_creationTime` older than 24 hours.
3. For each artifact, check whether any event in the same run references
   `payload._artifact.artifactId` matching this artifact's `_id`. Query the `events`
   table scoped to the artifact's `runId`.
4. If no referencing event is found, delete the blob from Vercel Blob via
   `DELETE https://blob.vercel-storage.com/{storageKey}` using `BLOB_STORE_TOKEN`.
5. Delete the orphaned artifact record from Convex.
6. Log how many records were cleaned up (Convex `console.log` is visible in the
   dashboard and captured in logs).

Document the retention policy and GC design in `docs/adrs/0011_artifact_gc.md`.

### 2B. Tag editing UI on run detail

`updateRunTags` mutation exists but is not wired into the UI. Add inline tag editing
to `RunHeader`:

- Clicking a "Edit tags" affordance opens an inline input with current tags pre-filled.
- Adding a tag: type the tag name and press Enter or comma.
- Removing a tag: click the × on the chip.
- On save: call `updateRunTags` via a Next.js server action.
- Enforce admin/member role at the server action layer — viewer role gets a 403.
- Optimistic UI update: show the new tag list immediately, revert on error.

### 2C. RBAC enforcement beyond basic membership

The `user_memberships` table stores `role: "admin" | "member" | "viewer"`. Currently
all authenticated members can call all mutations regardless of role.

Add an optional `minimumRole: "admin" | "member" | "viewer"` parameter to
`requireOrgMembership()` in `convex/auth.ts`. Default to `"viewer"` (any member can
read; no write mutations default to viewer — caller must pass `minimumRole`).

Apply role checks to the following mutations:
- `admin` only: `createApiKey`, `revokeApiKey`, `updateRunTags`, `createProject`
- `member` and above: all existing write mutations (`createRun`, `createEvent`,
  `createArtifact`) — pass `minimumRole: "member"`
- `viewer`: read-only — calling any write mutation that requires `"member"` or `"admin"`
  returns `{ code: "FORBIDDEN", message: "Insufficient role" }`

### 2D. Integration tests with real Convex

`tests/integration/api.test.ts` currently tests response shapes against static fixtures.
Replace the stubs with real integration tests:

- Use a Convex test deployment (`CONVEX_TEST_URL`, `TEST_API_KEY` env vars).
- Test the full create-run → send-events → get-replay path end-to-end.
- Test the artifact upload path: `POST /api/artifacts/upload` → verify the artifact
  record appears in Convex with the correct checksum and storageKey.
- Test the dedup path: upload the same artifact twice for the same run → verify only
  one artifact record exists in Convex (second call returns the existing ID).
- Test the 413 path: send an event with a payload > 10 KB directly (bypassing SDK
  externalization) → verify HTTP 413 from the route.
- Test event idempotency: send the same event twice → verify only one record in Convex.

Add `CONVEX_TEST_URL` and `TEST_API_KEY` to `.env.example` with a comment indicating
these are only required for running integration tests, not for local dev.

### 2E. SDK upload-once guard

On retry, the SDK re-externalizes the same oversized payload, issuing a second `PUT`
call to blob storage. The Convex dedup (ADR-0010) prevents a duplicate Convex record,
but the redundant blob API call wastes quota.

Add a per-`sendEvents`-call cache in `HttpTransport._uploadArtifact`: before issuing
the PUT, compute `sha256Hex(serializedPayload)` client-side and check a local `Map<string,
UploadResult>` keyed by `(runId, checksum)`. If the result is already cached, skip the
PUT and return the cached pointer. Cache scope is per `sendEvents` call — do not share
state between calls (this would be a memory leak for long-running SDK instances).

---

## 3. What Must NOT Be Done in Prompt 8

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
- Do not remove the `by_run_checksum` index without a schema migration plan. Removing it
  would re-expose the duplicate artifact risk on retry.

---

## 4. Acceptance Criteria for Prompt 8

1. Convex daily cron identifies orphaned artifact records (no referencing event, older
   than 24 hours), deletes the blob from Vercel Blob, and removes the Convex record.
   GC job is logged with a count of cleaned records.
2. Tag editing in `RunHeader` calls `updateRunTags` via server action; admin/member only;
   viewer role receives a 403; optimistic update reverts on error.
3. `requireOrgMembership()` accepts `minimumRole` parameter; admin-only mutations enforce
   the admin role and return a structured `FORBIDDEN` error for lower roles.
4. Integration tests pass against a real Convex test deployment (no stubs); dedup path
   and 413 path are covered.
5. SDK upload-once guard skips redundant blob PUT calls within a single `sendEvents` call.
6. `pnpm typecheck` passes with zero errors.
7. `./scripts/validate.sh` passes all three checks.
8. All prior tests still pass (>= 653 total, no regressions).

---

## 5. Known Technical Debt After Prompt 7

1. **Orphaned blobs accumulate** — artifact records with no referencing event are not
   cleaned up. Fix in Prompt 8 (see 2A).
2. **Tag editing not wired into UI** — `updateRunTags` mutation exists but `RunHeader`
   has no inline edit affordance. Fix in Prompt 8 (see 2B).
3. **No RBAC enforcement beyond basic membership** — all members can call all mutations.
   Fix in Prompt 8 (see 2C).
4. **Integration tests are fixture-based stubs** — no real Convex coverage in CI. Fix in
   Prompt 8 (see 2D).
5. **Redundant blob PUT on retry** — SDK re-uploads the same bytes on retry; the Convex
   dedup prevents duplicate records but the blob API call is still issued. Fix in Prompt 8
   (see 2E).
6. **`payload` field comparison is order-sensitive in diff** — JSON.stringify treats
   `{a:1,b:2}` and `{b:2,a:1}` as different. Acceptable for v1 — documented in ADR-0005.
7. **No request timeout on Convex event pagination** — very large runs (> 10,000 events)
   will block the replay endpoint indefinitely.
8. **`comments` mutations are minimal** — `resolveComment` is not wired into the UI.
9. **`convex/organizations.ts` and `convex/projects.ts` are partially implemented** —
   `createOrg`, `getOrgByClerkId`, `createProject` stubs need real implementations.
