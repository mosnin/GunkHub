# CLAUDE.md — Agent Flight Recorder Project Constitution

This file is the authoritative guide for Claude sessions working on this repository.
Read it in full before making any changes. It supersedes any general conventions you
might apply by default.

---

## Product Summary

Agent Flight Recorder records agent executions as immutable event graphs, stores them
durably in Convex, and lets engineers inspect, replay, and compare runs via a web UI.

The core value proposition is debuggability: when an agent fails or behaves unexpectedly,
an engineer can open the run trace, walk through every event in sequence, and understand
exactly what happened and why. Replay and diff are derived views over the stored event log
— they are never the source of truth.

**Primary v1 outcome: make failures explainable.**

---

## System Boundaries

Each boundary owns its domain exclusively. Do not blur these lines.

| Boundary | Owns |
|----------|------|
| `apps/web` | UI, API routes, Clerk auth integration, Next.js configuration |
| `packages/contracts` | Shared TypeScript types only — zero runtime dependencies |
| `packages/sdk` | Client recording library — instruments agent code, ships events to Convex |
| `packages/cli` | `afr` command-line interface — sdk team owns |
| `packages/mcp` | MCP server exposing the read API to MCP clients — **READ SURFACE ONLY** |
| `convex/` | Backend schema, query functions, mutation functions, Convex auth config |

`packages/mcp` is constrained beyond the ordinary boundary rules, because it hands a
tool surface to an autonomous caller:

- **It must never write.** No event ingestion, no run creation, no status/triage/
  lifecycle mutation, no alert or webhook configuration. Every tool it exposes is a
  `GET`. If a tool would change stored state, it does not belong in this package.
- **It must not import from `convex/` directly**, and must not hold a Convex deploy key
  or a Clerk session. It reaches the product only over the public `/api/v1/**` read API
  with an `x-api-key` carrying the `read` scope — the same door the `afr` CLI uses, with
  the same org scoping, the same 403 on a key that lacks `read`, and the same per-key
  rate class.
- **Entity types come from `@agent-flight-recorder/contracts`**, never redeclared
  locally (Repo Conventions → Types applies unchanged).
- **Tool responses are token-budgeted by design.** The tool set is a progressive-
  disclosure ladder (cheap orientation first, raw events last) — see `docs/mcp.md`.
  Adding a tool that returns unbounded event payloads defeats the package's purpose;
  large payloads stay artifact pointers, per Event Log Rule 3.

### File Ownership Map

Before editing any file, identify which boundary it belongs to. Do not edit files
outside the boundary you have been assigned without explicit instruction.

```
apps/web/**              → web boundary
packages/contracts/**   → contracts boundary
packages/sdk/**         → sdk boundary
packages/cli/**         → cli boundary — sdk team owns
packages/mcp/**         → mcp boundary — read-only MCP server; no writes, no convex/ imports
convex/**               → convex boundary
scripts/**              → shared tooling (any team may edit)
docs/**                 → shared documentation (any team may edit)
tests/**                → shared tests (any team may edit; includes tests/e2e)
root config files        → infrastructure (Team A owns, others may propose changes)
```

`.github/CODEOWNERS` mirrors this table (with real review-routing handles substituted
in later); keep the two in sync when the map changes.

---

## Core Entities

The data model is a strict hierarchy. Memorize it.

```
Organization
  └── Project
        └── Agent
              └── AgentVersion
                    └── Run
                          └── Event
```

- **Artifacts** hang off **Runs** — they store pointers to externalized large payloads
- **Comments** hang off **Runs** and **Events** — human annotations on recorded data
- An `AgentVersion` is immutable once created; a new version must be created for any
  change to the agent's configuration, system prompt, or tool list
- An append-only **audit log** (org-scoped) and an opt-in per-org **retention** window
  sit alongside this hierarchy — see Event Log Rules and `docs/architecture.md` for
  how they interact with runs and events

---

## Event Log Rules

These rules are non-negotiable. Do not propose changes to them without a formal ADR.

1. **The event log is append-only and immutable.** Once an event record is written,
   it is never updated or deleted. There are no update or delete mutations for events.

2. **Replay and diff are derived projections, never source of truth.** They are computed
   at query time from the stored event sequence. They are never stored back.

3. **Large payloads must be externalized.** Any event payload exceeding 10 KB must be
   written to blob storage. The event record stores only a pointer (artifact record with
   blob URL and SHA-256 checksum). This keeps the Convex document store lean.

4. **Event ordering is by `sequenceNumber` within a run.** Sequence numbers are
   monotonically increasing integers starting at 1. The SDK assigns them; the backend
   validates that they are contiguous and non-repeating.

5. **`RUN_STARTED` is always the first event; `RUN_COMPLETED` or `RUN_FAILED` is always
   the last.** A run without a terminal event is considered in-progress.

