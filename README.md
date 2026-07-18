# Agent Flight Recorder

Agent Flight Recorder records agent executions as immutable event graphs, stores them
durably in Convex, and lets engineers inspect, replay, and compare runs via a web UI.

The core value proposition is debuggability: when an agent fails or behaves unexpectedly,
an engineer can open the run trace, walk through every event in sequence, and understand
exactly what happened and why. Replay and diff are derived views over the stored event log
— they are never the source of truth.

**Primary v1 outcome: make failures explainable.**

---

## Monorepo Layout

| Path | Owns |
|------|------|
| `apps/web` | Next.js 14 (App Router) UI, ingestion API routes, Clerk auth integration |
| `packages/contracts` | Shared TypeScript types only — zero runtime dependencies |
| `packages/sdk` | Client recording library — instruments agent code, ships events to Convex |
| `convex/` | Backend schema, query/mutation functions, crons, Convex auth config |
| `tests/` | Unit tests (`tests/unit`), integration tests against a real Convex deployment (`tests/integration`), end-to-end tests (`tests/e2e`), shared fixtures |
| `scripts/` | Developer tooling: `validate.sh`, `check-schema-drift.ts`, `seed.ts`, `rebuild-projection.ts`, `verify-e2e.ts` |
| `docs/` | Architecture, ADRs, ops runbooks, product docs — see [Docs Index](#docs-index) |

See `CLAUDE.md` for the authoritative system-boundary and file-ownership rules, and
`docs/architecture.md` for how the pieces fit together end to end.

---

## Quickstart

Prerequisites: Node.js 20+, pnpm 9+ (`npm install -g pnpm@9`), a Clerk application, and a
Convex deployment.

```bash
git clone <repo-url>
cd GunkHub
pnpm install
```

### Environment setup

```bash
cp .env.example .env.local
```

`.env.example` is the authoritative, documented list of every environment variable the
app needs (Clerk keys, Convex URL/deploy key, blob storage, webhook secrets, test-only
integration vars). Fill in `.env.local` before starting the app — you'll need a Clerk app
and a Convex deployment first.

### Run locally

```bash
pnpm dev
```

Starts `apps/web` (Next.js dev server, `http://localhost:3000`) and `convex dev`
(pushes function changes to your Convex dev deployment) in parallel via Turbo.

### Verification commands

| Command | What it does |
|---------|---------------|
| `pnpm typecheck` | `tsc --noEmit` across every package (7 Turbo tasks) |
| `pnpm lint` | ESLint across every package (5 Turbo tasks) |
| `pnpm build` | Production build of all packages |
| `pnpm test` | Run all unit test suites |
| `pnpm clean` | Delete all build artifacts and caches |
| `./scripts/validate.sh` | Runs typecheck + build + lint + schema-drift with a pass/fail summary — run this before pushing |

CI (`.github/workflows/ci.yml`) runs typecheck, lint, schema-drift, dependency-audit,
build, unit tests, and a real-Convex integration test job on every PR into `main`.

---

## SDK

Agent authors instrument their code with `@agent-flight-recorder/sdk`. See
[`packages/sdk/README.md`](packages/sdk/README.md) for the quick-start, event builders,
buffering/retry/spool behavior, and payload-externalization details.

---

## Docs Index

- [`docs/architecture.md`](docs/architecture.md) — system architecture, entity hierarchy, event-log invariants, tenancy model, ingest paths, durability story
- [`docs/adrs/`](docs/adrs/) and [`docs/adr/`](docs/adr/) — architecture decision records (two directories exist today: `docs/adrs/0001`–`0026` is the original sequence, `docs/adr/001-data-retention-and-erasure.md` is a newer one; consult both when researching a decision)
- [`docs/ops/`](docs/ops/) — CI setup, dependency-audit ignore rationale, observability
- [`docs/operations_runbook.md`](docs/operations_runbook.md), [`docs/deployment_checklist.md`](docs/deployment_checklist.md) — operational procedures
- [`design.md`](design.md) — "Neon — Server Room After Dark," the authoritative visual style for every UI change
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev workflow, verification gates, how to add event types / Convex functions / UI surfaces / packages
- [`CLAUDE.md`](CLAUDE.md) — project constitution: system boundaries, entity model, event log and tenancy rules

---

## Current Capabilities

The following are implemented and enforced today, not aspirational:

- **Event log invariants** — append-only `events` table (no update/delete mutations),
  server-enforced contiguous `sequenceNumber`s starting at 1, `run.started` required as
  the first event, `run.completed`/`run.failed` required as the last (`convex/events.ts`,
  `convex/sdk_ingest.ts`)
- **Org tenancy** — every Convex query/mutation resolves `orgId` from the Clerk JWT via
  `getAuthContext`/`requireOrgMembership` (`convex/auth.ts`) before touching any table;
  `viewer`/`member`/`admin` role tiers with a rank-based minimum-role check
- **Audit log** — an append-only `audit_log` table records every privileged mutation
  (`convex/audit.ts`)
- **Retention / erasure (ADR 001)** — per-org opt-in `retentionDays`; a daily cron
  (`convex/retention.ts`) deletes terminal runs and their events/artifacts/comments past
  the window; org deletion is tracked via `pendingDeletionAt` with operator-invoked purge
- **API-key SDK ingest with rate limits** — `x-api-key`-authenticated mutations in
  `convex/sdk_ingest.ts` (`sdkCreateRun`, `sdkCreateEvents`, `sdkCreateArtifact`,
  `sdkUpdateRunStatus`) enforce key revocation/expiry/scope and a fixed one-minute-window
  per-key rate limit (`api_keys.rateLimitPerMin`)
- **Durability spool** — the SDK's buffered `Recorder` supports an on-disk `FileSpool`
  (JSONL, append-only) so events survive a process crash and are re-sent by
  `recorder.recover()` on the next process start
- **Payload externalization** — payloads over 10 KB are rejected inline and must be
  uploaded as artifacts (blob storage pointer + SHA-256 checksum), enforced both in the
  SDK and, defense-in-depth, in Convex (`sdk_ingest.ts` `assertPayloadWithinInlineLimit`)
- **Scheduled jobs** — daily crons for artifact GC, stale-run expiry, retention
  enforcement, and projection-integrity verification (`convex/crons.ts`)

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow. Before pushing any
branch, run:

```bash
./scripts/validate.sh
```

Typecheck, build, lint, and schema-drift must all pass — CI enforces the same checks.
