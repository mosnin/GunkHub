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
| 1 | `afr_list_failure_patterns` | What is broken? | ~284 tok / 10 patterns (~28/row) |
| 2 | `afr_get_pattern_evidence` | Did the fix hold? | ~423 tok |
| 3 | `afr_explain_run` | Why did this run fail? | ~119 tok typical, ~190 tok worst case |
| 4 | `afr_get_run_events` | Show me the actual events. | ~3 400-3 900 tok at the 50-event cap |
| — | `afr_list_runs` | Where am I? | ~475 tok / 20 runs (57x smaller than raw) |

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
  "unevaluated": { "count": 2, "sample": ["…"] }  // only when non-empty
}
```

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
  "status": "ready",              // "ready" | "pending" | "not_eligible"
  "runStatus": "failed",
  "summary": "…", "rootCause": "…", "suggestedFix": "…",
  "failureClass": "tool_error", "kind": "llm",
  "citedSequenceNumbers": [12, 13, 27]
}
```

Surfaces the explanation the backend already generated and cached
(`convex/run_explanations.ts`, served by `GET /api/v1/runs/:id/explanation`) —
nothing is re-derived here.

`status` is the honest discriminant and must not be collapsed into a bare null:
`pending` means the run failed and generation has not landed yet (retry later);
`not_eligible` means the run did not fail and never will have an explanation.
Those demand different behaviour.

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
| `afr_list_failure_patterns` | `failure_patterns` | `class, label, count, lastSeenAt, status` |
| `afr_list_runs` | `runs` | `agentId, status, startedAt, endedAt, environment, sessionId` |
| `afr_get_run_events` | `events` | `type, timestamp, payload` |
| `afr_get_pattern_evidence` | — | none: a composed envelope, not a projectable document |
| `afr_explain_run` | — | none, same reason |

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
