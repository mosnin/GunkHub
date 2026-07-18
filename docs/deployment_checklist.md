# Deployment Checklist — Agent Flight Recorder

Use this checklist when moving between environments. Work through each section in
order. Every unchecked item is a potential failure mode in production.

There is no `vercel.json` in this repo — Vercel deploy configuration (build command,
framework detection) relies entirely on Next.js defaults and the Vercel dashboard
project settings, not a checked-in config file.

---

## Deploy ordering: Convex before web

**Convex and web deploy independently — order matters.** If a change adds a Convex
schema field (or a new/changed query, mutation, or action) that the web app depends
on reading or calling, **deploy Convex first, then web.** If web ships first, every
request that touches the new field/function breaks until the Convex deploy lands
(worst case: `ConvexTimeoutError`/500s if the function doesn't exist yet, or silent
`undefined` reads if a field is missing and not required).

The `schema-drift` CI job (`.github/workflows/ci.yml`, `pnpm tsx
scripts/check-schema-drift.ts`) is a **pre-merge** gate — it compares field names in
`convex/schema.ts` against `packages/contracts/src/entities.ts` and fails the build
if one side added a field the other doesn't have. It catches drift between the
contracts package and the Convex schema; it does NOT enforce deploy order — a
correctly-drift-free PR can still be deployed to Convex and Vercel out of order after
merge. Ordering discipline is an operator responsibility at deploy time, not something
CI blocks.

**Practical sequence for a schema/function change:**
1. `npx convex deploy` (pushes schema + functions to the target Convex deployment).
2. Confirm in the Convex dashboard that the deploy succeeded and the new fields/
   functions are live.
3. Deploy web (`vercel deploy --prod`, or push to `main` if auto-deploy is enabled).

**Rolling back the same change:** reverse the order — revert/redeploy web first (stops
new writes/reads assuming the new shape), then revert Convex. See "Rollback
procedure" below and `docs/ops/incident_response.md` playbook (d) for the full bad-
deploy triage.

---

## Pre-deployment (all environments)

- [ ] `pnpm typecheck` passes with zero errors across all packages
- [ ] `./scripts/validate.sh` passes all checks (typecheck, build, lint, schema-drift)
- [ ] `pnpm test` passes — no regressions
- [ ] `.env.local` is complete — all required variables are set (see `.env.example`
  and the environment variable matrix below)
- [ ] No `.env.local` or secret files are staged for commit

---

## Environment variable matrix

Source of truth is `.env.example` (verified against `apps/web/src/lib/env.ts` and
each consuming route). "Required in" indicates where the variable is required.

| Variable | Required in | Notes |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | All (dev, CI, staging, prod) | Public. Validated at browser startup — throws `Missing required env var: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` if absent (`env.ts`). CI supplies a placeholder (`pk_test_ci_placeholder`) since builds don't need a real key. |
| `NEXT_PUBLIC_CONVEX_URL` | All | Public. Same startup validation as above. CI supplies `https://ci-placeholder.convex.cloud`. Format: `https://<deployment-name>.convex.cloud`. |
| `CLERK_SECRET_KEY` | Staging, prod (server-only) | Validated lazily at first use via `assertServerEnv(...)`, not at module load (so `next build` doesn't fail without it). Not required for typecheck/build/lint. |
| `CLERK_WEBHOOK_SECRET` | Staging, prod | Validates Svix signatures on `/api/webhooks/clerk`. Supports the dual-accept rotation format (`current,previous`) via `getAcceptedSecrets()` — see the "Secret rotation" section of `docs/operations_runbook.md` for the rotation procedure (owned separately from this doc). |
| `CLERK_JWT_ISSUER_DOMAIN` | Staging, prod | Used in `convex/auth.config.ts` to trust Clerk-issued JWTs. Must match the Clerk instance's frontend API domain — a staging/prod mismatch here is a common source of silent auth failures. |
| `CONVEX_WEBHOOK_SECRET` | Staging, prod | Shared secret set on BOTH the Vercel project and the Convex deployment (`npx convex env set CONVEX_WEBHOOK_SECRET <value>`) — authorizes the webhook route to call webhook-only lifecycle mutations. Also supports dual-accept rotation. |
| `CONVEX_DEPLOY_KEY` | CI/CD (non-interactive deploys) | Used by `npx convex deploy` outside interactive `convex dev`. Not needed for local dev. Treat as a password — never log or commit it. |
| `BLOB_STORE_TOKEN` | Prod (required); optional elsewhere | When unset, `getHealthData()` reports `storage.adapter: "stub"` — an in-memory adapter that loses data on process restart. Production with the stub adapter is flagged `status: "degraded"` by `/api/health`. Also required as a **Convex environment variable** (`npx convex env set BLOB_STORE_TOKEN ...`) for the artifact GC cron and the retention purge's best-effort blob deletion — this is a SEPARATE setting from the Vercel/Next.js env var of the same name and must be set on every Convex deployment independently (dev, ci-test, staging, prod). |
| `BLOB_STORE_URL` | Prod (required); optional elsewhere | Public base URL of the blob store. Used by `checkHealth()`'s blob-reachability HEAD probe. |
| `AFR_API_KEY` | SDK consumers only | NOT consumed by the web app or Convex at boot — no startup validation. Documented so operators know what the in-app setup snippets refer to. |
| `INTERNAL_VERIFY_SECRET` | Optional (enables full replay/projection verification) | Protects `/api/internal/verify-derivation`, called by the Convex `verifyRecentRuns` scheduled action. Unset → the route returns 503 and Convex falls back to sequence-only verification (degraded but non-fatal). Also supports dual-accept rotation. |
| `CONVEX_TEST_URL`, `TEST_API_KEY`, `TEST_AGENT_ID` | CI integration-test job only (repository secrets, not `.env.local`) | Target the permanent `ci-test` Convex deployment. See `docs/ops/ci_setup.md` for provisioning. Absent on `main` fails CI (release gate); absent on feature branches skips with a visible warning. |

**CI note:** standard CI jobs (typecheck, lint, build, test, schema-drift) never need
real secrets — the `env:` block in `.github/workflows/ci.yml` injects placeholder
values for the two vars `env.ts` validates at browser-startup time
(`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_CONVEX_URL`). Do not remove these
placeholders from the workflow.

---

## Convex deployment

- [ ] Run `npx convex deploy` to push the schema and functions to the target deployment
- [ ] Verify in the Convex dashboard that all tables are present: `organizations`,
  `projects`, `agents`, `agent_versions`, `runs`, `events`, `artifacts`, `comments`,
  `user_memberships`, `api_keys`, `verification_results`, `audit_log`
- [ ] Verify indexes are in place (check the schema tab in the Convex dashboard)
- [ ] Set Convex-side environment variables independently for this deployment:
  `npx convex env set BLOB_STORE_TOKEN <token>` (required for artifact GC and
  retention-purge blob deletion to work — see the env var matrix above),
  `npx convex env set CONVEX_WEBHOOK_SECRET <value>` (must match the Vercel-side value)
- [ ] Verify `CLERK_JWT_ISSUER_DOMAIN` in `convex/auth.config.ts` matches the target
  Clerk instance's frontend API domain for THIS environment (staging and prod use
  different Clerk instances — see "Staging vs prod separation" below; a mismatched
  issuer domain here fails auth silently)
