# ADR 003 — Lifting the Freeze on Alerting, Outbound Webhooks, and Data Export

Status: Accepted
Date: 2026-07-19
Relates to: ADR-002 (analytics/usage-metering freeze lift, tracked separately),
CLAUDE.md "Not in v1", ADR-0023 (webhook mutation authorization — original
numbered sequence), ADR-001 (retention/erasure — precedent for org-scoped,
operator-invoked bulk operations)

## Context

CLAUDE.md's "Not in v1" section explicitly deferred several categories of
functionality until the initial release shipped and the decision was
revisited: analytics/usage metering, and "webhooks or external integrations
(Slack, PagerDuty, etc.)." Alerting was never separately listed but is the
same shape of feature — a system-initiated, outbound side effect triggered by
run state — and carries the same risks.

The project owner has now directed implementation of three capabilities in
this category:

1. **Alerting** — org-configured rules that fire when a run reaches a
   terminal state matching a condition (e.g. "any `run.failed` for agent X").
2. **Outbound webhooks** — HTTPS POST delivery of an event envelope to an
   org-configured URL, so external systems can react to run outcomes.
3. **Data export** — bulk and single-run extraction of already-stored,
   already-authorized data (runs, events, artifacts, comments, verification
   results) in JSON/CSV/ndjson.

Analytics/usage metering remains a separate freeze-lift decision, tracked in
ADR-002; it is out of scope here.

Data export is the least risky of the three: it reads through existing,
already org-scoped and already-tested queries, initiates no outbound network
call to a third party, and introduces no new persistent state. It ships in
full this cycle. Alerting and webhooks introduce a genuinely new capability
— the platform makes outbound HTTP requests to operator-supplied URLs on its
own initiative — and are being built this cycle only as a pure, unwired
delivery engine; the schema, admin UI, and the scheduler/action that actually
triggers a delivery are deferred to a follow-up cycle (see
`docs/design/action_layer.md`).

## Decision

The freeze is lifted for **alerting, outbound webhooks, and data export**,
subject to the following constraints, which are non-negotiable in the same
sense as the Event Log Rules and Tenancy Rules elsewhere in CLAUDE.md:

1. **Org-scoped.** Every alert rule, webhook target, and export request is
   scoped to a single organization. No alert rule or webhook target may
   reference cross-org data, and no export query may return records outside
   the caller's org — this is the same tenancy boundary that already governs
   every Convex query and mutation.

2. **Admin-managed.** Creating, editing, or deleting an alert rule or webhook
   target is a privileged, admin-role-only mutation (mirroring the role
   check already used for retention-policy changes). A regular member may
   view configured rules/targets and trigger a data export, but may not
   configure where alerts or webhooks are sent.

3. **Append-only delivery logs.** Every webhook delivery attempt (and every
   alert evaluation that fires) is recorded as an immutable log row: target,
   payload hash, HTTP status (or error), attempt number, and timestamp. There
   is no update or delete mutation for a delivery log row, matching the
   event-log immutability principle — this log is itself an audit trail of a
   privileged, automated action.

4. **HTTPS-only targets.** A webhook target URL must use `https://`. No
   `http://`, no non-standard schemes. This is enforced in code
   (`assertSafeWebhookUrl` in `apps/web/src/lib/delivery.ts`), not just
   documented.

5. **HMAC-signed payloads.** Every webhook delivery is signed with a
   per-target secret using HMAC-SHA256, svix-style (`t=<ts>,v1=<hex>`), so a
   receiving system can verify authenticity and reject replays outside a
   tolerance window. See `signWebhookPayload` / `verifyWebhookSignature` in
   `apps/web/src/lib/delivery.ts` for the exact format and verification
   steps.

6. **SSRF-guarded delivery.** Before any outbound fetch, the target URL is
   validated: HTTPS only, no literal private/reserved IP (RFC 1918, loopback,
   link-local, unique-local IPv6), no `localhost`/`*.internal`/`*.local`
   hostname. This is a necessary but incomplete mitigation — see
   Consequences below.

7. **Data export ships now, complete.** Because export only reads through
   existing org-scoped queries and introduces no outbound side effects or new
   persistent state, it is not subject to the "engine only, wiring deferred"
   split that applies to alerting/webhooks. `GET /api/export/runs` and
   `GET /api/export/runs/[runId]` are fully functional this cycle.

## Consequences

- CLAUDE.md's "Not in v1" section will be amended in the final cycle of this
  work to remove webhooks/external-integrations from the freeze list (and to
  reflect ADR-002's analytics decision), replacing the blanket prohibition
  with a pointer to this ADR and the constraints above.
- The delivery engine shipped this cycle (`apps/web/src/lib/delivery.ts`) is
  pure and transport-level: it does not yet read from or write to any Convex
  table. It is not reachable from any route or scheduled function yet. No
  alert rule or webhook target can be configured until the data agent lands
  the corresponding schema and the wiring cycle lands the Convex
  action/scheduler described in `docs/design/action_layer.md`.
- **Known limitation, flagged for the audit cycle:** the SSRF guard
  (`assertSafeWebhookUrl`) is a syntactic check against the hostname/URL at
  call time. It does not resolve DNS and pin the resolved IP for the actual
  outbound fetch, so it does not fully mitigate DNS-rebinding — a public
  hostname that resolves to a public IP at validation time could be rebound
  to a private IP by the time the fetch happens. Full mitigation requires a
  resolve-then-pin strategy (resolve once, validate the IP, connect directly
  to that IP while preserving the original Host/SNI). This is deferred to a
  security-hardening pass; it must not be treated as fully closed.
- Export responses can be heavy (up to 5,000 runs, or an entire run's event
  log). The export routes use a stricter rate limit than standard read
  routes and stream their response bodies rather than materializing
  unboundedly large strings in memory.
- Any future alert-rule or webhook-target schema in `convex/schema.ts` is
  the data agent's responsibility, not this team's; this ADR documents the
  constraints that schema must satisfy, not the schema itself.
