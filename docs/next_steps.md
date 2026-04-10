# Next Steps — Prompt 13 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 12 complete.
**This document:** Defines what Prompt 13 should accomplish, based on remaining gaps after Prompt 12.

---

## 1. What Was Accomplished in Prompt 12

Prompt 12 closed the last major UI and operational gaps:

- **Artifact download** — `GET /api/artifacts/[id]/download` streams blobs with Clerk session auth and Convex org verification. ArtifactList has a per-row download link. ADR-0016.
- **Stale run expiry** — `expireStaleRuns` internalAction + daily cron at 03:00 UTC auto-transitions runs stuck in `running` for >24 hours to `timed_out`. Operations runbook updated. ADR-0017.
- **Keyboard navigation** — Timeline: ArrowUp/Down/Enter navigate and expand events. EventInspector: ArrowUp/Down in the left event list. Both have focus-ring highlights. Mouse interaction unchanged.
- **Event deep links** — `?event=<sequenceNumber>` pre-selects an event in EventInspector on load. Selection updates URL via `history.replaceState`. "Copy link" button in right panel header. ADR-0018.

---

## 2. What Prompt 13 Should Accomplish

Items are listed in priority order. Prompt 13 is a hardening and polish pass — v1 is feature-complete; the remaining items close operational, SDK, and UX gaps that will be felt early in a production deployment.

### 2A. SDK auto-externalization (HIGH — relieves a production footgun)

Currently, if a caller sends an event payload >10 KB via the SDK, the API returns HTTP 413 and the SDK surfaces the error to the caller. The caller must manually externalize the payload. This is a footgun in production.

Changes needed:

1. In `packages/sdk/src/transport.ts`, in the `sendEvents` method:
   - Before calling `POST /api/events`, scan each event's payload for byte size.
   - If any payload exceeds `PAYLOAD_EXTERNALIZATION_THRESHOLD` (10,240 bytes), call `_uploadArtifact` for that payload and replace the event payload with the returned `ExternalizedPayload` pointer.
   - This is the same path `HttpTransport` already uses — check whether `_uploadArtifact` is called correctly for individual event payloads in addition to the existing call site.
2. Add unit tests in `tests/unit/transport-externalization.test.ts` proving auto-externalization fires for >10 KB payloads and leaves <10 KB payloads untouched.
3. Update `docs/release_readiness.md` to mark SDK auto-externalization as resolved (remove from deferred list).

Acceptance criteria:
- Sending an event with a 15 KB payload via the SDK results in a successful event record (not a 413).
- Sending an event with a 5 KB payload skips the upload step.
- `pnpm typecheck` passes.

### 2B. Artifact download error UX (MEDIUM — prevents blank download on 404/502)

When the download route returns 404 or 502, the browser silently downloads a JSON error body with a `.download` link. Engineers don't know what went wrong.

Changes needed:

1. Update `ArtifactList.tsx`:
   - Convert to a `'use client'` component.
   - Replace the plain `<a download>` anchor with a button that calls `fetch` on click.
   - If the fetch response is not ok (non-2xx), read the JSON body and show an inline error message (e.g., a toast or an inline `<p className="text-red-400">` under the row).
   - If ok, trigger browser download via a `Blob` URL (`URL.createObjectURL`) and `<a>` programmatic click.
2. The download route itself does not change.

Acceptance criteria:
- Successful download triggers file download with correct filename.
- 404 (artifact not found or wrong org) shows a human-readable error message in the UI.
- 502 (blob storage unavailable) shows an error message.
- No new npm dependencies.

### 2C. Run detail breadcrumb navigation (LOW — discoverability)

Engineers navigating to a run detail page from search results or a shared URL have no way to navigate back to the project or agent without using the browser Back button.

Changes needed:

1. `apps/web/app/(app)/runs/[runId]/page.tsx`:
   - Read `run.projectId` and `run.agentId` from the run data.
   - Render a breadcrumb above the `RunHeader`: `Organization → Project → Agent → Run <id>`
   - Link Organization to `/`, Project to `/projects/[projectId]`, Agent to `/agents/[agentId]`.
2. No new pages needed — the links can 404 gracefully until those pages are implemented.

Acceptance criteria:
- Breadcrumb is visible on run detail page.
- Each segment is a link.
- `pnpm typecheck` passes.

### 2D. Convex schema validation check in CI (LOW — catches drift early)

Currently, `pnpm typecheck` catches TypeScript errors in Convex functions but not schema validator mismatches (e.g., a field in `schema.ts` that differs from the corresponding field in `packages/contracts`). These drift silently.

Changes needed:

1. Add `scripts/check-schema-drift.ts` — a script that:
   - Reads `convex/schema.ts` and `packages/contracts/src/entities.ts`.
   - For each entity, verifies the field names match between the Convex schema definition and the contracts type.
   - Reports mismatches as errors and exits with code 1.
2. Call this script from `scripts/validate.sh` as a fourth check (after lint).
3. The script should be zero-dependency (no new packages) and run with `pnpm tsx`.

Acceptance criteria:
- `./scripts/validate.sh` runs the drift check as part of its four-step suite.
- If a field is added to `schema.ts` but not to `contracts`, the check reports it.
- `pnpm typecheck` passes.

---

## 3. What Must NOT Be Done in Prompt 13

- Do not add real-time event streaming or live run monitoring.
- Do not add analytics dashboards or aggregate metrics.
- Do not change event log immutability rules.
- Do not redesign replay, diff, or the SDK recording interface.
- Do not add billing or usage metering.
- Do not add new background processing services beyond what exists.
- Do not add the `by_status` global index to the runs table unless the 2D schema drift check reveals it is needed.

---

## 4. Acceptance Criteria for Prompt 13

1. SDK auto-externalization: payloads >10 KB are uploaded before `/api/events`; 413 is never surfaced to callers sending large payloads.
2. Artifact download error UX: 404/502 shows an inline error message; successful download triggers browser file download.
3. Run breadcrumb: visible and linked on run detail page.
4. Schema drift check: `./scripts/validate.sh` runs the check; reports field mismatches correctly.
5. `pnpm typecheck` passes with zero errors.
6. `./scripts/validate.sh` passes all checks.
7. All prior tests still pass (>= 451 total, no regressions).
8. `docs/build_log.md`, `docs/working_memory.md`, `docs/next_steps.md` updated.

---

## 5. Known Technical Debt After Prompt 12

1. **SDK does not auto-externalize large payloads** — API returns 413; caller must handle. Fix in Prompt 13 (2A).
2. **Artifact download UX on error** — browser silently downloads JSON error body. Fix in Prompt 13 (2B).
3. **No breadcrumb on run detail page** — no back-navigation to project or agent. Fix in Prompt 13 (2C).
4. **No schema drift check** — contracts and Convex schema can drift silently. Fix in Prompt 13 (2D).
5. **Event list is not virtualized** — 10,000+ events loaded via "Load more" may cause sluggish scroll. Acceptable for v1; virtual scroll (react-window) is v1.1.
6. **`agentId + status + date` filter still applies status in-memory** — acceptable because agent-scoped run counts are small. Would require a `by_agent_status_started` index to fix cleanly.
7. **GC processes one page per daily run** — large orphan backlogs clear over multiple days. Acceptable at v1 scale.
8. **Stale run expiry uses a full-table scan** — no global `by_status` index. Acceptable at v1 run volumes.
