# Next Steps — Prompt 12 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 11 complete.
**This document:** Defines what Prompt 12 should accomplish, based on remaining gaps after Prompt 11.

---

## 1. What Was Accomplished in Prompt 11

Prompt 11 was an operational quality pass:

- **Run filter performance** — `listRuns` now uses index range queries for `startedAfter`. New compound index `by_org_status_started = ["orgId", "status", "startedAt"]` handles combined status+date filter in O(result set) rather than O(org runs). ADR-0015.
- **GC visibility** — `cleanOrphanedArtifacts` now separates errors into `blobErrors`, `checkErrors`, `recordErrors`; logs artifact ID and storage key on failure; emits "will retry next GC run" warning on blob delete failure; logs bounded-batch message when more candidates remain. Operations runbook updated with GC outcomes section.
- **Tag editing consistency** — `RunHeader` adds `savedTags` state updated on successful save. Read-only view renders `savedTags` instead of stale SSR prop. Cancel/Escape/error revert all use `savedTags` as the reset target.
- **CI release gate** — integration-test job now requires unit tests first (`needs: [test]`). Explicit notice/warning emitted on every run showing whether secrets are configured. Hard fail on `main` branch when `CONVEX_TEST_URL` is absent. `docs/ops/ci_setup.md` and `docs/release_readiness.md` updated.

---

## 2. What Prompt 12 Should Accomplish

Items are listed in priority order.

### 2A. Artifact download link (HIGH — last major UI gap)

Artifacts are visible in ArtifactList but not retrievable. Engineers must use Convex dashboard to find the storage key and manually fetch.

Changes needed:

1. `GET /api/artifacts/[id]/download` route:
   - Clerk session auth (same pattern as other routes)
   - Query artifact record from Convex; verify it belongs to caller's org
   - Fetch blob from Vercel Blob storage using `BLOB_STORE_TOKEN`
   - Stream response with `Content-Type` from artifact `mimeType` field and `Content-Disposition: attachment; filename="<artifact.name>"`
   - Return 401 if unauthenticated, 404 if artifact not found or wrong org, 502 if blob fetch fails

2. `ArtifactList.tsx`: add a download icon button per artifact row that navigates to the download route.

Acceptance criteria:
- Clicking download triggers a file download in the browser.
- 404 returned if artifact doesn't belong to caller's org.
- 401 returned if unauthenticated.

### 2B. Keyboard navigation in Timeline and EventInspector (MEDIUM)

Engineers debug runs by scanning events. Mouse-only navigation in a list of 200+ events is slow.

Changes needed:

1. **Timeline**: when the list is focused, ↑/↓ move a highlighted row; Enter expands/collapses. Manage `focusedIndex` state alongside `expandedId`.
2. **EventInspector**: same — ↑/↓ navigate the left event list; selection updates the right payload panel.

Acceptance criteria:
- Arrow keys navigate events.
- No change to mouse interaction.
- No new dependencies.

### 2C. Shareable event URL (LOW — quality of life)

Engineers share a link to a specific event in a run for debugging collaboration.

Changes needed:

1. Add `?event=<sequenceNumber>` query param to the run detail URL.
2. EventInspector auto-selects that event on mount when `?event=` is present.
3. A "Copy event link" button in the EventInspector right panel header copies the current URL including `?event=`.
4. Changing the selected event updates the URL without full navigation (`history.replaceState`).

Acceptance criteria:
- `?event=5` pre-selects event with `sequenceNumber 5`.
- Copy button copies canonical URL including `?event=`.
- `pnpm typecheck` passes.

### 2D. Run stuck-in-running timeout (LOW — operator quality of life)

Runs that crash without calling `run.complete()` or `run.fail()` stay in `running` forever. Operators currently patch manually via the Convex dashboard.

Changes needed:

1. Add `STALE_RUN_TIMEOUT_MS` constant (e.g., 24 hours) to `convex/helpers/pagination.ts`.
2. Add `expireStaleRuns` internalAction that queries runs with `status = "running"` and `startedAt < cutoff`, then calls `updateRunStatus` with `status = "timed_out"`.
3. Add a daily cron entry in `convex/crons.ts` for `expireStaleRuns` (at 03:00 UTC, distinct from GC at 02:00).
4. Update the operations runbook — remove the manual Convex dashboard patch instructions, replace with "runs auto-expire after 24 hours".

Acceptance criteria:
- Runs stuck in `running` for > 24 hours are transitioned to `timed_out` by the daily cron.
- The status transition uses the existing `updateRunStatus` mutation (enforces valid transitions).
- `pnpm typecheck` passes.

---

## 3. What Must NOT Be Done in Prompt 12

- Do not add real-time event streaming.
- Do not add analytics dashboards or aggregate metrics.
- Do not change event log immutability rules.
- Do not redesign replay, diff, or the SDK.
- Do not add billing or usage metering.
- Do not add new background processing services beyond the stale-run timeout cron.

---

## 4. Acceptance Criteria for Prompt 12

1. `GET /api/artifacts/[id]/download` returns the blob with correct headers; 401/404 guards in place; ArtifactList has download button.
2. Timeline and EventInspector support ↑/↓ keyboard navigation.
3. `?event=<N>` pre-selects the event; copy button writes canonical URL to clipboard.
4. Stale runs auto-expire via daily cron after 24 hours.
5. `pnpm typecheck` passes with zero errors.
6. `./scripts/validate.sh` passes all three checks.
7. All prior tests still pass (>= 443 total, no regressions).
8. `docs/build_log.md`, `docs/working_memory.md`, `docs/next_steps.md` updated.

---

## 5. Known Technical Debt After Prompt 11

1. **Artifact download not available from UI** — engineers must use Convex dashboard to retrieve blobs. Fix in Prompt 12 (2A).
2. **No keyboard navigation** in Timeline/EventInspector. Fix in Prompt 12 (2B).
3. **No shareable event URL** for deep-linking to a specific event. Fix in Prompt 12 (2C).
4. **Runs stuck in `running` require manual Convex dashboard patch.** Fix in Prompt 12 (2D).
5. **Event list is not virtualized** — 10,000+ events loaded via "Load more" may cause sluggish scroll. Acceptable for v1; virtual scroll (react-window) is v1.1.
6. **`agentId + status + date` filter still applies status in-memory** — acceptable because agent-scoped run counts are small. Would require a `by_agent_status_started` index to fix cleanly.
7. **GC processes one page per daily run** — large orphan backlogs clear over multiple days. Acceptable at v1 scale.
