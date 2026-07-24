# Operations Runbook — Agent Flight Recorder

This runbook covers common operational issues and their resolutions. Each section
describes a symptom, the likely cause, and the steps to diagnose and fix it.

> ## :warning: Verification status of this runbook
>
> **No Convex deployment has ever existed for this project, and this application
> has never been deployed to any environment.** Every procedure below was written
> against the code, not against a running system. None of it has been executed
> end-to-end.
>
> Treat each procedure as a *plausible* first attempt, not a proven one. In
> particular, the following are **unverified**:
>
> - Every `npx convex deploy` / `npx convex export` / `npx convex env set`
>   invocation. The commands and flags are correct per the Convex 1.42 CLI, but
>   have not been run against a real deployment of this project.
> - Every expected `GET /api/health` response body. The shapes come from reading
>   `apps/web/src/lib/health.ts`, not from a live response.
> - Every Convex-dashboard navigation path (table names, Settings → Backup/Export,
>   the Logs tab) — Convex's dashboard UI may have moved since these were written.
> - Every log-line format quoted below (artifact GC, stale-run expiry). These are
>   transcribed from the source that emits them, but have never been observed in
>   real deployment logs.
> - The **Secret rotation** procedure, which involves a live Vercel deploy and a
>   live Convex deployment in a specific interleaving. Its safety argument is
>   sound on paper; the sequencing has never been exercised.
>
> Before the first production incident, walk this runbook against a staging
> deployment and correct what does not match. See the **First-time bootstrap**
> section of `docs/deployment_checklist.md` for standing up the first deployment,
> including known issues (`node:` builtin imports in `convex/` with no
> `"use node"` directive) that are expected to surface at first deploy.

**Related ops docs:**
- [`docs/ops/observability.md`](ops/observability.md) — the logging contract, where
  logs go on Vercel, request-ID correlation, health endpoint semantics, the CSP
  report sink, and rate-limit classes.
- [`docs/ops/incident_response.md`](ops/incident_response.md) — triage playbooks for
  the four most likely incidents: Convex unreachable, ingestion rejections spiking,
  Clerk webhook/org-sync failures (including the erasure-obligation step), and bad
  deploys.
- [`docs/ops/dr_drill.md`](ops/dr_drill.md) — Convex export/restore mechanics, blob-
  store considerations, the quarterly restore-drill procedure, and recommended
  RPO/RTO targets.

---

## Storage health check

**Command:**
```
curl https://<your-domain>/api/health
```

**Expected (production):**
```json
{
  "status": "ok",
  "storage": { "adapter": "vercel", "configured": true },
  "timestamp": "2026-04-10T15:00:00.000Z"
}
```

**If `adapter` is `"stub"` in production:**
`BLOB_STORE_TOKEN` env var is not set. The application is using the in-memory stub
adapter — data stored in blob storage will be lost on process restart, and any
artifacts stored during this time are irrecoverable.

Fix: Add `BLOB_STORE_TOKEN` to Vercel project settings (Settings → Environment
Variables → Production) and redeploy. Verify the health endpoint returns
`"adapter": "vercel"` after the new deployment.

**If `configured` is `false`:**
The token is present but the blob store URL is missing. Set `BLOB_STORE_URL` and
redeploy.

---

## Verifying a run's projection is intact

**Quick check (demo data):**
```
pnpm tsx scripts/rebuild-projection.ts --demo
```

**Check a real run by ID:**
Export the run's events from the Convex dashboard (Logs → Events → filter by runId),
then:
```
pnpm tsx scripts/rebuild-projection.ts --events-file ./exported-events.json
```

The script calls `verifyProjectionIntegrity` and prints the result. A valid run
prints `OK: N events, no gaps, projection valid`. An invalid run lists the specific
sequence gaps or duplicates found.

**Interpretation:**
- Sequence gaps indicate events were not ingested (e.g., network failure between SDK
  batches). There is no automated repair — the canonical log is immutable.
- Duplicates should not occur in well-formed data. If they appear, check the SDK
  version — duplicate sequence numbers indicate a bug in the SDK's counter.

---

## Artifact upload failures (413 errors)

**Symptom:** SDK calls fail with `HTTP 413 PAYLOAD_TOO_LARGE` on `POST /api/events`.

**Cause:** The SDK is submitting an event payload > 10,240 bytes (10 KB) to
`/api/events` without externalizing it first.

**Fix (v1):** The caller must break down the payload into smaller pieces, or
externalize the large payload manually via `POST /api/artifacts/upload` before calling
`/api/events`. Replace the event payload with the artifact pointer returned by the
upload endpoint.

