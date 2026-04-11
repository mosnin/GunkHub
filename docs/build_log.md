# Build Log — Agent Flight Recorder

---

## Prompt 19 — Scheduled Verification, Auth Hardening, IntegrityBadge (2026-04-11)

### What changed

**A. convex/projection_verify.ts — Daily scheduled integrity verification**
- New Convex scheduled action running at 04:30 UTC via `convex/crons.ts`.
- Queries up to 50 recent terminal runs (completed or failed) within a 48-hour window (BATCH_LIMIT = 50, WINDOW_MS = 48 * 60 * 60 * 1000).
- For each run, fetches all events and calls `checkSequenceIntegrity(seqNums)`: detects gaps in the 1..max range and duplicate sequence numbers.
- Stores per-run results in a new `verification_results` Convex table: `runId`, `isValid`, `sequenceGaps`, `duplicateSeqNums`, `summary`, `checkedAt`.
- The `checkSequenceIntegrity` function is inlined in the Convex action because Convex actions cannot import from `apps/web` context. Logic duplication is documented in ADR-0020 and covered by unit tests in `tests/unit/scheduled_verify.test.ts`.

**B. convex/comments.ts — listComments auth fix**
- `listComments` previously could be called without an `orgId` argument, meaning callers could theoretically query comments without proving org membership. The query now requires `orgId: v.id("organizations")` as a mandatory argument and calls `requireOrgMembership(ctx, args.orgId)` before any data access.
- A `.filter((q) => q.eq(q.field("orgId"), args.orgId))` guard is applied after the index query to ensure no cross-org records are returned even if the index scan produced unexpected results.
- All callers in `apps/web/src/lib/services/comments.ts` have been updated to pass `orgId`.

**C. apps/web/app/api/artifacts/[id]/download/route.ts — orgId route guard**
- The artifact download route now checks `orgId` at the route level in addition to `userId`. Previously only `userId` (Clerk session) was checked; the org membership verification happened only inside the Convex service call. The route now extracts the Clerk org ID from the session and passes it as an explicit guard before the Convex call, matching the pattern used by other API routes.

**D. apps/web/src/components/runs/IntegrityBadge.tsx — UI component**
- New `IntegrityBadge` component on the run detail page. Displays a green "Sequence OK" badge when the most recent `verification_results` record for the run is valid, an amber "Sequence warning" badge when invalid, and nothing when no verification has run yet.
- Wired into the run detail page header next to the status badge.

**E. tests/unit/scheduled_verify.test.ts — NEW (Team D)**
- 57 pure logic tests across 5 groups: valid sequences (11 tests), sequence gaps (8 tests), duplicate sequence numbers (8 tests), summary string content (13 tests), bounded window constants (7 tests).
- All tests inline `checkSequenceIntegrity` and the BATCH_LIMIT / WINDOW_MS constants — no Convex, no network, no React.

**F. tests/unit/read_path_auth.test.ts — NEW (Team D)**
- 15 pure logic tests across 2 groups: comments auth requirement (5 tests asserting orgId filter correctness), artifact download route auth (10 tests asserting AND-gated userId+orgId guard logic).

### Why these choices fit the architecture

**Scheduled verification scope (ADR-0020):** The 50-run BATCH_LIMIT and 48-hour window are the smallest scope that provides actionable coverage without risking cron timeout. The daily cadence at 04:30 UTC (low-traffic window) matches the stale run expiry cron pattern (ADR-0017). Sequence gap and duplicate detection are the only checks that can be done inside the Convex runtime — `buildReplayProjection` lives in `apps/web` and cannot cross the runtime boundary.

**listComments auth fix:** The original query fetched comments via the `by_target` index then filtered by `orgId`, but the `orgId` was not a required argument — it was implicitly assumed to match the caller's org. Making it a required argument and calling `requireOrgMembership` before data access brings the query into compliance with the tenancy rule: auth must be checked before any data access (CLAUDE.md Tenancy Rules §5). This is a breaking API change documented as hard-to-reverse below.

**Artifact download orgId guard:** The existing route already called a Convex query that enforced org membership, but that check was inside the service layer, not at the HTTP boundary. Moving the check to the route level makes the boundary explicit and consistent with how other org-scoped routes are structured.

### Hard-to-reverse decisions

**verification_results table:** Once deployed to Convex, the table is a permanent schema fixture. Removing it requires a Convex schema migration (drop table definition + purge existing documents) coordinated with a deployment. This table should not be added without the cron action being deployed in the same change set.

**listComments signature change:** `orgId` is now a required argument. Any caller that invoked `listComments` without `orgId` will receive a Convex validation error after this change. All internal callers in `apps/web` have been updated. If any external tooling or scripts called the Convex function directly, they must also be updated. This cannot be rolled back without reverting the schema change, which would re-open the auth gap.

### Known residual risks

1. **Inline logic duplication:** `checkSequenceIntegrity` exists in both `convex/projection_verify.ts` and `tests/unit/scheduled_verify.test.ts`. If the algorithm is updated in one place without updating the other, production behavior will diverge from the tested behavior. Mitigate by always updating both in the same PR.
2. **buildReplayProjection not called from cron:** If a bug in the projection algorithm causes exceptions for specific event sequences, the cron will not surface it. Only unit tests cover that code path. Engineers should not interpret a green verification badge as proof that the replay tab will render correctly.
3. **50-run cap at high volume:** At sustained volumes above 50 terminal runs per 24 hours, the cron verifies only the 50 most recent runs. Older runs in the window are skipped. Acceptable at v1 scale.
4. **IntegrityBadge shows stale data between cron runs:** The badge reflects the last verification result, which may be up to 24 hours old. A run with fresh corruption will show no badge (or the prior green badge) until the next 04:30 UTC cron.

### Recommendation for Prompt 20

**Follow-tail toggle** is the highest-value remaining UX improvement: users who scroll backward in a live run's Timeline/EventInspector lose their position each time the auto-advance window fires. A sticky "follow tail" toggle (on by default) lets users pin to the latest events without disruption when they are debugging.

