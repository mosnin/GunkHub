# Working Memory — Agent Flight Recorder

**Read this file first in every new Claude session before touching any code.**

Last updated: 2026-04-11 (Prompt 15 — Run detail breadcrumb + schema drift check)

---

## 1. Current State

Prompts 1–13 complete. The following summarizes the full state after Prompt 13.

**Repo skeleton is in place.** pnpm workspace with Turborepo, TypeScript strict mode, ESLint, Prettier, `tsconfig.base.json`. All packages typecheck cleanly. `./scripts/validate.sh` runs typecheck → build → lint and reports pass/fail.

**Convex schema is fully defined** (`convex/schema.ts`). All tables defined: `organizations`, `projects`, `agents`, `agent_versions`, `runs`, `events`, `artifacts`, `comments`, `user_memberships`, `api_keys`. Prompt 10: `artifacts` gains `by_created_at`. Prompt 11: `runs` gains `by_org_status_started = ["orgId", "status", "startedAt"]` for efficient combined status+date filtering (ADR-0015).

**Convex queries and mutations are implemented** (not stubbed) for:
- `convex/runs.ts` — `listRuns`, `getRun`, `createRun`, `updateRunStatus`, `updateRunTags`
- `convex/events.ts` — `listEvents`, `getEvent`, `createEvent`
- `convex/artifacts.ts` — `listArtifacts`, `createArtifact`, `getArtifact` (Prompt 12)
- `convex/organizations.ts` — `upsertOrganization`, `upsertMembership`, `getOrg`, `listOrgs`
- `convex/comments.ts` — `listComments`, `createComment`, `resolveComment`
- `convex/agents.ts` — `listDistinctAgents`, `listAgentsByOrg` (NEW Prompt 13, `by_org` index)
- `convex/agent_versions.ts` — `createAgentVersion` (admin-gated, unique per agent), `listAgentVersions`, `getAgentVersion` (NEW Prompt 14)
- `convex/artifact_gc.ts` — `getOrphanCandidates` (indexed range + paginate), `isArtifactReferenced`, `deleteArtifactRecord`, `cleanOrphanedArtifacts`
- `convex/stale_runs.ts` (NEW Prompt 12) — `listStaleRuns`, `markRunTimedOut`, `expireStaleRuns`
- Auth helpers: `getAuthContext()`, `requireOrgMembership()` with `minimumRole` in `convex/auth.ts`

**packages/contracts is fully defined** (v0.6.1). All shared types:
- `entities.ts` — Organization, Project, Agent, AgentVersion (now with `configSnapshot?: Record<string, unknown>`, v0.6.1), Run, Event, Artifact, Comment
- `events.ts` — EventType union, all payload shapes, EventPayload discriminated union (includes `ExternalizedPayload`)
- `status.ts` — RunStatus, RunStatusValues, isTerminalStatus()
- `api.ts` — All API request/response types
- `replay.ts` — ReplayProjection, ReplayFrame, FailureSummary, FailurePoint, ReplayActor, FrameStatus
- `diff.ts` — RunDiff, EventDiff, DiffSummary, FieldChange
- `artifacts.ts` — `PAYLOAD_EXTERNALIZATION_THRESHOLD` (10240), `ArtifactPointer`, `ArtifactUploadRequest`, `ArtifactUploadResponse`

Key new exports (Prompt 6):
- `ExternalizedPayload` — pointer type for externalized event payloads, member of `EventPayload` union
- `PAYLOAD_EXTERNALIZATION_THRESHOLD` — imported by SDK to determine when to externalize

Key new exports (Prompt 10):
- `RunDiff.truncated?: boolean` — set when either run exceeded `MAX_EVENTS_PER_DIFF`
- `MAX_EVENTS_PER_DIFF = 10_000` — exported from `apps/web/src/lib/replay/diff.ts`

**packages/sdk is fully implemented.** The `Recorder` class, `Events` builders, `buildEvent` helper, `HttpTransport` (complete with auto-externalization, retry, timeout, per-sendEvents upload cache), `Transport` interface, all types. Functional end-to-end with real `HttpTransport` or injected `MockTransport`.