**Fix (v1.1):** SDK auto-externalization will handle this transparently.

---

## Blob storage failures

**Symptom:** `POST /api/artifacts/upload` returns HTTP 500 with `INTERNAL_ERROR`.

**Diagnosis:**
1. Check `GET /api/health` — is `storage.configured` true?
2. If `configured: false`: `BLOB_STORE_TOKEN` or `BLOB_STORE_URL` is missing.
   Set the missing env var in Vercel and redeploy.
3. If `configured: true`: the Vercel Blob REST API itself may be rejecting the token.
   Check that the token has not expired or been revoked. Rotate the token in the Vercel
   dashboard (Storage → your store → Settings → Tokens) and update `BLOB_STORE_TOKEN`.
4. Check the Vercel Function logs for the `/api/artifacts/upload` route for the full
   error message from the Vercel Blob API response.

---

## Duplicate event handling

Events with the same `(runId, sequenceNumber)` pair are silently deduplicated by the
`sdkCreateEvents` mutation (ADR-0007). The mutation returns the existing event ID
instead of inserting a new record.

This is correct behavior during SDK retries. If an SDK batch fails after partial
insertion and the caller retries the full batch, the already-inserted events are
idempotently accepted.

**If you see fewer events than expected in a run:**
Check whether the SDK is reusing sequence numbers. A sequence number reuse bug would
cause the dedup logic to drop events. Verify the SDK version and inspect the
`by_run_sequence` index in the Convex dashboard for the run.

---

## Projection fails to build

**Symptom:** The replay page shows an error fetching the projection, or
`verifyProjectionIntegrity` reports errors.

**Diagnosis:**
1. Verify the run exists in Convex (dashboard → runs table → filter by `id`).
2. Verify the run has events (dashboard → events table → filter by `runId`).
3. Run `scripts/rebuild-projection.ts` against the run's events to see the specific
   integrity error.

**Recovery:** Projections are always rebuilt on-demand from canonical events. There
is no materialized state to repair. Refreshing the replay page forces a fresh
projection build. If the canonical events are intact (no gaps, no duplicates), the
projection will succeed.

If the events themselves are corrupt or missing: the event log is immutable and there
is no recovery path for missing events in v1.

---

## Run stuck in "running" status

**Symptom:** A run's status is `running` indefinitely and never transitions to
`completed` or `failed`.

**Cause:** The SDK crashed or the process was killed before calling `run.complete()`
or `run.fail()`. The run has no terminal event and no status update was sent.

**Fix (automatic, v1):** Runs stuck in `running` for more than 24 hours are automatically
transitioned to `timed_out` by the daily `expire-stale-runs` cron job (runs at 03:00 UTC).
No manual intervention is required. The transition is logged in Convex function logs:
```
Stale run expiry: batch=N expired=E errors=X
```

**Fix (manual, if needed):** If a run must be expired immediately before the next cron run:
1. Open the Convex dashboard → runs table.
2. Find the stuck run by `id`.
3. Edit the `status` field to `"timed_out"`.
4. Edit the `endedAt` field to the current Unix timestamp in milliseconds.

---

## Convex deployment issues

> **Before the first deploy:** `npx convex deploy` assumes a Convex project
> already exists and that `convex/_generated` holds real codegen output. Neither
> is true yet — see **First-time bootstrap** in `docs/deployment_checklist.md`.
> Running `convex deploy` against a project that has never been created will fail
> at authentication (`401 MissingAccessToken`), not at the schema step.

**Push schema and functions:**
```
npx convex deploy
```

**If schema migration fails:**
Convex validates the schema against existing data before applying it. If the migration
fails because existing data does not conform to the new schema, you must:
1. Identify the incompatible documents using a Convex query in the dashboard.
2. Migrate the data or relax the schema constraint.
3. Retry `npx convex deploy`.

Convex does NOT support automatic schema rollback. If you must revert a schema change:
1. Revert the `convex/schema.ts` commit in the codebase.
2. Run `npx convex deploy` to push the reverted schema.
3. Note that data written under the new schema may be incompatible — assess impact
   before reverting.

**If functions fail to deploy:**
Check TypeScript errors in `convex/` files. Run `pnpm typecheck` locally to reproduce.

---

## Artifact GC outcomes

Artifact GC runs daily at 02:00 UTC via the Convex cron job defined in `convex/crons.ts`.
The action processes at most `GC_CANDIDATE_PAGE_SIZE` (100) artifact candidates per run,
oldest-first via the `by_created_at` index.

