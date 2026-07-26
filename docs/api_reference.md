# Agent Flight Recorder — API Reference

This document covers the HTTP surfaces added in Cycles 2-3 of the action layer
(`docs/design/action_layer.md`, ADR-003 `docs/adr/003-alerting-webhooks-export.md`):

0. **API key management** (`/api/api-keys/**`) — Clerk-authed, how to mint,
   list, and revoke the keys every other surface below authenticates with —
   including how to mint a **`read`**-scoped key for the v1 API / CLI
   (Cycle 3).
1. **The public v1 read API** (`/api/v1/**`) — key-authed, for the `afr` CLI
   and other external, automated consumers that need to read run/event data
   without a browser session.
2. **The alerts & webhooks management API** (`/api/alerts/**`,
   `/api/webhooks-config/**`) — Clerk-authed, used by the web UI's settings
   pages to configure alert rules and outbound webhook targets.

It also documents how to verify and consume an **outbound webhook
delivery** — the payload Agent Flight Recorder POSTs to a configured
webhook target when a run completes/fails or an alert fires — and how the
`afr` CLI relates to this API.

For the existing SDK-ingest routes (`POST /api/events`, `POST /api/runs`,
key-authed for writing) and the Clerk-authed run-browsing routes the web UI
itself uses (`GET /api/runs`, etc.), see their route source directly — this
document covers only what Cycles 2-3 added.

---

## 0. Key management

Base path: `/api/api-keys`. Clerk-session authenticated; `POST` and `DELETE`
additionally require the **admin** org role (Convex enforces this —
`convex/api_keys.ts` `requireOrgMembership(ctx, orgId, { minimumRole: "admin" })`).

| Method | Path                  | Role required | Notes |
|--------|-----------------------|----------------|-------|
| POST   | `/api/api-keys`       | admin          | Body: `{ name, scopes?, expiresAt?, expiresInDays?, rateLimitPerMin? }` → `{ id, name, scopes, createdAt, expiresAt, key }`, 201. **`key` (the raw secret) is present ONLY in this response** — persist it immediately, it cannot be retrieved again (only the SHA-256 hash is stored). |
| GET    | `/api/api-keys`       | any member     | `{ keys: ApiKeySummary[] }` — raw key and hash never returned |
| DELETE | `/api/api-keys/{id}`  | admin          | Revokes the key immediately → `{ revoked: true }` |

