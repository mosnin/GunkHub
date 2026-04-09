# Architecture — Agent Flight Recorder

## System Diagram (ASCII)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Agent Author's Infrastructure                                              │
│                                                                             │
│   ┌──────────────────────────────────┐                                      │
│   │   Agent Code (any runtime)       │                                      │
│   │   + @afr/sdk (npm package)       │                                      │
│   │                                  │                                      │
│   │   FlightRecorder.record(() => {  │                                      │
│   │     // agent execution           │                                      │
│   │   })                             │                                      │
│   └──────────────┬───────────────────┘                                      │
│                  │ HTTPS POST /api/ingest/events                            │
│                  │ (batched, authenticated with AFR_API_KEY)                │
└──────────────────┼──────────────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Vercel (apps/web)                                                          │
│                                                                             │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  Next.js API Route: POST /api/ingest/events                          │  │
│   │                                                                      │  │
│   │  1. Parse + validate request body (Zod)                              │  │
│   │  2. Authenticate: verify Clerk session or API key                    │  │
│   │  3. Extract orgId from Clerk JWT or API key record                   │  │
│   │  4. For each event payload > threshold:                              │  │
│   │     → Write to Vercel Blob                                           │  │
│   │     → Create Artifact record in Convex                               │  │
│   │  5. Call Convex mutation: ingestEvents(orgId, runId, events[])       │  │
│   └────────────────────────┬─────────────────────────────────────────────┘  │
│                            │                                                │
│   ┌────────────────────────▼─────────────────────────────────────────────┐  │
│   │  Next.js Pages (App Router)                                          │  │
│   │  /dashboard, /runs/[runId], /runs/[runId]/replay,                    │  │
│   │  /runs/compare?a=[id]&b=[id]                                         │  │
│   │                                                                      │  │
│   │  Client components → useQuery(api.runs.list, { orgId })              │  │
│   │  Server components → fetchQuery(api.runs.get, { orgId, runId })      │  │
│   └────────────────────────┬─────────────────────────────────────────────┘  │
└────────────────────────────┼────────────────────────────────────────────────┘
                             │ Convex client (WebSocket / HTTP)
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Convex Cloud                                                               │
│                                                                             │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  Auth middleware (reads Clerk JWT → extracts orgId, userId, role)    │  │
│   └────────────────────────┬─────────────────────────────────────────────┘  │
│                            │                                                │
│   ┌────────────────────────▼─────────────────────────────────────────────┐  │
│   │  Mutations                       Queries                             │  │
│   │  ─────────────────               ──────────────────                 │  │
│   │  ingestEvents                    runs.list (org-scoped)              │  │
│   │  createRun                       runs.get (org-scoped)               │  │
│   │  createProject                   events.listForRun (org-scoped)      │  │
│   │  createAgent                     events.get (org-scoped)             │  │
│   │  upsertAgentVersion              artifacts.getForEvent               │  │
│   │  addComment                      comments.listForRun                 │  │
│   │  resolveComment                  projects.list (org-scoped)          │  │
│   └────────────────────────┬─────────────────────────────────────────────┘  │
│                            │                                                │
│   ┌────────────────────────▼─────────────────────────────────────────────┐  │
│   │  Database Tables                                                     │  │
│   │  organizations, projects, agents, agentVersions,                     │  │
│   │  runs, events (append-only), artifacts, comments                    │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                             │
                             │ blob URL fetched on demand
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Vercel Blob Storage                                                        │
│                                                                             │
│   Large event payloads stored at:                                           │
│   afr/{orgId}/{runId}/{eventId}-payload.json                                │
│                                                                             │
│   Accessed via short-lived signed URLs (Vercel Blob managed)               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Choices and Rationale

### Next.js 15 (App Router)

- **Why:** App Router enables server components for fast initial load and clean co-location of API routes with the UI. The `/api/ingest/events` route benefits from Edge Runtime for low latency.
- **Trade-off:** App Router is more complex than Pages Router; the team needs to understand server/client component boundaries.

### Convex

- **Why:** Convex provides a reactive, strongly-typed backend with real-time subscriptions. The Convex TypeScript client generates types from the schema, eliminating a whole class of type mismatch bugs. The document model maps naturally to the event log structure.
- **Why not Postgres + Prisma:** Postgres would require separate connection pooling, a migrations workflow, and a query layer. Convex removes all of that friction for a small team moving fast.
- **Trade-off:** Convex's document model is less suitable for complex relational queries. For v1's read patterns (fetch events for a run, list runs by org), it is well-suited.

### Clerk

