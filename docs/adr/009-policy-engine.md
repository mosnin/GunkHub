# ADR 009 — Declarative Policy over Recorded Runs, and Why It Must Never Gate Ingest

Status: **Accepted as the authorisation for this work.** Written *before* the
implementation, deliberately: the central ruling in section 3 is a constraint on
where the code may be put, and a constraint discovered after the code is written
is a rewrite rather than a design.

Date: 2026-07-25

**Verified against a tree that moved under it — read in two passes.**

- *Pass 1*, commit `2e1d194` ("Add budget circuit breakers"), working tree
  clean. `grep -ril policy` across `convex/`, `packages/`, `apps/` and `tests/`
  matched only budget breakers (`BudgetUnavailablePolicy`), retention policy
  (ADR-001) and CSP report policy — **no policy-engine implementation of any
  kind, in any boundary.** Sections 3, 4 and 6 were written against nothing.
- *Pass 2*, same commit, mid-write: `convex/helpers/policy.ts` (1,094 lines),
  a `policies` table in `convex/schema.ts`, and two adversarial test files
  landed as untracked work from another boundary. **Section 3's ruling was
  reached independently and identically** — that file's PART 1 states "A POLICY
  GATE MUST NEVER REFUSE, MUTATE, OR SUPPRESS AN EVENT" and gives the same
  reason. Section 4 was **not**: the engine keeps the state name this document
  set out to refuse, and defends it by a mechanism this document did not
  anticipate. §4.1 is rewritten around what landed, and the residual objection —
  narrower than the original, and still real — is recorded there rather than
  dropped. Section 7's limit 1 is sharpened against the implemented coverage
  proof.

`convex/policies.ts`, `convex/policy_gate.ts`, `convex/policies.test.ts` and
`packages/contracts/src/policy.ts` are referenced by the landed helper and **do
not exist**; see section 8. Per `CLAUDE.md` → Repo Conventions → Types, contracts
is authoritative on vocabulary — and the vocabulary is currently defined in
`convex/helpers/`, which its own PART 6 records as a known debt with a written
handover. Until that move happens this ADR and a Convex helper are the two places
the vocabulary is written down, and they must not be allowed to drift.

Relates to: ADR-0002 (the event log is canonical and immutable), ADR-0008
(projection execution model), ADR-0024 (event type openness), ADR-0020 / ADR-0022
(verification scope and vocabulary), ADR-001 (retention/erasure — deletes the
evidence this engine reads), ADR-002 (observability-grade derived data; the
`environment` field this engine scopes on), ADR-003 (the precedent for lifting
part of a freeze, and for shipping the safe half of a capability first), ADR-005
(the `scanTruncated` posture), ADR-007 (OTel provenance and ordering caveats),
ADR-008 (the three-class epistemics and the "no `safe` verdict" rule this
document extends), and `packages/contracts/src/budgets.ts` (the pre-flight seam
this reuses wholesale).

---

## 1. Context — the constraint being lifted

`CLAUDE.md` → "Not in v1" freezes **"Policy engine, compliance features, or audit
log export."** Two prior ADRs have lifted part of that section and then amended
it: ADR-002 (analytics/aggregate metrics) and ADR-003 (webhooks/external
integrations). This is the third such lift and follows the same form.

The capability directed for this cycle is **declarative policy over recorded
runs**: an org writes rules of the shape *"agent X may not call tool Y"* or *"no
run in environment Z may egress to host H"*, and the product answers two
questions about them —

1. **Retrospectively**, over runs already recorded: which runs violate this rule?
2. **Prospectively**, as a pre-flight the SDK may ask before acting: does the
   call I am about to make match a configured prohibition?

**Only the policy engine is unfrozen.** The other two items in that bullet —
"compliance features" as a general category, and **audit log export** — remain
frozen and are explicitly out of scope, in the same way ADR-002 lifted analytics
while leaving the policy engine frozen. Section 6, constraint 7 says why the
export half is the dangerous half and what would have to be true to lift it.

---

## 2. Decision

**A declarative policy engine that detects over recorded data and answers a
pre-flight question, and that has no presence whatsoever on the write path.**

