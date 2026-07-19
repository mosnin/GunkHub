# Insight Engine — design and cycle-2 wiring plan

Owner: Team B (Insight Engine). Cycle 1 delivered three pure, schema-independent
engines (`convex/helpers/pricing.ts`, `convex/helpers/analytics.ts`,
`convex/helpers/evals.ts`) plus tests. This doc describes how cycle 2 wires
them into Convex queries/mutations once Team A's schema changes land (`runs`
gains `tokensIn`/`tokensOut`, plus new `daily_rollups` and `evals` tables), and
the API shapes Team E (UI) can build against next cycle.

Everything below is a plan, not yet implemented. Cycle 1 touched no schema,
no query/mutation files, and no other team's files — see the verification
section at the bottom of this doc's companion report.

---

## 1. Pricing — cost shown at query time, never stored

`convex/helpers/pricing.ts` exports `estimateCostUsd(model, tokensIn, tokensOut)`.
Cycle 2 wiring:

- A new query, e.g. `convex/analytics.ts::getRunCost`, reads a run's
  `tokensIn`/`tokensOut` (once Team A adds them) and the model string(s) it
  used (sourced from that run's `llm.request`/`llm.response` events — a run
  may span multiple models; sum `estimateCostUsd` per LLM call, not per run).
- **Never persisted.** Cost is recomputed on every read from the pricing
  table + stored token counts. This mirrors the CLAUDE.md rule against
  denormalizing derived event data ("llm call count", "last error message")
  into `runs` — a stored dollar figure would silently go stale the moment an
  operator overrides `PRICING_TABLE`.
- Unknown-model calls contribute `$0` to the total and are flagged via
  `matched: false` so the UI can render "cost data incomplete" instead of a
  falsely-precise total.

## 2. Analytics — rollup cron and comparison queries

`convex/helpers/analytics.ts` exports `computeRunStats`, `bucketByDay`,
`compareCohorts` — all pure over a `RunSummary[]`.

**Rollup cron** (new `convex/crons.ts` entry + `convex/rollups.ts` internal
mutation, owned by whichever agent lands the schema — coordinate before
writing): once daily, per org, per agent (or per agentVersion — TBD in
cycle-2 kickoff), page through the previous day's terminal runs via the
`by_org_started` / `by_agent_started` indexes, map each `Doc<"runs">` to a
`RunSummary` (`{status, startedAt, endedAt, tokensIn, tokensOut}`), call
`computeRunStats`, and upsert one row per (agentId, date) into
`daily_rollups`. This keeps `computeRunStats`'s bounded-sample contract (≤
~5000 runs/call) intact — the cron work is naturally chunked to one day's
volume, and a day with more than 5000 runs for one agent should page and
merge partial stats rather than pass everything through one call (merge
logic — sum counts, re-flatten duration samples up to a cap — is a cycle-2
TODO, not yet written).

**Version-comparison query** (e.g. `convex/analytics.ts::compareVersions`):
takes two `agentVersionId`s, `requireOrgMembership` checks both agents' org,
pulls each version's runs (either live from `runs` for small windows, or
pre-aggregated from `daily_rollups` for larger windows — cycle-2 decides the
crossover point), builds two `RunSummary[]`, and calls `compareCohorts`. The
`CohortComparison` result is returned as-is; the UI renders
`failureRateSignificance` + `failureRateSignificanceExplanation` directly (the
explanation string is written to be UI-safe prose, not just a debug label).

**Proposed query API surface for Team E:**

```ts
// convex/analytics.ts (cycle 2)
query getRunStats({ orgId, agentId?, projectId?, startedAfter?, startedBefore? })
  -> RunStats  // from computeRunStats, computed over live runs or rollups

query getDailySeries({ orgId, agentId?, projectId?, days })
  -> DailyBucket[]  // from bucketByDay, sourced from daily_rollups once available

query compareVersions({ orgId, agentVersionIdA, agentVersionIdB })
  -> CohortComparison  // from compareCohorts

query getRunCost({ orgId, runId }) -> { totalCostUsd: number, matched: boolean, byModel: Array<{model: string, costUsd: number, matched: boolean}> }
```