- **Why:** Clerk provides first-class multi-tenant organization support, including organization membership, roles, and JWT claims. This eliminates building auth from scratch.
- **Why not NextAuth / Auth.js:** Auth.js does not have native organization-level multi-tenancy. Building it would require significant custom work.
- **Integration:** Clerk issues JWTs with organization claims. Convex verifies these JWTs via a configured JWT issuer. The `orgId` is extracted from the JWT and enforced in every Convex function.

### pnpm Workspaces + Turbo

- **Why pnpm:** Strict dependency isolation, fast installs, native workspace support, and compatibility with all major tools.
- **Why Turbo:** Incremental builds and task caching across packages. The build pipeline (`contracts` → `sdk` → `web`) is expressed as a DAG in `turbo.json`.
- **Trade-off:** Turbo adds a layer of indirection; engineers need to understand which tasks run in which order.

### Vercel Blob

- **Why:** Native integration with Vercel deployment. No separate storage infrastructure to manage in v1.
- **Why not S3:** S3 is the right long-term answer, but it requires IAM, bucket policies, and more configuration. Vercel Blob is zero-config for a Vercel-hosted app.
- **Swap path:** The blob storage layer is isolated to the API ingest route. Replacing it with S3/R2 requires changing one module, not the entire system.

### TypeScript 5.5 Strict

- **Why:** `noUncheckedIndexedAccess`, `noImplicitReturns`, and `strictNullChecks` eliminate entire categories of runtime errors. The agent debugging domain requires high reliability.
- **Trade-off:** Strict mode increases development friction. Engineers must handle more nullability cases explicitly. This is the correct trade-off for a tool that must be trustworthy.

---

## Data Flow: SDK → API → Convex → Blob

### Ingestion (Write Path)

```
1. SDK instruments agent execution
   - On run start: creates a FlightRecorder instance with runId
   - On each agent step: emits an Event object (kind, payload, seq)
   - Batches events up to 50 or until run ends

2. SDK flushes batch to POST /api/ingest/events
   - Body: { runId, orgId, events: Event[] }
   - Auth: Bearer token (AFR API key, scoped to org)

3. API route: /api/ingest/events
   a. Parse body with Zod schema from @afr/contracts
   b. Verify Bearer token → resolve orgId
   c. For each event where sizeof(payload) > threshold:
      - Serialize payload to JSON
      - PUT to Vercel Blob: afr/{orgId}/{runId}/{eventId}-payload.json
      - Create Artifact record: { orgId, runId, eventId, blobUrl, sizeBytes }
      - Replace payload with payloadSummary, set payloadExternalized: true
   d. Call Convex mutation: ctx.runMutation(api.events.ingest, { orgId, runId, events })

4. Convex mutation: events.ingest
   a. Verify run exists and belongs to orgId
   b. Fetch current maxSeq for this run
   c. Validate events are contiguous from maxSeq+1
   d. Insert all events in a single Convex transaction (atomic)
   e. Update runs.eventCount, runs.updatedAt
   f. If any event.kind === "run.finished": update runs.status, runs.completedAt
```

### Read Path (Web UI)

```
1. User navigates to /runs/[runId]
2. Next.js server component calls: fetchQuery(api.runs.get, { orgId, runId })
   - orgId extracted from Clerk session (server-side)
   - Convex verifies orgId matches run.orgId
3. Component renders run metadata (status, agent, timestamps)
4. Client component subscribes: useQuery(api.events.listForRun, { orgId, runId })
   - Real-time subscription — updates live if more events arrive
5. For any event with payloadExternalized: true:
   - UI fetches: useQuery(api.artifacts.getForEvent, { orgId, eventId })
   - Gets blob URL from artifact record
   - Client fetches blob JSON directly from Vercel Blob CDN
```

---

## Auth Flow: Clerk → Convex

```
1. User signs in via Clerk (email, Google, etc.)
2. Clerk issues a session JWT containing:
   - sub: userId
   - org_id: active organization ID
   - org_role: owner | admin | member
   - iss: https://your-domain.clerk.accounts.dev

3. Browser → Convex: every query/mutation includes the JWT in the Authorization header

4. Convex Auth Middleware:
   - Verifies JWT signature against Clerk's JWKS endpoint
   - Extracts orgId, userId, role from claims
   - Makes these available as ctx.auth in all Convex functions

5. Every Convex function that accesses org-scoped data:
   const identity = await ctx.auth.getUserIdentity();
   if (!identity) throw new Error("Unauthenticated");
   const orgId = identity.orgId; // from JWT claim
   // All queries filter by orgId

6. API routes (server-side):
   - Use Clerk's auth() helper to extract the session
   - Validate orgId matches the resource being accessed
   - Pass orgId to Convex mutations via the Convex HTTP client
```

