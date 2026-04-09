# Working Memory — Agent Flight Recorder

**Read this file first in every new Claude session before touching any code.**

Last updated: 2026-04-09 (Prompt 1 — Initial Foundation)

---

## 1. Current State

Prompt 1 (Initial Foundation) is complete. The following has been built:

**Repo skeleton is in place.** pnpm workspace with Turborepo, TypeScript strict mode, ESLint, Prettier, `tsconfig.base.json`. All packages typecheck cleanly. `./scripts/validate.sh` runs typecheck → build → lint and reports pass/fail.

**Convex schema is fully defined** (`convex/schema.ts`). All 8 tables are defined: `organizations`, `projects`, `agents`, `agent_versions`, `runs`, `events`, `artifacts`, `comments`, `user_memberships`. All indexes are in place. The schema is the ground truth for data shape.

**Convex queries and mutations are implemented** (not stubbed) for:
- `convex/runs.ts` — `listRuns`, `getRun`, `createRun`, `updateRunStatus`
- `convex/events.ts` — `listEvents`, `getEvent`, `createEvent`
- `convex/artifacts.ts` — `listArtifacts`, `createArtifact`
- Auth helpers: `getAuthContext()`, `requireOrgMembership()` in `convex/auth.ts`

**packages/contracts is fully defined.** All shared types:
- `entities.ts` — Organization, Project, Agent, AgentVersion, Run, Event, Artifact, Comment
- `events.ts` — EventType union, all payload shapes, EventPayload discriminated union
- `status.ts` — RunStatus, RunStatusValues, isTerminalStatus()
- `api.ts` — All API request/response types
- `replay.ts` — ReplayProjection, ReplayFrame
- `diff.ts` — RunDiff, EventDiff, DiffSummary, FieldChange

**packages/sdk is implemented (except HTTP transport).** The `Recorder` class, `Events` builders, `buildEvent` helper, `HttpTransport` (stubbed), `Transport` interface, all types. The SDK is functional end-to-end when a `MockTransport` is injected (as in tests).

**apps/web components and service layer are scaffolded** (many are stubs):
- UI primitives: Badge, Button, Card, CodeBlock, EmptyState, ErrorState, LoadingState, Tabs
- Layout: AppShell, PageHeader, Sidebar
- Run components: RunList, RunHeader, Timeline, EventInspector, DiffViewer, ReplayViewer, ArtifactList, CommentThread
- Service layer stubs: `lib/services/runs.ts`, `lib/services/events.ts`, `lib/services/comments.ts` — all return empty/fake data with TODO comments
- No Next.js pages exist yet (no `app/` directory)

**Tests scaffolded:**
- `tests/unit/sdk.test.ts` — Recorder tests with MockTransport, passing
- `tests/unit/contracts.test.ts` — Type shape and EventType coverage tests
- `tests/integration/api.test.ts` — Stub, marked as TODO
- `tests/fixtures/runs.ts` — Sample run/event fixture data

---

## 2. Key Decisions Made

1. **pnpm + Turborepo monorepo.** Single deployment unit. Turborepo caches build artifacts. All packages share one `node_modules`. (See ADR-0001)

2. **Event log is append-only and immutable.** No `updateEvent` or `deleteEvent`. The event sequence is the ground truth. Replay and diff are computed projections. (See ADR-0002)

3. **Organization is the tenancy boundary.** Maps to Clerk org ID. Every Convex query must filter by `orgId`. (See ADR-0003)

4. **packages/contracts is the single source of type truth.** Zero runtime dependencies. All packages import shared types from here. (See ADR-0004)

5. **Convex over traditional ORM.** Real-time subscriptions future, built-in Clerk auth, type-safe queries, no connection pooling. Trade-off: hosted vendor, no SQL JOINs.

6. **Next.js API routes as the ingestion surface.** SDK calls Next.js, Next.js calls Convex mutations. Browser UI uses Convex React hooks directly. This keeps ingest auth and SDK routing logic in one layer.

7. **Payload externalization threshold: 10 KB.** Payloads over 10 KB go to blob storage. Pointer stored in event record. Keeps Convex documents small. Enforced by SDK before shipping.

8. **BlobStorageAdapter as an interface.** Blob provider is swappable. `convex/helpers/storage.ts` defines the interface. No concrete implementation in v1 — stub comment points to Prompt 2/3.

9. **Sequence numbers are SDK-assigned.** The SDK increments a local counter. Backend validates contiguity. This avoids a round-trip to get the next sequence number before each event.

10. **`run.started` event is always seq=1; terminal event is always last.** Enforced by convention in SDK; validated in `createEvent` mutation logic (run must be in "running" state).

11. **Roles: admin / member / viewer.** Defined on `UserMembership`. Not yet enforced in mutations beyond basic membership check — full RBAC is Prompt 3+ scope.

12. **Modular monolith architecture.** One Vercel deployment. Seams exist for future extraction (ingest layer, blob storage, projections). (See ADR-0001)