**apps/web production storage layer is implemented:**
- `apps/web/src/lib/storage/vercel.ts` — `VercelBlobAdapter` production implementation via native fetch, activated when `BLOB_STORE_TOKEN` env var is present
- `apps/web/src/lib/storage/index.ts` — `getStorageAdapter()` factory
- `apps/web/src/lib/replay/verify.ts` — `verifyProjectionIntegrity(run, events): ProjectionVerifyResult`
- `apps/web/app/api/health/route.ts` — `GET /api/health` operator endpoint
- `apps/web/src/lib/health.ts` — shared health data function
- `apps/web/src/components/runs/SystemHealthPanel.tsx` — health UI component
- `scripts/rebuild-projection.ts` — CLI script for event integrity verification

**apps/web components and service layer — all implemented (not stubs):**
- UI primitives: Badge, Button, Card, CodeBlock, EmptyState, ErrorState, LoadingState, Tabs
- Layout: AppShell, PageHeader, Sidebar
- Run components: RunList, RunHeader, Timeline (with load-more pagination, keyboard navigation), EventInspector (with load-more pagination, keyboard navigation, event deep link, copy-link button), DiffViewer (with truncation banner), ReplayViewer (with truncation banner), ArtifactList (with download link per row), CommentThread (resolve, show/hide resolved, compose)
- Service layer: `lib/services/runs.ts`, `lib/services/events.ts`, `lib/services/comments.ts`, `lib/services/artifacts.ts`, `lib/services/replay.ts`, `lib/services/diff.ts`, `lib/services/agents.ts`, `lib/services/projects.ts` (NEW Prompt 13), `lib/services/agent_versions.ts` (NEW Prompt 14)
- Server actions: `lib/actions/comments.ts` (createComment, resolveComment), `lib/actions/runs.ts` (updateRunTags), `lib/actions/projects.ts` (createProjectAction, NEW Prompt 13), `lib/actions/agents.ts` (createAgentAction, NEW Prompt 13), `lib/actions/agent_versions.ts` (createAgentVersionAction, NEW Prompt 14)
- API routes: `/api/runs`, `/api/runs/[id]`, `/api/runs/[id]/events`, `/api/runs/[id]/replay`, `/api/runs/[id]/status`, `/api/events`, `/api/artifacts/upload`, `/api/artifacts/[id]/download` (Prompt 12), `/api/api-keys/[id]` (DELETE revoke, NEW Prompt 13), `/api/health`, `/api/webhooks/clerk`
- UI components (Prompt 13): `CreateProjectModal`, `CreateAgentModal`, `ProjectsList`, `ProjectDetail`, `ApiKeysSection` (rewritten), `SdkSetupSnippet`
- UI components (Prompt 14): `VersionHistory`, `CreateVersionModal`, `VersionSection`
- Pages (Prompt 13): projects list, project detail with agents table, org-wide agents list, agent detail with SDK snippet, dashboard onboarding guide

**Tests (as of Prompt 13):**
- `tests/unit/sdk.test.ts` — Recorder tests with MockTransport
- `tests/unit/contracts.test.ts` — Type shape and EventType coverage tests
- `tests/unit/replay.test.ts` — buildReplayProjection algorithm tests
- `tests/unit/failure.test.ts` — buildFailureSummary algorithm tests
- `tests/unit/diff.test.ts` — buildRunDiff algorithm tests (includes truncation tests from Prompt 10)
- `tests/unit/storage.test.ts` — BlobStorageAdapter, sha256Hex, PAYLOAD_EXTERNALIZATION_THRESHOLD
- `tests/unit/projection-verify.test.ts` — verifyProjectionIntegrity
- `tests/unit/flight-recorder.test.ts` — FlightRecorder and RunRecorder HTTP transport tests
- `tests/unit/transport-externalization.test.ts` — HttpTransport payload externalization tests
- `tests/unit/artifact-dedup.test.ts` — Artifact deduplication tests
- `tests/unit/org_bootstrap.test.ts` (Prompt 10) — 15 tests for upsertOrganization, upsertMembership, clerkRoleToInternal
- `tests/unit/artifact_gc.test.ts` (Prompt 10) — 10 tests for GC orphan detection, bounded batch, and error categorization
- `tests/unit/run_filter.test.ts` (Prompt 11) — 14 tests for index selection and filter scenarios
- `tests/unit/stale_runs.test.ts` (Prompt 12) — 8 tests for stale run timeout config, cutoff arithmetic, and safety invariants
- `tests/unit/projects_agents.test.ts` (NEW Prompt 13) — 31 tests for slug generation, name validation, two-phase revoke state machine, and loadKeys fetch logic
- `tests/unit/agent_versions.test.ts` (NEW Prompt 14) — 19 tests for version string validation, mapAgentVersion correctness, and action validation logic
- `tests/unit/schema_drift.test.ts` (NEW Prompt 15) — 12 tests for `parseSchemaTableFields` and `parseContractsInterfaceProperties` parsing and exclusion logic
- `tests/integration/api.test.ts` — API response shape + org bootstrap integration tests
- **Total: 513 passing, 5 skipped (18 test files, all green)**

