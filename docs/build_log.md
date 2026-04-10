# Build Log — Agent Flight Recorder

---

## Prompt 7 — Artifact Deduplication, Externalized Payload Rendering, Run List Filtering, Tags

**Date:** 2026-04-10

### What changed

- `convex/schema.ts` — added `.index("by_run_checksum", ["runId", "checksum"])` to the
  `artifacts` table; added `.index("by_org_started", ["orgId", "startedAt"])` to the
  `runs` table.
- `convex/sdk_ingest.ts` — `sdkCreateArtifact` now queries `by_run_checksum` before
  inserting. If an artifact with the same `(runId, checksum)` already exists, returns
  the existing record instead of inserting a duplicate. Makes the mutation idempotent for
  retry scenarios.
- `convex/runs.ts` — `listRuns` gains an optional `startedAfter: number` filter param;
  new `updateRunTags` mutation for admin/member tag editing.
- `packages/contracts/src/api.ts` — `ListRunsRequest` gains `startedAfter?: number`;
  contracts version bumped to 0.4.0.
- `apps/web/src/lib/services/runs.ts` — service layer wires `startedAfter` through to
  `listRuns`; new `updateRunTags` service function delegates to the Convex mutation.
- `apps/web/app/(app)/runs/page.tsx` — filter bar with status dropdown and date range
  buttons (Last 24h / Last 7 days / Last 30 days) with keyboard-accessible active state.
- `apps/web/src/components/runs/RunList.tsx` — tags chips column added (max 3 visible,
  "+N more" overflow label).
- `apps/web/src/components/runs/EventInspector.tsx` — detects `_externalized` payload
  type and renders `ExternalizedPayloadView` showing artifact metadata and a download
  link instead of raw JSON.
- `apps/web/src/components/runs/RunHeader.tsx` — `tags` and `metadata` props; renders
  tag chips (expandable) and a collapsible metadata key-value panel.
- `tests/unit/artifact-dedup.test.ts` — 11 new unit tests (3 groups): foundation checks
  for threshold constant and checksum consistency, SDK retry idempotency (same payload
  produces same upload body across two `sendEvents` calls), and boundary correctness
  (exact threshold not externalized, threshold+1 is).
- `docs/adrs/0010_artifact_dedup.md` — decision record for `(runId, checksum)` dedup key
  strategy.

### Why dedup fits the architecture

The `(runId, checksum)` dedup key follows the same pattern established in ADR-0007 for
event idempotency: `(runId, sequenceNumber)` is the natural key for events; `(runId,
checksum)` is the natural key for artifacts within a run. Both use a two-field compound
index in Convex for O(1) lookup before every insert. The dedup scope is bounded — it
applies within a single run, avoiding unintended merging of artifacts that share content
across different runs (e.g., a canonical system prompt appearing in multiple runs).

### Hard-to-reverse decisions

- **`by_run_checksum` index**: schema migration is required to add or remove compound
  indexes in Convex. Once deployed with production data, removing this index requires
  a coordinated schema re-deployment.
- **`listRuns` gaining `startedAfter`**: any clients that cache or test the exact
  `listRuns` response shape must handle the new optional parameter. The parameter is
  additive and backward-compatible, but the new `by_org_started` index changes query
  execution planning for `listRuns` calls that do use it.
- **`ExternalizedPayload` rendering path in `EventInspector`**: once the UI handles
  `_externalized` payloads as a first-class case, removing `ExternalizedPayload` from
  the union requires both a data migration (stored events) and a UI revert.

### Known residual risks

- **Redundant blob upload on retry**: the `by_run_checksum` dedup prevents duplicate
  Convex artifact records, but the SDK still issues a second `PUT` call to blob storage
  on retry (blob write is idempotent at the same checksum-derived key, only the API call
  is redundant). A future prompt can add a client-side upload-once cache in
  `HttpTransport._uploadArtifact`.
- **Orphaned blobs remain**: if a blob upload succeeds but the subsequent `POST /api/events`
  call fails permanently and is never retried, the artifact record exists with no
  referencing event. No GC job yet — planned for Prompt 8.
- **Tags are read-only in list**: `RunList` displays tags but does not provide editing.
  Tag editing requires `updateRunTags` wired into `RunHeader` via server action — planned
  for Prompt 8.

### Test count

- Before Prompt 7: 382 tests in `tests/` workspace + 260 SDK tests = 642 total.
- After Prompt 7: 393 tests in `tests/` workspace (+ 11 new artifact-dedup tests)
  + 260 SDK tests = **653 total, all passing**.

