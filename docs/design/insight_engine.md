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

## 5. `getDashboardStats` same-day live fallback — cost, bound, and future work (cycle 5 / M5)

**The situation.** `computeDailyRollups` (Team A's cron, `convex/rollups.ts`)
runs once daily at 05:00 UTC and rolls up only the PRECEDING UTC calendar day.
That means "today" has zero `daily_rollups` coverage for the entire current
UTC day, always, for every org. `getDashboardStats` falls back to a live query
over `runs` for any date with zero rollup rows — in steady state that is
exactly one date per call: today. Already-rolled-up days are never re-scanned
live; the fallback is keyed off "this date has zero rows in the rollup map,"
not off "this date is recent."

**Why it's already about as cheap as it can be within this cycle's
boundaries.** The live fallback:
- Only ever fires for one date (today) in steady state — not a re-scan of
  the whole range.
- Is bounded: `.take(DASHBOARD_FALLBACK_MAX_RUNS)` (5,000), so a single call
  can never read more than 5,000 `runs` documents regardless of org size.
- Is indexed: `by_org_started` (org-wide) or `by_agent_started`
  (agent-scoped) — no table scan.
- Reads only the `runs` table (unlike `getAgentCostStats`'s fallback, which
  also reads events) — no N+1 read pattern.

**The actual cost being called out.** A Convex `query` has no cache to write
to across calls — every dashboard view (and every poll, if the UI polls)
independently re-runs this bounded scan. At high dashboard traffic on a large
org (hundreds of agents, many concurrent viewers), that is many independent
up-to-5,000-row scans of the same underlying "today" rows, once per view. The
per-call cost is bounded and cheap; the aggregate cost across a busy org's
viewers is the real concern, and it scales with viewer traffic, not with the
`range` parameter or org size directly.

**What this cycle did about it:**
1. Confirmed and documented (in `getDashboardStats`'s own doc comment) that
   the fallback already only touches today (or, for a brand-new org, a short
   pre-first-cron-tick backlog), never a re-scan of rolled-up history.
2. Added `todaySource: "rollup" | "fallback" | "no_data"` and
   `partialToday: boolean` to `DashboardStats` (top-level, not just on the
   per-day `series` point that already had `source`/`truncated`) so a caller
   can cheaply and honestly render "today's numbers are still live" without
   knowing the series-ordering convention.

**Recommendation for a future cycle (needs Team A — schema/cron owner):**
A real fix requires eliminating the live scan entirely for "today," which
means an incremental same-day rollup. Two concrete options, in order of
preference:
1. **Incremental upsert on terminal event.** When a run reaches a terminal
   status (`completed`/`failed`/`cancelled`/`timed_out`), have the same
   terminal-event path that already schedules `runEvalsForRun` also schedule
   an internal mutation that upserts (increments) TODAY's `daily_rollups` row
   for that `(orgId, agentId, date)` — turning `daily_rollups` from a
   once-daily batch write into an append/increment-friendly running total.
   `getDashboardStats` would then find a (continuously updating, but always
   present) rollup row for today and never take the live-scan branch at all.
   Requires: relaxing/re-purposing `daily_rollups` from "written once by the
   nightly cron" to "written once nightly AND incrementally intraday" (a
   behavior change to a table Team A owns, plus care that the nightly cron's
   overwrite-or-merge semantics don't clobber the day's incremental counts),
   and durability/ordering discipline on the incremented counters (e.g. an
   idempotency key so a scheduler retry doesn't double-count — same class of
   problem `runEvalsForRun` already solved for evals via its
   `createdBy === EVAL_SOURCE` idempotency check).
2. **Higher-frequency intraday cron** (e.g. hourly instead of once daily),
   rolling up "today so far" into a row keyed the same way, overwritten each
   tick. Simpler to reason about (still batch, not incremental-on-write) but
   less fresh (up to an hour of live-scan exposure right after each tick),
   and multiplies the existing cron's read cost by ~24x/day.
Both require a schema/cron change outside this file's ownership — this cycle
does not implement either, per the instruction that Team A owns schema. The
`todaySource`/`partialToday` fields added this cycle are forward-compatible
with option 1 or 2: once either lands, `todaySource` simply reports `"rollup"`
for today too, and `partialToday` becomes `false` in steady state, with no
API shape change needed on the caller side.

## 6. Pricing snapshot — cycle 5 review

`PRICING_LAST_UPDATED` is `"2026-01-15"`, roughly six months stale as of this
review — a reminder that this is a snapshot, not a live feed, and operators
should override it per the module's own top-of-file warning (env-configured
JSON blob merged over `PRICING_TABLE`, or a fork). The unmatched-model path
was re-verified to never fabricate: `resolveModelPricing` returns `undefined`
on no match (exact, then longest-key substring, then give up — no
nearest-neighbor guessing), and `estimateCostUsd` returns `{ costUsd: 0,
matched: false }` for that case rather than inventing a number.

Deliberately **not** added this cycle: newer-generation model ids (e.g. the
Claude generation this very session is running on, `claude-opus-4-6` /
`claude-sonnet-5`-style ids, and any GPT/Gemini ids released after
`PRICING_LAST_UPDATED`). This file's own rule is "never guess a price, mark
uncertain ones as unmatched" — without an operator-supplied, verified price
list for those ids, adding entries would mean fabricating numbers, which is
exactly what this module exists to avoid. Those model strings will correctly
surface as `unmatched`/`$0` with `matched: false` until an operator supplies
real pricing (via the documented override mechanism) or a future cycle adds
verified entries from a primary source.