**Architecture decisions recorded:**
- ADR-0001 through ADR-0004: repo shape, event log immutability, tenancy, contracts
- ADR-0005: On-demand replay and diff projection strategy (Prompt 3)
- ADR-0006: Artifact externalization policy — 10 KB threshold, blob storage, ArtifactPointer (Prompt 4)
- ADR-0007: Ingestion idempotency — (runId, sequenceNumber) dedup, returns existing ID (Prompt 4)
- ADR-0008: VercelBlobAdapter design — native fetch, no @vercel/blob SDK dependency (Prompt 5)
- ADR-0009: SDK-side payload externalization and `ExternalizedPayload` pointer representation (Prompt 6)
- ADR-0010: Artifact deduplication key strategy — `(runId, checksum)` compound index (Prompt 7)
- ADR-0011: Artifact GC — orphan definition, safety rationale, BLOB_STORE_TOKEN requirement (Prompt 8)
- ADR-0012: Org bootstrap — Clerk webhook → upsertOrganization + upsertMembership pipeline (Prompt 10)
- ADR-0013: Diff boundedness — MAX_EVENTS_PER_DIFF cap in service layer, truncated flag, UI disclosure (Prompt 10)
- ADR-0014: Artifact GC scaling — by_created_at index, paginated bounded batch (Prompt 10)
- ADR-0015: Run filter index — `by_org_status_started` compound index for combined status+date queries (Prompt 11)
- ADR-0016: Artifact download — fetch-and-proxy route, two-layer auth (Clerk + Convex org check) (Prompt 12)
- ADR-0017: Stale run expiry — daily cron at 03:00 UTC, internalAction pattern (Prompt 12)
- ADR-0018: Event deep link — `?event=<sequenceNumber>` URL contract, history.replaceState (Prompt 12)
- ADR-0019: Agent version identity — version string uniqueness per agent, `v.any()` config snapshot, no active-version pointer on agent (Prompt 14)

---

## 2. Key Decisions Made

1. **pnpm + Turborepo monorepo.** Single deployment unit. Turborepo caches build artifacts. All packages share one `node_modules`. (See ADR-0001)

2. **Event log is append-only and immutable.** No `updateEvent` or `deleteEvent`. The event sequence is the ground truth. Replay and diff are computed projections. (See ADR-0002)

3. **Organization is the tenancy boundary.** Maps to Clerk org ID. Every Convex query must filter by `orgId`. (See ADR-0003)

4. **packages/contracts is the single source of type truth.** Zero runtime dependencies. All packages import shared types from here. (See ADR-0004)

5. **Convex over traditional ORM.** Real-time subscriptions future, built-in Clerk auth, type-safe queries, no connection pooling. Trade-off: hosted vendor, no SQL JOINs.

6. **Next.js API routes as the ingestion surface.** SDK calls Next.js, Next.js calls Convex mutations. Browser UI uses Convex React hooks directly. This keeps ingest auth and SDK routing logic in one layer.

7. **Payload externalization threshold: 10 KB.** Payloads over 10 KB go to blob storage. Pointer stored in event record. Keeps Convex documents small. Enforced by SDK before shipping.

8. **BlobStorageAdapter as an interface.** Blob provider is swappable. `convex/helpers/storage.ts` defines the interface. No concrete implementation in v1 — stub comment points to Prompt 2/3.

9. **Sequence numbers are SDK-assigned.** The SDK increments a local counter. Backend validates contiguity. This avoids a round-trip to get the next sequence number before each event.