### Recommendation for Prompt 8

1. **Artifact GC job** (CRITICAL): Convex scheduled job (daily) to find artifact records
   older than 24 hours with no referencing event, delete the blob from Vercel Blob, and
   remove the orphaned Convex record.
2. **Tag editing UI**: wire `updateRunTags` mutation into `RunHeader` via a server action;
   enforce admin/member role check at the UI layer.
3. **RBAC enforcement**: add `minimumRole` parameter to `requireOrgMembership()` in
   `convex/auth.ts`; enforce admin-only on `updateRunTags`, `createProject`, key management.
4. **Integration tests**: replace fixture stubs in `tests/integration/api.test.ts` with
   real tests against a Convex test deployment (`CONVEX_TEST_URL`, `TEST_API_KEY`).
5. **SDK upload-once guard**: cache the upload result in `HttpTransport._uploadArtifact`
   keyed by `(runId, checksum)` to skip redundant blob PUT calls on retry.

---

## Prompt 6 — SDK Auto-Externalization and Test Coverage

**Date:** 2026-04-10

### What changed

- `packages/sdk/src/transport.ts` — `HttpTransport.sendEvents()` now auto-externalizes
  oversized payloads. Before the retry loop, each event whose payload serializes to
  > `PAYLOAD_EXTERNALIZATION_THRESHOLD` bytes is uploaded via `POST /api/artifacts/upload`.
  The event's `payload` is replaced with an `ExternalizedPayload` pointer before being
  sent to `POST /api/events`. Upload failures return `{ success: false, retryable: false }`
  immediately; the events call is skipped.
- `packages/contracts/src/events.ts` — `ExternalizedPayload` interface added to the
  `EventPayload` discriminated union. `PAYLOAD_EXTERNALIZATION_THRESHOLD` imported by the
  SDK from `packages/contracts/src/artifacts.ts` (was already defined there in Prompt 4).
- `apps/web/src/lib/health.ts` — shared health data function extracted from the health
  API route, eliminating the loopback HTTP call that `SystemHealthPanel` previously made
  to `/api/health` from the server-side component.
- `tests/unit/transport-externalization.test.ts` — 26 new unit tests covering SDK payload
  externalization: small payload passthrough, large payload upload + pointer replacement,
  mixed batches, upload failure handling, and pointer shape correctness.
- `docs/adrs/0009_payload_externalization_sdk.md` — decision record for SDK-side
  externalization and the `ExternalizedPayload` pointer representation.

### Why the externalization path fits the architecture

ADR-0006 established that payloads exceeding 10 KB must be externalized to blob storage.
The API route has enforced this boundary since Prompt 4 (HTTP 413 for oversized events).
The SDK-side preflight implemented here completes the loop: instead of letting the server
reject the event, the SDK detects the oversize condition locally, uploads the blob, and
ships a compact pointer. This is the correct place for this logic because:

1. The SDK is the author of the event and has the full payload before any network call.
2. The API route's 413 rejection is a correctness guard, not a service — it is not
   designed to handle blobs for callers.
3. Externalizing in Convex mutations would introduce a cross-service call from the data
   layer into blob storage, violating the boundary established in ADR-0006.

The `ExternalizedPayload` type in `packages/contracts` follows the CLAUDE.md rule that
all shared types live in `packages/contracts` only. Any consumer (UI, Convex queries,
future analytics) that reads event payloads will see the type in the union and handle
it correctly.

### Hard-to-reverse decisions

- **`ExternalizedPayload` in the `EventPayload` union**: once events are stored in Convex
  with `payload.type === "_externalized"`, this shape is part of the persistent data model.
  Removing or renaming `ExternalizedPayload` would require a migration of all stored events.
  The shape was designed to be stable: `type`, `originalType`, and `_artifact` are the
  minimal fields needed for any consumer to render or fetch the externalized content.

### Known residual risks

- **Duplicate artifact records on retry**: if `_uploadArtifact` succeeds but the
  subsequent `/api/events` call fails permanently, a repeat flush call will upload the
  same blob again and insert a second `artifacts` record in Convex. The content is correct;
  only the record count is inflated. Mitigation: add `(runId, checksum)` dedup to
  `sdkCreateArtifact` (see ADR-0009, Prompt 7 recommendation).

### Test count

