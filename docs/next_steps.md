# Next Steps — Prompt 9 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 8 complete.
**This document:** Defines what Prompt 9 should accomplish, based on remaining gaps after Prompt 8.

---

## 1. What Was Accomplished in Prompt 8

Prompt 8 completed artifact GC, RBAC role enforcement, inline tag editing, SDK upload
deduplication, and real integration test infrastructure:

- **Artifact GC cron** (`convex/crons.ts`, `convex/artifact_gc.ts`): daily scheduled job
  at 02:00 UTC detects orphaned artifact records (no referencing event, older than 24 h),
  deletes the blob from Vercel Blob, removes the Convex record, and logs candidate/cleaned/
  skipped/error counts.
- **RBAC `minimumRole` enforcement** (`convex/auth.ts`): `requireOrgMembership` gains an
  optional `minimumRole: "admin"|"member"|"viewer"` parameter (defaults to `"viewer"`).
  `createApiKey`, `revokeApiKey`, `updateRunTags`, and `createProject` now require
  `minimumRole: "admin"`. `createRun` requires `minimumRole: "member"`.
- **Inline tag editing in `RunHeader`**: add/remove chips, Enter/comma to commit, Save/Cancel
  buttons, error display on failure. Write path goes through a Next.js server action
  (`apps/web/app/(app)/runs/[runId]/actions.ts`).
- **SDK per-`sendEvents` upload cache** (`packages/sdk/src/transport.ts`): before issuing
  a blob PUT, `_uploadArtifact` computes the payload checksum and checks a local `Map`
  scoped to the current `sendEvents` call. Redundant PUT calls for the same payload within
  a single batch are eliminated without leaking state across calls.
- **Real Convex integration test suite** (`tests/integration/api.test.ts`): second
  `describe` block added alongside the existing fixture tests; skipped via
  `describe.skipIf` when `CONVEX_TEST_URL`, `TEST_API_KEY`, or `TEST_AGENT_ID` are not
  set. Covers: create-run (201 + `running` status), send-events (200 + eventIds),
  idempotency (same sequenceNumber returns same ID), 413 for oversized payload, and
  GET /api/runs (200 or 401 depending on auth model).
- **`.env.example`** updated with `CONVEX_TEST_URL`, `TEST_API_KEY`, `TEST_AGENT_ID`
  and full setup instructions.
- **ADR-0011** (`docs/adrs/0011_artifact_gc.md`): orphan definition, safety rationale,
  `BLOB_STORE_TOKEN` Convex env var requirement.

---

## 2. What Prompt 9 Should Accomplish

Items are listed in priority order. Items 1 and 2 unblock the full onboarding flow and
core UI interaction; item 3 is a reliability fix; items 4 and 5 are quality-of-life.

### 2A. Complete `convex/organizations.ts` stubs (CRITICAL)

`createOrg` and `getOrgByClerkId` are stubbed. The Clerk webhook handler that fires on
`organization.created` calls `createOrg` — without a real implementation the org bootstrap
flow silently fails and no org record is ever written to Convex.

Implement:

1. `createOrg(args: { clerkOrgId, name, slug })` — inserts a new record into the
   `organizations` table. Must check for duplicate `clerkOrgId` before inserting (return
   existing record if present — idempotent for webhook retries).
2. `getOrgByClerkId(args: { clerkOrgId })` — queries `organizations` by `clerkOrgId` index
   and returns the record or `null`.
3. `createProject(args: { orgId, name, slug })` — inserts a new `projects` record scoped
   to the org. Already requires `minimumRole: "admin"` (from Prompt 8 RBAC) — ensure the
   implementation enforces this via `requireOrgMembership`.

Acceptance criteria:
- A Clerk `organization.created` webhook round-trip creates an org record visible in Convex
  dashboard.
- `getOrgByClerkId` returns the record on the second webhook delivery (idempotent).
- `createProject` returns a 403 when called with a viewer-role token.

### 2B. Wire `resolveComment` into the `CommentThread` UI

`resolveComment` mutation exists in `convex/comments.ts` but the `CommentThread` component
has no resolve affordance. Engineers viewing a run detail page cannot mark comments as
resolved.

Add:
- A "Resolve" button on each unresolved comment in `CommentThread`.
- On click: call `resolveComment` via a server action (same pattern as tag editing).
- Optimistic UI: grey out / strike-through the comment immediately; revert on error.
- Resolved comments should render with a "Resolved" badge and be collapsed by default
  (expand via "Show resolved" toggle).

Acceptance criteria:
- Clicking "Resolve" on an unresolved comment marks it resolved in Convex.
- The comment list collapses resolved comments with a toggle.
- Viewer-role users see the Resolve button disabled (server action returns 403).

### 2C. Add request timeout and pagination limit on replay endpoint

Very large runs (> 10,000 events) block the replay endpoint indefinitely because
`listEvents` uses Convex pagination with no upper bound on total pages fetched.

Changes needed:
- Add a `MAX_EVENTS_PER_REPLAY = 10_000` constant in `convex/helpers/pagination.ts`.
- The replay service (`apps/web/src/lib/replay/projection.ts` caller) must stop fetching
  pages when the total event count exceeds `MAX_EVENTS_PER_REPLAY` and return a partial
  projection with a `truncated: true` flag in the `ReplayProjection`.
- `ReplayProjection` in `packages/contracts/src/replay.ts` must gain an optional
  `truncated?: boolean` field (non-breaking — additive).
