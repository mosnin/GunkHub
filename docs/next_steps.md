# Next Steps — Prompt 2 Specification

**Document type:** Exact specification for the next build session.
**Current state:** Prompt 1 (Initial Foundation) complete.
**This document:** Defines what Prompt 2 must accomplish, in scope, out of scope, and acceptance criteria.

---

## 1. What Prompt 2 Should Accomplish

Prompt 2 must transform the scaffolded foundation into a working application that:

1. Can be run locally with `pnpm dev` (web app serves real pages)
2. Has a functioning ingestion pipeline (SDK → API routes → Convex)
3. Shows real data from Convex in the UI (not stub returns)
4. Has a complete developer setup story (`.env.example`, CI workflow)

The test for "Prompt 2 succeeded": an engineer can instrument a TypeScript script with the SDK, run it, and see the resulting run appear in the web UI with all events visible.

---

## 2. Recommended Scope for Prompt 2

### 2A. Create the Next.js App Router pages (CRITICAL PATH)

The `apps/web/src/app/` directory must be created with the following routes:

```
app/
├── layout.tsx                          Root layout (ClerkProvider + ConvexProvider)
├── page.tsx                            Landing / redirect to sign-in
├── sign-in/[[...sign-in]]/page.tsx     Clerk sign-in page
├── sign-up/[[...sign-up]]/page.tsx     Clerk sign-up page
├── (dashboard)/
│   ├── layout.tsx                      Authenticated layout with AppShell/Sidebar
│   ├── page.tsx                        Dashboard — recent runs, org summary
│   ├── projects/
│   │   ├── page.tsx                    Project list
│   │   └── [projectSlug]/
│   │       ├── page.tsx                Project detail — agent list, recent runs
│   │       └── [agentSlug]/
│   │           └── page.tsx            Agent detail — version list, run list
│   └── runs/
│       ├── page.tsx                    All runs (org-wide, filterable)
│       └── [runId]/
│           ├── page.tsx                Run detail — event timeline, metadata
│           └── events/
│               └── [eventId]/
│                   └── page.tsx        Event detail — full payload inspector
```

Each page must have loading, empty, and error states. Use `loading.tsx` and `error.tsx` where appropriate.

### 2B. Wire the service layer to real Convex calls

Replace all stubs in `apps/web/src/lib/services/` with real Convex calls:

**`lib/services/runs.ts`:**
- `listRuns(params)` → calls `api.runs.listRuns` via Convex
- `getRun(id)` → calls `api.runs.getRun` via Convex
- `createRun(req)` → calls `api.runs.createRun` via Convex
- `updateRunStatus(id, status)` → calls `api.runs.updateRunStatus` via Convex

**`lib/services/events.ts`:**
- `listEvents(params)` → calls `api.events.listEvents` via Convex
- `getEvent(id)` → calls `api.events.getEvent` via Convex

**`lib/services/comments.ts`:**
- `listComments(targetId, targetType)` → calls `api.comments.listComments` via Convex
- `createComment(req)` → calls `api.comments.createComment` via Convex

For server components: use `ConvexHttpClient` with the server-side Clerk token.
For client components (interactive UI): use `useQuery` and `useMutation` Convex React hooks.

### 2C. Implement the ingestion API routes

Create `apps/web/src/app/api/` with the following route handlers:

```
api/
├── runs/
│   ├── route.ts                        POST — create run
│   └── [runId]/
│       └── status/
│           └── route.ts                PATCH — update run status
└── events/
    └── route.ts                        POST — batch append events
```

Each route handler must:
1. Validate the API key from the `x-api-key` header (see API key decision below)
2. Parse and validate the request body using Zod schemas derived from `packages/contracts`
3. Call the corresponding Convex mutation
4. Return the appropriate response or error shape (`ApiError`)

### 2D. Implement `HttpTransport` in the SDK

`packages/sdk/src/transport.ts` — implement all three methods:

**`createRun(req, auth)`:**
```
POST {endpoint}/api/runs
Headers: x-api-key: {auth.apiKey}
Body: CreateRunRequest
Returns: CreateRunResponse
```

**`sendEvents(events, auth)`:**
```
POST {endpoint}/api/events
Headers: x-api-key: {auth.apiKey}
Body: { events: CreateEventRequest[] }
Returns: { eventIds: string[] }
```

**`updateRunStatus(runId, status, endedAt, auth)`:**
```
PATCH {endpoint}/api/runs/{runId}/status
Headers: x-api-key: {auth.apiKey}
Body: { status, endedAt }
Returns: void
```