- Before Prompt 6: 356 tests in `tests/` workspace + 260 SDK tests = 616 total, all passing.
- After Prompt 6: 382 tests in `tests/` workspace (+ 26 new transport-externalization tests)
  + 260 SDK tests = **642 total, all passing**.

### Recommendation for Prompt 7

1. **ADR-0009 cleanup**: add `(runId, checksum)` dedup to `sdkCreateArtifact` in
   `convex/sdk_ingest.ts` to fix the duplicate artifact record risk on retry.
2. **Artifact GC job**: `convex/crons.ts` — daily job to query artifact records older than
   24 hours with no matching event reference, delete the orphaned blob from Vercel Blob, and
   remove the orphaned Convex record.
3. **Run list filtering**: status + date range filter in the runs page UI (Prompt 5 spec
   item 2C). Requires updating `convex/runs.ts → listRuns` to accept optional `status`
   and `startedAfter` parameters.
4. **RBAC enforcement**: `convex/auth.ts → requireOrgMembership()` needs an optional
   `minimumRole` parameter; admin-only mutations should pass `minimumRole: "admin"`.
5. **Integration tests**: replace fixture stubs in `tests/integration/api.test.ts` with
   real tests against a Convex test deployment.

---

## Prompt 5 — Release Candidate: Production Storage, Projection Verification, Deployment Docs

**Date:** 2026-04-10

### What changed

- `apps/web/src/lib/storage/vercel.ts` — `VercelBlobAdapter` production implementation using native `fetch` (no `@vercel/blob` package). Activated when `BLOB_STORE_TOKEN` env var is set.
- `apps/web/src/lib/storage/index.ts` — `getStorageAdapter()` updated: uses `BLOB_STORE_TOKEN` presence (not `BLOB_STORAGE_PROVIDER`) to select Vercel Blob vs stub adapter.
- `apps/web/src/lib/replay/verify.ts` — `verifyProjectionIntegrity(run, events)` pure function: checks sequence contiguity, detects duplicates, validates projection does not throw, produces `ProjectionVerifyResult` with structured error list and human-readable summary.
- `scripts/rebuild-projection.ts` — CLI tool for verifying run event sequence integrity locally and in CI.
- `apps/web/app/api/health/route.ts` — `GET /api/health` endpoint: returns storage adapter name, configured status, and timestamp. Operator health signal.
- `apps/web/src/components/runs/SystemHealthPanel.tsx` — displays health endpoint data in the web UI.
- `docs/adrs/0008_vercel_blob_adapter.md` — decision record for VercelBlobAdapter design (native fetch, no SDK dependency).
- `tests/unit/projection-verify.test.ts` — 68 new unit tests for `verifyProjectionIntegrity`: valid cases, empty events, sequence gaps, duplicate detection, large runs (500 events), nested events, failed run failure summaries, summary string content, projection field correctness, and determinism guarantees.
- `tests/unit/storage.test.ts` — updated 2 tests to match new `getStorageAdapter()` behavior (BLOB_STORE_TOKEN-based selection, no longer throws for BLOB_STORAGE_PROVIDER=vercel).
- `docs/deployment_checklist.md` — step-by-step checklist for local dev → staging → production deployment.
- `docs/release_readiness.md` — release candidate status document: what is ready, what is deferred, hard decisions, known gaps.
- `docs/operations_runbook.md` — operational runbook for common production issues.
- `.env.example` — `BLOB_STORE_TOKEN` and `BLOB_STORE_URL` documented (replaces `BLOB_READ_WRITE_TOKEN` and `BLOB_STORAGE_PROVIDER`).

### Why these release decisions

- **VercelBlobAdapter via native fetch**: avoids adding `@vercel/blob` as a dependency. The SDK must run in any Node.js environment. Keeping the blob adapter as a thin fetch wrapper with a single file to update if the API changes is the correct trade-off at v1 scale.
- **`BLOB_STORE_TOKEN` presence as the selector signal**: simpler than a `BLOB_STORAGE_PROVIDER` enum. If you have a token, use Vercel Blob. If not, use the stub. No risk of misconfigured provider name.
- **`verifyProjectionIntegrity` as a pure function**: aligns with the existing pattern of pure, deterministic algorithms for all projection work (ADR-0005). Makes it trivially testable and usable in both the web app and CLI scripts without dependency on any runtime context.
- **Deployment docs as first-class artifacts**: the system is approaching production readiness. Deployment checklists and runbooks must exist before any production deployment attempt. They cannot be written retrospectively after an outage.