Policy rules are org-scoped configuration. Evaluation is a **derived projection**
in the exact sense of Event Log Rule 2 — computed from the stored event sequence,
never written back, regeneratable at any time. Deleting every evaluation result
loses nothing but compute.

The two rulings in sections 3 and 4 are the spine of this document. Everything
else is mechanism, and neither ruling may be relaxed without a superseding ADR.

---

## 3. Ruling one — a flight recorder must never refuse to record a violation

**This corrects a prior direction in the roadmap for this work, which said policy
would be "enforced at ingest." That was wrong, and it is worth stating why in the
strongest available terms rather than quietly dropping it.**

Refusing to record a breach destroys the evidence of the breach. It is the one
failure mode that is unrecoverable, because the recorder is the only thing that
would have known. An ingest-time policy check converts the product's core promise
— *make failures explainable* — into its opposite at precisely the moment it
matters: the run that violated the policy is the run with no trace.

It is also self-defeating as enforcement. `packages/sdk` is a library inside
someone else's loop, not a supervisor above it (`packages/contracts/src/budgets.ts`,
invariant 1). Rejecting the *record* of an act does not prevent the act; the tool
call already happened, the HTTP request already left. All a rejection achieves is
that nobody can prove it. An org would then hold a clean policy report *because*
its agents misbehaved.

### The normative rules

**W1 — Ingest accepts exactly what it accepted before.** `sdkCreateRun`,
`sdkCreateEvents`, `sdkCreateArtifact` and their Clerk-session equivalents in
`convex/events.ts` gain no policy code, no policy import, and no new rejection.
The stable error-code alphabet (`packages/contracts/src/api_errors.ts`,
`docs/architecture.md` §5) gains no policy member. A run that violates every
configured rule ingests byte-identically to one that violates none.

**W2 — No policy evaluation runs inside an ingest transaction, even a
non-rejecting one.** This is stricter than W1 and the extra strictness is the
point: an evaluation that merely *throws* — on a malformed rule, a bad regex, a
resource limit — fails the surrounding insert and becomes an ingest-time refusal
by accident. The only permitted trigger is the one alerting already uses: the
terminal event **schedules** evaluation after the write commits
(`convex/events.ts` / `convex/sdk_ingest.ts` → `alert_engine`, `docs/architecture.md`
§8). Scheduling is not gating.

**W3 — The pre-flight answer is advisory and the SDK owns the decision.** The
backend returns facts about rules; it never returns `allow`/`deny`. This is
`convex/budget_gate.ts`'s rule verbatim, and for its stated reason: a backend that
returned "proceed" would be making a risk decision on behalf of a customer whose
risk it does not know, and would give a compromised deployment a single field to
flip.

**W4 — No field may claim the act was prevented.** `FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS`
in `packages/contracts/src/budgets.ts` applies unchanged and its list should be
shared, not forked: `enforced`, `blocked`, `halted`, `stopped`, `prevented`. "The
SDK returned deny" and "the call did not happen" are different facts and we own
only the first. A `policyEnforced: true` on a compliance report is the exact
sentence an auditor is asking about and the exact one nobody can support.

**W5 — There is a test, not just a paragraph.** The guard for W1/W2 is a
backend test that ingests a run violating every configured rule and asserts the
stored events are identical to the no-policy case. Without it, W1 is a comment,
and the first contributor who wants "just a warning at ingest" will not read it.

**The two halves depend on each other.** A pre-flight only has teeth *because*
recording is unconditional: the sole thing that makes "the agent asked, was told
a prohibition matched, and proceeded anyway" visible to anyone is the run that got
recorded regardless. Gating ingest would delete the evidence that the advisory
seam was ignored — which is the only evidence that an advisory seam produces.

---

## 4. Ruling two — what the engine may claim, and one correction to the brief

The evidential asymmetry here is **the reverse of the budget breaker's**, and the
reversal is what bounds the feature.

`compareSpendToLimit` (`packages/contracts/src/budgets.ts`) can return
`provably_under`, because spend is a reconciled number and being under a limit is
a decidable property of it. A policy has no such green. **A violation is a
positive fact in an append-only log** — an event exists showing the forbidden call
happened, and no later event can retract it. **Compliance is a claim about
absence**, and absence in this log is not a fact about the world. It is a fact
about what was recorded.

