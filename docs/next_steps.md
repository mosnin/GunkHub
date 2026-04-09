# Next Steps — Prompt 4 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 3 (Explainability Layer) complete.
**This document:** Defines what Prompt 4 must accomplish, in scope, out of scope, and acceptance criteria.

---

## 1. What Prompt 4 Should Accomplish

Prompt 4 must transform the explainability layer into a usable product by wiring the replay, diff, and failure summary algorithms into real UI pages, completing the project and agent management views, implementing the event detail page, and filling remaining gaps in the management layer.

The test for "Prompt 4 succeeded": an engineer can open the web UI, navigate to a completed run, step through its events in the replay view, inspect any event's full payload, compare two runs side-by-side in the diff view, and see a clear failure summary when a run fails.

---

## 2. Recommended Scope for Prompt 4

### 2A. Wire replay and diff into the UI (CRITICAL PATH)

The algorithms exist in `apps/web/src/lib/replay/`. They must now be called from API routes and consumed by the UI components.

**Replay endpoint and viewer:**

Create `apps/web/src/app/api/runs/[runId]/replay/route.ts`:
- `GET /api/runs/[runId]/replay` — fetches all events for the run, calls `buildReplayProjection`, returns `ReplayProjection` as JSON
- Auth: validate API key or Clerk session; scope to org
- Pagination: fetch events in pages if needed (runs with >100 events require multiple Convex fetches)

Wire `apps/web/src/components/runs/ReplayViewer.tsx`:
- Accept `ReplayProjection` as a prop
- Render a list of `ReplayFrame` entries with actor badges, status indicators, elapsed_ms, and payloadPreview
- Add step-through navigation: Previous / Next buttons advance the "active frame" index
- Keyboard navigation: left/right arrow keys step through frames
- Highlight the active frame visually (border, background tint)

**Diff endpoint and viewer:**

Create `apps/web/src/app/api/diff/route.ts`:
- `GET /api/diff?left=[runId]&right=[runId]` — fetches events for both runs, calls `buildRunDiff`, returns `RunDiff` as JSON
- Auth: validate org membership; both runs must belong to the caller's org

Wire `apps/web/src/components/runs/DiffViewer.tsx`:
- Accept `RunDiff` as a prop
- Render events side-by-side: left column (baseline), right column (comparison)
- Color-code by `EventDiff.kind`: same=neutral, added=green, removed=red, changed=yellow
- For `kind="changed"`, list the `FieldChange` entries showing `path`, `left`, and `right` values
- Show `summary.statusChanged` banner at the top if the terminal event type differs

**Failure summary component:**

Wire `apps/web/src/components/runs/FailureSummary.tsx`:
- Accept `FailureSummary` as a prop
- Only render when `hasFailure=true`
- Show primary failure: event type, reason, error message (if available), sequence number
- Show `allFailurePoints` as a collapsible list
- Show `cannotInfer` warning banner when applicable
- Show `isIncomplete` indicator when the run has no terminal event

### 2B. Event detail page

