# Release Readiness — v1

**Date:** 2026-04-11
**Status:** v1 Feature Complete — Prompt 15 (run detail breadcrumb, schema drift check, drift CI job)

---

## What is ready for v1

### Data layer (Convex)

- **Canonical event log** — immutable, append-only, Convex-backed. No `updateEvent`
  or `deleteEvent` mutations exist. The event sequence is the ground truth.
- **Idempotent event ingestion** — `sdkCreateEvents` deduplicates by
  `(runId, sequenceNumber)`. Safe to retry on network failure without creating
  duplicate events. Documented in ADR-0007.
- **Org tenancy enforcement** — every Convex query and mutation filters by `orgId`.
  No cross-org data leakage is possible via the query layer.
- **Full entity hierarchy** — `organizations`, `projects`, `agents`, `agent_versions`,
  `runs`, `events`, `artifacts`, `comments`, `user_memberships` all implemented with
  correct indexes.

### Ingestion pipeline (SDK + API)

- **SDK recording pipeline** — `FlightRecorder` → `RunRecorder` → `recordEvent` →
  `complete` / `fail`. Fully implemented with real HTTP transport (no stubs).
- **Payload size enforcement** — events with JSON payload > 10,240 bytes are rejected
  at `POST /api/events` with HTTP 413. Documented in ADR-0006.
- **Artifact externalization path** — `POST /api/artifacts/upload` externalizes large
  payloads to blob storage and records a pointer in Convex. API-key authenticated.
- **Production blob storage adapter** — `VercelBlobAdapter` using native `fetch` (no
  `@vercel/blob` package dependency). Activated when `BLOB_STORE_TOKEN` env var is set.

### Auth

- **Clerk integration** — sign-in, sign-up, org creation, and org membership all
  handled by Clerk. Webhook bootstrap creates Convex org records on
  `organization.created` events.
- **API key authentication** — SDK-facing routes (`/api/runs`, `/api/events`,
  `/api/artifacts/upload`) require `x-api-key` header. Keys are stored hashed in
  Convex `api_keys` table.

### Explainability layer (web)

- **Replay projection** — `buildReplayProjection(run, events)` produces a
  deterministic, on-demand projection with per-frame actor, status, elapsed time,
  payload preview, and nesting depth. Pure function, no side effects.
- **Failure summary** — `buildFailureSummary(run, events)` identifies failure points
  from the event log. Deterministic heuristic — never AI inference.
- **Run diff** — `buildRunDiff(leftRunId, rightRunId, leftEvents, rightEvents)` compares
  two runs by sequence position. Surfaces added, removed, and changed events.
- **Projection integrity verification** — `verifyProjectionIntegrity(run, events)`
  checks sequence contiguity, detects duplicates, validates the projection does not
  throw, and produces a human-readable summary. Used by the `rebuild-projection.ts`
  script.
- **On-demand computation** — no materialized projections. The event log is the only
  source of truth. Projections are always rebuilt from canonical events. See ADR-0005.

### Operator tooling

- **Health endpoint** — `GET /api/health` returns the storage adapter name and
  configuration status. Use this to verify the production adapter is active.
- **Projection rebuild script** — `scripts/rebuild-projection.ts` verifies a run's
  event sequence integrity from the command line.

### Test coverage

- **513+ tests passing** across `tests/` and `packages/sdk` workspaces (18 test files, 5 skipped).
- Unit tests cover replay, diff (including truncation), failure summary, storage, transport, artifact GC, org bootstrap, and schema drift parsing.
- All unit tests use `MockTransport` or in-memory stubs — no network calls, instant.
- Real-Convex integration tests (`tests/integration/api.test.ts`) run in CI when secrets are configured. Skipped gracefully otherwise. Merging to `main` requires secrets to be present.

### Filter performance

- **Run list filters use compound indexes** — `startedAfter` (date range) filter uses index range queries rather than in-memory filtering. New compound index `by_org_status_started = ["orgId", "status", "startedAt"]` handles combined status+date filter efficiently (ADR-0015).

### GC and operator visibility

- **Artifact GC** — daily cron processes artifacts oldest-first via `by_created_at` index, bounded at 100 per run. Blob delete failures preserve the Convex record and are retried on the next daily run. GC logs classify errors as `blobErrors`, `checkErrors`, `recordErrors` for operator diagnostics. See the Operations Runbook.

### UI consistency

- **Tag editing** — post-save tag state is consistent with the saved value without requiring a server re-render. The component tracks `savedTags` state updated on successful save.

---

## What is explicitly deferred to v1.1

- **SDK auto-externalization** — the SDK does not yet detect payloads > 10 KB before
  calling `/api/events`. If a payload exceeds the limit, the API returns HTTP 413 and
  the SDK surfaces that error to the caller. Auto-externalization (upload to
  `/api/artifacts/upload` then replace payload with pointer) is v1.1 scope.
- **Background projection verification** — no scheduled job verifies run sequence
  integrity in production. Integrity checks are on-demand only (via the CLI script).
- **Live run monitoring** — no real-time event streaming. The run detail page does not
  auto-refresh while a run is in progress.
- **RBAC beyond basic membership** — roles (`admin`, `member`, `viewer`) are stored
  on `user_memberships` and enforced on write mutations (admin required for tag edits,
  API key creation). Viewer-vs-member distinction on read paths is v1.1 scope.
