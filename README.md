# Agent Flight Recorder

Agent Flight Recorder is an agent execution debugging and replay platform. It records every
event that occurs during an AI agent's run — LLM calls, tool invocations, memory reads and
writes, handoffs, errors — and stores them as an immutable event graph. Engineers can then
inspect, replay, and compare runs to understand why an agent behaved the way it did and
exactly where a failure occurred.

The primary v1 outcome is to make failures explainable.

---

## Repo Shape

```
GunkHub/
├── apps/
│   └── web/               Next.js 14 app — UI, API routes, Clerk auth
├── packages/
│   ├── contracts/         Shared TypeScript types (no runtime deps)
│   └── sdk/               Client recording library for agent instrumentation
├── convex/                Backend: schema, queries, mutations, Convex auth
├── docs/                  Architecture docs, ADRs, API reference
├── tests/                 Integration and end-to-end tests
├── scripts/               Developer utility scripts (seed, validate)
├── .env.example           Authoritative list of required environment variables
├── CLAUDE.md              Project constitution for AI-assisted development
├── tsconfig.base.json     Strict TypeScript config extended by all packages
└── pnpm-workspace.yaml    pnpm workspace declaration
```

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | Use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) |
| pnpm | 9+ | `npm install -g pnpm@9` |
| Convex CLI | latest | `npm install -g convex` |
| Clerk account | — | Free tier at [clerk.com](https://clerk.com) |

---

## Install

```bash
# Clone the repository
git clone <repo-url>
cd GunkHub

# Install all workspace dependencies
pnpm install
```

---

## Environment Setup

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in all values. Every variable is documented in `.env.example`.
You will need a Clerk app and a Convex deployment before the app will start.

---

## Run Locally

```bash
pnpm dev
```

This starts all packages in parallel via Turbo:

- **apps/web** — Next.js dev server at `http://localhost:3000`
- **convex/** — `convex dev` watches and pushes function changes to your dev deployment

The web app talks to your Convex dev deployment in the cloud; there is no local Convex server
to run. The Convex dashboard at `https://dashboard.convex.dev` shows all data and function
logs during development.

---

## Available Scripts

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start all apps and watchers in parallel |
| `pnpm build` | Production build of all packages |
| `pnpm typecheck` | Run `tsc --noEmit` across all packages |
| `pnpm lint` | ESLint across all packages |
| `pnpm test` | Run all test suites |
| `pnpm clean` | Delete all build artifacts and caches |
| `./scripts/validate.sh` | Typecheck + build + lint with pass/fail summary |

---

## Package Ownership

### `apps/web`

The Next.js application that serves the Agent Flight Recorder UI. This package owns all
user-facing pages (org selector, project list, run list, event trace viewer, diff view),
all Next.js API routes, and the Clerk authentication integration. It imports entity types
from `@agent-flight-recorder/contracts` and never defines its own duplicate types. It
connects to the Convex backend via the ConvexProvider and uses Clerk's Next.js SDK for
authentication middleware and session management.

### `packages/contracts`

The single source of truth for all shared TypeScript types. This package has zero runtime
dependencies — it is types only. Every entity (`Organization`, `Project`, `Agent`,
`AgentVersion`, `Run`, `Event`, `Artifact`, `Comment`) is defined here. Both the web app and
the SDK import from this package. The Convex schema uses aligned-but-separate types because
Convex generates its own validator types; however, the shape must match `contracts` exactly.
Version this package carefully: any breaking change to a type must be coordinated with all
consumers before merging.

### `packages/sdk`

The client-side recording library that agent authors instrument their code with. It provides
a simple API (`recorder.startRun()`, `recorder.logEvent()`, `recorder.endRun()`) that batches
and ships events to the Convex ingest mutation. The SDK handles sequence numbering,
large-payload externalisation to blob storage, retry logic, and graceful degradation when the
backend is unreachable. It imports all entity types from `@agent-flight-recorder/contracts`.

### `convex/`

The Convex backend. Contains the database schema (all tables and their validators), all query
functions (read-only), all mutation functions (write), and Convex's auth configuration wired
to Clerk via the Convex-Clerk integration. Every query and mutation is scoped to the calling
user's organization — no cross-org data access is possible. The event log tables are
append-only; there are no update or delete mutations for event records.

### `docs/`

Architecture decision records (ADRs), sequence diagrams, and API reference documentation.
ADRs live in `docs/adr/` numbered sequentially. This is a human-readable knowledge base for
the engineering team.

### `tests/`

Integration tests and end-to-end tests that run against a live Convex test deployment. Unit
tests live alongside the code they test (co-located `*.test.ts` files). Integration tests that
span package boundaries or require a running Convex backend live here.

### `scripts/`

Developer utility scripts. `validate.sh` runs the full typecheck/build/lint suite locally and
prints a pass/fail summary. `seed.ts` will seed a local Convex deployment with realistic test
data covering all entity types and run scenarios.

---

## What is Implemented in This Foundation

The following is fully implemented and functional in this commit:

- **Monorepo structure** — pnpm workspaces, Turbo task graph, all package directories created
- **TypeScript configuration** — strict `tsconfig.base.json` extended by all packages
- **ESLint configuration** — typescript-eslint, import plugin, type-aware linting rules
- **Prettier configuration** — consistent formatting with per-file-type overrides
- **Git configuration** — `.gitignore` covering all build artifacts, secrets, and caches
- **Environment variable documentation** — `.env.example` with explanatory comments for all vars
- **CI workflow** — GitHub Actions: typecheck, lint, build, test jobs with pnpm cache
- **Validation script** — `scripts/validate.sh` with colored pass/fail output
- **Seed script structure** — `scripts/seed.ts` with complete data model and entry point wiring

## What is Stubbed

The following directories exist but contain only the minimum to satisfy the workspace:

- `apps/web/` — directory exists; Next.js app not yet scaffolded
- `packages/contracts/` — directory exists; types not yet defined
- `packages/sdk/` — directory exists; recording client not yet implemented
- `convex/` — directory exists; schema and functions not yet written

---

## What Comes Next

The next phases of work, in priority order:

1. **Convex schema** — Define all tables (`organizations`, `projects`, `agents`,
   `agentVersions`, `runs`, `events`, `artifacts`, `comments`) with proper validators and
   indexes. Wire Clerk JWT auth.

2. **contracts package** — Define all entity types and ingest payload types in
   `packages/contracts`. This unblocks SDK and web development.

3. **SDK recording client** — Implement `packages/sdk` with `startRun`, `logEvent`,
   `endRun`, large-payload externalisation, and retry logic.

4. **Web app scaffolding** — Next.js app with Clerk integration, Convex provider, and the
   base layout. Route structure: `/orgs/[orgSlug]/projects`, `/runs/[runId]`,
   `/runs/[runId]/events/[eventId]`.

5. **Run trace viewer** — The core UI: ordered event list with type icons, payload preview,
   sequence number, timestamps, duration markers.

6. **Replay logic** — Step-through replay of a run's event sequence. Stateless projection,
   never stored.

7. **Diff logic** — Side-by-side comparison of two runs of the same agent version. Highlight
   divergence points.

8. **Full ingestion** — Batch ingest endpoint, SDK streaming mode, blob store integration for
   large payloads.

---

## Contributing

Before pushing any commit, run:

```bash
./scripts/validate.sh
```

All three checks (typecheck, build, lint) must pass. CI enforces the same checks.
