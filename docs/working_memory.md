# Working Memory — Agent Flight Recorder

*This document is a state snapshot for future Claude sessions. Update it when the system state changes significantly.*

Last updated: April 2026 (foundation build, Team A)

---

## Current Status: Foundation Built

The repository structure is established. All configuration, documentation, and scaffold files are in place. No application code has been written yet — packages contain empty source directories or stubs.

---

## What Works Right Now

| Item | Status | Notes |
|---|---|---|
| Root workspace config (`package.json`, `pnpm-workspace.yaml`) | Complete | All scripts defined |
| Turborepo task pipeline (`turbo.json`) | Complete | build, dev, lint, typecheck, test, clean |
| TypeScript root config (`tsconfig.json`) | Complete | Strict mode, ES2022, Bundler resolution |
| ESLint config (`.eslintrc.js`) | Complete | TS strict rules, prettier compat |
| Prettier config (`.prettierrc`) | Complete | Standard settings |
| `.gitignore` | Complete | Covers Node, Next.js, Convex, Vercel, OS |
| `.env.example` | Complete | All required env vars documented |
| GitHub Actions CI (`ci.yml`) | Complete | Runs on push/PR to main, caches pnpm |
| Build validation script (`validate-build.sh`) | Complete | Checks each package individually |
| Seed data fixtures (`scripts/seed.ts`) | Complete | Typed mock data, no DB connection |
| `CLAUDE.md` (project constitution) | Complete | Architectural rules for AI agents |
| `README.md` | Complete | Install, dev, package descriptions |
| Product spec (`docs/product_spec.md`) | Complete | Problem, users, scope, flows |
| Domain model (`docs/product_model.md`) | Complete | Entities, lifecycle, event flow |
| Architecture doc (`docs/architecture.md`) | Complete | System diagram, tech choices, data flow |
| ADR 0001: repo shape | Complete | pnpm workspaces + Turbo decision |
| ADR 0002: event log canonical | Complete | Immutable append-only log decision |
| ADR 0003: tenancy boundary | Complete | Org = Clerk org = Convex orgId |
| ADR 0004: shared contracts | Complete | @afr/contracts is the leaf package |
| Claude subagent defs (`.claude/agents/`) | Complete | platform, data, ui, sdk_quality |

---

## What Is Stubbed with TODOs

| Item | Location | What's Missing |
|---|---|---|
| `packages/contracts/` | `packages/contracts/` | Empty dir — needs `package.json`, `tsconfig.json`, `src/index.ts` with all domain types |
| `packages/sdk/` | `packages/sdk/` | Empty dir — needs `package.json`, `tsconfig.json`, `src/index.ts`, `FlightRecorder` class |
| `apps/web/` | `apps/web/` | Empty dir — needs Next.js 15 app scaffold, `package.json`, all config files |
| `convex/` | `convex/` | Empty dir — needs `schema.ts`, query/mutation files, auth config |
| Ingest API route | `apps/web/app/api/ingest/` | Does not exist yet |
| Run list page | `apps/web/app/` | Does not exist yet |
| Run detail page | `apps/web/app/runs/[runId]/` | Does not exist yet |
| Replay UI | `apps/web/app/runs/[runId]/replay/` | Does not exist yet |
| Diff UI | `apps/web/app/runs/compare/` | Does not exist yet |

The `scripts/seed.ts` file imports from `@afr/contracts` — this will fail typecheck until the contracts package is built. This is expected and acceptable at the foundation stage.

---

## Known Constraints and Trade-offs

### 1. Convex Document Size Limit
Convex has a 1 MB document size limit. Event payloads must be externalized to blob storage above the threshold (default 8 KB). The externalization logic lives in the ingest API route. This is documented in the domain model but not yet implemented.

### 2. Convex Mutation Atomicity
`ingestEvents` writes all events in a batch atomically. If the batch is very large (e.g., 1000 events), the mutation may time out. The SDK should cap batch size at 50 events. This is a design constraint that should be documented in the SDK.

### 3. Clerk JWT Claims
The `orgId` is extracted from the Clerk JWT `org_id` claim. This means a user must have an active organization to interact with AFR. Users without an organization see an empty/onboarding state. This is the intended behavior but must be handled in the UI.

### 4. pnpm-lock.yaml Not Yet Generated
`pnpm install` has not been run in this session. The lockfile does not exist. CI will fail with `--frozen-lockfile` until the lockfile is committed. The first contributor to set up the project must run `pnpm install` and commit `pnpm-lock.yaml`.

### 5. TypeScript Project References Not Configured
The packages do not yet have `tsconfig.json` files with `references`. This is a known gap — `turbo typecheck` will work once each package has its own tsconfig extending the root.

### 6. No Zod in contracts Yet
The domain model docs describe Zod schemas for validation, but the contracts package doesn't have Zod as a dependency yet. This will be added in Prompt 2 when the contracts package is built.

---

## Next Decision Points

These decisions are deferred but need to be made before or during the next build prompt:

### Decision 1: Event Sequence Enforcement Strategy
**Question:** How strictly does the ingest mutation enforce contiguous sequence numbers?
- Option A: Reject any batch that has a gap (strict) — safe but loses events if SDK sends out-of-order
- Option B: Accept gaps, record them as metadata — forgiving but complicates replay
- Option C: Require client-side ordering guarantee only — simplest but trusts the SDK
**Recommendation:** Start with Option C (trust the SDK) in v1. Add gap detection as a warning in a later version.

### Decision 2: API Key vs. Session Auth for SDK Ingest
**Question:** How does the SDK authenticate to the ingest endpoint?
- Option A: Clerk session tokens — requires browser SDK or server-side Clerk client in agent code
- Option B: Long-lived API keys stored in Convex — simple for agent authors, requires key management UI
- Option C: Short-lived signed tokens — most secure, more complex
**Recommendation:** Option B (API keys) for v1. Key management UI is a small feature but enables the SDK to work from any runtime.

### Decision 3: Convex Auth Configuration
**Question:** Should Convex auth use Clerk's default JWT template or a custom template?
**Recommendation:** Use Clerk's default Convex JWT template, which includes `org_id` and `org_role` claims. Document the template configuration in the auth setup guide.

### Decision 4: Blob Storage Path Strategy
**Question:** Should blob paths include a content hash to enable deduplication?
- Current: `afr/{orgId}/{runId}/{eventId}-payload.json`
- Alternative: `afr/{orgId}/{runId}/{eventId}-{hash}.json`
**Recommendation:** Stick with the simpler path in v1. Deduplication is not a v1 requirement.

### Decision 5: Run Pre-Registration
**Question:** Does the SDK need to pre-register a run (create the run record) before sending events?
- Option A: Yes — SDK calls `POST /api/runs` first to get a `runId`, then sends events
- Option B: No — `ingestEvents` creates the run if it doesn't exist (upsert on first event)
- Option C: SDK generates runId client-side (UUID), ingest handles creation
**Recommendation:** Option C — SDK generates a UUID for `runId`. The ingest mutation upserts the run. This avoids the two-step flow and works offline-first.
