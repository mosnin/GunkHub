# Next Steps — v1.1 Candidates

**Document type:** State summary and v1.1 candidate list.
**Current state:** Prompt 24 complete.

---

## What Prompt 15 delivered

- Run detail breadcrumb: `RunBreadcrumb.tsx` component + `getAgent()` service function + breadcrumb wired into run detail page above RunHeader. Two non-fatal Convex queries (project + agent) per page load; failure degrades gracefully without breaking the run detail view.
- Schema drift check: `scripts/check-schema-drift.ts` parses `convex/schema.ts` and `packages/contracts/src/entities.ts`, compares field sets per entity, exits 1 on any mismatch. Exports `parseSchemaTableFields` and `parseContractsInterfaceProperties` as named exports.
- `scripts/validate.sh` updated: drift check is now the fourth mandatory check.
- `.github/workflows/ci.yml` updated: `schema-drift` job runs on every push and pull request.
- `docs/ops/ci_setup.md` updated to document the schema-drift job.
- `tests/unit/schema_drift.test.ts`: 12 unit tests for both parsing functions including exclusion logic.
- Final test count: **513 passing, 5 skipped, 18 test files, all green**.

---

## What Prompt 16 delivered

- **Audit — Scenario A confirmed:** `packages/sdk/src/transport.ts` `sendEvents()` already contained complete auto-externalization logic (upload to `/api/artifacts/upload`, replace payload with `ExternalizedPayload` pointer, per-`sendEvents` upload cache). The "SDK auto-externalization missing" note in prior working memory was stale. No SDK source changes were needed.
- **`apps/web/src/components/runs/ArtifactList.tsx` rewrite:** Converted from a server component with a silent-failure `<a download>` anchor to a `'use client'` component. Key additions: per-row `downloadStates` record tracking `{ downloading, error }`, `handleDownload()` using programmatic `fetch`, structured `{ code, message }` JSON error parsing for 401/404/502/500 responses with inline `text-red-400` error display in the Download cell, blob download via `URL.createObjectURL` + hidden `<a>` ref with 10s object URL revocation, and `extractFilename()` helper that prefers RFC 5987 `filename*=UTF-8''...` before falling back to plain `filename=` and then `artifact.name ?? artifact.id`.
- **`tests/unit/transport-externalization.test.ts` — Group 6 (upload cache deduplication):** Two new tests: (1) asserts `_uploadArtifact` is called exactly once when two identical large payloads appear in the same batch, and both events carry the same `artifactId` in their externalized bodies; (2) asserts `_uploadArtifact` is called twice and events carry distinct `artifactId` values when payloads differ.
- Final test count: **515 passing, 5 skipped, 18 test files, all green**.

---

## What Prompt 17 delivered

- **Bounded rendering in Timeline.tsx:** Added `WINDOW_SIZE = 100` constant and `windowStart` state. Timeline renders only `allEvents.slice(windowStart, windowStart + WINDOW_SIZE)` (visibleEvents). Keyboard navigation maps events with absolute index `absIdx = windowStart + relIdx` so the focus ring is stable across window shifts. "↑ N earlier events" and "↓ N more loaded events" navigation buttons allow moving the window without loading more data from the server.
- **Bounded rendering in EventInspector.tsx:** Same `WINDOW_SIZE = 100` sliding window applied to the left panel. Click on an event calls `ensureSelectedVisible` to adjust `windowStart` so the selected event stays in view. Deep link auto-seek: if `initialEventSeq` is not in the initial loaded events and a server cursor exists, EventInspector sets `seekState='seeking'` and auto-triggers `handleLoadMore()` pages until the target event is found or the cursor is exhausted. Shows "Seeking event #N…" during seek, "Event #N not found in this run." when the cursor is exhausted.
- **Version list pagination:** New Convex query `paginateAgentVersions` using `.paginate()`, 20 items/page, 100 max. New service function `listAgentVersionsPaginated`. New API route `GET /api/agents/[agentId]/versions?cursor=...&limit=N`. `VersionSection` component now accepts `nextCursor: string | null` and renders a "Load more versions…" button when `nextCursor` is non-null.
- **New tests:** `tests/unit/timeline_window.test.ts` (25 tests) and `tests/unit/version_pagination.test.ts` (14 tests). All pure logic, no React imports. Total test count: **554 passing, 5 skipped, 20 test files**.

