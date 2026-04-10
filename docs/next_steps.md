# Next Steps — Prompt 11 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 10 complete.
**This document:** Defines what Prompt 11 should accomplish, based on remaining gaps after Prompt 10.

---

## 1. What Was Accomplished in Prompt 10

Prompt 10 closed scale and production safety gaps:

- **Event pagination** — Timeline and EventInspector load 200 events at a time, with a "Load more" button fetching subsequent pages via `/api/runs/[id]/events?cursor=X&limit=200`. Reduces initial payload from 500 to 200 events.
- **Diff boundedness** — `fetchAllEvents` caps at `MAX_EVENTS_PER_DIFF = 10_000`; `RunDiff.truncated` propagates to DiffViewer as an orange warning banner. ADR-0013 documents the decision.
- **Artifact GC scaling** — `getOrphanCandidates` rewritten from `.collect()` full scan to indexed range query on `by_created_at` with `paginate({ numItems: GC_CANDIDATE_PAGE_SIZE })`. ADR-0014 documents the decision.
- **Org bootstrap tests** — 15 unit tests in `org_bootstrap.test.ts` prove `upsertOrganization`, `upsertMembership`, and `clerkRoleToInternal` correctness. ADR-0012 formalizes the pipeline.
- **Contracts bumped to 0.6.0** — `RunDiff.truncated` is the additive change.

---

## 2. What Prompt 11 Should Accomplish

Items are listed in priority order.

### 2A. Run detail: keyboard navigation and shareable event URL

Engineers debugging a run need to move through events quickly and share deep links to a specific event.

Changes needed:

1. **Keyboard navigation in Timeline and EventInspector.** When a Timeline or EventInspector is focused, arrow keys (↑/↓) move the selection. Enter expands/collapses the focused event. This requires managing a `focusedIndex` integer state alongside `expandedId`/`selectedId`.

2. **Deep-link URL for selected event.** Add a `?event=<sequenceNumber>` query parameter to the run detail URL. When `?event=` is present, the EventInspector should auto-select that event on mount. The Timeline should scroll the row into view. Changing the selected event updates the URL without a full navigation (use `history.replaceState` or Next.js `router.replace`).

3. **Copy event URL button.** In the EventInspector right panel header, add a small clipboard icon button. On click, copies the current URL (including `?event=`) to the clipboard. Show a brief "Copied!" confirmation.

Acceptance criteria:
- Arrow keys navigate events in the timeline and inspector.
- `?event=5` in the URL pre-selects event with sequenceNumber 5.
- The copy button copies the canonical URL.
- `pnpm typecheck` passes.

### 2B. Run search — full-text tag and metadata filter

The runs list currently filters by status, date range, and agent. Engineers cannot search by tag value or metadata key/value.

Changes needed:

1. `listRuns` in `convex/runs.ts` gains an optional `tag?: string` filter — adds `.filter((q) => q.includes(q.field("tags"), args.tag))` to the existing query chain.
2. `ListRunsRequest` in `packages/contracts/src/api.ts` gains `tag?: string` (non-breaking additive). Bump contracts to 0.7.0.
3. `apps/web/app/(app)/runs/page.tsx` gains a tag search input field. Value is reflected in `?tag=` URL query param. Works alongside existing filters.

Acceptance criteria:
- Typing a tag value into the search field and pressing Enter filters the run list to runs containing that exact tag.
- The URL updates to include `?tag=<value>`.
- `pnpm typecheck` passes after contracts version bump.

### 2C. Run detail page: event count and total duration in header

The `RunHeader` currently shows status, agent name, start time, elapsed duration, and tags. It does not show how many events the run produced.

Changes needed:

1. `RunHeader` accepts an optional `eventCount?: number` prop.
2. `apps/web/app/(app)/runs/[runId]/page.tsx` passes `eventsData?.events.length` (plus any loaded extra pages — just the initial count is acceptable for now).
3. Display `eventCount` in the header row as a small `N events` pill.

Acceptance criteria:
- Run header shows an event count when `eventCount` is provided.
- Component still renders correctly when `eventCount` is undefined (existing runs).

### 2D. Artifact download link in ArtifactList

`ArtifactList` shows artifact metadata (name, size, MIME type, checksum) but provides no way to download the artifact.

Changes needed:

1. Add a `GET /api/artifacts/[id]/download` route that:
   - Authenticates via Clerk session (same as other API routes).
   - Queries the artifact record from Convex, checks org membership.
   - Issues a `fetch` to the blob storage URL with `BLOB_STORE_TOKEN`.
   - Streams the response body back to the client with the correct `Content-Type` and `Content-Disposition: attachment` header.
2. `ArtifactList` gains a small download icon button per artifact row that navigates to this route.

Acceptance criteria:
- Clicking the download button triggers a file download in the browser.
- The download route returns 404 if the artifact does not belong to the caller's org.
- The download route returns 401 if unauthenticated.

---

## 3. What Must NOT Be Done in Prompt 11

- Do not add real-time event streaming.
- Do not add analytics dashboards or aggregate metrics.
- Do not change event log immutability rules — no `updateEvent` or `deleteEvent`.
- Do not implement multi-region ingestion.
- Do not add billing or usage metering.
- Do not remove the `by_created_at` index from artifacts without a migration plan.
- Do not add new required fields to `RecorderConfig` without a major SDK version bump.

---

## 4. Acceptance Criteria for Prompt 11

1. Timeline and EventInspector support ↑/↓ keyboard navigation.
2. `?event=<N>` in the URL pre-selects the event; copy button writes canonical URL to clipboard.
3. `?tag=` filter is reflected in URL and passed to `listRuns`; contracts bumped to 0.7.0.
4. Run header shows an optional event count pill.
5. `GET /api/artifacts/[id]/download` returns the blob with correct headers; 401/404 guards in place.
6. `pnpm typecheck` passes with zero errors.
7. `./scripts/validate.sh` passes all three checks.
8. All prior tests still pass (>= 426 total, no regressions).

---

## 5. Known Technical Debt After Prompt 10

1. **Event pagination loads more on demand but does not virtualize the list.** For runs with tens of thousands of events and heavy "load more" usage, the DOM can grow large. A virtual scroll list (e.g., `react-window`) is the long-term fix — acceptable for v1.
2. **Diff comparison is position-based and order-sensitive.** JSON.stringify field comparison treats `{a:1,b:2}` and `{b:2,a:1}` as different. Documented in ADR-0005 as acceptable for v1.
3. **GC processes one page per daily run.** Large orphan backlogs accumulate over multiple days. Acceptable — steady state has no backlog after the first sweep.
4. **`BLOB_STORE_TOKEN` must be set in Convex env vars separately from Next.js env vars.** If missing, blob records are cleaned but storage blobs remain. Documented in ops runbook.
5. **ArtifactList has no download affordance** — no way to retrieve the externalized payload from the UI. Fix in Prompt 11 (see 2D).
6. **No keyboard navigation in Timeline/EventInspector.** Fixed in Prompt 11 (see 2A).
7. **Run list has no tag search.** Fixed in Prompt 11 (see 2B).
