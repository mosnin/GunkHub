# CI Setup Runbook

This document describes how to configure CI for the Agent Flight Recorder monorepo,
including the release gate policy for real-Convex integration tests.

---

## Release Gate Policy

The `integration-test` CI job runs on every push and PR. Its behavior depends on
whether the three required secrets are configured:

| Secret status | Branch | Behavior |
|---------------|--------|----------|
| Secrets present | Any | Real-Convex tests run. Job fails if any test fails. |
| Secrets absent | Feature/fix branch | Tests skipped with a visible CI warning. Job passes. |
| Secrets absent | `main` branch | Job **fails** with an explicit release gate error. |

**This means:** merging to `main` without the integration secrets configured will fail CI.
This is intentional — it prevents shipping a release that has never had its integration
coverage confirmed.

The CI notice/warning step makes the integration test status explicit on every run:
- Green notice = secrets present, tests ran
- Yellow warning = secrets absent, tests skipped (allowed on feature branches)
- Red error = secrets absent on main (blocks merge)

---

## Integration Test Secrets

The real-Convex integration tests (`tests/integration/api.test.ts`) require three
repository secrets. Without them, the `describe.skipIf` guard skips the real-Convex
describe block gracefully — local developer runs without these env vars still pass.

### Required secrets (repository Settings → Secrets and variables → Actions)

| Secret name       | Description |
|-------------------|-------------|
| `CONVEX_TEST_URL` | Full HTTPS URL of the permanent `ci-test` Convex deployment (e.g. `https://ci-test-<id>.convex.cloud`). **Use a dedicated deployment — do NOT share with production.** |
| `TEST_API_KEY`    | A pre-provisioned API key for the ci-test deployment. The key must have `member` role or higher in the test org. |
| `TEST_AGENT_ID`   | Convex document ID of a pre-created `agents` record in the ci-test deployment. Used as the `agentId` for test run creation. |

### Provisioning `TEST_AGENT_ID`

The `TEST_AGENT_ID` is not automatically created. You must provision it manually:

1. Deploy the Convex backend to the `ci-test` deployment:
   ```
   npx convex deploy --deployment ci-test
   ```

2. Open the Convex dashboard for the `ci-test` deployment.

3. Create a test organization and project via the Clerk dashboard for the test environment,
   then confirm the Clerk webhook fires and a record appears in the `organizations` table.

4. Use the Convex dashboard Data browser to create:
   - A `projects` record under the test org
   - An `agents` record under that project

5. Copy the `_id` of the agents record. Set it as the `TEST_AGENT_ID` secret.

6. Create an API key via the web UI or Convex dashboard, hash it with SHA-256, and insert it
   into the `api_keys` table. Set the raw key as `TEST_API_KEY`.

### Permanent deployment policy

The CI integration tests use a **permanent** `ci-test` Convex deployment. Do not use
ephemeral per-PR deployments — setup/teardown timing between Convex provisioning and
the test runner has historically caused flaky failures.

The `ci-test` deployment is shared across all PRs. Tests are designed to be idempotent
(duplicate `sequenceNumber` returns the existing event ID) so concurrent PR runs do not
corrupt each other's state.

---

## Environment Variables for Standard CI Jobs

Standard CI jobs (typecheck, lint, build, test) do not require real secrets. Dummy
values are injected via the `env:` block in `.github/workflows/ci.yml`:

```yaml
env:
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk_test_ci_placeholder
  NEXT_PUBLIC_CONVEX_URL: https://ci-placeholder.convex.cloud
```

Do not remove these — the env validation in `apps/web/src/lib/env.ts` runs at
build time and will fail if these vars are absent.

---

## GC Cron: `BLOB_STORE_TOKEN` in Convex Environment

The artifact GC cron (`convex/artifact_gc.ts`) requires `BLOB_STORE_TOKEN` to be set
as a **Convex environment variable** (not a Next.js env var). If it is absent:

- Convex artifact records will be deleted from the database on schedule.
- The corresponding blobs will **not** be deleted from Vercel Blob storage.
- Blobs will accumulate indefinitely until the token is set.

To set it:
```
npx convex env set BLOB_STORE_TOKEN <your-vercel-blob-read-write-token>
```

This must be done for every Convex deployment (dev, ci-test, production) independently.

---

## Schema Drift Gate

The `schema-drift` CI job runs on every push and PR. It compares field names in
`convex/schema.ts` against property names in `packages/contracts/src/entities.ts`
for all entities that have a corresponding contract type.

### Why this gate exists

The Convex schema and the contracts package define the same entity shapes in two
places. TypeScript catches type mismatches *within* a package, but a field added
to `convex/schema.ts` without a matching property in contracts — or vice versa —
drifts silently until runtime. This check makes drift explicit and blocks the build.

### What triggers a drift failure

- Adding a field to a `defineTable({...})` body in `convex/schema.ts` without adding
  the matching property to the corresponding interface in `packages/contracts/src/entities.ts`
- Adding a property to a contracts interface without adding the matching field to
  `convex/schema.ts`

### How to fix a drift failure

Run locally to see the exact mismatch:

```
pnpm tsx scripts/check-schema-drift.ts
```

Then follow the remediation steps printed by the script:
1. If you added a field to `convex/schema.ts`: add the matching property to
   `packages/contracts/src/entities.ts` (and bump the contracts version).
2. If you added a property to the contracts: add the matching field to `convex/schema.ts`.
3. If the field is intentionally internal (not exposed by the app): add it to
   `SCHEMA_FIELD_EXCLUSIONS` in `scripts/check-schema-drift.ts`.

### Tables covered by the drift check

The check covers 8 entities: `organizations`, `projects`, `agents`, `agent_versions`,
`runs`, `events`, `artifacts`, `comments`.

The `user_memberships` and `api_keys` tables are intentionally excluded — they are
internal auth tables with no corresponding public contract types.

### Running locally

The drift check is the 4th step in `./scripts/validate.sh`. You can also run it
standalone:

```
pnpm tsx scripts/check-schema-drift.ts
```
