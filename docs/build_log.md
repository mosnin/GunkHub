# Build Log — Agent Flight Recorder

## Session: Foundation Build (April 2026)

**Team:** Team A — Platform
**Date:** April 9, 2026
**Scope:** Repository foundation — workspace config, documentation, scripts, CI, agent definitions

---

## Architecture Decisions Made

### 1. Modular Monolith with pnpm Workspaces

**Decision:** One git repository, three workspace packages (`apps/web`, `packages/contracts`, `packages/sdk`), plus a non-workspace Convex directory.

**Rationale:** The three packages share types intensively (`@afr/contracts` is used by all of them). A monorepo eliminates the friction of publishing internal packages, makes cross-package refactors atomic, and keeps CI simple. At this team size (small, < 10 engineers), the operational complexity of a polyrepo is not justified.

**Convex is deliberately excluded from the workspace** because Convex CLI manages its own dependencies and build process. Treating it as a workspace package would require fighting the Convex tooling.

**Risk:** As the repository grows, Turbo build times will increase. This is acceptable — Turbo's caching mitigates it.

ADR: `docs/adrs/0001_repo_shape.md`

---

### 2. Event Log as Canonical Source of Truth

**Decision:** The events table in Convex is append-only and immutable. The runs table is a mutable projection. No query or mutation may delete or update an event record.

**Rationale:** AI agent behavior is inherently temporal and causal — the event graph is the only complete representation of what happened. Mutable records would allow the "audit trail" to be silently corrupted. Append-only immutability is a hard constraint that eliminates entire categories of data integrity bugs.

**Consequence:** The runs table (status, eventCount, output) may momentarily be out of sync with the event log during high-throughput ingestion. This is acceptable — eventual consistency is fine for the projection, and the event log remains the truth.

ADR: `docs/adrs/0002_event_log_is_canonical.md`

---

### 3. Organization as Tenancy Boundary

**Decision:** `orgId` is the tenancy boundary. Every Convex function must filter by `orgId`. Clerk organizations map 1:1 to Convex orgIds.

**Rationale:** Multi-tenancy at the organization level is the standard for B2B SaaS. Users belong to one or more organizations and can switch between them. Clerk has native support for this, including JWT claims with `org_id`. Using Clerk organizations as the source of truth avoids maintaining a parallel membership system.

**Consequence:** Users without an active Clerk organization cannot access any data in AFR. The UI must handle this gracefully with an onboarding flow.

ADR: `docs/adrs/0003_tenancy_boundary.md`

---

### 4. Shared Contracts Package

**Decision:** `@afr/contracts` is a leaf package that exports all domain types, enums, and validation schemas. It imports from nothing else in the repo.

**Rationale:** Without a shared contracts package, type definitions would be duplicated across the SDK, web app, and Convex functions — leading to silent divergence. The contracts package is the single source of type truth. Making it a leaf (no internal dependencies) prevents circular dependency chains.

**Consequence:** Any new domain type must be added to `@afr/contracts` first. This is a small ceremony that pays for itself in type safety.

ADR: `docs/adrs/0004_shared_contracts_package.md`

---

## Stack Choices and Rationale

| Choice | Rationale |
|---|---|
| **Next.js 15** | App Router for server components + API routes in one deployment. Edge functions for low-latency ingestion. |
| **TypeScript 5.5 strict** | `noUncheckedIndexedAccess` and strict null checks eliminate runtime nullability errors. Non-negotiable for a debugging tool that must be trustworthy. |
| **Tailwind CSS 3** | Utility-first CSS is fast for building dense technical UIs. No component library lock-in. |
| **Convex** | Reactive backend with TypeScript-native client, built-in real-time subscriptions, and zero-config database. Eliminates connection pooling and migration complexity for a small team. |
| **Clerk** | Multi-tenant organization support, JWT with org claims, zero auth infrastructure. |
| **pnpm 9** | Strict dependency isolation, fast installs, native workspaces. |
| **Turbo 2** | Incremental builds, task caching, parallel execution across packages. |
| **Vercel Blob** | Zero-config blob storage for Vercel deployments. Swap path to S3/R2 is one module. |

---

## What Was Built

This session built the structural skeleton of the repository. No application logic was written.

**Configuration files:**
- `package.json` (root, workspace scripts)
- `pnpm-workspace.yaml`
- `turbo.json` (build pipeline)
- `tsconfig.json` (root, strict)
- `.eslintrc.js` (TypeScript strict rules)
- `.prettierrc`
- `.gitignore`
- `.env.example`

**CI/CD:**
- `.github/workflows/ci.yml` (typecheck + lint + build + test on push/PR)