13. **TypeScript strict mode throughout.** `strict: true` in `tsconfig.base.json`. ESLint enforces `import type` for type-only imports, no cross-package relative imports.

14. **No React UI library.** Build from Tailwind primitives. No shadcn, MUI, or Radix. Keeps dependency surface clean, enforces the "calm technical" design language.

15. **`AgentVersion` is immutable once created.** No update mutation. Code changes create a new version. This preserves historical accuracy — a Run always knows exactly what ran.

---

## 3. Open Questions (Future Prompts Must Resolve)

**HIGH PRIORITY (Prompt 2):**

- [ ] **How does the SDK authenticate to the Next.js API routes?** Current transport stubs send an `apiKey`. There is no `api_keys` table in the Convex schema yet. Do we use Clerk org tokens or a separate API key system? Decision needed before ingestion pipeline works end-to-end.

- [ ] **How does Next.js call Convex mutations server-side?** The service layer stubs in `apps/web/src/lib/services/` need to call Convex. This requires `ConvexHttpClient` (server-side) vs `useConvexMutation` (client-side). Need to decide: are API route handlers server-side Convex calls, or do they use a service account token?

- [ ] **What is the env var shape?** `apps/web/src/lib/env.ts` validates `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_CONVEX_URL`. But `CLERK_SECRET_KEY`, `CONVEX_DEPLOYMENT`, `BLOB_READ_WRITE_TOKEN` (Vercel Blob), and any API key secret are not yet documented in `.env.example`. Need a complete `.env.example`.

- [ ] **No Next.js pages exist.** The `apps/web/src/app/` directory is missing. All routes need to be created. At minimum: layout, sign-in, dashboard, project list, run list, run detail.

**MEDIUM PRIORITY (Prompt 3):**

- [ ] **Replay computation belongs where?** ReplayProjection is a contract type. Is it computed in the web app service layer, in a Convex query, or in the browser? Decision affects where `elapsed_ms` arithmetic lives.

- [ ] **RunDiff alignment strategy.** Events from two runs are aligned by `sequenceNumber` in the current diff contract. Is this correct? If two agent versions have different tool call sequences (different lengths), alignment-by-sequence-number will produce noisy diffs. May need alignment by event type or semantic proximity.

- [ ] **Blob storage implementation.** The `BlobStorageAdapter` stub needs a real implementation. Vercel Blob is the likely first choice — but `BLOB_READ_WRITE_TOKEN` must be in `.env.example` before this is wired up.

- [ ] **Comments mutations (`createComment`, `resolveComment`) are missing.** `convex/comments.ts` needs to be implemented. Currently the file exists but no mutations are implemented for comments.

**LOWER PRIORITY (Prompt 4+):**

- [ ] **`convex/organizations.ts` and `convex/projects.ts` are not fully implemented.** `createOrg`, `listProjects`, `createProject` stubs need implementation.

- [ ] **SDK `HttpTransport` is fully stubbed.** All three methods throw `not yet implemented`. This needs to be implemented in Prompt 2 alongside the API routes.

- [ ] **Integration tests are all stubs.** `tests/integration/api.test.ts` needs a test runner against a dev Convex deployment.

- [ ] **No `.env.example` file.** Must be created before Prompt 2.

---

## 4. Known Stubs

| File | What is Stubbed | What It Needs |
|------|----------------|---------------|
| `packages/sdk/src/transport.ts` — `HttpTransport` | All three methods throw | Real `fetch` calls to `/api/runs`, `/api/events`, `/api/runs/:id/status` with auth headers, retry logic |
| `apps/web/src/lib/services/runs.ts` | Returns empty/fake data | Real Convex calls via `ConvexHttpClient` or Convex React hooks |
| `apps/web/src/lib/services/events.ts` | Returns empty array | Same |
| `apps/web/src/lib/services/comments.ts` | Returns empty array | Same |
| `convex/helpers/storage.ts` — `BlobStorageAdapter` | Interface only, no implementation | Vercel Blob implementation (Prompt 3) |
| `convex/comments.ts` | File likely exists with no mutations | Need `createComment`, `resolveComment`, `listComments` |
| `convex/organizations.ts` | Partially implemented | Need `createOrg`, `getOrgByClerkId` |
| `convex/projects.ts` | Partially implemented | Need `listProjects`, `createProject` |
| `apps/web/src/app/` | Does not exist | All Next.js pages and layouts |
| `tests/integration/api.test.ts` | All tests are stubs | Real integration tests against dev Convex |

---

## 5. Dependency Map

```
packages/contracts
  └── no dependencies (pure TypeScript + Zod if added)

packages/sdk
  └── depends on: packages/contracts
      (imports: EventType, EventPayload, RunStatus, CreateRunRequest, etc.)

apps/web
  └── depends on: packages/contracts
      (imports: entity types, API shapes)
  └── does NOT depend on: packages/sdk
      (web app is the server, not the client)

convex/
  └── depends on: packages/contracts
      (would import: entity types for type alignment)
  └── does NOT depend on: packages/sdk, apps/web

tests/
  └── depends on: packages/sdk, packages/contracts
      (unit tests import Recorder, Events, contract types)
```