See [Minting a read key for the v1 API / CLI](#minting-a-read-key-for-the-v1-api--cli)
below for the `scopes` field's full contract.

```bash
curl -s -X POST "https://your-afr-host/api/api-keys" \
  -H "Cookie: __session=..." -H "Content-Type: application/json" \
  -d '{ "name": "prod SDK key", "expiresInDays": 365 }'
# => { "id": "...", "name": "prod SDK key", "scopes": ["ingest:write"],
#      "key": "<raw key, shown ONCE — save it now>", ... }
```

---

## 1. Public v1 read API

Base path: `/api/v1`. Every endpoint is `GET`, authenticated with an
`x-api-key` header, and requires the key to carry the **`read`** scope.

```
x-api-key: <your API key>
```

### Scopes

API keys carry an optional `scopes` array (`convex/api_keys.ts` /
`packages/contracts`). A key with **no** `scopes` array at all has full
back-compat access (the pre-ADR-002 behavior) and can call the v1 API. A key
with a non-empty `scopes` array must include `"read"` to call any `/api/v1/**`
endpoint — a write-only key (e.g. `scopes: ["ingest:write"]`) is rejected
with **403 Forbidden**.

### Minting a read key for the v1 API / CLI

`POST /api/api-keys` (Clerk-authed, admin role — see
[0. Key management](#0-key-management) above) accepts an optional `scopes`
array in its request body:

```bash
curl -s -X POST "https://your-afr-host/api/api-keys" \
  -H "Cookie: __session=..." -H "Content-Type: application/json" \
  -d '{ "name": "afr CLI (read-only)", "scopes": ["read"] }'
# => { "id": "...", "name": "afr CLI (read-only)", "scopes": ["read"],
#      "key": "<raw key, shown ONCE — save it now>", ... }
```

- **Allowed values:** `"ingest:write"`, `"ingest:read"`, `"read"` — a 422
  `VALIDATION_ERROR` is returned for anything outside this set, or for a
  non-array/empty `scopes` value.
- **Omit `scopes` entirely** to get the default, `["ingest:write"]` — this is
  the right choice for an SDK/ingest key and preserves the behavior of any
  existing integration that predates this field. (This is a change from the
  pre-Cycle-3 behavior of leaving `scopes` unset in Convex, which granted
  unrestricted back-compat access including `read` — omitting the field now
  explicitly scopes a new key to ingest-only. Existing keys created before
  this cycle are unaffected; only the *default for new keys created without
  an explicit `scopes` field* changed.)
- **Pass `["read"]`** to mint a key for the `afr` CLI or any other v1-API
  consumer that should only ever read, never ingest — this key will be
  rejected with 403 by every `/api/events`/`/api/runs` ingest route.
- **Pass both**, e.g. `["ingest:write", "read"]`, for a single key used by
  both an SDK integration and its own read-back tooling.

The response's `scopes` field always reflects what was actually stored
(resolved server-side by `convex/api_keys.ts`'s `createApiKey`, which
validates the same allowed set independently of the web route) — do not
assume the request body's `scopes` was accepted verbatim without checking
the response.

For the `afr` CLI specifically: every `afr` command that talks to
`/api/v1/**` (`runs list`, `runs get`, `replay`, `tail`, `export` —
`packages/cli/src/apiClient.ts`) needs a **`read`**-scoped key supplied via
its `--api-key`/config — mint one with the curl example above and see
[CLI relationship to the API](#cli-relationship-to-the-api) below.

### Response envelope

Every response — success or error — is JSON with a top-level `apiVersion`
field (a date string, changed only on a breaking envelope change, not on
every deploy):

**Success (2xx):**

```json
{
  "apiVersion": "2026-07-19",
  "data": { "...": "endpoint-specific payload" },
  "requestId": "req_abc123"
}
```

**Error (4xx/5xx):**

```json
{
  "apiVersion": "2026-07-19",
  "error": {
    "code": "RUN_NOT_ACTIVE",
    "message": "human-readable detail",
    "details": { "requestId": "req_abc123" }
  }
}
```

`requestId` is also always echoed in the `x-request-id` response header —
include it when reporting an issue.

> **Known limitation:** if a v1 route hits a truly unrecognized backend
> error (not one of the codes in the table below), or a request is rejected
> by the per-key rate limiter before reaching the route handler, the
> fallback response uses the flat `{ code, message, details }` shape (no
> `apiVersion`/`error` wrapper) instead of the v1 envelope. This is a shared
> platform code path (`apps/web/src/lib/apiHandler.ts`) outside this cycle's
> scope; a client should tolerantly accept either an `error` object or a
> top-level `code` field.

### Endpoints

> **Start cheap.** These endpoints are not equally priced. For "what is broken?" and
> "why did this run fail?", `GET /api/v1/patterns` and
> `GET /api/v1/runs/{runId}/explanation` answer in a few hundred tokens' worth of body.
> `GET /api/v1/runs/{runId}/events` returns raw event records and is the expensive one
> — reach for it when you already know which run and which sequence range you want.
> `docs/mcp.md` → "Start here" is the ladder, with measured costs and a worked example;
> it applies to any automated consumer of this API, not only MCP clients.

#### `GET /api/v1/runs`

List runs for the key's organization.

| Query param   | Type   | Notes |
|---------------|--------|-------|
| `status`      | string | One of `pending`, `running`, `completed`, `failed`, `cancelled`, `timed_out` |
| `agentId`     | string | Filter to one agent |
| `environment` | string | e.g. `production`, `staging`, `development`, `preview`, or a custom value |
| `session`     | string | Filter to one `sessionId` (ADR-002 session grouping) |
| `limit`       | number | Page size, server-capped |
| `cursor`      | string | Opaque pagination cursor from a previous response's `nextCursor` |
| `fields`      | string | Comma-separated projection — see [Field projection](#field-projection--fields). `_id` always returned. Omit for the full document. |

```
GET /api/v1/runs?status=failed&agentId=agent_abc&limit=25
x-api-key: afr_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```json
{
  "apiVersion": "2026-07-19",
  "data": {
    "runs": [ { "id": "run_1", "status": "failed", "...": "..." } ],
    "nextCursor": "eyJ...",
    "pageSize": 25,
    "total": 25
  },
  "requestId": "req_abc123"
}
```

`pageSize` is the authoritative field (the current page's length, not a
grand total across all pages) — `total` is kept as a compatibility alias
with the same value, for clients written against the Clerk-authed
`ListRunsResponse.total` naming.

`session` and `agentId`/`status`/`environment` are mutually exclusive
selection paths server-side (a `session` filter takes precedence over the
others if both are supplied) — see `convex/read_api.ts` `apiListRuns`.

#### `GET /api/v1/runs/{runId}`

Accepts `?fields=` — see [Field projection](#field-projection--fields). It projects `run`
only; `eventCount` and `artifactCount` are computed, not run fields, and are unaffected.

```json
{
  "apiVersion": "2026-07-19",
  "data": {
    "run": { "id": "run_1", "status": "completed", "...": "..." },
    "eventCount": 42,
    "artifactCount": 2
  },
  "requestId": "req_abc123"
}
```

#### `GET /api/v1/runs/{runId}/events`

Paginated event log, in `sequenceNumber` order (Event Log Rule 4).

| Query param | Type   |
|-------------|--------|
| `limit`     | number |
| `cursor`    | string |

Also accepts `?fields=` — see [Field projection](#field-projection--fields). The identity
field for events is **`sequenceNumber`**, not `_id`, and it is always returned.

```json
{
  "apiVersion": "2026-07-19",
  "data": {
    "events": [ { "id": "evt_1", "type": "run.started", "sequenceNumber": 1, "...": "..." } ],
    "nextCursor": "eyJ..."
  },
  "requestId": "req_abc123"
}
```

#### `GET /api/v1/runs/{runId}/replay`

Server-computed replay projection (same derivation rules as the web UI's
replay view — CLAUDE.md: replay is a derived projection, never stored).

```json
{
  "apiVersion": "2026-07-19",
  "data": {
    "projection": {
      "runId": "run_1",
      "frames": [ { "event": { "...": "..." }, "index": 0, "actor": "agent", "status": "ok", "...": "..." } ],
      "totalEvents": 42,
      "duration_ms": 1500,
      "isComplete": true,
      "isFailed": false
    }
  },
  "requestId": "req_abc123"
}
```

#### `GET /api/v1/runs/{runId}/explanation`

The "Why did this fail?" root-cause explanation (ADR-004), for the `afr
explain` CLI command and `FlightReader.getExplanation` (SDK). Requires the
`read` scope, same as every other v1 endpoint above.

```json
{
  "apiVersion": "2026-07-19",
  "data": {
    "explanation": {
      "kind": "heuristic",
      "summary": "The run failed after 3 consecutive tool_error events calling search_docs.",
      "rootCause": "search_docs returned a 500 starting at sequence 14 and never recovered.",
      "suggestedFix": "Check search_docs's upstream health before retrying this agent version.",
      "citedSequenceNumbers": [12, 14, 17],
      "failureClass": "tool_error",
      "generatedAt": 1753315200000
    }
  },
  "requestId": "req_abc123"
}
```

`data.explanation` is `null` (not an error) when the run is not in an
explainable status (`failed` / `timed_out` / `cancelled`) or generation
hasn't completed yet. This v1 (`x-api-key`) response does not currently
carry the `status: "not_eligible" | "pending" | "ready"` discriminant the
Clerk-authed `GET /api/runs/[id]/explanation` route now returns (see
`docs/design/explanations.md`) — `convex/read_api.ts`'s `apiGetExplanation`
would need the same discriminant added to close this gap for API-key
callers too. `kind` is `"heuristic"` (always available,
zero-config, deterministic) or `"llm"` (only present when an LLM provider is
configured and its result passed grounding validation — see ADR-004).
`citedSequenceNumbers` are real `sequenceNumber`s from this run's own event
log; every number in that array is guaranteed to correspond to a real event
this key's org can already read via `GET /api/v1/runs/{runId}/events` — no
citation in a stored explanation can point to a fabricated event.

#### `GET /api/v1/patterns`

Recurring failure patterns for the key's organization (ADR-005), most-recently-seen
first. A pattern is a **rollup over explanation-derived fingerprints** — observability-
grade derived data, regeneratable at any time. It is never source of truth; the event
log remains the only fact about what happened on any single run.

Powers `afr patterns`, `FlightReader.getFailurePatterns`, and the MCP server's
`afr_list_failure_patterns`.

| Query param | Type   | Notes |
|-------------|--------|-------|
| `agentId`   | string | Narrow to patterns observed on one agent's versions. An agent that does not exist in the key's org is an error, not an empty page. |
| `spiking`   | string | Only the exact string `true` opts in. Anything else — including `false` — is treated as unset. |
| `muted`     | string | Tri-state: exactly `true` or `false` opts in; anything else is unset. Read-side filter only. |
| `status`    | string | Exactly one of `open`, `acknowledged`, `resolved`. Any other value is treated as unset. |
| `regressed` | string | Only the exact string `true` opts in. |
| `state`     | string | Fix-confidence grade: exactly one of `unproven`, `proving`, `confirmed`, `regressed`. Any other value is treated as unset. |
| `limit`     | number | Clamped server-side to `1..200`; defaults to `50`. |
| `cursor`    | string | Opaque cursor from the previous response's `nextCursor`. |

Also accepts `?fields=` — see [Field projection](#field-projection--fields) — which
projects the `patterns[]` documents. The identity field is **`fingerprintHash`**, always
returned. The `fixConfidence` envelope is computed, not a document field, and is
unaffected.

> **Unrecognized filter values are ignored, not rejected.** Every filter on this route
> is parsed permissively: a typo (`status=Resolved`, `spiking=yes`) silently yields an
> *unfiltered* result for that dimension rather than a `400`/`422`. This is deliberate
> and consistent across the v1 filter surface, but it means a client cannot rely on the
> server to catch a misspelled filter — validate before sending if that matters.
> (`apps/web/app/api/v1/patterns/route.ts`.)

```json
{
  "apiVersion": "2026-07-19",
  "data": {
    "patterns": [
      {
        "fingerprintHash": "a1b2c3d4",
        "class": "tool_error",
        "label": "tool_error on search_docs",
        "count": 47,
        "firstSeenAt": 1753000000000,
        "lastSeenAt": 1753315200000,
        "status": "resolved",
        "...": "..."
      }
    ],
    "nextCursor": "eyJ...",
    "scanTruncated": false,
    "scannedRows": 137,
    "scanRowCeiling": 2000,
    "fixConfidence": {
      "stalenessBoundMs": 21600000,
      "entries": [
        {
          "fingerprintHash": "a1b2c3d4",
          "state": "unproven",
          "score": 0.12,
          "computedAt": 1753310000000,
          "ageMs": 5200000,
          "stale": false,
          "basis": "snapshot"
        }
      ],
      "staleCount": 0,
      "unevaluated": []
    }
  },
  "requestId": "req_abc123"
}
```

`patterns[]` entries are the full `failure_patterns` documents (see `FailurePattern` in
`packages/contracts`), not a reduced row shape — the CLI, SDK reader, and MCP server
each project them down themselves.

**The `fixConfidence` envelope is always present**, filtered or not. It exists so a
reader can distinguish a fresh verdict from a stale one, and "does not match the filter"
from "was never evaluated":

- `stalenessBoundMs` — the deployment's staleness bound, transported rather than
  hardcoded per client. Currently 6 hours (`FIX_CONFIDENCE_SNAPSHOT_STALE_AFTER_MS`,
  `convex/failure_patterns.ts`).
- `entries[]` — one entry per **returned** pattern, in the same order. `state`, `score`,
  `computedAt` and `ageMs` are `null` and `basis` is `"none"` when no usable snapshot
  exists; otherwise `basis` is `"snapshot"`. Match entries **by `fingerprintHash`**, not
  by array index — the index alignment is documented but the identifier cannot silently
  mislabel a verdict if it ever drifts.
- `staleCount` — how many returned entries are served from a snapshot older than the bound.
- `unevaluated[]` — fingerprints on this page with a live resolution but no usable
  snapshot, so they could not be graded at all. Computed **before** the `state` filter
  runs, so a caller filtering by `state` still learns about them.

Do not present a snapshot verdict as current without checking its age.

##### Filtering, the scan window, and `scanTruncated`

Every filter on this endpoint — `agentId`, `spiking`, `muted`, `status`, `regressed`,
`state` — reads a field with **no secondary index**, so all of them run in memory.

This used to mean `.paginate({ numItems: limit })` first and `.filter(...)` second, so
`numItems` counted rows *examined* rather than rows *matched*: a request for 25 could
return a well-formed **empty page with a `nextCursor`** while every match sat further
down. That is fixed (`convex/read_api.ts`, "BOUNDED OVERFETCH-THEN-FILTER"). The
endpoint now reads a scan window **larger than `limit`** and counts matches, bounded by
`PATTERN_SCAN_ROW_CEILING` (**2,000** rows per request). An unfiltered request is
unchanged and reads exactly what it returns.

The window is bounded, so it can still stop short — and when it does, **it says so**:

| Field | Type | Meaning |
|---|---|---|
| `scanTruncated` | boolean | `true`: the scan stopped on the row ceiling, not on the end of the table. This page may be short or empty **purely for that reason** — do not read it as "nothing matched". Follow `nextCursor`. `false`: the page is the complete answer up to `limit`; an empty page really does mean nothing matched, anywhere. |
| `scannedRows` | number | Rows examined to produce this page. |
| `scanRowCeiling` | number | The ceiling that bounded it (2,000). |

`scanTruncated` is the same contract `exposure.runCountTruncated` already offers on the
evidence endpoint: *this answer is a floor, ask again to see the rest.*

> **This matters most for CI.** `state=regressed` exists to gate a build — "fail if a
> pattern we marked fixed came back". A gate that exits 0 on a scan it could not
> complete turns a red build green, and a regression detector that silently answers
> "nothing here" is worse than no detector because a team stops looking. **Treat
> `scanTruncated: true` as "not answered yet", never as "clean."** Page on
> `nextCursor` until you get `scanTruncated: false`, or fail the gate as inconclusive.

Cursor semantics follow from the wider window: `nextCursor` is an opaque
`{ underlyingCursor, skip }` pair, not a raw Convex cursor, because a single window can
yield more matches than `limit` and a raw continuation cursor could only resume *past*
the whole window — dropping the surplus. Hand it back unmodified. A cursor issued by
the previous implementation is still accepted and resumes at that batch boundary.

Stop only when `nextCursor` is absent **and** `scanTruncated` is `false`.

**Reading it from the SDK.** `V1ListFailurePatternsData` (`packages/sdk/src/reader.ts`)
declares `scanTruncated?`, `scannedRows?` and `scanRowCeiling?`. All three are optional,
because a deployment predating the marker never sends them — so the field has **three**
states, not two. Use the exported helper rather than testing the field directly:

```ts
import { isPatternScanComplete } from '@agent-flight-recorder/sdk'

const data = await reader.getFailurePatterns({ state: 'regressed' })
if (!isPatternScanComplete(data)) {
  // The page is a floor, not an answer. Follow data.nextCursor, or report
  // the gate as inconclusive. Never exit 0 here.
}
```

`isPatternScanComplete` treats **absent** as complete (`scanTruncated !== true`), which
restores exactly the behaviour older deployments already had rather than making every
request against them permanently inconclusive. If you need to distinguish "the server
says the scan finished" from "the server does not answer the question", test
`data.scanTruncated === undefined` yourself — but do not re-derive the two-state reading
in a third place.

**The marker is wired end to end** (SDK 0.16.0, CLI 0.10.0): the backend computes it, the
route forwards it, the SDK types it, `afr patterns` acts on it with exit `11`, and the
MCP server's `afr_list_failure_patterns` and `afr_triage` both surface it on their tool
results.

**`FlightReader.getFailurePatterns` deliberately does not throw on truncation.** That is
the opposite of what `getRunEventWindow` does for an ignored `fromSequence`, and what
`assertProjectionHonored` does for an ignored `fields` — and the asymmetry is the point.
Those two refuse because the server returned a **wrong answer indistinguishable from a
right one**: the head of the log looks exactly like the requested window, a full document
looks exactly like a projection that included everything, and no field in the response
says otherwise. Truncation is the inverse situation — the server **told the truth, in a
field**, and the only defect was that nothing read it. Throwing would also break the
correct remedy, paging on `nextCursor`, by turning a resumable state into an exception,
and would fail an unfiltered browse where truncation is harmless.

So the SDK types it, names it, and hands it over. Deciding that an incomplete scan is
fatal is the **gate's** job, not the client's.

#### `GET /api/v1/patterns/{fingerprintHash}/evidence`

"Did the fix actually hold?" (ADR-006). A resolution on its own is an unearned human
assertion; this endpoint returns the evidence that grades it.

Powers `afr patterns evidence <fingerprint>`, `FlightReader.getFailurePatternEvidence`,
and the MCP server's `afr_get_pattern_evidence`.

Also accepts `?fields=`, which projects the `pattern` document only — `resolution`,
`exposure`, `transitions` and `confidence` are computed and unaffected. See
[Field projection](#field-projection--fields).

`{fingerprintHash}` must match `/^[a-f0-9]{8,64}$/i`. A value that does not is rejected
with **`400 INVALID_ARGUMENT`** ("Invalid fingerprint hash") *before any backend call*
(`apps/web/src/lib/services/fingerprintValidation.ts`). Note this is a **400**, whereas
`INVALID_ARGUMENT` from the backend is a **422** — see [Error codes](#error-codes).

```json
{
  "apiVersion": "2026-07-19",
  "data": {
    "pattern": { "fingerprintHash": "a1b2c3d4", "class": "tool_error", "...": "..." },
    "resolution": {
      "resolvedAt": 1753000000000,
      "resolvedByUserId": "user_1",
      "resolutionNote": "Pinned search_docs to v2.",
      "resolutionRef": "https://example.com/pr/412",
      "resolvedInVersionId": "ver_5",
      "resolvedInVersion": "1.6",
      "resolvedAtOccurrenceCount": 47,
      "resolvedAtRunCount": 310
    },
    "exposure": {
      "since": 1753000000000,
      "runCount": 0,
      "runCountTruncated": false,
      "recurrenceCount": 0,
      "baselineRunCount": 310,
      "agentIds": ["agent_1"],
      "heldSoFar": true
    },
    "transitions": [
      { "action": "failure_pattern.resolved", "actorClerkUserId": "user_1", "timestamp": 1753000000000, "metadata": {} }
    ],
    "confidence": { "score": 0.05, "state": "unproven", "...": "..." }
  },
  "requestId": "req_abc123"
}
```

- `resolution`, `exposure` and `confidence` are **all `null` together** exactly when the
  pattern has no live resolution — never resolved, or manually reopened (which clears
  `resolvedAt`). A fabricated `"unproven"` there would read as a judgment about a fix
  rather than the absence of one, so none is emitted.
- The regression guard's **automatic** reopen deliberately *keeps* `resolvedAt`, so a
  pattern with `status: "open"` and a non-null `exposure` is valid and expected, not a bug.
- `exposure.heldSoFar: true` with `runCount: 0` means **untested, not proven** — which is
  why `confidence.state` reads `unproven` there. Read `runCount` as a floor when
  `runCountTruncated` is `true`.
- `confidence.score` is a `0..0.95` fraction — never a percentage, never `1.0`. For a CI
  gate, branch on `state === "regressed"`, not on `exposure.heldSoFar`.
- `transitions[]` is **oldest-first**, reconstructed from the append-only `audit_log`
  (not a mutable history table), bounded to the 100 most recent
  (`MAX_PATTERN_LIFECYCLE_TRANSITIONS`). It includes the regression guard's own automatic
  `failure_pattern.regressed` rows, whose actor is the system rather than a person.

An unknown fingerprint returns **404**, not `200` with a null body. "Never existed" and
"belongs to another org" are deliberately indistinguishable, so this endpoint cannot be
used as an existence oracle for another org's data.

> **Envelope deviation on this route's own guards.** The `400` (malformed fingerprint)
> and `404` (unknown fingerprint) responses are constructed in the route handler as
> `{ error: { code, message }, requestId }` — `requestId` is a **sibling** of `error`,
> and there is **no `apiVersion` field**. This differs from both the documented v1 error
> envelope and the flat-`ApiError` fallback described above. A client parsing errors from
> this route must tolerate a third shape. (Verified in
> `apps/web/app/api/v1/patterns/[fingerprintHash]/evidence/route.ts`; errors that come
> back from Convex through `mapApiErrorV1` do use the standard envelope.)

### Field projection — `?fields=`

`fields` narrows each returned **stored document** to an allowlisted subset of its keys,
so the unwanted fields are never read, serialized, or put on the wire.

```
GET /api/v1/runs?status=failed&fields=status,startedAt,agentId
```

> ## :warning: Verification status
>
> Read from the implementation on this working tree (uncommitted, on top of HEAD
> `2cf9128`), not from a design document. **Nothing here has been executed:** no Convex
> deployment has ever existed for this project, so every statement below is "this is what
> the code says," never "this is what was observed." Two concrete inconsistencies found
> while reading it are called out in [Known gaps](#known-gaps-field-projection) — check
> those before building a client.

#### Where it is wired

| Endpoint | Projected resource | Identity field |
|----------|--------------------|----------------|
| `GET /api/v1/runs` | `runs` | `_id` |
| `GET /api/v1/runs/{runId}` | `runs` (projects `run` only) | `_id` |
| `GET /api/v1/runs/{runId}/events` | `events` | `sequenceNumber` |
| `GET /api/v1/patterns` | `failure_patterns` | `fingerprintHash` |
| `GET /api/v1/patterns/{fingerprintHash}/evidence` | `failure_patterns` (projects `pattern` only) | `fingerprintHash` |
| `GET /api/v1/runs/{runId}/replay` | — computed projection, not a stored document | n/a |
| `GET /api/v1/runs/{runId}/explanation` | — computed narrative, not a stored document | n/a |

All five document-returning routes import `parseFieldsParam`
(`apps/web/app/api/v1/_lib/fieldsParam.ts`) and forward the parsed list to the matching
`convex/read_api.ts` function.

On `GET /api/v1/runs/{runId}` and the evidence route, projection applies **only to the
stored document** in the response — `eventCount`/`artifactCount`, and the evidence route's
`resolution`/`exposure`/`transitions`/`confidence`, are computed values, not document
fields, and are unaffected.

#### Contract

| Input | Behavior |
|-------|----------|
| `fields` omitted | Full document, byte-identical to before projection existed. Purely opt-in. |
| `?fields=a,b,c` | Each record narrowed to those keys, plus the identity field. |
| Unknown field name | **`422 INVALID_ARGUMENT`** — names the offending field and lists every valid one. Never silently ignored. |
| `?fields=` (empty) | **`400 INVALID_ARGUMENT`**. Not "all fields" — rejected. |
| Empty entry — `?fields=a,,b`, `?fields=a,` | **`400`**. A stray comma is a caller-serializer bug; dropping the slot would hide it. |
| Whitespace-padded entry — `?fields=%20status` | **`400`**. Never trimmed: two different query strings must not mean the same request. |
| Whitespace-only entry | **`400`**. |
| Duplicate entry — `?fields=a,b,a` | **`400`**. Never de-duplicated. |
| Repeated param — `?fields=a&fields=b` | **`400`**. Ambiguous; silently using the first occurrence is refused. |

**Reject, never coerce.** Every ambiguous input above is an error rather than a
normalization, because a coerced value returns a different answer than the caller asked
for and — unlike an error — the caller cannot tell.

Two invariants:

1. **The identity field is always returned**, requested or not, and it is **not always
   `_id`** (`IDENTITY_FIELD`, `convex/read_api.ts`):

   | Resource | Identity field |
   |----------|----------------|
   | `runs` | `_id` |
   | `events` | `sequenceNumber` (Event Log Rule 4 — an event is addressed by its sequence within its run) |
   | `failure_patterns` | `fingerprintHash` (what every pattern-scoped endpoint takes as its key) |

   Requesting it explicitly is harmless — the selection is a set.

2. **Projection is applied after org filtering and cannot change which records come
   back.** Every filter, index range, cursor and org check runs against complete
   documents; `projectDoc` is the last thing to touch a row. `pageSize` is computed from
   the pre-projection array for exactly this reason. Field-name validation runs *before*
   any record lookup, so an unknown-field error is byte-identical whether the addressed
   record is in the key's org, does not exist, or belongs to another org — it is not a
   cross-org existence oracle.

#### Valid field names

The allowlist is **derived from the live Convex schema**, not restated — 
`[...SYSTEM_FIELDS, ...Object.keys(schema.tables[table].validator.fields)].sort()`. So the
accepted names are the **Convex document field names** plus the two system fields `_id`
and `_creationTime`, sorted (the sort makes the error message's "valid fields are: …" list
stable across deployments).

For `runs`, that is currently:

```
_creationTime, _id, agentId, agentVersionId, endedAt, environment, labels,
metadata, modelsSeen, orgId, parentRunId, projectId, sdkVersion, searchText,
sessionId, startedAt, status, tags, tokensIn, tokensOut, triageState, triggeredBy
```

Because the list is schema-derived, it changes automatically when the table changes —
do not hardcode it in a client. Ask for a field you are unsure of and read the valid set
out of the `422`.

#### Error bodies

The two failure classes are raised in different layers and **do not share a shape**:

- **Shape errors** (empty, stray comma, whitespace, duplicate, repeated param) are caught
  in the route before any backend call and return **400** as
  `{ error: { code: 'INVALID_ARGUMENT', message }, requestId }` — no `apiVersion`, and
  `requestId` a sibling of `error` (`fieldsInvalidArgument`). This matches the existing
  inline idiom the `fromSequence` guard already uses.
- **Unknown field names and an empty array** are raised by Convex
  (`validateFieldSelection`) and travel back through `mapApiErrorV1`, so they use the
  **standard v1 error envelope** and map to **422** (`INVALID_ARGUMENT: 422` in
  `apps/web/src/lib/apiErrorMapping.ts`).

A client must therefore handle a `400` and a `422`, in two different body shapes, for what
is conceptually one class of error.

#### Known gap: `id` vs `_id` on runs

**The identity field's spelling on the wire is unresolved**, and this section is the
record of that.

The v1 runs endpoints return **raw Convex documents** — no layer on the path (the route,
`apps/web/src/lib/services/api_v1.ts`, or `apiV1Envelope.ts`) renames anything. A Convex
document's key is `_id`, and `_id` is what `IDENTITY_FIELD.runs` guarantees is always
returned. The `runs` allowlist is schema-derived and therefore contains `_id` and **not**
`id`, so `?fields=id` on a run is a `422`.

But `packages/contracts`' `Run` interface declares `id: string`, and the
`GET /api/v1/runs` success example earlier in this section shows `"id": "run_1"`. Those
predate this cycle. Reading the code, the wire carries `_id`; confirming it requires
running the endpoint, which is not currently possible, so the example is left as-is rather
than silently "corrected" on inference alone.

Downstream this is handled defensively rather than resolved:
`packages/sdk/src/reader.ts` allows **both** spellings —
`PROJECTION_IDENTITY_FIELDS = { runs: ['id', '_id'], … }` — so its ignored-projection
check accepts either as a legitimate unrequested key. That is a deliberate widening of the
*guard*, not an answer to the naming question, and it does not weaken detection (a
deployment that dropped `?fields=` returns the whole document, not one extra key).

**What a client should do today:** request `_id` if you need the identity key by name, and
tolerate either spelling on the way back. **What the owning teams should do:** pick one
and make the contract type, the example above, and the wire agree.

#### One inaccuracy in a neighbouring comment

`packages/mcp/src/field-projection.ts` describes a rejected field name as "an HTTP 400
[that] carries `status: 400`". It is a **422** (unknown field names are raised by Convex,
not the route — see [Error bodies](#error-bodies), and
`tests/unit/field_projection_route.test.ts` asserts 422). The code itself is unaffected —
it discriminates on `status === undefined`, which holds for any defined status — but the
comment will mislead the next reader.

> **`fields` is stricter than every other v1 filter, deliberately.** `status`, `spiking`,
> `muted`, `state` and `limit` are all parsed permissively — a junk value is treated as
> unset (see the note under [`GET /api/v1/patterns`](#get-apiv1patterns)). `fields`
> rejects instead, because a misspelled *filter* returns too much data and the caller
> notices, whereas a misspelled *projection* returns a record missing the key the caller
> was about to read — indistinguishable on the wire from that data being legitimately
> absent. Do not "fix" the inconsistency by making `fields` permissive.

### Rate limits

The v1 read API uses its own key-bucketed rate class, keyed by a hash
prefix of the API key (never the raw secret) — **300 requests/min per key**,
independent of the 600/min ingest-write class `POST /api/events` uses and
the 120/min default write class other routes use. A `429` response includes
a `retry-after: 60` header.

### Error codes

| `error.code`             | HTTP status | Meaning |
|--------------------------|-------------|---------|
| `UNAUTHORIZED`           | 401         | Missing/invalid/expired/revoked API key |
| `FORBIDDEN`              | 403         | Key lacks the `read` scope (or, on management routes, caller lacks the required org role) |
| `NOT_FOUND`              | 404         | Run/event/resource does not exist, or does not belong to the key's org |
| `RUN_NOT_ACTIVE`         | 409         | (write paths only — included for completeness) run is not in a state that accepts the operation |
| `SEQUENCE_CONFLICT`      | 409         | (write paths only) |
| `EVENT_LIMIT_EXCEEDED`   | 422         | (write paths only) |
| `ARTIFACT_LIMIT_EXCEEDED`| 422         | (write paths only) |
| `COMMENT_LIMIT_EXCEEDED` | 422         | (write paths only) |
| `INVALID_ARGUMENT`       | 422         | Malformed filter/argument |
| `RATE_LIMITED`           | 429         | Per-key rate limit exceeded — see `retry-after` header |
| `INTERNAL_ERROR`         | 500         | Unexpected server error — safe to retry with backoff |
| `SERVICE_UNAVAILABLE`    | 503         | Backend (Convex) call timed out |

`FORBIDDEN` is what a scope-denied call actually returns today (the exact
message is `Forbidden: API key lacks required scope "read"`, thrown by the
same `resolveApiKey` helper `convex/sdk_ingest.ts` uses for ingest scope
checks) — treat `FORBIDDEN` from a v1 route as "key exists but cannot read,"
distinct from `UNAUTHORIZED` ("key does not exist / is revoked / expired").

### curl examples

```bash
# List failed runs for one agent
curl -s "https://your-afr-host/api/v1/runs?status=failed&agentId=agent_abc123&limit=10" \
  -H "x-api-key: $AFR_API_KEY" | jq .

# Get one run
curl -s "https://your-afr-host/api/v1/runs/run_xyz789" \
  -H "x-api-key: $AFR_API_KEY" | jq .

# Page through a run's events
curl -s "https://your-afr-host/api/v1/runs/run_xyz789/events?limit=200" \
  -H "x-api-key: $AFR_API_KEY" | jq .

# Fetch the replay projection
curl -s "https://your-afr-host/api/v1/runs/run_xyz789/replay" \
  -H "x-api-key: $AFR_API_KEY" | jq .
```

---

## 2. Alerts & webhooks management API

Base paths: `/api/alerts`, `/api/webhooks-config`. Clerk-session
authenticated (the caller must have an active org context); mutating
operations additionally require the **admin** org role — Convex itself
enforces this (`convex/alerts.ts` / `convex/webhooks.ts`
`requireOrgMembership(ctx, orgId, { minimumRole: "admin" })`), so a member/
viewer calling `POST`/`PUT`/`DELETE` gets a `403 FORBIDDEN`.

Response bodies use the flat `{ code, message, details }` `ApiError` shape
on error (not the v1 envelope — these are internal-UI routes, not the
public v1 API), and a plain JSON object keyed by resource name on success
(`{ rules: [...] }`, `{ webhook: {...} }`, etc.) — no `apiVersion` wrapper.

### Alert rules

| Method | Path                | Role required | Notes |
|--------|---------------------|---------------|-------|
| GET    | `/api/alerts`       | any member    | `{ rules: AlertRule[] }` |
| POST   | `/api/alerts`       | admin         | Body: `{ name, kind, channels, projectId?, thresholdPct?, windowMinutes?, enabled? }` → `{ rule }`, 201 |
| PUT    | `/api/alerts/{id}`  | admin         | Body: any subset of the create fields (except `kind`) → `{ rule }` |
| DELETE | `/api/alerts/{id}`  | admin         | → `{ deleted: true }` |
| GET    | `/api/alerts/events`| any member    | Firing history: `{ events: AlertEvent[] }`, optional `?limit=` |

`kind` is one of `run_failed` \| `failure_rate` \| `eval_failed`. Each
`channels[]` entry is `{ type: "webhook" | "email", target }` (webhook
targets must be `https://`; email targets must look like an email address —
enforced server-side).

```bash
curl -s -X POST "https://your-afr-host/api/alerts" \
  -H "Cookie: __session=..." -H "Content-Type: application/json" \
  -d '{
    "name": "Prod failures",
    "kind": "run_failed",
    "channels": [{ "type": "webhook", "target": "https://example.com/hook" }]
  }'
```

### Outbound webhook targets

| Method | Path                                       | Role required | Notes |
|--------|---------------------------------------------|---------------|-------|
| GET    | `/api/webhooks-config`                       | admin         | `{ webhooks: WebhookTarget[] }` — signing secret always stripped |
| POST   | `/api/webhooks-config`                       | admin         | Body: `{ url, events[] }` → `{ webhook }`, 201. **`webhook.secret` is present ONLY in this response** — persist it immediately, it cannot be retrieved again |
| DELETE | `/api/webhooks-config/{id}`                  | admin         | → `{ deleted: true }` |
| GET    | `/api/webhooks-config/{id}/deliveries`       | admin         | Delivery history: `{ deliveries: WebhookDelivery[] }`, optional `?limit=` |

`url` must be `https://`. `events[]` is a non-empty subset of
`run.completed` \| `run.failed` \| `eval.failed` \| `alert.fired`.

```bash
curl -s -X POST "https://your-afr-host/api/webhooks-config" \
  -H "Cookie: __session=..." -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hook", "events": ["run.failed", "run.completed"] }'
# => { "webhook": { "id": "...", "url": "...", "secret": "<64-hex-chars, save this now>", ... } }
```

### Version comparison & narrative

`GET /api/agents/{agentId}/versions/compare?a={versionIdA}&b={versionIdB}&explain=1`

Clerk-session authenticated, any org member. Wraps `convex/insights.ts`
`compareVersions` (the "did version B regress vs version A" cohort
comparison) and, only when `explain=1` is present, additionally builds a
grounded plain-English narrative (`apps/web/src/lib/versionNarrative.ts`).
Both `versionA`/`versionB` must belong to the `{agentId}` in the path — this
is checked as defense-in-depth on top of `compareVersions`'s own check that
the two version IDs share an agent with each other, so a caller cannot use a
version ID from a different agent to pull cross-agent data through this
URL shape.

Accepts both `a`/`b` and `versionA`/`versionB` query param names (a
compatibility shim for two params guessed independently before this route's
contract was finalized); `a`/`b` win if both pairs are somehow present.

```json
{
  "agentId": "agent_1",
  "versionA": { "id": "ver_a", "version": "1.4", "sampleSize": 120, "...": "..." },
  "versionB": { "id": "ver_b", "version": "1.5", "sampleSize": 100, "...": "..." },
  "comparison": { "failureRate": { "a": 0.08, "b": 0.34, "...": "..." }, "...": "..." },
  "verdict": "regression",
  "narrative": "v1.5 fails 34% vs v1.4's 8% (likely regression, p<0.05). The most common new failure class is tool_timeout on search_docs.",
  "narrativeDetail": {
    "significance": "likely_regression",
    "usedFailureClassBreakdown": true,
    "citedFailureClass": "tool_timeout"
  }
}
```

`verdict`/`narrative`/`narrativeDetail` are present only when `explain=1` is
passed — omitting it returns just the raw `agentId`/`versionA`/`versionB`/
`comparison` passthrough, for callers that only want the cohort numbers.
`narrative` never states a failure class or "on `<tool>`" detail that wasn't
present in `compareVersions`'s own per-version `failureClassCounts` /
`failureClassExamples` (added to `VersionCohortSummary` this cycle) — an
`insufficient_data` or `inconclusive` `narrativeDetail.significance` always
yields an honest "not enough data" / "not statistically significant"
narrative rather than a fabricated cause, and `usedFailureClassBreakdown` is
`false` whenever either cohort is missing the breakdown (e.g. a cohort with
no classified failures, or a `compareVersions` response predating this
field). Errors: `404 NOT_FOUND` for an unknown/cross-org/cross-agent version
ID, `422 INVALID_ARGUMENT` if the two versions don't share an agent,
`401`/`403` for missing auth / non-member.

---

## 3. Consuming an outbound webhook delivery

When a run reaches a terminal state (`run.completed` / `run.failed`) or an
alert fires, Agent Flight Recorder POSTs a signed envelope to every enabled
webhook target subscribed to that event type.

> **Status (final cycle): delivery is fully wired and live.** The signing/
> delivery engine (`apps/web/src/lib/delivery.ts`), the Convex schema/CRUD
> (`convex/webhooks.ts`, `convex/alerts.ts`), and the scheduler/action that
> triggers a delivery from a terminal event are all in place. The moment a
> run's terminal event lands (`convex/events.ts` / `convex/sdk_ingest.ts`),
> `ctx.scheduler.runAfter(0, ...)` schedules `alert_engine.runEvalsThenEvaluateAlerts`,
> which evaluates alert rules and enqueues `webhook_deliveries`/
> `email_deliveries` rows; two per-minute Convex crons,
> `webhook_engine:deliverPendingWebhooks` and `email_engine:deliverPendingEmails`
> (`convex/crons.ts`), drain those queues. See `docs/architecture.md` §8 for
> the full cron/scheduler picture. The payload shape and verification steps
> below are the stable contract this pipeline produces.

### Payload envelope

```json
{
  "apiVersion": "2026-07-19",
  "event": "run.failed",
  "orgId": "org_abc123",
  "run": {
    "id": "run_xyz789",
    "projectId": "proj_1",
    "agentId": "agent_1",
    "agentVersionId": "ver_3",
    "status": "failed",
    "startedAt": 1737300000000,
    "endedAt": 1737300042000,
    "tags": ["prod", "critical"],
    "triggeredBy": "scheduler",
    "sdkVersion": "1.4.0"
  },
  "firedAt": 1737300042500
}
```

`run` deliberately excludes `metadata` (may contain unbounded/sensitive
customer data). `apiVersion` here is the payload envelope's own version,
independent of the v1 read API's `apiVersion` — they happen to share the
same date-string convention but are versioned separately.

### Headers

Every delivery carries:

| Header               | Value |
|-----------------------|-------|
| `x-afr-signature`     | `t=<unix-seconds>,v1=<hex-hmac-sha256>` (svix-style) |
| `x-afr-event`         | The triggering event type, e.g. `run.failed` |
| `x-afr-delivery-id`   | Unique per delivery attempt — use for idempotency/dedup |

### Verifying the signature

1. Parse `x-afr-signature` into its `t=` and `v1=` parts.
2. Reject if `abs(now_seconds - t)` exceeds your replay-tolerance window
   (the reference implementation defaults to 300s / 5 minutes).
3. Recompute `hex(hmac_sha256(your_webhook_secret, "${t}.${raw_request_body}"))`
   — **use the exact raw bytes of the request body**, not a re-serialized
   JSON string (whitespace/key-order differences will break verification).
4. Compare to `v1` using a **constant-time comparison** (never `===` on a
   secret-derived value).
5. Only accept the delivery if step 4 succeeds.

Reference implementation: `signWebhookPayload` / `verifyWebhookSignature` in
`apps/web/src/lib/delivery.ts` (server-side signer) and
`convex/helpers/delivery.ts` (must stay in sync with it — see that file's
header).

**Runnable consumer example:** [`examples/webhook-consumer/`](../examples/webhook-consumer/)
is a complete, dependency-free Node HTTP server implementing the
verify-then-ack flow below end to end — run it with
`AFR_WEBHOOK_SECRET=<your secret> node examples/webhook-consumer/server.mjs`
and point a webhook target at it. Its README walks through registering the
target, the retry/idempotency contract, and how its verification logic is
tested against the same signing code AFR uses.

```js
// Node.js example
const crypto = require('node:crypto')

function verify(secret, rawBody, signatureHeader, toleranceSeconds = 300) {
  const parts = Object.fromEntries(signatureHeader.split(',').map((kv) => kv.split('=')))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(parts.v1, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
```

### Retry behavior

A delivery attempt that fails is retried with exponential backoff + jitter
(mirroring the SDK's own transport backoff), up to a bounded number of
attempts, after which the delivery is marked terminally `failed`. Each
attempt is recorded as an immutable row in `webhook_deliveries`
(`GET /api/webhooks-config/{id}/deliveries` to inspect); a `4xx` response
from your endpoint (other than 429) is treated as non-retryable — return
`5xx` or `429` if you want a delivery retried, `2xx` to acknowledge receipt,
and any other `4xx` to tell Agent Flight Recorder not to retry.

Consumers should be **idempotent** on `x-afr-delivery-id` regardless — a
delivery may be retried even after your endpoint successfully processed it
(e.g. if the response was lost in transit).

---

## 4. The `afr` CLI and this API

`packages/cli` (the `afr` command) is a thin client over the surfaces
documented above — it introduces no server-side behavior of its own. Every
`afr` command maps directly onto one of the HTTP calls in this document:

| `afr` command       | Calls |
|----------------------|-------|
| `afr patterns`       | `GET /api/v1/patterns` |
| `afr patterns evidence <fingerprint>` | `GET /api/v1/patterns/{fingerprintHash}/evidence` |
| `afr explain <id>`   | `GET /api/v1/runs/{runId}/explanation` |
| `afr runs list`      | `GET /api/v1/runs` |
| `afr runs get <id>`  | `GET /api/v1/runs/{runId}` |
| `afr tail <id>`      | `GET /api/v1/runs/{runId}/events` (polled) |
| `afr replay <id>`    | `GET /api/v1/runs/{runId}/replay` |
| `afr export <id>`    | `GET /api/v1/runs/{runId}/events` (paginated through to completion) |

**Start with `afr patterns` and `afr explain`, not `afr export`.** The first two rows
of that table answer "what is broken?" and "why did this run fail?" for a few hundred
tokens' worth of output; `afr export` pages a whole event log to completion. The same
progressive-disclosure ordering the MCP server enforces applies here — see
`docs/mcp.md` → "Start here" for the measured costs.

### Exit codes

`packages/cli/src/index.ts` returns a single set of process exit codes for every
command:

| Code | Meaning |
|---|---|
| `0` | Success — **including a successful request that matched nothing, and one that matched everything** |
| `1` | Usage error (bad or conflicting flags) |
| `2` | Auth failure (missing/invalid/revoked/expired key, or a key lacking `read`) |
| `3` | Not found |
| `4` | Network or server error |
| `10` | **`afr triage` only — "findings."** Verdict `issues`: ranked items were found. |
| `11` | **"Could not evaluate."** On `afr patterns`, a *filtered* request whose scan hit the server's row ceiling. On `afr triage`, verdict `unknown` — or `clear` with an incomplete view. |

#### Exit `11` — the gate code that matters

`afr patterns` maps `scanTruncated` onto a dedicated exit code
(`PATTERNS_SCAN_INCOMPLETE_EXIT_CODE = 11`,
`packages/cli/src/commands/patterns.ts`). The reasoning is worth stating plainly:
**exit 0 from a gate is a claim — "I checked, and it is clean" — and a truncated scan
has not checked.** So a filtered request that comes back on a truncated scan exits `11`
instead of `0`, annotated `[scan truncated N/M rows]`, and still prints the full page it
did get. Page with the API's `nextCursor` until the scan completes, or treat the run as
inconclusive.

**Only with an active filter.** An unfiltered listing does not truncate — the server
sizes its scan to the page (`scanSize = filtering ? PATTERN_SCAN_ROW_CEILING : needed`)
— and an unfiltered browse makes no whole-dataset claim to falsify. The annotation still
prints; only the exit code is withheld.

Output distinguishes the two truncated cases. **Empty and truncated** does not print
"No recurring failure patterns found" — that is a whole-dataset claim, and it is false
after a truncated scan; it reports no matches *in the rows scanned* and states plainly
that this is not "none exist". **Non-empty and truncated** prints the table, then a
`PARTIAL [scan truncated N/M rows]` footnote.

> **On `afr patterns`, exit `11` separates INCONCLUSIVE from CONCLUSIVE. It does not
> separate clean from dirty.** `afr patterns --state regressed` still exits `0` whether
> it found a regression or not — that command has no "matches found" exit code. A gate
> built on it must still parse `--json` and fail on a non-empty `patterns` array itself.
> What it no longer has to do is guess whether an *empty* array meant anything.

#### `afr triage` — exits `0` / `10` / `11`

`afr triage` has landed (`packages/cli/src/commands/triage.ts`, registered in
`packages/cli/src/index.ts`) and is the command that closes the "clean vs dirty" gap
above: `0` clear, `10` findings, `11` inconclusive. `10` wins over `11` when both apply
— findings are actionable, and the incompleteness is reported in the output and in
`--json`'s `complete` field.

**Exit `0` is unreachable on an incomplete scan**, and not by a convention this command
applies on top of the result: `verdict: "clear"` is only ever constructed when every
honesty check passed, so the property belongs to the verdict itself and cannot be
weakened in the CLI later. `exitCodeForTriage` is the whole mapping.

`--json` prints the raw `TriageResult`, byte-identical to what the `afr_triage` MCP tool
returns (both call `toTriageResult` from `@agent-flight-recorder/sdk`), including
next-hop pointers in their MCP tool-name form.

> Verified at commit `600b4f8` (clean tree). One stale artifact remains: the `@returns`
> comment on `main()` in `packages/cli/src/index.ts:109` still lists only `0/1/2/3/4`
> and has been updated for neither `10` nor `11`. Both codes are real in the command
> modules; the doc comment is wrong.

All of the above require a **`read`**-scoped API key — see
[Minting a read key for the v1 API / CLI](#minting-a-read-key-for-the-v1-api--cli).
Configure it via the `AFR_API_KEY` env var (`AFR_BASE_URL` for the
deployment host; run `afr config check` to validate both and ping
`/api/health`) — see `packages/cli/README.md` and `packages/cli/src/env.ts`.
There is no separate CLI-specific auth mechanism — it is the same
`x-api-key` header and the same envelope/error-code contract documented in
[section 1](#1-public-v1-read-api) above. `packages/cli/src/apiClient.ts`
parses the `{ apiVersion, data }` / `{ apiVersion, error }` envelope
tolerantly (see that file's header comment), so a CLI built against an
earlier `apiVersion` degrades gracefully rather than crashing on an
unrecognized field.

The CLI has **no write commands** against this API (it cannot create runs,
ingest events, or manage keys/alerts/webhooks) — those remain SDK
(`packages/sdk`) and web-UI-only surfaces. A `read`-scoped key is sufficient
for every `afr` command; an `ingest:write`-only key is rejected by all of
them with `403 FORBIDDEN`.

---

## 5. The MCP server and this API

`packages/mcp` is a second read-only client of the same surface, for MCP
clients (Claude, Cursor, or an agent debugging its own runs). Like the CLI it
adds no server-side behavior, uses the same `x-api-key` header, needs the same
**`read`** scope, and shares the same 300 req/min per-key rate class — give it
its own key rather than sharing the CLI's.

Its tools map onto the endpoints above, including the two failure-pattern
endpoints (`GET /api/v1/patterns` and
`GET /api/v1/patterns/{fingerprintHash}/evidence`), which are now documented in
[section 1](#get-apiv1patterns) — until this cycle `docs/mcp.md` was their only
reference:

| MCP tool                      | Calls |
|-------------------------------|-------|
| `afr_triage` **(entry point)** | `GET /api/v1/patterns` (one call, `limit=50`) |
| `afr_list_failure_patterns`   | `GET /api/v1/patterns` |
| `afr_get_pattern_evidence`    | `GET /api/v1/patterns/{fingerprintHash}/evidence` |
| `afr_explain_run`             | `GET /api/v1/runs/{runId}/explanation` |
| `afr_get_run_events`          | `GET /api/v1/runs/{runId}/events` (windowed) |
| `afr_list_runs`               | `GET /api/v1/runs` |

**The tools are a ladder, and the entry point is `afr_triage`** — one call, zero
required arguments, at most five ranked items, each carrying the exact tool and
arguments to call next. It makes exactly one upstream request (`GET /api/v1/patterns`
with `limit=50`); the ranking and capping happen in `packages/sdk/src/triage.ts`
(`packages/mcp/src/triage.ts` is a pure re-export of it), so it is not a new data source
and cannot disagree with tier 1. The `afr triage` CLI command imports the same
`toTriageResult`, so the two surfaces cannot rank differently either.

Measured client-visible costs: ~332 tokens for triage (~435 worst case), ~294 for tier 1
(ten patterns), ~423 for tier 2, ~121 for tier 3, and up to ~3,844 for a single
saturated tier-4 event window — roughly 12x triage and 32x tier 3. An agent that opens
with `afr_get_run_events` pays the most for the least, and has to know a run id before it
can even make the call. `docs/mcp.md` → "Start here" has the ladder, the worked example
with running costs, and where those numbers were measured (real projections over
contract-maximal fixtures; **not** against a running deployment, since none has ever
existed). Those figures are held in place by `scripts/check-token-budgets.ts`, which enumerates
the tools from the MCP server's own registry and measures each registered handler
against a contract-maximal fixture — `docs/mcp.md` → "What keeps these numbers true"
has the ratchet rules and what is still unwired.

A triage response separates `verdict` (`issues` / `clear` / `unknown`) from `complete`,
because "nothing is broken" and "I could not evaluate" are different answers and neither
should be read as the other. Any consumer using it as a build gate must treat
`verdict: "unknown"` and `complete: false` as inconclusive rather than clean — see
`docs/mcp.md` → "Using this as a CI gate", which also covers the `scanTruncated`
semantics for `state: "regressed"`.

`docs/mcp.md` additionally carries a verification-status banner for what in it has and
has not been exercised, and explains where server-side field projection does and does not
save an MCP caller anything.

> Token figures re-measured at commit `600b4f8` (clean tree) by driving the committed
> contract-maximal fixtures through the real projections; the previous set was written
> at `2695655` against uncommitted changes and four of the numbers had gone stale. The
> CLI counterpart `afr triage` **has since landed** — see
> [`afr triage` — exits `0` / `10` / `11`](#afr-triage--exits-0--10--11) above.
