# Agent Flight Recorder — Project Constitution

## Product Summary

Agent Flight Recorder (AFR) is a developer tool that records the complete execution of AI agents as immutable, structured event graphs and stores them for inspection, replay, and comparison. It is built for engineers who build and operate LLM-based agents and need to understand why a run succeeded or failed, how it has changed across versions, and what exactly the model did at each step. The core value proposition is turning opaque agent executions into auditable, debuggable records — giving teams the same kind of after-the-fact visibility into agent behavior that APM tools give for traditional services.

---

## Architecture Overview

AFR is a **modular monolith** managed with pnpm workspaces and Turbo. All packages live in one git repository. There is no runtime service mesh — packages share types through `@afr/contracts` and communicate at runtime through the Convex reactive backend.

```
Workspace packages:
  apps/web         — Next.js 15 frontend (App Router)
  packages/contracts — Shared TypeScript domain types (@afr/contracts)
  packages/sdk     — Recording SDK for agent authors (@afr/sdk)

Non-workspace:
  convex/          — Convex backend (schema, queries, mutations, actions)
```

**Key architectural principle: the event log is canonical.** Every agent execution produces a sequence of immutable events. The UI, replay engine, and diff viewer are all projections of the event log. No projection ever overwrites or backfills the event log.

---

## System Boundaries (clean seams to respect)

| Layer | Responsibility | Owned by |
|---|---|---|
| SDK (`@afr/sdk`) | Instrument agent code, batch events, POST to ingest endpoint | Team D |
| API Routes (`apps/web/app/api/`) | Validate, authenticate, write to Convex, offload blobs | Team C |
| Convex Functions | Persist events, enforce org-scoping, serve queries | Team B |
| Blob Storage (Vercel Blob) | Store externalized large payloads | Team B / infra |
| Web UI (`apps/web/app/`) | Render runs, events, diffs, replays — read-only projections | Team C |
| `@afr/contracts` | Type definitions shared across all layers | Team B |

**Rules:**
- SDK only talks to the API ingest endpoint — never directly to Convex.
- API routes validate and authenticate, then delegate to Convex mutations. They contain no business logic.
- Convex functions must always filter by `orgId` — never expose cross-org data.
- Blob storage is only accessed from API routes or Convex actions, never from the browser directly.

---

## Core Entities

| Entity | Description |
|---|---|
| **Organization** | Top-level tenancy unit. Maps 1:1 to a Clerk organization. All data is scoped to an org. |
| **User** | A Clerk user who is a member of one or more organizations. Role is per-org (owner / admin / member). |
| **Project** | A logical grouping of agents within an org. Used for navigation and filtering. |
| **Agent** | A named agent within a project. Has many versions over time. |
| **AgentVersion** | A snapshot of an agent's configuration: model, system prompt, tools, parameters. Immutable once created. |
| **Run** | One execution of an agent. Has a status lifecycle (pending → running → completed | failed). Contains input, output, and error. |
| **Event** | An atomic, immutable record of something that happened during a run. Has a kind, a sequence number, a payload, and optional parent-seq for tree structure. Append-only. |
| **Artifact** | A pointer to a blob-stored payload that was too large to inline in an Event. Linked to an Event by `eventId`. |
| **Comment** | A human annotation attached to a run or a specific event. Used for post-mortem collaboration. |

---

## Event Log Rules (THE most important section)

1. **Events are append-only.** Once written, an event is never mutated or deleted. Period.
2. **Sequence numbers are monotonically increasing per run.** `seq` starts at 1 and increments by 1. Gaps are not allowed.
3. **Large payloads are externalized to blob storage.** If a payload exceeds `AFR_PAYLOAD_SIZE_THRESHOLD_BYTES` (default 8 KB), it is written to blob storage and an Artifact record is created. The event stores `payloadExternalized: true` and `artifactId` pointing to the blob. The event payload field itself stores a small summary or is null.
4. **The log is the truth.** The `runs` table is a projection (status, counts, summary). If it is ever inconsistent with events, the events win.
5. **Replay is a read-only operation.** Replaying a run never writes new events. It reads the existing event sequence and simulates execution.
6. **Diff is a read-only comparison.** Diffing two runs never writes new events.
7. **No event kind may be added or renamed without an ADR** (Architecture Decision Record in `docs/adrs/`).

---

## Tenancy Rules

