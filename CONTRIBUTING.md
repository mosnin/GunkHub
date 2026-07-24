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

### The `tests/` package has two typecheck projects

`pnpm --filter @agent-flight-recorder/tests typecheck` runs **two** `tsc` invocations,
not one. Nothing extra to remember day to day — `pnpm typecheck` and `validate.sh` both
pick this up — but it matters if you add a test that imports backend code.

| Project | Covers | Notable option |
|---------|--------|----------------|
| `tests/tsconfig.json` | every test **except** the seam files listed in its `exclude` | `exactOptionalPropertyTypes: true` (inherited from `tsconfig.base.json`) |
| `tests/tsconfig.convex-seam.json` | only the seam files, plus whatever `convex/` code they pull in | extends `convex/tsconfig.json`, so `exactOptionalPropertyTypes: false` |

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

---

## Boundary Ownership Map

Mirrors `CLAUDE.md`'s System Boundaries table and `.github/CODEOWNERS`. Identify which
boundary a file belongs to before editing it, and do not cross a boundary you haven't
been assigned without explicit instruction.

```
apps/web/**             → web boundary (UI, API routes, Clerk integration, Next.js config)
packages/contracts/**   → contracts boundary (shared types only, zero runtime deps)
packages/sdk/**         → sdk boundary (client recording library)
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