10. **`run.started` event is always seq=1; terminal event is always last.** Enforced by convention in SDK; validated in `createEvent` mutation logic (run must be in "running" state).

11. **Roles: admin / member / viewer.** Defined on `UserMembership`. Not yet enforced in mutations beyond basic membership check — full RBAC is Prompt 3+ scope.

12. **Modular monolith architecture.** One Vercel deployment. Seams exist for future extraction (ingest layer, blob storage, projections). (See ADR-0001)

13. **TypeScript strict mode throughout.** `strict: true` in `tsconfig.base.json`. ESLint enforces `import type` for type-only imports, no cross-package relative imports.

14. **No React UI library.** Build from Tailwind primitives. No shadcn, MUI, or Radix. Keeps dependency surface clean, enforces the "calm technical" design language.

15. **`AgentVersion` is immutable once created.** No update mutation. Code changes create a new version. This preserves historical accuracy — a Run always knows exactly what ran.

---

## 3. Open Questions (Future Prompts Must Resolve)

**HIGH PRIORITY (Prompt 2):**

- [ ] **How does the SDK authenticate to the Next.js API routes?** Current transport stubs send an `apiKey`. There is no `api_keys` table in the Convex schema yet. Do we use Clerk org tokens or a separate API key system? Decision needed before ingestion pipeline works end-to-end.

- [ ] **How does Next.js call Convex mutations server-side?** The service layer stubs in `apps/web/src/lib/services/` need to call Convex. This requires `ConvexHttpClient` (server-side) vs `useConvexMutation` (client-side). Need to decide: are API route handlers server-side Convex calls, or do they use a service account token?

- [ ] **What is the env var shape?** `apps/web/src/lib/env.ts` validates `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_CONVEX_URL`. But `CLERK_SECRET_KEY`, `CONVEX_DEPLOYMENT`, `BLOB_READ_WRITE_TOKEN` (Vercel Blob), and any API key secret are not yet documented in `.env.example`. Need a complete `.env.example`.

- [ ] **No Next.js pages exist.** The `apps/web/src/app/` directory is missing. All routes need to be created. At minimum: layout, sign-in, dashboard, project list, run list, run detail.

**RESOLVED IN PROMPT 3:**

- [x] **Replay computation belongs where?** Decided: web app service layer, computed on-demand at request time. See ADR-0005. Implemented in `apps/web/src/lib/replay/`.

- [x] **RunDiff alignment strategy.** Decided: position-based alignment by sequenceNumber. Events at the same index position are compared. Extra events in the longer run are surfaced as added/removed. Documented in ADR-0005.

**MEDIUM PRIORITY (Prompt 4):**

- [ ] **Blob storage implementation.** The `BlobStorageAdapter` stub needs a real implementation. Vercel Blob is the likely first choice — but `BLOB_READ_WRITE_TOKEN` must be in `.env.example` before this is wired up.

- [ ] **Comments mutations (`createComment`, `resolveComment`) are missing.** `convex/comments.ts` needs to be implemented. Currently the file exists but no mutations are implemented for comments.

**LOWER PRIORITY (Prompt 4+):**

- [ ] **`convex/organizations.ts` and `convex/projects.ts` are not fully implemented.** `createOrg`, `listProjects`, `createProject` stubs need implementation.

- [ ] **SDK `HttpTransport` is fully stubbed.** All three methods throw `not yet implemented`. This needs to be implemented in Prompt 2 alongside the API routes.

- [ ] **Integration tests are all stubs.** `tests/integration/api.test.ts` needs a test runner against a dev Convex deployment.

- [ ] **No `.env.example` file.** Must be created before Prompt 2.

---

## 4. Known Stubs

| File | What is Stubbed | What It Needs |
|------|----------------|---------------|
| `apps/web/src/lib/services/runs.ts` | Returns empty/fake data | Real Convex calls via `ConvexHttpClient` or Convex React hooks |
| `apps/web/src/lib/services/events.ts` | Returns empty array | Same |
| `apps/web/src/lib/services/comments.ts` | Returns empty array | Same |
| `apps/web/src/lib/storage/stub.ts` — `StubBlobStorageAdapter` | In-memory dev/test implementation (Prompt 4) | Vercel Blob production adapter (Prompt 5) |
| `convex/comments.ts` | File likely exists with no mutations | Need `createComment`, `resolveComment`, `listComments` |
| `convex/organizations.ts` | Partially implemented | Need `createOrg`, `getOrgByClerkId` |
| `convex/projects.ts` | Partially implemented | Need `listProjects`, `createProject` |
| `apps/web/src/app/` | Does not exist | All Next.js pages and layouts |
| `tests/integration/api.test.ts` | All tests are stubs | Real integration tests against dev Convex |

