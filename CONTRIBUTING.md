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
**build**, **build-integrity** (`scripts/check-build-integrity.ts`, stale/partial `dist/`
artifacts — must run *after* `build`; see "Build Integrity" below), **lint** (7 Turbo
tasks), **schema-drift** (`scripts/check-schema-drift.ts`,
the Convex schema against its generated types), **convex-refs**
(`scripts/check-convex-refs.ts`, the hand-maintained `makeFunctionReference` strings in
`apps/web/src/lib/convexFunctions.ts` against the real `convex/*.ts` registrations), and
**design-tokens** (`scripts/check-design-tokens.ts`, `apps/web` against `design.md`).
All must pass. You can run a subset: `./scripts/validate.sh typecheck lint`.

`pnpm test` runs all unit test suites (`tests/unit/**`, plus package-local `*.test.ts`
files). CI additionally runs a real-Convex integration job
(`tests/integration/api.test.ts`) gated on `CONVEX_TEST_URL` being configured as a repo
secret — see `docs/ops/ci_setup.md`. That job is a hard release gate: merging to `main`
without the secret configured fails CI.

CI (`.github/workflows/ci.yml`) runs ten jobs: typecheck, lint, dependency-audit,
schema-drift, convex-refs, convex-codegen-sync, design-tokens, build, test, and
integration-test — on every push to `main`/`feature/**`/`fix/**`/`claude/**` and every
PR into `main`. A weekly `schedule` trigger (Mondays 06:00 UTC) runs *only*
dependency-audit; every other job is gated on `github.event_name != 'schedule'`.

---

## The MCP Token Budgets Are a Release Gate

This is the gate people most often mistake for a nicety, so it gets its own section.

**The budget is the product claim.** `packages/mcp` exists because an agent asking "why
did I fail?" by pulling the trace into its context has no budget left to think. The
whole value proposition is a measurable ratio: `afr_triage()` costs **~332 tokens** and
tells you what is broken and what to call next, where a single saturated 50-event window
from `afr_get_run_events` costs **~3,844** and tells you nothing you did not already have
to know to make the call. That is roughly **12x**, and it is the reason the package is
worth shipping at all.

Nothing in the type system protects it. `FailurePattern` declares 29 top-level fields
and `PATTERN_COLUMNS` emits 8 of them; adding a ninth is a one-line change that
type-checks, passes every shape test, and quietly moves the ratio. A tool that grows past
its budget does not break — it just stops being worth calling, and nobody finds out.
Response *size* is the claim, so response *size* is what gets asserted.

### The gate

```bash
pnpm build && pnpm tsx scripts/check-token-budgets.ts
```

The build is not optional: the script imports `packages/mcp/src/**` as *source* so it
measures the tree rather than a stale bundle, and that source resolves
`@agent-flight-recorder/sdk` and `/contracts` to their `dist/`.

What makes it different from the assertions that already existed:

- **Exhaustive by construction.** It calls `createServer()` and enumerates the tools from
  **the server's own registry**. A registered tool with no declared budget fails
  (`NO_BUDGET`); a declared budget for a tool that is no longer registered fails
  (`STALE_BUDGET`). Adding a tool cannot be done quietly.
- **Measured end to end.** Each of the 14 scenarios invokes the **registered handler**
  against a stub reader and measures the exact `text` an MCP client receives. A tool that
  wraps a lean projection in a fat envelope is over budget, and only the handler's own
  output shows that.
- **Absolutes only.** Every budget is an integer with its derivation written beside it.
  Ratios are computed and printed as commentary; nothing passes on one. Tier 4's ceiling
  used to be `RAW_DUMP_TOKENS / 10` — a ceiling that rose whenever someone raised the
  assumed raw-dump size. It is `10_000` now.
- **Fixtures proved maximal, not claimed maximal.** The contracts source is parsed with
  the TypeScript AST, and every declared property of `FailurePattern`, `Run`, `Event`,
  `RunExplanation` and the evidence envelope must be populated, or the scenario fails
  `FIXTURE_NOT_MAXIMAL`. A field added to a contract without being added to the fixture
  makes the guard notice its own inputs went stale.
