# ADR 008 — Version Divergence Analysis, and What It Is Allowed to Claim

Status: **Accepted for the contract and the read surface; the engine behind it
is still being built.** What exists on disk: the shared types
(`packages/contracts/src/divergence.ts`), the `FlightReader` read methods with
their response verification (`packages/sdk/src/reader.ts`), and the MCP tool
pair described in section 6 (`packages/mcp/**`, registered, budgeted,
baselined and measured). What does not: the `/api/v1/**` routes and the
`convex/` engine itself, so **no call to either tool can succeed against a
deployment yet**. Nothing here has been executed end to end; no Convex
deployment has ever existed for this project.

Date: 2026-07-25

**Verified against — read four times, because the tree moved under each read.
Five teams were landing on this branch while it was written.**

- *Pass 1*, commit `3a8916b` ("Ingest OpenTelemetry traces over OTLP/HTTP"),
  working tree clean. `grep -ril diverg` matched no divergence implementation
  anywhere — only pre-existing run-to-run *diff* code
  (`packages/contracts/src/diff.ts`, `apps/web/src/lib/replay/diff.ts`), which
  is a different feature and is discussed under Alternatives.
- *Pass 2*, same commit, one untracked directory: `apps/web/src/lib/divergence/`,
  carrying a web-boundary `types.ts`. Contracts, SDK, `convex/` and
  `apps/web/app/api/v1/**` were all still empty of divergence code. This ADR's
  first revision recorded that as the blocking problem: shared types in a web
  module cannot be imported by `packages/mcp` and must not be forked.
- *Pass 3*, same commit. `packages/contracts/src/divergence.ts` and the
  `FlightReader` methods had landed, and the contract had grown a **third**
  finding class (`IndeterminateDivergence`) that the first revision of this ADR
  did not anticipate. Section 3 below is rewritten around three classes, not
  two. `convex/divergence.ts` and `convex/helpers/divergence.ts` existed as
  untracked files; their contents are not relied on here.
- *Pass 4*, after the MCP surface described in section 6 was built. Measured
  green: `pnpm tsx scripts/check-token-budgets.ts` reports every registered
  tool budgeted and every measurement under both its budget and its baseline;
  `packages/mcp` typechecks and lints clean; the nine `mcp_*` +
  `token_budget_guard` suites pass, 205 tests. `pnpm build` fails **only** in
  `apps/web`, on components importing `@/lib/divergence/types` after that
  module was moved to contracts — a transient mid-migration state in another
  boundary, unrelated to anything here.

Every claim about `convex/` describes committed code at `3a8916b`. Claims about
`packages/contracts`, `packages/sdk` and `apps/web` describe an uncommitted,
actively-edited tree and must be re-checked once committed.

Relates to: ADR-0002 (the event log is canonical and immutable), ADR-0005
(on-demand replay), ADR-0008 (projection execution model), ADR-0013 (diff
boundedness), ADR-0019 (agent version identity), ADR-0020 / ADR-0022
(verification scope and vocabulary), ADR-002 (observability-grade derived
data), ADR-004 (run explanations), ADR-005 (the `scanTruncated` posture this
reuses), ADR-007 (derived events and what a projection may claim about
ordering).

---

## 1. Context

An `AgentVersion` is immutable (`CLAUDE.md` → Core Entities). Any change to an
agent's configuration, system prompt, or tool list creates a new one. The
question every operator of that agent then has — and, increasingly, the
question the *agent itself* has — is:

> If I ship this new version, what breaks?

The recorded event log already contains the raw material for a partial answer.
We have thousands of runs, each with a complete ordered event history, each
tied to the `AgentVersion` it executed under. Given a target version's
`configSnapshot`, we can walk a recorded run's events and ask, step by step,
whether that step was still *possible* under the target.

This is the same technique as Temporal's replay test: take production history,
run it against new code, report where the new code would have taken a different
path. It executes nothing. It is pure structural analysis over recorded facts.

**Why this needs an ADR rather than a design doc.** Every other derived view in
this product answers a question about the past — what happened, why it failed,
whether a fix held. This one answers a question about the *future*, and it
answers it to a caller who may act on it without a human in the loop. The
product's ICP is autonomous companies; the most agent-native question this
system will ever be asked is an agent asking whether its own next version is
safe to ship. A feature that gates a deploy is a feature whose limits have to
be written down with more force than its capabilities, because the failure mode
is not a confusing UI — it is a shipped outage, or a safe change blocked
forever, decided on our word.

