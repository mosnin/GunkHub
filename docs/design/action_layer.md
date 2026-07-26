# Action Layer — Cycle 2 Wiring Plan

This document describes how the pure delivery engine shipped in Cycle 1
(`apps/web/src/lib/delivery.ts`) gets wired into the actual product in
Cycle 2, once the data agent has landed the `alert_rules` /
`webhook_targets` / `webhook_deliveries` schema referenced in ADR-003
(`docs/adr/003-alerting-webhooks-export.md`). Nothing described here is
implemented yet — this is a design doc, not a status report.

## Trigger: alert evaluation on terminal events

Every run ends in exactly one terminal event: `run.completed` or
`run.failed` (CLAUDE.md Event Log Rule 5). Alert evaluation runs
server-side, triggered by that terminal event, not by polling:

- The event-creation path (`convex/events.ts` `createEvent` /
  `convex/sdk_ingest.ts` sdk-ingest path) already knows the instant a
  terminal event is written. The proposed hook is a Convex
  `ctx.scheduler.runAfter(0, internal.alerts.evaluateForRun, { runId })`
  call added at that point, scheduled rather than run inline, so alert
  evaluation never adds latency or failure risk to the ingest path itself.
- `alerts.evaluateForRun` (a new `internalMutation` or `internalAction`,
  TBD by the data agent depending on whether it only reads/writes Convex
  tables or also needs to enqueue outbound work) loads the org's
  `alert_rules`, matches them against the run's final status/tags/agent,
  and for each match inserts a row into `webhook_deliveries` with status
  `"pending"` (and, if email alerting is enabled for that rule, renders the
  body via `renderAlertEmailText` and hands off to whatever email-send path
  the data/platform agents wire up — no provider is chosen yet, see ADR-003).
- This keeps evaluation idempotent and replay-safe: it reads the immutable
  event log and org config, and only ever inserts new delivery rows — it
  never mutates a run or event.

## Fan-out: webhook delivery via a Convex internalAction

`webhook_deliveries` rows in status `"pending"` are drained by a Convex
`internalAction` (actions, unlike mutations, can call `fetch`):

- A cron or a `ctx.scheduler`-chained self-requeue (mirroring the pattern
  already used by `convex/artifact_gc.ts` and `convex/stale_runs.ts`) scans
  for pending rows in small batches, calls `deliverWebhook(...)` from the
  delivery engine for each, and writes the result back: `status` becomes
  `"delivered"` or `"failed"`, with the attempt count incremented. A
  `retryable: true` result reschedules the row for a future attempt at
  `Date.now() + computeBackoff(attempt)`; a `retryable: false` result (4xx,
  or attempts exhausted) marks it terminally `"failed"`.
- The delivery log itself is append-only per ADR-003 constraint 3: each
  attempt appends a log row (or an entry in an attempts array on the
  delivery row); nothing is overwritten in place except the row's own
  status/attempt-count bookkeeping fields, which are not part of the
  audit-log guarantee (the event log's immutability rule does not extend to
  this operational bookkeeping table — only to `events`).

### Import-safety flag: where does the delivery engine's code live?

`apps/web/src/lib/delivery.ts` is written as plain TypeScript with no
Next.js-specific imports (only `node:crypto`, `node:net`, and the global
`fetch`), specifically so it CAN be imported from `convex/` in Cycle 2.
Convex's action runtime supports `fetch` and standard Node builtins in
`"use node"` actions. Whether `apps/web/src/lib/delivery.ts` is imported
directly from a Convex action, or whether the pure crypto/backoff/SSRF
pieces are mirrored into a new `convex/helpers/delivery.ts`, is an open
decision that Cycle 2 must make explicitly:

- **Import directly** if Convex's build/bundler can resolve a module living
  under `apps/web/` from `convex/` without pulling in Next.js or React as
  transitive dependencies (this repo's workspace boundaries make this
  non-obvious — `apps/web` and `convex/` are different deployment targets).
- **Mirror into `convex/helpers/delivery.ts`** if the above does not hold.
  This duplicates ~150 lines of pure logic but avoids any cross-boundary
  import surprises. If this path is chosen, the two copies must be kept in
  sync by a shared test fixture (same signature vectors, same SSRF matrix)
  run against both modules, so a fix in one is caught as a regression in the
  other.

This decision is flagged now, not resolved, because it depends on Convex
bundler behavior this cycle did not have time to spike.

## Webhook payload envelope

Every webhook delivery POSTs a versioned envelope as its JSON body:

```json
{
  "apiVersion": "2026-07-19",
  "event": "run.failed",
  "orgId": "org_abc123",
  "run": {
    "id": "run_xyz789",
    "projectId": "proj_1",
    "agentId": "agent_1",
    "agentVersionId": "ver_3",
    "status": "failed",
    "startedAt": 1737300000000,
    "endedAt": 1737300042000,
    "tags": ["prod", "critical"],
    "triggeredBy": "scheduler",
    "sdkVersion": "1.4.0"
  },
  "firedAt": 1737300042500
}
```

- `apiVersion` is a date-versioned string (not a running integer), matching
  how many payload-shape-stability contracts are communicated externally.
  It changes only on a breaking change to this envelope shape.
- `event` is the triggering event type — currently always `run.completed`
  or `run.failed` (the two terminal types), but the field is a plain string
  so future non-terminal alert conditions do not require a new envelope
  version.
- `run` is the same shape as the `Run` contract type
  (`packages/contracts/src/entities.ts`), not a Convex document — so a
  contracts version bump automatically flows through to what webhooks send,
  and consumers get the exact same shape the web UI and REST API already
  expose. It intentionally excludes `metadata` (may contain
  customer-supplied free-form data of unbounded size/sensitivity) from the
  default envelope; a future `includeMetadata` per-target opt-in could add
  it back, but that is not part of this cycle's plan.
- `firedAt` is when the alert fired / the delivery was enqueued, distinct
  from `run.endedAt` (when the run itself concluded) — the two can differ
  under evaluation lag.

Every delivery of this envelope carries the signature headers documented in
`apps/web/src/lib/delivery.ts`: `x-afr-signature` (svix-style
`t=...,v1=...`), `x-afr-event`, and `x-afr-delivery-id`.

## Explicitly deferred to Cycle 2 (not designed here)

- The `alert_rules` / `webhook_targets` / `webhook_deliveries` Convex schema
  (data agent).
- The admin UI for configuring alert rules and webhook targets (ui agent).
- The actual email provider integration behind `renderAlertEmailText`
  (operator/platform decision — SES, Resend, Postmark, or similar).
- Per-target delivery secret rotation and storage (likely mirrors the
  existing API-key hashing pattern in `convex/api_keys.ts`, but is the data
  agent's call).