## 3. Evals — attachment model and scheduler wiring

`convex/helpers/evals.ts` exports `EvalRule`, `evaluateRules(rules, run,
events)`, and the `LlmJudgeSpec` / `runLlmJudge` stub.

**Attachment model:** eval rules are defined **at the `AgentVersion` level**
(a `rules: EvalRule[]` field, or a separate `agent_version_eval_rules` table if
Team A prefers not to grow `agent_versions` documents — cycle-2 decision).
Defining rules per-version (not per-agent) is deliberate: an agent's tool list
or system prompt changing is exactly when eval criteria are most likely to
need to change too, and `AgentVersion` is already immutable-once-created
(CLAUDE.md Core Entities), so a version's rule set is a stable, auditable
snapshot.

**Auto-run on terminal event:** when `sdk_ingest.ts` (or `events.ts`
`createEvent`) writes a `run.completed` / `run.failed` / `run.cancelled`
event, it schedules an internal mutation (`ctx.scheduler.runAfter(0, ...)`,
matching the existing pattern used elsewhere in this codebase for
post-write side effects) that:

1. Loads the run's `AgentVersion` and its attached `EvalRule[]`.
2. Loads the run's events (bounded, same `MAX_EVENTS_PER_REPLAY`-style cap
   already used for replay projections).
3. Calls `evaluateRules(rules, runSummary, eventSummaries)`.
4. Writes ONE row into Team A's new `evals` table: `{runId, orgId,
   agentVersionId, overallPassed, results: RuleResult[], evaluatedAt}`.

This keeps the evals table itself append-style per run (a run's eval result is
written once, at terminal-event time) — consistent with the project's general
distaste for mutable derived state, though `evals` is explicitly a derived
projection table (like `verification_results`), not the event log itself, so
it is not bound by the events-table immutability rule.

**LLM judge:** `runLlmJudge` stays a `not_configured` stub until a live
deployment + API key exists. When wired, it plugs into the same terminal-event
scheduler path as an optional additional check per rule set, storing its
`LlmJudgeResult` alongside the rule-based results in the same `evals` row.

**Proposed API surface for Team E:**

```ts
// convex/agent_versions.ts or convex/evals.ts (cycle 2)
mutation setEvalRules({ orgId, agentVersionId, rules: EvalRule[] })
query getEvalRules({ orgId, agentVersionId }) -> EvalRule[]
query getRunEval({ orgId, runId }) -> { overallPassed, results: RuleResult[], evaluatedAt } | null
query listEvalResults({ orgId, agentVersionId, limit?, cursor? }) -> paginated evals for a version (pass-rate trend over time)
```

## 4. Open questions for cycle 2

- Where do rules live: inline on `agent_versions.rules` (simple, but grows an
  otherwise-small document) vs. a separate table keyed by `agentVersionId`
  (extra index, but keeps `agent_versions` lean and allows independent
  pagination of large rule sets). Leaning toward a separate table given the
  project's "every index must be justified by an actual access pattern" rule
  — `getEvalRules` is exactly that pattern.
- Rollup granularity: per (org, agent, date) is the plan above; per (org,
  agentVersion, date) may be more useful for the version-comparison query and
  should be decided before `daily_rollups`' schema is finalized (Team A).
  Team B's cohort-compare code is agnostic to which granularity is chosen —
  it just needs a `RunSummary[]` for each side.
- `bucketByDay`'s `tz` parameter is a **fixed UTC offset**, not an IANA
  timezone (no timezone database in a portable pure-function module). If
  per-org timezone preferences with DST matter, that conversion needs to
  happen in the query layer (which can use `Intl`) before/after calling into
  this helper, not inside it.
- Percentile bounded-sample contract (≤ ~5000 runs per `computeRunStats`
  call): the rollup cron must pre-chunk large days rather than pass an
  unbounded array through. Merge-of-partial-stats logic across chunks is not
  yet written.
- `compareCohorts`' two-proportion z-test is a standard large-sample
  approximation, explicitly not a rigorous statistical test (documented in
  the source). If this becomes customer-facing beyond an internal hint, it
  may be worth revisiting with a proper hypothesis-testing library.
