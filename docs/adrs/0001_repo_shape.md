# ADR 0001: Modular Monolith with pnpm Workspaces and Turborepo

**Status:** Accepted
**Date:** April 2026
**Deciders:** Team A (Platform)

---

## Context

Agent Flight Recorder has three distinct software artifacts that must work together:

1. **A web application** (Next.js) — the user-facing UI and API routes
2. **A recording SDK** (TypeScript library) — instrumentation for agent code
3. **A shared type layer** — domain types used by both the SDK and the web app

These three artifacts share types heavily. The SDK and the web app must agree on the shape of an `Event`, the values of `EventKind`, and the structure of ingest request bodies. Without coordination, these definitions will silently diverge.

We need to decide: **polyrepo or monorepo, and how to structure it?**

---

## Decision

We will use a **modular monolith** — a single git repository containing all packages, managed by **pnpm workspaces** for dependency management and **Turborepo** for task orchestration.

The workspace packages are:
- `apps/web` — Next.js 15 web application
- `packages/contracts` — Shared TypeScript types (`@afr/contracts`)
- `packages/sdk` — Recording SDK (`@afr/sdk`)

The Convex backend directory (`convex/`) is in the same repository but is **not** a pnpm workspace package. It is managed directly by the Convex CLI.

---

## Alternatives Considered

### Option A: Polyrepo (separate git repos)

Three repositories: `afr-web`, `afr-sdk`, `afr-contracts`.

**Rejected because:**
- Publishing `@afr/contracts` to a registry (even a private one) adds ceremony for every type change
- Cross-package refactors require coordinated PRs across repos
- Local development requires linking packages with `pnpm link` or similar — fragile
- CI must be orchestrated across repos to prevent breaking the integration

### Option B: Monorepo without Turbo (plain pnpm workspaces)

Use pnpm workspaces for dependency management but no task orchestration.

**Rejected because:**
- Without Turbo, running `pnpm build` in the root does not respect the dependency order: `contracts` must be built before `sdk`, which must be built before `web`
- CI would need to hardcode the build order in shell scripts
- No task caching — every CI run rebuilds everything from scratch

### Option C: Nx instead of Turbo

Use Nx for task orchestration instead of Turbo.

**Considered but not chosen because:**
- Nx has a steeper learning curve and more configuration overhead
- Turbo covers all required task orchestration use cases (dependency order, caching, parallel execution) with minimal configuration
- Turbo is simpler to onboard new engineers to

---

## Consequences

### Positive

- **Single source of type truth:** `@afr/contracts` is in the same repo; type changes are atomic across all consumers.
- **Atomic cross-package changes:** A PR can change `@afr/contracts`, `@afr/sdk`, and `apps/web` in one commit, and CI validates the entire change.
- **Incremental builds:** Turbo caches build outputs. Changing only the SDK does not rebuild the contracts package.
- **Simple local development:** `pnpm dev` at the root starts all development processes via Turbo.

### Negative / Trade-offs

- **Build complexity:** Engineers must understand the Turbo task DAG. A change to `@afr/contracts` triggers rebuilds of `@afr/sdk` and `apps/web`.
- **Repo size grows over time:** All code in one repo. At scale, this can slow down git operations.
- **Convex is partially outside the workspace:** `convex/` requires separate CLI management (`npx convex dev`). This is a minor operational friction but is unavoidable given how Convex works.

### Invariants Established by This Decision

- All internal package dependencies use `workspace:*` in `package.json`.
- `turbo.json` must be updated whenever a new workspace package is added.
- The `contracts` package must remain a leaf (no internal dependencies).
- `convex/` imports from `@afr/contracts` only; it does not import from `@afr/sdk` or `apps/web`.