- The `ReplayViewer` component must show a warning banner when `truncated` is `true`.

Acceptance criteria:
- `buildReplayProjection` with 10,001 events returns `truncated: true` and only processes
  the first 10,000 events.
- The ReplayViewer banner is visible when the projection is truncated.
- All existing replay unit tests still pass.

### 2D. Enable integration tests in CI (dedicated test Convex deployment)

The real-Convex integration tests added in Prompt 8 require three env vars and are skipped
in standard CI. This is a known gap — tests that are always skipped in CI provide no
regression protection.

Changes needed:
- Add a GitHub Actions workflow step (or new job) in the CI configuration that provisions
  the three env vars (`CONVEX_TEST_URL`, `TEST_API_KEY`, `TEST_AGENT_ID`) from repository
  secrets and runs `pnpm test --reporter=verbose` against the shared test Convex deployment.
- The test Convex deployment must be a permanent "ci-test" deployment (not ephemeral) to
  avoid flaky setup/teardown timing issues.
- Add a `TEST_AGENT_ID` provisioning note to the CI runbook in `docs/ops/ci_setup.md`
  (create file if it does not exist).

Acceptance criteria:
- CI runs the real-Convex integration tests on every PR.
- A failing integration test blocks merge.
- The "skipped" block in the local test run still works for developers without the env vars.

### 2E. Agent filter dropdown on runs list page

The runs list page currently filters by status and date range. Engineers working with
multiple agents under one org cannot narrow the list to a single agent.

Changes needed:
- `listRuns` in `convex/runs.ts` gains an optional `agentId?: string` filter parameter.
- `convex/agents.ts` (or `convex/runs.ts`) gains a `listDistinctAgents(orgId)` query that
  returns agents that have at least one run in the org (for populating the dropdown).
- `apps/web/app/(app)/runs/page.tsx` gains an agent dropdown next to the status dropdown.
- The filter state is reflected in the URL query param (`?agentId=...`) for shareable URLs.
- `ListRunsRequest` in `packages/contracts/src/api.ts` gains `agentId?: string` (non-
  breaking — additive). Bump contracts version to 0.5.0.

Acceptance criteria:
- Selecting an agent from the dropdown filters the run list to that agent's runs only.
- The URL updates to include `?agentId=<id>` — refreshing the page preserves the filter.
- Selecting "All agents" clears the filter and shows all runs for the org.
- `pnpm typecheck` passes after contracts version bump.

---

## 3. What Must NOT Be Done in Prompt 9

- Do not add real-time event streaming.
- Do not add analytics dashboards or aggregate metrics.
- Do not add webhooks or external integrations (Slack, PagerDuty, etc.).
- Do not change event log immutability rules — no `updateEvent` or `deleteEvent`.
- Do not add AI-powered failure analysis.
- Do not implement multi-region ingestion.
- Do not add billing or usage metering.
- Do not add a mobile application.
- Do not remove `ExternalizedPayload` from the `EventPayload` union or rename its fields.
- Do not remove the `by_run_checksum` index without a schema migration plan.
- Do not add new required fields to `RecorderConfig` without a major SDK version bump.

---

## 4. Acceptance Criteria for Prompt 9

1. `createOrg` and `getOrgByClerkId` are implemented and idempotent; Clerk webhook
   round-trip creates an org record in Convex.
2. `CommentThread` renders a "Resolve" button; clicking it marks the comment resolved
   in Convex; resolved comments collapse with a "Show resolved" toggle.
3. `buildReplayProjection` returns `truncated: true` for runs exceeding 10,000 events;
   `ReplayViewer` shows a warning banner on truncated projections.
4. CI runs real-Convex integration tests on every PR via repository secrets; failing
   integration tests block merge.
5. Runs list page has an agent filter dropdown; filter state is reflected in the URL;
   `ListRunsRequest` gains `agentId?` with a contracts 0.5.0 bump.
6. `pnpm typecheck` passes with zero errors.
7. `./scripts/validate.sh` passes all three checks.
8. All prior tests still pass (>= 653 total, no regressions).

---

## 5. Known Technical Debt After Prompt 8

1. **`convex/organizations.ts` stubs** — `createOrg`, `getOrgByClerkId` are not fully
   implemented. Clerk webhook org bootstrap silently fails. Fix in Prompt 9 (see 2A).
2. **`resolveComment` not wired into UI** — mutation exists but `CommentThread` has no
   resolve affordance. Fix in Prompt 9 (see 2B).
3. **No request timeout on Convex event pagination** — very large runs (> 10,000 events)
   block the replay endpoint indefinitely. Fix in Prompt 9 (see 2C).
4. **Integration tests always skipped in CI** — real-Convex tests require env vars that
   are not present in standard CI. Fix in Prompt 9 (see 2D).
5. **No agent filter on runs list** — engineers with multiple agents cannot narrow the
   list to a single agent. Fix in Prompt 9 (see 2E).
6. **`payload` field comparison is order-sensitive in diff** — JSON.stringify treats
   `{a:1,b:2}` and `{b:2,a:1}` as different. Acceptable for v1 — documented in ADR-0005.
7. **GC requires `BLOB_STORE_TOKEN` in Convex env vars** — separate from Next.js env vars.
   If not set, Convex artifact records are deleted but blobs remain in storage indefinitely.
   Document in ops runbook.
8. **Tag edit optimistic state diverges from server on slow re-renders** — acceptable
   for v1; a future prompt can add proper optimistic update via `useOptimistic`.