- **Organization is the tenancy boundary.** Users belong to organizations. All agent, run, and event data belongs to an organization.
- **Every Convex query and mutation MUST filter by `orgId`.** This is not optional. Never write a Convex function that returns data without scoping it to an org.
- **Never return data across organization boundaries.** Even internal/admin queries must not mix org data.
- **Clerk organization = Convex orgId.** When a user is authenticated, their `orgId` comes from Clerk's organization claim in the JWT. Convex auth helpers extract this and enforce it.
- **Users can belong to multiple organizations**, but each session operates within one active organization at a time (set by Clerk's `active organization` concept).
- **Roles are per-org**: owner, admin, member. RBAC beyond these three roles is out of scope for v1.

---

## Design Quality Rules

The UI must be calm, technical, and high-signal. AFR is a developer tool used under stress (debugging failures). These rules are non-negotiable:

1. **Strong typographic hierarchy.** Use size, weight, and color to guide the eye — not decoration.
2. **Tight spacing discipline.** Dense layouts are appropriate; engineer tools are not marketing pages.
3. **No decorative noise.** No gradients, no hero illustrations, no motion that does not convey information.
4. **No generic dashboard clutter.** Do not add charts or widgets just because they are easy. Every element earns its place.
5. **Always show loading, empty, and error states.** Every data-fetching component must handle all three. There must be no blank white screens.
6. **Error states must be actionable.** Don't just show "something went wrong" — show what failed and what the user can do.
7. **Loading states must not cause layout shift.** Use skeleton screens that match the shape of the real content.

---

## Repo Conventions

- **All internal imports use package names** — `@afr/contracts`, `@afr/sdk`. Never use relative `../../` paths across package boundaries.
- **No circular dependencies** between packages. The dependency graph is: `@afr/contracts` ← `@afr/sdk` ← `apps/web`. `convex/` imports from `@afr/contracts` only.
- **`@afr/contracts` imports from nothing else in this repo.** It is the leaf package. If you find yourself importing from `@afr/sdk` or `apps/web` inside `contracts/`, stop.
- **Use `workspace:*` for internal deps** in `package.json` files (e.g., `"@afr/contracts": "workspace:*"`).
- **No `any` types in production code.** The ESLint rule `@typescript-eslint/no-explicit-any` is set to `error`. Use `unknown` and narrow.
- **TypeScript strict mode is on** everywhere. `noUncheckedIndexedAccess`, `noImplicitReturns`, and `strictNullChecks` are all enabled.
- **Convex auto-generated files** (`convex/_generated/`) are gitignored and must not be edited by hand.

---

## Rules for Future Prompts

These rules govern what future Claude agents working on this repo MUST NOT do without explicit human review:

- **DO NOT mutate the event schema** (`Event`, `EventKind`) without creating an ADR in `docs/adrs/` first.
- **DO NOT add new workspace packages** without updating `turbo.json` and `pnpm-workspace.yaml`, and announcing in `docs/build_log.md`.
- **DO NOT bypass org-scoping** in Convex queries. Every query must have a `where` or `filter` on `orgId`.
- **DO NOT implement business logic in API route handlers** — handlers validate, authenticate, and delegate. Business logic lives in service modules or Convex mutations.
- **DO NOT add analytics, marketplace, or orchestration features.** They are explicitly out of scope for v1 (see `docs/product_spec.md`).
- **DO NOT make the SDK depend on Node.js built-ins** that don't exist in edge runtimes if the SDK is expected to run in edge environments.
- **DO NOT store secrets** (API keys, tokens) in the database or event payloads. If a payload contains a secret, that is a bug in the agent code, not something AFR should handle.
- **DO NOT add new event kinds without updating the `EventKind` union in `@afr/contracts`** and all switch statements that enumerate event kinds.

---

## What Is NOT Built in v1

Be explicit about scope to avoid scope creep:

- **Real replay execution engine** — replay in v1 is a UI walkthrough of the event sequence, not re-running the agent.
- **Real diff computation logic** — diff in v1 is a structural comparison of two run event sequences; it does not execute anything.
- **Production ingestion pipeline** — ingest in v1 is a synchronous Next.js API route. A queue/stream layer (e.g., Upstash QStash, Kafka) may be added later without breaking the SDK.
- **Multi-region or distributed storage** — single Convex deployment, single blob storage region.
- **Analytics or usage tracking** — no product analytics (PostHog, Amplitude, etc.) in v1.
- **Marketplace or agent registry** — no public directory of agents or sharing across organizations.
- **Policy engine or RBAC beyond owner/admin/member** — no attribute-based access control, no custom roles.
- **Real-time collaboration features** — comments are async; no live cursors, no operational transform.
- **Alerting or notifications** — no email/Slack/webhook on run failure in v1.

---

## Package Ownership

| Package | Owns | Team |
|---|---|---|
| `apps/web` | Next.js frontend: pages, components, API routes, layout | Team C |
| `packages/contracts` | All shared domain TypeScript types and enums | Team B |
| `packages/sdk` | SDK for recording agent executions | Team D |
| `convex/` | Schema, queries, mutations, actions, auth helpers | Team B |
| `scripts/` | Build validation, seed data, utility scripts | Team A (Platform) |
| `.github/`, `turbo.json`, root configs | CI, workspace config, build tooling | Team A (Platform) |
| `docs/` | Architecture docs, ADRs, product spec | Team A (Platform) + all teams |
