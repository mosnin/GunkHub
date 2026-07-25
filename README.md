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
| `packages/cli` | `afr` command-line interface — a read-only client of the `/api/v1` read API |
| `packages/mcp` | MCP server — exposes the `/api/v1` read API to MCP clients; read-only, see [`docs/mcp.md`](docs/mcp.md) |
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
| `pnpm lint` | ESLint across every package (7 Turbo tasks) |
| `pnpm build` | Production build of all packages |
| `pnpm test` | Run all unit test suites — including the MCP token-budget assertions, which are a release gate, not a nicety ([`CONTRIBUTING.md`](CONTRIBUTING.md)) |
| `pnpm clean` | Delete all build artifacts and caches |
| `./scripts/validate.sh` | Runs typecheck + build + lint + schema-drift + convex-refs + design-tokens with a pass/fail summary — run this before pushing |

CI (`.github/workflows/ci.yml`) runs ten jobs — typecheck, lint, dependency-audit,
schema-drift, convex-refs, convex-codegen-sync, design-tokens, build, test, and a
real-Convex integration test job — on every PR into `main`.

---

## SDK

Agent authors instrument their code with `@agent-flight-recorder/sdk`. See
[`packages/sdk/README.md`](packages/sdk/README.md) for the quick-start, event builders,
buffering/retry/spool behavior, and payload-externalization details.

---

## Investigating a failure

Two read-only clients sit on the same `/api/v1` surface: the `afr` CLI
(`packages/cli`) and the MCP server (`packages/mcp`). Both are deliberately tiered by
cost, and **the order you call them in is the product**:

```
0. what is wrong, and                                   afr_triage()      ← START HERE
   what do I look at first?                             ~332 tokens, no arguments
1. what is broken? (breadth)  afr patterns           /  afr_list_failure_patterns
2. did the fix hold?          afr patterns evidence … /  afr_get_pattern_evidence
3. why did THIS run fail?     afr explain <runId>     /  afr_explain_run
4. show me the events         afr export <runId>      /  afr_get_run_events  ← expensive
```

`afr_triage()` takes no arguments and every item it returns names the exact next tool
and arguments to call — an agent never has to infer the ladder. Triage plus an
explanation costs roughly an eighth of a single step-4 event window. Most
investigations should end at step 3; many should end at step 0.
[`docs/mcp.md`](docs/mcp.md) → "Start here" has the measured numbers, a worked example,
and the CI-gate semantics.

`afr triage` is the CLI counterpart, and it is the same ranking — both surfaces import
`toTriageResult` from `@agent-flight-recorder/sdk`, so they cannot disagree. For a build
gate it maps the verdict onto exit codes: `0` clear, `10` findings, `11` inconclusive
("nothing found, but the view was incomplete"). Exit `0` is unreachable on an incomplete
scan. `afr patterns --state regressed` similarly exits `11` rather than `0` when its
scan was truncated, so a gate cannot mistake an unfinished scan for a clean one — see
[`docs/api_reference.md`](docs/api_reference.md) § "Exit codes" and
[`docs/mcp.md`](docs/mcp.md) § "Using this as a CI gate".

---

## Docs Index

- [`docs/architecture.md`](docs/architecture.md) — system architecture, entity hierarchy, event-log invariants, tenancy model, ingest paths, durability story
- [`docs/adrs/`](docs/adrs/) and [`docs/adr/`](docs/adr/) — architecture decision records (two directories exist today: `docs/adrs/0001`–`0026` is the original sequence, `docs/adr/001-data-retention-and-erasure.md` is a newer one; consult both when researching a decision)
- [`docs/mcp.md`](docs/mcp.md) — the MCP server (`packages/mcp`). **Start with its "Start here" section**: the progressive-disclosure ladder, the measured token cost of each tier, a worked example of the intended investigation path, and the CI-gate/`scanTruncated` semantics. "Where the token figures come from" → "What keeps these numbers true" names the suites that stop those costs drifting, and the gaps that remain. Then the tool contract and client configuration
- [`docs/api_reference.md`](docs/api_reference.md) — HTTP contract for the public v1 read API (`/api/v1/**`), key management, the alerts/webhooks management API, outbound webhook verification, and how the `afr` CLI and MCP server map onto all of it
- [`docs/ops/`](docs/ops/) — CI setup, dependency-audit ignore rationale, observability
- [`docs/operations_runbook.md`](docs/operations_runbook.md), [`docs/deployment_checklist.md`](docs/deployment_checklist.md) — operational procedures
- [`design.md`](design.md) — "Neon — Server Room After Dark," the authoritative visual style for every UI change
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev workflow, verification gates (including the MCP token budgets and the obligation that comes with them), how to add event types / Convex functions / MCP tools / UI surfaces / packages
- [`CLAUDE.md`](CLAUDE.md) — project constitution: system boundaries, entity model, event log and tenancy rules