**Reading the GC log line:**

```
Artifact GC: batch=N cleaned=C skipped=S blobErrors=B checkErrors=K recordErrors=R
```

| Field | Meaning |
|-------|---------|
| `batch` | Artifacts evaluated in this GC run |
| `cleaned` | Orphaned artifacts successfully deleted (blob + Convex record) |
| `skipped` | Referenced artifacts preserved (not orphans) |
| `blobErrors` | Blob DELETE calls that failed — artifact Convex record preserved, will retry tomorrow |
| `checkErrors` | Reference check failures — artifact preserved, will retry tomorrow |
| `recordErrors` | Convex record delete failures after successful blob delete — Convex record may be dangling |

**When blobErrors > 0:**
The Vercel Blob DELETE call failed. The Convex artifact record is preserved. The artifact
will appear as a candidate again in tomorrow's GC run. If `blobErrors` persists for
multiple days, check:
1. `GET /api/health` — is `storage.configured: true`?
2. Has `BLOB_STORE_TOKEN` expired or been revoked?
3. Check Convex function logs for the specific HTTP error from Vercel Blob.

**When recordErrors > 0:**
The blob was deleted but the Convex record deletion failed. The artifact record is a dangling
pointer with no corresponding blob. These records are harmless but take up Convex storage.
If `recordErrors` persists, check whether the Convex deployment is healthy.

**When there are more candidates than one batch:**
The log will include: `N candidates in this batch; additional candidates will be processed
in future GC runs.` This is normal for organizations with large artifact backlogs. The
backlog will clear over successive daily runs.

**Escalation threshold:** If `blobErrors` stays > 0 for 3 or more consecutive days, rotate
`BLOB_STORE_TOKEN` and monitor the next GC run.

---

## Emergency rollback

Follow these steps in order:

1. **Vercel rollback (immediate):**
   Vercel dashboard → Deployments → locate the previous stable deployment →
   three-dot menu → Promote to Production. Takes effect within ~30 seconds.

2. **Convex rollback (if schema changed):**
   ```
   git revert <schema-change-commit>
   npx convex deploy
   ```
   Wait for the Convex dashboard to show the functions as deployed.

3. **Verify recovery:**
   ```
   curl https://<your-domain>/api/health
   ```
   Confirm `"status": "ok"` before declaring the rollback complete.

4. **Post-incident:**
   Open a post-mortem issue describing what failed, the timeline, and the fix.
   Update this runbook if the incident revealed a gap.

---

## Clerk webhook failures (org not created in Convex)

**Symptom:** A user creates an org in Clerk but no matching record appears in the
Convex `organizations` table.

**Diagnosis:**
1. Check the Clerk webhook delivery log: Clerk Dashboard → Webhooks → your endpoint
   → Recent Deliveries. Look for failed deliveries on `organization.created`.
2. Common cause: `CLERK_WEBHOOK_SECRET` is set incorrectly. The webhook signature
   validation fails and the endpoint returns 400.
3. Check Vercel Function logs for `/api/webhooks/clerk` for the specific error.

**Fix:**
1. In Clerk Dashboard → Webhooks → your endpoint → Signing Secret: copy the correct
   secret.
2. Update `CLERK_WEBHOOK_SECRET` in Vercel project settings.
3. Redeploy.
4. Use Clerk's "Resend" button on the failed delivery to replay the webhook.

---

## API key authentication failures (SDK gets 401)

**Symptom:** SDK calls return HTTP 401 Unauthorized.

**Diagnosis:**
1. Verify the `x-api-key` header is being sent with the correct key value.
2. Verify the key has not been revoked (Convex dashboard → api_keys table → check
   `revokedAt` field).
3. Verify the key's `orgId` matches the org the SDK is recording runs for.

**Fix:** Generate a new API key from the settings page (or directly in Convex if the
settings UI is not available), update the SDK configuration, and retry.

---

## Secret rotation: CONVEX_WEBHOOK_SECRET / INTERNAL_VERIFY_SECRET

Both are shared secrets that must match on TWO deployments at once:

- `CONVEX_WEBHOOK_SECRET` — set on the Vercel project (used by
  `/api/webhooks/clerk` when calling the webhook-only Convex lifecycle
  mutations) AND on the Convex deployment (which validates it).
- `INTERNAL_VERIFY_SECRET` — set on the Vercel project (validated by
  `/api/internal/verify-derivation`) AND on the Convex deployment (sent by the
  `verifyRecentRuns` action).