6. **Privileged mutations are audited, not erased.** An append-only admin audit log
   records every privileged mutation (role changes, key revocation, retention policy
   changes, purges). Retention/erasure (data deletion for offboarding or an org's opt-in
   retention window) is governed by ADR-001 (`docs/adr/001-data-retention-and-erasure.md`)
   and is the sole exception to "events are never deleted" — it is operator-invoked, not
   an ad-hoc mutation.

---

## Tenancy Rules

Multi-tenancy is enforced at the organization boundary. These rules prevent data leakage.

1. **Organization is the tenancy and authorization boundary.** Every Convex query and
   mutation must accept and enforce `orgId` (mapped from the Clerk organization ID).

2. **Every query and mutation must scope to the caller's org.** No function may return
   records without filtering by the caller's `organizationId`.

3. **Never return data across org boundaries.** If a query for org A could ever return
   a record belonging to org B, it is a security defect.

4. **Clerk org ID maps to Convex organization record.** The `clerkOrgId` field on the
   `organizations` table is the join key. Use it consistently.

5. **Auth must be checked before any data access.** Convex functions must call
   `ctx.auth.getUserIdentity()` and resolve the org before touching any table.

---

## Design Quality Rules

Agent Flight Recorder is a premium engineering tool, not a startup template.
Every UI decision must reflect this.

> **⚠️ AUTHORITATIVE VISUAL STYLE — `design.md`.**
> The repo-root **`design.md`** ("Neon — Server Room After Dark") is the single
> source of truth for the product's visual identity: palette, typography, spacing,
> shapes, motion, components, and imagery. **You MUST read and follow `design.md`
> every time you make ANY UI change** — new components, restyles, layout, pages,
> animations, or graphics. All colors come from its tokens (Blackout `#000000`
> ground, Whiteout `#ffffff` text, Neon Glow `#34d59a` accent only), buttons are
> pills (`9999px`), all other containers are `4px`, and depth is layered near-black
> surfaces, never box-shadows. Do not introduce colors, radii, or type outside the
> `design.md` system without updating `design.md` first.

- **Calm, technical, high signal.** Remove anything that does not carry information.
- **Strong visual hierarchy.** Engineers scan vertically. Make the most important
  data (event type, status, timestamp, error message) immediately legible at a glance.
- **Tight spacing.** Dense layouts are appropriate for debugging tools. Avoid large
  amounts of whitespace that force unnecessary scrolling.
- **Clear loading, empty, and error states on every page.** Every data-dependent view
  must handle all three states explicitly. No blank screens, no silent failures.
- **No decorative noise.** No gradient blobs, no hero illustrations, no stock iconography
  that doesn't carry semantic meaning.
- **Build for the engineer's flow state.** Keyboard navigation, copyable values,
  stable URLs that can be shared, fast page transitions.

---

## Repo Conventions

### Types

- All shared entity types live in `packages/contracts` only.
- Never duplicate entity types across packages. If you need a type in two places,
  put it in `contracts` and import it.
- The SDK must import entity types from `@agent-flight-recorder/contracts`.
- The web app must import entity types from `@agent-flight-recorder/contracts`.
- Convex schema validator types are separate (generated by Convex) but the shape
  must align with `contracts` types exactly. If they diverge, fix both.

### Imports

- Use `import type` for all type-only imports. ESLint enforces this.
- No relative imports that escape a package root (e.g., `../../other-package`).
  Use workspace package names instead (`@agent-flight-recorder/contracts`).

### Commits

- Run `pnpm typecheck` before every commit. Non-typechecking code must not be merged.
- Run `./scripts/validate.sh` before pushing a branch. All three checks must pass.
- Commit messages: imperative mood, present tense. "Add event log schema" not "Added".

### Packages

- Do not add new packages to the workspace without updating this file.
- New packages must be added to the file ownership map above.
- New packages must have their own `tsconfig.json` extending `tsconfig.base.json`.

### Contracts versioning

- Do not change a type in `packages/contracts` without bumping the package version.
- After bumping, update all consumers (`apps/web`, `packages/sdk`) in the same PR.
- Breaking changes to contracts require a migration plan for existing Convex data.

### Documentation

- `docs/architecture.md` is the up-to-date system architecture reference (diagram,
  entity hierarchy, event-log invariants, tenancy model, ingest paths, durability story)
  — keep it current when the code paths it cites change.
- `CONTRIBUTING.md` is the practical dev workflow doc (setup, verification gates, boundary
  map, and how-tos for adding an event type / Convex function / UI surface / package).
  It defers to this file as authoritative on rules; update both if a rule changes.
