# Incident Response

Practical triage playbooks for the incidents most likely to occur given this
architecture (Next.js on Vercel + Convex backend + Clerk auth + Vercel Blob
storage). Pairs with `docs/ops/observability.md` (what to look at) and
`docs/operations_runbook.md` (symptom → fix reference for issues not covered here).

For each incident: **symptoms**, **triage steps**, **actions**.

---

## (a) Convex unreachable

**Symptoms:**
- `GET /api/health` returns HTTP `503` (the only status code that maps to 503 — see
  `docs/ops/observability.md#health-endpoint`), with `dependencies.convex: "down"` in
  the body.
- API routes that call Convex return `503 SERVICE_UNAVAILABLE` with a body like
  `{ "code": "SERVICE_UNAVAILABLE", "message": "Backend unavailable (request <id>)" }`.
  This is `withApiHandler` catching a `ConvexTimeoutError` (`apps/web/src/lib/convexServer.ts`)
  — every Convex call in a route is wrapped in `withConvexTimeout(...)`, which races
  the call against a timeout and throws `ConvexTimeoutError` on loss.
- SDK-side: ingestion calls (`/api/runs`, `/api/events`, `/api/artifacts/upload`,
  `/api/runs/[id]/status`) start failing with 503 across the board, not just for one
  org — this is a full backend outage, not a per-tenant issue.
- The Clerk webhook route (`/api/webhooks/clerk`) also 500s/503s on `ConvexTimeoutError`
  when trying to upsert an org or membership — new signups/org creation appear to hang.

**Triage:**
1. Hit `/api/health` directly. Confirm `dependencies.convex: "down"` and HTTP 503 —
   this is the fastest way to distinguish "Convex is actually down" from "one route has
   a bug." If `convex: "ok"` but individual routes 503, the problem is route-specific,
   not a platform outage — do not follow this playbook, check that route's own log
   lines instead.
2. Check the Convex dashboard for the production deployment directly (not through the
   app) — Deployment status page, and Convex's own status page
   (status.convex.dev) for a platform-wide incident.
3. Grep the Vercel log drain (or dashboard) for `err.message` containing
   `ConvexTimeoutError` or `timeout` across the affected time window, filtered by
   `status:503` — this tells you the blast radius (which routes, how many requests,
   since when) without needing Convex-side access.
4. Check whether `NEXT_PUBLIC_CONVEX_URL` was recently changed (bad deploy pointing at
   the wrong deployment) — see playbook (d) if so.

**Actions:**
- If Convex's own status page shows a platform incident: this is out of our control.
  Post a status update, keep `/api/health` monitoring running so the team gets the
  transition back to `"ok"` automatically, and do not attempt manual Convex-side
  intervention.
- If the Convex deployment itself looks healthy from its own dashboard but
  `NEXT_PUBLIC_CONVEX_URL` / `CONVEX_DEPLOY_KEY` in Vercel look wrong: this is a config
  drift issue, not an outage — fix the env var and redeploy (see
  `docs/deployment_checklist.md`).