**Fully implemented in Prompt 3 (no longer stubs):**
- `apps/web/src/lib/replay/projection.ts` — `buildReplayProjection` complete
- `apps/web/src/lib/replay/failure.ts` — `buildFailureSummary` complete
- `apps/web/src/lib/replay/diff.ts` — `buildRunDiff` complete

**Fully implemented in Prompt 6 (no longer stubs):**
- `packages/sdk/src/transport.ts` — `HttpTransport` complete: auto-externalization of oversized payloads via `_uploadArtifact`, retry loop for events, per-request timeout via `AbortController`
- `apps/web/src/lib/health.ts` — shared health data function, no more server-side loopback HTTP call
- `tests/unit/transport-externalization.test.ts` — 26 new tests for SDK payload externalization

**Fully implemented in Prompt 7 (no longer stubs):**
- `convex/sdk_ingest.ts` — artifact dedup via `(runId, checksum)` idempotency; `sdkCreateArtifact` returns existing record on duplicate instead of inserting
- `convex/runs.ts` — `listRuns` with optional `startedAfter` parameter; new `updateRunTags` mutation
- `apps/web/app/(app)/runs/page.tsx` — status dropdown + date range filter bar (Last 24h / 7 days / 30 days)
- `apps/web/src/components/runs/EventInspector.tsx` — `_externalized` payload rendering via `ExternalizedPayloadView`
- `apps/web/src/components/runs/RunHeader.tsx` — tags chips (expandable) + collapsible metadata key-value panel
- `apps/web/src/components/runs/RunList.tsx` — tags chips column (max 3 + overflow count)

**Fully implemented in Prompt 8 (no longer stubs):**
- Convex daily GC cron for orphaned artifacts (`convex/crons.ts`, `convex/artifact_gc.ts`)
- RBAC `minimumRole` enforcement on `createApiKey`, `revokeApiKey`, `updateRunTags`, `createProject` (`convex/auth.ts`)
- Inline tag editing in `RunHeader` (add/remove chips, Enter/comma to commit, Save/Cancel, error feedback via server action)
- SDK per-`sendEvents` upload cache in `HttpTransport._uploadArtifact` — prevents redundant blob PUT on same payload within a single call
- Real Convex integration test suite in `tests/integration/api.test.ts` (skipped gracefully when `CONVEX_TEST_URL`/`TEST_API_KEY`/`TEST_AGENT_ID` not set)

**Fully implemented in Prompt 9 (no longer stubs):**
- `convex/organizations.ts` — `upsertOrganization` + `upsertMembership` mutations (idempotent, webhook-safe)
- `apps/web/app/api/webhooks/clerk/route.ts` — full membership bootstrap on `organizationMembership.created` and `organizationMembership.updated`
- `apps/web/src/lib/actions/comments.ts` — `createCommentAction`, `resolveCommentAction`
- `apps/web/src/components/runs/CommentThread.tsx` — full resolve/compose/show-resolved UI
- `buildReplayProjection` truncation at 10,000 events with `ReplayProjection.truncated`
- CI integration test job in `.github/workflows/ci.yml`
- Agent filter dropdown on runs list page with URL-reflected `?agentId=`

**Fully implemented in Prompt 10 (no longer stubs / scale gaps):**
- Event pagination in Timeline and EventInspector — "Load more" button fetches next page via `/api/runs/[id]/events` cursor
- Diff bounded at `MAX_EVENTS_PER_DIFF = 10_000` with `RunDiff.truncated` and DiffViewer warning banner
- `getOrphanCandidates` uses indexed range query (`by_created_at`) with paginated bounded batch instead of full scan
- `tests/unit/org_bootstrap.test.ts` — 15 tests proving org bootstrap correctness (ADR-0012)
- `tests/unit/artifact_gc.test.ts` — 7 tests proving GC correctness (ADR-0014)