Create `apps/web/src/app/(dashboard)/runs/[runId]/events/[eventId]/page.tsx`:
- Fetch the event by ID from Convex
- Render full payload in a `CodeBlock` (syntax-highlighted JSON)
- Show all event metadata: type, sequenceNumber, timestamp, actor (computed), parentEventId (as a link)
- Show parent event chain as breadcrumbs (if parentEventId exists, link to that event's detail page)
- Handle loading, empty, and error states

### 2C. Project and agent management UI

Create the following pages (stubs are acceptable if time is tight, but should render real data):

**Project list:**
`apps/web/src/app/(dashboard)/projects/page.tsx`
- List all projects for the org from Convex
- Show: project name, slug, agent count, most recent run status and timestamp
- Link each project to its detail page

**Project detail:**
`apps/web/src/app/(dashboard)/projects/[projectSlug]/page.tsx`
- Show project name, description, slug
- List agents in the project
- Show recent runs across all agents

**Agent detail:**
`apps/web/src/app/(dashboard)/projects/[projectSlug]/[agentSlug]/page.tsx`
- Show agent name, description
- List agent versions (immutable snapshots) with changelogs
- List recent runs for this agent, filterable by status

These pages require implementing the following Convex functions if not yet done:
- `convex/projects.ts` — `createProject`, `getProject`
- `convex/agents.ts` — `listAgents`, `getAgent`, `createAgent`

### 2D. Run comparison UI flow

Add a "Compare" flow to the runs list page:
- Select a baseline run (checkbox or "Set as baseline" button)
- Select a second run (another checkbox or "Compare to baseline")
- Navigate to `/runs/compare?left=[runId]&right=[runId]`

Create `apps/web/src/app/(dashboard)/runs/compare/page.tsx`:
- Fetch both runs and their events
- Call `buildRunDiff` via the diff API endpoint
- Render the `DiffViewer` component

### 2E. API key management UI

If deferred from Prompt 2, implement now:

Create `apps/web/src/app/(dashboard)/settings/api-keys/page.tsx`:
- List all API keys for the org (name, created date, last used, revocation status)
- Button to create a new key (shows the key once on creation, then only a masked prefix)
- Button to revoke an existing key

This requires:
- `api_keys` table in Convex schema (if not already added in Prompt 2)
- `convex/api_keys.ts` — `listApiKeys`, `createApiKey`, `revokeApiKey`
- `apps/web/src/app/api/settings/api-keys/route.ts` — GET/POST handlers

### 2F. Blob storage wiring (if not done in Prompt 2/3)

Implement `BlobStorageAdapter` using Vercel Blob:
- Concrete implementation in `convex/helpers/storage.ts` (or a separate file)
- Wire the artifact upload path: SDK detects >10 KB payload → calls `/api/artifacts/upload` → stores in Vercel Blob → creates artifact record in Convex → ships pointer event
- Add `BLOB_READ_WRITE_TOKEN` to `.env.example` if not already present
- Add artifact list display in the run detail page using the existing `ArtifactList` component

---

## 3. Specific Files That Need Implementation

| File | What Needs to Change |
|------|---------------------|
| `apps/web/src/app/api/runs/[runId]/replay/route.ts` | Create: GET handler calling buildReplayProjection |
| `apps/web/src/app/api/diff/route.ts` | Create: GET handler with ?left=&right= calling buildRunDiff |
| `apps/web/src/components/runs/ReplayViewer.tsx` | Implement: step-through navigation, frame rendering |
| `apps/web/src/components/runs/DiffViewer.tsx` | Implement: side-by-side diff with color-coded kinds |
| `apps/web/src/components/runs/FailureSummary.tsx` | Implement: failure callout with primaryFailure + allFailurePoints |
| `apps/web/src/app/(dashboard)/runs/[runId]/events/[eventId]/page.tsx` | Create: event detail page with full payload |
| `apps/web/src/app/(dashboard)/projects/page.tsx` | Create: project list page |
| `apps/web/src/app/(dashboard)/projects/[projectSlug]/page.tsx` | Create: project detail page |
| `apps/web/src/app/(dashboard)/projects/[projectSlug]/[agentSlug]/page.tsx` | Create: agent detail page |
| `apps/web/src/app/(dashboard)/runs/compare/page.tsx` | Create: side-by-side run comparison page |
| `apps/web/src/app/(dashboard)/settings/api-keys/page.tsx` | Create: API key management page |
| `convex/agents.ts` | Create/complete: listAgents, getAgent, createAgent |
| `convex/projects.ts` | Complete: createProject, getProject |
| `convex/api_keys.ts` | Create: listApiKeys, createApiKey, revokeApiKey |
| `convex/helpers/storage.ts` | Implement: BlobStorageAdapter using Vercel Blob |
| `tests/integration/api.test.ts` | Replace stubs with real integration tests |

---

## 4. What Must NOT Be Done in Prompt 4

- **Do not add real-time event streaming.** Convex subscriptions for live run monitoring are a v2 feature.
- **Do not add analytics dashboards.** Aggregate metrics (failure rate, p95 duration) are explicitly out of scope for v1.
- **Do not add webhooks or external integrations.** No Slack, no PagerDuty, no email notifications in v1.
- **Do not change the event log immutability rules.** No update or delete mutations for events, under any circumstances.
- **Do not add AI-powered failure analysis.** Failure summary is and must remain deterministic heuristic — no LLM calls for explaining failures.

---

## 5. Acceptance Criteria for Prompt 4

Prompt 4 is complete when all of the following are true:

1. **Replay viewer is wired and interactive.** Given a completed run URL, an engineer can navigate to the run detail page, click into replay mode, and step through events frame-by-frame using keyboard or mouse.

2. **Failure summary renders on failed runs.** When viewing a run with `status="failed"`, the failure summary callout is visible, shows the primary failure event, and links to the relevant event in the timeline.

3. **Diff viewer shows real data.** Given two run IDs, the diff page fetches both runs' events, computes the diff, and renders added/removed/changed events with field-level changes visible.

4. **Event detail page renders full payload.** Clicking an event in the timeline navigates to the event detail page, which shows the complete payload as formatted JSON using `CodeBlock`.

5. **Project and agent pages render real data.** The project list shows real projects from Convex. Agent detail shows agent versions with changelogs.

6. **API key management is functional.** An admin can create a new API key, see its value once, and revoke an existing key. Revoked keys are rejected by the API routes.

7. **`pnpm typecheck` passes with zero errors across all packages.**

8. **`./scripts/validate.sh` passes all three checks** (typecheck, build, lint).

9. **All unit tests in `tests/unit/` pass.** The replay, failure, and diff tests added in Prompt 3 must pass against the real algorithm implementations.

10. **Integration tests cover at least the replay and diff API routes.** `tests/integration/api.test.ts` must have real (not stubbed) tests for `GET /api/runs/[runId]/replay` and `GET /api/diff`.

---

## 6. Known Technical Debt to Address in Prompt 4

1. **Payload comparison is order-sensitive** (JSON.stringify). If field-order-insensitive comparison is needed for reliable diffs, sort object keys before stringifying in `buildRunDiff`. This is a minor improvement but reduces false-positive diffs.

2. **No request timeout on Convex event pagination.** If a run has thousands of events and the Convex fetch is slow, the replay endpoint will wait indefinitely. Add a timeout or pagination limit.

3. **`parentEventId` links in the replay viewer are not yet clickable.** The ReplayFrame renders depth but doesn't link parent frames. Add a "Jump to parent" interaction.

4. **`apps/web/src/app/` is still missing several pages from Prompt 2 scope.** At minimum, the dashboard and run list pages should exist before Prompt 4 adds new pages on top of them.

5. **Integration tests still stubbed.** All tests in `tests/integration/api.test.ts` are marked TODO. These should test the full SDK → API routes → Convex path against a dev deployment.

---

## 7. Long-Term Roadmap (unchanged from Prompt 1)

### v1.0 (Prompts 1–4): Core Debuggability

The minimum viable product. An engineer can record, inspect, replay, and diff agent runs.

- Prompts 1–2: Foundation, ingestion pipeline, basic UI
- Prompt 3: Replay, diff, failure summary algorithms and tests
- Prompt 4: Polish, UI wiring, project/agent management, integration tests, documentation

### v1.1: Reliability and Usability Improvements

After v1.0 ships:
- Payload externalization fully wired (real blob storage)
- Run search by metadata fields and tags
- Improved error state design
- SDK Python port (if demand exists)
- Copy-to-clipboard on run ID, event ID, payload values
- Keyboard navigation through event timeline

### v2.0: Real-Time and Analytics

After product-market fit is established:
- Live run monitoring: real-time event stream as a run executes
- Aggregate analytics: failure rate by agent, p95 duration by event type
- Comparison dashboards: version A vs version B aggregate metrics
- Ingest layer extraction: standalone ingest service for high-throughput production use

### v3.0: Collaboration and Governance

- Team annotations: shared comment threads, resolution workflows
- Audit log export (compliance)
- Webhook integrations: Slack on run failure, PagerDuty escalation
- SSO: SAML, enterprise identity providers
- Data retention policies: automatic run expiry, selective replay archiving