Add retry logic using `defaultRetryStrategy`. Add error wrapping that returns `TransportResponse` (never throws). Add `debug` logging if `config.options?.debug` is true.

### 2E. Resolve the API key authentication decision

**Decision required:** Choose between two options:

**Option A: Use Clerk organization tokens directly.**
- The SDK caller provides a Clerk org-scoped token as the `apiKey`.
- The Next.js API route validates it against Clerk's verify endpoint.
- Pro: No additional infrastructure. Con: Clerk tokens expire, SDK must handle refresh.

**Option B: Implement an `api_keys` table in Convex.**
- Add table: `api_keys` with fields `orgId`, `keyHash`, `name`, `createdAt`, `lastUsedAt`, `revokedAt?`.
- The Next.js API route hashes the incoming key and looks it up in Convex.
- Pro: Long-lived, revocable, multiple keys per org. Con: More infrastructure.

**Recommendation:** Option B. API keys are the standard pattern for machine-to-machine auth. Implement a minimal version: `api_keys` table, `createApiKey` mutation, `validateApiKey` helper used in API routes. UI for key management can come in Prompt 3.

### 2F. Create the missing developer setup files

**`.env.example`** — must contain all required environment variables with explanations:

```bash
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Convex
NEXT_PUBLIC_CONVEX_URL=https://....convex.cloud
CONVEX_DEPLOYMENT=dev:...  # from npx convex dev

# Blob Storage (stub for v1 — not required until Prompt 3)
# BLOB_READ_WRITE_TOKEN=
```

**`.github/workflows/ci.yml`** — CI pipeline that runs on every push and PR:

```yaml
name: CI
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm test
```

### 2G. Implement missing Convex mutations

**`convex/comments.ts`** — add:
- `createComment({ targetId, targetType, content })` — creates a Comment record after auth check
- `resolveComment({ commentId })` — sets `resolvedAt`, `resolvedBy`
- `editComment({ commentId, content })` — sets `content`, `updatedAt`

**`convex/organizations.ts`** — add:
- `createOrg({ clerkOrgId, name, slug })` — called by Clerk webhook on org creation
- `getOrgByClerkId({ clerkOrgId })` — look up org by Clerk org ID

**`convex/projects.ts`** — add:
- `createProject({ orgId, name, slug, description? })` — creates a Project
- `getProject({ projectId })` — get project, verify membership

**`convex/agents.ts`** — create file with:
- `listAgents({ projectId })` — list agents for a project
- `getAgent({ agentId })` — get agent, verify membership
- `createAgent({ projectId, name, slug, description? })` — creates an Agent

---

## 3. Specific Files That Need Implementation

| File | What Needs to Change |
|------|---------------------|
| `apps/web/src/app/layout.tsx` | Create: root layout with ClerkProvider + ConvexProviderWithClerk |
| `apps/web/src/app/(dashboard)/layout.tsx` | Create: auth-protected layout with AppShell |
| `apps/web/src/app/(dashboard)/page.tsx` | Create: dashboard page — recent runs query |
| `apps/web/src/app/(dashboard)/runs/page.tsx` | Create: run list page with status filter |
| `apps/web/src/app/(dashboard)/runs/[runId]/page.tsx` | Create: run detail + event timeline |
| `apps/web/src/app/api/runs/route.ts` | Create: POST handler for run creation |
| `apps/web/src/app/api/runs/[runId]/status/route.ts` | Create: PATCH handler for status update |
| `apps/web/src/app/api/events/route.ts` | Create: POST handler for event batch |
| `apps/web/src/lib/services/runs.ts` | Replace stubs with real Convex calls |
| `apps/web/src/lib/services/events.ts` | Replace stubs with real Convex calls |
| `apps/web/src/lib/services/comments.ts` | Replace stubs with real Convex calls |
| `packages/sdk/src/transport.ts` — `HttpTransport` | Implement createRun, sendEvents, updateRunStatus |
| `convex/comments.ts` | Add createComment, resolveComment, editComment |
| `convex/organizations.ts` | Add createOrg, getOrgByClerkId |
| `convex/projects.ts` | Add createProject, getProject (full) |
| `convex/agents.ts` | Create file with listAgents, getAgent, createAgent |
| `.env.example` | Create with all required vars documented |
| `.github/workflows/ci.yml` | Create CI pipeline |

---