- [ ] Verify `NEXT_PUBLIC_CONVEX_URL` (Vercel side) is set to this deployment's URL
  (format: `https://<deployment-name>.convex.cloud`)
- [ ] If this deploy adds/changes schema fields the web app reads: confirm web has
  NOT already been deployed with code expecting the new shape (see "Deploy ordering"
  above)

---

## Clerk setup

- [ ] A Clerk application exists for this environment (see "Staging vs prod
  separation" — staging and prod must each have their own Clerk application, not a
  shared one) at https://dashboard.clerk.com
- [ ] `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` set to this environment's publishable key
  (`pk_live_...` for prod, `pk_test_...` for staging/dev)
- [ ] `CLERK_SECRET_KEY` set to this environment's secret key (`sk_live_...` / `sk_test_...`)
- [ ] Clerk JWT Template named exactly `"convex"` is configured:
  Clerk Dashboard → JWT Templates → New Template → select "Convex" → name "convex"
- [ ] Clerk webhook endpoint configured: Clerk Dashboard → Webhooks → Add Endpoint →
  `https://<this-environment's-domain>/api/webhooks/clerk`
- [ ] Clerk webhook subscribed to the following events — **the route
  (`apps/web/app/api/webhooks/clerk/route.ts`) actively handles all six; subscribe to
  all of them, not just the three listed in `.env.example`'s setup comment** (that
  comment predates the deletion-handling code path and is out of date):
  - `organization.created`
  - `organization.updated`
  - `organization.deleted` — marks `pendingDeletionAt`; see the erasure-obligation
    step in `docs/ops/incident_response.md` playbook (c)
  - `organizationMembership.created`
  - `organizationMembership.updated`
  - `organizationMembership.deleted` — access-control-critical; see playbook (c) for
    why a missed delivery here is high severity
- [ ] `CLERK_WEBHOOK_SECRET` set to the signing secret from the webhook endpoint
  (format: `whsec_...`)
- [ ] `CLERK_JWT_ISSUER_DOMAIN` set to this Clerk instance's frontend API domain
  (Clerk Dashboard → API Keys → Advanced → JWT Issuer Domain) and matches what was
  set on the Convex side in the previous section

---

## Blob storage (required for event payloads > 10 KB)

- [ ] Blob store created (Vercel dashboard → Storage → Blob → Create Store)
- [ ] `BLOB_STORE_TOKEN` set on Vercel (Storage → your store → `.env.local` tab)
  AND on the Convex deployment (`npx convex env set BLOB_STORE_TOKEN <token>`) — these
  are two independent settings; setting only the Vercel one leaves artifact GC and
  retention-purge blob deletion silently non-functional (Convex logs will show
  skipped/failed blob deletions, not a hard error)
