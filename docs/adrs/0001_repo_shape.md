# ADR-0001: Repository Shape — Modular Monolith in a Single pnpm Workspace

**Status:** Accepted
**Date:** 2026-04-09
**Deciders:** Initial foundation team (Prompt 1)

---

## Context

Agent Flight Recorder needs a repository structure that supports rapid v1 development while preserving the ability to evolve the architecture as scale demands increase.

The primary tension: clean separation of concerns vs. operational complexity.

The system has at least four distinct logical components:

1. A **web application** (Next.js) that serves the UI and the SDK ingestion endpoint
2. A **backend** (Convex) that stores data and executes queries/mutations
3. A **shared type library** (contracts) that both the web app and the SDK depend on
4. A **client SDK** (TypeScript npm package) that runs in customer code

Key constraints:
- Small team building v1
- SDK must remain stable even if backend architecture changes
- Convex, Clerk, and Vercel are required stack components
- Need to share types between web app, backend, and SDK without a publish cycle

### Option A: Multiple repositories (polyrepo)
Each component in its own git repository. The contracts package is published to npm, the SDK depends on it, the web app depends on it.

### Option B: Monorepo with separate services
All components in one repository, but the web app and the SDK ingest service are deployed as separate processes.

### Option C: Modular monolith in a single pnpm workspace (CHOSEN)
All components in one repository with a single deployment unit (Vercel for the web app, Convex for the backend). Module boundaries are enforced by convention and ESLint, not by process boundaries.

---

## Decision

**Modular monolith in a single pnpm workspace** with Turborepo as the build orchestrator.

Repository shape:
```
apps/web           — Next.js web application (UI + SDK ingestion API routes)
packages/contracts — Shared TypeScript types (no runtime deps)
packages/sdk       — Client recording SDK
convex/            — Backend schema, queries, mutations
docs/              — Project memory and specifications
tests/             — Cross-package tests and fixtures
scripts/           — Build and development utilities (validate.sh, seed.ts)
.claude/agents/    — Claude subagent definitions
```

All packages live in one repository. There are no separate services, no separate deployments for backend vs. frontend.

Deployment topology:
- `apps/web` deploys to Vercel (single Next.js app, one command)
- `convex/` deploys to Convex via `npx convex deploy`
- `packages/sdk` publishes to npm independently (separate versioning)

---

## Rationale

1. **Velocity**: A single repository enables co-evolution of types, backend, and UI without cross-repo coordination overhead. Changing a contract type propagates to all consumers immediately — no publish, no version bump, no consumer PR.

2. **Type safety across the full call graph**: `packages/contracts` is a direct workspace dependency of all packages. TypeScript errors surface immediately when contracts change. The SDK's `CreateEventRequest` is type-checked against the Convex mutation's `args` schema at build time.

3. **Deployment simplicity**: Vercel deploys `apps/web`. Convex deploys its own backend. No additional infrastructure to manage, monitor, or scale independently at v1.

4. **Seams exist for future extraction**: The SDK is already a separate package with an injectable `Transport` interface. If a standalone ingestion service becomes necessary, the Next.js API route boundary (`apps/web/src/app/api/`) can be extracted to a separate service without changing the SDK's `endpoint` config or the Convex schema.

5. **Appropriate for v1 scale**: The operational overhead of microservices (service discovery, inter-service auth, distributed tracing, independent deployments) does not pay off until there are clear service boundaries driven by real scale, team size, or independent deployment cadence needs.

---

## Consequences

### Positive

- Single `pnpm install` sets up all packages
- Single `vercel deploy` ships the entire web application
- Type changes propagate immediately — no publish cycle during iteration
- All packages share one `node_modules`, reducing disk use and version conflicts
- Unified lint, typecheck, and test pass/fail signal in CI

### Negative

- The SDK is co-located with the app but must be independently publishable to npm. Care required to maintain the SDK's package version separately from the monorepo root version.
- Convex deployment (`npx convex deploy`) is separate from Vercel deployment. Two deploy steps required for a full release. A release script should coordinate them.
- As the team grows, the monorepo will require more governance (code ownership, PR routing, merge queue) compared to separate repositories where team boundaries are enforced by repo access.

### Future extraction path

When the time comes to extract the ingest layer as a standalone service:
1. Create a new package (or separate repo) for the ingest service
2. Move `apps/web/src/app/api/runs/route.ts` and `apps/web/src/app/api/events/route.ts` to the new service
3. Update the SDK's `endpoint` config to point to the new service URL
4. `packages/contracts` API types remain unchanged — no SDK changes required

---

## Alternatives Considered

### Option A: Next.js + separate Convex service
Convex can be called directly from Next.js (as it is here) or it can serve as a standalone backend with its own HTTP endpoints. Using Convex HTTP actions as the ingest surface was considered but rejected: it would require duplicating auth middleware and would make it harder to add custom rate limiting and request logging at the API layer. The Next.js API route layer provides a clean place for this logic.

### Option B: Next.js + Express API + separate DB
Running a separate Express service for the high-throughput ingest path was considered but rejected for v1. Adds infrastructure management burden (auth, DB, ORM, connection pooling) that Convex eliminates. The seam for extracting to Express exists when needed.

### Option C: Microservices from day one
Rejected. Microservices add distributed systems complexity (service discovery, inter-service auth, distributed tracing, independent deployments) that is not justified for a v1 product with one team and unproven scale requirements. Service boundaries should emerge from real scaling problems, not be assumed upfront.