## 4. What Must NOT Be Done in Prompt 2

The following are explicitly out of scope. Do not implement them.

**Replay:** The `ReplayViewer` component is scaffolded but the playback logic must not be implemented. Replay requires a working run detail page first (Prompt 2), then replay logic (Prompt 3).

**Diff:** The `DiffViewer` component is scaffolded but the diff computation must not be implemented. Diff requires the replay infrastructure as a prerequisite.

**Blob storage implementation:** The `BlobStorageAdapter` interface exists. Do not implement a concrete adapter. The payload externalization path (>10 KB → blob) must not be connected yet. Focus on the core event pipeline first.

**API key management UI:** Even if the `api_keys` table is added in Prompt 2 (Option B), there should be no UI for creating or listing API keys. This is a Prompt 3 feature.

**Agent version management UI:** AgentVersion creation and version history display are not required in Prompt 2. The schema supports it, but no UI pages should be built for it.

**Multi-page navigation for projects/agents:** The project list and agent detail pages may be deferred to Prompt 3 if scope is tight. The minimum viable page set for Prompt 2 is: dashboard, run list, run detail.

**Real-time subscriptions:** Convex supports real-time subscriptions via `useQuery`. Do not add live-updating behavior in Prompt 2. Fetch data on load. Real-time will be a v2 feature.

---

## 5. Acceptance Criteria for Prompt 2

Prompt 2 is complete when all of the following are true:

1. **`pnpm dev` starts without errors.** The web app serves the dashboard page. No unhandled exceptions in the browser console on first load.

2. **Authentication works.** An unauthenticated user is redirected to sign-in. After signing in with Clerk, the dashboard loads and shows the user's organization context.

3. **SDK can record a run end-to-end.** A test script using `Recorder` + real `HttpTransport` can call `startRun()`, `recordEvent('custom', ...)`, and `endRun()` without throwing. The run appears in the Convex database (verifiable via Convex dashboard).

4. **Run list page shows real data.** The `/runs` page queries Convex and renders a list of runs (even if empty) with proper empty state. It does not return stub data.

5. **Run detail page renders all events.** Given a run ID in the URL, the page fetches the run and its events from Convex and renders them using the Timeline component. All event types render without crashing.

6. **API routes return proper error shapes.** A request to `POST /api/runs` with no auth header returns `{ code: "UNAUTHORIZED", message: "..." }` with status 401. A request with a valid API key and malformed body returns `{ code: "VALIDATION_ERROR", ... }` with status 400.

7. **`pnpm typecheck` passes with zero errors across all packages.**

8. **`./scripts/validate.sh` passes all three checks** (typecheck, build, lint).

9. **CI workflow runs and passes on a push to a feature branch.** The `.github/workflows/ci.yml` triggers and all steps complete green.

10. **`.env.example` is complete.** Every environment variable consumed by any package is documented in `.env.example` with a brief description and example value.

---

## 6. Recommended Scope for Prompt 3 (Replay and Diff)

After Prompt 2 delivers a working end-to-end pipeline, Prompt 3 should focus on:

**Replay implementation:**
- Implement `ReplayProjection` computation in the web app service layer (fetch events, compute `elapsed_ms`, return frames)
- Wire `ReplayViewer` component to the computed projection
- Add keyboard navigation (arrow keys step through events)
- Add timeline scrubber with accurate proportional timestamps
- Validate that `run.started` is always frame 0

**Diff implementation:**
- Implement `RunDiff` computation: fetch both runs' events, align by sequenceNumber, deep-compare payloads
- Wire `DiffViewer` component to show `added`, `removed`, `changed`, `same` events
- Highlight changed fields within `FieldChange[]` using the CodeBlock component
- Add a "diff two runs" UI: select baseline run, select comparison run, show diff

**Blob storage:**
- Implement `BlobStorageAdapter` using Vercel Blob
- Add `BLOB_READ_WRITE_TOKEN` to `.env.example`
- Wire the artifact upload path: SDK detects >10 KB payload → calls `/api/artifacts/upload` → stores in blob → creates artifact record in Convex → ships pointer event

**Additional pages:**
- Project list page with agent counts and recent run status
- Agent detail page with version history
- Event detail page (full payload inspector for a single event)

**API key management:**
- If deferred from Prompt 2: UI to create and list API keys
- Revocation flow

---

## 7. Long-Term Roadmap Outline

### v1.0 (Prompts 1–4): Core Debuggability

