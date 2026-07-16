# Roadmap: Agent Flight Recorder → World-Class Recording at Scale

**Status:** Active
**Date:** 2026-07-16
**Owner:** Platform
**Origin:** Comprehensive audit (score 4.6/10, "not deployable"). This roadmap is
the plan to take the system from "well-engineered but uncompilable and forgeable"
to a world-class recorder that can underpin autonomous AI agents at scale.

---

## 0. Framing

The vision — *enable autonomous AI agents at scale* — does not mean chasing
buzzword features. For a flight recorder it means five properties, in priority
order:

1. **It runs and cannot leak.** Compiles under strict CI; zero cross-tenant paths.
2. **The record is trustworthy.** Every event-log invariant enforced server-side,
   not merely observed after the fact by a nightly job.
3. **It never loses the record.** Durable ingestion across crashes, retries, and
   outages — especially the terminal/failure telemetry.
4. **It stays fast as data grows without bound.** Every query indexed; no full
   scans of the events or runs tables; bounded pagination everywhere.
5. **Failures are explainable in seconds.** The product's stated v1 outcome.

Scale features that require lifting the CLAUDE.md "Not in v1" freeze (streaming
fan-out, distributed ingestion, analytics) are **Phase 5** and gated behind ADRs.
We reach world-class on 1–5 *within the constitution* first. Correctness and
security are the moat; distribution is an optimization you earn afterward.

---

## 1. The Goal (precise, gradeable exit criteria)

The goal is met when **all** of the following are objectively true. Each is a
binary check an audit can grade — no subjective "feels done".