- `docs/mcp.md` documents the `packages/mcp` server: tool contract, MCP client config,
  env vars, required key scope, and the progressive-disclosure model the tool set is
  built around. Read it before adding or reshaping an MCP tool.
- Non-negotiable decisions (event log rules, tenancy rules, retention/erasure) are
  formalized as ADRs. Two ADR directories currently exist — `docs/adrs/` (the original
  numbered sequence, `0001`–`0026`) and `docs/adr/` (a newer sequence, starting with
  `001-data-retention-and-erasure.md`). Check both when researching or proposing a
  decision; do not silently merge or renumber them without an explicit instruction to
  do so.

---

## Rules for Future Prompts

When starting a new Claude session on this repository:

1. **Read this file first.** Do not make changes before understanding the system boundaries
   and entity model.

2. **Check the file ownership map** before editing any file. If you are assigned to a
   specific boundary (e.g., "you are the web team"), do not edit files in other boundaries
   unless explicitly instructed.

3. **Do not add new packages** without updating `CLAUDE.md` with the package's boundary
   description and adding it to the file ownership map.

4. **Do not change contracts** without bumping the version and updating all consumers
   in the same operation. Partial updates break the type system across packages.

5. **Keep event log immutability.** Never add an update or delete mutation for the
   `events` table. If you find a reason to want one, write an ADR first.

6. **Run `pnpm typecheck` before any commit.** This is mandatory, not optional.

7. **Scope every Convex function to the caller's org.** If you write a query that does
   not filter by `organizationId`, it is wrong.

8. **Check `.env.example`** if you add a new environment variable. Document it there
   before the code that consumes it is merged.

9. **Read `design.md` before any UI change.** Any change to `apps/web` components,
   pages, styles, layout, motion, or graphics MUST conform to the `design.md`
   ("Neon") system — its palette tokens, pill/4px shapes, Inter + GeistMono type,
   and motion/imagery rules. If a change needs something outside that system,
   update `design.md` first.

---

## Not in v1

The following are explicitly out of scope for the initial release. Do not implement
or design for them until v1 ships and the decision is revisited.

> **Amendment (2026-07-19, final cycle of the action-layer work):** ADR-002
> (`docs/adr/002-data-model-expansion.md`) and ADR-003
> (`docs/adr/003-alerting-webhooks-export.md`) each lifted part of this
> freeze and committed to amending this section once their work shipped.
> Both are now fully implemented and wired (not just data-model/engine-only —
> see `docs/architecture.md` §8 and §9 for the crons and terminal-event
> scheduling that make delivery live). The two lifted items are removed below
> and replaced with pointers to the ADRs that govern them.

> **Amendment (2026-07-25):** ADR-009 (`docs/adr/009-policy-engine.md`) lifts a
> third item, and lifts only **part** of its bullet: the declarative policy
> engine is authorised; "compliance features" as a category and audit log
> export are not. Unlike ADR-002 and ADR-003, ADR-009 was written *before* its
> implementation — its central ruling (a policy engine inside a flight recorder
> must never refuse to record a violation) constrains where the code may be
> put, so it had to precede the code. The engine's pure half
> (`convex/helpers/policy.ts`, the `policies` table) landed while it was being
> written and reached the same ruling independently; every read surface, the
> pre-flight, and the contracts vocabulary are still missing (ADR-009 §10).

- Real-time collaboration or live streaming of events to multiple viewers
- ~~Analytics dashboards, aggregate metrics, or usage statistics~~ — lifted by
  ADR-002: usage counters, daily rollups, and the analytics/cost/version-
  comparison UI surfaces are shipped, subject to ADR-002's constraints
  (additive schema only, org-scoped, approximate/observability-grade
  counters — never a substitute for the event log as source of truth).
- Agent marketplace or agent registry
- ~~Policy engine~~, compliance features, or audit log export — the **policy
  engine** half is lifted by ADR-009 (`docs/adr/009-policy-engine.md`):
  declarative rules evaluated over recorded runs, plus an advisory SDK
  pre-flight, subject to ADR-009's constraints (never on the write path —
  ingest accepts everything it accepted before; org-scoped; admin-managed,
  audit-snapshotted rules; outcomes never stored at all; mandatory coverage on
  every result; and no verdict meaning "compliant"). **Compliance
  features as a category and audit log export remain frozen** — see ADR-009
  constraint 7 for what would have to be true to lift them.
- Multi-region or distributed ingestion infrastructure
- Billing, usage metering, or subscription management
- ~~Webhooks or external integrations (Slack, PagerDuty, etc.)~~ — lifted by
  ADR-003: alerting and outbound webhook delivery are shipped, subject to
  ADR-003's constraints (org-scoped, admin-managed mutations, append-only
  delivery/firing logs, HTTPS-only + SSRF-guarded outbound targets,
  HMAC-signed payloads).
- Mobile application
