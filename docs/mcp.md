# MCP Server — `packages/mcp`

An MCP (Model Context Protocol) server that exposes Agent Flight Recorder's **read**
API to MCP clients: Claude Desktop, Claude Code, Cursor, or an agent investigating its
own recorded runs.

The premise is narrow and worth stating first. A failed agent run can be tens of
thousands of tokens of event log. An agent that answers "why did I fail?" by pulling
the whole trace into its context spends its budget on transport and has no room left
to think. This server exists so that the *usual* question costs a few hundred tokens
and the expensive answer is something you opt into, deliberately, once you know which
run and which sequence range you care about.

---

## Start here

```
afr_triage()
```

That is the whole answer for most callers. No arguments, ~332 tokens, and every item
it returns carries the exact next tool and argument object to call. If you read
nothing else on this page, call that.

**Ask the cheapest question first. Escalate only when the answer you got did not
settle it.** The tools are a ladder, not a menu, and the rungs are priced an order
of magnitude apart:

| Start here | Tool | Answers | Cost |
|---|---|---|---|
| **0** | **`afr_triage`** | **"What is wrong, and what do I look at first?"** | **~332 tokens** (~435 worst case) |
| 1 | `afr_list_failure_patterns` | "What is broken?" — *all* of it, beyond triage's top 5 | ~294 tokens (10 patterns) |
| 2 | `afr_get_pattern_evidence` | "Did the fix hold?" | ~423 tokens (one pattern, capped history) |
| 3 | `afr_explain_run` | "Why did *this run* fail?" | **~121 tokens** (one run) |
| 4 | `afr_get_run_events` | "Show me the literal events." | **~4,445 tokens** (one saturated 50-event window; ~8,707 with `includeProvenance`) |
| — | `afr_list_runs` | Orientation: which runs exist | ~475 tokens (20 runs) |

Read the last row of the ladder before you read anything else on this page. **One
tier-4 window costs about 13x a triage call, about 37x a tier-3 explanation, and
about 15x a tier-1 pattern list** — and a window is not the whole run, it is fifty
events of it. The tiers above it are not a warm-up you skip to get to the real data;
they are the reason the tier-4 call is affordable at all, because they tell you
*which fifty events* to ask for.

Most investigations should end at tier 3. Many should end at tier 0. Stop as soon as
the question is answered.