### G1 — Compiles and is gated
- [ ] `convex/` is a workspace package with its own `tsconfig.json` extending
      `tsconfig.base.json`, generated types present, and `pnpm typecheck` covers it.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` each run green over **every**
      package including `convex/`, `tests/`, and `scripts/`.
- [ ] CI runs all three on every PR with no illusory/no-op steps; the integration
      job actually executes its target file.

### G2 — Zero cross-tenant paths
- [ ] No public Convex function mutates or returns org-scoped data without either
      (a) `requireOrgMembership` against the *resource's* org, or (b) a verified
      webhook/secret gate. (Grader: enumerate every export in `convex/**`.)
- [ ] No secret material (`keyHash`) is ever returned by any query.
- [ ] An automated `convex-test` suite proves org-A cannot read or write org-B's
      runs, events, artifacts, comments, or API keys.

### G3 — Event-log invariants enforced at write time
- [ ] Ingest rejects: non-positive/non-integer sequence numbers, gaps,
      duplicates, and any event after a terminal event. (server-side, both paths.)
- [ ] `>10 KB` payload externalization enforced server-side, not only in the route.
- [ ] Property-based tests cover the sequence/terminal invariants.

### G4 — Durable ingestion
- [ ] SDK never drops events on transport failure (buffer restored + retried).
- [ ] SDK flushes terminal/failure telemetry on process crash/exit.
- [ ] Sequence numbers are per-run and start at 1 (verification passes for every run).
- [ ] Externalization threshold measured in UTF-8 bytes.

### G5 — Scales without full scans
- [ ] No `.filter()`-only scan of `runs`, `events`, or `artifacts`; every hot query
      uses an index. Artifact GC pages through all candidates (no starvation).
- [ ] Every list surface in the UI paginates (no unreachable records).

### G6 — Explainable & observable
- [ ] Live run monitoring shows tail events with no duplication bug.
- [ ] Verification cron and on-demand reverify actually run (no nonexistent-API calls).
- [ ] Docs (README, product_spec) match the shipped system.

### G7 — Audit score ≥ 8/10 on every dimension
- [ ] A re-run of the ten-dimension adversarial audit returns **no** confirmed
      critical or high finding, and every dimension scores ≥ 8.

---

## 2. Phases (the loop: implement → audit-gate → fix → advance)

Each phase ends with an **audit gate**: re-run the adversarial audit scoped to the
phase's dimensions. A phase is "done" only when the gate returns no confirmed
critical/high finding in its scope. Do not advance on an unmet gate.

### Phase 0 — Make it real (SHIPPED in this change)
Close the three showstoppers and the highest-severity tenancy/event-log/SDK defects.
- Webhook-mutation authorization (shared-secret gate) — ADR-0023.
- `listApiKeys` no longer returns `keyHash`.
- Server-side sequence positivity + contiguity + terminal-last enforcement
  (`sdkCreateEvents`, `createEvent`).
- `listStaleRuns` uses an index (`by_status_started`) instead of a full scan.
- SDK: buffer restored on flush failure; flush timer `unref()`'d; per-run sequence
  counter.
- Clerk `middleware.ts` added.
- **Gate:** tenancy + event-log + sdk dimensions, no confirmed critical/high.

> **Known Phase-0 carryover (cannot be verified in a sandbox without the Convex
> CLI):** the `convex/` typecheck/workspace integration and `convex codegen` are
> Phase 1 task 1. Phase 0 fixes are correct Convex patterns but are not yet proven
> green by `pnpm typecheck` because `convex/` is still outside the workspace.

### Phase 1 — Compile the backend & close the coverage illusion
1. Add `convex/package.json` + `convex/tsconfig.json`; add `convex` to
   `pnpm-workspace.yaml`; wire `typecheck` = `convex codegen && tsc --noEmit`.
2. Fix every `convex/*` import to the generated paths (`./_generated/server`,
   `./_generated/dataModel`).
3. Fix `projection_verify.ts` to use `ctx.runQuery/runMutation` with internal refs
   (remove nonexistent `runInternalQuery/runInternalMutation`).
4. Add `typecheck` scripts + `tsconfig.json` to `tests/`; lint all packages, not
   just `apps/web`.
5. Fix the integration-test CI command so it actually runs the target file.
- **Gate:** infra + contracts + convex-backend dimensions.

### Phase 2 — Trustworthy record & durable ingestion (finish G3/G4)
1. Server-side 10 KB externalization enforcement in Convex (defense in depth).
2. Close `Event.type`/`payload` validators in schema to the contracts union.
3. SDK crash/exit handlers (`beforeExit`, `SIGTERM`, `uncaughtException`) with a
   synchronous best-effort flush; UTF-8 byte measurement for externalization.
4. Artifact GC: honor `eventId` and run-level references; page through all
   candidates (fix starvation).
- **Gate:** event-log + sdk + convex-backend dimensions.

### Phase 3 — Test the invariants for real
1. `convex-test` harness; tenancy-isolation suite (G2); event-log invariant
   property tests (G3); externalization-threshold edge tests (exactly 10 KB).
2. Replace inline-reimplementation unit tests with tests that import production code.
3. Delete tautological assertions; make type-shape assertions real by typechecking
   `tests/`.
- **Gate:** tests dimension ≥ 8, plus coverage of G2/G3 proven.

### Phase 4 — UI correctness & scale-legibility
1. Fix EventInspector/Timeline live-poll duplication (ref-based dedupe, in-flight
   guard); add `/runs` pagination.
2. Ensure every data view paginates and handles loading/empty/error.
- **Gate:** web-ui dimension ≥ 8.

### Phase 5 — Scale beyond v1 (requires lifting the freeze; ADRs first)
These are the genuinely "at scale" capabilities. Each needs an ADR revising the
CLAUDE.md "Not in v1" list before any code. Sequenced by leverage:
1. **High-throughput ingestion** — batch/streaming ingest endpoint, backpressure,
   idempotency keys, and a queue in front of Convex for burst absorption.
   *(ADR: revisit "multi-region/distributed ingestion".)*
2. **Live streaming to viewers** — replace 5 s polling with a real subscription for
   active runs. *(ADR: revisit "real-time streaming".)*
3. **Aggregate health & analytics** — run-volume, failure-rate, p95-latency views
   for fleets of agents. *(ADR: revisit "analytics dashboards".)*
4. **Retention & tiering** — cold-storage tiering for the events table so unbounded
   growth stays cost-bounded.
5. **External integrations** — webhooks/alerting on run failure. *(ADR: revisit
   "webhooks/external integrations".)*
- **Gate:** full ten-dimension audit ≥ 8 across the board (G7).

---

## 3. Loop discipline

```
for phase in [0,1,2,3,4,5]:
    implement(phase)
    result = audit_gate(phase.dimensions)      # adversarial, verified findings
    while result.has_confirmed(critical|high):
        fix(result)
        result = audit_gate(phase.dimensions)
    commit(); push()
goal_met = full_audit().max_severity < high and full_audit().min_score >= 8
```

Exit the loop only when **G1–G7** all hold. Re-running the full audit is the
terminal check (G7).

---

## 4. Current state after Phase 0

| Goal | Status |
|------|--------|
| G1 compiles & gated | ⏳ Phase 1 (backend still outside workspace) |
| G2 zero cross-tenant | 🟡 critical + high closed; `getOrganization` query + `convex-test` proof remain |
| G3 invariants enforced | 🟡 sequence/terminal enforced; server-side 10 KB + schema union remain |
| G4 durable ingestion | 🟡 data-loss + per-run seq + unref fixed; crash handlers + UTF-8 remain |
| G5 no full scans | 🟡 stale-run scan fixed; artifact GC + UI pagination remain |
| G6 explainable | ⏳ Phase 2/4 (verify-action API + poll dedupe) |
| G7 audit ≥ 8 | ⏳ terminal gate |