**Dual-accept format:** both vars support a comma-separated value —
`current,previous` (entries trimmed, empty entries dropped) — parsed by
`getAcceptedSecrets()` in `apps/web/src/lib/env.ts`. This lets the Vercel
side and the Convex side be updated in either order with no window where
calls fail closed. Convex itself only ever holds ONE value per var (it does
not parse comma lists) — the dual-accept logic lives entirely in the web
tier:

- `CONVEX_WEBHOOK_SECRET`: the webhook route
  (`apps/web/app/api/webhooks/clerk/route.ts`) forwards the FIRST (current)
  value to Convex on every lifecycle mutation call. If Convex rejects it as
  `Unauthorized` (because Convex's single stored value is still the old
  secret), the route retries once with the SECOND (previous) value and logs
  a structured warning that rotation is in progress.
- `INTERNAL_VERIFY_SECRET`: `/api/internal/verify-derivation` accepts the
  incoming `x-internal-secret` header if it matches ANY entry in the list —
  so it validates whichever single value Convex's `verifyRecentRuns` action
  currently has configured, old or new.

**Procedure (add new secret as `new,old` → deploy → update Convex → drop old):**

1. Generate a new high-entropy secret: `openssl rand -hex 32`.
2. On Vercel (Project → Settings → Environment Variables → Production), set
   the var to `<new>,<old>` — new value first, old value second — for
   whichever secret you are rotating. Redeploy.
   - `CONVEX_WEBHOOK_SECRET=<new>,<old>`, or
   - `INTERNAL_VERIFY_SECRET=<new>,<old>`.
   At this point Convex still has the OLD single value configured, but
   nothing fails closed:
   - Webhook calls try `<new>` first, get rejected, retry with `<old>`
     (which Convex still recognizes) — check the Vercel function logs for
     the `"secret rotation appears in progress"` warning to confirm this is
     happening rather than silently failing.
   - Verify-derivation accepts Convex's `<old>` value because it's the
     second entry in the accepted list.
3. Update the SAME var on the Convex deployment to the single new value
   (Dashboard → Deployment → Settings → Environment Variables):
   `npx convex env set CONVEX_WEBHOOK_SECRET <new>` or
   `npx convex env set INTERNAL_VERIFY_SECRET <new>`.
   Convex env changes apply to new function executions automatically — no
   Convex redeploy needed.
4. Verify:
   - `CONVEX_WEBHOOK_SECRET`: create a throwaway Clerk org (or use Clerk's
     webhook "Resend") and confirm the org record appears in Convex, and
     that the Vercel logs show no more rotation-retry warnings (the first,
     current value is now succeeding directly).
   - `INTERNAL_VERIFY_SECRET`: wait for (or manually trigger) the next
     `verifyRecentRuns` cycle and confirm runs get verification results, not
     401s, in the Vercel function logs for `/api/internal/verify-derivation`.
5. Once step 4 confirms the new value works end-to-end, drop the old value:
   set the Vercel var back to a single value (`<new>`, no comma) and
   redeploy. Leaving the old value in the list longer than necessary widens
   the window in which a leaked old secret remains accepted.

**Why this is safe to leave mid-rotation:** both accepted values are
high-entropy secrets known only to the operator performing the rotation —
holding two valid values briefly is materially the same risk as holding one,
and is strictly safer than the old fail-closed window where webhooks/verify
calls were rejected outright.

---

## Backup and disaster recovery

**Data of record:** all product data (orgs, projects, agents, runs, events,
artifacts metadata, comments) lives in Convex. Artifact payload BLOBS live in
Vercel Blob storage; event records store only pointers + SHA-256 checksums.

**Backup capability:**

- Convex supports full-deployment snapshot export (Dashboard → Settings →
  Backup/Export, or `npx convex export`) producing a ZIP of all tables, and
  point-in-time restore via snapshot import on paid plans.
- Vercel Blob objects are durable managed storage; blobs are content-addressed
  by checksum in our storage keys, so a Convex restore never points at
  ambiguous blob content. Blobs themselves are not separately backed up today.

**Targets:** RPO and RTO are TBD by the operator — no formal targets have been
committed for v1. Until they are set, the working assumption is: RPO = age of
the most recent Convex snapshot export (run exports at least weekly), RTO =
time to import the snapshot into a fresh deployment plus a Vercel redeploy
(order of hours).

**Restore drill (recommended before GA):** export a snapshot, import it into a
scratch Convex deployment, point a preview Vercel deployment at it, and confirm
runs, events, and artifact downloads all resolve.