**Replay tab live refresh** is the next highest-value item: the replay projection is stale for running runs. A periodic re-fetch of the replay endpoint (similar to RunHeader's 5s status poll) would keep the replay tab current without a full page reload.

**RBAC viewer-vs-member on read paths** is deferred but increasingly important now that the read-path auth pattern has been tightened in Prompt 19.

---

## Prompt 18 — Live Run Monitoring (2026-04-11)

### What changed

**A. Timeline.tsx — Auto-advance + live polling**
- Auto-advance: after server-side Load more, `windowStart` advances to `max(0, newTotal - WINDOW_SIZE)`. Eliminates the two-click friction from Prompt 17.
- `isLive` prop: 5s polling — cursor path (paginated continuation) and no-cursor path (re-fetch + dedup by ID). Shows animate-pulse "live" indicator.

**B. EventInspector.tsx — Auto-advance + live polling**
- Same auto-advance and 5s polling as Timeline.
- Selection stability: polling never modifies `selectedId` or `focusedIdx`.
- Live dot in the Events left-panel header.

**C. RunHeader.tsx — Live status polling**
- `isLive` prop: polls `GET /api/runs/${runId}` every 5s when `liveStatus === 'running'`.
- Updates `liveStatus` and `liveEndedAt` in local state; stops when terminal.
- Shows animate-pulse "live" label next to the status badge.

**D. page.tsx — isLive wiring**
- Passes `isLive={run.status === 'running'}` to RunHeader, Timeline, and EventInspector.

### Why these choices fit the architecture

Polling was chosen over Convex real-time subscriptions because the web app's Convex integration is server-side only (`getAuthedClient()` in the service layer). Adding client-side Convex subscriptions would require `ConvexReactClient` + `ConvexProvider` — a larger architectural addition not yet in the repo and not needed for v1 live monitoring.

The 5-second cadence is conservative and easy to reason about. For short runs (< 200 events), the re-fetch approach adds a small amount of redundant data transfer, but the simplicity is worth it.

### Hard-to-reverse decisions

None. Polling is fully reversible — the `isLive` prop and interval effects can be replaced with real-time subscriptions without changing the component API.

### Known residual risks

1. **Re-fetch overhead on small runs**: Polling from start fetches up to 200 events every 5s until the run crosses 200 events. For fast runs with many small events, this is ~10–50 KB/poll, acceptable for v1.
2. **No server-push backpressure**: If the run generates events faster than the 5s poll can consume, users see batched jumps rather than a smooth tail. Acceptable for v1.
3. **isLive not reset on status change**: Once the page renders with `isLive=true`, Timeline/EventInspector keep their intervals running until unmount, even if the run completes mid-session. The RunHeader updates its badge (correct status shown), but Timeline/EventInspector continue harmless empty polls. A future improvement could read `liveStatus` from RunHeader or context and clear the intervals.

### Recommendation for Prompt 19

The most impactful remaining gap: **replay tab live refresh**. The replay projection is computed server-side from the event log; running runs show a stale projection until page reload. A client-side hook or route re-fetch could regenerate the projection periodically for running runs.

Second: **window auto-tail toggle** — a "follow tail" toggle that automatically keeps the window anchored to the latest events as polling delivers them, vs. the current behavior where the window advances on each poll but the user can manually navigate away.

---

## Prompt 17 — Bounded rendering, deep link auto-seek, version pagination (2026-04-11)

### What changed

- **Timeline.tsx rewrite (Team A):** Added `WINDOW_SIZE = 100` constant and `windowStart` state (default 0). Renders only `allEvents.slice(windowStart, windowStart + WINDOW_SIZE)` (visibleEvents). Keyboard navigation maps each visible event with `absIdx = windowStart + relIdx` so the focus ring is correct across window shifts. "↑ N earlier events" button appears when `windowStart > 0`; "↓ N more loaded events" button appears when `windowEnd < allEvents.length`. ArrowDown/ArrowUp at a window edge shifts `windowStart` rather than clipping at the window boundary.
- **EventInspector.tsx rewrite (Team B):** Same `WINDOW_SIZE = 100` sliding window for the left event panel. Click events call `ensureSelectedVisible` to adjust `windowStart` so the selected event stays visible. Deep link auto-seek: if `initialEventSeq` is not present in the initially loaded events and a cursor exists, EventInspector sets `seekState='seeking'` and auto-triggers `handleLoadMore()` in a loop until the target event is found or the cursor is exhausted. "Seeking event #N…" banner shown during seek; "Event #N not found in this run." shown when exhausted.
- **Version pagination (Team C):** New Convex query `paginateAgentVersions` using `.paginate()`, 20 items/page, 100 max. New service function `listAgentVersionsPaginated`. New API route `GET /api/agents/[agentId]/versions?cursor=...&limit=N` with `parseVersionsParams` query-param parsing. `VersionSection` component now accepts `nextCursor: string | null` and renders a "Load more versions…" button when `nextCursor` is non-null.
- **New tests (Team D):** `tests/unit/timeline_window.test.ts` (25 pure logic tests) and `tests/unit/version_pagination.test.ts` (14 pure logic tests). Both files inline the algorithms rather than importing from source, keeping tests offline and instant. Test total: **554 passing, 5 skipped, 20 test files**.

### Why these choices fit the architecture

**Bounded window (not react-window):** The sliding window approach requires zero new runtime dependencies and fits naturally within the existing component state model. `WINDOW_SIZE = 100` was chosen because it keeps DOM node count well within browser paint budget for a debugging tool while still showing enough context to understand event sequences. The window is bidirectional — users can navigate up and down — so no events are permanently inaccessible. Full `react-window` virtualization would require a fixed-height row contract and would complicate the existing keyboard-navigation and copy-link features; the window approach avoids both problems.

**Deep link auto-seek:** Rather than requiring the caller to know which page of a run contains a specific event, the EventInspector self-heals by loading pages until the event is found. This keeps the `?event=<sequenceNumber>` URL contract simple and stable. The tradeoff is that deep links to events late in a very long run may require multiple round-trips before the event is found — see residual risks below.

**Version pagination via Convex `.paginate()`:** This is the canonical Convex cursor-based pagination primitive. The 20-items-per-page default matches common UX convention; the 100-item max prevents runaway queries. The `nextCursor` passthrough from Convex through the service layer and API route to the component keeps the cursor opaque — no layer interprets or constructs it.

### Hard-to-reverse decisions

None. The sliding window approach is fully reversible: removing the window and rendering all events would restore the previous behavior. The version pagination cursor API is additive — the `VersionSection` component degrades gracefully when `nextCursor` is null (no button shown). The deep link auto-seek can be disabled by removing the `useEffect` that triggers it without any schema or API changes.

### Known residual risks

1. **Deep link auto-seek is O(pages).** If a run has 5,000 events at 200 events per server page, seeking to event #4,900 requires loading 24 pages before the event appears. Each page is a separate Convex query. For very long runs, this seek loop is noticeable. A mitigation would be a Convex query that returns the page number containing a specific `sequenceNumber`, but this would require a new query endpoint.
2. **Timeline "load more" and window advance are two separate user actions.** After clicking "Load more" to fetch the next server page, the newly loaded events appear in `allEvents` but are not automatically brought into the visible window — the user must also click "↓ N more loaded events" to advance the window. Auto-advancing the window after a server load-more would collapse this into one click. See Prompt 18 candidates in `next_steps.md`.
3. **Version uniqueness check in `createAgentVersion` still uses `.collect()`.** The mutation scans all existing versions for the agent to enforce uniqueness. This is O(n) per mutation but correct at v1 scale (agents typically have <50 versions). A dedicated index would eliminate the scan.

### Recommendation for Prompt 18

**Live run monitoring** (Convex real-time subscription on the events list so Timeline updates automatically while a run is in progress) is the highest-value next step — it is the feature that most directly improves the debugging workflow for in-flight failures. Second priority: **auto-advance window on server load-more completion** to collapse the two-click pattern into one.

---

## Prompt 16 — Artifact download error UX + upload cache dedup tests (2026-04-11)

### What changed

- Audited `packages/sdk/src/transport.ts` `sendEvents()` — auto-externalization was already fully implemented (upload to `/api/artifacts/upload`, replace payload with `ExternalizedPayload` pointer, per-`sendEvents` upload cache). The "SDK auto-externalization missing" note in prior working memory was stale; no SDK source changes were needed.
- Rewrote `apps/web/src/components/runs/ArtifactList.tsx` as a `'use client'` component with programmatic `fetch('/api/artifacts/${id}/download')`, per-row `downloadStates` tracking `{ downloading, error }`, structured `{ code, message }` JSON error parsing for 401/404/502/500 responses with inline `text-red-400` error display, blob download via `URL.createObjectURL` + hidden `<a>` ref with 10s object URL revocation, and `extractFilename()` with RFC 5987 `filename*=UTF-8''...` support before falling back to plain `filename=` and then `artifact.name ?? artifact.id`.
- Added Group 6 to `tests/unit/transport-externalization.test.ts`: two upload cache deduplication tests asserting `_uploadArtifact` is called once for identical large payloads in the same batch, and twice for different large payloads, with `artifactId` consistency verified in externalized event bodies.

### Why these choices fit the architecture

The artifact download rewrite follows the established pattern for client-side error UX: the server route returns structured `{ code, message }` JSON errors; the client component parses and displays them inline rather than relying on browser default error handling. The RFC 5987 filename extraction mirrors how modern browsers handle `Content-Disposition` headers, ensuring engineers see sensible default filenames when downloading payloads.

### Hard-to-reverse decisions

None. The `ArtifactList` rewrite is a component-level change with no schema or API contract implications.

### Known residual risks

None beyond those carried from Prompt 15.

---

## Prompt 15 — Run detail breadcrumb + schema drift check (2026-04-11)

### What changed

- Added `RunBreadcrumb.tsx` component that renders `Organization → Project → Agent → Run <id>` with links to each level
- Added `getAgent()` service function in `apps/web/src/lib/services/agents.ts` for server-side single-agent fetch
- Wired breadcrumb into `apps/web/app/(app)/runs/[runId]/page.tsx` — the run detail page now fetches project and agent context and renders the breadcrumb above `RunHeader`
- Added `scripts/check-schema-drift.ts` — parses `convex/schema.ts` and `packages/contracts/src/entities.ts` with regex-based field extraction, compares the two sets per entity, and exits non-zero on any mismatch
- Updated `scripts/validate.sh` to run the drift check as a fourth step after typecheck, build, and lint
- Updated `.github/workflows/ci.yml` to include a `schema-drift` job that runs on every push and pull request
- Updated `docs/ops/ci_setup.md` to document the new job
- Added `tests/unit/schema_drift.test.ts` — 12 unit tests covering `parseSchemaTableFields` (6 tests) and `parseContractsInterfaceProperties` (6 tests)

### Why these choices fit the architecture

**Breadcrumb:** The run detail page already fetches the run record. The breadcrumb adds two additional server-side Convex queries (`getProject`, `getAgent`) executed non-fatally — if either fails, the page still renders with a degraded breadcrumb rather than a hard error. This follows the established pattern for non-critical parent-context enrichment. No client-side state is required; the fetch happens in the server component.

**Drift check:** The schema and contracts are the two authoritative definitions of each entity's field shape. They can drift silently when one is updated without the other. A static file comparison (regex-based field name extraction, no runtime import of Convex or contracts packages) is the simplest possible check that catches the common case. It runs in under 100 ms, requires no environment variables, and is safe to run in any CI context including PR previews. Storing this as a script (not a test) keeps it callable from `validate.sh` and from CI as an explicit named job.

### Hard-to-reverse decisions

None for this prompt. Both changes are purely additive:
- The breadcrumb can be removed or restyled without data migration
- The drift check script can be deleted or extended without affecting any other system component

### Known residual risks

- **Breadcrumb adds 2 non-fatal Convex queries per run detail page load.** At v1 scale this is negligible. If run detail becomes a high-traffic page, these two fetches are candidates for caching or request coalescing.
- **Drift check is regex-based.** It parses field names from schema.ts and entities.ts by line-by-line pattern matching. Unusual formatting (multi-statement lines, line continuations, macro-expanded defineTable calls) could cause false negatives (missing a real field) or false positives (spurious match). The current schema formatting is conventional enough that this is not a practical risk for v1.

### Recommendation for Prompt 16

SDK auto-externalization is the highest-value remaining item: the SDK must detect payloads >10 KB before calling `POST /api/events` and auto-upload them to `POST /api/artifacts/upload`. This eliminates the silent HTTP 413 failure that callers currently must handle. Artifact download error UX is the next highest value: convert the plain `<a download>` anchor to a programmatic fetch with inline error display.

---

## Prompt 14 — Agent version management (2026-04-10)

### What changed

- Added `convex/agent_versions.ts` with `createAgentVersion` (admin-gated, unique-per-agent), `listAgentVersions`, `getAgentVersion`
- Extended `agent_versions` schema with `configSnapshot: v.optional(v.any())`
- Bumped `packages/contracts` to v0.6.1 with `AgentVersion.configSnapshot?: Record<string, unknown>`
- Added `services/agent_versions.ts`, `actions/agent_versions.ts` (server action) to web service layer
- Added version history UI on agent detail page: `VersionHistory`, `CreateVersionModal`, `VersionSection` components
- Run list and run detail now show agent version label where available (Version column in RunList, badge in RunHeader)
- SDK setup snippets updated across three surfaces to include `agentVersionId`
- ADR-0019 records three hard decisions about version identity

### Why these choices fit the architecture

Version management is a management-plane concern that sits above the event log. Versions are created by admins, attributed to runs at creation time, and never modified after creation — consistent with the immutable event model. The `v.any()` config snapshot avoids coupling the schema to a configuration DSL that does not yet exist. Version string uniqueness enforced at the mutation level keeps the schema simple while providing the correctness guarantee that matters.

### Hard-to-reverse decisions

- **Version string uniqueness per agent**: a mutation-level scan (not a DB index). Reversible if volume demands an index, but the current approach is correct at v1 scale.
- **No active-version pointer on agent**: runs self-attribute at creation time. Adding a "current version" pointer later would require a migration strategy. This is a non-breaking omission.

### Residual risks

- Version label enrichment in the run list page does N parallel `getAgentVersion` fetches (one per distinct version ID in the page). At v1 scale (50 runs, likely 1–3 distinct versions) this is fast. Revisit if runs pages show hundreds of distinct versions.
- No pagination on `listAgentVersions` — `.collect()` loads all versions. Acceptable for v1 (agents typically have <100 versions).

### Recommendation for Prompt 15

See `docs/next_steps.md`.

---

## Prompt 13 — First-success onboarding path

**Date:** 2026-04-10
**Status:** Complete

### What was built

- **Project creation UI** — `CreateProjectModal` + `ProjectsList` + projects page. Admins can create projects from the UI with auto-generated slugs.
- **Agent creation UI** — `CreateAgentModal` + project detail page shows agents table with create button.
- **Org-wide agents page** — lists all agents across projects with links to runs.
- **Agent detail page** — shows agent ID, last run link, and SDK setup snippet.
- **Dashboard onboarding** — four-step Getting Started guide replaces hardcoded SDK snippet.
- **API key management** — `ApiKeysSection` rewritten: loads existing keys on mount, name input before generate, two-phase revoke (Revoke → Confirm? → DELETE /api/api-keys/[id]).
- **SDK setup snippet** — `SdkSetupSnippet` component on settings page with install command and copy-ready code block.
- **Service layer** — `services/projects.ts`, `services/agents.ts` additions (`listAgents`, `listAgentsByOrg`, `createAgent`).
- **Server actions** — `actions/projects.ts` (`createProjectAction`), `actions/agents.ts` (`createAgentAction`).
- **API key revoke route** — `DELETE /api/api-keys/[id]` wraps `revokeApiKey` Convex mutation.
- **`listAgentsByOrg` Convex query** — new query on `by_org` index for org-wide agent listing.

### Files added or changed (Prompt 13)

```
convex/agents.ts                                        (listAgentsByOrg query)
apps/web/src/lib/convexFunctions.ts                     (projects section, agents additions)
apps/web/src/lib/services/projects.ts                   (NEW)
apps/web/src/lib/services/agents.ts                     (listAgents, listAgentsByOrg, createAgent)
apps/web/src/lib/actions/projects.ts                    (NEW)
apps/web/src/lib/actions/agents.ts                      (NEW)
apps/web/app/api/api-keys/[id]/route.ts                 (NEW — DELETE revoke)
apps/web/app/(app)/projects/page.tsx                    (real list + CreateProjectModal)
apps/web/app/(app)/projects/[projectId]/page.tsx        (real detail + CreateAgentModal)
apps/web/app/(app)/agents/page.tsx                      (org-wide agent list)
apps/web/app/(app)/agents/[agentId]/page.tsx            (agent detail + SDK snippet)
apps/web/app/(app)/dashboard/page.tsx                   (stepped onboarding guide)
apps/web/src/components/projects/CreateProjectModal.tsx (NEW)
apps/web/src/components/projects/CreateAgentModal.tsx   (NEW)
apps/web/src/components/projects/ProjectsList.tsx       (NEW)
apps/web/src/components/projects/ProjectDetail.tsx      (NEW)
apps/web/src/components/settings/ApiKeysSection.tsx     (rewritten)
apps/web/src/components/settings/SdkSetupSnippet.tsx    (NEW)
apps/web/app/(app)/settings/page.tsx                    (SdkSetupSnippet added)
tests/unit/projects_agents.test.ts                      (NEW)
```

---

## Prompt 12 — 2026-04-10: Artifact Download, Keyboard Navigation, Event Deep Links, Stale Run Expiry

### What changed

**Team A — Artifact download route (ADR-0016)**
- `convex/artifacts.ts`: added `getArtifact` public query — looks up artifact by Convex ID and verifies org membership via `requireOrgMembership`; returns null if not found
- `apps/web/src/lib/convexFunctions.ts`: added `getArtifact` function reference in the `artifacts` section
- `apps/web/app/api/artifacts/[id]/download/route.ts` (NEW): GET handler — Clerk session auth (401 if missing), Convex artifact query with org verification (404 if wrong org), fetch-and-stream from Vercel Blob (`BLOB_STORE_URL/${storageKey}`) with `Authorization: Bearer ${BLOB_STORE_TOKEN}`, returns `Content-Type: mimeType` and `Content-Disposition: attachment; filename="<name>"`. Returns 502 if blob fetch fails.
- `apps/web/src/components/runs/ArtifactList.tsx`: added "Download" column with `<a href="/api/artifacts/${id}/download" download>` anchor per artifact row (server component, no client-side JS required)
- `docs/adrs/0016_artifact_download.md` (NEW): documents the two-layer auth model (Clerk + Convex org check) and the fetch-and-proxy trade-off

**Team B — Stale run expiry (ADR-0017)**
- `convex/helpers/pagination.ts`: added `STALE_RUN_TIMEOUT_MS = 86_400_000` (24 h) and `STALE_RUN_BATCH_SIZE = 100`
- `convex/stale_runs.ts` (NEW): `listStaleRuns` internalQuery (full-table filter for `status="running"` AND `startedAt < cutoff`, bounded with `.take(STALE_RUN_BATCH_SIZE)`), `markRunTimedOut` internalMutation (idempotent: returns early if run is missing or already non-running, patches `{status:"timed_out", endedAt:Date.now()}`), `expireStaleRuns` internalAction (orchestrates query → mutation loop, logs `batch=N expired=E errors=X`)
- `convex/crons.ts`: added `"expire-stale-runs"` daily cron at `{ hourUTC: 3, minuteUTC: 0 }` (distinct from artifact GC at 02:00)
- `tests/unit/stale_runs.test.ts` (NEW): 8 tests covering timeout constant value, batch size bounds, cutoff arithmetic, and markRunTimedOut safety invariants
- `docs/operations_runbook.md`: replaced manual-only "Run stuck in running" fix with automatic cron description + manual fallback; removed "no automated timeout in v1" note
- `docs/adrs/0017_stale_run_expiry.md` (NEW): records context, decision, and consequences

**Team C — Keyboard navigation + event deep links (ADR-0018)**
- `apps/web/src/components/runs/Timeline.tsx`: added `focusedIndex` state and `useRef` on the events container div; `onKeyDown` handles ArrowUp/ArrowDown (move focus) and Enter (toggle expand); `onFocus` initializes `focusedIndex` to 0; focused row gets `ring-1 ring-neutral-600` highlight; mouse interaction unchanged
- `apps/web/src/components/runs/EventInspector.tsx`: refactored into `EventInspector` (state owner) + `EventInspectorInner` (client component with `useEffect`) to satisfy Rules of Hooks around conditional early returns; new `initialEventSeq?: number` prop initializes `selectedId` from the event with matching `sequenceNumber`; `focusedIdx` state drives left-panel row highlight and keyboard nav (ArrowUp/Down updates both `focusedIdx` and `selectedId`); `useEffect` syncs `?event=<sequenceNumber>` into URL via `history.replaceState` on selection change; "Copy link" button in right panel header copies `window.location.href` to clipboard
- `apps/web/app/(app)/runs/[runId]/page.tsx`: added `event?: string` to `RunDetailPageProps.searchParams`; parses as integer (`parseInt(..., 10) || undefined`); passes `initialEventSeq` to `<EventInspector>`
- `docs/adrs/0018_event_deep_link.md` (NEW): documents `?event=<sequenceNumber>` URL contract, `history.replaceState` behavior, and tab composability

### Why these fit the architecture
- Artifact download: fetch-and-proxy (not redirect) is required to set `Content-Disposition: attachment` header. The Next.js route is the correct place for Clerk auth + Convex org verification — keeps the Convex layer unaware of HTTP session mechanics.
- Stale run expiry: an `internalAction` with `internalMutation` avoids user-auth requirements on scheduled jobs, matches the artifact GC pattern, and is safe — `markRunTimedOut` is idempotent and never touches terminal runs.
- Keyboard nav: `focusedIndex` / `focusedIdx` state is local to the component — no new store, no new dependency. Arrow-key navigation is the standard pattern for engineering tools with dense event lists.
- Event deep link: `history.replaceState` (not `router.push`) avoids adding browser history entries per keystroke, which would make the Back button unusable. `?event=N` by sequence number (not Convex ID) is stable, human-readable, and safe to share.

### Hard-to-reverse decisions
- Download route URL shape (`/api/artifacts/[id]/download`): changing would break existing saved URLs and bookmarks. Chosen once, permanent.
- `?event=<sequenceNumber>` URL contract: changing to event ID would break shared links. sequenceNumber is more stable and human-readable than Convex internal IDs.

### Known residual risks
- Blob traffic is proxied through Next.js serverless functions. For very large artifacts, this could hit Vercel's 4.5 MB function response body limit. Acceptable at v1 — large artifacts should be rare and users can download via `GET /api/artifacts/[id]/download` directly.
- Stale run expiry uses a full-table scan (no global `by_status` index). At v1 run volumes this is acceptable; if the runs table grows to millions of records, a dedicated index would reduce overhead.

### Recommendation for Prompt 13
- v1 is feature-complete. Focus on hardening and operations:
  1. Smoke test on staging with real artifact download flow end-to-end
  2. Consider API versioning (`/api/v1/`) before external clients rely on current paths
  3. SDK auto-externalization (payloads > 10 KB automatically uploaded before `/api/events`) — currently a 413 surfaces to the caller

---

## Prompt 11 — 2026-04-10: Operational Quality Pass (Filter Performance, GC Visibility, Tag Consistency, CI Gate)

### What changed

**Team A — Run filter performance (ADR-0015)**
- `convex/schema.ts`: added `.index("by_org_status_started", ["orgId", "status", "startedAt"])` to the `runs` table
- `convex/runs.ts`: rewrote `listRuns` query branching from a 4-branch + in-memory-filter pattern to a 6-branch pattern that pushes `startedAfter` into index range queries for every applicable filter combination. The sole remaining in-memory `.filter()` is the `orgId` safety check.
- `tests/unit/run_filter.test.ts` (NEW): 14 tests documenting the expected index selection for each filter scenario and verifying pagination constants
- `docs/adrs/0015_run_filter_index.md` (NEW): compound index justification, consequences, known limitations

**Team B — Artifact GC visibility**
- `convex/artifact_gc.ts`: replaced the single `errors` counter with three separated counters (`blobErrors`, `checkErrors`, `recordErrors`); each catch block logs the artifact ID and storage key; blob delete failures emit a clear "will be retried in next GC run" warning; added bounded-batch log when more candidates remain
- `tests/unit/artifact_gc.test.ts`: added 3 tests documenting the safety invariants for the error categorization behavior (total: 10 tests in file)
- `docs/operations_runbook.md`: added "Artifact GC outcomes" section explaining log format, counter meanings, escalation thresholds

**Team C — Tag editing consistency**
- `apps/web/src/components/runs/RunHeader.tsx`: added `savedTags` state that tracks the last successfully persisted tag set; read-only view renders `savedTags` instead of stale `tags` prop; success branch updates `savedTags` before exiting edit mode; Cancel/Escape and error revert use `savedTags` as the reset target

**Team D — CI release gate**
- `.github/workflows/ci.yml`: integration-test job now `needs: [test]` (was `[build]`); added "Report integration test configuration" step that emits a visible notice/warning depending on whether secrets are present; added "Verify integration tests were not silently skipped on main" step that fails on `main` branch when `CONVEX_TEST_URL` is absent
- `docs/ops/ci_setup.md`: documented the release gate policy — secrets-present runs tests and fails on failure; secrets-absent on feature branches warns; secrets-absent on `main` blocks the job
- `docs/release_readiness.md`: updated test count, deferred items list (removed resolved items), added filter/GC/tag/CI sections reflecting current state

### Why these fit the architecture
- Run filter index: Convex compound indexes are the correct mechanism for combining equality and range filters. Adding at schema definition time costs one extra index write per run insert but makes every filtered read O(result set) rather than O(org runs).
- GC visibility: better logging is zero-cost at runtime and materially improves operator response time when GC has issues. Safety invariant (blob delete failure → record preserved) is unchanged.
- Tag consistency: `savedTags` client state is the minimal correct fix — no server round-trip, no prop callback, no refactor. The read-only view always shows what was last successfully saved.
- CI gate: making integration test skip visible (not silent) closes a discipline gap. The `main` branch hard-fail ensures integration coverage is required for release.

### Hard-to-reverse decisions
- `by_org_status_started` index: adding is easy; removing requires schema migration and re-deployment. Justified — it is cheaper to add now than retroactively on a live system with existing runs.
- CI gate on `main`: once set, contributors need to be aware that pushing to `main` without secrets configured blocks CI. Documented in `docs/ops/ci_setup.md`.

### Known residual risks
- `agentId + status + date` filter still applies `status` in-memory (acceptable — agent-scoped run counts are small)
- GC processes one bounded page per daily run; large backlogs clear over multiple days
- Tag editing: if the `tags` prop changes via an external re-render while `savedTags` differs, `savedTags` is authoritative (correct behavior — shows what was last saved by this client)

### Recommendation for Prompt 12
1. Artifact download link: `GET /api/artifacts/[id]/download` with auth — closes the last major UI gap (artifacts visible but not retrievable)
2. Keyboard navigation in run Timeline and EventInspector (↑/↓ arrow keys, Enter to expand)
3. Shareable event URL: `?event=<sequenceNumber>` query param deep-links to a specific event
4. Run stuck/timed-out: automated timeout job for runs stuck in `running` state > N hours (low risk, operators currently need to patch manually)

---

## Prompt 10 — 2026-04-10: Scale & Production Safety (Event Pagination, Diff Bounding, GC Indexing, Org Bootstrap Tests)

### What changed

**Team A — Org bootstrap tests and ADR**
- `tests/unit/org_bootstrap.test.ts` (NEW): 15 unit tests covering `upsertOrganization` (idempotency, slug/name update, not-found), `upsertMembership` (insert, role upsert, org not found), and `clerkRoleToInternal` mapping
- `tests/integration/api.test.ts`: new `describe` block for org bootstrap integration tests (skipped when env vars absent)
- `docs/adrs/0012_org_bootstrap.md` (NEW): documents the Clerk webhook → `upsertOrganization` + `upsertMembership` pipeline, idempotency guarantees, and the decision to use `by_clerk_org_id` index for deduplication

**Team B — Run event pagination UI**
- `apps/web/app/(app)/runs/[runId]/page.tsx`: reduced initial event load from `limit: 500` to `limit: 200`; captures `nextCursor` from `listEvents` response and passes it to Timeline and EventInspector
- `apps/web/src/components/runs/Timeline.tsx`: added `initialNextCursor` prop, `extraEvents`/`cursor`/`loadError` state, `handleLoadMore` async function, and "Load more events" button at bottom of list; fetches from `/api/runs/[id]/events?cursor=X&limit=200`
- `apps/web/src/components/runs/EventInspector.tsx`: same load-more pattern; "Load more…" link appears at bottom of the left event list panel

**Team C — Diff boundedness**
- `packages/contracts/src/diff.ts`: added `truncated?: boolean` to `RunDiff` (non-breaking additive field); contracts bumped to 0.6.0
- `apps/web/src/lib/replay/diff.ts`: added `MAX_EVENTS_PER_DIFF = 10_000` export constant
- `apps/web/src/lib/services/diff.ts`: `fetchAllEvents` exits the pagination loop when `allDocs.length >= MAX_EVENTS_PER_DIFF`; sets `truncated: true` in the returned object; propagated via `{ ...diff, truncated: true }` in `getRunDiff`
- `apps/web/src/components/runs/DiffViewer.tsx`: orange truncation warning banner shown when `diff.truncated === true`
- `tests/unit/diff.test.ts`: new tests covering truncated diff detection, partial comparison correctness, and `truncated` flag propagation
- `docs/adrs/0013_diff_boundedness.md` (NEW): cap rationale, service-layer responsibility, UI disclosure requirement

**Team D — Artifact GC scaling**
- `convex/schema.ts`: added `.index("by_created_at", ["createdAt"])` to the `artifacts` table
- `convex/artifact_gc.ts`: `getOrphanCandidates` rewritten from `.collect()` full scan to indexed range query `q.lt("createdAt", cutoff)` with `.paginate({ numItems: GC_CANDIDATE_PAGE_SIZE })`; returns `{ candidates, nextCursor }` for bounded batch processing
- `convex/helpers/pagination.ts`: added `GC_CANDIDATE_PAGE_SIZE = 100` constant
- `tests/unit/artifact_gc.test.ts` (NEW): 7 tests covering orphan detection, referenced artifact skip, blob token absent path, and error resilience
- `docs/adrs/0014_artifact_gc_scaling.md` (NEW): index choice, full-scan rejection, bounded batch design

### Why these fit the architecture
- Event pagination uses the existing `/api/runs/[id]/events` route — no new API surface; the route already supports cursor/limit params
- Diff cap applied in service layer, not in pure `buildRunDiff` — keeps the pure function testable in isolation with full arrays
- GC indexed query uses user-defined `createdAt` field (Convex does not allow indexing `_creationTime`); the index is minimal and targeted

### Hard-to-reverse decisions
- Contracts 0.6.0 bump: `RunDiff.truncated` is additive and non-breaking; consumers that do not check the flag see the same diff they always did
- `by_created_at` index on artifacts: low-cost addition; no schema migration required for existing records

### Known residual risks
- `getOrphanCandidates` processes only one page per GC run; very large orphan backlogs are processed across multiple daily runs (acceptable — steady state has no backlog)
- Diff truncation is silent in the API response unless the caller checks `truncated`; the UI banner is the disclosure mechanism

---

## Prompt 9 — 2026-04-10: Org Bootstrap, CommentThread, Replay Truncation, CI Integration Tests, Agent Filter

### What changed
- `convex/organizations.ts`: added `upsertMembership` mutation (idempotent insert/update of `user_memberships` rows; resolves org by `clerkOrgId` before inserting)
- `apps/web/app/api/webhooks/clerk/route.ts`: `handleOrganizationMembershipCreated` now calls both `upsertOrganization` and `upsertMembership`; `organizationMembership.updated` case merged into same handler; `clerkRoleToInternal` helper maps Clerk role strings to internal role union
- `apps/web/src/lib/actions/comments.ts` (NEW): `createCommentAction` and `resolveCommentAction` server actions
- `apps/web/src/components/runs/CommentThread.tsx`: full implementation — unresolved list, resolved collapsible section ("Show/Hide N resolved"), compose form, optimistic resolve with revert on error, error banners
- `packages/contracts/src/replay.ts`: added `truncated?: boolean` to `ReplayProjection`
- `convex/helpers/pagination.ts`: added `MAX_EVENTS_PER_REPLAY = 10_000`
- `apps/web/src/lib/replay/projection.ts`: `buildReplayProjection` slices to first 10,000 events by `sequenceNumber` and sets `truncated: true` when the run exceeds the limit
- `apps/web/src/components/runs/ReplayViewer.tsx`: orange warning banner when `projection.truncated === true`
- `.github/workflows/ci.yml`: added `integration-test` job with `CONVEX_TEST_URL`, `TEST_API_KEY`, `TEST_AGENT_ID` from repository secrets
- `docs/ops/ci_setup.md` (NEW): CI runbook for secret provisioning and `TEST_AGENT_ID` setup
- `convex/agents.ts`: added `listDistinctAgents(orgId)` query
- `apps/web/src/lib/services/agents.ts` (NEW): `listDistinctAgents()` service function
- `apps/web/app/(app)/runs/page.tsx`: agent filter dropdown with URL-reflected `?agentId=` param
- `packages/contracts/package.json`: bumped 0.4.0 → 0.5.0 (agentId filter on ListRunsRequest)

### Hard-to-reverse decisions
- `upsertMembership` is idempotent: duplicate webhook deliveries are safe; role updates patch existing rows
- Replay truncation at 10,000 events is consistent with diff bound — same limit for predictability

---

## Prompt 8 — 2026-04-10: Artifact GC, RBAC, Tag Editing, Real Integration Tests

### What changed
- `convex/crons.ts` (NEW): daily scheduled job at 02:00 UTC triggers artifact GC action
- `convex/artifact_gc.ts` (NEW): internal GC action detects orphaned artifacts (no referencing event, older than 24h), deletes blob via Vercel Blob DELETE, removes Convex record; logs candidate/cleaned/skipped/error counts
- `convex/auth.ts`: `requireOrgMembership` gains optional `minimumRole: "admin"|"member"|"viewer"` parameter (defaults to "viewer" — preserves all existing callers)
- `convex/api_keys.ts`: `createApiKey`, `revokeApiKey` now require `minimumRole: "admin"`
- `convex/runs.ts`: `updateRunTags` requires `minimumRole: "admin"`; `createRun` requires `minimumRole: "member"`
- `convex/projects.ts`: `createProject` requires `minimumRole: "admin"`
- `apps/web/app/(app)/runs/[runId]/actions.ts` (NEW): Next.js server action for tag updates (returns error string or null)
- `apps/web/src/components/runs/RunHeader.tsx`: inline tag edit affordance (add/remove chips, Enter/comma to commit, Save/Cancel, error display); uses `useTransition` for optimistic-style save
- `packages/sdk/src/transport.ts`: per-`sendEvents` upload cache prevents redundant blob PUT calls when the same oversized payload appears more than once in a single batch
- `tests/integration/api.test.ts`: real integration test suite added (skipped when `CONVEX_TEST_URL` not set); covers create-run, send-events, idempotency, 413 path
- `.env.example`: documents `CONVEX_TEST_URL`, `TEST_API_KEY`, `TEST_AGENT_ID`
- `docs/adrs/0011_artifact_gc.md` (NEW): orphan definition, safety rationale, BLOB_STORE_TOKEN requirement

### Why these fit the architecture
- GC job runs inside Convex as an `internalAction` — no new services, no new infra
- Role model uses the existing `user_memberships.role` field — smallest sufficient RBAC for v1
- Tag editing uses a server action (not an API route) — keeps the write path in the SSR layer
- Integration tests skip gracefully without env vars — no CI breakage

### Hard-to-reverse decisions
- RBAC enforcement: once deployed, callers without admin role will receive Forbidden on createApiKey, revokeApiKey, updateRunTags, createProject. SDK callers use API key auth (not affected).

### Known residual risks
- GC requires `BLOB_STORE_TOKEN` set in Convex env vars (separate from Next.js env vars); if not set, Convex records are deleted but blobs remain
- Tag edit optimistic state diverges from server on slow re-renders (acceptable for v1)
- Integration tests require manual env setup; not enabled in default CI

### Recommendation for Prompt 9
1. Complete `createOrg`, `getOrgByClerkId` stubs in `convex/organizations.ts` — needed for the full onboarding flow
2. Wire `resolveComment` into the UI
3. Add request timeout on Convex event pagination (> 10,000 events blocks replay endpoint)
4. Consider compound `["orgId", "status", "startedAt"]` index on `runs` for efficient combined filtering
5. Enable integration tests in CI via a dedicated test Convex deployment

---

## Prompt 7 — Artifact Deduplication, Externalized Payload Rendering, Run List Filtering, Tags

**Date:** 2026-04-10

### What changed

- `convex/schema.ts` — added `.index("by_run_checksum", ["runId", "checksum"])` to the
  `artifacts` table; added `.index("by_org_started", ["orgId", "startedAt"])` to the
  `runs` table.
- `convex/sdk_ingest.ts` — `sdkCreateArtifact` now queries `by_run_checksum` before
  inserting. If an artifact with the same `(runId, checksum)` already exists, returns
  the existing record instead of inserting a duplicate. Makes the mutation idempotent for
  retry scenarios.
- `convex/runs.ts` — `listRuns` gains an optional `startedAfter: number` filter param;
  new `updateRunTags` mutation for admin/member tag editing.
- `packages/contracts/src/api.ts` — `ListRunsRequest` gains `startedAfter?: number`;
  contracts version bumped to 0.4.0.
- `apps/web/src/lib/services/runs.ts` — service layer wires `startedAfter` through to
  `listRuns`; new `updateRunTags` service function delegates to the Convex mutation.
- `apps/web/app/(app)/runs/page.tsx` — filter bar with status dropdown and date range
  buttons (Last 24h / Last 7 days / Last 30 days) with keyboard-accessible active state.
- `apps/web/src/components/runs/RunList.tsx` — tags chips column added (max 3 visible,
  "+N more" overflow label).
- `apps/web/src/components/runs/EventInspector.tsx` — detects `_externalized` payload
  type and renders `ExternalizedPayloadView` showing artifact metadata and a download
  link instead of raw JSON.
- `apps/web/src/components/runs/RunHeader.tsx` — `tags` and `metadata` props; renders
  tag chips (expandable) and a collapsible metadata key-value panel.
- `tests/unit/artifact-dedup.test.ts` — 11 new unit tests (3 groups): foundation checks
  for threshold constant and checksum consistency, SDK retry idempotency (same payload
  produces same upload body across two `sendEvents` calls), and boundary correctness
  (exact threshold not externalized, threshold+1 is).
- `docs/adrs/0010_artifact_dedup.md` — decision record for `(runId, checksum)` dedup key
  strategy.

### Why dedup fits the architecture

The `(runId, checksum)` dedup key follows the same pattern established in ADR-0007 for
event idempotency: `(runId, sequenceNumber)` is the natural key for events; `(runId,
checksum)` is the natural key for artifacts within a run. Both use a two-field compound
index in Convex for O(1) lookup before every insert. The dedup scope is bounded — it
applies within a single run, avoiding unintended merging of artifacts that share content
across different runs (e.g., a canonical system prompt appearing in multiple runs).

### Hard-to-reverse decisions

- **`by_run_checksum` index**: schema migration is required to add or remove compound
  indexes in Convex. Once deployed with production data, removing this index requires
  a coordinated schema re-deployment.
- **`listRuns` gaining `startedAfter`**: any clients that cache or test the exact
  `listRuns` response shape must handle the new optional parameter. The parameter is
  additive and backward-compatible, but the new `by_org_started` index changes query
  execution planning for `listRuns` calls that do use it.
- **`ExternalizedPayload` rendering path in `EventInspector`**: once the UI handles
  `_externalized` payloads as a first-class case, removing `ExternalizedPayload` from
  the union requires both a data migration (stored events) and a UI revert.

### Known residual risks

- **Redundant blob upload on retry**: the `by_run_checksum` dedup prevents duplicate
  Convex artifact records, but the SDK still issues a second `PUT` call to blob storage
  on retry (blob write is idempotent at the same checksum-derived key, only the API call
  is redundant). A future prompt can add a client-side upload-once cache in
  `HttpTransport._uploadArtifact`.
- **Orphaned blobs remain**: if a blob upload succeeds but the subsequent `POST /api/events`
  call fails permanently and is never retried, the artifact record exists with no
  referencing event. No GC job yet — planned for Prompt 8.
- **Tags are read-only in list**: `RunList` displays tags but does not provide editing.
  Tag editing requires `updateRunTags` wired into `RunHeader` via server action — planned
  for Prompt 8.

### Test count

- Before Prompt 7: 382 tests in `tests/` workspace + 260 SDK tests = 642 total.
- After Prompt 7: 393 tests in `tests/` workspace (+ 11 new artifact-dedup tests)
  + 260 SDK tests = **653 total, all passing**.

### Recommendation for Prompt 8

1. **Artifact GC job** (CRITICAL): Convex scheduled job (daily) to find artifact records
   older than 24 hours with no referencing event, delete the blob from Vercel Blob, and
   remove the orphaned Convex record.
2. **Tag editing UI**: wire `updateRunTags` mutation into `RunHeader` via a server action;
   enforce admin/member role check at the UI layer.
3. **RBAC enforcement**: add `minimumRole` parameter to `requireOrgMembership()` in
   `convex/auth.ts`; enforce admin-only on `updateRunTags`, `createProject`, key management.
4. **Integration tests**: replace fixture stubs in `tests/integration/api.test.ts` with
   real tests against a Convex test deployment (`CONVEX_TEST_URL`, `TEST_API_KEY`).
5. **SDK upload-once guard**: cache the upload result in `HttpTransport._uploadArtifact`
   keyed by `(runId, checksum)` to skip redundant blob PUT calls on retry.

---

## Prompt 6 — SDK Auto-Externalization and Test Coverage

**Date:** 2026-04-10

### What changed

- `packages/sdk/src/transport.ts` — `HttpTransport.sendEvents()` now auto-externalizes
  oversized payloads. Before the retry loop, each event whose payload serializes to
  > `PAYLOAD_EXTERNALIZATION_THRESHOLD` bytes is uploaded via `POST /api/artifacts/upload`.
  The event's `payload` is replaced with an `ExternalizedPayload` pointer before being
  sent to `POST /api/events`. Upload failures return `{ success: false, retryable: false }`
  immediately; the events call is skipped.
- `packages/contracts/src/events.ts` — `ExternalizedPayload` interface added to the
  `EventPayload` discriminated union. `PAYLOAD_EXTERNALIZATION_THRESHOLD` imported by the
  SDK from `packages/contracts/src/artifacts.ts` (was already defined there in Prompt 4).
- `apps/web/src/lib/health.ts` — shared health data function extracted from the health
  API route, eliminating the loopback HTTP call that `SystemHealthPanel` previously made
  to `/api/health` from the server-side component.
- `tests/unit/transport-externalization.test.ts` — 26 new unit tests covering SDK payload
  externalization: small payload passthrough, large payload upload + pointer replacement,
  mixed batches, upload failure handling, and pointer shape correctness.
- `docs/adrs/0009_payload_externalization_sdk.md` — decision record for SDK-side
  externalization and the `ExternalizedPayload` pointer representation.

### Why the externalization path fits the architecture

ADR-0006 established that payloads exceeding 10 KB must be externalized to blob storage.
The API route has enforced this boundary since Prompt 4 (HTTP 413 for oversized events).
The SDK-side preflight implemented here completes the loop: instead of letting the server
reject the event, the SDK detects the oversize condition locally, uploads the blob, and
ships a compact pointer. This is the correct place for this logic because:

1. The SDK is the author of the event and has the full payload before any network call.
2. The API route's 413 rejection is a correctness guard, not a service — it is not
   designed to handle blobs for callers.
3. Externalizing in Convex mutations would introduce a cross-service call from the data
   layer into blob storage, violating the boundary established in ADR-0006.

The `ExternalizedPayload` type in `packages/contracts` follows the CLAUDE.md rule that
all shared types live in `packages/contracts` only. Any consumer (UI, Convex queries,
future analytics) that reads event payloads will see the type in the union and handle
it correctly.

### Hard-to-reverse decisions

- **`ExternalizedPayload` in the `EventPayload` union**: once events are stored in Convex
  with `payload.type === "_externalized"`, this shape is part of the persistent data model.
  Removing or renaming `ExternalizedPayload` would require a migration of all stored events.
  The shape was designed to be stable: `type`, `originalType`, and `_artifact` are the
  minimal fields needed for any consumer to render or fetch the externalized content.

### Known residual risks

- **Duplicate artifact records on retry**: if `_uploadArtifact` succeeds but the
  subsequent `/api/events` call fails permanently, a repeat flush call will upload the
  same blob again and insert a second `artifacts` record in Convex. The content is correct;
  only the record count is inflated. Mitigation: add `(runId, checksum)` dedup to
  `sdkCreateArtifact` (see ADR-0009, Prompt 7 recommendation).

### Test count

- Before Prompt 6: 356 tests in `tests/` workspace + 260 SDK tests = 616 total, all passing.
- After Prompt 6: 382 tests in `tests/` workspace (+ 26 new transport-externalization tests)
  + 260 SDK tests = **642 total, all passing**.

### Recommendation for Prompt 7

1. **ADR-0009 cleanup**: add `(runId, checksum)` dedup to `sdkCreateArtifact` in
   `convex/sdk_ingest.ts` to fix the duplicate artifact record risk on retry.
2. **Artifact GC job**: `convex/crons.ts` — daily job to query artifact records older than
   24 hours with no matching event reference, delete the orphaned blob from Vercel Blob, and
   remove the orphaned Convex record.
3. **Run list filtering**: status + date range filter in the runs page UI (Prompt 5 spec
   item 2C). Requires updating `convex/runs.ts → listRuns` to accept optional `status`
   and `startedAfter` parameters.
4. **RBAC enforcement**: `convex/auth.ts → requireOrgMembership()` needs an optional
   `minimumRole` parameter; admin-only mutations should pass `minimumRole: "admin"`.
5. **Integration tests**: replace fixture stubs in `tests/integration/api.test.ts` with
   real tests against a Convex test deployment.

---

## Prompt 5 — Release Candidate: Production Storage, Projection Verification, Deployment Docs

**Date:** 2026-04-10

### What changed

- `apps/web/src/lib/storage/vercel.ts` — `VercelBlobAdapter` production implementation using native `fetch` (no `@vercel/blob` package). Activated when `BLOB_STORE_TOKEN` env var is set.
- `apps/web/src/lib/storage/index.ts` — `getStorageAdapter()` updated: uses `BLOB_STORE_TOKEN` presence (not `BLOB_STORAGE_PROVIDER`) to select Vercel Blob vs stub adapter.
- `apps/web/src/lib/replay/verify.ts` — `verifyProjectionIntegrity(run, events)` pure function: checks sequence contiguity, detects duplicates, validates projection does not throw, produces `ProjectionVerifyResult` with structured error list and human-readable summary.
- `scripts/rebuild-projection.ts` — CLI tool for verifying run event sequence integrity locally and in CI.
- `apps/web/app/api/health/route.ts` — `GET /api/health` endpoint: returns storage adapter name, configured status, and timestamp. Operator health signal.
- `apps/web/src/components/runs/SystemHealthPanel.tsx` — displays health endpoint data in the web UI.
- `docs/adrs/0008_vercel_blob_adapter.md` — decision record for VercelBlobAdapter design (native fetch, no SDK dependency).
- `tests/unit/projection-verify.test.ts` — 68 new unit tests for `verifyProjectionIntegrity`: valid cases, empty events, sequence gaps, duplicate detection, large runs (500 events), nested events, failed run failure summaries, summary string content, projection field correctness, and determinism guarantees.
- `tests/unit/storage.test.ts` — updated 2 tests to match new `getStorageAdapter()` behavior (BLOB_STORE_TOKEN-based selection, no longer throws for BLOB_STORAGE_PROVIDER=vercel).
- `docs/deployment_checklist.md` — step-by-step checklist for local dev → staging → production deployment.
- `docs/release_readiness.md` — release candidate status document: what is ready, what is deferred, hard decisions, known gaps.
- `docs/operations_runbook.md` — operational runbook for common production issues.
- `.env.example` — `BLOB_STORE_TOKEN` and `BLOB_STORE_URL` documented (replaces `BLOB_READ_WRITE_TOKEN` and `BLOB_STORAGE_PROVIDER`).

### Why these release decisions

- **VercelBlobAdapter via native fetch**: avoids adding `@vercel/blob` as a dependency. The SDK must run in any Node.js environment. Keeping the blob adapter as a thin fetch wrapper with a single file to update if the API changes is the correct trade-off at v1 scale.
- **`BLOB_STORE_TOKEN` presence as the selector signal**: simpler than a `BLOB_STORAGE_PROVIDER` enum. If you have a token, use Vercel Blob. If not, use the stub. No risk of misconfigured provider name.
- **`verifyProjectionIntegrity` as a pure function**: aligns with the existing pattern of pure, deterministic algorithms for all projection work (ADR-0005). Makes it trivially testable and usable in both the web app and CLI scripts without dependency on any runtime context.
- **Deployment docs as first-class artifacts**: the system is approaching production readiness. Deployment checklists and runbooks must exist before any production deployment attempt. They cannot be written retrospectively after an outage.

### Hard-to-reverse decisions

- **env var naming: `BLOB_STORE_TOKEN` (not `BLOB_READ_WRITE_TOKEN` or `BLOB_STORAGE_PROVIDER`)**: all deployments must use this exact var name. Changing it later requires coordination across all environments and any external tooling that sets the variable.
- **No fallback if `BLOB_STORE_TOKEN` expires**: the adapter is selected at request time, not at server startup. A token expiry causes upload failures without a graceful fallback. This is acceptable for v1 (token TTLs are long) but must be addressed before high-volume production use.

### Known gaps

- SDK does not auto-externalize large payloads (> 10 KB). The API returns HTTP 413 — the SDK must be updated in v1.1 to call `/api/artifacts/upload` before `/api/events` for oversized payloads.
- No automatic artifact garbage collection for orphaned or failed-upload artifacts.
- Integration tests in `tests/integration/api.test.ts` remain fixture-based stubs; real Convex integration requires a live deployment.

### Test count

356 tests passing in `tests/` workspace (was 288 after Prompt 4, was 2 failing at Prompt 5 start due to `storage.test.ts` tests not reflecting the updated `getStorageAdapter()` behavior; fixed in Prompt 5).
260 SDK tests passing in `packages/sdk`.
Total: 616 tests, all green.

---

## Prompt 4 — Hardening: Blob Storage, Ingestion Idempotency, Artifact UI

**Date:** 2026-04-10

### What changed

- `apps/web/src/lib/storage/` — `BlobStorageAdapter` interface, `sha256Hex`, `PAYLOAD_EXTERNALIZATION_THRESHOLD` constant, `StubBlobStorageAdapter` (in-memory, dev/test), `getStorageAdapter()` factory
- `apps/web/app/api/events/route.ts` — 10 KB payload size check: events with JSON payload > 10 240 bytes rejected with HTTP 413 PAYLOAD_TOO_LARGE
- `apps/web/app/api/artifacts/upload/route.ts` — POST endpoint: externalize a large payload to blob storage and record the artifact in Convex; API key auth; enforces minimum payload size
- `convex/sdk_ingest.ts` — `sdkCreateEvents`: idempotent insert; duplicate (runId, sequenceNumber) returns existing ID instead of inserting; `sdkCreateArtifact`: API-key-authenticated artifact creation
- `apps/web/src/lib/services/artifacts.ts` — `listArtifacts`, `getArtifactUrl` wired to Convex; used by run detail page
- `apps/web/src/components/runs/ArtifactList.tsx` — renders real artifact data passed from run detail page
- `apps/web/app/(app)/runs/[runId]/events/[eventId]/page.tsx` — event detail page: full payload JSON, metadata, parent event link
- `apps/web/src/lib/convexFunctions.ts` — added `sdk_ingest.sdkCreateArtifact` function reference
- `tests/unit/storage.test.ts` — 28 new unit tests for threshold constant, sha256Hex, StubBlobStorageAdapter, getStorageAdapter
- `docs/adrs/0006_artifact_externalization.md` — decision record for payload externalization policy
- `docs/adrs/0007_ingestion_idempotency.md` — decision record for duplicate event handling

### Decisions made

- Idempotency key for events: `(runId, sequenceNumber)` — natural key matching how the SDK assigns sequence numbers. O(1) lookup via existing `by_run` Convex index. See ADR-0007.
- Threshold: 10,240 bytes (10 × 1024). Measured by `JSON.stringify(payload).length`. Enforced at the API route boundary. See ADR-0006.
- Blob storage is provider-agnostic. `StubBlobStorageAdapter` handles local dev and CI. Production adapter (Vercel Blob) deferred to v1.1 when `BLOB_READ_WRITE_TOKEN` is available.
- Checksum (SHA-256) computed before upload, stored on artifact record for integrity verification.

### Test count

288 tests passing (was 260 after Prompt 3; +28 in Prompt 4).

---

## Prompt 3 — Explainability Layer (replay, failure summary, diff)

**Date:** 2026-04-09

### What changed
- packages/contracts v0.1.0 → v0.2.0: extended ReplayFrame (actor, status, payloadPreview, depth), added FailureSummary/FailurePoint types, added GetReplayResponse/GetDiffResponse API types
- apps/web/src/lib/replay/: pure deterministic algorithms for projection (projection.ts), failure analysis (failure.ts), and run comparison (diff.ts)
- apps/web/src/lib/services/replay.ts + diff.ts: service layer fetching all events and computing projections
- apps/web/app/api/runs/[id]/replay/route.ts + app/api/diff/route.ts: new GET endpoints
- apps/web/src/components/runs/ReplayViewer.tsx: interactive step-through replay UI
- apps/web/src/components/runs/DiffViewer.tsx: side-by-side run comparison UI
- apps/web/src/components/runs/FailureSummary.tsx: failure callout panel
- tests/fixtures/events.ts: 6 scenario fixtures (successful run, failed tool, failed LLM, partial run, nested events, diverging runs for diff)
- tests/unit/replay.test.ts, failure.test.ts, diff.test.ts: algorithm unit tests
- docs/adrs/0005_on_demand_replay.md: decision record for projection strategy

### Why on-demand computation
Event counts for v1 are small. On-demand computation avoids cache invalidation complexity and keeps the event log as the only source of truth. See ADR-0005.

### Known edge cases
- Runs with >1000 events require multiple pagination fetches (handled but adds latency)
- Circular parentEventId chains are guarded but must not appear in well-formed data
- Payload comparison is order-sensitive (JSON.stringify) — field reordering looks like a diff

### Recommendation for Prompt 4
1. Project/agent management UI (list projects, agents, versions)
2. Event detail page (full payload inspector for a single event)
3. Run tagging and metadata search
4. API key management UI (revoke, rotate)
5. Run comparison flow from the runs list (select two runs → diff)
6. Blob storage wiring for large payloads

---

## Session: Prompt 1 — Initial Foundation

**Date:** 2026-04-09
**Session ID:** Prompt 1
**Teams:** A (Repo Architecture), B (Data + Contracts), C (Web App), D (SDK + Quality)
**Goal:** Lay the complete foundation — monorepo, schema, contracts, SDK skeleton, web app skeleton, tests.

---

## Decisions Made

1. **pnpm as the package manager (not npm or yarn).**
   Rationale: pnpm's symlink-based `node_modules` is significantly faster and disk-efficient in monorepos. pnpm workspaces are native and well-supported. Version pinned to 9.x in `package.json` `packageManager` field and `engines` constraint.

2. **Turborepo as the build orchestrator (not Nx or Lerna).**
   Rationale: Turborepo has minimal configuration, fast incremental builds via content hashing, and native pnpm workspace integration. It does not require per-package task runners or complex configuration.

3. **TypeScript strict mode enforced at the base tsconfig level.**
   All packages extend `tsconfig.base.json` which sets `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. These are not negotiable on a new project — fixing them later is extremely painful.

4. **`packages/contracts` has zero runtime dependencies.**
   Rationale: Contracts are imported by the SDK (runs in customer's Node process), by the web app (runs in Vercel), and by Convex (runs in Convex runtime). Adding a runtime dependency (e.g. Zod) to contracts would add that dependency to all three environments. Zod may be added in Prompt 2 for API validation, but must be kept tree-shakeable.

5. **EventType is a string literal union, not an enum.**
   Rationale: TypeScript string literal unions are the idiomatic choice for discriminated unions. Enums have footguns (reverse mapping, ambient declarations, emit issues). String literals serialize naturally to JSON without transformation.

6. **`events.payload` uses `v.any()` in Convex schema.**
   Rationale: Convex's validator DSL cannot express a discriminated union of complex objects without extreme verbosity and duplication. The contract types enforce the shape at the TypeScript level. Runtime validation of event payloads is the SDK's responsibility (it constructs the payload with typed builders).

7. **Run status transitions are enforced in the `updateRunStatus` mutation.**
   Rationale: Status transitions are business logic, not schema constraints. Encoding them in the mutation means they are enforced regardless of which caller invokes the mutation. The valid transitions are: `pending → running | cancelled`, `running → completed | failed | cancelled | timed_out`. Terminal states cannot be transitioned.

8. **`requireOrgMembership()` is called in every mutation, not just `getAuthContext()`.**
   Rationale: `getAuthContext()` only verifies the user is authenticated and the org exists. It does not verify the user is a member of that org. A sophisticated attacker who knows an `orgId` Convex ID could potentially bypass the auth check if only `getAuthContext()` were called. `requireOrgMembership()` adds the membership check.

9. **Sequence numbers are SDK-assigned, not server-assigned.**
   Rationale: If sequence numbers were server-assigned, the SDK would need a round-trip to the server before buffering each event. That would serialize event recording and add latency. SDK-assigned sequence numbers allow buffering with no server round-trips. The server validates contiguity on receive.

10. **`AgentVersion` is immutable once created — there is no `updateAgentVersion`.**
    Rationale: An AgentVersion represents a point-in-time snapshot of agent configuration. If it could be mutated, historical runs would no longer accurately reflect the configuration that produced them. Immutability is a correctness requirement, not a preference.

11. **`comments` use a `targetId: string` + `targetType: "run" | "event"` union rather than two separate nullable foreign keys.**
    Rationale: Two nullable FKs (`runId?`, `eventId?`) require a check constraint to ensure exactly one is set. The string+discriminant approach is simpler in Convex (which has no check constraints) and maps naturally to the UI, which shows comments on either entity type without different code paths.

12. **No React UI component library (no shadcn, Radix, MUI).**
    Rationale: Agent Flight Recorder is a technical tool with a specific visual language (calm, dense, high-signal). External component libraries impose design opinions that are hard to override. Tailwind primitives give full control. This decision also keeps the dependency surface small and avoids version conflict issues.

13. **SDK `Transport` interface is injectable (dependency injection pattern).**
    Rationale: Unit testing the `Recorder` without a real HTTP endpoint requires injecting a mock transport. Without DI, every test would need to spin up a server or intercept `fetch`. The `MockTransport` pattern is clean and fast.

14. **`Recorder` maintains a single active run context.**
    Rationale: The common use case is one agent run per Recorder instance. Supporting concurrent runs would complicate the API (every method would need a `runId` parameter) and the buffer (separate buffers per run). If concurrent runs are needed, the caller should instantiate multiple Recorders.

15. **`FlushResult` always returns success/failure explicitly — no thrown exceptions.**
    Rationale: The SDK runs inside customer agent code. If `flush()` throws, the exception propagates into the agent, potentially crashing it. Returning a `FlushResult` with `errors[]` lets the SDK surface the failure without affecting the agent's execution path. The caller can inspect `result.errors` and decide how to proceed.

16. **`scripts/validate.sh` runs typecheck → build → lint in that order.**
    Rationale: Typecheck is the fastest signal that something is wrong. Building before typechecking would waste CI time if there are type errors. Lint runs last because it catches style issues, not correctness issues — style issues are lower priority than build failures.

17. **`by_agent_started` and `by_project_started` indexes on the `runs` table.**
    Rationale: The most common query patterns are "list runs for this agent, newest first" and "list runs for this project, newest first". The compound index on `(agentId, startedAt)` enables efficient time-range queries without a full table scan.

18. **`parentEventId` on the events table enables a DAG, not just a flat list.**
    Rationale: Real agent executions are not flat sequences. A single LLM response may trigger multiple tool calls, each of which makes HTTP requests. `parentEventId` lets the UI reconstruct the execution tree for the inspector view while `sequenceNumber` preserves the canonical timeline order.

---

## Files Created

### Team A — Repo Architecture

- `package.json` — workspace root, pnpm config, Turborepo scripts
- `pnpm-workspace.yaml` — workspace package globs
- `tsconfig.base.json` — strict TypeScript base config
- `.eslintrc.json` (root) — ESLint config with import rules
- `.prettierrc` — Prettier config
- `turbo.json` — Turborepo pipeline config
- `CLAUDE.md` — Project constitution (system boundaries, entity model, rules for future sessions)
- `README.md` — Developer onboarding
- `scripts/validate.sh` — CI validation gate (typecheck → build → lint)
- `scripts/seed.ts` — Dev database seeding (stub)
- `scripts/validate.ts` — Validate script TypeScript runner
- `.env.example` — (MISSING — not created in Prompt 1, must be created in Prompt 2)
- `.github/workflows/ci.yml` — (MISSING — not created in Prompt 1, must be created in Prompt 2)

### Team B — Data + Contracts

**packages/contracts:**
- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/src/entities.ts` — Organization, Project, Agent, AgentVersion, Run, Event, Artifact, Comment
- `packages/contracts/src/events.ts` — EventType union, all payload shapes, EventPayload
- `packages/contracts/src/status.ts` — RunStatus, RunStatusValues, isTerminalStatus()
- `packages/contracts/src/api.ts` — All API request/response shapes
- `packages/contracts/src/replay.ts` — ReplayProjection, ReplayFrame
- `packages/contracts/src/diff.ts` — RunDiff, EventDiff, DiffSummary, FieldChange
- `packages/contracts/src/artifacts.ts` — Artifact types (if separate from entities)
- `packages/contracts/src/index.ts` — Re-exports all public types

**convex/:**
- `convex/schema.ts` — All 8 table definitions with indexes (COMPLETE)
- `convex/auth.ts` — `getAuthContext()`, `requireOrgMembership()` (COMPLETE)
- `convex/runs.ts` — `listRuns`, `getRun`, `createRun`, `updateRunStatus` (COMPLETE)
- `convex/events.ts` — `listEvents`, `getEvent`, `createEvent` (COMPLETE)
- `convex/artifacts.ts` — `listArtifacts`, `createArtifact` (COMPLETE)
- `convex/comments.ts` — LIST query implemented; CREATE/RESOLVE mutations (STUB)
- `convex/organizations.ts` — `getOrg` (STUB — needs createOrg, getOrgByClerkId)
- `convex/projects.ts` — `listProjects` (STUB — needs createProject)
- `convex/helpers/pagination.ts` — `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` (COMPLETE)
- `convex/helpers/storage.ts` — `BlobStorageAdapter` interface (INTERFACE ONLY — no implementation)

### Team C — Web App

**apps/web — structure:**
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/next.config.js`
- `apps/web/tailwind.config.ts`
- `apps/web/postcss.config.js`

**apps/web/src/lib:**
- `apps/web/src/lib/env.ts` — Env var validation at startup (COMPLETE)
- `apps/web/src/lib/auth.ts` — Clerk auth helpers for Next.js (STUB)
- `apps/web/src/lib/utils.ts` — Utility functions (STUB)
- `apps/web/src/lib/services/runs.ts` — Run service layer (STUB — returns fake data)
- `apps/web/src/lib/services/events.ts` — Event service layer (STUB — returns empty array)
- `apps/web/src/lib/services/comments.ts` — Comment service layer (STUB — returns empty array)

**apps/web/src/components/ui:**
- `Badge.tsx` — Status badges with color variants
- `Button.tsx` — Button with primary/secondary/ghost variants
- `Card.tsx` — Container card
- `CodeBlock.tsx` — Syntax-highlighted code viewer
- `EmptyState.tsx` — Empty data state with message and action
- `ErrorState.tsx` — Error state with message and retry action
- `LoadingState.tsx` — Loading spinner/skeleton
- `Tabs.tsx` — Tab navigation component

**apps/web/src/components/layout:**
- `AppShell.tsx` — Root layout with sidebar
- `PageHeader.tsx` — Page title + breadcrumbs
- `Sidebar.tsx` — Navigation sidebar

**apps/web/src/components/runs:**
- `RunList.tsx` — Table of runs with status badges and timestamps
- `RunHeader.tsx` — Run detail header with status, timing, metadata
- `Timeline.tsx` — Chronological event list with type icons
- `EventInspector.tsx` — Per-event payload viewer (collapsible)
- `DiffViewer.tsx` — Side-by-side run diff (STUB — no diff computation)
- `ReplayViewer.tsx` — Step-through replay player (STUB — no playback logic)
- `ArtifactList.tsx` — List of artifacts with download links
- `CommentThread.tsx` — Comment list and compose form

**apps/web/src/app/ — MISSING.** No Next.js pages exist. This is the most critical gap for Prompt 2.

### Team D — SDK + Quality

**packages/sdk:**
- `packages/sdk/package.json`
- `packages/sdk/tsconfig.json`
- `packages/sdk/src/index.ts` — Public exports (COMPLETE)
- `packages/sdk/src/recorder.ts` — Recorder class (COMPLETE)
- `packages/sdk/src/events.ts` — Events builders, buildEvent (COMPLETE)
- `packages/sdk/src/transport.ts` — Transport interface, HttpTransport (STUB — all methods throw)
- `packages/sdk/src/types.ts` — RecorderConfig, RunContext, FlushResult, etc. (COMPLETE)

**tests:**
- `tests/vitest.config.ts`
- `tests/unit/sdk.test.ts` — Recorder tests with MockTransport (PASSING)
- `tests/unit/contracts.test.ts` — Contract type coverage tests (PASSING)
- `tests/integration/api.test.ts` — (STUB — all tests marked TODO)
- `tests/fixtures/runs.ts` — Sample run and event data (COMPLETE)

**docs:**
- `docs/product_spec.md` — Full product specification (COMPLETE)
- `docs/adrs/0001_repo_shape.md` — (written in Prompt 1)
- `docs/adrs/0002_event_log_is_canonical.md` — (written in Prompt 1)
- `docs/adrs/0003_tenancy_boundary.md` — (written in Prompt 1)
- `docs/adrs/0004_shared_contracts_package.md` — (written in Prompt 1)

---

## Deviations from Original Spec

1. **No `.env.example` was created.** Environment variables are referenced in `apps/web/src/lib/env.ts` but a template `.env.example` was not created. Must be created in Prompt 2 before other developers can set up the project.

2. **No GitHub Actions CI workflow was created.** `scripts/validate.sh` exists and is the validation gate, but there is no `.github/workflows/ci.yml` that runs it on pull requests. Must be created in Prompt 2.

3. **`convex/comments.ts` mutations are incomplete.** The `createComment` and `resolveComment` mutations were not implemented in Prompt 1. The list query exists.

4. **`apps/web/src/app/` does not exist.** The Next.js App Router requires this directory to serve pages. Zero pages exist. The web app cannot be run as a server yet.

5. **SDK `HttpTransport` is entirely stubbed.** All three methods throw. The SDK is functional end-to-end with a mock transport (tests pass), but cannot make real HTTP calls until Prompt 2 implements the API routes and the transport.

6. **No API key management system.** The `RecorderConfig` accepts an `apiKey`, and the `Transport` auth interface carries it, but there is no `api_keys` table in Convex and no API key issuance flow. Prompt 2 must decide: use Clerk tokens or implement a separate API key system.

---

## Risks Identified

1. **API key auth gap.** The SDK sends an `apiKey` but there is no system to issue or validate API keys. If we use Clerk org tokens directly, the SDK must manage token refresh. If we use opaque API keys, we need the `api_keys` table. This is the most critical architectural decision remaining.

2. **Convex `v.any()` for event payloads is a runtime validation gap.** Large, malformed payloads can be stored without error. The SDK's typed builders mitigate this, but untrusted ingest (e.g. from a compromised API key) could store arbitrary data in the events table. Payload validation at the API route layer (Zod) is the mitigation.

3. **No test environment for Convex.** Integration tests need a Convex dev deployment to run against. Without one, all integration tests are stubs and cannot catch schema/mutation regressions. This is acceptable for Prompt 1 (foundation) but must be resolved before the project grows.

4. **`apps/web` has no pages yet.** The web app is not runnable. This is expected for Prompt 1 but means there has been no end-to-end validation of the auth or Convex integration from the browser. Prompt 2 must create pages and perform manual smoke testing.

5. **Blob storage is a no-op.** Large payloads will either fail silently or be stored in-line (violating the 10 KB rule) until the `BlobStorageAdapter` is implemented. If anyone uses the SDK with large payloads before Prompt 3, they will hit issues.

6. **`turbo.json` pipeline ordering must be validated.** If the `dependsOn` declarations in `turbo.json` are incorrect, packages may be built out of order. This would cause stale type artifacts and confusing TypeScript errors. Must be verified when Prompt 2 adds actual build steps.

---

## Completed vs Stubbed

| Area | Completed | Stubbed |
|------|-----------|---------|
| Monorepo config | pnpm workspace, Turborepo, TypeScript, ESLint, Prettier, validate.sh | .env.example, CI workflow |
| Convex schema | All 8 tables, all indexes | — |
| Convex auth | getAuthContext(), requireOrgMembership() | — |
| Convex runs | listRuns, getRun, createRun, updateRunStatus | — |
| Convex events | listEvents, getEvent, createEvent | — |
| Convex artifacts | listArtifacts, createArtifact | — |
| Convex comments | (list query) | createComment, resolveComment |
| Convex organizations | — | createOrg, getOrgByClerkId |
| Convex projects | — | createProject, listProjects (full) |
| Blob storage | BlobStorageAdapter interface | Concrete implementation |
| packages/contracts | All entity types, all event types, API shapes, replay/diff projections | — |
| packages/sdk | Recorder class, Events builders, types, Transport interface | HttpTransport implementation |
| apps/web components | All UI primitives, layout, run-specific components | — |
| apps/web service layer | Service function signatures, type imports | Real Convex calls |
| apps/web pages | — | All pages (app/ directory missing) |
| Unit tests | sdk.test.ts (passing), contracts.test.ts (passing) | integration/api.test.ts |
| Documentation | product_spec.md, all 4 ADRs, this build log, working_memory.md, architecture.md, product_model.md, next_steps.md | — |