The minimum viable product. An engineer can record, inspect, replay, and diff agent runs.

- Prompts 1–2: Foundation, ingestion pipeline, basic UI
- Prompt 3: Replay, diff, blob storage
- Prompt 4: Polish, edge cases, org/project/agent management UI, integration tests, documentation

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

---

## What Prompt 2 Should Accomplish

Connect the skeleton to real data. After Prompt 2, a developer with valid Clerk and Convex credentials should be able to:

1. Sign in with Clerk
2. See their organization's projects, agents, and runs
3. Create a run via the API
4. Record events via the API
5. See runs and events in the web UI

---

## Recommended Scope for Prompt 2

### A. Convex integration in the web app

Replace the service stubs in `apps/web/src/lib/services/` with real Convex client calls.

**Files to implement:**
- `apps/web/src/lib/services/runs.ts` — replace placeholder returns with `useQuery(api.runs.listRuns, ...)` and `useMutation(api.runs.createRun)`
- `apps/web/src/lib/services/events.ts` — wire to `api.events.listEvents`
- `apps/web/src/lib/services/comments.ts` — wire to `api.comments.listComments` + `createComment`

**Pattern:** Use Convex React hooks in client components, server-side `fetchQuery` in server components.

### B. Real run creation endpoint

Implement `POST /api/runs` fully:
- Extract orgId from Clerk auth
- Validate agentId belongs to caller's org
- Call Convex `createRun` mutation via server-side client
- Return real run ID

**Files to implement:**
- `apps/web/app/api/runs/route.ts` — replace service stub call with Convex server client
- `apps/web/app/api/events/route.ts` — implement event creation with Convex

### C. Real event ingestion

Implement `POST /api/events` fully:
- Validate run belongs to caller's org
- Call Convex `createEvent` mutation
- Enforce immutability (no update/delete paths)
- Handle batch event submissions

### D. Convex auth setup

Configure Convex to verify Clerk JWTs:
- Add `convex/auth.config.ts` with Clerk JWKS URL
- Update `getAuthContext` in `convex/auth.ts` to read from `ctx.auth`
- Test auth flow end-to-end

### E. Wire RunList component to real data

Replace placeholder in `apps/web/app/(app)/runs/page.tsx`:
- Convert page to use Convex `useQuery` for runs
- Show real run data in RunList component
- Add pagination support

### F. Organization bootstrap on sign-in

When a user signs in, create their Convex org record if it doesn't exist:
- Add Clerk webhook handler at `apps/web/app/api/webhooks/clerk/route.ts`
- Handle `organization.created` event
- Call Convex `createOrganization` mutation

---

## What Must NOT Be Done in Prompt 2

- Do not implement replay logic (Prompt 3)
- Do not implement diff logic (Prompt 3)
- Do not implement production blob storage (Prompt 4)
- Do not add real-time event streaming
- Do not add analytics or metrics
- Do not implement SDK HTTP transport (Prompt 2 or 3)

---

## Acceptance Criteria for Prompt 2

1. `POST /api/runs` creates a real run in Convex
2. `POST /api/events` creates real events in Convex, scoped to org
3. Run list page shows real data from Convex
4. Authentication gates all API routes and pages
5. Cross-org data access is impossible
6. All 79 existing tests still pass
7. No TypeScript errors

---

## Prompt 3 Scope: Replay and Diff

After Prompt 2, the third prompt should implement:

1. **Replay projection** — compute `ReplayProjection` from event log
   - `GET /api/runs/[id]/replay` endpoint
   - `ReplayViewer` component wired to real data
   - Timeline animation (play/pause/step)

2. **Diff projection** — compute `RunDiff` from two runs
   - `GET /api/diff?left=[runId]&right=[runId]` endpoint
   - `DiffViewer` component wired to real data
   - Visual diff (added/removed/changed events highlighted)

3. **EventInspector** — fully interactive event tree
   - Left panel: event list with type badges
   - Right panel: payload viewer using CodeBlock
   - Click to navigate events

---

## Long-Term Roadmap

| Prompt | Goal |
|--------|------|
| 1 | Foundation (this prompt) |
| 2 | Real data flow and ingestion |
| 3 | Replay and diff projections |
| 4 | SDK HTTP transport implementation |
| 5 | Artifact upload and viewer |
| 6 | Comment threads wired to data |
| 7 | Dashboard with real metrics |
| 8 | Blob storage production implementation |
| 9 | Agent version management |
| 10 | Performance optimization and production readiness |
