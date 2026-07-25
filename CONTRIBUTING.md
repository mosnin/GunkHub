# Contributing to Agent Flight Recorder

`CLAUDE.md` is the authoritative project constitution — system boundaries, the entity
model, event log and tenancy rules, and design conventions. Read it before making any
change. This document is the practical how-to that sits on top of it.

---

## Dev Setup

```bash
git clone <repo-url>
cd GunkHub
pnpm install
cp .env.example .env.local   # fill in Clerk + Convex + blob storage values
pnpm dev                     # apps/web dev server + convex dev, in parallel via Turbo
```

You need a Clerk application and a Convex deployment before the app will start. Every
required variable is documented inline in `.env.example` — if you add a new one,
document it there in the same PR that introduces the code consuming it.

---

## Verification Gates

Run before every commit:

```bash
pnpm typecheck
```

Before pushing a branch, run the full gate:

```bash
./scripts/validate.sh
```

`validate.sh` runs, in order: **typecheck** (7 Turbo tasks — one per workspace package),
**build**, **lint** (5 Turbo tasks), and **schema-drift**
(`scripts/check-schema-drift.ts`, which checks the Convex schema against its generated
types). All must pass. You can run a subset: `./scripts/validate.sh typecheck lint`.

`pnpm test` runs all unit test suites (`tests/unit/**`, plus package-local `*.test.ts`
files). CI additionally runs a real-Convex integration job
(`tests/integration/api.test.ts`) gated on `CONVEX_TEST_URL` being configured as a repo
secret — see `docs/ops/ci_setup.md`. That job is a hard release gate: merging to `main`
without the secret configured fails CI.

CI (`.github/workflows/ci.yml`) runs: typecheck, lint, dependency-audit,
schema-drift, build, test, and integration-test, on every push to `main`/`feature/**`/
`fix/**`/`claude/**` and every PR into `main`.

### The `tests/` package has three typecheck projects

`pnpm --filter @agent-flight-recorder/tests typecheck` runs **three** `tsc` invocations,
not one. Nothing extra to remember day to day — `pnpm typecheck` and `validate.sh` both
pick this up — but it matters if you add a test that imports backend code or renders a
React component.

| Project | Covers | Notable option |
|---------|--------|----------------|
| `tests/tsconfig.json` | every test **except** the files listed in its `exclude` | `exactOptionalPropertyTypes: true` (inherited from `tsconfig.base.json`) |
| `tests/tsconfig.convex-seam.json` | only the Convex seam files, plus whatever `convex/` code they pull in | extends `convex/tsconfig.json`, so `exactOptionalPropertyTypes: false` |
| `tests/tsconfig.dom.json` | only the DOM tests, plus whatever `apps/web/` components they render | extends `apps/web/tsconfig.json`, so `exactOptionalPropertyTypes: false`; `jsx: react-jsx` |

**Why the split.** `convex/tsconfig.json` deliberately turns
`exactOptionalPropertyTypes` off: Convex's generated document types declare optional
fields as `field?: T` while `ctx.db.insert()`/`patch()` accept an explicit `undefined`,
so the flag errors on essentially every insert (47 errors across 19 files at last count).
`tests/` inherits the flag as `true`. A test that type-imports a `convex/` module
therefore fails typecheck on backend code that is perfectly correct under its own
config — which is why `tests/unit/fix_confidence_vocab.test.ts` used to compare the
fix-confidence vocabulary by running a `RegExp` over `convex/insights.ts`'s source text.

Relaxing the flag in `tests/tsconfig.json` was rejected: that strictness is what makes
fixture drift against `packages/contracts` fail CI, and one seam test is not worth
disarming it for all ~65 suites. Instead the seam file is compiled under the backend's
own options, by extending `convex/tsconfig.json` rather than restating its flags — so if
`convex/` ever re-enables the flag, the seam project follows and the divergence
disappears with no edit.

**If you add a test that type-imports `convex/`:** add it to `include` in
`tests/tsconfig.convex-seam.json` and to `exclude` in `tests/tsconfig.json`. Keep that
list short — every file on it trades `exactOptionalPropertyTypes` for visibility of
Convex types, which is only the right trade for a file whose entire job is pinning a
cross-boundary seam. An ordinary test that just needs a shape should import it from
`@agent-flight-recorder/contracts` and stay in the strict project.