---

## What Prompt 18 delivered

- **Auto-advance window in Timeline.tsx and EventInspector.tsx:** After `handleLoadMore` completes, `windowStart` is set to `Math.max(0, newTotal - WINDOW_SIZE)` so the newly loaded events are immediately visible. Eliminates the two-click friction from Prompt 17 where users had to click "Load more" and then separately click the window-advance button.
- **Live polling in Timeline.tsx (`isLive` prop):** A 5-second `setInterval` polls for new events when `isLive` is true. Cursor path: if `cursor` exists, calls `handleLoadMore()` to fetch the next paginated page. No-cursor path: re-fetches from start and deduplicates by event ID. Shows an animate-pulse emerald dot and "live" label above the event list.
- **Live polling in EventInspector.tsx (`isLive` prop):** Same 5s polling strategy as Timeline. Selection stability invariant: `selectedId` and `focusedIdx` are never modified by a polling update. Live dot shown in the Events left-panel header.
- **Live status polling in RunHeader.tsx (`isLive` prop):** Polls `GET /api/runs/${runId}` every 5s when status is `'running'`. Updates `liveStatus` and `liveEndedAt` in local state; badge and duration display use the live values. Stops polling when status transitions to a terminal state. Shows animate-pulse dot and "live" label next to the status badge.
- **page.tsx wiring:** Passes `isLive={run.status === 'running'}` to RunHeader, Timeline, and EventInspector.
- **New tests:** `tests/unit/active_run.test.ts` (21 tests) — auto-advance window computation, event dedup for live polling, terminal status detection via contracts, and `isLive` activation rule. Total test count: **575 passing, 5 skipped, 21 test files**.

---

## What Prompt 22 delivered

- **`reverifyRun` Convex action**: new public action in `convex/projection_verify.ts`. Auth-gated (Clerk identity + member+ role via two `internalQuery` helpers). Runs same seq + derivation flow as the nightly cron, bounded by `DERIVATION_MAX_EVENTS=500`, graceful degradation to sequence-only. Returns result shape for immediate UI use.
- **`reverifyRunAction` Next.js server action**: `apps/web/src/lib/actions/verification.ts`. Checks Clerk session, calls `client.action(convex.projection_verify.reverifyRun, ...)`, maps raw result to `VerificationStatus`. Re-exported from `apps/web/app/(app)/runs/[runId]/actions.ts`.
- **`VerificationFailureDetail` component**: pure presentational component (`apps/web/src/components/runs/VerificationFailureDetail.tsx`). Renders ordered issue list for each failure type (sequence gaps, duplicates, replay failed, failureSummary failed) with system-grounded remediation hints. `buildIssues()` exported for testing.
- **`VerificationPanel` component** (`'use client'`): `apps/web/src/components/runs/VerificationPanel.tsx`. Shows `IntegrityBadge`, age label, per-check `CheckPill` row (sequence/replay/failureSummary — ran/skipped + passed/failed), partial verification notice when seq-only, inline error display, "Re-verify" button with pending state.
- **Run detail page wired**: `VerificationPanel` rendered between `FailureSummaryPanel` and the tab bar for terminal runs.
- **Tests**: `tests/unit/reverify_panel.test.ts` — 48 pure-logic tests across 8 groups covering result mapping, state transitions, issue generation, CheckPill states, error handling, and partial verification detection.
- **Build log updated** with full implementation notes for Prompt 22.