Where these numbers come from, what keeps them from drifting, and what they do not
cover, is in [Where the token figures come from](#where-the-token-figures-come-from).
They are measured by invoking the real registered tool handlers over contract-maximal
fixtures, and held there by a standing gate; they are **not** measured against a running
deployment, because none has ever existed.

### The worked example

Something is failing and you have no run id, no fingerprint, and no idea where to
look. That is the normal starting state. The path, with the running cost:

```
0. afr_triage()                                     ~332 tok   (running: ~332)
     → verdict "issues", complete true, scanned 50
     → items[0]: { class: "tool_error", label: "Tool call failed",
                   count: 128, signal: "regressed", score: 235,
                   next: { tool: "afr_get_pattern_evidence",
                           args: { fingerprintHash: "01f3a9…" } } }
     → you now know WHAT to look at and WHAT TO CALL NEXT. No inference.

1. …you do NOT call afr_list_failure_patterns here. Triage already read that
   endpoint. Reach for tier 1 only when you need breadth past the top 5.

2. afr_get_pattern_evidence(fingerprintHash: "01f3a9…")   ~423 tok  (running: ~755)
     → "resolved 6 days ago, 0 exposure since — unproven"
     → for "did last week's fix hold?", THIS IS THE END. Stop here.

3. afr_explain_run(runId)                            ~121 tok   (running: ~453)
     → root cause in prose + citedSequenceNumbers: [12, 14, 17]
     → for "why did this run fail?", THIS IS THE END. Stop here.
       (Reached directly from triage when an item's `next` points at a run —
        ~332 + ~121, not ~755.)

4. afr_get_run_events(runId, from: 12, limit: 10)   ≤4,445 tok  (running: ≤4,898)
     → the literal event records, only around the numbers tier 3 cited
```

Triage plus an explanation — enough to name the worst thing in the org *and* explain
a concrete instance of it — costs about **453 tokens**. That is roughly a tenth of
one tier-4 window.

**The naive path, for contrast.** An agent that skips the ladder and opens with
`afr_get_run_events` pays up to **~4,445 tokens** for a fifty-event window and gets
back… fifty event records. No root cause, no fingerprint, no verdict on whether this
is new or the thing that has been failing all week. It has spent roughly 13x the cost
of `afr_triage()` to buy the raw material for an answer rather than the answer, and it
now has to reason about the failure inside whatever context budget is left. Worse, it
had to *choose a run id* before it could make the call at all — which is the one thing
it did not know. If it guessed wrong, it pays again.

That is the mistake this server exists to make unattractive. Raw events are for
**confirmation** — you have a hypothesis and a sequence number and you want to see
the literal record. They are not for discovery.

### If you only want a CI gate

An agent-driven investigation is not the only caller. For "fail the build if a
supposedly-fixed failure came back", the shell answer is **`afr triage`** — the same
ranking as tier 0, mapped onto exit codes `0` (clear) / `10` (findings) / `11`
(inconclusive). See [Using this as a CI gate](#using-this-as-a-ci-gate), which covers
the exit-code and truncation semantics — **including the case where a scan could not be
completed, which must never be reported as "all clear."**

---

> ## :warning: Verification status of this document
>
> This page documents the tool contract, the transport, and the endpoints behind
> them. It has **not** been executed end to end, and cannot be yet: no Convex
> deployment has ever existed for this project and the application has never been
> deployed to any environment (same caveat as `docs/operations_runbook.md`).
>
> **Verified by reading the code on this branch:**
> - Every `/api/v1/**` route listed in the tool table exists, is `GET`-only, is
>   authenticated with `x-api-key`, and requires the `read` scope
>   (`apps/web/app/api/v1/**`, `convex/read_api.ts`).
> - The query parameters, the response envelope, the per-key rate class
>   (300 req/min), and the error codes described below match those routes.
> - **Every token figure on this page**, re-measured by actually running
>   `pnpm build && pnpm tsx scripts/check-token-budgets.ts` on this tree and
>   transcribing its report. Three figures the previous revision published were stale
>   and are corrected here: tier 0 typical (333 → **332**), tier 1 (284 → **294**), and
>   tier 4 externalized (3,838 → **3,844**). Two others (`afr_list_runs` **475**, tier 4
>   inline **3,390**) are confirmed unchanged.
> - **Re-measured again after OTel provenance landed** (ADR-007): every event a
>   derived run returns now carries a compact `derived`/`derivedLossy` marker, which
>   moved both tier-4 rows by +601 (externalized **3,844 → 4,445**, inline
>   **3,390 → 3,991**) and added a fourth tier-4 row for the opt-in full-record path
>   (`includeProvenance: true`, **8,717** at its lower `MAX_LIMIT_WITH_PROVENANCE`
>   of 40). Native-only windows pay none of this. No other figure moved.
> - **Re-measured a third time after the fixtures were made contract-maximal again**
>   (contracts 0.11.0 → 0.14.0). ADR-007 added four fields to `Run`
>   (`otelTraceId`, `otelRoot`, `otelRootStartNano`, `otelLastAppendAt`) and one to
>   `Event` (`temporalOrder`); the shared fixtures did not populate them, so
>   `FIXTURE_NOT_MAXIMAL` fired and every budget on this page had been measured
>   against a payload smaller than the contract permits. They are populated now.
>   **No measured figure moved** — `toRunRow` and `toEventRow` build their rows by
>   explicit assignment, never by spread, so the five new fields are dropped at the
>   projection rather than paid for. The two `afr_list_runs` *ratios* moved, because
>   the un-projected input got fatter while the row did not: **58.8x → 62.6x** and
>   **62.0x → 66.1x**. `scripts/token-budget-baseline.json` is byte-identical.
>   ADR-007 landed on `Run` in four separate waves during this cycle — the
>   `otel*` block, then `otelMaxInstantNano`, then `derivedEventCount` /
>   `otelUnkeyedDerivedCount` — and `FIXTURE_NOT_MAXIMAL` caught every one within
>   minutes. **Not one of them moved a token count**, because `toRunRow` builds
>   its row by explicit assignment; all seven fields are dropped at the
>   projection. The ratios above are the only visible trace, which is exactly why
>   they are checked (`DOC_FIGURE_STALE`) rather than transcribed by hand.
> - **Two deliberate movements, both landing in the same diff as the numbers above.**
>   (a) Tier 4 gained an `orderingBasis` field — see
>   [Ordering on a derived run](#ordering-on-a-derived-run). Measured at exactly
>   **+9 tokens**, and only when it fires: **4,445 → 4,454** on an otherwise
>   identical window. Every other scenario is unchanged, because the field is
>   absent unless proven. (b) The fixture family's `spanId` was 17 characters
>   where a W3C span id is 16 — safe in direction (a maximal fixture that
>   over-states cannot under-state a budget) but wrong, and this family's claim is
>   that it is contract-maximal and *provably* so. Corrected, which moved the one
>   scenario that emits a span id: `includeProvenance` **8,717 → 8,707** (1 byte ×
>   40 events).
> - The enforcement described in
>   [What keeps these numbers true](#what-keeps-these-numbers-true): the script and
>   `scripts/token-budget-baseline.json` exist and run; the `mcp_*` suites plus
>   `token_budget_guard.test.ts` pass (205 tests across 9 files) under
>   `npx vitest run` in `tests/`; `createServer` registers exactly eight tools and
>   the script enumerates them from that registry.
> - **Re-measured a fourth time when the version-divergence pair landed (ADR-008).**
>   `afr_assess_version` and `afr_get_run_divergence` are registered, budgeted
>   (**1,300** and **1,700**), baselined, and measured at **1,233** / **83** and
>   **1,562** / **119**. **No pre-existing figure moved** — the two tools add
>   projections and touch none of the existing ones. Their ceilings are the two
>   largest on this page after tier 4's, and the derivation is written into their
>   scenarios in `scripts/check-token-budgets.ts`: three disjoint finding classes
>   cost roughly three times a single-envelope tier, and a merged single list would
>   have fit under 450. The measured cost of *not* merging them is the number to
>   quote at anyone proposing that it be merged.
>
> **Unverified — treat as design intent, not measurement:**
> - **Token cost against real data.** The figures above are measured against
>   *fixtures*, not traffic. Tier 4 in particular is a function of your own event
>   payloads. The ordering of the tiers is robust; the absolute numbers are
>   representative, not a promise.
> - The MCP client configuration blocks. The handshake has not been run against a
>   real client, and the executable name/entry path comes from the package layout,
>   not from a successful launch.
> - Anything about live latency, wire bytes, or real-world response sizes.
>
> **Changed since the previous revision of this page — re-verified at `600b4f8`:**
> - **`afr triage` (the CLI command) now exists**, and the claim that it did not is
>   removed. `packages/cli/src/commands/triage.ts` implements it and
>   `packages/cli/src/index.ts` registers the subcommand, with CI-gate exit codes
>   `0`/`10`/`11`. See [Using this as a CI gate](#using-this-as-a-ci-gate).
> - **The ranking moved out of `packages/mcp`.** `toTriageResult` and every weight
>   now live in `packages/sdk/src/triage.ts`; `packages/mcp/src/triage.ts` is a pure
>   re-export, and `packages/cli` imports the same function. There is one
>   implementation, so the CLI and the MCP tool cannot rank differently.
>
> **Since resolved — the caveats this section used to carry are gone:**
> - `scripts/check-token-budgets.ts` and `scripts/check-build-integrity.ts` are both in
>   `scripts/validate.sh` **and** in the `build` job of `.github/workflows/ci.yml` (they
>   run there because they need that job's artifacts). Nothing about these numbers is
>   enforced by hand any more.
> - `afr_explain_run`'s contract-maximal scenario is **no longer over budget**: the
>   citation array is now byte-capped the way the prose fields are, and it measures
>   **198** for any citation count at any sequence-number width. The `knownBreach` entry
>   was deleted with the fix.
>
> **Freshness.** Verified against the working tree at commit `600b4f8` **plus
> uncommitted changes**: `scripts/check-token-budgets.ts`,
> `scripts/check-build-integrity.ts`, `scripts/token-budget-baseline.json` and
> `tests/unit/mcp_budgets.ts` were untracked, and
> `tests/unit/mcp_progressive_disclosure.test.ts` was modified, at the time of writing —
> all three landed *while this page was being revised*. SDK 0.17.0, CLI 0.11.0,
> `packages/mcp` 0.1.0. The previous revision was written at `2695655` against a similar
> moving tree, which is how three token figures went stale. Multiple agents land code in
> parallel on this branch. **Re-run the script and re-check `git log` before trusting a
> specific number or a specific "does not yet" claim.**
>
> The two `/api/v1/patterns**` endpoints behind tiers 1 and 2 are **now documented
> in `docs/api_reference.md`** (§1), which is their canonical HTTP contract —
> query params, response shapes, the `fixConfidence` envelope, and the
> bounded-overfetch-then-filter scan a client has to page around. This page covers
> only what an MCP caller needs; prefer the API reference for the wire detail.
>
> **Server-side field projection (`?fields=`) landed while this page was being written**
> and is read from the working tree, not from a design document. See
> [Server-side field projection](#server-side-field-projection) for what it does and does
> not buy an MCP caller — the short version is that it saves bandwidth, not context.

---

## What it is for

Three callers, one shape:

- **A human in an MCP client** asking "what's broken in production this week?" without
  leaving their editor.
- **An agent debugging itself** — reading its own run's explanation after a failure,
  or checking whether the failure it just hit is a known recurring pattern.
- **A triage loop** that polls for spiking patterns and checks whether last week's
  claimed fixes actually held.

All three want the same thing: the smallest amount of trace that answers the question.

## What it is *not* for

It is a **read surface only**. It exposes no tool that writes. There is no event
ingestion, no run creation, no triage or status transition, no acknowledge/resolve/
reopen, no alert or webhook configuration. Those actions are member- or admin-gated,
Clerk-authenticated, and audited (`audit_log.actorClerkUserId` exists precisely to
record *which person* made a privileged change). An API key has no human actor behind
it, and an MCP tool call has no human in the loop at all — so this surface can reflect
lifecycle state, and can never assert it.

**In particular, the policy pre-flight does not belong here.**
[`docs/adr/009`](adr/009-policy-engine.md) authorises a declarative policy engine
with two halves: reading policy findings (a read, and legitimate on this surface
under the ordinary rules once the routes exist) and an advisory pre-flight the SDK
asks before acting. The second requires a key with **`ingest:write`** — a pre-write
check belongs to the write path, the same reasoning that put
`convex/budget_gate.ts` behind `ingest:write` rather than `read` — and this package
must never hold such a key. The pre-flight is a `packages/sdk` seam, like
`BudgetGuard`. That it *reads* rather than mutates is not sufficient warrant: the
scope it needs is the disqualifying fact. No read surface for either half exists
yet — only the engine's pure fold — so nothing is buildable here today; this is
recorded now because "it's only a query" is the argument that would otherwise land
the pre-flight here the moment a route appears.

It also does not talk to Convex directly. It holds no deploy key and no Clerk session.
It reaches the product over the public `/api/v1/**` HTTP API with an API key, exactly
like the `afr` CLI, and inherits that door's org scoping and rate limits. See
`CLAUDE.md` → System Boundaries for the binding version of these constraints.

---

## Progressive disclosure — the whole point

The ladder, the measured costs, and the worked example are at the top of this page:
[Start here](#start-here). This section is the *why* behind those numbers.

Each rung hands you the selector for the next one. Tier 1 returns representative run
IDs. Tier 3 returns *real* sequence numbers cited from the run's own event log — every
cited number is guaranteed to correspond to an event the same key can fetch at tier 4,
so there is no such thing as a citation pointing at a fabricated event. That guarantee
is what makes the windowed tier-4 call viable: you fetch ten events, not two thousand.

### Where the token figures come from

Every number on this page is a **client-visible token estimate** — the size of the exact
`text` an MCP client receives. It is produced by `scripts/check-token-budgets.ts`, which
calls `createServer()`, enumerates the tools from **the server's own registry**, and
invokes each registered handler against a stub reader and a contract-maximal fixture. Not
the projection in isolation: a tool that wraps a lean projection in a fat envelope is
over budget, and only the handler's own output shows that.

The estimator:

```
estimateTokens(x) = ceil(utf8ByteLength(JSON.stringify(x)) / 4)
```

Bytes/4 is the standard rough BPE approximation. It matches what the server actually
emits — `packages/mcp/src/tools/shared.ts` serializes with `JSON.stringify(value)` and
no indentation — so these are the bytes a caller pays for. It is an estimate, not a
tokenizer, and it is monotonic in payload size, which is the property a ratchet needs.

**Run it yourself:** `pnpm build && pnpm tsx scripts/check-token-budgets.ts`. The build
is required — the script imports `packages/mcp/src/**` as source, and that source
resolves `@agent-flight-recorder/sdk` and `/contracts` to their `dist/`.

| Tool / scenario | Measured | Budget | Fixture |
|---|---|---|---|
| `afr_triage` typical | **332** | 450 | a full 50-pattern scan of maximal `FailurePattern`s, nothing degraded |
| `afr_triage` worst case | **435** | 450 | truncated scan + unevaluated + every item muted |
| `afr_triage` `verdict: "clear"` | **32** | 450 | an org with nothing to report |
| `afr_list_failure_patterns`, 10 | **294** | 300 | 10 maximal rollups — the published tier-1 figure (15.0x unprojected) |
| `afr_list_failure_patterns`, 20 | **561** | 600 | a default page (15.9x) |
| `afr_list_failure_patterns`, 100 | **2,681** | 2,800 | a saturated page at `MAX_LIMIT` (16.8x) |
| `afr_get_pattern_evidence` | **423** | 450 | one pattern, 100 inbound lifecycle transitions, capped to 10 (34.8x) |
| `afr_explain_run` realistic | **121** | 200 | a realistic `RunExplanation` |
| `afr_explain_run` contract-maximal | **198** | 200 | 2 KB summary + 1 KB root cause + 1 KB fix |
| `afr_explain_run` 20 six-digit citations | **198** | 200 | the same explanation on a 100k-event run — what makes `CITED_SEQUENCE_BYTE_CAP`'s "any count, any width" claim falsifiable |
| `afr_explain_run` pending | **24** | 200 | no explanation generated yet |
| `afr_get_run_events` externalized | **4,445** | 10,000 | a saturated 50-event window, every payload externalized, every event OTel-derived and carrying a `temporalOrder` key (3.1x) |
| `afr_get_run_events` inline | **3,991** | 10,000 | a saturated 50-event window of 10,040-byte inline payloads, just under the externalization threshold (34.3x) |
| `afr_get_run_events` + `includeProvenance` | **8,707** | 10,000 | 40 fully-derived events at `MAX_LIMIT_WITH_PROVENANCE` — the full `OtelEventProvenance` record per event, not the compact marker (1.3x) |
| `afr_get_run_events` ordering unverifiable | **4,454** | 10,000 | the same externalized window with no `temporalOrder` on any event — the `orderingBasis` alarm firing, and the pair that measures its cost (2.6x) |
| `afr_list_runs`, 20 | **475** | 600 | a default page of maximal `Run` documents, ADR-007 `otel*` block included (62.6x) |
| `afr_list_runs`, 100 | **2,250** | 2,800 | a saturated page at `MAX_LIMIT` (66.1x) |
| `afr_assess_version` fleet | **1,233** | 1,300 | 12 proven + 12 speculative + 12 indeterminate reasons over a truncated 10,000-run scan, capped to 4 per kind |
| `afr_assess_version` clean | **83** | 1,300 | nothing proven, scan complete — the closest this tool comes to a green light |
| `afr_get_run_divergence` full | **1,562** | 1,700 | 8 + 8 + 8 findings on one run, coverage incomplete, capped to 3 per kind |
| `afr_get_run_divergence` clean | **119** | 1,700 | nothing found and the analysis complete — pays for the full per-dimension roll-up, which is what makes a clean answer readable |

The ratios in the fixture column are **commentary**. Nothing passes on one — every
budget is an absolute integer, because a ratio against a fat fixture gets easier as the
fixture gets fatter, which is not the property under test.

> ⚠ **`afr_explain_run`'s contract-maximal scenario used to be over budget: 203 against
> 200.** It is not any more, and the history is worth keeping because the fix is not the
> obvious one.
>
> The cause was that `toExplainRunResult` capped the three prose fields and forwarded
> `citedSequenceNumbers` **verbatim**. The long-published "192 worst case" was measured
> against an explanation citing five sequence numbers; `RunExplanation` documents the
> bound as ≤ 20. Measured: 5 citations → 192, 10 → 196, 15 → 200, 20 → **204**. So this
> tier was under budget only because real explanations happen to cite few events — a
> property of the generator, not a guarantee of this layer.
>
> **The fix caps BYTES, not citations.** Capping the array at ten would have been the
> same cheap-by-luck bound one level down: a sequence number's *width* grows with run
> length (Event Log Rule 4 numbers events from 1 per run), so ten six-digit citations on
> a 100k-event run cost what twenty four-digit ones do. The byte cap holds **198** for
> any count and any width, and `scripts/check-token-budgets.ts` carries a dedicated
> 20-six-digit-citation scenario so that claim is falsifiable rather than asserted.
> The 200 was never raised.

### What keeps these numbers true

Three layers, and they are not redundant:

| Layer | What it does |
|---|---|
| `scripts/check-token-budgets.ts` | the standing gate. Enumerates tools from `createServer()`'s registry, measures 21 scenarios through the registered handlers, asserts absolutes, and ratchets `scripts/token-budget-baseline.json` |
| `tests/unit/mcp_budgets.ts` | the single declaration of every budget, of the estimator, **and of the contract-maximal fixture family** — all imported by every mcp suite. `450` used to appear in three files and `300` in two, only one of each carrying the derivation; `fatPattern` appeared in four, and the copies measured 284 where the script measured 294 for the same tool on the same scenario. The suites now import all three from here, so `FIXTURE_DUPLICATION` reports clean |
| `tests/unit/mcp_progressive_disclosure.test.ts`, `mcp_triage.test.ts`, `mcp_triage_measure.test.ts`, `mcp_triage_next_hops.test.ts` | projection-level budgets plus the shape guards — a projection that starts emitting a field it is not allowed to fails here even when the byte count would still fit |

Everything drives the real exported code — not a copy, not a snapshot — over fixtures
that are **proved** maximal, not claimed to be: the script parses the contracts source
with the TypeScript AST and fails (`FIXTURE_NOT_MAXIMAL`) if any declared property of
`FailurePattern`, `Run`, `Event`, `RunExplanation` or the evidence envelope is left
unpopulated. A budget measured against a fixture missing half the optional fields is a
budget measured against a payload the system cannot produce.

**The three things the script does that the suites could not:**

1. **A new tool cannot ship unbudgeted.** The tool list comes from the server's registry,
   so a registered tool with no declared budget fails as `NO_BUDGET`, and a budget for a
   tool no longer registered fails as `STALE_BUDGET`.
2. **Tier 4's ceiling is an absolute.** It used to be `RAW_DUMP_TOKENS / 10` — a ceiling
   that rose whenever someone raised the assumed raw-dump size. It is written as
   `10_000` now.
3. **The whole picture is in one place.** The figures on this page used to be re-derived
   by hand from several suites' stdout, so nobody could see the picture drift.

**The ratchet, and the obligation it puts on you.** `scripts/token-budget-baseline.json`
records where every scenario actually is:

- `measured > budget` → **fail**: the published ceiling was breached. Cut the response.
- `measured > baseline` → **fail**, separately: still under the ceiling, but above where
  we were. Silent drift inside the headroom is how a ceiling gets reached. A deliberate
  increase is recorded with `--write-baseline` and lands as a reviewable diff **in the
  same commit**.
- `measured < baseline` → **pass**, and it prints the delta telling you to lower the
  baseline in the same commit. Failing CI on the commit that improves things is how
  ratchets get deleted; a stale-high baseline cannot hide, because the delta prints on
  every run.

`--write-baseline` refuses to record any value above its own budget: a baseline may
record where we are, never bless a breached ceiling.

A **pre-existing** breach — one the guard found rather than one someone introduced — is
recorded as a `knownBreach` with its owner and its fix written out, reports as
`FROZEN_BREACH`, and does not block. It is debt with a receipt, not an exemption: the
frozen number may only fall, and the guard fails if the entry outlives the breach.

**Where this is not yet closed.** The script is in neither `scripts/validate.sh` nor
`.github/workflows/ci.yml`, so nothing runs it automatically — it is a command someone
has to remember. (`scripts/check-build-integrity.ts` *is* in `validate.sh`, as
`build-integrity` after `build`; it is not in CI either.) Separately, the script declares
its budgets inline rather than importing `tests/unit/mcp_budgets.ts`; the two agree today
(450/300/200/10,000) but they are still two copies, which `mcp_budgets.ts`'s own header
flags as the remaining consolidation step.

**A one-token difference you will notice.** `mcp_triage_measure.test.ts` prints 331 for
the typical triage response; the script measures 332. Both are correct and neither is
drift — the suite measures `toTriageResult`'s output, the script measures the tool
result an MCP client receives. Where they differ, **this page quotes the script**,
because that is what the agent actually pays.

**What these numbers are not.** They are not measured against a deployment; none has
ever existed for this project. They are not wire bytes (see
[Server-side field projection](#server-side-field-projection) — that section is about a
different quantity entirely, and the two must not be conflated). Tier 4's real cost
depends on your own event payloads; the two tier-4 rows above are the worst cases the
system can *legally* produce, which is why the tier-4 figure quoted at the top of the
page is a ceiling rather than a typical value.

**Tier 0's budget is derived, not chosen.** 450 is tier 2's budget, and the argument for
the tool's existence is that it must cost less than the ~707 tokens of calling tiers 1
and 2 yourself — otherwise it is a fifth tier pretending to be a shortcut.
`tests/unit/mcp_triage.test.ts` asserts both: the absolute ceiling, and that a triage
response is strictly cheaper than tier 1 + tier 2. The worst case measures **435**
against a fully saturated, maximally caveated response — 97% of the ceiling, about 15
tokens of headroom, well under half a triage item. Widening an item will go red almost
immediately, which is the intended behaviour.

**The ratios are the durable part.** ~4,445 vs ~121 is ~37x; vs ~294 it is ~15x; vs
~332 it is ~13x. Those gaps are structural — they follow from what each tier returns,
not from the fixtures — and they are the reason to work down the ladder rather than up
it.

### Why the tiers cost what they do

- **Tier 1** returns compact rollup rows — fingerprint, class, label, count, first/last
  seen, status, spike verdict. No event bodies, no narratives.
- **Tier 2** returns one pattern's resolution claim plus the evidence grading it:
  post-resolution run exposure, the fix-confidence verdict
  (`unproven` / `proving` / `confirmed` / `regressed`) with its drivers, and the
  lifecycle transition history reconstructed from the append-only audit log.
- **Tier 3** returns a summary, a root cause, an optional suggested fix, a failure
  class, and a short array of cited sequence numbers. It is a *narrative*, deliberately
  bounded — it is cheaper than tier 1 because it describes exactly one run.
- **Tier 4** returns actual event records. Its cost scales with your payloads, which is
  why it is windowed and why payloads over 10 KB were never stored inline in the first
  place (Event Log Rule 3) — those events carry an **artifact pointer** (blob URL +
  SHA-256 checksum), and this server returns the pointer, never the blob. If you need
  the bytes, fetch the artifact yourself, outside the model's context if you can.

---

## Using this as a CI gate

The ladder above is written for an agent or a human investigating a failure. A second
caller wants something narrower: **"fail the build if a failure we claimed to have
fixed came back."**

Two surfaces answer that. `afr_triage()` reports a `regressed` signal on any item it
ranks — and ranks it first, above everything. `afr_list_failure_patterns(state:
"regressed")` (or `afr patterns --state regressed` from the CLI) asks the question
directly, with no top-5 cap.

**From a shell, prefer `afr triage`.** It is the same ranking (same SDK function, same
scores, same next-hop pointers) and it maps the verdict straight onto an exit code, so
a build fails without anyone having to remember a `jq -e`:

| Code | Verdict | Meaning |
|---|---|---|
| `0` | `clear` | the scan completed and found nothing |
| `10` | `issues` | ranked items were found |
| `11` | `unknown` | nothing was found **and** the view was incomplete — not evidence of health |
| `1` / `2` / `3` / `4` | — | usage / auth / not-found / network-or-server |

`10` wins over `11` when both apply: findings are actionable, and the incompleteness is
stated in the output and in `--json`'s `complete` field. **Exit `0` is unreachable on an
incomplete scan** — not by convention in the command, but because `verdict: "clear"` is
only ever constructed when every honesty check passed, which is why the gate cannot be
weakened later without changing the verdict itself. Read
`packages/cli/src/commands/triage.ts` (`TRIAGE_HELP`, `exitCodeForTriage`) for the
binding version.

Prefer `state: "regressed"` over `regressed: true`. `regressed: true` matches any
pattern with `regressedAt` set, including one that regressed, was genuinely re-fixed,
and was re-resolved — `regressedAt` is retained as history. `state: "regressed"`
matches only a recurrence strictly after the *current* `resolvedAt`, and it keeps an
exact, snapshot-independent path in `convex/read_api.ts`, so it does not depend on the
fix-confidence refresh cron having run.

### Reading `afr_triage` as a gate

`afr_triage()` is honest about incompleteness, and a gate must use that rather than
just counting items:

- **`verdict: "clear"` is the only safe green.** It means the scan completed and found
  nothing.
- **`verdict: "unknown"` is not green.** It means there was nothing to show *and*
  something prevented a whole look. Exiting 0 on it reports "your agents are healthy"
  when the truth is "I failed to look."
- **`complete: false` qualifies any verdict, including `issues`.** It means the ranked
  items are the worst of what was *scanned*, not the worst that exist. `caveats[]` says
  exactly why in plain sentences, and `next` points at the tier-1 call that gets the
  rest.
- **Triage ranks at most 5 of at most 50.** It is a headline, not an inventory. A gate
  that must not miss a regression anywhere in the org should use
  `afr_list_failure_patterns(state: "regressed")` and page it, not triage.

**Two independent incompleteness signals, and triage reports both.** They are not the
same failure and neither subsumes the other:

| Signal | Source | Means |
|---|---|---|
| `nextCursor` present | triage's own `SCAN_LIMIT` | The *ranking's* window was not whole. More patterns exist than the 50 that were ranked, so "these are the worst" is really "the worst of the 50 I looked at". The server scan was fine. |
| `scanTruncated: true` | the server's row ceiling | The *server* could not finish scanning even that window. A short or empty page can be an artefact of the ceiling, so empty `items` is not evidence of health at all. |

The second is strictly worse, so it is the one the caveat names when both fire (a
server-side ceiling always also yields a resumable cursor, so "both" is the normal
truncation case). `scanTruncated` is surfaced as its own top-level field on the triage
result; the cursor is surfaced through `next`.

Only the server marker is a statement about correctness. A `nextCursor` on its own means
the ranking is a headline, which is what triage is *for* — so `complete: false` from a
cursor alone is not evidence that anything was missed, while `scanTruncated: true` is.

Prefer `state: "regressed"` over `regressed: true`. `regressed: true` matches any
pattern with `regressedAt` set, including one that regressed, was genuinely re-fixed,
and was re-resolved — `regressedAt` is retained as history. `state: "regressed"`
matches only a recurrence strictly after the *current* `resolvedAt`, and it keeps an
exact, snapshot-independent path in `convex/read_api.ts`, so it does not depend on the
fix-confidence refresh cron having run.

### An unfinished scan is not a clean scan

This is the part that decides whether a gate is worth having.

Every filter on `GET /api/v1/patterns` — `agentId`, `spiking`, `muted`, `status`,
`regressed`, `state` — reads a field with **no index**, so all of them run in memory.
The endpoint therefore reads a scan window wider than the page and filters inside it,
bounded by `PATTERN_SCAN_ROW_CEILING` (**2,000** rows, `convex/read_api.ts`).

A scan that stops on that ceiling returns a short — possibly **empty** — page. On the
wire, an empty page because *nothing matched* and an empty page because *the scan ran
out of budget* are the same three bytes. **A CI gate that cannot tell them apart exits
0 on a scan it never completed, and a red build goes green.** That is worse than having
no gate, because a team stops looking.

So the backend declares it. `apiListFailurePatterns` returns, alongside `patterns` and
`nextCursor`:

| Field | Meaning |
|---|---|
| `scanTruncated` | `true` — the scan stopped on the row ceiling, not on the end of the table. This page **may** be short or empty purely for that reason. `false` — the page is the complete answer up to `limit`; an empty page really does mean nothing matched, anywhere. |
| `scannedRows` | Rows examined to produce this page. |
| `scanRowCeiling` | The ceiling that bounded it (2,000). |

The rule for a gate: **`scanTruncated: true` means "not yet answered", never
"clean".** Follow `nextCursor` until you get a page with `scanTruncated: false`, or
fail the gate as inconclusive. Never map it to exit 0.

`scanTruncated: false` is the assertion a gate is entitled to make.

> **Verified, and a gap you must know about before you build on it.**
>
> Verified by reading the code on this branch:
> - `convex/read_api.ts` computes `scanTruncated = !exhausted && matches.length < needed`
>   and returns it with `scannedRows` and `scanRowCeiling`. Exhaustion is checked first,
>   so a scan that reached the end of the table is never reported as truncated, and a
>   page that filled is never reported as truncated either.
> - `apps/web/app/api/v1/patterns/route.ts` forwards the backend result into the
>   envelope wholesale, and `packages/sdk/src/v1-client.ts` returns `envelope.data`
>   verbatim — so the field does reach a client at runtime.
> - `convex/read_api.test.ts` asserts both directions of the flag; the structural guard
>   is `tests/unit/pattern_pagination_contract.test.ts`.
>
**It is wired end to end.** Verified by reading the working tree at the moment this was
written (SDK 0.16.0, CLI 0.10.0), while three teams were still pushing:

- `packages/sdk/src/reader.ts` declares `scanTruncated?`, `scannedRows?` and
  `scanRowCeiling?` on `V1ListFailurePatternsData`, and exports
  **`isPatternScanComplete(data)`** as the single place that decides what an *absent*
  marker means. All three are optional because a deployment predating the marker never
  sends them.
- **`afr patterns` reads it** and maps a truncated scan onto exit `11`
  ([below](#the-clis-exit-codes)), with distinct renderings for the empty and non-empty
  cases.
- **MCP tier 1 forwards it.** `toListPatternsResult` takes an optional fourth `scan`
  argument and sets `scanTruncated: true` on the tool result;
  `packages/mcp/src/tools/list-failure-patterns.ts` passes `data`.
- **`afr_triage` reports it too**, and keeps it *separate* from its own window limit —
  see [Reading `afr_triage` as a gate](#reading-afr_triage-as-a-gate).

### Absent is treated as complete, on purpose

`isPatternScanComplete` returns `true` for both `false` and `undefined`, so a deployment
that never declares truncation reads as complete. That looks wrong until you know why:
treating absence as incomplete would make every request against an older deployment
*permanently* inconclusive, which turns a gate into noise and gets it switched off —
reaching the same end state as the bug the marker exists to fix, by a longer road.
Treating it as complete restores exactly the behaviour those deployments already had.

The honest reading of absence is "this deployment does not answer the question." If you
need to distinguish that from a positive "the scan finished", test
`data.scanTruncated === undefined` yourself. **Do not re-derive the collapse in a fourth
place** — the SDK, the CLI, tier 1 and triage all call the helper rather than reimplement
it, which is the point of it existing.

### The SDK does not throw on truncation

Deliberately, and the asymmetry is worth understanding. `getRunEventWindow` throws on an
ignored `fromSequence`, and `assertProjectionHonored` throws on an ignored `fields`,
because in both cases **the server returned a wrong answer indistinguishable from a right
one**: the head of the log looks exactly like the requested window, and a full document
looks exactly like a projection that included everything. Nothing in the response says
otherwise, so refusing is the only way the caller finds out.

Truncation is the inverse. The server **told the truth, in a field**, and the only defect
was that nothing read it. Throwing would also break the correct remedy — paging on
`nextCursor` — by turning a resumable, ordinary state into an exception, and would fail
an unfiltered browse where truncation is harmless.

So the SDK types it, names it, and hands it to the caller. **Deciding that an incomplete
scan is fatal is the gate's job, not the client's.** `afr patterns` makes exactly that
decision, with exit 11, for the CI path.

### The CLI's exit codes

`afr patterns` is the surface where the truncation contract becomes a build outcome:

| Code | Meaning |
|---|---|
| `0` | Request succeeded and the scan was complete — **whether or not anything matched** |
| `1` / `2` / `3` / `4` | Usage / auth / not-found / network-or-server error |
| `11` | **"Could not evaluate."** A *filtered* request whose scan hit the server's row ceiling |

Exit `11` exists because **exit 0 from a gate is a claim** — "I checked, and it is
clean" — and a truncated scan has not checked. The result is annotated
`[scan truncated N/M rows]`, the page the server did return is still printed in full,
and the command exits `11` instead of `0`. Page with `nextCursor` until the scan
completes, or treat the run as inconclusive.

The rendering distinguishes the two truncated cases, because they mean different things:

- **Empty and truncated** no longer prints "No recurring failure patterns found." That
  sentence is a whole-dataset claim and it is false after a truncated scan. It instead
  reports what was actually established — no matches *in the rows scanned* — and says
  plainly that this is **not** "none exist", since nothing is known past the ceiling.
- **Non-empty and truncated** prints the full table, then a `PARTIAL
  [scan truncated N/M rows]` footnote in the existing bracket idiom: these rows are
  real, but they are not the complete set.

Withheld for unfiltered listings, deliberately: an unfiltered request does not truncate
(`scanSize = filtering ? PATTERN_SCAN_ROW_CEILING : needed`), and "here are some
patterns" makes no whole-dataset claim to falsify. The annotation still prints.

> **On `afr patterns`, exit `11` distinguishes inconclusive from conclusive — not clean
> from dirty.** This command has no "matches found" exit code: `afr patterns --state
> regressed` exits `0` whether it found a regression or not, so a gate built on it must
> parse `--json` and fail on a non-empty `patterns` array itself. What it no longer has
> to do is guess whether an empty array meant anything.
>
> **`afr triage` is the command that closed that gap**, with exit `10` for findings —
> which is why it is the better default for a shell gate. Reach for `afr patterns
> --state regressed` when you need breadth past triage's top 5 and are willing to page.
>
> The `@returns` comment on `main()` in `packages/cli/src/index.ts:109` still lists only
> `0/1/2/3/4` and has been updated for neither `11` nor `10`. Both codes are real
> (`packages/cli/src/commands/patterns.ts`, `packages/cli/src/commands/triage.ts`); the
> doc comment is stale. Verified at `600b4f8`.

---

## Server-side field projection

> **Status: landed across all four layers.** Read from the working tree, not from a design
> document, and — like everything else on this page — **never executed**.
> `convex/read_api.ts` accepts a `fields` argument on all five read functions; all five
> document-returning HTTP routes parse `?fields=`; `FlightReader` sends it and verifies it
> was honored; this server derives its field lists from its column tables and degrades
> gracefully when a deployment cannot project. Full contract: `docs/api_reference.md` §1
> ("Field projection — `?fields=`").

The change is that the v1 API returns a narrowed record (`?fields=a,b,c`) instead of the
whole document, and this server asks for only the fields it uses.

**Be clear about where the win is, because it is easy to overstate.**

### It does not meaningfully reduce what the agent sees

`packages/mcp/src/projections.ts` **already** discards these fields, client-side, before
anything reaches a tool result. That file is the tool surface's actual output shape, and
it is unchanged by where the discarding happens:

| Tool | Upstream shape | Columns kept | Document fields actually requested |
|------|----------------|--------------|------------------------------------|
| `afr_list_runs` | `Run` — 21 declared fields | 7 (`RUN_COLUMNS`) | 6 — `runId` has a `null` source |
| `afr_list_failure_patterns` | `FailurePattern` — ~30 declared fields | 8 (`PATTERN_COLUMNS`) | 5 — `fingerprintHash`, `confidenceState`, `confidenceStale` have `null` sources |
| `afr_get_run_events` | `Event` — 8 fields | 7 (`EVENT_COLUMNS`) | 3 — four columns all read `payload`, and `sequenceNumber` has a `null` source |

The dropped fields include the expensive ones — `run.metadata` (an unbounded
`Record<string, unknown>`), `run.searchText`, `run.tags`, and a failure pattern's
`representativeRunIds` / `affectedAgentVersionIds` / `lastSpikeAssessment`. They are
already not in the agent's context.

So: **moving projection server-side leaves the agent-visible token count essentially
unchanged.** If the tool output shifts at all after this lands, that is a bug, not a
saving. Do not sell this change as a context win — the context win was already taken, by
`projections.ts`, and taking it twice is not possible.

The tier costs in the table above are unaffected for the same reason. Tier 4 is doubly
unaffected: an event's bulk is its `payload`, which the tool needs and therefore still
requests, and the agent-visible cost of a window is already bounded by
`WINDOW_PAYLOAD_BYTE_BUDGET` (8 000 bytes) regardless of what the server sends.

### Where the win actually is

- **Wire bytes, AFR → this server.** A tier-1 page of 50 patterns currently transfers
  ~30 fields per row to use 6. That reduction is real and it is the bulk of the benefit.
- **Backend read and serialization cost** in Convex, on the same ratio.
- **Latency**, to whatever degree those two dominate — unmeasured, see below.

### Where there is no win

- **Agent context.** As above.
- **Rate-limit headroom.** The v1 rate class is 300 **requests** per minute per key
  (`{ rateLimit: { key: 'apiKey', limitPerMin: 300 } }` on every v1 route). It counts
  requests, not bytes. Smaller responses buy no additional calls.
- **Artifact payloads.** Externalized payloads were never inlined (Event Log Rule 3); the
  pointer is already all that crosses.

An honest summary: **this saves bandwidth and backend work, not context.**

### The drift risk, and how it is handled

`toColumnar` **drops any column that is null in every row** and reports only the surviving
columns in its `fields` header. Good compression — but it means an absent field and a
never-requested field are indistinguishable in the output. If a requested field list were
ever *narrower* than what a projection function reads, the column would not error and
would not come back empty: it would silently vanish from the header, and a caller indexing
by name would find nothing. The failure would surface far from its cause.

That class of drift is closed structurally rather than by discipline. Each projection is
declared as a `ProjectedColumn` table (`RUN_COLUMNS`, `PATTERN_COLUMNS`, `EVENT_COLUMNS`)
pairing every emitted column with the document field it reads, and the request lists are
**derived** from those tables by `requestFieldsOf` rather than maintained alongside them.
Adding a column that reads a new field therefore extends the request automatically.

A `source: null` means the value does not come from the projected document — either an
identity field the server returns whether or not it was asked for (contract rule 3:
`_id` / `sequenceNumber` / `fingerprintHash`), or a value joined in from a separate
envelope (`confidenceState` and `confidenceStale` come from `fixConfidence`, not from the
pattern document). Those are deliberately *not* requested. Note this makes the tools
**depend on the always-return-identity guarantee**: if the server ever stopped honoring
it, `runId` / `sequenceNumber` / `fingerprintHash` would disappear from the header and
every "handle into the next tier" would break at once.

See `CONTRIBUTING.md` → "Add a Field to a Projected Resource".

### Degrading to a deployment that cannot project

`FlightReader` refuses to hand back a full document dressed as a projection: if a response
carries a field nobody requested, the deployment silently dropped the unknown `?fields=`
parameter, and the SDK throws `V1ApiError('invalid_response')` rather than let a caller
read "field absent" when the truth is "never projected."

That refusal is right for a generic caller and **wrong for this server**, which
re-projects every response client-side anyway — a full document is a *correct* input here,
merely an expensive one. Letting it propagate would mean adopting server-side projection
turned working tools into failing ones against every deployment predating it.

So `packages/mcp/src/field-projection.ts` wraps each projected read in
`withFieldProjection`: ask with the field list, and on that one specific refusal, ask again
without it. One wasted round trip on a deployment that was going to be the expensive path
regardless, and **the tool's output is byte-identical either way**.

The retry is deliberately narrow. It fires only on `V1ApiError` with
`kind: 'invalid_response'` **and no `status`** — the SDK's client-side refusal. A
server-side rejection of a bad field name carries an HTTP status and is rethrown
untouched, so a typo in a column table still fails loudly, as contract rule 2 requires.

> One inaccuracy worth knowing while reading that file: its comment calls the bad-field-name
> rejection "an HTTP 400 [carrying] `status: 400`". It is a **422** — unknown field names
> are raised by Convex, not the route (`tests/unit/field_projection_route.test.ts` asserts
> 422; the 400s are the route's own shape guards). The logic is unaffected, since it
> discriminates on `status === undefined`, but the comment misdescribes the code below it.

### The identity-spelling question

`RUN_COLUMNS` gives `runId` a `null` source, so this server never requests the runs
identity field and relies entirely on the always-returned guarantee. The backend returns
it as `_id` (raw Convex document); `packages/contracts`' `Run` declares `id`. The SDK
sidesteps the disagreement by treating **both** spellings as legitimate identity keys
rather than resolving it. `docs/api_reference.md` → "Known gap: `id` vs `_id` on runs" is
the record; it is not settled, and `toRunRow` reads `run.id`.

### Not verified

- **Any byte or latency figure.** The field counts above are read from
  `packages/contracts/src/`, `convex/schema.ts` and `packages/mcp/src/projections.ts`, and
  are accurate as *declarations*. The bytes they correspond to depend on your data and
  have not been measured; no before/after comparison exists anywhere in the repo.
- **That tool output is byte-identical before and after projection.** That is the intended
  invariant, not a tested one, and gaps 1 and 2 above are reasons to doubt it currently
  holds. Worth an explicit test.
- **Everything in the two gaps above**, which are read from source and not from a running
  system.

---

## Tool contract

Every tool is read-only and org-scoped to the API key's organization. Cross-org reads
are impossible by construction — scoping is enforced in `convex/read_api.ts`, not in
this server.

### `afr_triage` — tier 0, the entry point

**One call, zero required arguments.** `afr_triage()` is the intended first call for
any caller that does not already have a run id or a fingerprint.

It is not a new data source. It reads the same `GET /api/v1/patterns` endpoint tier 1
reads, once, with a field selection derived the same way — everything else is ranking,
capping, and pointer construction over that one response. There is no second fact here
to disagree with the first.

That ranking lives in **`packages/sdk/src/triage.ts`**, not in this package.
`packages/mcp/src/triage.ts` is a pure re-export, and `afr triage` imports the same
`toTriageResult`. Two surfaces answering one question with two rankings is the drift
this arrangement exists to prevent, so there is exactly one implementation and the CLI's
`--json` output is byte-identical to the tool result.

**Arguments.** `agentId` (optional) narrows to one agent. That is the only filter. There
is deliberately no `environment` argument: a `FailurePattern` is an org-scoped rollup
over fingerprints and carries no environment, so the argument could only be accepted and
ignored — and a filter that silently does nothing is worse than an absent one, because
the caller believes it applied. There is no `limit` either: the emitted count is fixed at
`MAX_ITEMS` (**5**) out of a `SCAN_LIMIT` (**50**) scan, because the published cost is
measured *at* that number and a caller-raisable cap would make the published cost a
fiction. For breadth beyond five, use tier 1.

**Response.**

| Field | Meaning |
|---|---|
| `verdict` | `issues` \| `clear` \| `unknown`. See below — `clear` and `unknown` are **not** the same answer. |
| `complete` | Whether the view behind the verdict was whole. Orthogonal to `verdict`: `{ verdict: "issues", complete: false }` is a real and common state, meaning "the worst of what I saw", not "the worst that exist". |
| `scanned` | How many patterns were considered (≤ `SCAN_LIMIT`). Compare against `items.length` to see the cap at work. |
| `items[]` | Up to 5 ranked items: `fingerprintHash`, `class`, `label`, `count`, `lastSeenAt`, `signal`, `score`, optional `muted: true`, and `next`. |
| `caveats[]` | Every reason `complete` is false, in plain sentences. Present only when non-empty. |
| `unevaluated` | `{ count, sample }` — patterns with a live resolution but no usable confidence snapshot, so whether the fix held could not be graded at all. Named rather than dropped. |
| `next` | A top-level next hop when the *items* are not the answer — a truncated scan, or nothing found. Absent when the items carry their own. |

**Every item carries its own next call.** `next` is `{ tool, args }` — a tool name and
the exact argument object to pass it, verbatim. Exactly one pointer per item, chosen by
signal: a pattern with a live resolution (or one that regressed) raises "did the fix
hold?" and points at `afr_get_pattern_evidence`; anything else raises "why does this
happen?" and points at `afr_explain_run` with a representative run id. An agent never has
to infer the ladder.

**The ranking, and why it is auditable.** Items are ordered by `signal` class first —
`regressed` > `spiking` > `open` > `acknowledged` > `resolved` — with recency and volume
ordering *within* a class and never promoting across one (the class weights are spaced
wider than the maximum tie-break, so the tiers cannot interleave). Muted patterns sort
last and are flagged rather than hidden. `regressed` ranks above everything because a
regression is not merely a failure: it is a false belief living in the system, which
everything downstream is currently reasoning from. The `score` is emitted so the ordering
can be checked rather than trusted, and ties break on `fingerprintHash` so the order is
total and two calls a millisecond apart cannot shuffle.

**`clear` is not `unknown`.** `clear` means the scan completed and found nothing.
`unknown` means it could not be evaluated. A tool that reports the second as the first
has told a caller its agents are healthy when it actually failed to look. Read `verdict`
and `complete` together, always.

### `afr_list_failure_patterns` — tier 1

Recurring failure patterns for the key's org, most-recently-seen first. Compact rows.

Backed by `GET /api/v1/patterns`. Filters: `agentId`, `spiking` (`true` only),
`muted` (`true`/`false`), `status` (`open` | `acknowledged` | `resolved`), `regressed`
(`true` only), `state` (`unproven` | `proving` | `confirmed` | `regressed`), `limit`,
`cursor`. Unrecognized filter values are ignored rather than rejected.

The response carries a `fixConfidence` envelope alongside the rows — a staleness bound,
each verdict's age, and the fingerprints that could not be graded at all. It exists so
a reader can tell a fresh verdict from a stale one, and "does not match the filter"
from "was never evaluated". Do not present a snapshot verdict as current without
checking its age.

Patterns are **observability-grade derived data**, not source of truth. They are a
rollup over explanation-derived fingerprints, regeneratable at any time. The event log
remains the only fact about what happened on any single run.

The filters run in memory over a bounded scan window, so a short or empty page is not
always the end of the result set. The tool result carries **`scanTruncated: true`** when
the server's scan stopped on its row ceiling — an empty page is only "nothing matched"
when that field is absent. If you are using `state: "regressed"` as a build gate, read
[Using this as a CI gate](#using-this-as-a-ci-gate) first; it is the difference between
a gate and a gate-shaped object.

### `afr_get_pattern_evidence` — tier 2

One fingerprint's resolution evidence: the claim, the exposure measured since, the
confidence verdict and its drivers, and the transition history (including automatic
reopens by the regression guard).

Backed by `GET /api/v1/patterns/{fingerprintHash}/evidence`. A malformed fingerprint
is rejected with `400 INVALID_ARGUMENT` before any backend call. An unknown fingerprint
returns **404**, not `200` with a null body — "never existed" and "belongs to another
org" are deliberately indistinguishable so this endpoint cannot be used as an existence
oracle for another org's data.

A resolution on its own is an unearned assertion. This tool is what grades it: a fix
marked resolved six days ago with zero runs since is `unproven`, and saying so is the
entire value of the tier.

### `afr_explain_run` — tier 3

The "why did this fail?" root-cause explanation for one run: summary, root cause,
optional suggested fix, failure class, and cited sequence numbers.

Backed by `GET /api/v1/runs/{runId}/explanation`. The explanation is `null` (not an
error) when the run is not in an explainable status (`failed` / `timed_out` /
`cancelled`) or generation has not completed.

`status: "pending"` tells you to retry later, so it is only an honest answer if the
retry eventually terminates. Explanation generation is eager and fire-and-forget — a
dropped action, a transient engine-unavailable skip, or a run that failed before ADR-004
shipped would otherwise leave a run permanently `pending`. A `backfill-missing-explanations`
cron (every 30 minutes, `convex/crons.ts`) repairs that gap, bounded to terminal runs
that ended in the last 24 hours, at most 250 rows scanned per status per tick and 25
generations scheduled per tick. Re-scheduling is idempotent. **The acknowledged limit:
runs beyond that scan bound are not repaired** — a run that has been `pending` for
longer than the window will stay that way. Verified from `convex/run_explanations.ts`
and `convex/crons.ts` in the working tree; like everything else here, never executed. `kind` is `"heuristic"` — always
available, deterministic, zero configuration — or `"llm"` when an LLM provider is
configured *and* its output passed the grounding gate (it must cite at least one real
sequence number from this run). Ungrounded LLM output is discarded in favor of the
heuristic result; you never receive an explanation citing an event that does not exist.

### `afr_get_run_events` — tier 4

A **windowed slice** of one run's event log, in `sequenceNumber` order.

Backed by `GET /api/v1/runs/{runId}/events` (`limit`, `cursor`). Payloads over 10 KB
are artifact pointers, never inline bytes — this tool returns the pointer.

Use it last, with a window centered on a sequence number you got from tier 3. If you
find yourself paging the whole log, the earlier tiers did not do their job or you
skipped them.

#### Ordering on a derived run

For an event derived from an OpenTelemetry span, `sequenceNumber` is **the order we
learned about the event, not the order it happened** (ADR-007; see
`packages/contracts/src/temporal.ts`). Within one OTLP batch the two coincide. Across
batches they cannot: a span that arrives late but occurred early can only be
*appended*, because inserting it would require renumbering, and renumbering an
append-only log is permanent corruption (Event Log Rule 1).

The tool used to state that caveat and stop there. **A warning with no resolution
mechanism is worse than silence** — it makes the uncertainty unresolvable rather than
merely unflagged, and MCP is the one surface where a caller cannot go and look at the
run view instead. So the response now carries:

```
orderingBasis: "ingest-unverified"
```

**Present means proven.** At least one derived event in this run has no ordering key,
so what you are holding is an arrival log and cannot be made into a timeline. Do not
reason about what happened before what.

**Absent means undetermined — it is not a clean bill of health.** The reasoning is
one-directional on purpose. `analyzeRunOrdering` returns `ingest-unverified` for a run
*iff* any derived event lacks a key, so seeing one in a window proves the verdict for
the whole run regardless of what lies outside the window. Nothing observable in a
window can prove the other two verdicts (`temporal`, `sequence-native`), because a
single unkeyed event one sequence number outside it would overturn them. A tier-4
response is a slice **by construction**, so this is the normal case, not an edge case,
and the tier does not guess.

Costs **9 tokens**, and only when it fires. The semantics live in the tool
description, which an agent pays for once per session, rather than in the response,
which it pays for on every call — an earlier draft put the explanation in
`provenanceNote` and measured +33 tokens on *every* derived window for information the
description already carried.

> **Known gap.** The three-way verdict needs an O(run) read that this tier
> deliberately never performs, so `temporal` and `sequence-native` are not reportable
> here at all. The fix is not in this package: a denormalized run-level counter
> (an `unkeyedDerivedCount`, monotonic and add-only in the manner of `tokensIn` /
> `modelsSeen`) written at ingest would make the full verdict an O(1) read for MCP,
> the CLI and the web UI alike. That is a `convex/` + `packages/contracts` change.

### `afr_list_runs` — orientation

Compact run rows for the key's org. Backed by `GET /api/v1/runs`. Filters: `status`,
`agentId`, `environment`, `session`, `limit`, `cursor`. Server-capped page size;
`nextCursor` pages forward.

This is not a tier — it is the "which run are we even talking about?" lookup you reach
for when you arrive with a run ID or an agent name rather than a failure pattern.

---

## Version divergence — `afr_assess_version` and `afr_get_run_divergence`

A second question, with its own cheap-first pair. Given a run's recorded event
history and two `AgentVersion` `configSnapshot`s, the divergence engine reports
where a **target** version would have diverged from what was **recorded**. It
executes nothing: it is structural analysis over the event log, the same shape of
answer as Temporal's replay test.

This is the most agent-native question the product answers — an agent asking whether
its own next version is safe to ship — which is exactly why both tools are shaped by
what they are *not* allowed to claim. The decision record is
`docs/adr/008-version-divergence-analysis.md`; read its "What the engine can never
know" section before building a gate on either tool.

| Tool | Question | Role |
|---|---|---|
| `afr_assess_version` | "If I ship this version, what breaks across the fleet, and for how many distinct reasons?" | the entry point: agent + target version, no run id needed |
| `afr_get_run_divergence` | "Where does this one run's trajectory become impossible?" | the drill-down, reached from the entry point's `next` pointers |

**Start at `afr_assess_version`.** Its unit is the *reason*, not the run: "340 of
10,000 runs would break, for 12 distinct reasons" is a tractable morning, and a list
of 340 run ids is not. It also hands back the run ids worth drilling into — which is
the thing you did not know when you asked. Opening with `afr_get_run_divergence`
means choosing a run id first, the same mistake as opening with tier 4.

**These two are NOT priced an order of magnitude apart, and that is honest.** The
fleet call is not cheap because it returns little; it is cheap *relative to what it
covers* — one call over ten thousand runs. The reason to call it first is that it
answers the question you actually have and tells you where to look next, not that it
is a tenth the price.

### Three kinds of finding, and they are not three confidence levels

Every finding belongs to exactly one of three classes, returned in three separate
arrays that are never merged, never summed, and never sorted together:

- **`proven`** — a FACT. "This run called `search_web` at sequence 42; the target
  declares no such tool, so that step could not have happened." Each carries
  `provenBy`: the recorded sequence number, the event type, the target config path,
  the value the run recorded, and what the target declares there (`null` meaning
  absent — which is itself the proof). Safe to gate a deploy on.
- **`speculative`** — NOT EVIDENCE. "The system prompt changed, so behaviour may
  differ." It may differ everywhere or nowhere, and no recorded history can decide
  which. Carries `because`: why it cannot be proven. Never a gate signal by default.
- **`indeterminate`** — a question the analysis COULD NOT ANSWER. "Whether the tool
  calls at sequences 12 and 19 target tools this version still declares" — because
  their payloads were externalized past the 10 KB ceiling (Event Log Rule 3), so the
  event survived and the deciding field did not. Not a break, and not the absence of
  one. **This is the common case, not an edge case**, because `configSnapshot` is
  free-form and `compatible` requires every dimension declared. Each entry carries a
  `remedy`: the action that would make it answerable ("re-publish this version with a
  structured `tools` declaration"). That is the only field on either response that
  tells an autonomous caller what to *do* rather than what it cannot know, and it is
  what makes an unanswerable question a fixable state rather than a dead end.

The third class exists because two are not enough, and a two-bucket answer corrupts
both: an engine with nowhere to put an unanswerable question either files it as proof
(a guess rendered as evidence), files it as speculation ("could not check" rendered as
"checked, only a maybe" — wrong in the safe-looking direction), or drops it. Dropping
is the worst of the three and is what a two-bucket type quietly encourages.

Every finding carries its `certainty` discriminant explicitly, even though the array
it arrived in already implies it. **That redundancy is deliberate and must not be
optimized away.** The array name is context; the field is content, and only the field
survives an agent lifting one finding out of the response and carrying it into its own
reasoning, a log line, or another tool call — which is exactly what an LLM consumer
does with a structured result. This is the [`orderingBasis`](#ordering-on-a-derived-run)
decision at higher stakes: **you cannot open the run view to disambiguate.** Where a
budget and this rule conflict, the budget gives — cut a finding, cut a sample, cut a
sentence, never the discriminant.

### `complete` is the field that stops a false clean

`proven: []` means one of two entirely different things, and only one of them is safe
to ship on:

- we checked, and nothing is proven to break; or
- we did not finish checking.

So both tools return a top-level **`complete`**, derived from contracts'
`isDivergenceAnalysisComplete` / `isFleetDivergenceAnalysisComplete` rather than
re-implemented here. It is stricter than the coverage record nested beside it,
because there are two ways not to have looked: a dimension never reached
(`coverage.unassessed`, each entry naming why — an absent `configSnapshot`, a
dimension the snapshot is silent on, an unreadable shape, an engine limit) and a
specific question reached but unanswerable (`indeterminate`). **An empty `proven`
list authorises nothing unless `complete` is true.**

Every finding on both tools carries its `dimension`, and `afr_get_run_divergence`
additionally returns **`byDimension`** — one outcome per dimension,
`{ tools: 'incompatible', model: 'clean', budgets: 'undeclared', … }`, derived by
contracts' `divergenceByDimension` rather than re-folded here.

**That field is what stops a caller reading past the verdict.** A single global word
collapses six independent questions and is almost always the worst of the six, so a
version whose tools are provably fine and whose budgets were never declared reads as
one undifferentiated failure. `undeclared` and `unanswered` are separated carefully:
both mean "not checked", but only `undeclared` is *yours* to fix. The fleet tool has
no roll-up, deliberately — `FleetDivergenceReport` carries no coverage record, so
`undeclared` and `clean` are not derivable from it, and folding one anyway would mean
a second copy of a precedence rule that must exist exactly once.

The fleet call additionally reports `window`, and its `complete` folds in **four**
separate ways of not having looked: `scanTruncated` (stopped on the row ceiling),
`runsUnassessable` (visited but unreadable), `runsSkippedForBudget` (inside the window
but never reached), and `nextCursor` (pages remain). The last is the one most easily
missed, because a full, clean first page looks exactly like a finished scan — and a
first page presented as a fleet verdict is the worst failure this feature has. The
cursor is forwarded so an agent told "incomplete" can actually do something about it.
This is the same posture as
[`scanTruncated` on pattern listings](#an-unfinished-scan-is-not-a-clean-scan) — the
server states the incompleteness in a field, and the gate decides that an incomplete
scan is not a pass.

### The asymmetry that is easiest to misread when the news is good

**A clean report says the target would not have BROKEN on recorded history. It never
says the target would BEHAVE THE SAME.** Added capability is invisible to a replay by
construction — nothing recorded can be contradicted by an addition, so a tool the
target adds appears only as a speculative `tool_added`. Reading `compatible` as
"behaves identically" is a conclusion the method cannot support, drawn in the one
situation where nobody is inclined to check.

Two more one-directional limits worth knowing before you build a gate: a surviving
tool call can be proven **invalid** against the target schema but never proven
**valid** (enums, formats and cross-field constraints are not evaluated), and
`capability_removed` is never emitted at all, because no event type records which
named capability produced it — a removed capability surfaces speculatively instead.
`docs/adr/008-version-divergence-analysis.md` §5.1 is the full list.

### There is no "safe" verdict, deliberately

`verdict` is `incompatible` | `compatible_with_caveats` | `compatible` |
`indeterminate`. There is no value meaning "safe", because the engine never executes
and therefore:

- It can **prove** a recorded step was impossible — a tool or model the target does
  not declare, a hard recorded budget the target lowers.
- It can **never prove** a prompt change, an added tool, or a decoding-parameter
  change is harmless. That is a property of not running the agent, not a gap better
  analysis closes.
- Recorded history is a **sample, not a specification**. A fleet analysis that finds
  nothing has established a fact about the runs it read and nothing about the next
  one.

The strongest true statement a clean result supports is: *no recorded run is proven to
break on the dimensions that were checked.* Neither tool says anything stronger.

`verdict` is forwarded from the server, which `FlightReader` has already cross-checked
against the report's own contents — a response whose verdict contradicts its arrays,
whose `targetVersionId` is not echoed back, or whose `proven` list contains something
unprovable never reaches these projections. It is not recomputed here: a second
derivation of one rule is a second rule.

### Arguments, caps, and next hops

Both take `targetVersionId` as a **required** argument. There is no "compare against
the latest" default anywhere in this stack — a gate whose subject is implicit silently
changes meaning the moment somebody publishes a new version. `afr_assess_version` also
takes `agentId`, and optional `since` / `limit`; `afr_get_run_divergence` takes
`runId`.

Findings and reasons are capped **per class** (4 per class on the fleet call, 3 on the
drill-down) and never against a shared budget: a shared cap would let a version with
one broken tool and eleven prompt tweaks push its single proven reason off the end of
the list. Whatever is cut is counted, never silently dropped. On the drill-down,
proven findings are emitted earliest-first so the cut always falls on the tail — the
**first** proven break is the meaningful one, since everything after it describes a
trajectory the target was never going to reach.

Proven reasons carry a `next` pointing at the drill-down for a representative run; the
drill-down carries a `next` pointing at an event window around the first proven break.
**Speculative and indeterminate reasons carry no `next`, on purpose** — drilling in
returns the same unprovable sentence, or the same unanswerable question, one level
down, having spent a tool call to do it. A pointer implies there is something at the
end of it.

---

## Configuration

### Environment variables

The server reads the **same two variables the `afr` CLI reads**. They are already
documented in `.env.example`; nothing new is introduced.

| Variable | Required | Notes |
|----------|----------|-------|
| `AFR_API_KEY` | yes | Agent Flight Recorder API key. **Must carry the `read` scope.** |
| `AFR_BASE_URL` | yes | Base URL of the AFR deployment, e.g. `https://your-afr-host` or `http://localhost:3000`. A trailing slash is stripped. |

Note the difference in *how* they are supplied. For the CLI they live in your shell
environment. For an MCP server they are set in the MCP client's config file (`env`
block below), because the client — not your shell — launches the process.

### The key must have the `read` scope

Mint a read-only key rather than reusing an ingest key:

```bash
curl -s -X POST "https://your-afr-host/api/api-keys" \
  -H "Cookie: __session=..." -H "Content-Type: application/json" \
  -d '{ "name": "MCP server (read-only)", "scopes": ["read"] }'
# => { "id": "...", "scopes": ["read"], "key": "<raw key, shown ONCE — save it now>" }
```

- A key with `scopes: ["ingest:write"]` is rejected by every `/api/v1/**` endpoint with
  `403 FORBIDDEN` (`Forbidden: API key lacks required scope "read"`).
- Omitting `scopes` when creating a key now yields the default `["ingest:write"]` —
  i.e. **not** usable here.
- A `read`-only key is symmetrically rejected by every ingest route, which is the point:
  handing an MCP client a key that cannot possibly write is the cheapest form of the
  read-only guarantee.

Check the `scopes` field on the *response*; it reflects what was actually stored.

See `docs/api_reference.md` §0–1 for the full key-management contract.

### MCP client config

The tool surface is the same across clients; only the file differs. Claude Desktop
(`claude_desktop_config.json`) and Claude Code / Cursor (`.mcp.json` in the project
root) both take this shape:

```json
{
  "mcpServers": {
    "agent-flight-recorder": {
      "command": "node",
      "args": ["/absolute/path/to/GunkHub/packages/mcp/dist/index.js"],
      "env": {
        "AFR_API_KEY": "afr_live_xxxxxxxxxxxxxxxxxxxxxxxx",
        "AFR_BASE_URL": "https://your-afr-host"
      }
    }
  }
}
```

`packages/mcp/package.json` declares the bin `afr-mcp` → `./dist/index.js`, so once
the package is installed/linked you can use that name instead of an absolute path:

```json
{
  "mcpServers": {
    "agent-flight-recorder": {
      "command": "afr-mcp",
      "env": {
        "AFR_API_KEY": "afr_live_xxxxxxxxxxxxxxxxxxxxxxxx",
        "AFR_BASE_URL": "https://your-afr-host"
      }
    }
  }
}
```

Either form requires `pnpm --filter @agent-flight-recorder/mcp build` first — `dist/`
is a build artifact and is not checked in.

Transport is stdio: the client spawns the process and speaks MCP over stdin/stdout.
Consequences worth knowing before you debug it:

- **Never write to stdout.** Anything printed there corrupts the protocol stream. Logs
  go to stderr.
- The process inherits nothing from your interactive shell. If `AFR_API_KEY` works in
  your terminal but the server reports it missing, the `env` block above is what is
  actually in effect.
- Restart the MCP client after editing its config; these files are read at launch.

**Unverified:** `packages/mcp` is being landed alongside this document and neither
config block has been used to launch a real client. The bin name and entry path are
read from `packages/mcp/package.json`, not from a successful handshake. When
`packages/mcp/README.md` exists it is the owning team's authority on the launch
command; prefer it over this page if the two disagree.

### Local development

`AFR_BASE_URL=http://localhost:3000` points the server at `pnpm dev`. You still need a
real API key from that deployment, which means a working Convex deployment and a
seeded org — the server has no fixture or offline mode.

---

## Operational notes

- **Rate limit:** 300 requests/min per key, bucketed by a hash prefix of the key (never
  the raw secret). This is shared with every other `/api/v1/**` consumer using the same
  key — the CLI, the SDK's `FlightReader`, and this server will contend if they share
  one. Give the MCP server its own key. A `429` carries `retry-after: 60`.
- **Errors:** `UNAUTHORIZED` (401) means the key is missing, invalid, revoked, or
  expired. `FORBIDDEN` (403) means the key exists but lacks `read` — the single most
  likely first-run failure. `NOT_FOUND` (404) covers both "does not exist" and "belongs
  to another org," deliberately. `INVALID_ARGUMENT` (422, or 400 on the evidence route's
  fingerprint guard) means a malformed argument.
- **Envelope:** successful v1 responses are `{ apiVersion, data, requestId }`; errors
  are `{ apiVersion, error: { code, message, details } }`. A known platform gap means
  some failures (unrecognized backend errors, and rate-limit rejections that never reach
  the route handler) return a flat `{ code, message, details }` instead — a client must
  tolerate either. `requestId` is echoed in the `x-request-id` header; quote it in bug
  reports.
- **Secrets:** `AFR_API_KEY` is a credential. It belongs in the MCP client config, not
  in a committed file, and not in a tool response.

---

## Further reading

- `docs/api_reference.md` — the v1 read API contract (runs, events, replay, explanation,
  and both pattern endpoints), plus the `?fields=` projection contract
- `CONTRIBUTING.md` — "The MCP Token Budgets Are a Release Gate" (the obligation that
  comes with adding or reshaping a tool), "Add or Reshape an MCP Tool", and "Add a Field
  to a Projected Resource," the multi-boundary checklist for making a new field
  reachable through this server
- `docs/adr/005-failure-patterns.md` — why failure patterns exist and their
  observability-grade constraints
- `docs/adr/006-failure-resolution.md` — the resolution lifecycle and the fix-confidence
  verdict tier 2 returns
- `docs/adr/004-run-explanations.md`, `docs/design/explanations.md` — how tier 3's
  explanation is produced and grounded
- `docs/adr/008-version-divergence-analysis.md` — the divergence engine, the
  provable/speculative invariant, and the normative specification of the two proposed
  tools above (including their budgets and what may never be compressed to meet one)
- `CLAUDE.md` — System Boundaries; the binding constraints on this package
- `packages/mcp/README.md` — the owning team's package-level docs