`tests/tsconfig.dom.json` exists for exactly the same reason, one boundary over:
`apps/web/tsconfig.json` also sets `exactOptionalPropertyTypes: false`, so a test that
imports a React component drags web source that is correct under its own config into the
strict project and fails on idiomatic prop forwarding (`<Badge mutedAt={p.mutedAt} />`,
where `mutedAt?: number` meets `number | undefined`). Same resolution: extend the owning
package's tsconfig rather than relax this one.

---

## Writing a DOM test

Most suites in `tests/` run under `environment: 'node'` and that is the default. A test
that renders a React component opts **into** jsdom per-file. The global environment is
deliberately not flipped: ~67 node suites have no use for a DOM, and giving SDK, Convex
and service tests browser globals (`window`, `localStorage`) their production runtime
does not have would let a test pass for the wrong reason.

**1. Name the file `.tsx` and declare the environment in its first docblock.**

```tsx
/**
 * @vitest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PatternStatusFilter } from '@/components/patterns/PatternStatusFilter'
```

The docblock must be the **first** comment in the file — Vitest reads it there and
nowhere else. `tests/setup/global.ts` then loads `tests/setup/dom.ts` (jest-dom matchers
plus unmount-between-tests) automatically, gated on `document` existing, so node suites
never pay for it.

**2. Register the file in the right projects.** A new `.tsx` DOM test needs three
one-line edits, or it will fail `typecheck` and `lint` while still passing `test`:

- add it to `include` in `tests/tsconfig.dom.json`
- add it to `exclude` in `tests/tsconfig.json`
- add it to the `files` list in `tests/.eslintrc.js`, which points type-aware linting at
  `tsconfig.dom.json` (the root config's `**/*.test.ts` override does not match `.tsx`)

**3. Assert on the accessibility tree, not on markup.** Prefer
`getByRole`/`getByLabelText`/`toHaveAccessibleName` over class names and test IDs — a
role query fails when the thing a user relies on breaks, a class query fails when
someone renames a utility. `tests/unit/patterns_a11y.test.tsx` is the worked example
and carries reusable helpers for tab-stop enumeration, `sr-only`-stripped visible text,
`aria-hidden`-stripped announced text, and live-region discovery.

**4. Two Vite behaviours that will bite you.**

- **`next/link` and `@clerk/nextjs/server` are not resolvable from `tests/`** (they are
  `apps/web` dependencies, and pnpm's `node_modules` are isolated). Both are aliased to
  stubs in `tests/stubs/`, wired up in `tests/vitest.config.ts`. Next **route** files
  (`loading.tsx`, `page.tsx`) live outside the `@/*` alias and import via `@app/*`.
- **`new URL('../x', import.meta.url)` is statically rewritten by Vite** into an asset
  URL, which under jsdom resolves against `http://localhost:3000/@fs/...` — so
  `fileURLToPath` throws `ERR_INVALID_URL_SCHEME`. It works in node suites and breaks in
  DOM ones. Use `path.resolve(fileURLToPath(import.meta.url), '../…')` instead; a bare
  `import.meta.url` is not rewritten.

**5. Never assert on a real network call.** Stub with `vi.stubGlobal('fetch', …)` and
`vi.unstubAllGlobals()` in `afterEach`. Interactions go through `userEvent`, and every
`userEvent` call is awaited — a floating one leaves React state updates unflushed and
produces failures that look like race conditions.

**Cost.** The DOM harness (`jsdom`, `@testing-library/{react,dom,jest-dom,user-event}`)
is devDependency-only, ~29 MB installed, and adds roughly 2.5s to the `tests` package's
wall clock — almost all of it the one jsdom file, plus ~11ms per node file for the
gated setup import.

---

## Boundary Ownership Map

Mirrors `CLAUDE.md`'s System Boundaries table and `.github/CODEOWNERS`. Identify which
boundary a file belongs to before editing it, and do not cross a boundary you haven't
been assigned without explicit instruction.

```
apps/web/**             → web boundary (UI, API routes, Clerk integration, Next.js config)
packages/contracts/**   → contracts boundary (shared types only, zero runtime deps)
packages/sdk/**         → sdk boundary (client recording library)
packages/cli/**         → cli boundary (`afr` command-line interface; sdk team owns)
packages/mcp/**         → mcp boundary (read-only MCP server over /api/v1; see docs/mcp.md)
convex/**               → convex boundary (schema, queries, mutations, auth config, crons)
scripts/**              → shared tooling (any team may edit)
docs/**                 → shared documentation (any team may edit)
tests/**                → shared tests (any team may edit)
root config files        → infrastructure (platform team owns; others may propose changes)
```

---

## Commit Conventions

- Imperative mood, present tense: "Add event log schema," not "Added event log schema."
- Run `pnpm typecheck` before every commit — non-typechecking code must not be merged.
- Run `./scripts/validate.sh` before pushing a branch.

---

## How To: Add a New Event Type

An event type touches four files that must change together:

1. **`packages/contracts/src/events.ts`** — the source of truth. Add the string literal
   to the `EventType` union, define its payload interface, and add it to the
   `EventPayload` discriminated union.
2. **`convex/events.ts`** — mirror the new literal into `VALID_EVENT_TYPES`. Convex
   cannot import the contracts package (no path resolution across the workspace
   boundary at the Convex bundler level), so this set is hand-mirrored. The file carries
   a `MUST stay in sync` comment at the mirror site — do not remove it.
3. **`convex/sdk_ingest.ts`** — the same mirror exists a second time here, for the
   API-key ingest path. Update both or a type accepted on one path will be silently
   rejected on the other.
4. **`packages/sdk/src/events.ts`** — add a builder function to the `Events` object so
   SDK callers get a typed constructor instead of hand-building the payload shape.

If the new type is meant to be a terminal event (like `run.completed`/`run.failed`),
also add it to `TERMINAL_EVENT_TYPES` in both `convex/sdk_ingest.ts` and the SDK's
`recorder.ts` — otherwise the run will never close, or the SDK will accept events after
what should have been the last one.

---

## How To: Add a New Convex Function

Follow the auth-first pattern used throughout `convex/*.ts`:

1. Call `getAuthContext(ctx)` (`convex/auth.ts`) before touching any table. It throws
   `"Unauthorized"` if there is no Clerk identity or no `org_id` claim, and resolves the
   Convex `orgId`.
2. If the action requires a minimum privilege, call
   `requireOrgMembership(ctx, orgId, { minimumRole: "member" | "admin" })` — default is
   `"viewer"`.
3. Scope every query/filter to the resolved `orgId`. No function may return records
   without filtering by the caller's `organizationId` — see `CLAUDE.md` Tenancy Rules.
4. If the mutation is privileged (role changes, retention policy changes, key
   revocation, purges), write an audit row via the helper in `convex/audit.ts` — see
   `AUDIT_ACTIONS` for the closed set of action names.
5. Use stable error codes for anything that crosses to the client and might need
   machine handling: `afrError(code, message)` from `convex/helpers/errors.ts`. If the
   code needs to reach the SDK (not just the web UI), add it to
   `packages/contracts/src/api_errors.ts` (`AFR_API_ERROR_CODES`) and the status mapping
   in `apps/web/src/lib/apiHandler.ts` (`AFR_CODE_TO_STATUS`) — these codes are
   append-only; never rename or remove one a deployed SDK might match on.

The **one exception** to the auth-first pattern is `convex/sdk_ingest.ts`: those
mutations authenticate via a hashed `x-api-key`, not a Clerk JWT, and must never call
`getAuthContext`/`requireOrgMembership`. They still must scope every access to the API
key's own `orgId` — see `resolveApiKey` and the cross-org checks throughout that file.

---

## How To: Add a Field to a Projected Resource

The v1 read API supports server-side projection (`?fields=a,b,c`) on the `runs`, `events`
and `failure_patterns` documents, so **a field existing is no longer the same as a field
being reachable.** Adding one to the schema is necessary but not sufficient: a caller that
names its fields gets exactly what it named, and adding a field upstream does nothing for
it until its own list changes.

Full contract: `docs/api_reference.md` §1 ("Field projection — `?fields=`").

1. **`convex/schema.ts`** — add the field to the table validator (`convex/` boundary).
   **This is also what makes it projectable**: the allowlist is derived from the live
   schema (`Object.keys(schema.tables[table].validator.fields)` in `convex/read_api.ts`),
   not maintained by hand, so there is no separate allowlist to update and no way for the
   two to drift.
2. **`packages/contracts/src/`** — add it to the entity interface and bump the package
   version per `CLAUDE.md` → Contracts versioning. Prefer optional (`field?: T`) for
   anything added to an existing table; documents written before the change will not
   have it.
3. **Check the route forwards `fields`.** All five document-returning v1 routes call
   `parseFieldsParam` (`apps/web/app/api/v1/_lib/fieldsParam.ts`) and forward the list. A
   new route returning stored documents must do the same, or projection is silently
   unavailable on it. That helper validates **shape only** — it deliberately does not know
   which names are valid, so there is exactly one source of truth for the allowlist.
4. **Every client that passes an explicit `fields` list**, if the new field should reach
   it:
   - `packages/mcp/src/projections.ts` — add a `ProjectedColumn` entry to the relevant
     `*_COLUMNS` table. The request lists (`RUN_REQUEST_FIELDS`, `PATTERN_REQUEST_FIELDS`,
     `EVENT_REQUEST_FIELDS`) are **derived** from those tables by `requestFieldsOf`, so
     declaring the column's `source` is all that is needed — do not maintain a parallel
     list.
   - `packages/sdk/src/reader.ts` — `FlightReader` forwards whatever the caller passes;
     nothing to add unless a default list exists.
   - `packages/cli/src/apiClient.ts` — if the CLI requests narrowed records.

**Use the `source` field honestly.** A `ProjectedColumn` with `source: null` is never
requested, and that is reserved for two cases: an identity field the server returns
regardless (`_id` for runs, `sequenceNumber` for events, `fingerprintHash` for failure
patterns), or a value joined in from a separate envelope rather than the document. Giving
a real document field a `null` source silently removes it from the request.

**The silent failure this prevents.** `toColumnar` drops any column that is null across
every row and reports only the surviving columns in its `fields` header. So a column whose
source field was never requested does not throw and does not come back as nulls — it
vanishes from the header entirely, and a consumer indexing by name finds nothing. Deriving
the request list from the column table is what keeps that from happening; do not
short-circuit it.

The column tables are **append-only — never reorder**, because rows are positionally
aligned with the header. Adding a column is safe; moving one is a breaking change for any
consumer that cached an index.

---

## How To: Add a New UI Surface

Any change to `apps/web` components, pages, styles, layout, motion, or graphics **must**
conform to `design.md` ("Neon — Server Room After Dark") — read it before writing any
markup. In short: colors come only from its tokens (Blackout `#000000`, Whiteout
`#ffffff`, Neon Glow `#34d59a`), buttons are pills (`9999px` radius), all other
containers are `4px`, and depth comes from layered near-black surfaces, never
`box-shadow`. If your surface needs something the system doesn't provide, update
`design.md` first, in the same PR.

Every data-dependent view must handle loading, empty, and error states explicitly — no
blank screens, no silent failures (`CLAUDE.md` Design Quality Rules).

---

## How To: Add a New Package

1. Add the package under `packages/` (or a new top-level directory if it isn't a
   library) with its own `package.json` and a `tsconfig.json` extending
   `tsconfig.base.json`.
2. Register it in `CLAUDE.md`: add a row to the System Boundaries table and an entry in
   the File Ownership Map. A package that doesn't appear in `CLAUDE.md` is not
   recognized as owned by any boundary.
3. If it needs shared entity types, import them from `@agent-flight-recorder/contracts`
   — never duplicate entity types across packages.
4. Wire it into `pnpm-workspace.yaml` and `turbo.json` task graph as needed.

---

## Further Reading

- `docs/architecture.md` — system diagram, entity hierarchy, event-log invariants,
  tenancy model, ingest paths and error-code contract, durability story
- `docs/adrs/` and `docs/adr/` — architecture decision records
- `docs/ops/` — CI setup, dependency-audit rationale, observability
- `packages/sdk/README.md` — SDK usage and API reference
- `docs/mcp.md` — the MCP server (`packages/mcp`): tool contract, MCP client config, the
  `read`-scoped key it requires, and the progressive-disclosure tiers its tools implement