---

## Query Path: Web → Convex

```
Browser (React Client Component)
  │
  │ useQuery(api.runs.list, { orgId, projectId, status, limit })
  │ → Convex WebSocket subscription (real-time)
  │
  ▼
Convex Query: runs.list
  ├── Verify auth (ctx.auth.getUserIdentity())
  ├── Assert identity.orgId === args.orgId
  ├── db.query("runs")
  │     .withIndex("by_org_project", q => q.eq("orgId", args.orgId).eq("projectId", args.projectId))
  │     .filter(q => args.status ? q.eq(q.field("status"), args.status) : true)
  │     .order("desc")
  │     .take(args.limit ?? 50)
  └── Return runs[]
  
Browser (Next.js Server Component)
  │
  │ fetchQuery(api.runs.get, { orgId, runId })
  │ → Convex HTTP query (one-time fetch, not subscription)
  │
  ▼
Convex Query: runs.get
  ├── Verify auth
  ├── Assert orgId
  ├── db.get(runId)
  ├── Assert result.orgId === orgId
  └── Return run
```

---

## Future Ingest Evolution Path

The current synchronous ingest (SDK → API Route → Convex) is sufficient for v1. It has a single point of failure: if the API route is slow or the Convex mutation fails, the SDK either blocks or drops events.

The SDK is designed so that **adding a queue layer does not require SDK changes**.

### Evolution Path

**Phase 1 (v1): Synchronous ingest**
```
SDK → POST /api/ingest/events → Convex mutation (synchronous)
```

**Phase 2: Queue-backed ingest (no SDK change required)**
```
SDK → POST /api/ingest/events → Enqueue to QStash / SQS
                              (returns 202 immediately)
                  ↓
QStash → POST /api/ingest/worker → Convex mutation
```
The SDK only sees `POST /api/ingest/events` → `202 Accepted`. The internal routing to a queue is transparent.

**Phase 3: Streaming ingest (no SDK change required)**
```
SDK → HTTP streaming to Kafka / Kinesis producer endpoint
    → Consumer writes to Convex in order
```
The SDK's `FlightRecorder` API accepts an optional `transport` parameter. The default transport is HTTP POST. A streaming transport can be injected without changing the recording API.

**Key invariant:** The SDK's public API (`FlightRecorder`, `EventKind`, event payload shapes) is versioned. The ingest endpoint URL is configurable (`AFR_INGEST_URL`). The queue/stream layer lives entirely between the API endpoint and Convex — invisible to SDK users.

---

## Deployment Architecture

```
┌─────────────────────┐     ┌───────────────────────────┐
│  Vercel              │     │  Convex Cloud              │
│                      │     │                            │
│  apps/web            │────▶│  convex/ functions         │
│  (Next.js)           │     │  (schema, queries,         │
│  - Static assets CDN │     │   mutations, actions)      │
│  - Edge Functions    │     │                            │
│    (API routes)      │     │  Managed database          │
│  - Node.js runtime   │     │  (built-in, no config)     │
│    (server           │     │                            │
│     components)      │     │  Real-time subscriptions   │
│                      │     │  (WebSocket)               │
└─────────────────────┘     └───────────────────────────┘
          │                              │
          ▼                              │
┌─────────────────────┐                  │
│  Vercel Blob         │                  │
│  (large payload      │◀────────────────┘
│   storage)           │   (artifact URLs referenced
│                      │    in Convex artifact records)
└─────────────────────┘

┌─────────────────────┐
│  Clerk               │
│  (auth + org mgmt)   │
│                      │
│  JWT issuance        │────▶ Convex JWT verification
│  User management     │────▶ Next.js auth() helper
│  Org membership      │
└─────────────────────┘
```

### Deployment Steps

1. **Convex:** `npx convex deploy` — pushes schema and functions to Convex Cloud, returns the deployment URL.
2. **Vercel:** Connect the repo to Vercel, set env variables, deploy `apps/web`. Vercel auto-detects Next.js.
3. **Environment variables:** Set in Vercel dashboard and Convex dashboard respectively (see `.env.example`).
4. **Clerk:** Configure Clerk application, add the Convex JWT template, set JWKS endpoint in Convex auth config.

### No Self-Hosting in v1

v1 targets fully managed infrastructure: Vercel (compute + blob), Convex (database + functions), Clerk (auth). Self-hosting any component is out of scope and is not tested.
