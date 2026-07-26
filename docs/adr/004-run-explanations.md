# ADR 004 — Run Explanations ("Why did this fail?")

Status: Shipped (final as of Explainability Layer cycle 3)
Date: 2026-07-24
Relates to: ADR-0002 (event log is canonical), ADR-0003 (tenancy boundary),
ADR-002 (evals/data model expansion), ADR-003 (alerting)

## Context

CLAUDE.md's primary v1 outcome is "make failures explainable." Today an
engineer debugging a failed run must manually read the event log, the
eval results, and the verification status to reconstruct what happened.
This ADR adds a generated, grounded, plain-English root-cause explanation
attached to any failed/timed_out (and, at an admin's discretion, cancelled)
run — the flagship "Why did this fail?" feature for this cycle.

## Decision

**Grounded, never asserting beyond the trace.** An explanation is built from
the run's own event log (a deterministic `FailureSummary`, mirroring
`apps/web/src/lib/replay/failure.ts`'s pure derivation — Convex cannot import
across the `apps/web` boundary, so `convex/helpers/failure_summary.ts` is a
dependency-free mirror, matching the existing `helpers/notifier.ts` /
`helpers/delivery.ts` precedent) plus its evals. It cites real
`sequenceNumber`s from that run; any claim that cannot be tied to an event in
the log is not something this feature is allowed to state.

**Deterministic by default, LLM as an opt-in supplement.** Team B's PURE
`buildHeuristicExplanation` (`convex/insights.ts`) ALWAYS runs and produces a
usable explanation with zero external configuration — this is the feature
that ships. An LLM provider is entirely optional (`AFR_LLM_PROVIDER` env var,
pluggable — see `convex/helpers/llm_provider.ts`, mirroring
`helpers/notifier.ts`'s `EmailNotifier` pattern exactly: a `Noop` default, a
generic HTTP-POST shape that does not hardcode a vendor). When configured, the
LLM is given a grounding prompt that lists only the sequence numbers that
actually exist on the run and is instructed to cite only those. Its response
is never trusted as-is: any cited `sequenceNumber` not present in the run's
own event log is stripped (`validateCitedSeqNums`), and if what remains cites
zero real events or is missing a summary/root cause, the LLM result is
discarded entirely and the heuristic result is stored instead. This is the
core safety property: an LLM outage, misconfiguration, or hallucination can
never produce an *ungrounded* explanation — it can only fail closed to the
deterministic one.

**Cached, regeneratable — not append-only.** Unlike `events`/`evals`, a run
explanation is a *generated artifact about* the immutable log, not an
observation recorded *into* it. `run_explanations` therefore permits
delete-then-insert regeneration (one row per `runId`, enforced by write-time
discipline via the `by_run` index) rather than being append-only. Every
regeneration is itself audited (`run_explanation.regenerated` in
`audit_log`), so "who asked for a fresh explanation, and when" stays visible
— this mirrors why `alert_events`/`webhook_deliveries` allow a narrow,
audited patch without violating the spirit of immutability elsewhere in the
schema.

**Org-scoped, generated off the terminal-transition path, non-blocking.**
`generateRunExplanation` (an `internalAction`) is scheduled via
`ctx.scheduler.runAfter(0, ...)` — never called inline — from every path that
can land a run in `failed`/`timed_out`/`cancelled`: the `run.failed` terminal
event (`convex/events.ts`, `convex/sdk_ingest.ts`), an admin's
`updateRunStatus` call, and the stale-run-expiry cron
(`convex/stale_runs.ts`). It never blocks or risks the ingest/mutation path
it is scheduled from, matching the existing `runEvalsThenEvaluateAlerts`
precedent. Only `failed`/`timed_out`/`cancelled` runs are eligible;
`getRunExplanation` returns `null` for a `completed` (or still-active) run
rather than an empty/placeholder explanation. `regenerateRunExplanation` is
an admin-gated public `action`; `getRunExplanation` is a member-gated public
`query`, both enforcing `requireOrgMembership`/an equivalent internal
membership check before touching any row.

