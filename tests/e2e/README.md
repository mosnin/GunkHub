# tests/e2e

Playwright suite for `apps/web`, in two tiers.

| Tier | Files | Runs when | What it proves |
|---|---|---|---|
| Unauthenticated | `unauth.spec.ts` | always | The frontend boots, renders, and responds correctly with **no** backend and **no** real Clerk instance. |
| Authenticated | `auth.setup.ts`, `authenticated.spec.ts` | only when credentials are provisioned | The signed-in product works: run trace, event inspector, replay, diff, failure patterns, resolution lifecycle. |
| Coverage guard | `auth-coverage.spec.ts` | always | States, as a test result, whether the authenticated tier ran. **Fails** the run when it did not. |

Run everything with `pnpm e2e` (from the repo root) or
`pnpm --filter @agent-flight-recorder/tests run e2e`.

---

## Why the authenticated tier exists

Every page worth anything in this product is behind `clerkMiddleware`'s
`auth().protect()` (see `apps/web/middleware.ts`): `/dashboard`, `/runs`,
`/patterns`, `/diff`, `/settings`. Until this tier runs, no signed-in user
journey has ever been exercised by an automated test, at any point in the
product's life.

That gap matters more than a normal coverage gap here, because
`convex/_generated/api.ts` is a hand-written `anyApi` stub. Nothing type-checks
the web↔Convex seam: a renamed Convex function or a changed argument shape
compiles cleanly and fails only at runtime, as a 500 or a silently empty
response. The authenticated journey is the only check that operates at the
level where those failures are visible.

The specs are written accordingly — see the header comment in
`authenticated.spec.ts`. In short: a 200 proves nothing, because `apps/web`
renders a well-designed empty state for every data-dependent view. So every
assertion pairs "real data is present" with "the empty/error copy for this view
is absent", carries values across navigations, and re-asserts mutations after a
reload.

---

## Unlocking the authenticated tier

Four things are required. Steps 1–3 are provisioning; **step 4 was a code-level
blocker and is already fixed on this branch.**

### 1. A Clerk **development** instance

Not a production instance. `clerkSetup()` calls
`testingTokens.createTestingToken()` and throws outright on a production secret
key — Clerk Testing Tokens are a development-instance feature. Concretely you
need a `pk_test_…` / `sk_test_…` pair.

In the Clerk Dashboard for that instance:

- **Enable the password strategy.** `clerk.signIn({ strategy: 'password' })` is
  what `auth.setup.ts` uses. (Clerk's `email_code` / `phone_code` strategies
  also work with their `+clerk_test` addresses and the fixed `424242` code, if
  you prefer those — `auth.setup.ts` would need a one-line change.)
- **Create an organization**, and **add the test user to it**. This is the step
  most easily missed; see step 3.
- **Create the test user** with a known password.

Bot protection does not need to be disabled: `setupClerkTestingToken()` appends
`__clerk_testing_token` to Frontend API requests, which is precisely what it
bypasses.

### 2. A seeded Convex deployment

Set `NEXT_PUBLIC_CONVEX_URL` to a real deployment and seed it:

```bash
NEXT_PUBLIC_CONVEX_URL=https://your-test-deployment.convex.cloud pnpm tsx scripts/seed.ts
```

**The seeded org's `clerkOrgId` must equal the Clerk organization id from step
1.** `apps/web/src/lib/services/*` resolves the Clerk `orgId` to a Convex
organization document via that join key (`CLAUDE.md` § Tenancy Rules), and every
org-scoped query fails to find anything if they disagree. `scripts/seed.ts`
currently hard-codes `org_seed_acme` / `org_seed_rival`, so either edit those to
your real Clerk org id, or let the Clerk webhook
(`apps/web/app/api/webhooks/clerk/route.ts`) create the org record by firing an
`organization.created` event at the test deployment.

#### Seeding the test deployment

The journeys assert against real data and will fail — loudly, with a message
naming this section — if the deployment is empty. The seeded org needs:

- at least **two** runs (one is enough for most journeys; the diff journey needs two),
- at least one run with **recorded events** (for the timeline, event inspector, and replay),
- at least one **failure pattern in `open` status** (for the resolution lifecycle journey).

The lifecycle journey is idempotent: it acknowledges, resolves, then reopens the
pattern, restoring it to `open`.

### 3. Add `@clerk/testing` and set the environment variables

```bash
pnpm --filter @agent-flight-recorder/tests add -D @clerk/testing@^1.4.4
```

**Pin the 1.x line.** `@clerk/testing@2.x` depends on `@clerk/backend` ^3.x and
targets clerk-js v6+, while `apps/web` pins `@clerk/nextjs@5.7.6`
(`@clerk/backend` 1.14.1, `@clerk/clerk-react` 5.12.0). Its browser helpers
drive a `window.Clerk` API this app does not ship.

`tests/e2e/support/clerk-testing.ts` loads the package through a non-literal
specifier precisely so that `pnpm typecheck` keeps passing for everyone who has
not installed it. Once installed, nothing else needs to change.