### Hard-to-reverse decisions

- **env var naming: `BLOB_STORE_TOKEN` (not `BLOB_READ_WRITE_TOKEN` or `BLOB_STORAGE_PROVIDER`)**: all deployments must use this exact var name. Changing it later requires coordination across all environments and any external tooling that sets the variable.
- **No fallback if `BLOB_STORE_TOKEN` expires**: the adapter is selected at request time, not at server startup. A token expiry causes upload failures without a graceful fallback. This is acceptable for v1 (token TTLs are long) but must be addressed before high-volume production use.

### Known gaps

- SDK does not auto-externalize large payloads (> 10 KB). The API returns HTTP 413 — the SDK must be updated in v1.1 to call `/api/artifacts/upload` before `/api/events` for oversized payloads.
- No automatic artifact garbage collection for orphaned or failed-upload artifacts.
- Integration tests in `tests/integration/api.test.ts` remain fixture-based stubs; real Convex integration requires a live deployment.

### Test count

356 tests passing in `tests/` workspace (was 288 after Prompt 4, was 2 failing at Prompt 5 start due to `storage.test.ts` tests not reflecting the updated `getStorageAdapter()` behavior; fixed in Prompt 5).
260 SDK tests passing in `packages/sdk`.
Total: 616 tests, all green.

---

## Prompt 4 — Hardening: Blob Storage, Ingestion Idempotency, Artifact UI

**Date:** 2026-04-10

### What changed

- `apps/web/src/lib/storage/` — `BlobStorageAdapter` interface, `sha256Hex`, `PAYLOAD_EXTERNALIZATION_THRESHOLD` constant, `StubBlobStorageAdapter` (in-memory, dev/test), `getStorageAdapter()` factory
- `apps/web/app/api/events/route.ts` — 10 KB payload size check: events with JSON payload > 10 240 bytes rejected with HTTP 413 PAYLOAD_TOO_LARGE
- `apps/web/app/api/artifacts/upload/route.ts` — POST endpoint: externalize a large payload to blob storage and record the artifact in Convex; API key auth; enforces minimum payload size
- `convex/sdk_ingest.ts` — `sdkCreateEvents`: idempotent insert; duplicate (runId, sequenceNumber) returns existing ID instead of inserting; `sdkCreateArtifact`: API-key-authenticated artifact creation
- `apps/web/src/lib/services/artifacts.ts` — `listArtifacts`, `getArtifactUrl` wired to Convex; used by run detail page
- `apps/web/src/components/runs/ArtifactList.tsx` — renders real artifact data passed from run detail page
- `apps/web/app/(app)/runs/[runId]/events/[eventId]/page.tsx` — event detail page: full payload JSON, metadata, parent event link
- `apps/web/src/lib/convexFunctions.ts` — added `sdk_ingest.sdkCreateArtifact` function reference
- `tests/unit/storage.test.ts` — 28 new unit tests for threshold constant, sha256Hex, StubBlobStorageAdapter, getStorageAdapter
- `docs/adrs/0006_artifact_externalization.md` — decision record for payload externalization policy
- `docs/adrs/0007_ingestion_idempotency.md` — decision record for duplicate event handling

### Decisions made

- Idempotency key for events: `(runId, sequenceNumber)` — natural key matching how the SDK assigns sequence numbers. O(1) lookup via existing `by_run` Convex index. See ADR-0007.
- Threshold: 10,240 bytes (10 × 1024). Measured by `JSON.stringify(payload).length`. Enforced at the API route boundary. See ADR-0006.
- Blob storage is provider-agnostic. `StubBlobStorageAdapter` handles local dev and CI. Production adapter (Vercel Blob) deferred to v1.1 when `BLOB_READ_WRITE_TOKEN` is available.
- Checksum (SHA-256) computed before upload, stored on artifact record for integrity verification.

### Test count

288 tests passing (was 260 after Prompt 3; +28 in Prompt 4).

---

## Prompt 3 — Explainability Layer (replay, failure summary, diff)

**Date:** 2026-04-09