- **Vercel Blob SDK package** — the `VercelBlobAdapter` uses native `fetch` directly
  to avoid adding `@vercel/blob` as a dependency. If the Vercel Blob REST API changes,
  update `apps/web/src/lib/storage/vercel.ts`.
- **Artifact download error UX** — the download link is a plain `<a download>` anchor.
  If the route returns 404/502, the browser silently downloads a JSON error body.
  Programmatic fetch with inline error display is v1.1 scope.
- **Event virtualization** — the Timeline and EventInspector load events in pages of
  200 via "Load more", but do not virtualize the DOM list. Runs with 10,000+ events
  loaded incrementally may have sluggish scroll performance.

**Resolved since initial release candidate:**
- Artifact GC implemented and running (ADR-0011, ADR-0014)
- Run list filtering by status, date range, and agent — all implemented with compound indexes (ADR-0015)
- Tags display and inline editing in RunHeader
- Comments with resolve/show-resolved UI
- Integration tests run in CI with explicit release gate on main
- Artifact download from UI — `GET /api/artifacts/[id]/download` with Clerk auth and org verification (ADR-0016)
- Stale run auto-expiry — daily cron transitions stuck `running` runs to `timed_out` after 24 h (ADR-0017)
- Keyboard navigation in Timeline and EventInspector (ADR-0018)
- Shareable event URL — `?event=<sequenceNumber>` deep link with copy-link button (ADR-0018)
- Project creation from UI — `CreateProjectModal`, projects page, auto-slug generation, admin-gated via Convex mutation (Prompt 13)
- Agent creation from UI — `CreateAgentModal`, project detail page with agents table (Prompt 13)
- API key management — load existing keys on mount, name input before generate, two-phase revoke (`DELETE /api/api-keys/[id]`) (Prompt 13)
- SDK setup snippet — `SdkSetupSnippet` component on settings page with install command and copy-ready code block (Prompt 13)
- Org-wide agents page — `listAgentsByOrg` query on `by_org` index, agents page with project links (Prompt 13)
- Dashboard onboarding guide — four-step Getting Started flow replaces hardcoded SDK snippet (Prompt 13)
- Agent version creation from UI — `createAgentVersion` mutation (admin-gated, unique per agent), version history on agent detail page, CreateVersionModal (ADR-0019)
- Agent version attribution on runs — Version column in run list, version badge in run detail header
- SDK snippets include `agentVersionId` across agent detail page, project detail, and settings
- Run detail breadcrumb — `Organization → Project → Agent → Run <id>` breadcrumb with links, non-fatal parent-context fetch (Prompt 15)
- Schema drift check — `scripts/check-schema-drift.ts` compares convex/schema.ts against contracts entities per table; called from validate.sh and CI (Prompt 15)

---

## Hard decisions

**On-demand projections** — projections are recomputed at request time rather than
materialized. This is correct for v1 scale (< 1,000 events per run). The computation
is dominated by Convex fetch latency, not projection CPU time. Revisit if run sizes
reach 50,000+ events or if replay endpoint p99 exceeds 2 seconds.

**Blob storage via native fetch** — `VercelBlobAdapter` calls the Vercel Blob REST API
directly rather than using the `@vercel/blob` npm package. This avoids adding a
dependency that might break in edge runtimes or constrained environments. The trade-off
is that if Vercel changes its Blob API, we update one file (`vercel.ts`).

**No materialized projections** — keeping the event log as the sole source of truth is
correct and testable. Materialized projections add a synchronization problem: what
happens if the materialized view is stale? With on-demand projection, there is no
stale-view problem.

**`(runId, sequenceNumber)` as the idempotency key** — natural key matching how the
SDK assigns sequence numbers. O(1) lookup via the existing `by_run` Convex index.
Documented in ADR-0007.

**env var naming** — `BLOB_STORE_TOKEN` (not `BLOB_READ_WRITE_TOKEN` or
`BLOB_STORAGE_PROVIDER`) is the signal for activating the Vercel Blob adapter. The
adapter is activated by the presence of the token, not by a separate provider flag.
This is a simpler contract: if the token is set, use Vercel Blob; otherwise use the
stub adapter. Changing this naming later would be a breaking env var change requiring
coordination with all deployments.

---

## Known gaps and risks

| Gap | Severity | Mitigation |
|-----|----------|------------|
| SDK does not auto-externalize large payloads | Medium | API returns HTTP 413; caller must handle and retry with smaller payload or use `/api/artifacts/upload` directly |
| `BLOB_STORE_TOKEN` expiry has no fallback | High | Monitor token expiry; rotate before expiry; health endpoint will show `configured: false` if token is absent |
| No run integrity verification in production | Low | Sequence gaps could appear if a Convex mutation fails mid-batch; use `rebuild-projection.ts` to check individual runs manually |
| Large runs (> 10,000 events) may time out | Low | Replay endpoint fetches all events; no pagination timeout is enforced. Mitigate with per-run event count limits at the SDK level. |
| `comments` mutations are minimal | Low | `resolveComment` is wired into the UI; `listComments` with `targetType` filter works. Full threading not in v1. |
| Artifact download error UX | Low | 404/502 from download route causes browser to download JSON error body. Inline error display deferred to v1.1. |
| Stale run expiry uses full-table scan | Low | No global `by_status` index; full `.filter()` scan per daily cron. Acceptable at v1 run volumes. |
