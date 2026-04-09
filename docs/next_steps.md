# Next Steps — Agent Flight Recorder

## Build Roadmap

This document defines the recommended sequence for follow-up build sessions, including exact prompt guidance for each session.

---

## Prompt 2: Contracts, Convex Schema, and Ingest

**Goal:** Build the data layer. After this prompt, events can be written to the database and types are fully defined.

**What gets built:**
- `packages/contracts/` — complete TypeScript types package (`@afr/contracts`):
  - All entity types: `Organization`, `Project`, `Agent`, `AgentVersion`, `Run`, `Event`, `Artifact`, `Comment`
  - All enum types: `RunStatus`, `EventKind`, `MemberRole`
  - Zod schemas for all ingest request bodies
  - `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- `convex/schema.ts` — full Convex schema for all tables, with indexes
- `convex/events.ts` — `ingestEvents` mutation, `listForRun` query, `get` query
- `convex/runs.ts` — `createRun`, `get`, `list` queries/mutations
- `convex/projects.ts` — `create`, `list` queries/mutations
- `convex/agents.ts` — `create`, `list`, `upsertVersion` mutations/queries
- `convex/artifacts.ts` — `create`, `getForEvent` mutation/query
- `convex/comments.ts` — `add`, `resolve`, `listForRun` mutations/queries
- `convex/auth.config.ts` — Clerk JWT configuration
- `convex/_helpers/orgScope.ts` — org-scoping utility for all queries
- `apps/web/app/api/ingest/events/route.ts` — POST ingest endpoint with blob externalization
- `apps/web/app/api/ingest/runs/route.ts` — POST run pre-registration (optional)

**Exact recommended prompt:**

> You are Team B (data/backend) building Agent Flight Recorder. The repository foundation is in place at /home/user/GunkHub. CLAUDE.md defines the project constitution — read it first.
>
> Build the complete data layer:
> 1. The `@afr/contracts` package at `packages/contracts/` — all entity types, EventKind enum, RunStatus enum, Zod schemas for ingest requests. This package imports from nothing else in the repo.
> 2. The Convex schema at `convex/schema.ts` — all tables with correct indexes for the query patterns described in docs/architecture.md.
> 3. All Convex query and mutation files for: events, runs, projects, agents, agentVersions, artifacts, comments.
> 4. Convex auth config for Clerk JWT verification.
> 5. The Next.js API route `POST /api/ingest/events` that validates, authenticates, externalizes large payloads to Vercel Blob, and calls the Convex ingestEvents mutation.
>
> Rules (enforced by CLAUDE.md):
> - Every Convex query must filter by orgId.
> - Events are append-only — no mutation may delete or update an event.
> - Use Zod schemas from @afr/contracts for request validation.
> - The contracts package must export all types used by SDK, web, and convex.

---

## Prompt 3: Web Application + Query Views

**Goal:** Build the browsable UI. After this prompt, engineers can sign in and navigate runs.

**What gets built:**
- `apps/web/` — complete Next.js 15 app scaffold:
  - `package.json`, `tsconfig.json`, `tailwind.config.ts`, `next.config.ts`
  - `app/layout.tsx` — root layout with Clerk provider, Convex provider
  - `app/page.tsx` — dashboard / org overview
  - `app/(app)/projects/[projectId]/runs/page.tsx` — run list with filters
  - `app/(app)/runs/[runId]/page.tsx` — run detail with event log
  - `app/(app)/runs/[runId]/layout.tsx` — run context (agent, version, status)
  - `components/run/EventLog.tsx` — event timeline with kind icons
  - `components/run/EventDetail.tsx` — payload viewer (inline + blob fetch)
  - `components/run/RunStatusBadge.tsx` — status indicator
  - `components/layout/Sidebar.tsx`, `Header.tsx`
  - Loading, empty, and error states for all data-fetching components
  - Sign-in / sign-up pages via Clerk

**Exact recommended prompt:**

> You are Team C (frontend/UI) building Agent Flight Recorder. The repository foundation is at /home/user/GunkHub. The contracts package (@afr/contracts) and Convex backend are complete. Read CLAUDE.md before starting.
>
> Build the complete Next.js 15 web application in apps/web/:
> 1. App scaffold: package.json, tsconfig.json, tailwind config, next.config.ts with Convex + Clerk.
> 2. Root layout with ClerkProvider and ConvexProvider.
> 3. Authentication pages (sign-in, sign-up) using Clerk's prebuilt components.
> 4. Dashboard page: list of projects in the active organization.
> 5. Run list page: runs for a project, filtered by status and agent, sorted by date desc.
> 6. Run detail page: full event log for a run as a scrollable chronological timeline.
> 7. EventDetail panel: clicking an event shows the full payload, with blob fetch for externalized payloads.
>
> Design rules (from CLAUDE.md):
> - Calm, technical, high-signal UI. No decorative noise.
> - All data-fetching components must have loading, empty, AND error states.
> - Loading states use skeleton screens matching content shape.
> - No layout shift on load.

---

## Prompt 4: Replay Walker

**Goal:** Build the step-through replay UI. After this prompt, engineers can walk through a run event-by-event.

**What gets built:**
- `app/(app)/runs/[runId]/replay/page.tsx` — replay mode page
- `components/replay/ReplayWalker.tsx` — event cursor, step forward/back controls
- `components/replay/ReplayEventPanel.tsx` — contextual rendering per event kind
- `components/replay/LLMConversationView.tsx` — chat-style rendering of llm.request/response
- `components/replay/ToolCallView.tsx` — tool call/result pair renderer
- `components/replay/ReplayTimeline.tsx` — minimap sidebar with current cursor position
- Keyboard shortcuts: Arrow keys to step, Home/End to jump, Escape to exit
- Deep-link support: `/runs/[runId]/replay?seq=14` jumps to a specific event
- `convex/replays.ts` — `initReplay` mutation (creates a ephemeral replay session record, optional)

**Exact recommended prompt:**

> You are Team C (frontend/UI) building Agent Flight Recorder. The run detail page and event log viewer are complete. Read CLAUDE.md before starting.
>
> Build the replay walker feature in apps/web/:
> 1. A replay page at /runs/[runId]/replay that fetches all events for the run.
> 2. A ReplayWalker component that maintains a cursor (current seq number) in local state.
> 3. Controls: step forward, step back, jump to beginning, jump to end.
> 4. Keyboard support: ArrowRight/ArrowDown = next event, ArrowLeft/ArrowUp = previous.
> 5. For each event, render a contextual panel based on event kind:
>    - llm.request / llm.response: render as a chat conversation view
>    - tool.call / tool.result: render as a paired call/response view
>    - run.started / run.finished / run.error: render metadata view
> 6. A timeline sidebar that shows all events as a list, with the current cursor highlighted.
> 7. Deep-link support: ?seq=N in the URL jumps to that sequence position on load.
>
> Important: Replay is read-only. No mutations. The UI only reads from the event log.

---

## Prompt 5: Diff Viewer

**Goal:** Build side-by-side run comparison. After this prompt, engineers can compare two runs.

**What gets built:**
- `app/(app)/runs/compare/page.tsx` — diff viewer with ?a=runId&b=runId params
- `components/diff/RunDiffView.tsx` — two-column event list with alignment
- `components/diff/DiffEventRow.tsx` — event row with match/added/removed/changed styling
- `components/diff/PayloadDiff.tsx` — JSON diff view for two event payloads
- `lib/diff/alignEvents.ts` — algorithm to align events from two runs by kind and index
- `lib/diff/diffPayload.ts` — JSON structural diff (added/removed/changed keys)
- Run selection UI: from run list, select two runs and navigate to compare page

**Exact recommended prompt:**

> You are Team C (frontend/UI) building Agent Flight Recorder. The replay walker is complete. Read CLAUDE.md before starting.
>
> Build the run diff viewer feature in apps/web/:
> 1. A compare page at /runs/compare?a=[runIdA]&b=[runIdB] that fetches events for both runs.
> 2. An alignment algorithm in lib/diff/alignEvents.ts that pairs events from run A and run B by kind and relative position (seq within kind-group). Unmatched events are marked as added or removed.
> 3. A two-column diff view: run A events on the left, run B events on the right.
> 4. Each row shows the event kind, seq, and a diff status badge: match | changed | added | removed.
> 5. Clicking a row expands to show a side-by-side JSON diff of the two event payloads.
> 6. A summary header: N events in A, M events in B, X matching, Y changed, Z added/removed.
> 7. A "Select runs to compare" flow from the run list page: select two checkboxes → "Compare" button.
>
> Diff is read-only. No mutations. The diff is computed client-side from the event data.

---

## Risks to Address Early (Before Prompt 2)

### High Priority

1. **API Key authentication design.** The SDK needs to authenticate without a browser Clerk session. Design and build the `apiKeys` Convex table and key generation UI before the SDK is built. This is a blocker for SDK testing.

2. **pnpm-lock.yaml.** Run `pnpm install` locally to generate the lockfile and commit it. CI will fail without it (uses `--frozen-lockfile`).

3. **Convex deployment credentials.** Set up the Convex project and run `npx convex dev` at least once to generate `convex/_generated/`. Without this, `@afr/contracts` cannot import from `convex/_generated/api` if that pattern is used.

### Medium Priority

4. **Event kind exhaustiveness checks.** When `EventKind` is defined in contracts, add a `assertNever` utility and use it in all switch statements that enumerate event kinds. This makes adding a new kind a compile-time error in all switch statements until handled.

5. **Seed data connectivity.** `scripts/seed.ts` will typecheck-fail until `@afr/contracts` is built. Either stub the types locally in the seed file (temporarily) or build contracts first.

6. **Blob storage setup.** The Vercel Blob token (`BLOB_READ_WRITE_TOKEN`) must be configured before the ingest endpoint can externalize large payloads. Ensure this is set in local `.env.local` before testing ingest.

### Lower Priority

7. **Run retention policy.** No data TTL is defined. For a debugging tool, indefinite retention is fine in development, but should be addressed before any production usage with real customer data.

8. **Error handling in the ingest route.** The ingest route must handle partial failures gracefully — if blob write succeeds but Convex mutation fails, the blob is orphaned. Add cleanup logic or idempotency keys in Prompt 2.
