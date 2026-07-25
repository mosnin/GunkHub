# `@agent-flight-recorder/mcp`

An MCP (Model Context Protocol) server that exposes Agent Flight Recorder's
read API to any MCP client — Claude, Cursor, or an agent debugging itself.

Read-only. There is no tool here that writes anything.

## Why this shape

A 50-step agent run dumped raw is 100k+ tokens and useless to an agent that has
to reason inside a context window. So this is not a CRUD mirror of the REST API.
It is **four tiers, each a cheap decision point**, so an agent spends a few
hundred tokens to learn what is broken and only pays for a full trace if it
actually needs one.

| Tier | Tool | Answers | Measured cost |
|---|---|---|---|
| **0** | **`afr_triage`** | **What is wrong, and what do I look at first?** | **~331 tok typical, ~429 worst case** |
| 1 | `afr_list_failure_patterns` | What is broken? | ~284 tok / 10 patterns (~28/row) |
| 2 | `afr_get_pattern_evidence` | Did the fix hold? | ~423 tok |
| 3 | `afr_explain_run` | Why did this run fail? | ~119 tok typical, ~190 tok worst case |
| 4 | `afr_get_run_events` | Show me the actual events. | ~3 400-3 900 tok at the 50-event cap |
| — | `afr_list_runs` | Where am I? | ~475 tok / 20 runs (57x smaller than raw) |

**A ladder whose bottom rung is not the obvious one is a ladder people fall
off.** Tiers 1-4 were measured and correct, and an agent arriving cold still had
no reason to start at the bottom: the CRUD instinct is "fetch the run", which is
tier 4, ~3 838 tokens, and answers nothing useful because the agent does not yet
know *which* run. Tier 0 exists to be the obvious first call — no arguments, one
upstream read, and every item carrying the exact next tool and arguments — so
descending the ladder is the path of least resistance rather than a discipline
the caller has to supply.

Every figure above is **measured**, against contract-maximal inputs (a
`FailurePattern` with every optional field set, an explanation using its full
2 KB + 1 KB + 1 KB prose allowance, a 50-event window of payloads sitting just
under the 10 KB externalization threshold) — not a target. Re-measure rather
than trusting them if the projections change.

Every tier's response carries the handle for the next one: a pattern row carries
its `fingerprintHash`, an explanation carries `citedSequenceNumbers`. Working
down the tiers is always cheaper than starting at the bottom.

## Setup

Authenticates with the same two environment variables `packages/cli` uses — same
names, same "both or neither" rule, same error sentence. The key must carry the
**`read`** scope; a write-only ingest key is rejected with 403.

```json
{
  "mcpServers": {
    "agent-flight-recorder": {
      "command": "afr-mcp",
      "env": {
        "AFR_BASE_URL": "https://afr.example.com",
        "AFR_API_KEY": "afr_..."
      }
    }
  }
}
```

If either variable is missing the process prints the message naming **both** and
exits 1 rather than starting. A server that accepts the handshake and then fails
every tool call shows up in the client as *connected*, and the model tries to
work around the failure instead of the human fixing the config.

Transport is **stdio** — the standard for a locally-spawned MCP server. Nothing
is ever written to stdout except protocol frames; diagnostics go to stderr.

## Tools

### `afr_triage` — Tier 0, the entry point

**Input:** `{ agentId?: string }` — **zero required arguments**. `afr_triage()`
is the intended call; that is what makes it the default.

**Output:**

```jsonc
{
  "verdict": "issues",            // "issues" | "clear" | "unknown"
  "complete": false,              // was the view behind the verdict WHOLE?
  "scanned": 50,
  "items": [
    { "fingerprintHash": "01f3a9c1d4e7b2", "class": "http_error",
      "label": "HTTP 429 from provider", "count": 220, "lastSeenAt": 1753400000000,
      "signal": "regressed", "score": 233,
      "next": { "tool": "afr_get_pattern_evidence",
                "args": { "fingerprintHash": "01f3a9c1d4e7b2" } } }
  ],
  "scanTruncated": true,          // only when the SERVER's scan hit its row ceiling
  "caveats": ["Scan truncated at 50 patterns; ranking covers only what was scanned."],
  "unevaluated": { "count": 6, "sample": ["…","…","…"] },   // only when non-empty
  "next": { "tool": "afr_list_failure_patterns", "args": { "cursor": "…", "limit": 100 } }
}
```

