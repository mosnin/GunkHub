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
| `afr runs list`      | `GET /api/v1/runs` |
| `afr runs get <id>`  | `GET /api/v1/runs/{runId}` |
| `afr tail <id>`      | `GET /api/v1/runs/{runId}/events` (polled) |
| `afr replay <id>`    | `GET /api/v1/runs/{runId}/replay` |
| `afr export <id>`    | `GET /api/v1/runs/{runId}/events` (paginated through to completion) |

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

Its five tools map onto the endpoints above, plus the two failure-pattern
endpoints (`GET /api/v1/patterns` and
`GET /api/v1/patterns/{fingerprintHash}/evidence`) that this document does not
yet cover:

| MCP tool                      | Calls |
|-------------------------------|-------|
| `afr_list_failure_patterns`   | `GET /api/v1/patterns` |
| `afr_get_pattern_evidence`    | `GET /api/v1/patterns/{fingerprintHash}/evidence` |
| `afr_explain_run`             | `GET /api/v1/runs/{runId}/explanation` |
| `afr_get_run_events`          | `GET /api/v1/runs/{runId}/events` (windowed) |
| `afr_list_runs`               | `GET /api/v1/runs` |

The tools are deliberately tiered by token cost, and the ordering matters —
see `docs/mcp.md`, which is currently also the only reference for the two
pattern endpoints and carries a verification-status banner for what in it has
and has not been exercised.
