# ADR 005 — Failure Patterns (Prevention)

Status: Accepted (Cycle 1)
Date: 2026-07-24
Relates to: ADR-0002 (event log is canonical), ADR-0003 (tenancy boundary),
ADR-002 (data model expansion — observability-grade rollups), ADR-004 (run
explanations)

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
