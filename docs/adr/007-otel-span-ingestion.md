# ADR 007 — OpenTelemetry Span Ingestion and Derived Sequence Numbers

Status: **Proposed — decision NOT settled.** The provenance types and the
adversarial ordering suite have landed; the span→event mapping, the sequence
synthesis, and the Convex schema change have not. The adversarial suite has
**confirmed the impossibility case** (see the open question below): time-ordering
and append-only cannot both hold across multi-batch arrival. That narrows the
decision to two sound outcomes but does not pick one, and neither has been
built or tested against a real mapper. Do not build on this as though it were
Accepted.

Date: 2026-07-25

**Verified against — read twice, because the tree moved mid-write:**

- *Pass 1*, commit `b15e921` ("Enforce the token budgets, and stop trusting a
  partial build"), clean tree. The repository contained **zero** occurrences of
  `opentelemetry`, `otlp`, `otel`, `genai`, `spanId`, or `traceId` outside
  `node_modules`/`.next`. Nothing had landed.
- *Pass 2*, same commit plus uncommitted working-tree changes to
  `packages/contracts` (version `0.10.0` → `0.11.0`, new
  `packages/contracts/src/provenance.ts`, and edits to `entities.ts`,
  `events.ts`, `api.ts`, `index.ts`). This is the provenance work. `convex/` was
  **untouched** at both passes — verified via `git status --short convex/`
  returning empty and `grep -rn "otel" convex/` returning nothing.

- *Pass 3*, same commit, after two further untracked files appeared:
  `tests/unit/otel_ordering_adversarial.test.ts` (1301 lines) and
  `tests/unit/otel_provenance.test.ts`. Executed via
  `npx vitest run` in `tests/`: **62 passed, 31 skipped, 0 failed.** The 31
  skips matter — see the caveat under the open question. `convex/` was still
  untouched.

Every code claim below names the file it was read from. Claims about `convex/`
describe committed code at `b15e921`; claims about `packages/contracts` and
`tests/` describe the uncommitted pass-2/pass-3 state and will need re-checking
once committed.

Relates to: ADR-0002 (event log is canonical and immutable), ADR-0007
(ingestion idempotency — the `(runId, sequenceNumber)` key this ADR stresses),
ADR-0024 (event `type` openness — see the stale-ADR note under Constraints),
ADR-0017 (stale run expiry — the 24-hour ceiling described below), ADR-001
(retention/erasure, the only sanctioned deletion path)

---

## Context

We want to accept OpenTelemetry GenAI spans over OTLP and derive Agent Flight
Recorder events from them, so that an agent already instrumented with OTel gets
a flight recorder without adopting `@agent-flight-recorder/sdk`. This is a third
ingest path alongside the two that exist today (`docs/architecture.md` §5).

This requires an ADR rather than a doc page because it collides directly with
three of the six Event Log Rules in `CLAUDE.md`, which that file marks
non-negotiable and changeable only by formal ADR. The collisions are not
stylistic. They are structural, and they are described below in terms of what
the code actually does.

### Rule 4 — sequence numbers

`CLAUDE.md` Rule 4: sequence numbers are contiguous integers from 1, assigned by
the SDK, validated by the backend. The backend really does validate this.
`convex/sdk_ingest.ts` `sdkCreateEvents` loads the run's highest stored
`sequenceNumber` and throws the stable code `SEQUENCE_CONFLICT` unless the
incoming event is exactly `state.maxSeq + 1`. There is no gap tolerance and no
reordering window.

OTel guarantees none of the inputs this needs. A span carries a start and end
timestamp from the emitting process's clock, a `span_id`, and a `parent_span_id`
— it carries no ordinal, no total order across siblings, and no count of how
many spans the trace will ultimately contain. Deriving a contiguous ordinal from
1 is therefore a **synthesis** step with no counterpart in the SDK path, and it
is a mechanism the Event Log Rules do not currently describe.

### Rule 5 — first and terminal events

`CLAUDE.md` Rule 5, enforced in `convex/sdk_ingest.ts`: when a run has no events
(`state.maxSeq === 0`) the first event's type must be `run.started`; once a
terminal event is stored nothing further may be appended (`RUN_NOT_ACTIVE`), and
storing the terminal event also patches the run's `status`/`endedAt`.

OTel has no concept of either. The nearest analogue to both is the trace's root
span, and a root span is the **last** span an exporter typically emits, because
it does not end until its children have. It may also arrive out of order, arrive
after an arbitrary delay, or never arrive at all — a crashed process exports the
children it already batched and never closes the root.

### Rule 1 — append-only and immutable

`CLAUDE.md` Rule 1: no update or delete mutation exists for events. Confirmed —
`convex/schema.ts`'s `events` table has no update path, and ADR-001 established
that the only sanctioned deletion is whole-run retention or whole-org purge.

OTLP exporters retry on failure, and a trace's spans arrive across multiple
batches by design. Under an immutable log, a retry that yields a *second* event
for a span already recorded, or the *same* span recorded at a *different*
sequence number, is not a transient glitch that a later write corrects. It is
permanent corruption of the artifact the product exists to make trustworthy.

---

## Constraints (verified, and true regardless of which decision we reach)

Properties of the code as read at the passes above — `convex/` at `b15e921`,
`packages/contracts` and `tests/` in the pass-2/pass-3 working tree. Any design
has to satisfy them or explicitly change them.

**C1 — The existing idempotency guard does not cover spans.** ADR-0007 fixed the
idempotency key as `(runId, sequenceNumber)`, and `convex/sdk_ingest.ts`
implements exactly that: it queries the `by_run` index for
`(runId, evt.sequenceNumber)` and returns the existing `_id` if found. That is
sufficient for the SDK, whose retries resend the *same* event with the *same*
ordinal. It is **not** sufficient for OTLP, where a retried span may be assigned
a *different* derived ordinal if other spans landed in between. Such a retry does
not collide, so it is not deduplicated — it inserts a second event for one span.
Deduplication for this path must therefore key on something span-identifying,
which leads directly to C2.

**C2 — The span id now has a contract but still has nowhere to be stored, and
the two sides are currently out of sync.** As of pass 2, `packages/contracts`
defines `EventProvenance` (`provenance.ts`) — a closed `sdk | otel` union whose
`otel` arm carries `traceId`, `spanId`, `parentSpanId`, `spanName`,
`semconvVersion`, `mapperVersion`, `lossy`/`lossReasons`, and a `receivedAt`
distinct from the span-clock `timestamp` — and adds an optional
`Event.provenance` (`entities.ts`).

`convex/schema.ts` has **not** changed. The `events` table still has exactly
seven fields (`runId`, `orgId`, `type`, `sequenceNumber`, `timestamp`,
`payload`, `parentEventId`) and one index, `by_run` on
`["runId", "sequenceNumber"]`. So today there is still no column to store a span
id in and no index that could answer "have I already recorded this span?"
without scanning the run.

This is not a theoretical gap — it is currently a **failing gate**. Running
`scripts/check-schema-drift.ts` at pass 2 reports:

```
  ✗  events ↔ Event
       "provenance" is in contracts but missing from convex/schema.ts
Schema drift detected.
```

`./scripts/validate.sh` therefore does not pass in the working tree as it stands.
Closing this requires the additive `convex/schema.ts` field plus an index
suitable for span-keyed dedupe, which is the Convex-side work that has not
landed.

**C3 — There is a hard 24-hour ceiling on trace assembly, and it is
one-directional.** `convex/stale_runs.ts` sweeps runs still in `status:
"running"` whose `startedAt` is older than `STALE_RUN_TIMEOUT_MS`
(`convex/helpers/pagination.ts` — verified `24 * 60 * 60 * 1000`), and patches
them to `timed_out`. It does **not** append a terminal event; it patches status
directly. Meanwhile `sdkCreateEvents` rejects any genuinely new event when
`run.status !== "running"` with `RUN_NOT_ACTIVE`. The consequence for this path:
a trace whose spans are still arriving 24 hours after its run was created has its
run closed out from under it, and every subsequent span for that trace becomes
permanently unappendable. Nothing reopens a `timed_out` run.

**C4 — The derived event type must come from a closed set, and that set has
just diverged.** `convex/sdk_ingest.ts` checks `VALID_EVENT_TYPES` — a set of 17
literals (`run.started`, `run.completed`, `run.failed`, `run.cancelled`,
`llm.*`, `tool.*`, `memory.*`, `retrieval.*`, `http.*`, `custom`) — and rejects
anything else. At pass 1 that set mirrored `EventType` in
`packages/contracts/src/events.ts` exactly.

At pass 2 it no longer does. Contracts added an 18th type,
`otel.span.unmapped`, with an `OtelSpanUnmappedPayload` recording spans that
matched no mapping rule (rather than dropping them — the right call, and for the
right reason: a silently-dropped span is indistinguishable to a debugging
engineer from a span that never happened). `convex/sdk_ingest.ts` and
`convex/events.ts` still carry the 17-literal set and both carry a `MUST stay in
sync` comment; `docs/architecture.md` §3 item 5 documents the mirroring
obligation. **Until the Convex side is updated, an `otel.span.unmapped` event
cannot be written through `sdkCreateEvents`.** Whether the OTel path should go
through `sdkCreateEvents` at all is itself undecided (see below), but if it does,
this must be closed in all three places.

> **Stale-ADR note.** ADR-0024 (`docs/adrs/0024_event_type_openness.md`, dated
> 2026-07-16) records the decision that `events.type` is *intentionally open* and
> that `EventType` is "not a closed whitelist of everything that may be
> recorded." The validator is still `v.string()` as that ADR says, but
> `sdkCreateEvents` now enforces the closed `VALID_EVENT_TYPES` set in code, and
> `docs/architecture.md` §3 item 5 documents it as a "Closed event-type set."
> Behaviour has moved since ADR-0024 was accepted. Resolving that contradiction
> is out of scope here and is **not** decided by this ADR; it is flagged because
> anyone mapping span kinds to event types will hit it.

**C5 — Ordering by timestamp is ordering by someone else's clock.** Span
timestamps come from the emitting process. Across processes they are subject to
clock skew, and OTel provides no synchronization guarantee. Any synthesis that
sorts by span start time is producing a total order from partially-ordered,
mutually-unsynchronized inputs.

---

## Decision

**Not yet made.** What follows is the shape of the decision and the question that
gates it. This section will be rewritten — not appended to — when the in-flight
work lands.

### What is settled

Three things. The first is settled by the landed provenance work; the other two
follow from the constraints rather than from a design preference.

1. **A derived event must be distinguishable from a recorded one, and must carry
   enough identity to audit.** This is decided and implemented in contracts
   (`packages/contracts/src/provenance.ts`, `api.ts`). The mechanism worth
   recording here is the deliberate asymmetry: `Event.provenance` is *optional*
   on the stored entity (existing rows have none and the log is append-only, so
   there is no backfill that is not a rewrite of history), while
   `OtelDerivedEventWrite` — the only contract describing a derived write —
   makes it *required* and types it as `OtelEventProvenance` rather than
   `EventProvenance`, so the derived path cannot even claim `source: "sdk"`.
   That is what makes "absent means native" a true statement about a closed set
   of rows rather than a guess. Two fields in it are load-bearing for the
   problems below: `mapperVersion` (when a mapper bug is found, this identifies
   which stored events are suspect — and under Rule 1 identifying them is the
   *only* remedy available), and `receivedAt` kept separate from the span-clock
   `timestamp` (which is what makes C5's clock skew visible instead of making it
   look like out-of-order execution).

2. **The event log stays the source of truth, and stays immutable.** This ADR
   does not propose an update mutation, a renumbering pass, a soft-delete flag,
   or a "corrections" event. Derived-from-OTel events are ordinary events in the
   same table under the same rules. If OTel ingestion cannot be made to work
   under Rule 1, the answer is that we do not ship it in this form — not that we
   weaken Rule 1.

3. **Span→event derivation is a projection into the log, not a new kind of
   log.** Spans are an input format. Nothing about a span survives except what
   the mapping writes into an event. There is no second store of raw spans that
   the UI reads instead — and per the adversarial finding below, a staging
   buffer would not rescue the ordering anyway, so there is no live proposal for
   one.

### The open question that gates everything else

**Can a trace that arrives across multiple OTLP batches be assigned contiguous
sequence numbers from 1, with `run.started` first, without ever renumbering or
rewriting an event?**

The failure case is concrete and does not depend on anything unusual happening:

- Batch 1 arrives carrying spans B and C. The root span A has not ended, so it
  has not been exported. To write anything at all, sequence 1 must be
  `run.started` (C4/Rule 5), so `run.started` must be synthesized from something
  other than the root span.
- Batch 2 arrives carrying span D, whose start timestamp precedes B's.

D's correct position in a timestamp order is before B. B already holds a
sequence number. There is no mechanism to insert an event before an existing
one, and no update mutation to renumber B (Rule 1, C1). D can only be appended
after C, in arrival order — or refused.

### The adversarial finding: this is confirmed, not suspected

The suite that landed at pass 3 encodes exactly this case and names it. From
`tests/unit/otel_ordering_adversarial.test.ts`, case
`multibatch/late-earlier-span-cannot-be-inserted`, invariant `APPEND_ONLY`,
severity `correctness-fatal`:

> **THE IMPOSSIBILITY CASE.** Batch 1 carries child B (t=200). Batch 2 carries
> its parent A (t=100), which belongs BEFORE B in every ordering that respects
> time or causality. Under an immutable log B already occupies sequence 1.
> Time-ordering and append-only cannot both hold. The only sound outcomes are
> (a) A is appended after B, with trace order carried by an explicit field
> rather than by `sequenceNumber`, or (b) the batch is REFUSED with a typed
> error. Silently renumbering B, or emitting A at a sequence number already
> taken, are both permanent corruption.

So the answer to the open question is **no, not in general** — and this is now a
finding with a test behind it rather than a worry. The suite's framing is
sharper than the one this ADR started with and supersedes it. In particular it
rules out the "buffer until the trace looks complete, then materialize in one
ordered pass" idea, not because buffering is unattractive but because it only
relocates the problem: OTel defines no trace-completion signal, so completion is
a timeout, and a span arriving after materialization is exactly as unplaceable
as A. (A timeout would also have to sit well inside the 24-hour ceiling in C3.)

The two sound outcomes, neither of which is chosen:

- **(a) Append in arrival order; move trace order to an explicit field.**
  Always writable, never corrupts, loses nothing. The cost is that
  `sequenceNumber` stops meaning what Rule 4 and every reader of it — replay,
  diff, the event-window UI — currently assume. This is a change to Rule 4's
  *semantics*, not merely to who assigns the numbers, and it requires a
  `CLAUDE.md` amendment plus an audit of every consumer that treats sequence
  order as temporal order. Note this is *not* the same as abandoning ordering:
  the trace order still exists, it just stops being carried by the sequence
  number. No such field exists today in either `convex/schema.ts` or the landed
  contracts.
- **(b) Refuse the late batch with a typed error.** Keeps the log clean and the
  ordering honest at the cost of permanently incomplete traces. The landed
  `IngestOtelSpansResponse.rejected` is the shape this outcome would use. The
  product's stated purpose is making failures explainable, and "the trace you
  are looking at is silently missing its parent span" is a materially worse
  debugging artifact than the SDK path produces — so if this is chosen,
  incompleteness has to be a loud, first-class property of the run, not an
  absence the engineer has to notice.

The suite defends nine other invariants besides `APPEND_ONLY` — `CONTIGUITY`,
`COMPLETENESS`, `DETERMINISM`, `STABILITY`, `DEDUP`, `CAUSALITY`, `TERMINAL`,
`TENANCY`, `TOTALITY` — each case declaring which one it defends as a structural
field rather than in prose. `multibatch/replayed-batch-is-idempotent` is the
`DEDUP` counterpart to C1 above: a redelivered batch must produce *nothing*,
and the suite notes that otherwise "every OTLP retry permanently doubles the
run."

**The caveat that keeps this from being settled.** Of the 93 tests, **31 are
skipped**, and they are the ones that matter most: the suite loads a mapper from
`convex/helpers/otel_mapping` via `describe.skipIf(binding === undefined)`, and
that module does not exist. The 62 passing tests exercise the cases against two
deliberately-naive reference mappers (`naiveTimeSortMapper`,
`lexicographicMapper`) to prove the cases have teeth — every multi-batch case
lists both as `catches`. **No real mapper has been tested against any of this.**
The suite proves the problem is real; it has not yet proven any solution is.

**What the landed API contract implies — and does not settle.** The pass-2
`IngestOtelSpansRequest` (`packages/contracts/src/api.ts`) takes
`OtelDerivedEventWrite[]`, each carrying an already-assigned `sequenceNumber`.
So the synthesis happens *upstream* of the write, and the write is an ordinary
append. Its response type includes a `rejected: Array<{ spanId, reason }>`
whose documented reasons are "malformed provenance, a run that is no longer
`running`, a sequence-number conflict."

That is the failure case above, surfaced as an API field. It is a good and
honest shape — a caller can tell a recorded-but-unmapped span from a refused one
rather than inferring silence — but it should be read as **the contract
admitting the problem exists, not as the problem being solved**. It leans toward
outcome (b) above, yet the component that would actually decide the late span's
fate — the sequence synthesis that assigns those numbers across batches — is
exactly what has not landed. Nothing in the contract prevents a design that
rejects the entire tail of every slow trace.

---

## Consequences

Stated conditionally, because the decision is open.

- **If any option is adopted:** an additive schema change to `events` plus a new
  index is required for span-keyed deduplication (C2). Additive-and-optional, in
  the same posture as ADR-002's fields, so no backfill of existing events.
- **If outcome (a) — append in arrival order, explicit ordering field — is
  adopted:** `CLAUDE.md` Rule 4 must be amended in the same PR to say that
  sequence order is arrival order for this path, a new ordering field must be
  added to `convex/schema.ts` and the contracts, and every consumer that reads
  `sequenceNumber` as temporal order (replay, diff, the event-window surfaces)
  must be audited against the weaker guarantee. The amendment and the audit are
  the expensive parts, not the ingest code.
- **If outcome (b) — refuse late batches — is adopted:** incompleteness must be
  a first-class, visible property of a run, not an absence a user has to infer.
  The `rejected` array is a per-request signal that no one is reading hours
  later; the run itself has to carry the fact.
- **Regardless:** the 24-hour stale-run ceiling (C3) applies to this path and is
  not currently documented as a constraint on ingestion anywhere. A long-running
  or slowly-exported trace loses its tail permanently and without an error the
  emitter can see, because the emitter is an OTLP exporter that has no channel
  for `RUN_NOT_ACTIVE`.
- **Regardless:** retention and erasure (ADR-001) apply unchanged. Events derived
  from spans are ordinary events in an org-scoped run and are swept by the same
  per-run and per-org paths.

---

## What this ADR does NOT decide

Listed explicitly so nobody reads settled intent into silence:

- The span→event **mapping table** itself (which GenAI span kinds and attributes
  become which `EventType` and payload shape). Not landed at either pass; owned
  by the mapping work.
- **How `sequenceNumber` is actually synthesized across batches.** The contract
  assumes it has been; nothing computes it yet. This is the open question above
  and it is the gating one.
- The **Convex-side storage** of provenance: the additive `convex/schema.ts`
  field, its validator shape, and the index that makes span-keyed dedupe (C1/C2)
  possible. Contracts landed; Convex did not, and the schema-drift gate is
  failing in the meantime.
- **Whether the OTel path writes through `sdkCreateEvents` or a separate
  mutation.** `OtelDerivedEventWrite` deliberately does *not* extend
  `CreateEventRequest`, which hints at separation, but nothing decides it. This
  determines whether C4's closed-set divergence has to be closed at all.
- **Whether OTel ingestion ships at all.** See the open question above.
- The **transport surface**: whether this is an OTLP/HTTP endpoint under
  `apps/web/app/api/**`, a collector exporter, or something else; and its auth.
  (The obvious default is the existing `x-api-key` ingest auth from
  `docs/architecture.md` §5, but nothing has been decided or built.)
- Any **error code** for this path. `AFR_API_ERROR_CODES`
  (`packages/contracts/src/api_errors.ts`) is append-only and a deployed client
  matches exact strings; adding a code is a contract change that belongs to
  whichever design is chosen.
- The **ADR-0024 contradiction** noted under C4. Flagged, not resolved.
- Whether **`run.started`/terminal events synthesized by the backend** (rather
  than recorded by an instrumented process) are honest events at all, or whether
  they need to be distinguishable from recorded ones. This is a real product
  question — the log currently means "this is what the agent reported" — and it
  is open.