### What changed
- packages/contracts v0.1.0 → v0.2.0: extended ReplayFrame (actor, status, payloadPreview, depth), added FailureSummary/FailurePoint types, added GetReplayResponse/GetDiffResponse API types
- apps/web/src/lib/replay/: pure deterministic algorithms for projection (projection.ts), failure analysis (failure.ts), and run comparison (diff.ts)
- apps/web/src/lib/services/replay.ts + diff.ts: service layer fetching all events and computing projections
- apps/web/app/api/runs/[id]/replay/route.ts + app/api/diff/route.ts: new GET endpoints
- apps/web/src/components/runs/ReplayViewer.tsx: interactive step-through replay UI
- apps/web/src/components/runs/DiffViewer.tsx: side-by-side run comparison UI
- apps/web/src/components/runs/FailureSummary.tsx: failure callout panel
- tests/fixtures/events.ts: 6 scenario fixtures (successful run, failed tool, failed LLM, partial run, nested events, diverging runs for diff)
- tests/unit/replay.test.ts, failure.test.ts, diff.test.ts: algorithm unit tests
- docs/adrs/0005_on_demand_replay.md: decision record for projection strategy

### Why on-demand computation
Event counts for v1 are small. On-demand computation avoids cache invalidation complexity and keeps the event log as the only source of truth. See ADR-0005.

### Known edge cases
- Runs with >1000 events require multiple pagination fetches (handled but adds latency)
- Circular parentEventId chains are guarded but must not appear in well-formed data
- Payload comparison is order-sensitive (JSON.stringify) — field reordering looks like a diff

### Recommendation for Prompt 4
1. Project/agent management UI (list projects, agents, versions)
2. Event detail page (full payload inspector for a single event)
3. Run tagging and metadata search
4. API key management UI (revoke, rotate)
5. Run comparison flow from the runs list (select two runs → diff)
6. Blob storage wiring for large payloads

---

## Session: Prompt 1 — Initial Foundation

**Date:** 2026-04-09
**Session ID:** Prompt 1
**Teams:** A (Repo Architecture), B (Data + Contracts), C (Web App), D (SDK + Quality)
**Goal:** Lay the complete foundation — monorepo, schema, contracts, SDK skeleton, web app skeleton, tests.

---

## Decisions Made

1. **pnpm as the package manager (not npm or yarn).**
   Rationale: pnpm's symlink-based `node_modules` is significantly faster and disk-efficient in monorepos. pnpm workspaces are native and well-supported. Version pinned to 9.x in `package.json` `packageManager` field and `engines` constraint.

2. **Turborepo as the build orchestrator (not Nx or Lerna).**
   Rationale: Turborepo has minimal configuration, fast incremental builds via content hashing, and native pnpm workspace integration. It does not require per-package task runners or complex configuration.