### 4.1 The three states, and one objection that was raised, answered, and partly survives

The vocabulary is **`violated` / `not_evaluable` / `satisfied`**, as landed in
`convex/helpers/policy.ts`:

| State | Claim | Warrant |
|---|---|---|
| `violated` | "Run R called `send_email` at sequence 42. Policy P denies it." | The recorded event log. A positive fact about a stored row, which no incomplete scan can un-record. Decided **first**, before any completeness test — a proof does not become less true because something else went unread. |
| `not_evaluable` | "Whether run R called `send_email` — we could not decide." | A named gap in the *inputs*: the deciding payload was externalized, the log read hit a ceiling, the run is still in flight. Not a finding about the run at all. |
| `satisfied` | "This terminated run's log was read to its end, every relevant payload was legible, and none records a denied operation." | A five-literal `PolicyCoverageProof`. |

The rules of ADR-008 §3 apply and the implementation honours them: the states are
**separate types with deliberately non-overlapping field names**
(`violatedPolicyId` / `satisfiedPolicyId` / `undecidedPolicyId`), so `??`-chaining
one into another does not compile (R1); they are **never merged into one count**
(R2); truncation and in-flight runs are **first-class fields, not absences** (R5);
and a `FORBIDDEN_COMPLIANCE_CLAIMS` guard bans "compliant", "clean", "passed",
"no violations" from `not_evaluable` prose (R6).

**This ADR set out to refuse the name `satisfied`**, on ADR-008's R4 ("no green
that outranks unknown") and §5 ("there is no `safe` in the vocabulary at all"),
proposing `no_violation_found` instead. That objection is **mostly answered by the
mechanism that landed**, and the answer is better than the rename would have been:

- `satisfied` is **unconstructible** without `PolicyCoverageProof`, whose five
  fields are literal-typed (`logReadComplete: true`, `payloadsAllReadable: true`,
  `runIsTerminal: true`, `crossOrgRowsSkipped: 0`, `forbiddenOperationsFound: 0`).
  A caller holding a truncated read, an unreadable payload or an in-flight run
  **cannot spell** the outcome. It is a compile error, not a convention, and there
  is no fallback path to it.
- The proof's discriminator is `proves: "complete_log_read_found_nothing"` — a
  statement about the search, which is exactly what the rename was for.
- The required `satisfiedBecause` prose ends by naming the limit inline: *"an
  operation that was never recorded — by an uninstrumented code path, or outside
  this product entirely — is not in the log and is not covered by this finding."*

A rename on top of that machinery would have bought nothing. **The objection is
withdrawn as to the type.**

### 4.2 What survives: the name travels where the proof does not

The residual risk is narrower than the original objection and it is not
theoretical. `summarisePolicyOutcomes` in the same file emits **`satisfiedCount`**.

A count is the one form in which this vocabulary leaves the type system. The
proof does not aggregate, the prose does not aggregate, the disclaimer about
uninstrumented code paths does not aggregate — **the word does.** `satisfiedCount:
12` on a dashboard, in an API response, or pasted into a security questionnaire is
precisely the figure section 5 is about, and every safeguard above it is a field
that figure does not carry. The engine is honest per run and the aggregate is
where the honesty is spent.

So the constraint this ADR places on layers **above** the engine, which do not yet
exist and are where the exposure is:

- **No surface may render a bare `satisfiedCount`.** It appears only alongside
  `notEvaluableCount` and `violatedCount`, never as a standalone figure, never as
  a percentage, never as a ratio with `not_evaluable` in the denominator.
- **No layer may translate `satisfied` into "compliant", "passing", "clean" or a
  green tick.** `FORBIDDEN_COMPLIANCE_CLAIMS` currently applies only to
  `not_evaluable` prose, which is correct for the engine and insufficient for a
  UI: the guard bans the *word*, and a green tick is the word rendered as a
  glyph.
- **A rollup may report counts per state; it may never report a verdict word
  meaning "compliant"**, because no such verdict is derivable from the states
  beneath it.

