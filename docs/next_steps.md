# Next Steps — v1.1 Candidates

**Document type:** State summary and v1.1 candidate list.
**Current state:** Prompt 17 complete.

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

**5. Background projection verification**
No scheduled job verifies run sequence integrity in production. Integrity checks are on-demand only via `scripts/rebuild-projection.ts`. A Convex cron checking a sample of recent runs would provide proactive alerting.

**6. Live run monitoring**
The run detail page does not auto-refresh while a run is in progress. Engineers watching a live run must manually reload. A polling interval or Convex real-time subscription would improve the debugging workflow.

**7. RBAC viewer-vs-member on read paths**
Roles (`admin`, `member`, `viewer`) are stored and enforced on write mutations. The viewer-vs-member distinction on read paths is deferred.

**8. Version label enrichment at scale**
The run list page fetches one `getAgentVersion` per distinct version ID per page load. At v1 scale (1–3 distinct versions per page) this is fast. Consider caching or a batch query if pages regularly show many distinct versions.

---

## Prompt 18 Candidates

**1. Live run monitoring (highest value)**
The run detail page does not auto-refresh while a run is in progress. Engineers watching a live run must manually reload. A Convex real-time subscription (replacing the current one-shot server component fetch for events) would make the timeline update automatically as the agent emits events. This was LOW item 6 in the prior list; with bounded rendering now in place, live updates are the next UX gap that most affects the debugging workflow.

**2. Background projection verification**
No scheduled job verifies run sequence integrity in production. Integrity checks are on-demand only via `scripts/rebuild-projection.ts`. A Convex cron checking a sample of recent runs would provide proactive alerting before users encounter corrupted traces. This was LOW item 5 in the prior list.

**3. Auto-scroll on new event load**
Timeline and EventInspector do not auto-scroll to the newly visible window after the user clicks "Load more" and then the window advances. The user must click "Load more" (which fetches more events from the server) and then separately click "↓ N more loaded events" (which shifts the window forward). Automatically advancing the window to show new events after a server load-more completes would collapse this into a single action.

---

## What must NOT be added in v1.1

- Real-time collaboration or live streaming of events to multiple viewers
- Analytics dashboards or aggregate metrics
- Agent marketplace or registry
- Policy engine or compliance features
- Billing or usage metering
- Full deployment/promotion workflows
- Config diffing or version comparison