Then set these six variables (add them to `.env.example` and to the `e2e` CI
job's `env:` block, sourced from repository secrets):

| Variable | Value | Why |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_…` | Clerk **development** instance publishable key. Read by `clerkSetup()` and by `apps/web`. |
| `CLERK_SECRET_KEY` | `sk_test_…` | Same instance's secret key. `clerkSetup()` exchanges it for a Testing Token. Production keys are rejected. |
| `NEXT_PUBLIC_CONVEX_URL` | deployment URL | The seeded Convex deployment from step 2. |
| `E2E_CLERK_USER_USERNAME` | email or username | The test user's identifier. This is Clerk's own documented name for this variable in their Playwright guide. |
| `E2E_CLERK_USER_PASSWORD` | password | The test user's password, for the `password` first-factor strategy. |
| `E2E_CLERK_ORG_ID` | `org_…` | The Clerk organization to **activate on the session**. See below — this one is not optional and not obvious. |

#### Why `E2E_CLERK_ORG_ID` is required

`clerk.signIn()` only calls `setActive({ session })`. It never sets an active
**organization**. But `apps/web/src/lib/auth.ts` does:

```ts
if (!session.orgId) {
  throw new Error('No organization selected')
}
```

So a correctly signed-in user with no active org fails on every org-scoped page
with an error boundary rather than an auth redirect — a confusing failure that
looks nothing like a credentials problem. `auth.setup.ts` therefore calls
`window.Clerk.setActive({ organization })` explicitly after signing in, and
asserts the dashboard renders before saving the storage state.

### 4. (Already fixed) The `playwright.config.ts` wiring

Before this branch, provisioning all of the above would still not have worked.
Playwright spawns the `webServer` with `{ ...process.env, ...webServer.env }` —
the config's `env` **wins** over the ambient environment. `playwright.config.ts`
hard-coded `DUMMY_ENV` there, so a real `CLERK_SECRET_KEY`,
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_CONVEX_URL` exported in the
shell were overwritten with placeholders and `next start` always came up
pointing at a fake Clerk domain. The config now passes real values through when
`readAuthTierConfig()` reports the tier configured, and falls back to
`DUMMY_ENV` otherwise.

---

## What an unconfigured run reports

`auth-coverage.spec.ts` fails, and the failure message is the report:

```
AUTHENTICATED E2E COVERAGE: 0 of 10 journeys executed.

This run exercised the UNAUTHENTICATED tier only. Everything behind Clerk auth —
the entire product — was not loaded by a browser in this run. ...

Journeys with ZERO coverage:
  ✗ app shell renders for a signed-in user with an active organization
  ✗ dashboard renders real org data (not the no-runs zero state)
  ...

Missing or placeholder environment variables:
  - E2E_CLERK_USER_USERNAME
      Identifier (email or username) of a seeded Clerk test user. ...
```

This replaces the previous `test.skip(true, …)` in `auth.spec.ts`. A skip is a
reassuring signal generated by an absence of information: the run went green,
the summary said "1 skipped", and the fact that no signed-in journey had ever
run was a footnote nobody read. It is the same failure mode this codebase spent
two cycles removing from its dashboard.

A variable is treated as missing when it is unset, empty, **or still holding a
documented placeholder value** (`pk_test_replace_me`, the `DUMMY_ENV` values,
etc.), so half-configuring the tier does not read as configured.

### The escape hatch

Setting `AFR_E2E_ACK_NO_AUTH_COVERAGE=1` downgrades the failure to a Playwright
annotation. The full report still prints.

That variable **records an accepted gap; it does not close one.** It exists so a
team can consciously carry the gap for a bounded window. Adding it to CI to
restore green re-creates exactly the silence this file removed — if you do it,
put an expiry on it.

---

## Files

| File | Role |
|---|---|
| `unauth.spec.ts` | Unauthenticated tier. Unchanged by this work. |
| `auth-coverage.spec.ts` | The zero-coverage guard. Opens no browser. |
| `auth.setup.ts` | Playwright setup project: sign in, activate org, save storage state. |
| `authenticated.spec.ts` | The ten authenticated journeys. |
| `support/auth-tier.ts` | Env detection and the zero-coverage report. Imported by `playwright.config.ts`. |
| `support/clerk-testing.ts` | Loader for `@clerk/testing/playwright` + `activateOrganization`. |
| `support/global-setup.ts` | Calls `clerkSetup()` when configured; no-op otherwise. |
| `support/journey.ts` | The 5xx/page-error auto-fixture and shared assertions. |
| `fixtures/` | The unauthenticated tier's dev-browser cookie. See its own README. |
| `.auth/` | Gitignored. Holds the live signed-in session written by `auth.setup.ts`. |

## Selector conventions

`apps/web` has **no `data-testid` attributes anywhere**. Selectors here lean on
roles, `aria-label`, `aria-current`, and `href` — all of which are load-bearing
for accessibility and routing, so they break only when behaviour breaks. Body
copy is used only where nothing else identifies the element, and is quoted
exactly from the component.

Adding testids to the sidebar nav, run table rows, the pattern status badge, and
the lifecycle buttons would make this suite meaningfully more robust. That is an
`apps/web` change and belongs to the ui team.