**Measured at ~331 tokens typical and ~429 worst case** (a saturated 50-pattern
scan, every item muted, every co-occurring caveat firing, an `unevaluated`
sample and a top-level next hop), against the same `bytes/4` estimator and the
same contract-maximal fixtures as everything else here. The ceiling is 450 —
tier 2's — and the reason is a test, not a preference: an agent can already buy
"what is broken" plus "did the fix hold" by calling tier 1 (~284) and tier 2
(~423) itself, for ~707. **A shortcut that costs more than the thing it
shortcuts is a fifth tier pretending to be a shortcut, and it should not
exist.**

**One upstream read.** Same endpoint as tier 1, same derived `fields` selection
discipline. There is no second data source here to disagree with the first;
everything else is ordering, capping and pointer construction.

#### `next` — the point of the tool

Every item carries exactly ONE `next`: a real tool name and the exact argument
object to pass it. An agent should never have to *infer* the ladder.

- A pattern with a live resolution, or one that regressed, raises "did the fix
  hold?" — that is tier 2, verbatim.
- Anything else raises "why does this happen?", and the cheapest real answer is
  the cached explanation for a run that exhibited it, so the pointer is
  `afr_explain_run` on `representativeRunIds[0]` (~121 tokens, an order of
  magnitude under fetching that run's events).

One pointer, not two: offering a choice per item would re-create, per item, the
choice problem this tool exists to remove.

#### The ranking, and why it is this ranking

Signal class first, then recency, then volume.

| Signal | Weight | Why here |
|---|---|---|
| `regressed` | 200 | A regression is not merely a failure, it is a **false belief living in the system**. Someone asserted this was fixed, the product recorded it, and the evidence now contradicts it — so every downstream reader is reasoning from something known to be wrong. A known-wrong belief is strictly worse than the known-unknown every other row is. |
| `spiking` | 160 | A spike is a **change**, and the only signal here carrying information about *when* something started. A steady failure rate is a known cost; one that quadrupled this morning still has its causal window open. |
| `open` | 120 | Unfixed and **nobody has looked**. |
| `acknowledged` | 80 | Unfixed, but a human already made a judgement about it. For "what should I look at first", unseen beats seen-and-deferred. |
| `resolved` | 40 | Last, but **not zero** — dropping holding resolutions would make an all-resolved org indistinguishable from an empty one. |

Recency decays with a 24-hour half-life (max 20) and volume is log10-scaled and
saturates at ~100 occurrences (max 15). Volume is log-scaled deliberately:
linear volume lets one 10 000-count pattern drown the list, and "the biggest
number" is not the question being asked.

**The weights are spaced 40 apart and the tie-breakers total at most 35, so
recency and volume order WITHIN a class and can never promote an item across
one.** That is what makes the ordering explainable in one sentence — read the
signal, then read the position within it — and
`tests/unit/mcp_triage.test.ts` asserts the spacing directly rather than
trusting the arithmetic to stay true. Ties break on `fingerprintHash`, so the
order is total and two calls a millisecond apart cannot shuffle.

**Muted patterns are demoted below everything and flagged `muted: true`, never
hidden.** Muting suppresses *alerting*, not existence — but an admin muting a
fingerprint is a human saying "stop putting this in front of me", and a tool
whose whole job is "what should I look at first" has no business overriding
that.

#### Honesty: `verdict` and `complete` are two different questions

`clear` and `unknown` **are not the same answer** and are never collapsed.
`clear` is "the scan finished and found nothing"; `unknown` is "I could not
evaluate". Reporting the second as the first tells a caller its agents are
healthy when the tool actually failed to look.

`complete` is orthogonal on purpose. `verdict: "issues", complete: false` is a
real and common state — *these are the worst of what I saw, not the worst that
exist* — and folding it into the verdict would either overstate a partial
result or discard a useful one. It goes false when the scan was truncated, when
the deployment served no fix confidence (so regressions could only be inferred
from `regressedAt`), or when some resolution had no gradeable snapshot;
`caveats` names each reason in one sentence, and `unevaluated` names the
specific fingerprints.

**Two truncations, kept distinct, because they are different failures.** A
`nextCursor` means more patterns exist than the 50 this tool ranked — the scan
was fine, the *ranking's scope* was not, so "these are the worst" really means
"the worst of the 50 I looked at". `scanTruncated` is the server's own marker
and means it could not finish scanning even that window, so a short or **empty**
`items` may be an artefact of the row ceiling rather than evidence of health.
The second is strictly worse, so it is what the single caveat names when both
fire; both drive `complete: false`.

Neither replaced the other. The cursor answers a question the server marker
knows nothing about (this tool's own `SCAN_LIMIT`), and the marker answers one
no cursor can (whether the server's scan was whole). Dropping either would
under-declare a real gap. Absence of the marker is read through the SDK's
`isPatternScanComplete`, so what "undeclared" means is decided in one place
rather than guessed at three layers.

Emitting 5 of 50 is **not** a caveat — that is the design, and `scanned` versus
`items.length` states it for free. A caveat that fires on every ordinary call
makes `complete` permanently false and the list permanently unread.

#### Why there is no `limit`, and no `environment`

`MAX_ITEMS` is hard at 5. The measured budget is measured *at* five; a
caller-raisable cap would mean the published cost is not the cost. Breadth is
`afr_list_failure_patterns`, which is exactly where the top-level `next` points
when the scan was truncated — with the cursor forwarded verbatim, so continuing
is mechanical rather than a guess.

There is no `environment` filter because a `FailurePattern` is an org-scoped
rollup over fingerprints and carries no environment. An `environment` argument
here could only be accepted and ignored, and **a filter that silently does
nothing is worse than an absent one** — a caller believes it applied.

### `afr_list_failure_patterns` — Tier 1

**Input:** `{ agentId?: string, state?: 'unproven'|'proving'|'confirmed'|'regressed', status?: 'open'|'acknowledged'|'resolved', spiking?: boolean, regressed?: boolean, limit?: number (1-100, default 20), cursor?: string }`

**Output — COLUMNAR.** Field names are sent once, rows are positional:

```jsonc
{
  "fields": ["fingerprintHash","class","label","count","lastSeenAt","status","confidenceState","confidenceStale"],
  "rows": [
    ["01f3a9…", "tool_error", "Tool call failed", 128, 1753400000000, "open", "unproven", null]
  ],
  "nextCursor": "…",                              // absent on the last page
  "scanTruncated": true,                          // only when the scan hit its row ceiling
  "unevaluated": { "count": 2, "sample": ["…"] }  // only when non-empty
}
```

**`scanTruncated` is the difference between "nothing matched" and "nothing
matched in the slice I could afford to look at."** A filtered request
overfetches a bounded window and then filters it, so a short — or entirely
empty — page can be produced purely by the row ceiling. While it is present, an
empty `rows` is **not** evidence that nothing matches: follow `nextCursor` until
a page comes back without it, or report the question as unanswered.

Convex computes the marker, the v1 route forwards it and the SDK types it — and
this projection used to drop it at the last hop, which made the whole chain
worthless. **A marker nobody reads is the same as no marker**, and the
consequence lands on an agent: it calls the tool it is most likely to call
first, sees a short list, and concludes the system is healthy. Emitted only when
true, so a complete scan pays nothing (measured +5 tokens when it fires, against
this tier's 300-token budget — the tightest in the package). Absence means
"complete, or a deployment that cannot say", and that collapse is decided once,
in the SDK's `isPatternScanComplete`, not re-guessed here.

**Read a row by looking its column up in `fields`, never by a hardcoded
index.** Adding a column later must not break a caller. A column that is `null`
in every row is omitted from `fields` entirely — it carries no information and
costs a `null` per row.

Why columnar, and why only here: in an array of objects every row repeats every
key name, and on a tier-1 row those names are about half the bytes. That cost
multiplies by row count. Naming the fields once took this response from ~467 to
~284 tokens for the same data. Tiers 2-4 return a single item, so key repetition
does not compound there and they stay self-describing objects. Columnar is a
compression for repetition, not a house style.

`status` is resolved for you: absent on the rollup means `"open"`.

No representative runs, no payloads, no spike detail, no trends, no agent
version lists, no mute state, no resolution notes. All of those are one tier
down, for the one pattern you actually chose.

`state` vs `status`: `status` is what a human **asserted**; `state` is what the
**evidence** supports. For a CI gate prefer `state: 'regressed'` over
`regressed: true` — the boolean also matches patterns whose regression predates
their current resolution, i.e. ones that were genuinely re-fixed.

`unevaluated` names patterns with a live resolution but no usable confidence
snapshot. They are excluded from a `state`-filtered result, and naming them
matters: "we could not evaluate these" is a different answer from "these do not
match."

### `afr_get_pattern_evidence` — Tier 2

**Input:** `{ fingerprintHash: string }`

**Output:**

```jsonc
{
  "fingerprintHash": "…", "class": "…", "label": "…",
  "count": 41, "lastSeenAt": 1753400000000, "status": "resolved",
  "resolution": {                 // null when there is no live resolution
    "resolvedAt": 1753000000000,
    "resolvedByUserId": "…", "resolutionNote": "…", "resolutionRef": "…",
    "resolvedInVersionId": "…", "resolvedInVersion": "…",
    "resolvedAtOccurrenceCount": 38, "resolvedAtRunCount": 900
  },
  "exposure": {                   // null exactly when resolution is null
    "since": 1753000000000,
    "runCount": 214, "runCountTruncated": false,
    "recurrenceCount": 0, "heldSoFar": true
  },
  "confidence": {                 // null exactly when resolution is null
    "score": 0.42,                // 0-1 fraction capped at 0.95 — never a percentage
    "state": "proving",
    "exposureRuns": 214, "observedRuns": 214,
    "elapsedMs": 172800000, "recurred": false,
    "exposureCredit": 0.53, "soakCredit": 0.29,
    "limitingFactor": "accumulating", "versionAttribution": "matched"
  },
  "transitions": [{ "action": "failure_pattern.resolved", "actor": "user_…", "timestamp": 1753000000000 }],
  "transitionsTruncated": true    // only when older transitions were dropped
}
```

Measured at ~423 tokens with the contract-maximal 100 inbound transitions. That
is above the 300 this tier was first specified at, and the figure was updated
rather than the projection: the remaining cost is the 10 most recent lifecycle
transitions and the full set of confidence drivers. Both are the answer to "did
the fix hold?" — cutting them would buy the budget by discarding the evidence.
The unbounded `metadata` bag on each transition (400+ bytes each, ~10k tokens
across 100) *is* dropped, which is the cut that was actually available.

Reading it correctly: `runCount` is a **floor** when `runCountTruncated` is
true. `heldSoFar: true` with `runCount: 0` means the fix is **untested**, not
proven — which is why `confidence.state` reports that case as `'unproven'`. For
a build gate, branch on `state === 'regressed'`.

`transitions` returns the 10 most recent, oldest-first, with the unbounded
`metadata` field dropped.

### `afr_explain_run` — Tier 3

**Input:** `{ runId: string }`

**Output:**

```jsonc
{
  "runId": "…",
  "status": "ready",              // "ready" | "pending" | "not_eligible" — RAW server discriminant
  "availability": "not_yet",      // omitted when status is "ready"
  "runStatus": "failed",
  "summary": "…", "rootCause": "…", "suggestedFix": "…",
  "failureClass": "tool_error", "kind": "llm",
  "citedSequenceNumbers": [12, 13, 27]
}
```

Surfaces the explanation the backend already generated and cached
(`convex/run_explanations.ts`, served by `GET /api/v1/runs/:id/explanation`) —
nothing is re-derived here. `kind` is `heuristic` or `llm`: the heuristic path
is unconditional and primary, the LLM is augmentation behind a grounding gate,
so an explanation never depends on an LLM being available — but a caller should
know whether it is reading a derived summary or an analysed one.

**Read `availability`, not `status`, to decide whether to retry.**
`status: "not_eligible"` is true-but-misleading for a run that is **still in
flight**: the server means "not eligible right now", the word reads as "not
eligible ever", and an agent that believes the second concludes *nothing to see
here* about a run that is actively failing and will have an explanation in
thirty seconds. Since tier 0 makes `afr_explain_run` the default second call,
that misreading now sits on the default path.

`availability` resolves `status` against `runStatus`, both of which the server
already sends:

| `availability` | Means | Do |
|---|---|---|
| `not_yet` | It failed and generation has not landed, **or the run is still running and may yet fail** | Retry later |
| `never` | The run reached a terminal, non-failed state | Stop |
| `unknown` | `runStatus` was not served, or the two signals contradict each other | Do not conclude either |

`available` exists in the vocabulary but is never emitted — it is implied by
`status: "ready"`, and tier 3's contract-maximal budget is measured on exactly
that case, so a field with no information content must not land on it.

**The wire vocabulary is deliberately not widened to fix this.** `status` is
validated against a hard-coded `not_eligible|pending|ready` in both this package
(`readStatus`) and `apps/web/src/lib/services/explanations.ts`, and both
*silently downgrade* an unrecognised value to `pending` — so a new server-side
status would reach an agent as `pending`, the exact un-actionable answer it
would have been added to remove. Fixing that properly needs a coordinated change
across `packages/mcp` + `apps/web` + `convex/read_api.ts`;
`tests/unit/explanation_coverage.test.ts` pins the coupling on the source text
until then. `availability` is the client-side derivation available today, and
`status` is unchanged.

The `citedSequenceNumbers` are the point of the tier boundary — pass one as
`aroundSequence` to tier 4 instead of paging a whole run.

**Prose is bounded by this layer, not by the contract.** `RunExplanation`
permits 2 KB of `summary` plus 1 KB each of `rootCause` and `suggestedFix` —
~1 000 tokens, five times this tier's cost. Real explanations are far shorter,
but that is a property of the generator, not a guarantee of this layer, so the
three fields are capped at 230 / 150 / 110 bytes and truncated with an explicit
in-band marker (`…[truncated, N more chars]`). A realistic explanation is never
touched; a runaway one cannot blow the tier. Silent truncation would be the real
hazard — an agent reading a cut-off root cause as a complete one draws a
confident conclusion from half a sentence.

### `afr_get_run_events` — Tier 4 (expensive)

**Input:** `{ runId: string, aroundSequence?: number, fromSequence?: number, limit?: number (1-50, default 20) }`

**Output:**

```jsonc
{
  "runId": "…",
  "fromSequence": 7,
  "events": [
    { "sequenceNumber": 7, "type": "tool.call", "timestamp": 1753…, "payload": { … } },
    { "sequenceNumber": 8, "type": "llm.request", "timestamp": 1753…,
      "originalType": "llm.request",
      "artifact": { "artifactId": "…", "checksum": "sha256:…", "size": 41283,
                    "storageBucket": "…", "storageKey": "…" } }
  ],
  "nextFromSequence": 27,         // absent at end of log
  "truncationNote": "…"           // only when a byte budget cut something
}
```

**The limit cap is 50 and it is not negotiable.** It is enforced by the input
schema, so a request for 5000 is *rejected* rather than silently clamped —
quietly returning 50 of 5000 would let a caller believe it had seen the whole
log.

**Artifact payloads are never inlined.** A payload over the 10 KB
externalization threshold is returned as a pointer plus checksum. An agent that
wants the blob can fetch it deliberately with those coordinates; it never
arrives by accident.

**Bytes are budgeted, not just events.** The 50-event cap caps *events*; an
agent pays for *bytes*. Externalization only triggers above 10 KB, so a payload
of 10 239 bytes is never an artifact — fifty of those inlined verbatim is
~127 000 tokens in one tool result, more than the raw dump this package exists
to prevent. So an inline payload over 400 bytes is replaced by
`{ truncated: true, bytes, preview }`, and once a window has spent its 8 KB
total payload budget the remaining payloads drop to a marker. Events are
budgeted in order, so the ones nearest the window start — the ones you aimed at
— keep their payloads. Measured worst case: ~3 400 tokens for a saturated
50-event window of near-threshold payloads.

`aroundSequence` centres the window (half the budget before the cited event,
half after), because the events leading *up to* a failure are usually what
explain it. `fromSequence` starts at an exact sequence and is ignored when
`aroundSequence` is given.

### `afr_list_runs`

**Input:** `{ status?: RunStatus, agentId?: string, environment?: string, sessionId?: string, limit?: number (1-100, default 20), cursor?: string }`

**Output — COLUMNAR**, same encoding and same reading rule as tier 1:
`{ fields: ["runId","agentId","status","startedAt","endedAt","environment","sessionId"], rows: [[…]], nextCursor? }`

Deliberately omits the `metadata` bag, `tags`, `labels`, token counters,
`searchText`, `modelsSeen`, and `sdkVersion`. `metadata` alone is unbounded
caller-supplied JSON, which would make row size unpredictable — exactly what a
compact list must not be.

## Server-side field projection

The projections above are what an agent *sees*. Until the read API grew a
`fields` selector (`convex/read_api.ts` §FIELD PROJECTION, `?fields=a,b,c` on
the v1 routes, `fields?: string[]` on `FlightReader`), they were also all this
package did: it fetched the whole thirty-field document and threw most of it
away. That saved the context window and nothing else — the wire bytes, the JSON
serialization and the backend read were already paid.

Each tool now asks for exactly the columns it will emit:

| Tool | Table | `fields` sent |
|---|---|---|
| `afr_triage` | `failure_patterns` | `class, label, count, lastSeenAt, muted, regressedAt, resolvedAt, status, lastSpikeAssessment, representativeRunIds` |
| `afr_list_failure_patterns` | `failure_patterns` | `class, label, count, lastSeenAt, status` |
| `afr_list_runs` | `runs` | `agentId, status, startedAt, endedAt, environment, sessionId` |
| `afr_get_run_events` | `events` | `type, timestamp, payload` |
| `afr_get_pattern_evidence` | — | none: a composed envelope, not a projectable document |
| `afr_explain_run` | — | none, same reason |

`afr_triage` asks for more than it emits, and that is deliberate: `regressedAt`,
`resolvedAt`, `lastSpikeAssessment` and `representativeRunIds` are **ranking and
pointer inputs**, never columns. A field the server does not send is one the
ranking silently treats as absent — without `regressedAt`/`resolvedAt`, every
regression on a deployment without fix confidence would classify as `open` and
the tool would confidently rank a broken fix below a new singleton. They live in
`TRIAGE_RANKING_SOURCES` with a stated purpose each, because an unexplained name
in a field selection is the first thing a future reader deletes as unused.

**The list is DERIVED, never written twice.** Each projection declares its
columns once as a `ProjectedColumn[]` table pairing the emitted column with the
document field it reads; the columnar header (`PATTERN_FIELDS`, `RUN_FIELDS`)
and the request (`PATTERN_REQUEST_FIELDS`, …) both come out of that one table.
Two hand-maintained lists would drift, and the two directions fail differently:
a column emitted but not requested reads `undefined` on every row and is then
silently dropped by the all-null-column rule, while a name requested but not
real is a **hard 422** — read API rule 2 never silently ignores an unknown
field; Convex raises `INVALID_ARGUMENT` and the v1 error mapping renders it as
422, distinct from the route's own 400 for a malformed `?fields=` (empty,
padded, duplicated, or repeated). `tests/unit/mcp_fields.test.ts` checks every requested name against the
live `convex/schema.ts`.

Identity fields are never requested: the read API returns `_id` /
`sequenceNumber` / `fingerprintHash` regardless (rule 3), and `getRunEventWindow`
adds `sequenceNumber` itself so its ignored-floor check stays armed.

**The client-side projections stay, as a backstop.** They are no longer the
mechanism, but they are not redundant: `fields` is opt-in and an older
deployment ignores it; the byte budgets (payload previews, prose caps,
transition cap) are enforced only client-side, because no field selection bounds
the *size* of a field it did return; and several emitted columns are not
document fields at all (`confidenceState` is joined from the `fixConfidence`
envelope, the artifact pointer is read out of an externalized payload). A server
that ignores `fields` still yields a correct, budgeted response. Do not delete
them as dead code.

**Projection is an optimization, never a dependency.** `FlightReader` refuses to
hand back a full document dressed as a projection — right for a generic caller,
wrong here, where the response is re-projected anyway and a full document is a
correct input. So `withFieldProjection` retries once without the selection when
a deployment cannot honor it, and tier 4 retries the *window* un-projected
before it drops to client-side paging. A 422 for an unknown field name is
never retried: that is a bug in the column table and must surface.

### Measured

Contract-maximal fixtures, `bytes/4` token estimate — the same estimator and the
same fat inputs as `tests/unit/mcp_progressive_disclosure.test.ts`.

| Tier | Case | Client tokens before → after | Wire bytes before → after |
|---|---|---|---|
| 1 `list_failure_patterns` | 10 patterns | 284 → 284 | 15 813 → 2 323 (**−85.3%**) |
| 2 `get_pattern_evidence` | 100 transitions | 423 → 423 | 58 668 → 58 668 (0%) |
| 3 `explain_run` | realistic | 121 → 121 | 581 → 581 (0%) |
| 3 `explain_run` | contract-max | 192 → 192 | 4 379 → 4 379 (0%) |
| 4 `get_run_events` | 50 externalized | 3 838 → 3 838 | 19 862 → 17 112 (−13.8%) |
| 4 `get_run_events` | 50 near-threshold | 3 384 → 3 384 | 512 962 → 510 212 (−0.5%) |
| — `list_runs` | 20 runs | 475 → 475 | 111 111 → 2 891 (**−97.4%**) |

**The client-visible numbers do not move, and that is the honest result** — the
projections were already dropping those fields, so there was never a client-side
win available here. The win is upstream, and it is where the shape predicts:
huge on the list tiers, where a fat document is reduced to five or six scalars
and multiplied by page size; small on tier 4, where the payload *is* the cost and
no selection can remove it; zero on tiers 2 and 3, which compose an envelope
rather than return a document and have no `fields` vocabulary to use.

The byte budgets are unchanged. Server-side projection removes fields nobody
reads; it is not licence to loosen a bound. Tier 4's 50-event cap, 400-byte
per-payload cap, 8 KB window budget and truncation marker all stand exactly as
they were — as the near-threshold row above shows, that tier is bounded by
`budgetEventRows` and by nothing else.

## Startup validation

The process refuses to start — rather than starting and failing every call —
when:

- either variable is unset, **or is only whitespace**. Values are trimmed
  first, so `AFR_API_KEY=$(cat ~/.afr-key)` with a trailing newline is caught
  instead of producing a 401 on every tool call.
- `AFR_BASE_URL` is not a parseable absolute URL (`afr.example.com`, `/api/v1`,
  `htps://…`). Every request would fail; better to say so at launch.
- `AFR_BASE_URL` uses a non-HTTP scheme.
- `AFR_BASE_URL` uses plaintext `http://` to a **non-local** host. The API key
  is sent as a header on every request, so that transmits a read-scoped
  credential in the clear. `localhost`, `127.0.0.1` and `::1` are allowed —
  that is a dev loop, not a leak. This matches ADR-003's HTTPS-only posture for
  outbound targets.

## Errors

Every failure becomes an `McpError`; no raw fetch error or stack trace escapes.

| Cause | MCP code |
|---|---|
| Key invalid / missing `read` scope | `InvalidRequest` |
| Unknown run or fingerprint | `InvalidParams` |
| Rate limited, server, network, unparseable response | `InternalError` |

**No existence oracle.** A `not_found` means one of three indistinguishable
things — the id never existed, it belongs to another organization, or it was
purged under a retention policy. Every `not_found` is rewritten to a **fixed
sentence chosen by resource kind and nothing else**; the server's own message is
discarded. The same string, byte for byte, for a typo'd id and for another org's
real id.

## Why there are no write tools

Acknowledging, resolving, reopening, or muting a pattern are member-gated,
audited actions in the web app. An API key has no human behind it, and the audit
log exists to record *which person* made a privileged change. Reading proof that
a fix held needs no actor; asserting that it held does.

## Known gaps against the SDK

- **The v1 events route still cannot seek by sequence number.** The SDK now
  offers `FlightReader.getRunEventWindow`, which asks the server for a window
  addressed by `sequenceNumber` and — crucially — throws `invalid_response`
  rather than returning the head of the log when the deployment ignores the
  `fromSequence` parameter. `src/events-window.ts` calls it first and falls back
  to client-side paging on exactly that one error: page forward from the start,
  discard below the window, keep the window, stop. The fallback costs
  `ceil(fromSequence / 200)` round trips and refuses to scan past 20 000 events.
  **`GET /api/v1/runs/:id/events` does not accept `fromSequence` yet**, so the
  fallback is the live path today; when the route lands, the primary path takes
  over automatically and the fallback plus its scan ceiling can be deleted, with
  no change to the tool's input or output shape.

## Development

```bash
pnpm --filter @agent-flight-recorder/mcp build      # tsup -> dist/, executable bin
pnpm --filter @agent-flight-recorder/mcp typecheck
pnpm --filter @agent-flight-recorder/mcp lint
```