---

## Current Capabilities

The following are implemented and enforced today, not aspirational:

### Core event log and platform

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
  the window; org deletion is tracked via `pendingDeletionAt` with operator-invoked purge;
  configured from the web UI (`apps/web/src/components/settings/RetentionSection.tsx`)
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
- **Sampling** — client-side head sampling with tail-bias for failures
  (`packages/sdk/src/sampling.ts`), decided once per run, optionally deterministic
  (`seedFromRunName`) or caller-overridden (`decider`); see `docs/architecture.md` §9 for
  its effect on server-side rollups/usage/alerts
- **Redaction** — SDK-side payload redaction before events leave the process
  (`packages/sdk/src/redaction.ts`)
- **Member management** — org member listing and role changes in the web UI
  (`apps/web/app/(app)/settings/members/page.tsx`)

### Run organization and investigation

- **Full-text search over runs** — a Convex search index (`search_runs`) over an
  extracted `searchText` field, queried via `searchRuns` and surfaced in the web UI
  (`apps/web/app/(app)/search/page.tsx`) and `GET /api/v1/runs`
- **Run hierarchy and sessions** — parent/child sub-runs (`parentRunId`) and free-form
  session grouping (`sessionId`) for multi-turn/multi-agent flows
  (`apps/web/src/components/runs/RunHierarchyPanel.tsx`,
  `apps/web/app/(app)/sessions/[sessionId]/page.tsx`)
- **Environments** — per-run `environment` field (well-known values or a custom string),
  filterable in the run list and the v1 read API
- **Triage** — a linear `open → investigating → resolved` state machine for failed/
  timed-out runs (`apps/web/app/api/runs/[id]/triage/route.ts`,
  `apps/web/src/components/runs/TriageControl.tsx`)
- **Evals** — pass/fail/score checks recorded against a run, written via a member-gated
  mutation or an API-key ingest path for automated eval pipelines
  (`convex/evals.ts`, `apps/web/src/components/runs/EvalsPanel.tsx`)

### Analytics, alerting, and delivery (ADR-002 / ADR-003)

- **Analytics, cost, and version comparison** — daily per-agent rollups (`daily_rollups`)
  and per-org usage counters (`usage_counters`), surfaced in a usage settings page
  (`apps/web/app/(app)/settings/usage/page.tsx`) and an agent-version comparison view
  (`apps/web/src/components/agents/VersionCompare.tsx`); see `docs/architecture.md` §9
  for how client-side sampling affects these numbers
- **Alerting** — org-configured, admin-managed alert rules (`run_failed` /
  `failure_rate` / `eval_failed`) evaluated automatically on every run's terminal event,
  configured via `/api/alerts/**` and the web UI (`apps/web/app/(app)/settings/alerts/page.tsx`)
- **Outbound webhooks** — HTTPS-only, SSRF-guarded, HMAC-signed webhook delivery to
  org-configured targets, with an append-only delivery log
  (`convex/webhook_engine.ts`, `apps/web/app/(app)/settings/webhooks/page.tsx`)
- **Email delivery** — the alert-rule email channel counterpart to webhooks, pluggable
  via an `EmailNotifier` abstraction (console logger by default, Resend when
  `AFR_EMAIL_PROVIDER=resend`) (`convex/email_engine.ts`, `convex/helpers/notifier.ts`)
- **Data export** — bulk (`GET /api/export/runs`) and single-run
  (`GET /api/export/runs/{runId}`) extraction of already-authorized data in
  JSON/CSV/ndjson, rate-limited and streamed rather than materialized in memory
- **Read-only public API surface** — the key-authenticated `/api/v1/**` read API
  (`convex/read_api.ts`), the SDK-side `FlightReader` client (`packages/sdk/src/reader.ts`),
  and the `afr` CLI (`packages/cli`, read-only: `runs list`, `runs get`, `tail`, `replay`,
  `export`) — see `docs/api_reference.md` for the full contract

### Scheduled jobs

- Five daily crons (artifact GC, stale-run expiry, retention enforcement,
  projection-integrity verification, daily rollup computation) and two per-minute crons
  (webhook delivery, email delivery) — all defined in `convex/crons.ts`, detailed in
  `docs/architecture.md` §8

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow. Before pushing any
branch, run:

```bash
./scripts/validate.sh
```

Typecheck, build, lint, and schema-drift must all pass — CI enforces the same checks.