---

## What Prompt 24 delivered

- **Unified 4-term vocabulary**: `unverified`, `partial`, `verified`, `failed` — replacing `seq verified`/`seq_verified`/`check failed` across all surfaces. `IntegrityBadge` labels, filter pill values, URL params, and `VerificationPanel` notice text all use the same terms. Documented in ADR-0022 as a hard-to-reverse URL param change.
- **`SelectableRunList` client component**: New `'use client'` component replacing `RunList` on the /runs page. Checkbox column for multi-select (terminal runs only: completed/failed/cancelled/timed_out). Select-all header checkbox. Bulk action bar with eligible count, "Re-verify N" button, and per-row ✓/✗ result indicators. `useTransition` for async action with "Re-verifying…" pending state.
- **`bulkReverifyAction` server action**: Parallel `reverifyRunAction` calls via `Promise.allSettled`, bounded to 20 runs, returns `BulkReverifyResult` with `succeeded`/`failed`/`errors`.
- **Dashboard link update**: "view all →" → "view all failed →" with title hint about bulk re-verify on the runs page.
- **New tests**: `tests/unit/verification_vocab.test.ts` (57 tests) and `tests/unit/bulk_reverify.test.ts` (40 tests). Updated `verification_discoverability.test.ts` for new vocabulary. Total test count: **851 passing, 5 skipped, 29 test files**.

---

## What Prompt 23 delivered

- **Integrity column on RunList**: Optional `verificationStatuses` prop; when passed, shows an "Integrity" column with `IntegrityBadge` per row. Dashboard does not pass the prop (no column). Runs page passes it (column shown).
- **Verification filter on runs page**: `VerifyFilter` type (`all/verified/partial/failed/unverified`), `matchesVerifyFilter()` pure function, `buildHref()` helper preserving active params. Batch-fetches verification statuses post-fetch (non-fatal). New "Integrity" filter pill group in the filter bar.
- **Dashboard verification issues section**: Compact list of up to 5 recent failed verifications (fetched via `listRecentFailedVerifications`). All-clear state, "view all →" link to `/runs?verify=failed`. Non-fatal fetch.
- **New Convex queries**: `batchGetVerificationResults` (bounded to 100 runIds, per-record orgId safety check) and `listRecentFailedVerifications` (by_org_verified index, over-fetch 200 + filter, cap 20).
- **New service functions**: `batchGetRunVerificationStatuses`, `getRecentFailedVerifications`, `UNVERIFIED_STATUS` constant, `FailedVerification` interface — all in `apps/web/src/lib/services/projection_verify.ts`.
- **New tests**: `tests/unit/verification_discoverability.test.ts` — 54 pure-logic tests. Total test count: **794 passing, 5 skipped, 27 test files**.

---

## What Prompt 22 delivered

- **`reverifyRun` Convex action**: auth-gated (member+), same seq + derivation flow as nightly cron, DERIVATION_MAX_EVENTS=500, graceful degradation to seq-only.
- **`reverifyRunAction` Next.js server action**: `apps/web/src/lib/actions/verification.ts`. Checks Clerk session, calls action, maps result.
- **`VerificationFailureDetail`**: pure component with `buildIssues()` for all 4 failure types with system-grounded remediation hints.
- **`VerificationPanel`** (`'use client'`): CheckPill row, re-verify button, IntegrityBadge, error display, partial verification notice.
- **New tests**: `tests/unit/reverify_panel.test.ts` — 54 pure-logic tests.

---

## What Prompt 21 delivered