3. **TypeScript strict mode enforced at the base tsconfig level.**
   All packages extend `tsconfig.base.json` which sets `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. These are not negotiable on a new project — fixing them later is extremely painful.

4. **`packages/contracts` has zero runtime dependencies.**
   Rationale: Contracts are imported by the SDK (runs in customer's Node process), by the web app (runs in Vercel), and by Convex (runs in Convex runtime). Adding a runtime dependency (e.g. Zod) to contracts would add that dependency to all three environments. Zod may be added in Prompt 2 for API validation, but must be kept tree-shakeable.

5. **EventType is a string literal union, not an enum.**
   Rationale: TypeScript string literal unions are the idiomatic choice for discriminated unions. Enums have footguns (reverse mapping, ambient declarations, emit issues). String literals serialize naturally to JSON without transformation.

6. **`events.payload` uses `v.any()` in Convex schema.**
   Rationale: Convex's validator DSL cannot express a discriminated union of complex objects without extreme verbosity and duplication. The contract types enforce the shape at the TypeScript level. Runtime validation of event payloads is the SDK's responsibility (it constructs the payload with typed builders).

7. **Run status transitions are enforced in the `updateRunStatus` mutation.**
   Rationale: Status transitions are business logic, not schema constraints. Encoding them in the mutation means they are enforced regardless of which caller invokes the mutation. The valid transitions are: `pending → running | cancelled`, `running → completed | failed | cancelled | timed_out`. Terminal states cannot be transitioned.

8. **`requireOrgMembership()` is called in every mutation, not just `getAuthContext()`.**
   Rationale: `getAuthContext()` only verifies the user is authenticated and the org exists. It does not verify the user is a member of that org. A sophisticated attacker who knows an `orgId` Convex ID could potentially bypass the auth check if only `getAuthContext()` were called. `requireOrgMembership()` adds the membership check.

9. **Sequence numbers are SDK-assigned, not server-assigned.**
   Rationale: If sequence numbers were server-assigned, the SDK would need a round-trip to the server before buffering each event. That would serialize event recording and add latency. SDK-assigned sequence numbers allow buffering with no server round-trips. The server validates contiguity on receive.

10. **`AgentVersion` is immutable once created — there is no `updateAgentVersion`.**
    Rationale: An AgentVersion represents a point-in-time snapshot of agent configuration. If it could be mutated, historical runs would no longer accurately reflect the configuration that produced them. Immutability is a correctness requirement, not a preference.

11. **`comments` use a `targetId: string` + `targetType: "run" | "event"` union rather than two separate nullable foreign keys.**
    Rationale: Two nullable FKs (`runId?`, `eventId?`) require a check constraint to ensure exactly one is set. The string+discriminant approach is simpler in Convex (which has no check constraints) and maps naturally to the UI, which shows comments on either entity type without different code paths.

12. **No React UI component library (no shadcn, Radix, MUI).**
    Rationale: Agent Flight Recorder is a technical tool with a specific visual language (calm, dense, high-signal). External component libraries impose design opinions that are hard to override. Tailwind primitives give full control. This decision also keeps the dependency surface small and avoids version conflict issues.

13. **SDK `Transport` interface is injectable (dependency injection pattern).**
    Rationale: Unit testing the `Recorder` without a real HTTP endpoint requires injecting a mock transport. Without DI, every test would need to spin up a server or intercept `fetch`. The `MockTransport` pattern is clean and fast.

14. **`Recorder` maintains a single active run context.**
    Rationale: The common use case is one agent run per Recorder instance. Supporting concurrent runs would complicate the API (every method would need a `runId` parameter) and the buffer (separate buffers per run). If concurrent runs are needed, the caller should instantiate multiple Recorders.

15. **`FlushResult` always returns success/failure explicitly — no thrown exceptions.**
    Rationale: The SDK runs inside customer agent code. If `flush()` throws, the exception propagates into the agent, potentially crashing it. Returning a `FlushResult` with `errors[]` lets the SDK surface the failure without affecting the agent's execution path. The caller can inspect `result.errors` and decide how to proceed.

16. **`scripts/validate.sh` runs typecheck → build → lint in that order.**
    Rationale: Typecheck is the fastest signal that something is wrong. Building before typechecking would waste CI time if there are type errors. Lint runs last because it catches style issues, not correctness issues — style issues are lower priority than build failures.

17. **`by_agent_started` and `by_project_started` indexes on the `runs` table.**
    Rationale: The most common query patterns are "list runs for this agent, newest first" and "list runs for this project, newest first". The compound index on `(agentId, startedAt)` enables efficient time-range queries without a full table scan.

18. **`parentEventId` on the events table enables a DAG, not just a flat list.**
    Rationale: Real agent executions are not flat sequences. A single LLM response may trigger multiple tool calls, each of which makes HTTP requests. `parentEventId` lets the UI reconstruct the execution tree for the inspector view while `sequenceNumber` preserves the canonical timeline order.

---

## Files Created

### Team A — Repo Architecture

- `package.json` — workspace root, pnpm config, Turborepo scripts
- `pnpm-workspace.yaml` — workspace package globs
- `tsconfig.base.json` — strict TypeScript base config
- `.eslintrc.json` (root) — ESLint config with import rules
- `.prettierrc` — Prettier config
- `turbo.json` — Turborepo pipeline config
- `CLAUDE.md` — Project constitution (system boundaries, entity model, rules for future sessions)
- `README.md` — Developer onboarding
- `scripts/validate.sh` — CI validation gate (typecheck → build → lint)
- `scripts/seed.ts` — Dev database seeding (stub)
- `scripts/validate.ts` — Validate script TypeScript runner
- `.env.example` — (MISSING — not created in Prompt 1, must be created in Prompt 2)
- `.github/workflows/ci.yml` — (MISSING — not created in Prompt 1, must be created in Prompt 2)

### Team B — Data + Contracts

**packages/contracts:**
- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/src/entities.ts` — Organization, Project, Agent, AgentVersion, Run, Event, Artifact, Comment
- `packages/contracts/src/events.ts` — EventType union, all payload shapes, EventPayload
- `packages/contracts/src/status.ts` — RunStatus, RunStatusValues, isTerminalStatus()
- `packages/contracts/src/api.ts` — All API request/response shapes
- `packages/contracts/src/replay.ts` — ReplayProjection, ReplayFrame
- `packages/contracts/src/diff.ts` — RunDiff, EventDiff, DiffSummary, FieldChange
- `packages/contracts/src/artifacts.ts` — Artifact types (if separate from entities)
- `packages/contracts/src/index.ts` — Re-exports all public types