- Once Convex recovers, `/api/health` flips back to `200`/`"ok"` on its own (it pings
  live, no caching) — no manual reset needed. Watch for a burst of retried SDK writes
  once ingestion resumes; this is expected (SDK retries are safe — see "Duplicate
  event handling" in `docs/operations_runbook.md`).
- Post-incident: note the outage window so anyone reconciling run/event counts around
  that time knows to expect gaps (`docs/operations_runbook.md`'s "Verifying a run's
  projection is intact" section covers how to check a specific run for sequence gaps
  caused by a dropped SDK batch during the outage).

---

## (b) Ingestion rejections spiking (409 / 422)

These are stable `afrError` codes from Convex, mapped to HTTP status by
`AFR_CODE_TO_STATUS` in `apps/web/src/lib/apiHandler.ts`:

| Code | HTTP | Meaning |
|---|---|---|
| `RUN_NOT_ACTIVE` | 409 | The caller is submitting events/status for a run that is not in an active (non-terminal) state — e.g. events after `RUN_COMPLETED`/`RUN_FAILED` already closed it. |
| `SEQUENCE_CONFLICT` | 409 | The submitted `sequenceNumber` doesn't fit the run's expected contiguous sequence (gap or a number already used by a *different* payload — true duplicates of the same `(runId, sequenceNumber)` are silently deduplicated, not rejected; see `docs/operations_runbook.md`). |
| `EVENT_LIMIT_EXCEEDED` | 422 | Per-run or per-org event volume cap hit. |
| `ARTIFACT_LIMIT_EXCEEDED` | 422 | Per-run or per-org artifact cap hit. |
| `COMMENT_LIMIT_EXCEEDED` | 422 | Per-run or per-org comment cap hit. |
| `RATE_LIMITED` | 429 | Convex's durable per-API-key `rateLimitPerMin` counter tripped (see `convex/sdk_ingest.ts`) — distinct from the in-process `rateLimit.ts` limiter; this is the durable one. |

**Triage — identify the offending key/org:**
1. In the log drain, filter for `route:"/api/events"` (or `/api/runs`,
   `/api/artifacts/upload`, `/api/runs/[id]/status`) with `status:409` or `status:422`,
   grouped/counted by `orgId` over the spike window. `withApiHandler`'s request log
   line includes `orgId` whenever the request resolved one via the `apiKey`/`org`
   rate-limit key path, so a single log query answers "who."
2. Cross-reference against the `err` field on those log lines (present because
   `mapAfrErrorResponse` logs the caught error before returning the mapped response)
   to see the specific `afrError` code and the server-authored detail message
   (truncated to 500 chars, first line only).
3. For `RUN_NOT_ACTIVE`/`SEQUENCE_CONFLICT` specifically: check the Convex dashboard's
   `audit_log` table (or `runs`/`events` tables directly, filtered by the offending
   `orgId`) to see the run's actual status and last-recorded sequence number — this
   tells you whether the SDK is racing itself (e.g. two processes writing the same
   run concurrently, or retrying after the run was already closed by a timeout/manual
   status update).
4. For `RATE_LIMITED`: the offending API key's `rateLimitPerMin` is in
   `api_keys.rateLimitPerMin` (Convex dashboard, `api_keys` table) — confirm the
   caller's actual traffic against that ceiling.

**Actions:**
- `RUN_NOT_ACTIVE`/`SEQUENCE_CONFLICT` spikes from ONE org: usually a caller-side bug
  (double-instrumentation, retry-after-close, non-monotonic sequence numbers from a
  buggy SDK integration). Reach out to that customer/team with the specific run IDs
  from step 3 — there is no server-side fix, the SDK contract (append-only,
  contiguous, monotonic) is intentionally strict (see "Event Log Rules" in
  `CLAUDE.md`).
- Broad spike across many orgs: check whether a shared SDK version was just released
  with a sequencing regression — this is a code issue in `packages/sdk`, escalate to
  the SDK team, not an ops fix.
- `EVENT_LIMIT_EXCEEDED`/`ARTIFACT_LIMIT_EXCEEDED`/`COMMENT_LIMIT_EXCEEDED`: confirm
  whether the org's limit needs a legitimate raise (customer conversation) vs. a
  runaway agent loop hammering the API (customer-side bug — the limit did its job).
- `RATE_LIMITED` from a single legitimate high-volume customer: this is a
  `rateLimitPerMin` conversation, not an incident — raise the key's limit via the
  `createApiKey`/key-management surface if justified.

---

## (c) Webhook failures — Clerk orgs out of sync

**Symptoms:**
- A user creates/updates an org or membership in Clerk but the corresponding Convex
  record (`organizations`, `user_memberships`) doesn't reflect it — new org owners see
  an empty/broken app, or a removed member retains access.
- Clerk Dashboard → Webhooks → your endpoint → Recent Deliveries shows failed
  deliveries to `/api/webhooks/clerk`.

**Detect:**
1. Clerk Dashboard → Webhooks → Recent Deliveries — the authoritative source of
   delivery failures, including the HTTP status Clerk received and Clerk's own retry
   history.
2. Vercel log drain: filter `route:"/api/webhooks/clerk"`. Common failure signatures:
   - `400` — Svix signature verification failed (`CLERK_WEBHOOK_SECRET` mismatch;
     see the "Secret rotation" section of `docs/operations_runbook.md` for the
     coordinated-update procedure, since this secret must match on both Clerk and the
     Vercel env).
   - `503` — `ConvexTimeoutError` while calling the upsert/membership mutations; see
     playbook (a).
   - `logger.error('Failed to handle Clerk webhook event "..."', ...)` lines carry the
     specific `eventType` (`organization.created`, `organization.updated`,
     `organizationMembership.created`, `organizationMembership.updated`,
     `organizationMembership.deleted`, `organization.deleted`) and the underlying
     `err` — this tells you exactly which event type and org failed.
3. This route has its own per-instance rate limiter (60/min/IP, not
   `withApiHandler`'s) — check whether Clerk's own retries or a delivery burst tripped
   it (`getClientIp` keys by `x-forwarded-for`; Clerk's webhook sender IP would be the
   key here). A 429 here compounds the sync gap since Clerk backs off retries.

**Replay options:**
- Clerk Dashboard → Webhooks → the failed delivery → **Resend**. This is the primary
  replay mechanism; the route's handlers are idempotent for the org/membership upsert
  paths (`handleOrganizationUpsert` — see `docs/operations_runbook.md`'s Clerk webhook
  section), so a resend after fixing the root cause (secret, Convex reachability) is
  safe.
- If Clerk's delivery history has aged out or you need to force a specific state:
  reproduce the mutation manually from the Convex dashboard (e.g. directly edit the
  `organizations` or `user_memberships` table to match Clerk's current state) — this
  is a stopgap, prefer Resend when available since it goes through the same code path
  the app relies on.

**Membership revocation implications:** `organizationMembership.deleted` calls
`handleOrganizationMembershipDeleted`, which removes the `user_memberships` row for
that user/org. If this webhook fails silently, a removed Clerk member RETAINS Convex
access — because every Convex query/mutation enforces org membership via
`user_memberships`, not by calling out to Clerk live (see "Tenancy Rules" in
`CLAUDE.md`). This is the highest-severity webhook failure mode: treat delivery
failures on `organizationMembership.deleted` as urgent (access-control drift), not
routine sync lag, and confirm via Clerk Recent Deliveries + Resend immediately.

**Org deletion / erasure obligation:** `organization.deleted` calls
`handleOrganizationDeleted`, which does NOT purge Convex data — it stamps
`pendingDeletionAt` on the `organizations` record, writes an audit row, and logs a
structured `ORG_DELETION_REQUESTED` warning (`convex/organizations.ts`,
`markOrganizationPendingDeletion`). This is intentional (ADR 001,
`docs/adr/001-data-retention-and-erasure.md`): the cascade purge is never automatic.

**Erasure obligation runbook step:** once you see `ORG_DELETION_REQUESTED` (log line
or `pendingDeletionAt` set on the org — queryable via `GET /api/org/retention` for a
given org, or directly in the Convex dashboard's `organizations` table), an operator
must explicitly run the purge:

1. Confirm the erasure request is legitimate (matches an actual offboarding/GDPR
   request — `pendingDeletionAt` alone does not prove intent was verified, it only
   proves Clerk sent the deletion webhook).
2. Open the Convex dashboard for the production deployment → **Functions** tab.
3. Locate `retention:purgeOrganization` (an `internalAction` — not publicly callable,
   so it will not appear in any public API surface; it is only invokable from the
   dashboard's function runner or the Convex CLI by someone with deployment access).
4. Run it with `{ orgId: "<the organization's Convex _id>" }` (get the `_id` from the
   `organizations` table row, not the Clerk org ID).
5. It cascades in dependency order (api_keys → memberships → comments →
   verification_results → per-run artifacts/events → runs → agent_versions → agents →
   projects → audit_log → the org record itself), batched and self-rescheduling via
   `ctx.scheduler` if not drained in one invocation (`MAX_BATCHES_PER_INVOCATION =
   200` batches per call before it reschedules itself — for very large orgs this may
   take multiple scheduled passes; watch the Convex function logs for `PURGE
   COMPLETE org=... ` to confirm completion, or `not drained after N batches;
   re-scheduling` if it's still running).
6. Blob deletion is best-effort during purge — failures are logged
   (`Retention: blob DELETE failed for key=...`) but never block the record deletion.
   If `BLOB_STORE_TOKEN` is unset in the Convex environment, blobs for that org are
   never deleted at all (only the Convex artifact records are) — confirm the token is
   set before relying on the purge for full blob erasure.
7. Because the purge deletes the org's own `audit_log` last, the durable record of
   "this org was purged" is the `PURGE COMPLETE` console line in Convex function logs
   — retain/export that per your compliance policy; it does not persist in the
   database once the purge finishes.

---

## (d) Bad deploy

**Symptoms:** a deploy just went out and something broke — elevated 500s, a route
missing, a schema-shaped error (`Convex mutation error: ... unexpected field` /
similar), or the schema-drift CI job would have caught it but didn't run/was
bypassed.

**Triage:**
1. Check `/api/health` and the log drain for a spike in `status:500` immediately
   following the deploy timestamp.
2. Determine which side changed: web-only (Vercel), Convex-only, or both. If both
   changed together and web now 500s calling Convex functions that don't exist yet /
   have a different shape, this is almost always an **ordering** problem — see the
   schema-migration ordering rule below.

**Rollback:**
1. **Vercel rollback (fast, ~30s):** Vercel dashboard → Deployments → the last known-good
   deployment → "..." menu → **Promote to Production**. This reverts the web app
   immediately without touching Convex.
2. **Convex rollback consideration (only if schema/functions changed):** Convex has
   no automatic schema rollback. If the bad deploy included a `convex/schema.ts` or
   function change:
   - `git revert <the schema/function commit>` then `npx convex deploy` to push the
     reverted schema/functions.
   - Before reverting, assess whether any data was already written under the NEW
     schema/shape during the bad deploy's window — reverting the schema doesn't
     undo already-written documents, and a stricter reverted schema could then reject
     reads of newer-shaped data. Check the `schema-drift` CI job's own docs
     (`docs/ops/ci_setup.md`) for what fields it tracks if you need to reason about
     shape compatibility.
   - **Ordering matters on rollback too:** if you're rolling BOTH back, revert web
     first (stops new writes in the new shape) then Convex, mirroring the forward
     ordering rule below in reverse.
3. **Verify:** `curl https://<domain>/api/health` — confirm `"status": "ok"` (or at
   minimum, HTTP 200 and `dependencies.convex: "ok"`) before declaring the rollback
   complete.

**Schema-migration ordering rule (why deploy order matters going forward, not just on
rollback):** when a change adds a Convex schema field that the web app depends on
reading, **deploy Convex before web**. If web ships first expecting a field Convex
doesn't have yet, every request touching that field breaks until the Convex deploy
lands. The `schema-drift` CI job (`.github/workflows/ci.yml`'s `schema-drift` job,
`pnpm tsx scripts/check-schema-drift.ts`) exists specifically to catch the mirror
case — a contracts/schema field added on one side without the other — but it is a
**pre-merge** gate (compares `convex/schema.ts` field names against
`packages/contracts/src/entities.ts`), not a deploy-ordering enforcer. It cannot stop
you from merging a correct PR and then deploying the two halves out of order; that
ordering discipline is operator responsibility. See `docs/deployment_checklist.md`
for the full deploy sequence.

**Post-incident:** open a post-mortem issue (timeline, root cause, fix), and update
`docs/operations_runbook.md` or this playbook if the incident revealed a gap neither
covers.