- **Full derivation verification via internal HTTP route** (`POST /api/internal/verify-derivation`): New stateless Next.js route protected by `INTERNAL_VERIFY_SECRET`. Receives raw Convex run/event documents, maps them to contracts types, calls `verifyProjectionIntegrity`, and returns `checksRan`, `replayPassed`, `failureSummaryPassed` alongside the existing sequence fields.
- **Convex action extended** (`verifyRecentRuns`): When `INTERNAL_VERIFY_URL` and `INTERNAL_VERIFY_SECRET` are set in the Convex environment, the action fetches full event documents (`_listEventsFull`) and POSTs to the web route for full derivation check. Falls back to sequence-only on any error or if the run exceeds `DERIVATION_MAX_EVENTS = 500`.
- **`verification_results` schema extended**: Three optional fields added — `checksRan`, `replayPassed`, `failureSummaryPassed`. Old records unaffected.
- **`VerificationStatus` service extended**: New `checksRan`, `replayPassed`, `failureSummaryPassed` fields. Absent fields map to `[]` / `null`.
- **`IntegrityBadge` richer states**: Now shows `seq verified` (sky blue) for valid sequence-only records, `verified` (emerald) for full derivation-verified records, `check failed` (red) for any failure, `unverified` (gray) for no record yet.
- **New tests**: `tests/unit/derivation_verify.test.ts` (43 tests). Total test count: **680 passing, 5 skipped, 24 test files**.
- **ADR-0021**: Documents the internal-route architecture decision, environment variable setup, size cap, and graceful degradation.

---

## What Prompt 20 delivered

- **Follow-tail model for Timeline.tsx and EventInspector.tsx**: `followTail` boolean state (defaults to `isLive`). When following, polls auto-advance the window to the tail. When paused, `unseenCount` accumulates new event arrivals. "↓ N new — resume" badge shown when paused with unseen events. Toggle turns off on ArrowDown/ArrowUp, event row click, "earlier events" button click.
- **New tests**: `tests/unit/follow_tail.test.ts` (31 tests). Total test count: **637 passing (before Prompt 21), 5 skipped, 23 test files**.

---

## What Prompt 19 delivered

- **Daily scheduled sequence integrity verification** (`convex/projection_verify.ts`): Convex cron at 04:30 UTC verifying up to 50 recent terminal runs (48h window). `checkSequenceIntegrity` detects gaps and duplicates in the event sequence and stores per-run outcomes in a new `verification_results` table. Logic inlined in the Convex action (documented in ADR-0020) because Convex actions cannot import from `apps/web` context.
- **`listComments` auth fix**: `orgId` is now a required argument; `requireOrgMembership` is called before any data access. The query also applies an explicit `.filter()` by `orgId`. This closes a tenancy gap where callers could query without proving org membership. All `apps/web` callers updated.
- **Artifact download route orgId guard**: `GET /api/artifacts/[id]/download` now checks `orgId` at the route level (in addition to `userId`) before passing control to the Convex service layer. Consistent with org-scoped route pattern used by other API routes.
- **`IntegrityBadge` UI component**: Run detail page header shows a green "Sequence OK" or amber "Sequence warning" badge based on the most recent `verification_results` record for the run.
- **New tests**: `tests/unit/scheduled_verify.test.ts` (47 tests) and `tests/unit/read_path_auth.test.ts` (15 tests). Total test count: **637 passing, 5 skipped, 23 test files**.

---

## v1.1 Candidates

Listed in rough priority order.

### HIGH

**1. SDK auto-externalization** — DONE
Audited in Prompt 16 — already fully implemented in `packages/sdk/src/transport.ts` `sendEvents()`: upload to `POST /api/artifacts/upload`, replace payload with `ExternalizedPayload` pointer, per-`sendEvents` upload cache for deduplication within a batch. No action required.

**2. Artifact download error UX** — DONE
Implemented in Prompt 16. `apps/web/src/components/runs/ArtifactList.tsx` rewritten as a `'use client'` component with programmatic `fetch('/api/artifacts/${id}/download')`, per-row `downloadStates` tracking `{ downloading, error }`, inline `text-red-400` error display parsed from `{ code, message }` JSON error bodies, blob download via `URL.createObjectURL` + hidden `<a>` ref with 10s revocation, and `extractFilename()` with RFC 5987 support.