**Fully implemented in Prompt 11 (operational quality pass):**
- `convex/runs.ts` — `listRuns` uses index range queries for `startedAfter`; compound index `by_org_status_started` handles status+date combined filter efficiently (ADR-0015)
- `convex/artifact_gc.ts` — error counters separated into `blobErrors`/`checkErrors`/`recordErrors`; per-artifact failure logs; bounded-batch log when more candidates remain
- `apps/web/src/components/runs/RunHeader.tsx` — `savedTags` state prevents post-save display revert
- `.github/workflows/ci.yml` — integration-test job needs `[test]`; explicit notice/warning on secret presence; hard fail on `main` when secrets absent
- `docs/release_readiness.md`, `docs/operations_runbook.md`, `docs/ops/ci_setup.md` updated

**Fully implemented in Prompt 15 (breadcrumb + schema drift):**
- `apps/web/src/components/runs/RunBreadcrumb.tsx` — `Organization → Project → Agent → Run <id>` breadcrumb with links, non-fatal parent-context fetch
- `apps/web/src/lib/services/agents.ts` — `getAgent()` service function added for server-side single-agent fetch
- `apps/web/app/(app)/runs/[runId]/page.tsx` — breadcrumb wired above RunHeader, non-fatal project + agent fetches
- `scripts/check-schema-drift.ts` — regex-based schema/contracts field comparison, exits 1 on drift; exports `parseSchemaTableFields` and `parseContractsInterfaceProperties` as named exports
- `scripts/validate.sh` — fourth check added (schema drift)
- `.github/workflows/ci.yml` — `schema-drift` job added
- `docs/ops/ci_setup.md` — schema-drift job documented
- `tests/unit/schema_drift.test.ts` — 12 unit tests for parsing functions (NEW)

**Fully implemented in Prompt 13 (first-success onboarding path):**
- `convex/agents.ts` — `listAgentsByOrg` query on `by_org` index for org-wide agent listing
- `apps/web/src/lib/services/projects.ts` — `listProjects`, `getProject`, `createProject` with slug generation
- `apps/web/src/lib/services/agents.ts` — `listAgents`, `listAgentsByOrg`, `createAgent`
- `apps/web/src/lib/actions/projects.ts` — `createProjectAction` server action with name validation
- `apps/web/src/lib/actions/agents.ts` — `createAgentAction` server action with name validation
- `apps/web/app/api/api-keys/[id]/route.ts` — `DELETE /api/api-keys/[id]` revoke route
- `apps/web/src/components/projects/CreateProjectModal.tsx` — project creation modal with auto-slug
- `apps/web/src/components/projects/CreateAgentModal.tsx` — agent creation modal within a project
- `apps/web/src/components/projects/ProjectsList.tsx` — org projects list component
- `apps/web/src/components/projects/ProjectDetail.tsx` — project detail with agents table
- `apps/web/src/components/settings/ApiKeysSection.tsx` — rewritten: loads keys on mount, name field, two-phase revoke
- `apps/web/src/components/settings/SdkSetupSnippet.tsx` — install command + code snippet for settings page
- `apps/web/app/(app)/projects/page.tsx` — real projects list page with CreateProjectModal
- `apps/web/app/(app)/projects/[projectId]/page.tsx` — project detail with agents table + CreateAgentModal
- `apps/web/app/(app)/agents/page.tsx` — org-wide agents list with project links
- `apps/web/app/(app)/agents/[agentId]/page.tsx` — agent detail with last run link and SDK snippet
- `apps/web/app/(app)/dashboard/page.tsx` — four-step Getting Started onboarding guide
- `apps/web/app/(app)/settings/page.tsx` — SdkSetupSnippet added
- `tests/unit/projects_agents.test.ts` — 31 tests for slug logic, name validation, revoke state machine, fetch mock