## Consequences

- `packages/contracts` gains `run_explanations.ts` (a `RunExplanation`
  interface) — additive, a patch version bump (0.7.3 → 0.7.4), not breaking.
- `convex/schema.ts` gains one new, additive table (`run_explanations`); no
  existing table or field changes. Migration is a no-op.
- The event log's immutability is unaffected: `run_explanations` is
  explicitly NOT append-only (see above), but it is also not part of the
  event log — it is a derived, regeneratable projection, same category as
  `daily_rollups`, just per-run instead of per-day.
- `convex/insights.ts` (Team B) is expected to land a pure
  `buildHeuristicExplanation(run, events, failureSummary, evalResults)`
  function this cycle; `convex/run_explanations.ts` calls it via a guarded
  dynamic lookup so this change typechecks and ships independently of that
  landing, and picks up the real implementation with zero code change once
  it does.
- No vendor SDK or vendor-specific request/response shape is introduced by
  this change — `HttpExplanationLLM` is generic HTTP, opt-in, and disabled by
  default (`AFR_LLM_PROVIDER` unset ⇒ heuristic-only, zero external calls).

## Cycle 3 — final state

This feature is DONE as of this cycle; the two paths, the grounding
guarantee, and the injection mitigations below are the shipped, final
design (see `docs/design/explanations.md` for the full HTTP-surface and
threat-model writeup this section summarizes):

- **Two generation paths, one trust hierarchy.** `buildHeuristicExplanation`
  (Team B, `convex/insights.ts`) is deterministic, zero-config, and ALWAYS
  computed first — it is the explanation that ships when no LLM provider is
  configured, and the fallback whenever the LLM path is skipped, discarded,
  or fails. The optional LLM path (`AFR_LLM_PROVIDER=http`) only ever
  supplements or replaces the heuristic result after passing the grounding
  gate below; it never runs instead of computing the heuristic first, and it
  never gets a path to bypass that gate.
- **Grounding guarantee, unconditional.** `validateCitedSeqNums` strips any
  `citedSeqNums` (from either path) not present in the run's own event
  window, and the grounding gate in `generateRunExplanation` discards an LLM
  result entirely (falling back to the heuristic) unless, after that
  filtering, it cites at least one real sequence number and has a non-empty
  `summary`/`rootCause`. No explanation this feature stores can cite a
  fabricated event.
- **Injection mitigations, both layers shipped.** Layer 1 (citation
  validation, above) is what actually neutralizes a successful injection
  attempt. Layer 2 (structural isolation — the `UNTRUSTED_TRACE_DATA` fence
  around every trace-derived field in the grounding prompt, plus
  `neutralizeTraceMarkers` closing the cycle-3 delimiter-forging gap) is
  defense-in-depth on top of it. Neither layer, individually or combined,
  guarantees narrative *accuracy* on real, correctly-cited events — see
  `docs/design/explanations.md`'s "Layer 2" and "What this does not defend
  against" sections for the honest residual. This is why the deterministic
  heuristic explanation remains the trusted default rather than a stopgap.
- **Coarse null state resolved at the source.** `getRunExplanation` now
  returns an explicit `status: "not_eligible" | "pending" | "ready"`
  discriminant (Team A) alongside `explanation`/`runStatus`/`runEndedAt`;
  `services/explanations.ts`'s `getRunExplanationWithStatus` and `GET
  /api/runs/[id]/explanation` (Team C) expose it end-to-end. The UI
  (`ExplanationPanel`, the failed-runs-list preview) has not yet adopted it —
  it still uses a client-side `isStillAnalyzing`/`ANALYZING_GRACE_PERIOD_MS`
  time heuristic, which remains a reasonable approximation but is superseded
  in precision by the real discriminant now available over HTTP. See
  `docs/design/explanations.md`'s equivalent section for the adoption gap.
