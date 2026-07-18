# Disaster Recovery: Backup Mechanics and Quarterly Restore Drill

This doc makes the "Backup and disaster recovery" section of
`docs/operations_runbook.md` concrete and actionable. That section states the
recommended RPO/RTO targets and the data-of-record split (Convex = product data,
Vercel Blob = artifact payload bytes); this doc is the how-to.

---

## What lives where (recap)

- **Convex** is the system of record for every entity in the hierarchy
  (organizations → projects → agents → agent_versions → runs → events), plus
  artifact *metadata* (pointer + SHA-256 checksum, not the bytes), comments,
  api_keys, user_memberships, audit_log, and verification_results.
- **Vercel Blob** holds the actual bytes for externalized event payloads (>10 KB)
  and uploaded artifacts. Blobs are content-addressed by checksum in the storage
  key, so a Convex restore never points at ambiguous blob content — if the blob
  still exists at that key, it is guaranteed to be the right bytes.

A DR plan has to cover both, but they are not equally easy to back up — Convex has
first-class export tooling; Vercel Blob does not have an equivalent snapshot/export
feature today (see "Blob-store considerations" below).

---

## Convex export mechanics

**Dashboard:** Convex Dashboard → Deployment → **Settings → Backup/Export**. Triggers
a full-deployment snapshot export producing a ZIP of all tables.

**CLI:**
```
npx convex export --path ./backup-$(date +%Y%m%d).zip
```
Run this against the target deployment (pass `--deployment <name>` or rely on
`CONVEX_DEPLOY_KEY`/the configured project, same as `npx convex deploy`).

**Point-in-time restore** (importing a snapshot back into a deployment) is available
on paid Convex plans via snapshot import — same Dashboard area, or
`npx convex import <path>` against the target deployment.

**What to export:** the full-deployment export (not a table-by-table partial) —
it's the only mode Convex's export tooling supports, and partial exports would risk
missing a table that a future schema change adds. This naturally includes
`organizations`, `projects`, `agents`, `agent_versions`, `runs`, `events`,
`artifacts` (pointers + checksums, not bytes), `comments`, `api_keys`,
`user_memberships`, `audit_log`, and `verification_results`.

**Recommended cadence:** daily, automated (not ad hoc). A cron-triggered `convex
export` (e.g. from a scheduled GitHub Actions workflow or an external scheduler
hitting a script that shells out to the Convex CLI with `CONVEX_DEPLOY_KEY`) that
writes the ZIP to durable storage (a private cloud bucket, not committed to git —
these exports contain full tenant data across all orgs). Retain at least the last
7 daily exports plus the most recent export of each of the last 4 weeks, so a slow-
discovered corruption issue still has a viable restore point. This is a
**recommendation** — no automated export job exists in this repo today; provisioning
it is a prerequisite for the RPO target below to be real rather than aspirational.

---

## Blob-store considerations

Vercel Blob has no native snapshot/export feature equivalent to Convex's. Practical
options, in order of preference:

1. **Rely on content-addressing + Convex export for recoverability of METADATA**, and
   treat blob loss as bounded in scope: if a blob object is lost (not the whole
   store — Vercel Blob itself is durable managed storage under normal operation),
   only the payloads referenced by artifact records pointing at that key are
   unrecoverable; the rest of the run's event log (everything ≤10 KB stored inline
   in Convex) is untouched. This is a deliberate consequence of the "large payloads
   externalized" design (`CLAUDE.md`'s Event Log Rules) — it bounds blast radius but
   does not eliminate it.
2. **For a true DR posture**, periodically enumerate artifact records via Convex
   (storage keys are all recorded there) and mirror the referenced blobs to a second
   bucket/provider. This is NOT implemented today — flagging it as a gap rather than
   describing tooling that doesn't exist. If blob durability becomes a compliance
   requirement, this needs a dedicated script (list artifacts → HEAD/GET each
   storage key → copy to a secondary store) and its own runbook entry.
3. **Do not treat a Convex restore alone as a full data restore** — a restored
   Convex deployment will contain artifact records whose `storageKey` may no longer
   resolve if blobs were lost in the same incident that necessitated the restore.
   The restore drill below explicitly checks for this (step 5).

---

## Quarterly restore drill

Run this once per quarter, and immediately after any DR-relevant infrastructure
change (Convex plan change, blob provider change, major schema migration). Treat a
failed drill as an incident — the point is to find gaps before a real emergency does.

**1. Export.**
```
npx convex export --path ./drill-$(date +%Y%m%d).zip --deployment <production-or-latest-daily>
```
Prefer restoring from the most recent scheduled daily export (if the automated job
from the cadence section above exists) rather than a fresh export — the drill should
validate the ACTUAL artifact you'd restore from in a real incident, not a
freshly-generated best case.