**Scripts:**
- `scripts/validate-build.sh` (per-package validation with summary)
- `scripts/seed.ts` (typed fixture data for local development)

**Documentation:**
- `CLAUDE.md` (project constitution — most important doc)
- `README.md`
- `docs/product_spec.md`
- `docs/product_model.md`
- `docs/architecture.md`
- `docs/working_memory.md`
- `docs/build_log.md` (this file)
- `docs/next_steps.md`
- `docs/adrs/0001_repo_shape.md`
- `docs/adrs/0002_event_log_is_canonical.md`
- `docs/adrs/0003_tenancy_boundary.md`
- `docs/adrs/0004_shared_contracts_package.md`

**Claude subagent definitions:**
- `.claude/agents/platform.md`
- `.claude/agents/data.md`
- `.claude/agents/ui.md`
- `.claude/agents/sdk_quality.md`

---

## What Was Intentionally Deferred

| Item | Reason for Deferral |
|---|---|
| `packages/contracts/` source | Requires type design review with Team B; types are tightly coupled to Convex schema |
| `packages/sdk/` source | Requires contracts types to be stable; SDK API design needs Team D input |
| `apps/web/` scaffold | Requires contracts and Convex schema to be in place |
| `convex/schema.ts` | Requires contracts types; schema design is the core of Prompt 2 |
| Ingest API route | Depends on Convex schema and contracts |
| UI components | Depends on full page/data architecture |
| Zod validation schemas | Will be co-located with contracts types in Prompt 2 |
| API key management | Out of scope for foundation; needed before SDK can authenticate |
| pnpm lockfile | Cannot be generated in this session; first developer must run `pnpm install` |

---

## Risks Identified

### Risk 1: Convex Document Size and Query Limits
**Description:** Convex has a 1 MB document size limit and limits on the number of documents a single query can return. Large event payloads and high-event-count runs could hit these limits.
**Mitigation:** Payload externalization (documented in architecture). Event list queries use pagination (`take(50)`). The SDK caps batch size at 50 events.
**Residual risk:** A single event with a very large inline payload (e.g., an LLM response with extremely long messages) could still hit the limit if the payload size check has an edge case.

### Risk 2: Convex Cold Start on Ingest
**Description:** Convex function cold starts can add latency to the first ingest request after a period of inactivity.
**Mitigation:** Not mitigated in v1. This is acceptable for a debugging tool used by engineers during active development. Production SLA is not a v1 requirement.

### Risk 3: Event Ordering Guarantee from SDK
**Description:** The SDK assigns sequence numbers client-side. If the SDK runs in a distributed environment (multiple instances), sequence numbers could collide or arrive out of order.
**Mitigation:** In v1, sequence numbers are assigned by the SDK per-run, and runs are single-tenant (one SDK instance per run). The ingest mutation validates contiguity but does not enforce strict ordering across instances. Multi-instance SDK scenarios are explicitly out of scope for v1.

### Risk 4: Clerk JWT Expiry During Long Runs
**Description:** An agent run that takes longer than the Clerk JWT expiry (typically 1 hour) will fail to authenticate when the SDK tries to flush events near the end of the run.
**Mitigation:** The SDK should not use Clerk session tokens directly. It should use long-lived API keys (out of scope for this session, flagged as a decision point in `working_memory.md`).

### Risk 5: Blob Storage Availability During Ingest
**Description:** If Vercel Blob is unavailable when the ingest route tries to externalize a large payload, the entire ingest request will fail and events will be lost.
**Mitigation:** Not mitigated in v1. The ingest route is synchronous — blob write is in the critical path. Adding a retry queue (Prompt 2 consideration) would isolate blob failures from event loss.

### Risk 6: Schema Migration Complexity
**Description:** Convex does not support SQL-style migrations. Schema changes require careful handling of existing data.
**Mitigation:** The contracts package and ADR process gate schema changes. New fields should be optional (`?`) when first introduced. Breaking changes require a coordinated migration plan.

---

## Open Questions

1. **API key management UI:** Where does an engineer create an AFR API key for their agent? This needs a settings page and a Convex table (`apiKeys`). Not designed yet.
2. **Run pre-registration vs. upsert:** See Decision 5 in `working_memory.md`.
3. **Replay mechanism:** v1 replay is a UI walkthrough. What does the replay state machine look like in the frontend?
4. **Diff algorithm:** What algorithm is used to align events from two runs for comparison? By sequence? By kind+index? This needs a decision before the diff viewer is built.
5. **Maximum run retention:** How long are runs kept? No retention policy is defined in v1. This needs to be addressed before launch.
