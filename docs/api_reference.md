# Agent Flight Recorder — API Reference

This document covers two HTTP surfaces added in Cycle 2 of the action layer
(`docs/design/action_layer.md`, ADR-003 `docs/adr/003-alerting-webhooks-export.md`):

1. **The public v1 read API** (`/api/v1/**`) — key-authed, for the `afr` CLI
   and other external, automated consumers that need to read run/event data
   without a browser session.
2. **The alerts & webhooks management API** (`/api/alerts/**`,
   `/api/webhooks-config/**`) — Clerk-authed, used by the web UI's settings
   pages to configure alert rules and outbound webhook targets.

It also documents how to verify and consume an **outbound webhook
delivery** — the payload Agent Flight Recorder POSTs to a configured
webhook target when a run completes/fails or an alert fires.

For the existing SDK-ingest routes (`POST /api/events`, `POST /api/runs`,
key-authed for writing) and the Clerk-authed run-browsing routes the web UI
itself uses (`GET /api/runs`, etc.), see their route source directly — this
document covers only what Cycle 2 added.

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

> **Known gap, flagged for follow-up:** the key-management UI/route
> (`POST /api/api-keys`) does not yet expose `"read"` in its allowed-scopes
> list (`ALLOWED_SCOPES` in `apps/web/app/api/api-keys/route.ts` currently
> only allows `"ingest:write"` / `"ingest:read"`). Until that list is
> updated, issue v1-read-API keys with no `scopes` array (full back-compat
> access) rather than expecting a dedicated read-only key today.

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

---

## 3. Consuming an outbound webhook delivery

When a run reaches a terminal state (`run.completed` / `run.failed`) or an
alert fires, Agent Flight Recorder POSTs a signed envelope to every enabled
webhook target subscribed to that event type.

> **Cycle-2 status:** the signing/delivery engine
> (`apps/web/src/lib/delivery.ts`) and the Convex schema/CRUD
> (`convex/webhooks.ts`, `convex/alerts.ts`) both exist; the scheduler/action
> that actually triggers a delivery from a terminal event is the piece
> `docs/design/action_layer.md` describes as still to be wired. The payload
> shape and verification steps below are the stable contract regardless of
> when the trigger lands.

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
`apps/web/src/lib/delivery.ts`.

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