---

## 2. Decision

**A structural divergence engine: given one recorded run's event history and
two `AgentVersion` `configSnapshot`s, report where the target version would
have diverged from what was recorded. It never executes anything.**

It is a **derived projection** in the exact sense of Event Log Rule 2 —
computed at query time from the stored event sequence, never written back,
regeneratable at any time from the event log plus two immutable config
snapshots. It creates no new source of truth, and deleting every cached
divergence result would lose nothing but compute.

It is **observability-grade**, in the sense ADR-002 and ADR-005 use the term,
with one addition specific to this feature: an observability-grade *count* that
is slightly wrong is a nuisance, but an observability-grade *safety verdict*
that is slightly wrong is a shipped outage. So the grading in section 3 is not
a presentation concern. It is the feature.

---

## 3. Three kinds of claim, separated structurally

This is the load-bearing decision in this document. Everything else is
mechanism.

| Class | Claim | Warrant |
|---|---|---|
| **Proven** | "This run called `search_web` at sequence 42. The target declares no such tool. This step could not have happened." | The recorded event log. No model of agent behaviour is involved. A fact about a fact. |
| **Speculative** | "The system prompt changed. Behaviour may differ." | None. The run may be byte-identical under the target. Unfalsifiable from recorded history. |
| **Indeterminate** | "Whether the tool calls at sequences 12 and 19 target tools this version still declares — we could not decide." | Not a finding about the version at all. A fact about the *inputs*: a malformed tool list, or a `tool.call` payload externalized past the 10 KB ceiling (Event Log Rule 3), so the event survived and the deciding field did not. |

**These are not three confidence levels on one scale.** They are different
kinds of statement. A proven finding is a deduction from recorded evidence; a
speculative finding is the observation that we have no evidence either way; an
indeterminate finding is the admission that a specific question was asked and
could not be answered. There is no threshold, no score, and no accumulation of
speculative findings that becomes a proof.

**The third class is the one that is easy to leave out, and leaving it out
corrupts the other two.** A real engine reading a real `configSnapshot`
routinely lands on a question it cannot decide. With only two buckets available
it has three options and all three are wrong: file it as proven (a guess
rendered as evidence — catastrophic); file it as speculative ("could not check"
rendered as "checked, and it is only a maybe" — a lie in the safe-looking
direction, which is how a false clean ships); or drop it, which is the worst of
the three and is exactly what a two-bucket type quietly encourages. This ADR's
first revision proposed two buckets; `packages/contracts/src/divergence.ts`
landed three, and three is right.

### The normative rules

These bind every layer — engine, contracts, API, CLI, web UI, and MCP.

**R1 — The classes are separate types, not a flag on one type.** A single
`Finding` interface with `certainty: 'proven' | 'speculative' | ...` is the
design that fails, and it fails for a reason worth stating precisely:
TypeScript can force a *producer* to set a field, but it can never force a
*consumer* to read one. A renderer, a projection, or a summariser that ignores
the flag compiles perfectly and treats proof and conjecture identically. The
distinction has to be carried in the *shape*, so that ignoring it is a compile
error rather than an oversight.

As the contract implements it: each type carries a distinct `certainty` literal
**and** a required field the others lack (`provenBy` / `speculativeBecause` /
`unknownBecause`), so assignment fails in both directions on a missing required
property, not merely on the discriminant — deleting the discriminant would not
open the hole. There is deliberately **no shared `message` field** (proof says
`provenClaim`, speculation says `speculativeConcern`, an unanswered question
says `undecidedQuestion`), so the one-liner that renders "all the findings"
cannot be written by accident. And there is **no exported union**: a consumer
who genuinely needs to hold all three names all three, and naming them is the
acknowledgement.

**R2 — The classes are never merged into one list, one count, or one number.**
Not in a payload, not in a projection, not in a summary line. A
`totalAffectedRuns` field that sums proven and speculative runs launders
conjecture into fact in the one direction that matters: "412 runs break" reads
as 412 proven breakages, and if 300 of them are "the prompt changed", the
number is a lie. The types must offer no merged field to reach for.

**R3 — "We did not check" is a distinct answer from "we checked and found
nothing".** `configSnapshot` is optional on `AgentVersion`
(`packages/contracts/src/entities.ts`, `convex/schema.ts` — `v.optional(v.any())`),
and a snapshot that *is* present may be silent on a dimension. Every dimension
the analysis did not reach is named in a coverage record with the reason it was
not reached. An empty proven list alongside a non-empty `unassessed` is not a
clean bill of health, and no layer may present it as one.