- **Failures name the field, not the number.** A blown budget prints per-field byte
  attribution. "expected 465 to be <= 300" is a failure nobody can act on, and a failure
  nobody can act on gets deleted the first time it goes red.

The projection-level suites are **not** replaced by it and still run under `pnpm test`:
`tests/unit/mcp_progressive_disclosure.test.ts`, `mcp_triage.test.ts`,
`mcp_triage_measure.test.ts` and `mcp_triage_next_hops.test.ts` carry the shape guards,
which catch a projection emitting a field it is not allowed to *even when the byte count
would still fit*. `tests/unit/mcp_budgets.ts` is now the single declaration of every
budget and of the estimator that all of them import — before it, `450` appeared in three
files and `300` in two, with only one copy of each carrying the derivation.

Note that **`packages/mcp` has no `test` script of its own**, so
`pnpm --filter @agent-flight-recorder/mcp test` runs nothing at all. Do not read its
silence as a pass.

### The obligation that comes with it

1. **Adding an MCP tool means declaring a budget in the same commit.** You no longer have
   to remember: the registry enumeration fails the build with `NO_BUDGET` if you don't.
   Declare it with the derivation written next to it — a ceiling nobody can explain is a
   ceiling that gets raised the first time it goes red.
2. **Lowering a measurement means lowering the baseline in the same commit.** This is the
   half people skip. `scripts/token-budget-baseline.json` is a ratchet, not a config:
   - `measured > budget` → fail. The published ceiling was breached. Cut the response.
   - `measured > baseline` → fail, separately. Under the ceiling but above where we were;
     silent drift inside the headroom is how a ceiling gets reached. If the increase is
     deliberate, run `pnpm tsx scripts/check-token-budgets.ts --write-baseline` so the new
     number lands as a reviewable diff in the same commit.
   - `measured < baseline` → **pass**, and it prints the delta with an instruction to
     lower the file. Failing CI on the commit that improves things is how ratchets get
     deleted, so it does not — but a stale-high baseline cannot hide either, because the
     delta prints on every run.

   `--write-baseline` refuses to record any value above its own budget. A baseline may
   record where we are; it may never bless a breached ceiling.
3. **A pre-existing breach is frozen, not waived.** A scenario already over budget when
   the guard found it is recorded as a `knownBreach` with its owner and its fix written
   out. It reports as `FROZEN_BREACH` and does not block — but the recorded number may
   only **fall**: one token more and it blocks, and the guard fails if the entry outlives
   the breach. It is debt with a receipt, not an exemption.
4. **Never raise a budget to make the script green.** The ceiling is the product claim.
   Either the response gets smaller, or the increase is deliberate and gets argued for in
   review as a change to the claim.
5. **Update `docs/mcp.md` when a published figure moves.** Its cost table and its
   "Where the token figures come from" section quote the script's output; the two going
   out of step is the drift the script exists to prevent, one level up.
6. **An event-count cap is not a byte cap.** `MAX_LIMIT` (50,
   `packages/mcp/src/tools/get-run-events.ts`) bounds how many events a window returns;
   `PAYLOAD_PREVIEW_BYTE_CAP` (400) and `WINDOW_PAYLOAD_BYTE_BUDGET` (8,000), both in
   `projections.ts`, bound what it costs. Payloads under the 10 KB externalization
   threshold are inlined verbatim, so a cap on rows alone lets one window cost more than
   the raw dump the package exists to replace.

### Measured, on this tree

Transcribed from an actual run at commit `600b4f8` plus the guards' own (then untracked)
landing. Estimator: `ceil(utf8ByteLength(JSON.stringify(x)) / 4)`.

| Tool / scenario | Measured | Budget |
|---|---|---|
| `afr_triage` typical | 332 | 450 |
| `afr_triage` worst case | 435 | 450 |
| `afr_triage` clear | 32 | 450 |
| `afr_list_failure_patterns`, 10 / 20 / 100 | 294 / 561 / 2,681 | 300 / 600 / 2,800 |
| `afr_get_pattern_evidence` | 423 | 450 |
| `afr_explain_run` realistic / contract-maximal / pending | 121 / **203** / 24 | 200 |
| `afr_get_run_events` externalized / inline | 3,844 / 3,390 | 10,000 |
| `afr_list_runs`, 20 / 100 | 475 / 2,250 | 600 / 2,800 |

