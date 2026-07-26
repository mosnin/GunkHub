# ADR 006 — Failure Pattern Resolution Lifecycle

Status: Accepted
Date: 2026-07-24
Relates to: ADR-005 (failure patterns — the rollup/occurrence model this ADR
layers a lifecycle on top of), ADR-002 (data model expansion — observability-
grade rollups), ADR-0002 (event log is canonical and immutable)

## Context

ADR-005 gives every recurring failure fingerprint a durable rollup
(`failure_patterns`) and, in its Cycle 3 amendment, an admin-gated
mute/unmute for alert suppression. What it does not give an engineer is a way
to say "I've seen this, I'm on it" or "this is fixed" — and, just as
importantly, a way to find out automatically if a fix that looked good didn't
actually hold. This ADR adds that lifecycle.

## Decision

**A human-driven lifecycle layered on the rollup, never a new source of
truth.** Exactly like `comments` are an annotation hung off `runs`/`events`
(never a fact about what happened), the `status`/`acknowledgedAt`/
`resolvedAt`/`resolutionNote`/`resolutionRef`/`regressedAt` fields added to
`failure_patterns` (all optional/additive — `convex/schema.ts`) are an
annotation on the rollup. The underlying `failure_pattern_occurrences` table
and the rollup's own count/lastSeenAt/trend bookkeeping are completely
unaffected by this lifecycle; resolving a pattern does not stop
`recordFailurePatternOccurrence` from recording future occurrences against
the same fingerprint.

### States

`FailurePatternStatus = "open" | "acknowledged" | "resolved"`
(`packages/contracts/src/failure_patterns.ts`). Absent `status` means `"open"`
— every pre-this-cycle row and every freshly-created rollup defaults to open
by omission, not by an explicit write, so no migration/backfill is required.

### Mutations (`convex/failure_patterns.ts`)

All three are **MEMBER-gated** (`requireOrgMembership(ctx, orgId, {
minimumRole: "member" })`), not admin-gated — this is normal day-to-day triage
work, the same tier as `comments.ts`'s resolve/edit, and deliberately a lower
bar than `mutePattern`/`unmutePattern` (admin-gated, because muting is
org-wide alert-suppression config, not personal triage). All three are
audited (`convex/audit.ts`'s `AUDIT_ACTIONS`) and return the full updated
`Doc<"failure_patterns">`, or `null` when the fingerprint does not exist IN
THE CALLER'S ORG — the same "never existed" / "belongs to a different org"
collapse `mutePattern`/`getFailurePattern` already use, so a caller-facing
layer can return one generic 404 without this layer leaking which case it
was.

- `acknowledgePattern({ orgId, fingerprintHash }) => Doc<"failure_patterns"> | null`
  — sets `status: "acknowledged"`, `acknowledgedAt: Date.now()`,
  `acknowledgedByUserId: <caller>`. Audited as `"failure_pattern.acknowledged"`.
  Does not touch `resolvedAt`/`regressedAt`.

- `resolvePattern({ orgId, fingerprintHash, note?, ref? }) => Doc<"failure_patterns"> | null`
  — sets `status: "resolved"`, `resolvedAt: Date.now()`,
  `resolvedByUserId: <caller>`, and `resolutionNote`/`resolutionRef` if
  supplied. `note`/`ref` are bounded free text, validated **server-side** (not
  just at the UI layer) against `MAX_RESOLUTION_NOTE_LENGTH` /
  `MAX_RESOLUTION_REF_LENGTH` (2 KB each, `convex/helpers/pagination.ts`) —
  same "server enforces its own invariants" discipline as every other bounded
  string field in this codebase. Audited as `"failure_pattern.resolved"`.
  Deliberately does **not** clear a pre-existing `regressedAt` — see
  "Why regressedAt survives a resolve" below.

- `reopenPattern({ orgId, fingerprintHash }) => Doc<"failure_patterns"> | null`
  — sets `status: "open"` and clears `regressedAt`. A **manual** reopen is not
  itself a regression event, so the "your fix didn't hold" marker should not
  linger past a deliberate human reopen (contrast with `resolvePattern`
  above). Audited as `"failure_pattern.reopened"`.

`resolvedByUserId`/`resolutionNote`/`resolutionRef`/`acknowledgedAt`/
`acknowledgedByUserId` are never cleared by `reopenPattern` — they are
historical "last resolution/acknowledgement" context, the same "don't erase
the paper trail" posture `mutedAt` already established in ADR-005 Cycle 3
(not cleared on unmute).

### The regression guard

The load-bearing new behavior: `recordFailurePatternOccurrence`'s
`upsertRollup` helper (`convex/failure_patterns.ts`) checks, on every new
occurrence, whether the existing rollup is `status === "resolved"` **and**
this occurrence's `occurredAt` is after the rollup's `resolvedAt`. If so:

1. The rollup is auto-reopened in the same patch as the count/lastSeenAt
   update: `status: "open"`, `regressedAt: <this occurrence's occurredAt>`
   (not `Date.now()` — mirrors how `lastSeenAt`/`firstSeenAt` already use the
   caller-supplied `occurredAt`, so a backfilled/replayed occurrence regresses
   at the time it actually happened, not at replay time).
2. Unless the pattern is `muted`, `convex/alerts.ts`'s
   `firePatternRegressionAlert` internal mutation is called — a new alert
   kind, `pattern_regressed` (added to `ALERT_RULE_KIND` in
   `convex/alerts.ts` and `alert_rules.kind` in `convex/schema.ts`), fired
   the same way ADR-005 Cycle 2's `pattern_spike` is: one append-only
   `alert_events` row per matching enabled `pattern_regressed` rule in the
   org, `metadata: { fingerprintHash, class, label, resolvedAt, regressedAt,
   deepLink }`, plus one delivery per rule channel. A no-op (`{ fired: 0 }`)
   when the org has no enabled `pattern_regressed` rule, the same posture
   every other alert kind has.

Muting suppresses the alert only, exactly as it does for `pattern_spike` —
the reopen itself always happens regardless of mute state, because mute is
alert-suppression config, not a lifecycle override.

This is idempotent by construction: the moment the regression fires, the
rollup's `status` is `"open"` again, so no *later* occurrence on this same
still-open episode can re-enter the `existing.status === "resolved"` branch
until a human resolves it again.

### Why `regressedAt` survives a resolve

`resolvePattern` leaves a pre-existing `regressedAt` untouched. This means
"has this fingerprint ever regressed before" stays visible as history across
a resolve → regress → resolve cycle, rather than being silently erased the
next time someone marks it resolved again. Only a **human** `reopenPattern`
call clears it, on the theory that a deliberate manual reopen is a fresh
start, not a continuation of the regression history.

## Consequences

- No migration: every field is optional/additive, absent `status` reads as
  `"open"`.
- The event log and `failure_pattern_occurrences` remain completely
  unaffected — this ADR only ever patches the rollup and appends an alert
  event, both already-established derived/observability-grade write paths
  under ADR-005 and ADR-002's constraints.
- Team C (apps/web routes/services) wraps `acknowledgePattern`/
  `resolvePattern`/`reopenPattern` directly — see the mutation contracts
  above for exact args/return shapes. Team C's `alertRules.ts` `mapAlertEvent`
  should widen to handle `alert_rules.kind === "pattern_regressed"` /
  `alert_events.metadata` carrying `resolvedAt`/`regressedAt` instead of
  `recentCount`, alongside the existing `pattern_spike` case.