### 4.3 The one case where an unreadable payload still proves a violation

A genuine capability this ADR's first draft did not anticipate, and it is worth
stating as a rule because the boundary is as important as the rule.

Against a policy naming specific tools, an externalized `tool.call` is
`not_evaluable` — the name is gone, the call might have been to a permitted tool.
**But when the rule denies the operation itself** (`deniedTools` absent: "may not
call *any* tool"; `deniedHosts` absent: "may not egress *at all*"), the event
**type** alone decides it, and the type survives externalization. Which tool it
was cannot change the answer, because nothing is permitted.

This is ADR-008 §5.1b's `{ declared: 'none' }` insight reached independently and
from the other side: a complete claim converts an absence into a decidable fact.
**The boundary is `deniedTools === undefined`, never "some tools are denied"** —
against a rule naming even one tool the engine must still decline, and a
contributor who widens this guard has manufactured proofs.

### 4.3 What the pre-flight may claim, and why it is the stronger half

The pre-flight is epistemically *better* than the retrospective evaluation on the
one call it is asked about, and *worse* about everything else — and both halves of
that need saying.

Better: the caller supplies the tool name or target host it is about to use. That
input is complete by construction. There is no externalization, no missing
instrumentation, no sampling. Matching a supplied name against a configured
prohibition is decidable.

Worse: it decides *that call*, under *the rules configured at that instant*, from
*the fields the caller chose to supply*. It says nothing about the run, and it
binds nothing — the call actually made may differ from the call described (§7,
limit 7).

So the answers are `prohibition_matched` and `no_matching_prohibition`, and the
second is scoped in its own name to the rules and fields involved. There is no
`allowed`. Following `budgets.ts` invariant 2 exactly, **"I asked and no
prohibition matched" and "I could not ask" are different types sharing no field**,
the unreachable-server behaviour is a **required explicit parameter** rather than a
default buried in a catch block, and the weakening arms require the caller to
write down `acceptedRisk` in prose. A single `ok: true` would make an org whose
answers are 100% "could not ask" look identical, on every graph, to an org with a
working pre-flight.

---

## 5. Why a false clean is worse here than anywhere else in this product

This section is the reason the constraints in section 6 are stricter than
ADR-002's, and it is not a matter of taste.

Every other incomplete answer in this system misleads **an engineer**: a truncated
pattern scan, an approximate usage counter, an `indeterminate` divergence verdict.
That engineer has recourse. They can page the cursor, open the run view,
recompute from the log, ask again. The person misled is the person who can check,
and the gap closes on its own.

**A compliance surface is the first output of this product intended to leave the
building.** "No policy violations in Q3" is read by an auditor, a customer's
security review, a procurement questionnaire — a reader who has no access to the
event log, does not know that `http.request` events exist only where an engineer
called the builder, and is relying on the claim *precisely because* they cannot
check it themselves.

**The person relying on the answer is not the person who could have checked it.**
That severance is what turns an observability-grade approximation into a
misrepresentation. ADR-002 established that approximate is fine for counters —
"never a substitute for the event log as source of truth" — and that standard is
correct there and **insufficient here**. An approximate counter that is wrong
embarrasses a dashboard. An attestation that is wrong is relied upon by someone
who had no way to know.

Every constraint below follows from this paragraph, not from tidiness.

---

## 6. Constraints the lift is conditional on

Non-negotiable in the same sense as the Event Log Rules and Tenancy Rules.

1. **Never on the write path.** Section 3, W1–W5. This is the constraint the
   whole lift is conditional on; violating it un-lifts the freeze.

2. **Org-scoped.** Every rule, evaluation and pre-flight answer is scoped to one
   organization, per Tenancy Rules 1–3. A rule may not reference cross-org data
   and an evaluation may not read outside the caller's org. The pre-flight is
   API-key authenticated and inherits the key's `orgId`, exactly as
   `convex/budget_gate.ts` does.

3. **Admin-managed rules, snapshotted into the audit log.** Creating, editing,
   deleting or disabling a policy is an admin-role-only mutation written to
   `audit_log` (Event Log Rule 6, ADR-003 constraint 2), **with the full rule
   snapshotted into the audit row**, so a deleted policy's terms remain
   reconstructible from the append-only log alone. Every definition carries a
   `revision`, bumped on every rule or subject change and stamped onto every
   outcome, so a report and a rule that disagree are *detectable* rather than
   silently reconciled — an evaluation necessarily applies today's rule to a run
   that finished last month, which is a legitimate question and a dishonest one
   if the rule can change underneath a report someone already read.

4. **Outcomes are not stored at all.** Stronger than "derived, never source of
   truth", and the landed schema is right to go further than this ADR's first
   draft, which would have permitted an append-only findings table. **No
   `lastEvaluatedAt`, no `violationCount`, no cached verdict, no findings
   table.** An outcome is a derived projection (Event Log Rule 2) computed at
   query time. Storing one creates a compliance figure that can disagree with
   the log it came from — and per section 5, that figure is the one somebody
   would attest to. If caching is ever introduced for cost, it must be
   regeneratable, markable stale, and its staleness declared in the result
   (ADR-008 §9), never absorbed.

5. **Coverage is mandatory on every result, and strictest on the clean one.**
   Following ADR-008 R3/R5 and `docs/mcp.md` → "An unfinished scan is not a clean
   scan": every result names the runs scanned, the runs not scanned and why, and
   the dimensions the rule could not be evaluated over. An empty violation list
   with a non-empty coverage gap is not a clean bill of health and no layer — API,
   CLI, UI, MCP — may present it as one. **The clean-case response is the one most
   likely to be acted on without reading further, so it is the one where these
   fields may never be slimmed away.**

6. **The pre-flight requires `ingest:write`, not `read`, and consumes no ingest
   rate budget.** Both for `budget_gate.ts`'s reasons: it is semantically part of
   the write path the key already holds, so requiring `read` would break every
   key scoped exactly `["ingest:write"]`; and a caller must never be discouraged
   from asking, nor able to exhaust its own ingest allowance by asking.

7. **No attestation surface this cycle.** No signed report, no PDF, no
   "compliance export", no audit-log export — that last remains frozen in
   `CLAUDE.md` and is untouched by this ADR. This mirrors ADR-003's split: ship
   the half whose blast radius is understood, defer the half that reaches a third
   party. Lifting this requires a superseding ADR that answers, at minimum: what
   the document asserts in words, what coverage it is required to print
   *alongside* the headline rather than in a footnote, and who is accountable
   when it is wrong. Until then the output is an engineering view for people who
   can open the runs behind it.

8. **`packages/mcp` stays read-only.** Policy evaluation results are readable
   through the MCP surface under the existing rules (`CLAUDE.md` → System
   Boundaries): no rule mutation, no `convex/` import, `/api/v1/**` with a `read`
   key. **The pre-flight tool does not belong in `packages/mcp`** — it requires
   `ingest:write` (constraint 6), which that package must never hold. It is a
   `packages/sdk` seam, like `BudgetGuard`.

9. **Additive schema only.** New tables; any new field on an existing table is
   optional. No migration, per ADR-002's precedent.

---

## 7. What this engine cannot know

Deliberately longer than the section describing what it can do, and the more
important of the two. Each of these is a boundary a future contributor will
otherwise rediscover by shipping a wrong answer to someone who believed it.

**1 — Absence of an event is not absence of the act, and the coverage proof
cannot see this.** `Events.httpRequest` (`packages/sdk/src/events.ts:69`) and
`Events.toolCall` are **manual builders**. There is no `fetch` interception, no
monkey-patching, no auto-instrumentation anywhere in `packages/sdk/src`. An agent
that egresses without calling the builder produces a run with zero `http.request`
events — byte-identical, to this engine, to a run that touched no network at all.

**This is the limit that `PolicyCoverageProof` does not and cannot cover, and it
is the sharpest thing in this section.** Its five fields —
`logReadComplete`, `payloadsAllReadable`, `runIsTerminal`, `crossOrgRowsSkipped`,
`forbiddenOperationsFound` — are all properties of *the read*. Every one can be
satisfied over a run that egressed to a forbidden host through an uninstrumented
`fetch`. The proof establishes **"we read the whole log and it contains no denied
operation"**, which is exactly what its discriminator
(`complete_log_read_found_nothing`) says and exactly what its prose admits. It
does **not** establish that no denied operation occurred, and no field it could
gain from reading harder would change that: the missing fact was never written.

**There is no sixth field available.** A `recordingComplete: true` would have to
be *asserted by the agent*, not observed by us — which is the `agent_config.ts`
pattern from ADR-008 §5.1b: **completeness is claimed, never inferred.** An agent
that declares it routes all egress through the recorder makes absence meaningful
*for that agent*, the same way `{ declared: 'none' }` makes an empty tool list a
checkable claim. **That declaration does not exist today**, so today every
`satisfied` on an `egress_denied` policy rests on an unstated assumption of
complete instrumentation. Adding it is the single highest-value follow-up this
feature has, and until it lands §4.2's constraints on aggregate rendering are
doing the load-bearing work.

A contributor tempted to close this gap in the engine should note ADR-008 recorded
the identical temptation for `capability_removed` and reached the identical
verdict: **closing it needs a declaration, not a cleverer evaluator.**

**2 — Externalization removes the deciding field.** Event Log Rule 3 sends any
payload over 10 KB to blob storage, leaving `{ type: "_externalized",
originalType, _artifact: {...} }`. `originalType` survives; `ToolCallPayload.name`
and `HttpRequestPayload.url` do not (ADR-008 §5.1). **A policy about tool names
therefore cannot be evaluated over exactly the runs with the largest payloads**,
which are disproportionately the interesting ones. This is `not_evaluable`, not a
pass. If a future engine fetches artifacts to close this, that is a cost change
and a coverage change and must be declared in the result — it is not a silent
improvement.

**3 — `environment` is a label the client chose, not a trust boundary.**
ADR-002 defines it as a free-form string up to 32 characters, stamped from the API
key or supplied by the caller, "not validated beyond a length bound — the value is
opaque to the backend." A rule scoped to `environment: "production"` is scoped to
a self-report. An agent that mislabels its environment is outside every rule
scoped that way, and nothing in this system detects it. Any surface that renders
"no violations in production" is rendering "no violations among runs that said
they were production."

**4 — OTel-derived runs are evaluated at one remove.** Per ADR-007, a span that
matched no mapping rule is recorded as `otel.span.unmapped` — kept visible
precisely because it mapped to nothing, which also means its content is not in a
typed payload this engine can read. A policy over such a run is evaluating a
mapper's output, not the agent's acts, and `sequenceNumber` on those runs is
arrival order, not occurrence order. Anywhere a policy result cites a *position*,
ADR-007's `orderingBasis` caveat must be forwarded, not swallowed.

**5 — Retention deletes the evidence.** ADR-001 permits an org's opt-in retention
window to purge runs — the sole sanctioned exception to "events are never
deleted." A policy report over a period whose runs have aged out finds nothing,
honestly and uselessly. **The retention horizon is a coverage fact and must be
named in the result**, because the state where a compliance report goes clean *by
elapsed time* is the one that will happen without anyone deciding it.

**6 — Sampling means a violating run may never have been recorded.**
`packages/sdk/src/sampling.ts`; see `docs/architecture.md` §9 for its effects on
derived data. A sampled-out run is invisible to the engine and to its coverage
record alike, since nothing was written to count.

**7 — The pre-flight decides a description, not an act.** It answers about the
call as *described* by the caller. Nothing binds the description to the call
subsequently made, and nothing re-checks. This is an ordinary time-of-check /
time-of-use gap and it is unclosable from inside a library: the SDK cannot observe
what its caller does after `check()` returns (`budget-guard.ts`, "WHAT THIS CLASS
DOES NOT DO, AND CANNOT"). It is also the reason W1 matters — the recorded run is
the only thing that can ever contradict the description.

**8 — A rule matches a string, not a capability.** "May not call tool Y" compares
names. A renamed tool with an identical implementation escapes the rule; two
unrelated implementations sharing a name are conflated; a tool invoked indirectly
through another tool is invisible. This is ADR-008's "compares declarations, not
behaviour" in a compliance costume, and it means a `satisfied` is conditional on
the naming being an accurate description — an ingest-time property, not an
analysis-time one, and one no coverage proof inspects.

**9 — A rule that has never fired is indistinguishable from a rule that is
broken.** A malformed matcher, a rule scoped to an agent id that no longer exists,
a rule referencing an event type the SDK never emits: each produces a permanently
empty violation list that looks exactly like compliance. Rules must therefore
report whether they were *evaluable at all*, per rule, on every result. A rule
that could not be applied to a single run is a `not_evaluable` rule, and it is the
single most likely cause of a falsely clean report in ordinary operation.

---

## 8. Consequences

- `CLAUDE.md` → "Not in v1" is amended in the same change: **"Policy engine"** is
  struck and replaced with a pointer here; **"compliance features"** and **"audit
  log export"** remain frozen (constraint 7). This is the split ADR-002 used when
  it lifted analytics but left the policy engine standing.
- `docs/architecture.md` gains the policy engine in its scheduled-jobs picture and
  — more importantly — an explicit statement in §3 that the write path is
  unchanged, so a reader of the invariants cannot conclude otherwise.
- **The vocabulary is in the wrong boundary, and this is tracked debt, not an
  exception.** `CLAUDE.md` → Repo Conventions → Types requires shared entity
  types to live in `packages/contracts` only. The three states currently live in
  `convex/helpers/policy.ts`, whose own PART 6 records the reason (contracts
  belongs to another team and was out of scope, so the alternative was no
  definition) and the handover: move its PART A–C into
  `packages/contracts/src/policy.ts`, then delete and import — exactly as
  `helpers/budget.ts` did. It is currently safe because no name collides with an
  existing contracts export, so there is nothing that can yet drift. **The
  failure mode to avoid is creating a second copy in contracts and leaving this
  one in place** — one certainty boundary with two definitions is a boundary that
  can silently disagree, which this repository has already paid for three times.
  Until the move, this ADR and that helper are the two places the vocabulary is
  written down; a change to either must update the other.
- The engine is a new read cost over the event log. Whether it is a bounded scan
  with a declared ceiling (the `PATTERN_SCAN_ROW_CEILING` pattern, honesty marker
  included) or a precomputed rollup (the ADR-002 pattern) is a `convex/` decision
  with a direct consequence for constraint 5: **precomputation adds staleness,
  which becomes one more thing the result must declare rather than absorb.**
- Most policies over most orgs will return `not_evaluable` at first, and that is
  the correct behaviour, not a defect to be tuned away. Per ADR-008 §5.1b, the
  remedy is usually a declaration or a re-read, not a tuned threshold. The landed
  engine already carries this as **`wouldBeEvaluableBy`** on every
  `not_evaluable` outcome ("re-evaluate once the run records `run.completed` or
  `run.failed`", and so on). It is the only actionable field on the response and
  must be forwarded by every layer above, not summarised away. The declaration it
  cannot yet name is the instrumentation-completeness claim of §7 limit 1, which
  does not exist to point at.
- The pre-flight adds a second SDK seam that does something other than record.
  The first (`BudgetGuard`) established the pattern; this one must reuse it rather
  than re-derive it, including the forbidden-claim field list.

---

## 9. Alternatives considered

**Enforce at ingest.** The original direction. Rejected in section 3: it destroys
the evidence of the breach it claims to prevent, and prevents nothing, because the
act has already happened by the time the record arrives.

**Enforce in the SDK, hard — throw on violation.** Rejected. `budget-guard.ts`
invariant 1 already settled it: an exception from an enforcement path inside
someone else's `try/catch` is an enforcement outcome nobody chose, and it is the
permissive one. Returning a value is strictly safer than throwing, in a library.

**Renaming `satisfied` to `no_violation_found`.** This ADR's original position,
**withdrawn in §4.1** once the type-level `PolicyCoverageProof` landed: a name
that hedges buys less than a constructor that cannot be called without proof, and
having both would suggest the name was the safeguard. What survives the
withdrawal is §4.2 — the name outlives the proof the moment it is counted.

**A bare `satisfied`, with no coverage proof.** Rejected, and it is worth naming
separately from the above because it is the shape the feature would have taken
without ADR-008's precedent: it is `verdict: "safe"` under a compliance hat, and
it would be false in exactly the case that matters — a policy over a run whose
`tool.call` payloads were all externalized past the 10 KB ceiling.

**Two states (`violated` / `not_violated`).** Rejected for ADR-008 §3's reason,
which applies with more force here: an engine with nowhere to put an unanswerable
question files it somewhere worse, and the safe-looking bucket is where it lands.

**A compliance score, or a percentage-compliant figure.** Rejected. It implies a
scale where there are kinds, it invites a threshold, and a threshold over a metric
whose denominator is "runs we could read" is a number that improves when
instrumentation gets worse.

**Reuse `alert_rules` for policy rules.** Rejected. An alert fires on a condition
and is a notification; a policy violation is a durable finding about a run that
must survive, be citable, and never be edited by the party it embarrasses
(constraint 3). Overloading the alerting table would put those findings under a
row whose `deliveryStatus` is patchable by design (ADR-002).

**Ship an attestation/export surface now.** Rejected in constraint 7, following
ADR-003's precedent of shipping the safe half first. The engine's honest output is
currently a list of states and a coverage record; the work of turning that into a
sentence a third party may rely on has not been done, and doing it implicitly by
adding a "Download report" button is how it would get done badly.

---

## 10. What exists, and what does not

The backend landed in stages while this was written; the state below is as of the
final pass and should be re-checked, not trusted.

**Exists.** `convex/helpers/policy.ts` (the vocabulary, `foldPolicyOutcome`,
`isPolicyCoverageComplete`, the bounds, the compliance-claim guard); the
`policies` table with `by_org` / `by_org_enabled`; `convex/policies.ts` (the I/O
half and admin CRUD) and an `convex/audit.ts` change alongside it;
`convex/policy_gate.ts` — **which requires `ingest:write` and returns definitions
rather than a verdict, exactly as constraint 6 and W3 require**; and three
adversarial test files under `tests/unit/`.

**W5 is satisfied, under a different filename.** Comments in the landed code point
at a `convex/policies.test.ts` that does not exist; the assertion they describe
lives in `tests/unit/policy_adversarial_ingest.test.ts`, which proves a forbidden
tool call is accepted and durably stored with its name intact, that forbidden and
allowed calls produce *indistinguishable* ingest outcomes, and that a run made
entirely of forbidden calls still terminates normally. It also proves the harness
can see a refusal at all, which is what keeps the other three from passing
vacuously. **The stale filename in those comments should be corrected**, because a
future contributor who greps for the named file will conclude the guard is
missing.

**Does not exist.**

1. **`packages/contracts/src/policy.ts`** — see section 8. The vocabulary is
   still in `convex/helpers/`.
2. **The instrumentation-completeness declaration** of §7 limit 1 — the only
   thing that would make `satisfied` on an `egress_denied` policy mean what its
   name says.
3. **Every read surface**: no `/api/v1/**` route, no `FlightReader` method, no
   CLI command, no UI, no MCP tool. **Nothing outside `convex/` can reach any of
   this**, which is also why §4.2's constraints on aggregate rendering are not
   yet violated by anything — they bind the layer that has not been built.

## 11. Open questions

- **How is a rule expressed?** This ADR fixes what a rule may *claim*, not its
  syntax. A matcher language rich enough to be useful is rich enough to be slow
  and to fail in ways that produce limit 9's silent empty result; the bound is not
  proposed here.
- **Does retrospective evaluation run over all history or a window?** ADR-008's
  open question about fleet sampling applies unchanged, and recency-biasing has the
  same shape of blind spot.
- **Does a violation fire an alert?** The wiring exists (ADR-003) and the
  temptation is obvious. It is not authorised here: an alert is a delivery with a
  patchable status, and coupling a durable finding to one needs its own decision.
- **What happens when a rule is edited?** Findings cite the rule that produced
  them; an edited rule makes historical findings cite something that no longer
  exists in that form. Rule versioning is probably required and is not specified.