**The guard found a real defect on its first run, and it is frozen rather than fixed.**
`afr_explain_run`'s contract-maximal scenario measures **203 against a budget of 200**,
recorded as a `knownBreach`, so the script exits `0` but the number may only fall.

The root cause is worth reading, because it is the argument for measuring the handler in
miniature. `toExplainRunResult` caps the three prose fields (`SUMMARY_BYTE_CAP`,
`ROOT_CAUSE_BYTE_CAP`, `SUGGESTED_FIX_BYTE_CAP`) and forwards `citedSequenceNumbers`
**verbatim**. The previously published "192, budget 200" was measured against an
explanation citing five sequence numbers; `RunExplanation` documents the bound as ≤ 20
(`packages/contracts/src/run_explanations.ts`). Measured: 5 citations → 192, 10 → 196,
15 → 200, 20 → **204**. The tier was under budget only because real explanations happen
to cite few events — a property of the generator, not a guarantee of this layer, which is
the exact argument the prose caps were added for, left unfinished on the one field that
is an array.

The fix is to cap `citedSequenceNumbers` the way the prose fields are capped (10 keeps it
at 196 with headroom); the citations are a handle into tier 4 and a caller needing a 16th
can page. It belongs to the `packages/mcp` owner. **Do not raise the 200**, and delete
the `knownBreach` entry in the same commit as the fix — the guard fails if the entry
outlives the breach.

### Still open

- **`scripts/check-token-budgets.ts` is not wired in.** It is in neither
  `scripts/validate.sh` nor `.github/workflows/ci.yml`, so nothing runs it automatically;
  it is a command you have to remember. `check-build-integrity.ts` *is* in `validate.sh`
  (as `build-integrity`, after `build`) but is likewise absent from CI. Add both to CI,
  and this document's check list, when that lands.
- **The script declares its budgets inline** rather than importing
  `tests/unit/mcp_budgets.ts`. They agree today (450 / 300 / 200 / 10,000) but they are
  still two copies — the last consolidation step, flagged in `mcp_budgets.ts`'s own
  header, which also argues the budgets should ultimately live in `packages/mcp/src/`
  beside the projections they constrain, where the author widening one would actually
  see them.

---

## Build Integrity — the false green a clean wipe does not cure

`scripts/check-build-integrity.ts` exists for one specific failure, and it is worth
understanding because the reflex fix does not work on it.

**The incident.** A field was deleted from an interface in `packages/sdk` to mutation-test
a guard. `tsc --noEmit` passed clean, exit 0 — because `packages/sdk/dist/index.d.ts`
still declared the deleted field. The package's `tsup` run had failed at its DTS step and
**left the previous `.d.ts` in place**. Every downstream typecheck was happily checking
against yesterday's types.

**`rm -rf packages/*/dist` does not catch it.** The stale artifact is produced by a build
that *ran and partially failed*, not by one that never ran. A cold wipe has cured every
other false green this project has hit; it does not cure this one, because the next build
re-creates exactly the same partial state.

Two checks, each asserting a property a partial build actually violates:

- **CHECK 1 — declared, therefore present.** Every path a package's `package.json`
  promises (`main`, `module`, `types`, `bin`, every string leaf of `exports`) that points
  into `dist/` must exist and be non-empty.
- **CHECK 2 — one build, one artifact set.** Within a `dist/`, the type artifacts
  (`.d.ts`/`.d.mts`/`.d.cts`) must not **predate** the code artifacts
  (`.js`/`.mjs`/`.cjs`). tsup emits JS first and declarations last, so in a healthy build
  declarations are always newer. Declarations *older* than the JS beside them means the
  two did not come from one invocation.

That asymmetry is the design point: "declarations newer than JS" is healthy by
construction no matter how slow the DTS step was, so there is no threshold to tune and no
slow-CI false alarm. Only the inverted direction is reported, with a 2 s epsilon for
filesystem granularity. In the reproduction the inversion was **10.8 s** — a
magnitude-based rule with a "generous" 60 s threshold would have missed the real incident.