**Workspace package names:**
- `@agent-flight-recorder/contracts`
- `@agent-flight-recorder/sdk`
- `@agent-flight-recorder/web` (apps/web)

---

## 6. Where to Find Things

| What | Where |
|------|-------|
| Shared TypeScript types (entities, events, API) | `packages/contracts/src/` |
| Convex schema (all table definitions) | `convex/schema.ts` |
| Convex auth helpers | `convex/auth.ts` |
| Convex run queries/mutations | `convex/runs.ts` |
| Convex event queries/mutations | `convex/events.ts` |
| Convex artifact queries/mutations | `convex/artifacts.ts` |
| Blob storage interface | `convex/helpers/storage.ts` |
| Pagination constants | `convex/helpers/pagination.ts` |
| SDK public entry point | `packages/sdk/src/index.ts` |
| SDK Recorder class | `packages/sdk/src/recorder.ts` |
| SDK event builders | `packages/sdk/src/events.ts` |
| SDK Transport interface + HttpTransport stub | `packages/sdk/src/transport.ts` |
| SDK config types | `packages/sdk/src/types.ts` |
| Web service layer (run operations) | `apps/web/src/lib/services/runs.ts` |
| Web env validation | `apps/web/src/lib/env.ts` |
| Web UI primitives | `apps/web/src/components/ui/` |
| Web layout components | `apps/web/src/components/layout/` |
| Web run-specific components | `apps/web/src/components/runs/` |
| CI validation script | `scripts/validate.sh` |
| Dev seeding script | `scripts/seed.ts` |
| Unit tests | `tests/unit/` |
| Test fixtures | `tests/fixtures/` |
| Project constitution (read first) | `CLAUDE.md` |
| Architecture decisions | `docs/adrs/` |
| Product specification | `docs/product_spec.md` |
| Domain model | `docs/product_model.md` |
| Architecture guide | `docs/architecture.md` |
| Next steps for Prompt 2 | `docs/next_steps.md` |

---

## 7. Gotchas

**Convex ID types vs string IDs in contracts.**
The Convex schema uses typed IDs (`v.id("runs")`) which produce `Id<"runs">` types. The `packages/contracts` entities use `string` for all IDs. When calling Convex mutations from the web app, you must cast string IDs to `Id<"tableName">` using Convex's `Id` helper. Do not confuse these — they look like strings but Convex enforces the type at runtime.

**`run.status` is a string in Convex schema, not an enum.**
In `convex/schema.ts`, the status field is defined as `v.union(v.literal("pending"), ...)`. This means Convex validates it as a string union at runtime. The `RunStatus` type in `packages/contracts/src/status.ts` is the TypeScript type alias. They must stay in sync — if you add a status to one, add it to both.

**`v.any()` in the `events` table payload field.**
`events.payload` is `v.any()` in the schema because the payload is a discriminated union that Convex cannot express with its validator DSL. This means Convex does not type-check payloads at insert time. TypeScript type safety is enforced at the `createEvent` mutation's args level by consuming the `EventPayload` type from contracts. Do not remove the TypeScript types assuming Convex validates them — it does not.

**The `events` table has no `updateEvent` mutation, by design.**
If you find yourself wanting to update an event, you are doing something wrong. Review the ADR-0002. If you genuinely need an escape hatch, write a new ADR first.

**`apps/web` does not have an `app/` directory yet.**
Next.js 14 App Router requires an `app/` directory. It does not exist. Do not try to run the web app dev server until it is created in Prompt 2.

**SDK `HttpTransport` throws on all methods.**
All three `HttpTransport` methods throw `not yet implemented`. If you run the SDK's integration path, it will fail. Unit tests work because they inject `MockTransport`. Do not wire the SDK to a real endpoint until Prompt 2 implements the Next.js API routes and `HttpTransport`.

**No `.env.example` exists.**
Before any developer can run the project, `.env.example` must be created. Required vars at minimum: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT`. Create this early in Prompt 2.

**Convex `paginate()` returns `{ page, isDone, continueCursor }`.**
The `listRuns` and `listEvents` queries use Convex's built-in pagination. The response shape is not a simple array — it is a page object. The service layer must unwrap `page.page` to get the records array. This is already done correctly in `convex/runs.ts` and `convex/events.ts`, but watch for it when writing new queries.

**`parentEventId` enables a DAG, not just a list.**
Events can have a `parentEventId` referencing another event in the same run. This means the event sequence is technically a directed acyclic graph (tool.call → http.request → http.response, all parented to a common llm.request). The timeline UI and replay logic must handle both the linear (sequence) and tree (parent) views. Do not assume events are a flat list.

**Turborepo task ordering.**
`pnpm build` via Turborepo builds `packages/contracts` and `packages/sdk` before `apps/web`. If you add a new package dependency, update `turbo.json` (root level) to declare it in the `dependsOn` field. Otherwise Turborepo may build in the wrong order and produce stale type artifacts.
