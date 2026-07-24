# ADR 005 — Failure Patterns (Prevention)

Status: Accepted (Cycle 1); Amended (Cycle 2 — pattern-spike alerting +
accurate daily trend)
Date: 2026-07-24
Relates to: ADR-0002 (event log is canonical), ADR-0003 (tenancy boundary),
ADR-002 (data model expansion — observability-grade rollups), ADR-004 (run
explanations)

> **Cycle 2 amendment:** this ADR's Cycle 1 text below is left unchanged as
> the historical record of what shipped first. See "Cycle 2 (DEEPEN)" at the
> end of this file for what changed: pattern-spike alert firing (closing the
> "stored, not alerted on" gap) and an accurate, non-sample-truncated daily
> trend.

## Context

ADR-004 answers "why did *this* run fail?" per run. CLAUDE.md's primary v1
outcome — "make failures explainable" — extends naturally to a second
question this ADR answers: "have we seen this failure before, and how often?"
An engineer debugging a fresh failure benefits from knowing it is the ninth
occurrence of a known, recurring fingerprint rather than a novel one, and from
being alerted when a previously-rare fingerprint suddenly spikes.

## Decision

**A durable, org-scoped memory of recurring failure fingerprints, derived from
`run_explanations`.** Every time `run_explanations.ts`'s `generateRunExplanation`
classifies a terminal failure (heuristic `failureClass` + the grounded
`citedSequenceNumbers`/event window it already computed — see ADR-004), it
derives a fingerprint (`heuristicClass`, plus a salient discriminator: a
failing tool name, a terminal event type, or a normalized error signature) and
schedules (`ctx.scheduler.runAfter(0, ...)`, non-blocking, same discipline as
ADR-004's own scheduling) an append-only occurrence record.

**OBSERVABILITY-GRADE DERIVED DATA, NEVER SOURCE OF TRUTH** — this is the same
constraint ADR-002 states for `daily_rollups`/`usage_counters`, restated here
explicitly because it is the load-bearing invariant of this feature: a
`failure_patterns` rollup (count, first/last seen, representative runs,
affected agent versions, spike assessment) is *computed from* the event log +
`run_explanations`, never the other way around. Deleting every row in both new
tables and recomputing them from scratch (replaying every run's explanation)
would only mean "we forget which failures recurred, until the next occurrence
re-teaches us" — never "a fact about what happened on any run changed."
Nothing in this feature is read by, or feeds back into, replay/diff or the
event log itself.

**Two tables: append-only occurrences, upserted rollup.**
- `failure_pattern_occurrences` — APPEND-ONLY, like `events`/`evals`/
  `audit_log`. One row per `runId` (idempotency is enforced at write time via
  the `by_run` index, the same "write-time discipline, not a database
  constraint" pattern `run_explanations.by_run` already uses — see ADR-004).
  There is no update or delete mutation for this table, mirroring the event
  log's own immutability rule exactly.
- `failure_patterns` — a rollup, exactly one row per `(orgId, fingerprintHash)`,
  upserted (patched in place) as new occurrences land. NOT append-only — same
  category as `daily_rollups`/`run_explanations`: a generated aggregate, never
  itself a fact about a single run.

**Idempotent per run, org-scoped, cross-org isolated.**
`recordFailurePatternOccurrence` (an `internalMutation`) is a no-op if an
occurrence already exists for the given `runId` — safe against the same
terminal-transition path firing more than once, or a scheduler retry. Every
row (occurrence and rollup) carries `orgId`; every public query
(`listFailurePatterns`, `getFailurePattern`) calls `requireOrgMembership`
before touching either table, and every index used for lookups is
org-prefixed.

**Fingerprinting and spike detection are pluggable, pure functions — this
cycle ships a documented fallback.** The interface this feature depends on
(`deriveFailureFingerprint`, `assessPatternSpike`) is owned by the Insight
Engine (`convex/insights.ts`, Team B) per the cross-team coordination for this
cycle. `convex/failure_patterns.ts` calls both via a guarded dynamic lookup —
the same pattern `convex/run_explanations.ts` uses for
`buildHeuristicExplanation` (ADR-004) — and falls back to a thin, pure, local
implementation with the identical signature when Team B's exports are not yet
present. This is deliberate, not a placeholder to be embarrassed about: it
means this feature ships and typechecks independently of exactly when Team
B's (better, presumably ML/statistics-informed) implementations land, and
upgrades to them with zero code change the moment they do.

**Spike assessment is stored, not (yet) alerted on.** A periodic cron
(`assessPatternSpikesCron`, every 15 minutes) recomputes each active pattern's
trailing 14-day daily trend and calls `assessPatternSpike`, storing the result
on `failure_patterns.lastSpikeAssessment`. It deliberately does **not** create
an `alert_events` row via `convex/alerts.ts`'s `recordAlertFired`: that would
require a `pattern_spike` entry in `alert_rules.kind`'s closed enum, which is
alerting-surface schema/API owned by `convex/alerts.ts` — out of this file's
ownership this cycle. This is an explicit, documented gap (see
`convex/failure_patterns.ts`'s `assessPatternSpikesCron` doc comment), not a
silent omission: a future cycle (or Team C) wiring real alert delivery for a
spiking pattern should either add a `pattern_spike` alert-rule kind, or poll
`lastSpikeAssessment` from the alert-evaluation path.

## Consequences

- `packages/contracts` gains `failure_patterns.ts`
  (`FailurePattern`/`FailurePatternOccurrence`/`FailurePatternTrendPoint`/
  `FailurePatternDetail`) — additive, a patch version bump (0.7.6 → 0.7.7),
  not breaking.
- `convex/schema.ts` gains two new, additive tables
  (`failure_pattern_occurrences`, `failure_patterns`); no existing table or
  field changes. Migration is a no-op.
- `convex/run_explanations.ts` gains exactly one new call
  (`ctx.scheduler.runAfter(0, _recordFailurePatternOccurrenceRef, ...)`,
  scheduled right after its existing `_upsertRunExplanationRef` call in
  `generateRunExplanation`) plus one import — everything else in that file is
  untouched. The event log's immutability and ADR-004's grounding guarantee
  are both unaffected: this feature only *reads* the classification ADR-004
  already grounded, it adds no new event or explanation fields.
- No read-facing API route or UI surface is added this cycle — `read_api.ts`
  (Team D) and the UI (Team E) are expected to expose
  `listFailurePatterns`/`getFailurePattern` in a later cycle.
- Alert-firing on a detected spike is explicitly deferred (see "Spike
  assessment is stored, not (yet) alerted on" above) — `lastSpikeAssessment`
  is visible on the rollup for any future consumer, but nothing in this
  cycle notifies a human about it.

## Cycle 2 (DEEPEN) — pattern-spike alerting + accurate daily trend

This cycle closes the two gaps Cycle 1 left open, without changing any of the
invariants above (event log immutability, org-scoping, occurrences remaining
append-only, the rollup remaining a derived/regeneratable aggregate).

**1. `pattern_spike` alert-rule kind + real firing.** `alert_rules.kind`
(`convex/alerts.ts` / `convex/schema.ts`, `packages/contracts/src/alerts.ts`)
gains a fourth variant, `pattern_spike` — additive to the closed enum, a
patch/minor contracts bump (0.7.7 → 0.7.8). `alert_events` gains two additive/
optional fields: `patternFingerprintHash` (the fingerprint whose rollup
transitioned into spiking) and `metadata` (freeform, kind-specific structured
payload — for `pattern_spike`, `{ fingerprintHash, class, label, recentCount,
deepLink }`, where `deepLink` is `/patterns/[fingerprint]`). Neither field is
populated for any other alert kind.

`convex/failure_patterns.ts`'s `assessPatternSpikesCron` now calls
`convex/alerts.ts`'s new `firePatternSpikeAlert` (an `internalMutation`)
whenever a pattern's spike assessment transitions from not-spiking to
spiking. `firePatternSpikeAlert` mirrors `convex/alert_engine.ts`'s existing
per-rule firing semantics exactly: it fires once per ENABLED `pattern_spike`
alert_rule in the pattern's org (a rule of this kind is treated as org-wide —
`projectId` is not meaningful for an org-scoped, not project-scoped, rollup),
inserting one append-only `alert_events` row plus one channel delivery
(`webhook_deliveries`/`email_deliveries`) per rule channel, same as every
other kind. An org with no matching enabled rule gets its spike assessment
stored (unchanged from Cycle 1) but no alert fires — same "no-op when no rule
matches" behavior every other alert kind already has.

**2. Anti-flap / idempotency: rising-edge-only, with a cooldown, stored on the
rollup itself.** A pattern-spike alert must fire AT MOST ONCE per spike
episode, not on every 15-minute cron tick for as long as the pattern remains
above threshold. This is decided by a new pure Insight Engine (Team B)
function, `assessPatternSpikeTransition(prev, curr, opts)`
(`convex/insights.ts`), consumed via the same guarded-dynamic-lookup +
local-fallback discipline `deriveFailureFingerprint`/`assessPatternSpike`
already established in Cycle 1 — `assessPatternSpikeTransitionFallback` in
`convex/failure_patterns.ts` is what runs if Team B's export isn't present.
The decision only needs `prev` (the previously stored `lastSpikeAssessment`)
and this pattern's own `lastPatternSpikeAlertFiredAt` (a new additive,
optional field on `failure_patterns` — the epoch ms this pattern last fired a
spike alert, across every `pattern_spike` rule in the org; a per-pattern
cooldown, not per-rule): a rising edge (not-spiking/never-assessed ->
spiking) fires unless still inside the cooldown window (default 6h) since the
last fire, and a sustained spike (already spiking -> still spiking) never
fires again regardless of cooldown. `lastPatternSpikeAlertFiredAt` is
advanced whenever a fire is ATTEMPTED, independent of whether any rule
existed to receive it — the anti-flap state tracks "did this pattern's
assessment just transition," not "did a human get notified."

**3. Accurate daily trend — no longer a bounded occurrence sample.** Cycle
1's trend was built by reading up to `MAX_TREND_OCCURRENCE_SAMPLE` (2,000)
occurrence rows and bucketing them into 14 daily counts — silently
undercounting any day past that sample's horizon for a high-volume
fingerprint. Cycle 2 replaces this with `failure_pattern_daily_counts`, a new
additive table: exactly one row per `(orgId, fingerprintHash, day)`,
upserted/incremented by `recordFailurePatternOccurrence` alongside every new
occurrence (same append-friendly, observability-grade category as
`daily_rollups`/`usage_counters` — never itself a fact about a single run).
Both `getFailurePattern` and `assessPatternSpikesCron` now read the trend via
`readAccurateTrend`, which ranges the `by_org_fingerprint_day` index over the
14-day window — reading at most 14 rows per call, REGARDLESS of how many
occurrences the fingerprint has ever recorded, so this is simultaneously more
accurate and cheaper than the sample it replaces. `MAX_TREND_OCCURRENCE_SAMPLE`
is removed; `buildTrendFromOccurrences` (the Cycle 1 bucketing function) is
kept, exported, and tested as a still-correct pure utility for any caller that
only has a raw occurrence list in hand, but is no longer used by either query.

**Contracts/schema summary:**
- `packages/contracts/src/alerts.ts`: `AlertRuleKind` gains `"pattern_spike"`;
  `AlertEvent` gains optional `patternFingerprintHash`/`metadata`. Version
  0.7.7 → 0.7.8.
- `convex/schema.ts`: `alert_rules.kind` gains `pattern_spike`; `alert_events`
  gains optional `patternFingerprintHash`/`metadata`; `failure_patterns` gains
  optional `lastPatternSpikeAlertFiredAt`; new additive table
  `failure_pattern_daily_counts`. No existing field changes shape — migration
  is a no-op.
- No read-facing API route or UI surface for `pattern_spike` rules/events is
  added this cycle (Team C/D/E, as with Cycle 1's `listFailurePatterns`/
  `getFailurePattern`).

## Cycle 3 (HARDEN + close deferrals) — mute, webhook pattern context, cooldown fix

This cycle closes the last deferral this feature carried (Cycle 2 shipped a
throwing `mutePattern`/`unmutePattern` stub deliberately removed before
ship — "a throwing stub is worse than nothing") and a gap the cross-cutting
audit flagged in the webhook envelope, plus a subtler cooldown bug the same
audit found. None of these changes touch the invariants above: occurrences
remain append-only, the rollup remains a derived/regeneratable aggregate,
and every mutation remains org-scoped.

**1. Mute, implemented end-to-end.** `failure_patterns` gains two additive,
optional fields: `muted?: boolean` and `mutedAt?: number`. Two new
mutations, `mutePattern`/`unmutePattern`
(`{ orgId, fingerprintHash } => Doc<"failure_patterns"> | null`), are
org-scoped, **admin-gated** (`requireOrgMembership(ctx, orgId, { minimumRole:
"admin" })` — the same tier as alert-rule mutations, since muting suppresses
org-wide alerting) and **audited** (`failure_pattern.muted`/
`failure_pattern.unmuted`, added to `AUDIT_ACTIONS`). Both return `null`
(never throw) when the fingerprint does not exist in the caller's org — the
same "never existed" / "belongs to a different org" collapse
`getFailurePattern` already uses, so a caller-facing layer can map both to
one generic 404 without this mutation leaking which case it was. Neither
mutation touches `failure_pattern_occurrences` (still append-only,
untouched) or stops `recordFailurePatternOccurrence`/
`assessPatternSpikesCron`'s own assessment bookkeeping — muting suppresses
exactly one thing: `assessPatternSpikesCron`'s call to
`firePatternSpikeAlert` on a rising-edge transition. A muted pattern still
gets `lastSpikeAssessment` computed and stored on every cron tick
(observability is unaffected); it just never reaches `alert_events`/webhook/
email delivery while `muted` is true. `mutedAt` is not cleared on unmute —
it is a "last muted at" historical marker, not a "currently muted since"
field; `muted: false` alone is the live suppression flag. See
`convex/failure_patterns.test.ts`'s "mutePattern / unmutePattern" suite,
which proves a muted pattern spiking fires zero `alert_events` rows and that
unmuting followed by a fresh rising edge (drop-then-respike, same pattern
Cycle 2's cooldown tests already used) fires again.

**2. Webhook pattern context.** A `pattern_spike`-driven `alert_events` row
already carried `patternFingerprintHash`/`metadata` (Cycle 2), but
`convex/webhook_engine.ts`'s `deliverPendingWebhooks` built its envelope from
only `{apiVersion, event, orgId, run, firedAt}` and never read that row —
a pattern-spike webhook delivery lost all pattern context (fingerprint,
class, label, recentCount, deep link), leaving only the generic `alert.fired`
event name and a representative run. `WebhookEnvelope` (contracts) gains an
optional `pattern?: WebhookEnvelopePattern` field
(`{fingerprintHash, class, label, recentCount, deepLink}`); `webhook_engine.ts`
now looks up the delivery's `alert_events` row (a new `getAlertEventForEnvelope`
internal query) and reattaches this context when `patternFingerprintHash` is
set, leaving it absent for every other alert kind. HMAC signing is unchanged
in mechanism — it already signs `JSON.stringify(payload)` over whatever the
envelope object contains, so the new field is covered by the same signature
with no separate signing logic needed (see
`convex/action_layer.test.ts`'s "carries pattern context ... signed over the
full payload" test, which recomputes the expected signature independently
and compares).

   **Deep-link absolutization (ADR-003 constraint):** ADR-003 requires an
   external webhook's deep link to be absolute, not a bare relative path.
   `convex/alerts.ts` already had exactly the seam this needs:
   `AFR_WEB_BASE_URL` (`.env.example`), the same optional Convex env var
   `alert_engine.ts`'s `buildRunUrl` already uses for the "View run" link in
   alert emails. `firePatternSpikeAlert`'s new `buildPatternDeepLink` helper
   prefixes `/patterns/[fingerprintHash]` with `AFR_WEB_BASE_URL` when set,
   falling back to the bare relative path when it is not (most deployments
   have no operator-facing setup step for this env var yet). No new env var
   was introduced — this reuses the one seam already documented for exactly
   this purpose, rather than inventing a second one. The relative-path
   fallback is a documented, not silent, limitation: `WebhookEnvelopePattern`'s
   doc comment and this ADR both flag it, and an external consumer that needs
   an absolute URL in that case can construct one from `fingerprintHash` plus
   its own known app origin.

**3. Cooldown-advance fix (cross-cutting audit finding).** Cycle 2's
`assessPatternSpikesCron` advanced `lastPatternSpikeAlertFiredAt` (the
per-pattern anti-flap cooldown clock) whenever a fire was merely *attempted*
(`transition.shouldFire === true`), even when the org had zero enabled
`pattern_spike` rules to receive it. Consequence: an org whose pattern spiked
before any rule was configured would silently start its cooldown timer, so
the first rule an admin added later could miss that still-ongoing spike for
up to a full cooldown window (default 6h). Fixed: the cooldown now only
advances when `firePatternSpikeAlert`'s own `{ fired }` count is `> 0` — i.e.
a fire that actually reached at least one enabled rule. A muted pattern is
treated the same way (the fire is skipped entirely, so the cooldown clock
does not advance either) — this is also the mechanism that lets unmuting,
followed by a later genuine rising edge, fire again. See
`convex/failure_patterns.test.ts`'s "AUDIT FIX (cycle 3)" test.

**Contracts/schema summary:**
- `packages/contracts/src/failure_patterns.ts`: `FailurePattern` gains
  optional `muted`/`mutedAt` (and the previously-undeclared
  `lastPatternSpikeAlertFiredAt`, a Cycle 2 field that had been left off the
  contract — added now for schema/contract parity).
- `packages/contracts/src/webhooks.ts`: new `WebhookEnvelopePattern`
  interface; `WebhookEnvelope` gains optional `pattern`. Version 0.7.8 →
  0.7.9 (both changes are additive).
- `convex/schema.ts`: `failure_patterns` gains optional `muted`/`mutedAt`. No
  existing field changes shape — migration is a no-op.
- `convex/audit.ts`: `AUDIT_ACTIONS` gains `failure_pattern.muted`/
  `failure_pattern.unmuted`.
- Mutation contract for other teams (Team C's mute route/service, Team E's
  mute UI, Team D's CLI):
  `failure_patterns:mutePattern`/`unmutePattern({ orgId, fingerprintHash }) => Doc<"failure_patterns"> | null`.