### MEDIUM

**3. Version list pagination** — DONE
Implemented in Prompt 17 with Convex `.paginate()`, 20 items/page, 100 max. `paginateAgentVersions` query, `listAgentVersionsPaginated` service, `GET /api/agents/[agentId]/versions?cursor=...&limit=N` route, and "Load more versions…" button in `VersionSection`.

### LOW

**4. Event list virtualization** — addressed in Prompt 17 with bounded window (not full react-window)
Timeline and EventInspector now render at most 100 events at a time (`WINDOW_SIZE = 100`). This eliminates the DOM growth problem for typical runs. Full `react-window` virtualization remains an option if a run needs all events visible simultaneously without page navigation, but the sliding window approach covers the common debugging use case without an additional dependency.

**5. Background projection verification** — DONE (Prompt 19)
Daily Convex cron at 04:30 UTC verifies up to 50 recent terminal runs (48h window) for sequence gaps and duplicates. Results stored in `verification_results` table. `IntegrityBadge` component on run detail page surfaces the latest result.

**6. Live run monitoring** — DONE (Prompt 18)
Implemented via 5s polling on RunHeader, Timeline, and EventInspector. `isLive` prop wired from page.tsx. Animate-pulse indicators, cursor/no-cursor dedup strategy, selection stability.

**7. RBAC viewer-vs-member on read paths**
Roles (`admin`, `member`, `viewer`) are stored and enforced on write mutations. The viewer-vs-member distinction on read paths is deferred.

**8. Version label enrichment at scale**
The run list page fetches one `getAgentVersion` per distinct version ID per page load. At v1 scale (1–3 distinct versions per page) this is fast. Consider caching or a batch query if pages regularly show many distinct versions.

---

## Prompt 18 Candidates — DONE

**1. Live run monitoring** — DONE
Implemented in Prompt 18. `isLive` prop on RunHeader, Timeline, and EventInspector. 5s polling with cursor/no-cursor strategies, animate-pulse live indicators, selection stability invariant in EventInspector.

**2. Auto-scroll on new event load** — DONE
Implemented in Prompt 18 as part of auto-advance window. After `handleLoadMore` completes, `windowStart` advances to `Math.max(0, newTotal - WINDOW_SIZE)` automatically.

---

## Prompt 20 Candidates

**1. Follow-tail toggle (highest value)**
Timeline and EventInspector auto-advance the window on each poll (newest events visible), but users who scroll backward to inspect earlier events will find the window jumping forward again on the next poll. A "follow tail" toggle — on by default for live runs — would let users anchor the window to the latest events while polling, and turn it off to inspect historical events without interruption.

**2. Replay tab live refresh**
The replay projection is computed server-side from the event log. When a run is in progress, the replay tab shows a stale projection until the user manually reloads the page. A client-side hook or route re-fetch (similar to the RunHeader polling approach) could regenerate the projection periodically for running runs, bringing the replay view up to date without a full page reload.

**3. RBAC viewer-vs-member on read paths**
Roles (`admin`, `member`, `viewer`) are stored and enforced on write mutations. The viewer-vs-member distinction on read paths is deferred. Now that the read-path auth pattern has been tightened in Prompt 19 (listComments, artifact download), extending RBAC to viewer-level enforcement on read queries is a natural next step.

**4. Version label enrichment at scale**
The run list page fetches one `getAgentVersion` per distinct version ID per page load. At v1 scale (1–3 distinct versions per page) this is fast. Consider caching or a batch query if pages regularly show many distinct versions.

---

## What must NOT be added in v1.1

- Real-time collaboration or live streaming of events to multiple viewers
- Analytics dashboards or aggregate metrics
- Agent marketplace or registry
- Policy engine or compliance features
- Billing or usage metering
- Full deployment/promotion workflows
- Config diffing or version comparison