**Fully implemented in Prompt 12 (artifact download, keyboard nav, deep links, stale run expiry):**
- `convex/artifacts.ts` — `getArtifact` query (by ID, org-scoped via requireOrgMembership)
- `convex/stale_runs.ts` — `listStaleRuns`, `markRunTimedOut`, `expireStaleRuns` for daily auto-expiry of stuck runs
- `convex/crons.ts` — `expire-stale-runs` daily cron at 03:00 UTC
- `convex/helpers/pagination.ts` — `STALE_RUN_TIMEOUT_MS` and `STALE_RUN_BATCH_SIZE` constants
- `apps/web/app/api/artifacts/[id]/download/route.ts` — GET blob download with Clerk auth, Convex org check, fetch-and-proxy streaming
- `apps/web/src/components/runs/ArtifactList.tsx` — download icon link per artifact row
- `apps/web/src/components/runs/Timeline.tsx` — keyboard navigation (ArrowUp/Down/Enter, focusedIndex highlight)
- `apps/web/src/components/runs/EventInspector.tsx` — keyboard nav in event list, `initialEventSeq` prop for deep link, `history.replaceState` URL sync, "Copy link" button
- `apps/web/app/(app)/runs/[runId]/page.tsx` — parse `?event=<N>` searchParam, pass to EventInspector
- `docs/operations_runbook.md` — stale run section updated to auto-expiry
- ADRs 0016, 0017, 0018 added

**Test count (Prompt 12):** 451 passing, 5 skipped (15 test files, all green)

---

## 5. Dependency Map

```
packages/contracts
  └── no dependencies (pure TypeScript + Zod if added)

packages/sdk
  └── depends on: packages/contracts
      (imports: EventType, EventPayload, RunStatus, CreateRunRequest, etc.)

apps/web
  └── depends on: packages/contracts
      (imports: entity types, API shapes)
  └── does NOT depend on: packages/sdk
      (web app is the server, not the client)

convex/
  └── depends on: packages/contracts
      (would import: entity types for type alignment)
  └── does NOT depend on: packages/sdk, apps/web

tests/
  └── depends on: packages/sdk, packages/contracts
      (unit tests import Recorder, Events, contract types)
```

**Workspace package names:**
- `@agent-flight-recorder/contracts`
- `@agent-flight-recorder/sdk`
- `@agent-flight-recorder/web` (apps/web)

---

## 6. Where to Find Things

| What | Where |
|------|-------|
| Shared TypeScript types (entities, events, API) | `packages/contracts/src/` |
| Convex schema (all table definitions) | `convex/schema.ts` |
| Convex auth helpers | `convex/auth.ts` |
| Convex run queries/mutations | `convex/runs.ts` |
| Convex event queries/mutations | `convex/events.ts` |
| Convex artifact queries/mutations | `convex/artifacts.ts` |
| Blob storage interface | `convex/helpers/storage.ts` |
| Pagination constants | `convex/helpers/pagination.ts` |
| SDK public entry point | `packages/sdk/src/index.ts` |
| SDK Recorder class | `packages/sdk/src/recorder.ts` |
| SDK event builders | `packages/sdk/src/events.ts` |
| SDK Transport interface + HttpTransport (complete) | `packages/sdk/src/transport.ts` |
| SDK config types | `packages/sdk/src/types.ts` |
| Web service layer (run operations) | `apps/web/src/lib/services/runs.ts` |
| Web env validation | `apps/web/src/lib/env.ts` |
| Web UI primitives | `apps/web/src/components/ui/` |
| Web layout components | `apps/web/src/components/layout/` |
| Web run-specific components | `apps/web/src/components/runs/` |
| CI validation script | `scripts/validate.sh` |
| Dev seeding script | `scripts/seed.ts` |
| Unit tests | `tests/unit/` |
| Test fixtures | `tests/fixtures/` |
| Project constitution (read first) | `CLAUDE.md` |
| Architecture decisions | `docs/adrs/` |
| Product specification | `docs/product_spec.md` |
| Domain model | `docs/product_model.md` |
| Architecture guide | `docs/architecture.md` |
| Next steps for Prompt 2 | `docs/next_steps.md` |

---

## 7. Gotchas

**Convex ID types vs string IDs in contracts.**
The Convex schema uses typed IDs (`v.id("runs")`) which produce `Id<"runs">` types. The `packages/contracts` entities use `string` for all IDs. When calling Convex mutations from the web app, you must cast string IDs to `Id<"tableName">` using Convex's `Id` helper. Do not confuse these — they look like strings but Convex enforces the type at runtime.