**The root-cause fix is elsewhere and is not yours to assume.** tsup already exits 1 on a
failed DTS step; the defect is that the failed run leaves the old `.d.ts` behind.
`packages/cli` and `packages/mcp` set `clean: true` and so do not; `packages/contracts`
and `packages/sdk` build without `--clean` and so do. Adding `--clean` to those two is
the right prevention (`packages/**` — needs its boundary owner) and converts a CHECK 2
failure into a CHECK 1 failure. Both checks stay useful either way, because they assert
the **outcome** rather than trusting anyone's build flags to stay put.

Run it **after a build**: `pnpm tsx scripts/check-build-integrity.ts`. Exit `0` intact,
`1` a real finding, `2` the checker itself could not run.

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

## How To: Add or Reshape an MCP Tool

`packages/mcp` is a **read surface only** (`CLAUDE.md` → System Boundaries): every tool
is a `GET` over `/api/v1/**`, it never imports from `convex/`, and it holds no deploy
key or Clerk session. Beyond that, the constraint that catches people out is the token
budget — the tool set is a progressive-disclosure ladder, and a tool that returns more
than its tier costs is not a feature, it is the defect the package exists to prevent.

1. **Read `docs/mcp.md` → "Start here" first.** It has the ladder, the measured cost of
   each tier, and where a new tool would sit on it. A tool that does not make some
   question *cheaper* than the tier below it does not belong.
2. **Add the projection to `packages/mcp/src/projections.ts`, not to the tool module.**
   That file is the output shape; the tools are a thin shell around it. Emitted columns
   are declared in a `ProjectedColumn` table (`RUN_COLUMNS`, `PATTERN_COLUMNS`,
   `EVENT_COLUMNS`) and the `?fields=` request list is *derived* from that table by
   `requestFieldsOf` — never maintained alongside it. See "Add a Field to a Projected
   Resource" above for the multi-boundary version.
3. **Register the tool in `packages/mcp/src/server.ts`** and set
   `annotations: { readOnlyHint: true }`.
4. **Declare a budget in the same PR** — `tests/unit/mcp_progressive_disclosure.test.ts`
   for tiers 1–4 and `afr_list_runs`, `tests/unit/mcp_triage.test.ts` for tier 0. Those
   suites drive the real exported projections against deliberately *maximal* fixtures
   and fail the build when a projection widens. Response size is the value proposition,
   so response size is what gets asserted — a shape-only test goes green while someone
   bolts an unbounded array onto a row. **Nothing currently cross-checks the registered
   tool list against the assertions**, so an unbudgeted tool ships silently; see
   "The MCP Token Budgets Are a Release Gate" above for the full obligation, including
   what to do when a measurement goes *down*.
5. **An event-count cap is not a byte cap.** `MAX_LIMIT` bounds how many events a
   window returns; `PAYLOAD_PREVIEW_BYTE_CAP` / `WINDOW_PAYLOAD_BYTE_BUDGET` bound what
   it costs. Payloads under the 10 KB externalization threshold are inlined verbatim,
   so a cap on rows alone lets a single window cost more than the raw dump the package
   exists to replace.
6. **Do not drop a truth-bearing flag in the projection.** `scanTruncated` on
   `GET /api/v1/patterns` is the live example: the backend distinguishes "nothing
   matched" from "the scan ran out of budget", and tier 1's projection currently
   forwards neither to the caller. A caller that cannot tell those apart reads an
   incomplete scan as an all-clear. If a response carries a "this answer is a floor"
   marker, the projection must carry it too.
7. **Update `docs/mcp.md`** — the tool contract section, and the cost table if the
   measured numbers moved. That page carries a verification-status banner splitting
   what was verified by reading the code from what was not; keep new claims on the
   correct side of it. No Convex deployment has ever existed for this project, so
   nothing here has been exercised end to end, and the docs must keep saying so.

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
- `docs/mcp.md` — the MCP server (`packages/mcp`). Its "Start here" section is the
  progressive-disclosure ladder with measured per-tier token costs, a worked example of
  the intended investigation path, and the CI-gate/`scanTruncated` semantics; the rest
  is the tool contract, MCP client config, and the `read`-scoped key it requires
- `docs/api_reference.md` — the HTTP contract behind both read clients: `/api/v1/**`
  endpoints and their envelope, `?fields=` projection, key management, the
  alerts/webhooks management API, and the `afr` CLI's exit codes