**convex/:**
- `convex/schema.ts` — All 8 table definitions with indexes (COMPLETE)
- `convex/auth.ts` — `getAuthContext()`, `requireOrgMembership()` (COMPLETE)
- `convex/runs.ts` — `listRuns`, `getRun`, `createRun`, `updateRunStatus` (COMPLETE)
- `convex/events.ts` — `listEvents`, `getEvent`, `createEvent` (COMPLETE)
- `convex/artifacts.ts` — `listArtifacts`, `createArtifact` (COMPLETE)
- `convex/comments.ts` — LIST query implemented; CREATE/RESOLVE mutations (STUB)
- `convex/organizations.ts` — `getOrg` (STUB — needs createOrg, getOrgByClerkId)
- `convex/projects.ts` — `listProjects` (STUB — needs createProject)
- `convex/helpers/pagination.ts` — `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` (COMPLETE)
- `convex/helpers/storage.ts` — `BlobStorageAdapter` interface (INTERFACE ONLY — no implementation)

### Team C — Web App

**apps/web — structure:**
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/next.config.js`
- `apps/web/tailwind.config.ts`
- `apps/web/postcss.config.js`

**apps/web/src/lib:**
- `apps/web/src/lib/env.ts` — Env var validation at startup (COMPLETE)
- `apps/web/src/lib/auth.ts` — Clerk auth helpers for Next.js (STUB)
- `apps/web/src/lib/utils.ts` — Utility functions (STUB)
- `apps/web/src/lib/services/runs.ts` — Run service layer (STUB — returns fake data)
- `apps/web/src/lib/services/events.ts` — Event service layer (STUB — returns empty array)
- `apps/web/src/lib/services/comments.ts` — Comment service layer (STUB — returns empty array)

**apps/web/src/components/ui:**
- `Badge.tsx` — Status badges with color variants
- `Button.tsx` — Button with primary/secondary/ghost variants
- `Card.tsx` — Container card
- `CodeBlock.tsx` — Syntax-highlighted code viewer
- `EmptyState.tsx` — Empty data state with message and action
- `ErrorState.tsx` — Error state with message and retry action
- `LoadingState.tsx` — Loading spinner/skeleton
- `Tabs.tsx` — Tab navigation component

**apps/web/src/components/layout:**
- `AppShell.tsx` — Root layout with sidebar
- `PageHeader.tsx` — Page title + breadcrumbs
- `Sidebar.tsx` — Navigation sidebar

**apps/web/src/components/runs:**
- `RunList.tsx` — Table of runs with status badges and timestamps
- `RunHeader.tsx` — Run detail header with status, timing, metadata
- `Timeline.tsx` — Chronological event list with type icons
- `EventInspector.tsx` — Per-event payload viewer (collapsible)
- `DiffViewer.tsx` — Side-by-side run diff (STUB — no diff computation)
- `ReplayViewer.tsx` — Step-through replay player (STUB — no playback logic)
- `ArtifactList.tsx` — List of artifacts with download links
- `CommentThread.tsx` — Comment list and compose form

**apps/web/src/app/ — MISSING.** No Next.js pages exist. This is the most critical gap for Prompt 2.

### Team D — SDK + Quality

**packages/sdk:**
- `packages/sdk/package.json`
- `packages/sdk/tsconfig.json`
- `packages/sdk/src/index.ts` — Public exports (COMPLETE)
- `packages/sdk/src/recorder.ts` — Recorder class (COMPLETE)
- `packages/sdk/src/events.ts` — Events builders, buildEvent (COMPLETE)
- `packages/sdk/src/transport.ts` — Transport interface, HttpTransport (STUB — all methods throw)
- `packages/sdk/src/types.ts` — RecorderConfig, RunContext, FlushResult, etc. (COMPLETE)

**tests:**
- `tests/vitest.config.ts`
- `tests/unit/sdk.test.ts` — Recorder tests with MockTransport (PASSING)
- `tests/unit/contracts.test.ts` — Contract type coverage tests (PASSING)
- `tests/integration/api.test.ts` — (STUB — all tests marked TODO)
- `tests/fixtures/runs.ts` — Sample run and event data (COMPLETE)

**docs:**
- `docs/product_spec.md` — Full product specification (COMPLETE)
- `docs/adrs/0001_repo_shape.md` — (written in Prompt 1)
- `docs/adrs/0002_event_log_is_canonical.md` — (written in Prompt 1)
- `docs/adrs/0003_tenancy_boundary.md` — (written in Prompt 1)
- `docs/adrs/0004_shared_contracts_package.md` — (written in Prompt 1)

---

## Deviations from Original Spec

1. **No `.env.example` was created.** Environment variables are referenced in `apps/web/src/lib/env.ts` but a template `.env.example` was not created. Must be created in Prompt 2 before other developers can set up the project.

2. **No GitHub Actions CI workflow was created.** `scripts/validate.sh` exists and is the validation gate, but there is no `.github/workflows/ci.yml` that runs it on pull requests. Must be created in Prompt 2.

3. **`convex/comments.ts` mutations are incomplete.** The `createComment` and `resolveComment` mutations were not implemented in Prompt 1. The list query exists.

4. **`apps/web/src/app/` does not exist.** The Next.js App Router requires this directory to serve pages. Zero pages exist. The web app cannot be run as a server yet.

5. **SDK `HttpTransport` is entirely stubbed.** All three methods throw. The SDK is functional end-to-end with a mock transport (tests pass), but cannot make real HTTP calls until Prompt 2 implements the API routes and the transport.

6. **No API key management system.** The `RecorderConfig` accepts an `apiKey`, and the `Transport` auth interface carries it, but there is no `api_keys` table in Convex and no API key issuance flow. Prompt 2 must decide: use Clerk tokens or implement a separate API key system.

---

## Risks Identified

1. **API key auth gap.** The SDK sends an `apiKey` but there is no system to issue or validate API keys. If we use Clerk org tokens directly, the SDK must manage token refresh. If we use opaque API keys, we need the `api_keys` table. This is the most critical architectural decision remaining.

2. **Convex `v.any()` for event payloads is a runtime validation gap.** Large, malformed payloads can be stored without error. The SDK's typed builders mitigate this, but untrusted ingest (e.g. from a compromised API key) could store arbitrary data in the events table. Payload validation at the API route layer (Zod) is the mitigation.

3. **No test environment for Convex.** Integration tests need a Convex dev deployment to run against. Without one, all integration tests are stubs and cannot catch schema/mutation regressions. This is acceptable for Prompt 1 (foundation) but must be resolved before the project grows.

4. **`apps/web` has no pages yet.** The web app is not runnable. This is expected for Prompt 1 but means there has been no end-to-end validation of the auth or Convex integration from the browser. Prompt 2 must create pages and perform manual smoke testing.

5. **Blob storage is a no-op.** Large payloads will either fail silently or be stored in-line (violating the 10 KB rule) until the `BlobStorageAdapter` is implemented. If anyone uses the SDK with large payloads before Prompt 3, they will hit issues.

6. **`turbo.json` pipeline ordering must be validated.** If the `dependsOn` declarations in `turbo.json` are incorrect, packages may be built out of order. This would cause stale type artifacts and confusing TypeScript errors. Must be verified when Prompt 2 adds actual build steps.

---

## Completed vs Stubbed

| Area | Completed | Stubbed |
|------|-----------|---------|
| Monorepo config | pnpm workspace, Turborepo, TypeScript, ESLint, Prettier, validate.sh | .env.example, CI workflow |
| Convex schema | All 8 tables, all indexes | — |
| Convex auth | getAuthContext(), requireOrgMembership() | — |
| Convex runs | listRuns, getRun, createRun, updateRunStatus | — |
| Convex events | listEvents, getEvent, createEvent | — |
| Convex artifacts | listArtifacts, createArtifact | — |
| Convex comments | (list query) | createComment, resolveComment |
| Convex organizations | — | createOrg, getOrgByClerkId |
| Convex projects | — | createProject, listProjects (full) |
| Blob storage | BlobStorageAdapter interface | Concrete implementation |
| packages/contracts | All entity types, all event types, API shapes, replay/diff projections | — |
| packages/sdk | Recorder class, Events builders, types, Transport interface | HttpTransport implementation |
| apps/web components | All UI primitives, layout, run-specific components | — |
| apps/web service layer | Service function signatures, type imports | Real Convex calls |
| apps/web pages | — | All pages (app/ directory missing) |
| Unit tests | sdk.test.ts (passing), contracts.test.ts (passing) | integration/api.test.ts |
| Documentation | product_spec.md, all 4 ADRs, this build log, working_memory.md, architecture.md, product_model.md, next_steps.md | — |
