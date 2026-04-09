# Architecture — Agent Flight Recorder

**Version:** 1.0
**Date:** 2026-04-09
**Status:** Reflects Prompt 1 (Initial Foundation) build state.

---

## 1. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Agent Codebase (Customer)                                          │
│                                                                     │
│   import { Recorder } from '@agent-flight-recorder/sdk'            │
│   const r = new Recorder({ endpoint, apiKey, agentId })             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  HTTP (batched JSON)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  apps/web  (Next.js 14 App Router, Vercel)                          │
│                                                                     │
│   /api/runs          POST  → createRun                              │
│   /api/runs/:id      PATCH → updateRunStatus                        │
│   /api/events        POST  → createEvent (batch)                    │
│   /api/artifacts     POST  → createArtifact (after blob upload)     │
│                                                                     │
│   API Routes call Convex mutations via convex/nextjs client         │
└──────────────┬──────────────────────────────────────────────────────┘
               │  Convex client (type-safe RPC over WebSocket/HTTP)
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Convex Backend                                                     │
│                                                                     │
│   schema.ts         Table definitions and indexes                   │
│   auth.ts           getAuthContext(), requireOrgMembership()        │
│   runs.ts           listRuns, getRun, createRun, updateRunStatus    │
│   events.ts         listEvents, getEvent, createEvent               │
│   artifacts.ts      listArtifacts, createArtifact                   │
│   comments.ts       listComments, createComment, resolveComment     │
│   organizations.ts  getOrg, createOrg                               │
│   projects.ts       listProjects, getProject, createProject         │
│   helpers/          pagination.ts, storage.ts (BlobStorageAdapter)  │
└──────────────┬──────────────────────────────────────────────────────┘
               │  Convex built-in document store (internally PostgreSQL)
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Convex Document Store (managed, hosted by Convex)                  │
│  Tables: organizations, projects, agents, agent_versions,           │
│          runs, events, artifacts, comments, user_memberships        │
└─────────────────────────────────────────────────────────────────────┘

Separately, for large payloads (> 10 KB):

┌──────────────┐     upload blob     ┌──────────────────────────────┐
│  apps/web    │ ─────────────────▶  │  Blob Storage                │
│  API route   │ ◀────────────────── │  (Vercel Blob / R2 — stub)   │
│              │    storageKey        │                              │
└──────────────┘                     └──────────────────────────────┘
                                              ▲
                                              │ Artifact record
                                              │ stores storageKey
                                     ┌────────┴────────────────────┐
                                     │  Convex: artifacts table    │
                                     └─────────────────────────────┘
```

**Web UI flow** (browser to Convex directly):

```
Browser → Clerk (auth) → Convex React hooks (useQuery, useMutation)
                            └─ Convex backend queries/mutations