**`run.status` is a string in Convex schema, not an enum.**
In `convex/schema.ts`, the status field is defined as `v.union(v.literal("pending"), ...)`. This means Convex validates it as a string union at runtime. The `RunStatus` type in `packages/contracts/src/status.ts` is the TypeScript type alias. They must stay in sync — if you add a status to one, add it to both.

**`v.any()` in the `events` table payload field.**
`events.payload` is `v.any()` in the schema because the payload is a discriminated union that Convex cannot express with its validator DSL. This means Convex does not type-check payloads at insert time. TypeScript type safety is enforced at the `createEvent` mutation's args level by consuming the `EventPayload` type from contracts. Do not remove the TypeScript types assuming Convex validates them — it does not.

**The `events` table has no `updateEvent` mutation, by design.**
If you find yourself wanting to update an event, you are doing something wrong. Review the ADR-0002. If you genuinely need an escape hatch, write a new ADR first.

**`apps/web` does not have an `app/` directory yet.**
Next.js 14 App Router requires an `app/` directory. It does not exist. Do not try to run the web app dev server until it is created in Prompt 2.

**SDK `HttpTransport` is fully implemented.**
`HttpTransport` now implements `createRun`, `sendEvents`, and `updateRunStatus` with real `fetch` calls, retry logic, and per-request timeout. `sendEvents` auto-externalizes payloads exceeding 10 KB by calling `POST /api/artifacts/upload` before `POST /api/events`. When using `MockTransport` in tests, none of this applies — `MockTransport` bypasses the HTTP layer entirely.

**No `.env.example` exists.**
Before any developer can run the project, `.env.example` must be created. Required vars at minimum: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT`. Create this early in Prompt 2.

**Convex `paginate()` returns `{ page, isDone, continueCursor }`.**
The `listRuns` and `listEvents` queries use Convex's built-in pagination. The response shape is not a simple array — it is a page object. The service layer must unwrap `page.page` to get the records array. This is already done correctly in `convex/runs.ts` and `convex/events.ts`, but watch for it when writing new queries.

**`parentEventId` enables a DAG, not just a list.**
Events can have a `parentEventId` referencing another event in the same run. This means the event sequence is technically a directed acyclic graph (tool.call → http.request → http.response, all parented to a common llm.request). The timeline UI and replay logic must handle both the linear (sequence) and tree (parent) views. Do not assume events are a flat list.

**Turborepo task ordering.**
`pnpm build` via Turborepo builds `packages/contracts` and `packages/sdk` before `apps/web`. If you add a new package dependency, update `turbo.json` (root level) to declare it in the `dependsOn` field. Otherwise Turborepo may build in the wrong order and produce stale type artifacts.

---

## 8. Prompt 16 Candidates (v1.1 deferred items)

The following items were explicitly deferred from v1 and are candidates for the next session. See `docs/next_steps.md` for full descriptions.

1. **SDK auto-externalization** (HIGH) — SDK does not yet detect payloads >10 KB before calling `/api/events`. API returns HTTP 413; caller must handle. Auto-externalize (upload to `/api/artifacts/upload`, replace payload with pointer) before shipping `POST /api/events`.
2. **Artifact download error UX** (HIGH) — download link is a plain `<a download>` anchor. On 404/502 the browser silently downloads a JSON error body. Convert to `'use client'` with programmatic fetch and inline error display.
3. **Version list pagination** (MEDIUM) — `listAgentVersions` uses `.collect()` with no pagination. Acceptable for v1; add cursor-based pagination if version counts grow.
4. **Event list virtualization** (LOW) — Timeline and EventInspector load events in pages of 200 but do not virtualize the DOM. Runs with 10,000+ events may have sluggish scroll. Consider react-window.
5. **Background projection verification** (LOW) — no scheduled job verifies run sequence integrity in production. Currently on-demand only via `rebuild-projection.ts`.
6. **Live run monitoring** (LOW) — no real-time event streaming. Run detail page does not auto-refresh while a run is in progress.
7. **RBAC viewer-vs-member on read paths** (LOW) — roles stored and enforced on writes; read path distinction is deferred.
8. **Version label enrichment at scale** (LOW) — run list fetches one `getAgentVersion` per distinct version ID on each page load. Consider caching or a batch query if pages regularly show many distinct versions.