**R4 — No verdict vocabulary may contain a green that outranks "unknown".**
This is the `afr_triage` lesson (`docs/mcp.md` → "Reading `afr_triage` as a
gate") applied to a strictly higher-stakes question. The contract's
`computeDivergenceVerdict` is the single definition, and its precedence is
deliberate: a proven divergence yields `incompatible` **even under incomplete
coverage**, because a proof does not become less true when something else went
unchecked — demoting it would let an incomplete scan hide a certainty. Nothing
proven plus incomplete coverage yields `indeterminate`, which is not a hedge
but the word that stops a false clean. **There is no `safe` in the vocabulary
at all** — see section 5.

**R5 — Truncation, sampling and unanswered questions are first-class result
fields, never absences.** A bounded event read that stopped early, a fleet
analysis over a recent sample, and a question that could not be decided all
produce results that *look* exactly like complete clean ones. Each is declared
in a field the caller can read. This is the `scanTruncated` contract from
`convex/read_api.ts`, restated: an unfinished scan is not a clean scan, and on
the wire an empty result because nothing matched and an empty result because we
ran out of budget are the same three bytes.

**R6 — Copy asserts only what is warranted.** Proven copy is in the indicative
and states an impossibility ("could not have happened"). Speculative copy is in
the conditional and names the uncertainty out loud ("may differ… this is not
evidence of a break"). Indeterminate copy is phrased as the open *question*.
The grammatical difference is the line of defence that survives being read
aloud, machine-translated, or truncated, and it is the only one that survives
reaching a caller with no UI to look at. No speculative string may be rewritten
into the indicative without moving its reason into the proven alphabet and
giving it an event to point at.

---

## 4. What the engine can prove

Only claims decidable from `(recorded events, target config)` with no model of
how an agent chooses. The test for admitting a new proven reason: **if
answering it requires the word "probably" or "may", it is not proven.** The
contract's `ProvenDivergenceKind` is a closed set and each member carries a
written proof obligation — a tool invoked that the target does not declare, a
tool call the target's schema cannot accept, a model the target does not
permit, a hard recorded count over a numeric ceiling, a named capability
removed. Each is a statement about what the target *permits*, checked against
what the run *did*. None predicts behaviour. All are falsifiable by reading two
artefacts.

**The first proven break is the meaningful one.** Once a run provably could not
have taken a step it recorded, everything after that step is counterfactual —
the remainder of the recorded trajectory is not evidence about the target
version at all, because the target was never going to be in that state. Later
findings in the same run are still reported (they name additional distinct
reasons, which is what an operator fixes), but no layer may present the tail as
though the target would have reached it.

---

## 5. What the engine can never know

This section is deliberately as long as the one above, and it is the more
important of the two.

**It never executes, so it can never prove a prompt change is safe.** A changed
system prompt, a changed temperature, an added tool, a substituted model: each
may alter the entire trajectory or alter nothing, and nothing in a recorded
event log distinguishes those cases. This is not a gap to be closed by better
analysis. It is a property of not running the agent. An improvement to the
engine that starts reporting prompt changes as breakages — or as *safe* — is
not an improvement; it is the feature claiming more than its method supports,
and it is the specific regression this ADR exists to prevent.

**It cannot prove absence of divergence.** "No proven findings" means we found
no proof, over the dimensions we could check, on the runs we looked at. There
is no observation the engine can make that establishes safety.

**Recorded history is a sample, not a specification.** The runs we have are the
paths the agent took under the old config, against the inputs it received. A
target version can break on an input no recorded run contains. A fleet analysis
over 10,000 runs that finds nothing has established a fact about those 10,000
runs and nothing about the 10,001st.

**Structural checks are as good as the snapshot.** `configSnapshot` is
`Record<string, unknown>` — an untyped bag. A snapshot that omits a dimension
yields a coverage gap (R3) and a snapshot that is present but malformed yields
an indeterminate finding; but a snapshot that *misdescribes* the version yields
a confidently wrong answer that nothing in this system can detect. The engine's
claims are conditional on the snapshot being an accurate record, which is an
ingest-time property, not an analysis-time one.

**It says nothing about non-config change.** Two versions with identical
configs can behave differently: the implementations behind the tool names may
have changed, an upstream API may have changed, a provider may have silently
updated the weights behind a model id. The engine compares declarations, not
behaviour.

**Ordering caveats propagate.** For runs containing OTel-derived events,
`sequenceNumber` is arrival order, not occurrence order (ADR-007). "The first
proven break" is therefore "the first by the run's ordering key", and on a run
whose ordering basis is `ingest-unverified` that is an arrival-order claim.
Anywhere the engine reports a *position* in a trajectory, ADR-007's
`orderingBasis` caveat applies unchanged and must be forwarded, not swallowed.

### 5.1 The specific things this engine cannot determine

Read from `convex/helpers/divergence.ts` after Team A's engine landed. These
are sharper than the general limits above and each is a concrete boundary a
future contributor will otherwise re-discover by shipping a wrong answer.

- **`capability_removed` is never emitted, and cannot be.** No event type in
  `packages/contracts/src/events.ts` records which *named* capability produced
  it — a `retrieval.query` carries a query string, not the identity of the
  retrieval source. Without a recorded capability identifier there is no fact
  to contradict, so a removed capability is reported *speculatively* as
  `config_changed`. The kind stays in the contract's union because the contract
  owns it. **Closing this needs an event-payload change, not an engine change**,
  and anyone who "fixes" it in the engine has invented a proof.
- **An externalized `tool.call` payload loses the tool name entirely.** Event
  Log Rule 3 externalizes anything over 10 KB, so this is not rare. The event
  survives with its type; the discriminating field goes to blob storage, and
  the engine reads the event log only — it never fetches an artifact. A call to
  a removed tool then becomes indistinguishable from no call at all, which is
  exactly the `evidence_externalized` indeterminate kind and exactly why the
  third class had to exist.
- **A surviving tool call can be proven INVALID, never proven VALID.** Schema
  checking runs in one direction only: a recorded argument the target's schema
  rejects is a proof; a recorded argument it appears to accept is not, because
  enums, formats, and cross-field constraints are not evaluated. "The call
  still validates" is therefore never a finding, and must never be reported as
  reassurance.
- **`max_tokens` semantics are assumed standard.** `budget_exceeded` compares a
  recorded count against a numeric ceiling on the assumption that the ceiling
  means what it usually means. A provider with different semantics yields a
  confidently wrong proof.

### 5.1b The limits are mostly a property of what callers DECLARE

This section would be badly misread if it stopped at 5.1, and the misreading
matters more than any individual limit in it. A reader who takes away only "this
thing usually answers `indeterminate`" will conclude the feature is weak. The
actual conclusion is almost the opposite.

The dominant cause of an `indeterminate` verdict is **not** the strictness of
the `compatible` rule, and it is not a shortcoming of the engine. It is
snapshots that make no claims at all. `configSnapshot` is
`Record<string, unknown>`; a free-form blob that happens to have a `tools` key
has never claimed that the key is a complete list, so the engine — correctly —
refuses to derive anything from an absence in it.

`packages/contracts/src/agent_config.ts` is the fix, and it is one neither the
brief nor this ADR's earlier revisions proposed. Declaration is **per
dimension** and self-describing, and — the high-leverage part —
**`{ declared: 'none' }` and `{ declared: 'unbounded' }` are complete,
checkable claims.** An agent that legitimately has no tools can now *say so*,
and every recorded tool call then contradicts that claim: a permanent shrug
becomes a real verdict at zero cost. An agent with no budget ceiling can say
that too. Today those agents are indistinguishable from ones whose tool list or
budget was simply never captured.

**Completeness is claimed, never inferred**, and that asymmetry is what makes
the whole scheme safe rather than merely convenient. A producer must say
`declared: 'enumerated'` (a complete list, absence is a fact, absence can carry
a proof) or `declared: 'partial'` (these exist, absence proves nothing, absence
can never carry a proof). Only `enumerated` and `none` may carry a proof. The
failure this prevents is the catastrophic one: a snapshot whose `tools: []`
means *the capture failed* rather than *there are no tools* would manufacture
`tool_removed` proofs against a perfectly healthy version — proven breakage,
reported with total confidence, for a change that breaks nothing. A producer
that cannot honestly claim completeness now cannot accidentally claim it.

So the honest summary of section 5 is: the engine's silence is mostly a
property of what callers declare, not of what the engine can decide. **Declaring
your configuration buys you a real answer.** That is also why
`IndeterminateDivergence.remedy` and the per-dimension `undeclared` state exist
and are carried through to the MCP surface (6.3): they are the two fields that
turn "I cannot tell" into "I cannot tell *yet*, and here is what to do about
it". Nothing else on either response is actionable in that way.

The limits in 5.1 are real and permanent. The `indeterminate` verdicts most
callers will actually see, at first, are neither.

### 5.2 Two corrections to this ADR's original framing

Recorded rather than quietly edited, because both errors were in the direction
of *understating* what the engine can prove, and an ADR that silently improves
its own predictions is not a record.

- **A model change was described as never provable. It is provable in one
  direction.** If the target enumerates a permitted-model list and the run
  recorded a model outside it, that is a closed contradiction — `model_removed`
  — with the same warrant as a removed tool. What remains unprovable is a model
  *substitution* the target does permit (`model_substituted`, speculative): the
  output may differ, and nothing recorded decides it.
- **Token and tool-call budgets were filed as advisory parameter drift. They
  are hard proofs.** A recorded 4,000-token response could not have been
  generated under `max_tokens: 512`. `budget_exceeded` belongs in the proven
  alphabet, subject to 5.1's caveat about semantics, and only for counts the
  log actually measures — a wall-clock timeout the log does not measure does
  not qualify.

### 5.3 The asymmetry that is easiest to misread when the news is good

**A clean report says the target would not have BROKEN on recorded history. It
never says the target would BEHAVE THE SAME.**

These sound alike and are not. Added capability is invisible to a replay *by
construction*: nothing recorded can be contradicted by an addition, so a tool
the target adds can only ever appear as a speculative `tool_added`. An agent
that reads `verdict: "compatible"` as "this version behaves identically" has
drawn a conclusion the method cannot support, in the one situation — good news
— where nobody is inclined to check. This sentence is in both tool
descriptions verbatim, because the tool description is the only place an
autonomous caller will ever encounter it.

**Consequently, the engine emits no "safe to ship" verdict.** It reports proven
impossibilities, unproven differences, questions it could not answer, and the
dimensions it could not check. Deciding to ship is the caller's, and the
decision a clean result supports is narrow: *no recorded run is proven to break
on the dimensions that were checked.* That sentence is the strongest true
statement available, and every layer should be able to produce it verbatim.

---

## 6. The MCP surface — what shipped

`packages/mcp` is where this feature meets its ICP, and where section 5's
limits become load-bearing rather than editorial. An agent reading a tool
result **cannot go and look at the UI to disambiguate.** It has the bytes we
returned and nothing else. Every hedge a web page can express as layout,
typography, or an adjacent caveat panel has to survive as *structure* in a JSON
payload measured in hundreds of tokens.

The binding constraints from `CLAUDE.md` → System Boundaries are honoured
unchanged: both tools are read-only (`readOnlyHint: true`, no mutation of any
kind), the package imports nothing from `convex/`, holds no deploy key and no
Clerk session, and reaches the product only through `FlightReader` — which is
the package's only HTTP path — over `/api/v1/**` with an `x-api-key` carrying
the `read` scope. Every entity type comes from
`@agent-flight-recorder/contracts`; nothing is redeclared. Only the *output
projections* are declared locally, which is what `projections.ts` has always
been.

### 6.1 Two tools, and which one is first

| Tool | Question | Role | Budget | Measured |
|---|---|---|---|---|
| `afr_assess_version` | "If I ship this version, what breaks across the fleet, and for how many distinct reasons?" | entry point: agent + target version, no run id needed | 1,100 | 1,032 worst case / 76 clean |
| `afr_get_run_divergence` | "Where does this one run's trajectory become impossible?" | drill-down, reached from the entry point's `next` pointers | 1,400 | 1,336 worst case / 82 clean |

**Why the fleet call is first.** Its unit is the *reason*, not the run: "340 of
10,000 runs would break, for 12 distinct reasons" is a tractable morning, and a
list of 340 run ids is not. It also hands back the run ids worth drilling into
— which is precisely what the caller did not know when it asked. Opening with
the per-run tool means choosing a run id first, the same mistake as opening
with tier 4.

**These two are NOT an order of magnitude apart, and saying so is more useful
than pretending otherwise.** The original design note for this ADR asserted the
`afr_triage` → `afr_get_run_events` shape, with the fleet call cheap and the
drill-down expensive. The measurements do not support that, and the reason is
structural rather than fixable: the drill-down returns *findings*, bounded by
how many tools and models a config declares, not event payloads. A per-run
divergence report is simply not a tier-4-sized object, and budgeting it at
10,000 by analogy would have put a ceiling ten times higher than the content
around a response nothing forces to be large. The fleet call's cheapness is
relative to *what it covers* — one call over ten thousand runs — not to the
drill-down. The reason to call it first is that it answers the question you
have and tells you where to look next.

**Why the ceilings are the two largest on this surface after tier 4's.** This
is where the three-class distinction is paid for, in tokens, on purpose.
`afr_triage` returns one ranked list and fits in 450. `afr_assess_version`
returns **three disjoint ranked lists** plus a run count plus a scan-
completeness record. **A single merged ranked list would fit under 450
comfortably.** That measurement is not an argument for 450; it is the price of
the honest encoding, and it is the number to quote at anyone who proposes
flattening this to hit a rounder ceiling. The per-run budget is roughly three
times tier 2's 450 for the same reason — one tier-2-sized envelope per
epistemic class, each with its own required prose, the proven ones each
carrying a proof, plus the coverage record that decides whether an empty proven
list means anything at all. Both remain roughly a tenth of one tier-4 window,
which is the bound that actually matters.

### 6.2 What holds the budgets

Caps declared next to the projections, in the idiom `projections.ts` already
uses, and every one of them announcing its cut rather than making it silently:

- **Findings and reasons are capped per class** — 4 per class on the fleet
  call, 3 on the drill-down — and never against a shared budget. A shared cap
  would let a version with one broken tool and eleven prompt tweaks push its
  single *proven* reason off the end of the list, which is R2's defect arriving
  through the back door. Whatever is cut is counted (`provenDropped`,
  `indeterminateReasonsDropped`, …).
- **The fleet call caps prose far tighter than the drill-down.** A fleet row is
  a label — certainty, kind, subject, run count, and the way in — and the full
  sentence is one hop away. Fifteen rows at the drill-down's prose widths cost
  more than the entire fleet budget in prose alone, and would buy the same
  facts spelled out at length.
- **Every cap is in BYTES, not items.** The tier-3 citation bug (`docs/mcp.md`,
  "the fix caps BYTES, not citations") is the standing precedent: an item cap
  bounds a field only for as long as items happen to be small, and nothing
  bounds how long an engine-written sentence can get.
- **Proven findings are emitted earliest-first**, so the cut always falls on
  the tail and never on the first proven break (section 4).
- **`undecidedQuestion` gets the largest prose cap of any field on either
  tool.** A claim cut short is still a claim; a question with its subject cut
  off is unanswerable *and* unidentifiable. If a budget must give somewhere, it
  gives on a proven claim — which the caller can re-read in full from the run —
  before it gives here.

### 6.3 What is not compressed, at any budget

**The `certainty` discriminant, on every finding and every group, always.** Not
inferred from which array a thing appears in, not defaulted, not omitted
because it "can be derived from context", not dropped as a redundant constant
column by a columnar encoder.

That last one is a live hazard on this surface, not a hypothetical: `toColumnar`
in `packages/mcp/src/projections.ts` drops any column that is null in every row,
and a column constant within a list is exactly the shape a future compression
pass would target. The deeper argument is the one that decided it: the array
name is *context*, the field is *content*, and only the field survives an agent
lifting one finding out of the response and carrying it into its own reasoning,
a log line, or another tool call — which is exactly what an LLM consumer does
with a structured result. `packages/contracts` makes the same call on
`ProvenDivergenceReason.certainty` and says so.

**The per-dimension outcome, on the drill-down.** `byDimension` is the one
field that can say something about a dimension with *no findings in it at all*,
which no per-row attribution can ever do: `budgets: 'undeclared'` on an
otherwise-clean report is the most important sentence that report contains, and
it is invisible to any amount of reading the finding arrays. It is emitted even
on the clean case — where it costs proportionally the most, taking that scenario
from 82 to 119 tokens — precisely because the clean case is the one a caller
acts on without reading further. It is derived by contracts'
`divergenceByDimension`, never re-folded, so this surface cannot come to
disagree with the CLI about whether a dimension passed.

**The `complete` field, and the coverage record under it.** Both tools return a
top-level `complete` derived from the contract's
`isDivergenceAnalysisComplete` / `isFleetDivergenceAnalysisComplete` rather than
re-implemented — deliberately stricter than the nested coverage flag, because
there are two ways not to have looked and both count. The clean-case scenarios
are budgeted precisely so an "all clear" response cannot be quietly slimmed by
dropping the fields that make it meaningful; they are the responses most likely
to be acted on without reading further.

The precedent for paying tokens to keep an epistemic distinction is
`orderingBasis` (ADR-007, `docs/mcp.md` → "Ordering on a derived run"): nine
tokens, spent to make an uncertainty *resolvable* rather than merely unflagged,
justified explicitly by MCP being the one surface where a caller cannot go and
look at the run view instead. This is the same call at higher stakes and it
resolves the same way. **Where a budget and this rule conflict, the budget
gives**: cut a finding, cut a sample, cut a sentence — never the discriminant,
never `complete`, never the separation of the arrays.

**Correspondingly, the tool descriptions carry the semantics.** What "proven",
"speculative" and "indeterminate" mean, and the fact that a clean proven list
is not a safety claim, live in the descriptions — which an agent pays for once
per session — rather than in the responses, which it pays for on every call.
`check-token-budgets.ts` treats tool descriptions as the one consumer that
cannot run the script to check a stale figure; they are also the one consumer
that cannot read this ADR.

### 6.4 Pointers, and where there deliberately are none

Proven reasons carry a `next` pointing at the drill-down for a representative
run; the drill-down carries a `next` pointing at an event window around the
first proven break. **Speculative and indeterminate reasons carry no `next`, on
purpose.** Drilling into a representative run for a speculative reason returns
the same unprovable sentence one level down, having spent a whole tool call to
do it; for an indeterminate reason it returns the same unanswerable question.
Handing an agent a pointer implies there is something at the end of it. The
absence is the honest answer, and it is explained in the tool description
rather than paid for as a per-row field.

Neither tool takes a caller-raisable cap on findings or reasons: the published
cost is measured *at* the declared caps, and a caller-raisable cap makes a
published cost a fiction (the `afr_triage` `MAX_ITEMS` argument, unchanged).
Both take `targetVersionId` as a **required** argument — there is no "compare
against latest" default anywhere in this stack, because a gate whose subject is
implicit silently changes meaning the moment somebody publishes a new version.

### 6.5 The config-only tier: objection withdrawn, tool blocked on a read path

Team A's engine has three entry points and this surface maps onto two.
`convex/divergence.ts` `compareVersionConfigs` costs **zero run reads and zero
event reads**: every speculative finding depends only on the (baseline, target)
config pair, so it is identical across all 10,000 runs and is computed once. In
practice that is most of the answer, and it is free.

An earlier revision of this ADR objected to exposing it, on the ground that a
config-only tool can never produce a proven finding — proof requires run data,
by construction — so it would return `proven: []` on every call, and **an empty
proven array on a surface that cannot produce proof is a lie by shape**: an
agent cannot distinguish "we looked for proof and found none" from "proof was
never on the table here", and the first reading is the one that authorises a
deploy. The condition set was: no `proven` key at all rather than an empty one,
and a verdict that can never read `compatible`.

**`ConfigDivergenceReport` now satisfies that condition, and exceeds it.** It
has no `proven` field and **no `verdict` field at all** — omitted from the type
rather than made optional, because an optional field that must never be set is
a field that gets set. It carries `speculative`, `indeterminate`,
`analysableDimensions` and `coverage`. There is nothing left on it for a caller
to misread as a clean bill of health, and the shape-level lie is not
expressible.

**The objection is therefore withdrawn, and the tool should exist.** It is the
genuinely cheap first rung this pair otherwise lacks: for the cost of two config
reads, a caller learns what changed and — through `analysableDimensions` — what
a fleet scan could even prove about this version before spending one. That is a
real pre-flight, and "your target declares neither tools nor budgets, so a scan
can prove nothing about either" is worth knowing *before* the expensive call,
not after.

**It is not built for one reason only: there is no read path.** No
`FlightReader` method and no `/api/v1/**` route exist for it, and `packages/mcp`
holds no HTTP path of its own by design. That is a `packages/sdk` +
`apps/web` change, listed in section 8. This is a blocked decision, not an open
one — the design question is settled, and the tool should land the day the route
does, with its own budget scenario and fixture in the same change.

### 6.6 The budget landed with the tools

A tool registered on the server with no scenario in
`scripts/check-token-budgets.ts` fails as `NO_BUDGET`, by construction, because
the tool list is read from the server's own registry. Both tools ship with four
scenarios between them (worst case and clean case each), contract-maximal
fixtures in `tests/unit/mcp_budgets.ts` alongside the rest of the family, and
**eleven new maximality claims** — more than any other tier carries, because a
divergence report is a composed envelope and `checkMaximality` only inspects
the top level of whatever object a claim hands it. Claiming `DivergenceReport`
alone would have proved its four fields present and proved nothing about the
shapes nested inside them, which is where every byte actually is.

---

## 7. Alternatives considered

**Reuse the existing run-to-run diff (`packages/contracts/src/diff.ts`).** That
compares two *recorded* runs event by event. This feature has one recorded run
and one hypothetical version; there is no second event list to diff against,
and manufacturing one would require executing the target — the one thing the
method does not do.

**One `Finding` type with a `certainty` field.** Rejected in R1. It typechecks,
it is smaller, and it makes the defect invisible: no consumer is obliged to
read the field.

**Two classes instead of three.** Proposed in this ADR's first revision and
rejected once the contract landed. Section 3 is the argument: an engine with
nowhere to put an unanswerable question puts it somewhere worse.

**A single confidence score.** Rejected: it implies a scale where there are
kinds. A score invites a threshold, a threshold invites "high confidence = ship
it", and the top of that scale is a safety claim the method cannot support.

**A `verdict: "safe"` value.** Rejected under R4. There is no observation this
engine can make that establishes safety, so the value would be false exactly
when it mattered most — on a target with an incomplete snapshot, or a sampled
population.

**Storing divergence results.** Rejected under Event Log Rule 2. Caching for
cost is an implementation question for `convex/`, not a change to what is
source of truth, and any cache must be regeneratable and markable stale.

**Flattening the classes in the MCP layer only, to save tokens.** Rejected in
6.3, and worth naming as an alternative precisely because it is the one a
future contributor will reach for first: it is a small diff, it makes a budget
go green, and its cost is invisible in every test that measures bytes.

**Budgeting the per-run tool at tier 4's 10,000 by analogy.** Rejected in 6.1.
A ceiling derived from the shape of the ladder rather than from what the
response contains is not a ceiling.

---

## 8. What is still missing

The MCP tools are registered, typechecked, linted, budgeted and baselined, and
**they cannot yet answer a call**, because two layers under them do not exist:

1. **`apps/web/app/api/v1/**`** — `GET /api/v1/runs/:runId/divergence` and
   `GET /api/v1/agents/:agentId/divergence`, **and a configuration-comparison
   route** returning `ConfigDivergenceReport` — section 6.5's objection is
   withdrawn and that tier is wanted, blocked only on this and on the
   corresponding `FlightReader` method. Read-only, `x-api-key`-
   authenticated, `read` scope, the standard v1 envelope and rate class.
   `FlightReader` is written against the exact contract shape, so wiring these
   should require no SDK change; until then either method surfaces a
   `V1ApiError` with `kind: 'not_found'`, which this package maps to a fixed,
   non-disclosing message.
2. **`convex/`** — the engine, org-scoped like every other read function, plus
   the read-API functions the routes call. `convex/divergence.ts` and
   `convex/helpers/divergence.ts` were untracked files at pass 3 and are not
   relied on by anything asserted here.

Neither is in this boundary. Separately, `apps/web` currently fails `pnpm build`
because its divergence components still import `@/lib/divergence/types` after
that module moved into contracts — a mid-migration state that will resolve
itself, noted only because it is the one thing standing between this branch and
a green root build.

---

## 9. Open questions

- **Where do speculative reasons stop?** The alphabet is closed in type but
  open in spirit: any config field that differs could be a speculative finding,
  and an alphabet that grows to cover every field produces a report where
  everything is flagged and nothing is signal. A bound is needed and is not
  proposed here.
- **Does a fleet analysis sample, and how is that sample chosen?** The window
  record makes any sampling visible (R5), but recency-biasing a sample means
  the analysis over-represents current traffic patterns — both what an operator
  usually wants and a systematic blind spot for seasonal paths.
- **Cost.** A fleet analysis over 10,000 runs reads every run's events. Whether
  that is a bounded scan with a declared ceiling (the `PATTERN_SCAN_ROW_CEILING`
  pattern, with its honesty marker — which the contract's `DivergenceScanWindow`
  already anticipates) or a precomputed rollup (the ADR-002 pattern) is a
  `convex/` decision with a direct consequence for R5: precomputation adds
  staleness, which becomes another thing the result must declare rather than
  absorb.
- **Should `afr_assess_version` be reachable from `afr_triage`?** A regressed
  failure pattern and a proven version divergence are different questions, and
  cross-linking the two ladders may confuse more than it helps. Currently not
  linked; `tests/unit/mcp_triage.test.ts` records the decision.