```

The web UI bypasses Next.js API routes for read-heavy queries. It uses Convex React hooks directly from server or client components. The Next.js API routes are only the ingestion surface for the SDK.

---

## 2. Package Responsibility Matrix

| Package | Owns | Does NOT Own |
|---------|------|--------------|
| `apps/web` | Next.js App Router pages and layouts; React components; Tailwind config; API route handlers (`/api/**`); service layer (`lib/services/`); Clerk auth integration; `next.config.js`; `tailwind.config.ts` | Convex schema; Convex queries/mutations; SDK transport logic; shared type definitions |
| `packages/contracts` | All shared TypeScript type definitions: entity types, event payload union, API request/response shapes, replay and diff projection types; Zod schemas if added | Runtime framework code; fetch/HTTP logic; Convex-specific types; UI components |
| `packages/sdk` | `Recorder` class public API; event builder helpers (`Events.*`); `HttpTransport` implementation; `Transport` interface; buffering and retry logic; SDK-level types (`RecorderConfig`, `FlushResult`, etc.) | Convex schema; Next.js components; entity type definitions (imports from contracts) |
| `convex/` | Convex schema (`schema.ts`); all query and mutation functions; `auth.ts` context helpers; `helpers/` utilities; `BlobStorageAdapter` interface | React components; Next.js routing; SDK transport; contract type definitions (imports from contracts) |
| `scripts/` | `validate.sh` (CI validation gate); `seed.ts` (dev data seeding); `validate.ts` | Package logic |
| `tests/` | Unit tests (`unit/`); integration test stubs (`integration/`); fixtures (`fixtures/`) | Package source code |

---

## 3. Data Flow: How a Run Gets Recorded

This is the end-to-end path from SDK call to persisted event.

### Step 1: SDK starts a run

```
Recorder.startRun(input, config)
  → HttpTransport.createRun({ agentId, metadata, tags, sdkVersion })
    → POST /api/runs
      → Next.js API route handler
        → Validates Clerk auth (Bearer token or x-api-key header)
        → Calls convex mutation: createRun({ orgId, projectId, agentId, ... })
          → requireOrgMembership() check
          → ctx.db.insert("runs", { status: "pending", startedAt: now, ... })
          → Returns run document
      → Returns { run: Run } JSON
    → SDK stores runId in RunContext
  → SDK emits run.started event (buffered)
```

### Step 2: SDK records events during execution

```
Recorder.recordEvent("llm.request", payload)
  → payload serialized, sequenceNumber assigned (local counter)
  → pushed to eventBuffer[]
  → if buffer.length >= maxBatchSize: flush()
  → or: flush() fires on flushIntervalMs timer
```

### Step 3: SDK flushes event batch

```
Recorder.flush()
  → HttpTransport.sendEvents(eventBuffer[], { apiKey })
    → POST /api/events  (body: CreateEventRequest[])
      → Next.js API route handler
        → Validates auth
        → For each event in batch:
          → calls convex mutation: createEvent({ runId, type, sequenceNumber, timestamp, payload })
            → Verifies run exists and is in "running" state
            → requireOrgMembership() check
            → ctx.db.insert("events", { ... })
      → Returns { eventIds: string[] }
    → FlushResult returned to caller
```

### Step 4: SDK ends the run

```
Recorder.endRun(output)
  → Appends run.completed event to buffer
  → flush() (synchronous, drains buffer)
  → HttpTransport.updateRunStatus(runId, "completed", endedAt)
    → PATCH /api/runs/:id/status
      → Calls convex mutation: updateRunStatus({ runId, status: "completed", endedAt })
        → Validates transition (running → completed is valid)
        → ctx.db.patch(runId, { status: "completed", endedAt })
```

### Payload externalization path (triggered when payload > 10 KB)

```
SDK detects payload > 10 KB
  → POST /api/artifacts/upload  (body: { runId, eventId?, mimeType, data: base64 })
    → Next.js API route
      → Calls BlobStorageAdapter.upload(key, data, mimeType)
      → Calls convex mutation: createArtifact({ storageKey, checksum, size, ... })
      → Returns { storageKey, artifactId }
  → SDK builds pointer payload: { __externalized: true, artifactId, storageKey, checksum }
  → Continues with recordEvent() using pointer payload
```

---

## 4. Auth Flow

Clerk is the identity provider. Convex is the authorization enforcer.

```
User visits web app
  → ClerkProvider wraps the app (apps/web/src/app/layout.tsx)
  → Clerk handles sign-in, org selection
  → On sign-in, Clerk issues a JWT with claims including:
      { sub: "user_2abc...", org_id: "org_2xyz...", ... }

User makes a request to Convex (via React hook)
  → ConvexProviderWithClerk passes Clerk JWT to Convex
  → Convex validates JWT signature against Clerk's JWKS
  → ctx.auth.getUserIdentity() returns the validated identity

SDK makes a request to Next.js API route
  → Sends x-api-key: <org_api_key> header
  → Next.js API route validates the API key
  → Looks up orgId from the API key record
  → Calls Convex mutation with orgId in the mutation args
  → Convex mutation calls requireOrgMembership(ctx, orgId) to confirm

Inside every Convex query/mutation:
  1. Call getAuthContext(ctx) → extracts clerkUserId, clerkOrgId from JWT
  2. Look up Organization by clerkOrgId → get Convex orgId
  3. Call requireOrgMembership(ctx, orgId) → verify UserMembership record exists
  4. All subsequent db queries use orgId in the filter
```

**Key file:** `convex/auth.ts` — `getAuthContext()` and `requireOrgMembership()`.

**Multi-tenancy guarantee:** Because every query filters by `orgId` derived from the authenticated user's Clerk org, it is structurally impossible for org A to see org B's data — provided `getAuthContext()` is always called first, which CLAUDE.md enforces as a code convention.

---

## 5. Blob Storage Abstraction

### The Interface

```typescript
// convex/helpers/storage.ts

export interface BlobStorageAdapter {
  upload(key: string, data: ArrayBuffer, mimeType: string): Promise<string>;
  getUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}
```

### Why it exists

The blob storage implementation is the most likely infrastructure component to change between v1 and v2. Vercel Blob is convenient for initial development and staging; production workloads may require R2, S3, or GCS for cost and latency reasons. Hiding the implementation behind an interface means:

1. The rest of the codebase depends only on the interface, not the provider SDK.
2. Swapping providers requires changing exactly one file (the adapter implementation) and no call sites.
3. Tests can inject a `MockBlobStorageAdapter` that stores bytes in memory.

### Current state (Prompt 1)

The interface is defined. There is no concrete implementation yet — the stub comment in `storage.ts` notes "Replace this stub with real Vercel Blob or R2 implementation in v1.1."

### How to swap implementations

1. Create a new file, e.g. `convex/helpers/storage-r2.ts`, that implements `BlobStorageAdapter`.
2. Change the instantiation site (the Next.js API route that handles artifact upload) to use the new adapter.
3. Update `.env.example` with the new adapter's required environment variables.
4. No other files need to change.

---

## 6. API Route Design: Next.js / Convex Seam

The Next.js API routes are the **ingestion surface** — they are the entry point for SDK HTTP calls. They are not a general-purpose API. Browser-side UI reads go directly from React components to Convex using the Convex React SDK, bypassing Next.js entirely.

### Ingestion routes (SDK → Next.js → Convex)

```
POST   /api/runs                  Create a run (SDK startRun)
PATCH  /api/runs/[runId]/status   Update run status (SDK endRun/failRun)
POST   /api/events                Batch-append events (SDK flush)
POST   /api/artifacts             Register an artifact after blob upload
```

### Why Next.js API routes (not Convex HTTP actions)?

Convex does support HTTP actions as an alternative ingest path. We chose Next.js API routes for v1 because:

1. **Auth is unified:** The web app and the SDK use the same auth middleware. Adding a separate Convex HTTP endpoint would require duplicating auth logic.
2. **Middleware:** Next.js middleware (rate limiting, request logging, API key validation) is easier to apply at the route level than in Convex HTTP actions.
3. **Co-location:** Having the ingest routes in `apps/web` keeps the entire application in one deployable unit.

### Seam note

The Next.js API routes are a thin adapter layer. They:
1. Validate the auth token / API key
2. Parse and validate the request body (using Zod schemas from `packages/contracts`)
3. Call the appropriate Convex mutation
4. Return the Convex response as JSON

They do not contain business logic. Business logic lives in Convex mutations.

---

## 7. Why Convex (not a Traditional ORM)

We chose Convex over a traditional stack (Prisma + PostgreSQL, Drizzle + PlanetScale, etc.) for the following reasons:

**Real-time subscriptions (future):** Convex queries are reactive by default. When an event is written to the database, any browser that has an active `useQuery("events.listEvents", ...)` hook automatically receives the updated result without polling. This is table stakes for live run monitoring (v2 feature). Building this on a traditional ORM would require a separate WebSocket layer (Pusher, Ably, or custom).

**Built-in auth:** Convex integrates directly with Clerk via its `ConvexProviderWithClerk` pattern. The JWT is validated inside Convex, and `ctx.auth.getUserIdentity()` returns the decoded identity without any custom JWT middleware. This eliminates an entire class of auth bugs.

**Type-safe queries:** Convex generates TypeScript types from the schema. `ctx.db.insert("runs", { ... })` is type-checked against the schema at compile time. There are no SQL strings that escape the type system.

**No connection pooling:** Convex manages its own connection infrastructure. There is no `DATABASE_URL`, no connection pool configuration, no cold-start connection overhead. This simplifies deployment significantly.

**Trade-offs accepted:**
- Convex is a hosted service — vendor lock-in exists. Migrating away would require re-implementing queries and mutations using a different backend.
- Complex joins require multiple queries and in-memory assembly. Convex does not support SQL JOINs. For v1's data volumes, this is acceptable.
- The Convex document model limits document size to 1 MB. The payload externalization rule (>10 KB to blob storage) is partly motivated by staying safely below this limit.

---

## 8. Scalability Seams

The v1 architecture is a modular monolith. The following seams exist to allow evolution without a full rewrite:

### Ingest layer seam

The Next.js API routes (`/api/runs`, `/api/events`) are the seam between the SDK and the backend. When ingest volume grows beyond what a single Vercel function can handle:

1. Replace the Next.js API routes with a standalone ingest service (Node.js + Express, or a Cloudflare Worker).
2. The SDK's `HttpTransport` only needs its `endpoint` config updated — no SDK changes required.
3. The Convex backend remains unchanged.

This seam is already protected: the SDK is configured with an `endpoint` parameter rather than a hard-coded URL.

### Blob storage seam

As described in Section 5, the `BlobStorageAdapter` interface is the seam for swapping blob providers. Moving from Vercel Blob to R2 or S3 requires changing one file.

### Projection seam

`ReplayProjection` and `RunDiff` are currently computed on demand in the web app service layer. If run sizes grow to millions of events, these computations will become slow. The seam for this is:

1. Add a background Convex action that materializes projections into a `replay_snapshots` table.
2. The web app service layer checks for a cached snapshot first, falls back to live computation if not found.
3. No schema changes to the canonical `events` table required.

### Auth seam

The current auth model uses Clerk's organization as the tenancy boundary. If the product expands to support SSO, custom identity providers, or per-user API keys with fine-grained permissions:

1. The `getAuthContext()` helper in `convex/auth.ts` is the single seam. Changing the auth token extraction and org lookup logic here propagates to all queries and mutations automatically.
2. The `UserMembership` table already supports `admin`, `member`, `viewer` roles, giving a foundation for RBAC expansion.

---

## 9. What is a Modular Monolith and Why v1 Uses It

A modular monolith is a single deployable application with **internally enforced module boundaries**. It is contrasted with:

- A **big ball of mud**: one deployable, no enforced boundaries, code calls code arbitrarily.
- **Microservices**: multiple deployable services that communicate over the network.

Agent Flight Recorder is a modular monolith. There is one deployment target (Vercel + Convex), but the code is organized into packages with strict ownership rules:

```
packages/contracts  ← pure types, zero deps
packages/sdk        ← depends on: contracts
apps/web            ← depends on: contracts (not sdk)
convex/             ← depends on: contracts (not sdk, not web)
```

**Why modular monolith for v1:**

1. **Operational simplicity:** One `vercel deploy` command ships the entire application. No inter-service networking, no service discovery, no distributed tracing overhead.

2. **Type safety across the entire call graph:** Because all packages are in one pnpm workspace and share types from `packages/contracts`, TypeScript can catch type mismatches between the SDK's `CreateEventRequest` and the Convex mutation's `args` schema at build time — before any code runs.

3. **Team velocity:** The v1 team is small. Distributed architecture adds cognitive overhead and deployment complexity that is not justified until the system needs to scale beyond a single-region deployment.

4. **The seams exist for future extraction:** The `BlobStorageAdapter` interface, the SDK's injectable `Transport`, and the Next.js API route surface are all places where independent services could be inserted. When the time comes to extract the ingest layer, the boundary is clean.

**What "modular" means in practice:**
- The file ownership map in `CLAUDE.md` is the enforcement mechanism.
- No relative imports that escape a package boundary (ESLint enforces this).
- Each package has its own `tsconfig.json`, `package.json`, and can be independently built.
- Changing the contracts package requires updating all consumers in the same PR — this is what prevents type drift between services.