- [ ] `BLOB_STORE_URL` set to the public base URL of the blob store
  (format: `https://<store-name>.public.blob.vercel-storage.com`)
- [ ] Smoke test artifact upload:
  ```
  curl -X POST https://<domain>/api/artifacts/upload \
    -H "x-api-key: <your-api-key>" \
    -H "Content-Type: application/json" \
    -d '{"runId":"test","key":"test/smoke.json","payload":"'$(python3 -c "print('x'*11000)"}'"}'
  ```
  Expected: HTTP 200 with `{ "storageKey": "...", "checksum": "...", "size": ... }`
- [ ] `GET /api/health` shows `storage.adapter = "vercel"` and `storage.configured = true`

---

## Vercel deployment

- [ ] All environment variables from the matrix above are set in Vercel project
  settings for the target environment (Settings → Environment Variables →
  Production, or the appropriate Preview/staging scope — see "Staging vs prod
  separation" for why these must be separate sets, not the same values reused)
- [ ] Run `vercel deploy --prod` (or push to `main` if auto-deploy is enabled) — only
  AFTER the corresponding Convex deploy has landed if this deploy depends on new
  Convex schema/functions (see "Deploy ordering" above)
- [ ] Deployment completes without build errors
- [ ] Smoke test: visit the deployed domain, sign in with Clerk, create or join an
  org, verify the dashboard loads with no console errors
- [ ] Verify the run list page loads without errors (may be empty — that is fine)

---

## Staging vs prod separation

Staging and production must NOT share infrastructure. Concretely, each environment
needs its own:

- **Convex deployment.** Separate deployment names/URLs — never point a staging
  Vercel deployment at the production `NEXT_PUBLIC_CONVEX_URL`. This is the single
  most consequential separation: sharing a Convex deployment means staging test data
  and production tenant data live in the same tables, and a staging schema
  experiment can break production reads.
- **Clerk instance/application.** Separate Clerk applications (not just separate
  environments within one Clerk app), each with its own publishable/secret key pair,
  its own webhook endpoint + signing secret, and its own JWT issuer domain. Clerk org
  IDs are only meaningful within the Clerk instance that issued them — Convex
  `organizations.clerkOrgId` records from one Clerk instance are meaningless (and a
  potential confusion/security hazard) if pointed at a different instance's users.
- **Env var sets.** Each environment gets its own full set from the matrix above —
  do not copy a production `BLOB_STORE_TOKEN`, `CLERK_SECRET_KEY`,
  `CONVEX_WEBHOOK_SECRET`, or `CONVEX_DEPLOY_KEY` into staging. A leaked or
  compromised staging credential should never grant access to production data.
- **Blob store.** Separate Vercel Blob store per environment, for the same
  data-isolation reason — staging smoke tests and DR drills (see
  `docs/ops/dr_drill.md`) will write and delete objects; that must never touch
  production blobs.

The permanent `ci-test` Convex deployment (used by CI's `integration-test` job, see
`docs/ops/ci_setup.md`) is a THIRD environment, distinct from both staging and
production — do not reuse it as a staging environment or restore-drill target (the
DR drill in `docs/ops/dr_drill.md` explicitly calls out not overwriting it).

---

## Post-deployment verification

- [ ] `GET /api/health` returns HTTP 200 with `"status": "ok"` and
  `dependencies: { "convex": "ok", "blob": "ok" }` (or `"skipped"` for blob in
  non-prod environments without blob storage configured)
  ```json
  {
    "status": "ok",
    "storage": { "adapter": "vercel", "configured": true },
    "dependencies": { "convex": "ok", "blob": "ok" },
    ...
  }
  ```
  If `adapter` is `"stub"` in production: `BLOB_STORE_TOKEN` env var is missing.
  Add it in Vercel project settings and redeploy.
- [ ] SDK end-to-end smoke test: run the SDK against the deployed URL with a real API
  key, record a short run, and verify it appears in the dashboard
- [ ] Check the Convex dashboard → Logs tab for any function errors in the last 5 minutes
- [ ] Check the Vercel log drain / Functions logs for any 500 responses on API routes
  (see `docs/ops/observability.md` for how logs are structured and where to look)

---

## Rollback procedure

If a deployment is broken and must be reverted immediately, see
`docs/ops/incident_response.md` playbook (d) ("Bad deploy") for the full triage and
rollback steps, including the reverse-ordering rule for schema-dependent rollbacks.
Summary:

1. **Vercel rollback**: Vercel dashboard → Deployments → locate the previous stable
   deployment → three-dot menu → Promote to Production. This is near-instant.
2. **Convex rollback** (only if schema/functions changed): Convex does NOT support
   automatic schema rollback — revert the `convex/schema.ts`/function commit and run
   `npx convex deploy`. Data written under the new schema during the bad window may
   be incompatible with the reverted schema; assess before reverting.
3. Verify `GET /api/health` returns `"status": "ok"`.
4. Notify the team via the agreed incident channel and open a post-mortem issue.
