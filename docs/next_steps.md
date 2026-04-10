# Next Steps — v1 Complete / v1.1 Candidates

**Document type:** State summary and v1.1 candidate list.
**Current state:** Prompt 13 complete. v1 is feature-complete.

---

## v1 is complete

Prompts 1–13 have closed all items from the original v1 specification. The system is
feature-complete as defined:

- Canonical, immutable event log (Convex) with org tenancy enforcement
- SDK recording pipeline (`FlightRecorder` / `RunRecorder` / `Recorder`) with HttpTransport, retry, batching, per-request timeout
- Payload externalization to blob storage (>10 KB threshold, ArtifactPointer)
- Replay projection, failure summary, and run diff — on-demand, no materialized state
- Web UI: run list (with filters), run detail (timeline, event inspector, diff, replay, comments, artifacts, tags)
- Keyboard navigation and event deep links in the run detail view
- Artifact download (`GET /api/artifacts/[id]/download`) with Clerk auth and org verification
- Artifact GC (daily cron, bounded batch, `by_created_at` index)
- Stale run expiry (daily cron at 03:00 UTC, `timed_out` status)
- API key management: create (named, hashed), revoke (two-phase confirm), list
- Project and agent creation from UI (admin-gated via Convex RBAC)
- Org-wide agents page and agent detail page with SDK setup snippet
- Dashboard onboarding guide (four-step Getting Started flow)
- Clerk webhook bootstrap for org and membership records
- Health endpoint (`GET /api/health`) for operator monitoring
- CI gate: integration tests on feature branches (graceful skip), hard fail on main when secrets absent
- 482 tests passing, 5 skipped (16 test files)

---

## v1.1 Candidates

The following items were explicitly deferred from v1. They are candidates for the next
session. They are listed in rough priority order.

### HIGH

**1. SDK auto-externalization**
The SDK does not detect payloads >10 KB before calling `POST /api/events`. If a payload
exceeds the limit, the API returns HTTP 413 and the error surfaces to the caller. The
SDK should scan each event payload's byte size before sending, automatically upload
oversized payloads to `POST /api/artifacts/upload`, and replace the payload field with
an `ExternalizedPayload` pointer — exactly as `HttpTransport._uploadArtifact` already
does. This is a production footgun; callers sending large LLM response payloads will hit
413 without knowing why.

Files to change: `packages/sdk/src/transport.ts`, `tests/unit/transport-externalization.test.ts`.

**2. Artifact download error UX**
The download link in `ArtifactList` is a plain `<a download>` anchor. When the download
route returns 404 (artifact not found or wrong org) or 502 (blob storage unavailable),
the browser silently downloads a JSON error body. Convert `ArtifactList` to a
`'use client'` component, replace the anchor with a button that calls `fetch` on click,
and show an inline error message on non-2xx responses.

Files to change: `apps/web/src/components/runs/ArtifactList.tsx`.

### MEDIUM

**3. Run detail breadcrumb navigation**
Engineers navigating to a run detail page from search results or a shared URL have no
way to navigate back to the project or agent without using the browser Back button. Add
a breadcrumb row above `RunHeader`: `Organization → Project → Agent → Run <id>`, each
segment linked to its respective page.

Files to change: `apps/web/app/(app)/runs/[runId]/page.tsx`.

**4. Convex schema drift check**
The Convex schema in `convex/schema.ts` and the contracts in `packages/contracts/src/entities.ts`
can diverge silently — TypeScript catches type mismatches within a package but not
cross-package field name drift. Add `scripts/check-schema-drift.ts` (zero-dependency,
runs with `pnpm tsx`) that reads both files and reports field name mismatches. Add it
to `scripts/validate.sh` as a fourth check step.

### LOW

**5. Event list virtualization**
The Timeline and EventInspector load events in pages of 200 via "Load more" but do not
virtualize the DOM list. Runs with 10,000+ events loaded incrementally may have sluggish
scroll performance. Consider `react-window` for the event list rows.

**6. Background projection verification**
No scheduled job verifies run sequence integrity in production. Integrity checks are
on-demand only via `scripts/rebuild-projection.ts`. A daily Convex cron that samples
recently-completed runs and flags sequence gaps would improve operational confidence.

**7. Live run monitoring**
The run detail page does not auto-refresh while a run is in progress. Polling (via
`setInterval`) or Convex real-time subscriptions could provide a live view. Not required
for the "make failures explainable" use case — runs are typically inspected after the
fact — but useful for long-running agents.

**8. RBAC viewer-vs-member on read paths**
Roles (`admin`, `member`, `viewer`) are stored on `user_memberships` and enforced on
write mutations. The read path distinction (viewers cannot write, members can) is not
yet enforced on read queries. Low risk at v1 scale (all org members can read all data);
needed before external-facing use cases.

---

## What must NOT be added in v1.1

- Real-time collaboration or live streaming of events to multiple viewers
- Analytics dashboards, aggregate metrics, or usage statistics
- Agent marketplace or agent registry
- Policy engine, compliance features, or audit log export
- Multi-region or distributed ingestion infrastructure
- Billing, usage metering, or subscription management
- Webhooks or external integrations (Slack, PagerDuty, etc.)
- Mobile application
