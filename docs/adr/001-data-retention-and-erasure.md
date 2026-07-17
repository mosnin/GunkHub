# ADR 001 — Data Retention and Erasure

Status: Accepted
Date: 2026-07-17
Relates to: ADR-0002 (event log is canonical), ADR-0003 (tenancy boundary), ADR-0011/0026 (artifact GC)

## Context

The event log is append-only and immutable (ADR-0002): there are no update or delete
mutations for events, and every derived view (replay, diff, failure summary) depends on
that guarantee. Two enterprise realities collide with pure immutability:

1. **Erasure obligations.** GDPR Art. 17 (and equivalent contractual clauses) require
   that when a customer offboards, their data is actually deleted — event payloads,
   artifacts, comments, memberships, API keys, all of it.
2. **Storage growth.** The event log grows without bound. Customers with high-volume
   agents need a way to age out old, terminal runs they no longer care about.

Doing nothing is not an option; doing it wrong (an ad-hoc `deleteEvent` mutation)
destroys the product's core trust guarantee.

## Decision

**The only sanctioned deletion paths are org-scoped, internal, and whole-record:**

1. **Org purge (`retention:purgeOrganization`)** — an `internalAction` that cascades
   deletion of ALL data belonging to a single organization, in dependency order:
   comments → verification_results → per-run artifacts (with best-effort blob
   deletion, failures logged) and events → runs → agent_versions → agents →
   projects → api_keys → memberships → audit_log → the organization record itself.
   It is batched (≤ ~100 docs per internal mutation call) and re-schedules itself
   via `ctx.scheduler` until drained, respecting Convex transaction limits.
   It is NOT publicly callable — it is invoked only from the Convex dashboard/CLI
   by an operator acting on a verified offboarding/erasure request.

2. **Retention window (`organizations.retentionDays`, `retention:enforceRetention`)** —
   an optional per-org number. A daily cron deletes **terminal** runs (and their
   events, artifacts, comments, verification results) whose `startedAt` is older
   than the window, only for orgs that have opted in by setting `retentionDays`.
   In-progress runs are never touched.

**What this preserves:** within-org immutability. No individual event is ever
updated or selectively deleted; the unit of deletion is the whole run (retention)
or the whole org (purge). An engineer reading a run trace can still trust that
what they see is exactly what was recorded — a run either exists in full or not
at all. There is still no `updateEvent`, no `deleteEvent`, no soft-delete flag.

**Audit trail of the purge itself:** the purge deletes the org's `audit_log` rows
last — an audit row recording "org purged" cannot survive inside the org's own
partition, because erasure requires deleting it too. The terminal purge record is
therefore emitted to the Convex function log (console) with org id, counts, and
timestamp; operators should retain deployment logs per their compliance policy.

## Consequences

- Erasure and offboarding are satisfiable without weakening the event-log contract.
- Storage growth is boundable per org, opt-in, and only ever removes closed runs.
- The purge/retention mutations use `ctx.db.delete` on events internally; this is
  sanctioned ONLY inside `convex/retention.ts` internal functions. Any new public
  deletion surface still requires a fresh ADR.
- Blob deletion is best-effort: a failed blob DELETE is logged and does not block
  record deletion during a purge (the org is gone; orphaned blobs are an ops
  cleanup task surfaced by the logs). Retention-path blob failures are likewise
  logged.
- Cross-region log retention of the console purge record is an operational
  responsibility, not a database guarantee.