**2. Restore to a scratch deployment.**
Create a new, disposable Convex deployment (`npx convex deploy` targeting a new
project/deployment name — do not reuse `ci-test`, since that deployment is shared
infrastructure for CI integration tests per `docs/ops/ci_setup.md` and must not be
overwritten by a restore). Import the export into it:
```
npx convex import ./drill-<date>.zip --deployment <scratch-deployment-name>
```

**3. Point a preview deployment at the scratch backend.**
Deploy (or reuse) a Vercel Preview deployment of the web app with
`NEXT_PUBLIC_CONVEX_URL` overridden to the scratch deployment's URL, and Clerk
env vars pointed at a non-production Clerk instance (see "Staging vs prod
separation" in `docs/deployment_checklist.md` — the same separation principle
applies to a drill environment). Do not point a scratch restore at production
Clerk — Clerk org IDs in the restored data need to resolve against whichever Clerk
instance issued them originally, so a drill against production Convex data needs
production Clerk (read-only concerns aside), while a drill against synthetic/seed
data can use a test Clerk instance.

**4. Run the integration suite against it.**
```
CONVEX_TEST_URL=<scratch preview URL> \
TEST_API_KEY=<a valid key from the restored api_keys table, or provision one> \
TEST_AGENT_ID=<a valid agent _id from the restored data> \
pnpm --filter @agent-flight-recorder/tests test -- --reporter=verbose integration/api.test.ts
```
This is the same suite CI's `integration-test` job runs (see
`.github/workflows/ci.yml`) — reusing it means the drill validates the restored
backend against the same assertions production correctness depends on, not a
bespoke drill-only script that could drift from what actually matters.

**5. Verify counts and blob resolution.**
- Compare row counts per table (Convex dashboard Data browser, or a quick script
  using `ctx.db.query(table).collect().length` via a scratch-only debug query) between
  the scratch deployment and a known baseline (the production dashboard's counts at
  export time, if you recorded them, or simply "non-zero and roughly proportional to
  known org/run activity").
- Spot-check that artifact records' `storageKey` values still resolve: pick several
  `artifacts` rows from the restored data and attempt a HEAD/GET against the blob
  URL. This is the check that catches the blob-store gap from the previous section —
  a restore can succeed at the Convex layer while silently losing artifact payloads.
- Confirm `verifyProjectionIntegrity` succeeds for a handful of restored runs
  (`pnpm tsx scripts/rebuild-projection.ts --events-file <exported events for a
  run>`, per `docs/operations_runbook.md`'s "Verifying a run's projection is intact"
  section) — this confirms the restore preserved sequence contiguity, not just
  document counts.

**6. Tear down.** Delete the scratch Convex deployment and the preview Vercel
deployment once the drill is recorded. Do not leave scratch deployments containing
copies of real tenant data running indefinitely — treat them with the same data
sensitivity as production.

**7. Record the result.** Note the date, export source (which daily backup), pass/
fail per step above, elapsed time for steps 1-5 (this is your empirical RTO data
point, not a guess), and any gaps found. File a follow-up issue for any step that
failed or took materially longer than the previous drill.

---

## RPO / RTO

`docs/operations_runbook.md` currently states these are "TBD by the operator" with a
working-assumption fallback. Recommended concrete targets, to be formally adopted by
whoever owns operational sign-off (these are recommendations from this doc, not yet
ratified policy — replace this section's framing once an operator adopts them):

- **RPO: 24 hours.** Achievable once the daily automated export (see "Recommended
  cadence" above) exists — RPO is bounded by export frequency, so this target is only
  real once that automation is provisioned. Until then, the actual RPO is "however
  long since the last export anyone manually ran," which is not a target, it's an
  unknown.
- **RTO: 4 hours.** Derived from the restore drill: import time for a full-deployment
  snapshot plus a Vercel redeploy pointed at the restored backend is expected to be on
  the order of tens of minutes for the Convex import itself (scales with data volume)
  plus normal Vercel deploy time (~minutes), leaving generous headroom in the 4-hour
  target for the human steps (incident declaration, verifying the restore per step 5
  above, DNS/env cutover, confirming `/api/health` is green). Treat the drill's
  recorded elapsed time (step 7) as the actual measurement to validate or revise this
  number against — if a drill consistently runs longer than 4 hours, lower confidence
  in this target and investigate why before an incident forces the question.

Blob-store recovery is explicitly NOT covered by the RTO above unless the mirroring
gap in "Blob-store considerations" is closed — today, a blob-loss incident's recovery
time is unbounded (there is no restore path for a lost blob other than "the org has to
re-upload/re-run," which may not be possible for historical artifacts).
