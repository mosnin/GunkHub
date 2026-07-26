# Observability

How logs, request correlation, health checks, and rate limits actually work in this
codebase today. This is a companion to `docs/operations_runbook.md` (symptom → fix)
and `docs/ops/incident_response.md` (triage playbooks) — this doc is the reference for
"what does the system emit and where does it go."

---

## Logging contract

All structured logging goes through `apps/web/src/lib/logger.ts`. There is no logging
library dependency — `logger` is a ~50-line wrapper that emits one JSON object per line.

**Shape** (`emit()` in `logger.ts`):

```json
{ "ts": "2026-07-18T09:12:03.441Z", "level": "info", "msg": "request", "requestId": "...", "route": "/api/runs", "method": "GET", "status": 200, "durationMs": 42 }
```

Fixed fields: `ts` (ISO timestamp), `level`, `msg`. Everything else is caller-supplied
context (`LogContext`), commonly `requestId`, `route`, `orgId`, and free-form keys.
`err` (if present) is never logged raw — `serializeError()` turns it into
`{ name, message, stack }` before it lands in the JSON line.

**Levels:** `debug`, `info`, `warn`, `error`. Sink selection is by level, not by call
site: `warn` and `error` go to `console.error` (stderr), `debug`/`info` go to
`console.log` (stdout). This split matters because Vercel's log pipeline lets you
filter by stream.

**Who calls it:**
- `withApiHandler` (`apps/web/src/lib/apiHandler.ts`) emits exactly ONE `request` log
  line per HTTP request, on every code path (success, 4xx, 5xx, rate-limited). Fields:
  `route`, `method`, `status`, `durationMs`, `requestId`, `orgId` (when resolved),
  plus `err` on error paths. Anything ≥500 logs at `error`, everything else at `info`.
- Individual routes add their own `logger.warn`/`logger.error` calls for
  route-specific events (e.g. `/api/csp-report` logs one `csp-violation` line per
  violation; the Clerk webhook route logs failures per event type).
- Convex functions use `console.log`/`console.warn`/`console.error` directly (Convex
  function logs are a separate log stream from the Next.js app — see below) — e.g.
  artifact GC's `Artifact GC: batch=N cleaned=C ...` line, retention's
  `PURGE COMPLETE org=... ` line, and `organizations.ts`'s structured
  `ORG_DELETION_REQUESTED` JSON warning.

## Where logs go on Vercel

Vercel captures anything written to stdout/stderr from a Function invocation as that
invocation's "Runtime Logs." By default these are visible in the Vercel dashboard
(Project → Logs) for a limited retention window and are NOT durable or searchable
long-term.

**To ship logs to a durable/searchable sink (Datadog, Axiom, Better Stack, etc.):**
attach a **Log Drain**. Vercel → Project → Settings → Log Drains → Add. Point it at
your provider's ingest endpoint (most providers publish a "Vercel integration" that
handles this in one click — e.g. the Datadog Vercel integration, the Axiom Vercel
integration). Because every line this app writes is already a single JSON object,
no reformatting/parsing step is needed on the way in — configure the drain's parser
as "JSON" (or the provider's native JSON-lines mode) and every field (`ts`, `level`,
`msg`, `requestId`, `route`, `orgId`, ...) becomes a queryable/filterable attribute.

**Convex function logs are separate.** Convex functions (queries/mutations/actions/
crons) do not go through the Next.js app or Vercel's log pipeline at all — they live
in the Convex dashboard (Deployment → Logs) and have their own retention and, on paid
plans, their own log stream/export integration. If you are correlating an incident
across both (e.g. a `withConvexTimeout` 503 in the Next.js log and the Convex
function it was calling), you need both dashboards — there is no unified log view
today.

---

## Request-ID correlation flow

Every request gets a `requestId`, minted or propagated by `getRequestId()` in
`logger.ts`:

1. **Inbound:** if the caller sent an `x-request-id` header (length ≤ 128 chars, to
   bound hostile input), that value is reused. Otherwise `crypto.randomUUID()` mints
   a new one.
2. **Propagation:** `withApiHandler` computes the `requestId` once per request and
   threads it through `ApiHandlerContext` to the route handler, the request log
   line, and every error response body (`details.requestId` in the `ApiError` JSON,
   or top-level `requestId` in ad-hoc error responses like the Clerk webhook route).
3. **Outbound:** the wrapper sets `x-request-id` on every response header
   (`res.headers.set('x-request-id', requestId)`), including error responses (503
   from `ConvexTimeoutError`, 429 from rate limiting, mapped `afrError` codes, and
   the generic 500 fallback).

**Support flow — user report → requestId → log line:**
1. User (or SDK-consuming customer) reports an error. Ask them for the `requestId`
   from the response body (`ApiError.details.requestId`) or, if they have raw HTTP
   access, the `x-request-id` response header.
2. If the customer instead supplies their OWN `x-request-id` in the request (SDKs are
   free to do this to pre-correlate with their own traces), that same value round-trips
   — the same lookup works.
3. In the Vercel log drain / dashboard, filter for `requestId:"<value>"`. Because the
   whole line is JSON, this is an exact-match filter, not a substring search — no false
   positives from timestamp or duration collisions.
4. That single log line has `route`, `method`, `status`, `durationMs`, and `orgId`
   (when the request resolved one). If `status >= 500` or the mapped error is a
   `ConvexTimeoutError`/afrError code, the `err` field (when present) has the full
   `{ name, message, stack }`.
5. If the failure involved a Convex function (mutation/action), cross-reference the
   same time window in the Convex dashboard's function logs — there is no shared
   requestId between the two systems today (Convex mutations do not receive or log
   the Next.js requestId), so correlate by org + timestamp instead.

---

## Health endpoint

`GET /api/health` (`apps/web/app/api/health/route.ts`, backed by
`apps/web/src/lib/health.ts`) is unauthenticated and rate-limit-exempt
(`{ rateLimit: { disabled: true } }`) so uptime probes on tight schedules are never
turned away. `export const dynamic = 'force-dynamic'` forces it to run per-request
rather than being statically cached at build time.

**Two layers:**
- `getHealthData()` — synchronous, reads `process.env` only. Computes
  `storage.adapter` (`'vercel'` if `BLOB_STORE_TOKEN` is set and non-empty, else
  `'stub'`), `storage.configured` (same boolean), `projection` (static — always
  `{ model: 'on-demand', materializationEnabled: false }`, since projections are never
  materialized in v1), and `environment` (from `NODE_ENV`).
- `checkHealth()` — the async deep check used by the route. Pings two dependencies in
  parallel, each bounded by a 2-second deadline (`DEPENDENCY_TIMEOUT_MS`; a timed-out
  probe reports `'down'`):
  - **Convex** (`pingConvex`) — hard dependency. Runs a trivial query
    (`organizations.getOrganization` with a sentinel `clerkOrgId`). Any response —
    including an application-level "not found" error — counts as `'ok'`; only a
    transport-level failure (message matching `/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket/i`)
    counts as `'down'`. Skipped (reported `'down'` immediately) if
    `NEXT_PUBLIC_CONVEX_URL` is unset.
  - **Blob storage** (`pingBlobStorage`) — soft dependency (the stub adapter is a
    working fallback). HEADs `BLOB_STORE_URL`; any HTTP response (even a 4xx) counts
    as `'ok'` — this probes transport reachability, not object existence. Reports
    `'skipped'` (not `'down'`) when `BLOB_STORE_TOKEN`/`BLOB_STORE_URL` are unset,
    since there is deliberately nothing external to check.

**Status semantics:**
- `status: "ok"` — `httpStatus 200`. Neither hard nor soft dependency is down, and
  (in production) the storage adapter is not the stub.
- `status: "degraded"` — `httpStatus 200` still. Either: production is running the
  stub storage adapter (`environment === 'production' && adapter === 'stub'`), or
  blob storage pinged `'down'`. Convex is still reachable in this state — the app is
  usable but something needs attention.
- **503** — `httpStatus 503` (independent of the `status` string, which will still
  read `"degraded"` in the body). This is the ONLY case that maps to a non-200 HTTP
  status: `convexStatus === 'down'`. Convex is the hard dependency; if it's
  unreachable the route itself fails closed. Load balancers / uptime monitors should
  key their alerting off the HTTP status code, not the JSON `status` field, since only
  the HTTP code distinguishes "Convex is down" from "everything else that degrades but
  still serves."

`SystemHealthPanel` (web UI) calls `getHealthData()` directly rather than hitting
`/api/health` over HTTP, to avoid a same-origin loopback fetch from within the
Next.js server process.

---

## CSP report endpoint

`POST /api/csp-report` (`apps/web/app/api/csp-report/route.ts`) is the `report-uri` /
`report-to` target configured in `apps/web/next.config.js`'s Content-Security-Policy.
The CSP is currently deployed in **Report-Only mode** (`Content-Security-Policy-Report-Only`
header) specifically so this soak period produces observable violation data before the
policy is enforced.

**What arrives:** browsers POST violation reports in one of two wire formats, both
handled:
- `application/csp-report` (legacy `report-uri`): `{ "csp-report": { ... } }`
- `application/reports+json` (`report-to`): an array of `{ type, url, body: {...} }`

The route is **log-only** — it extracts a bounded set of fields
(`documentUri`, `effectiveDirective`, `violatedDirective`, `blockedUri`, `sourceFile`,
`lineNumber`, `disposition`), truncates every string field to 512 bytes, caps at 10
reports per request body, caps the total body at 32 KB, and emits one
`logger.warn('csp-violation', { requestId, route, ...violation })` line per
violation. The raw body is never echoed back or persisted. The endpoint always
returns `204` (even on a malformed or oversized body) — there is nothing a browser
can do with a non-204 response to a report POST.

Deliberately unauthenticated (browsers send these without credentials) and tightly
rate-limited: `{ rateLimit: { key: 'ip', limitPerMin: 10 } }` — see the per-instance
caveat below, since this specific route is exactly the kind of unauthenticated,
IP-keyed endpoint that caveat is written for.

To watch for policy violations before flipping to enforce mode: filter the log drain
for `msg:"csp-violation"` and look at `violatedDirective`/`blockedUri` to see what's
tripping the (not-yet-enforced) policy.

---

## Rate-limit classes

All in-process rate limiting is a token-bucket limiter (`createRateLimiter` in
`apps/web/src/lib/rateLimit.ts`), continuously refilled, one bucket map per limiter
instance, capped at `MAX_BUCKETS = 10_000` buckets (oldest evicted first) so hostile
key churn can't exhaust memory.

**`withApiHandler` defaults** (used when a route doesn't override
`opts.rateLimit.limitPerMin`): 300/min for GET, 120/min for anything else
(`DEFAULT_READ_LIMIT_PER_MIN` / `DEFAULT_WRITE_LIMIT_PER_MIN`).

**Per-route overrides actually configured today** (grepped from `apps/web/app/api/**/route.ts`):

| Route | Key | Limit/min | Notes |
|---|---|---|---|
| `POST /api/events` | `apiKey` | 600 | SDK ingest — highest-volume route |
| `POST /api/artifacts/upload` | `apiKey` | 120 | |
| `POST /api/runs` | `apiKey` | 120 | |
| `PATCH /api/runs/[id]/status` | `apiKey` | 120 | |
| `POST /api/internal/verify-derivation` | `ip` | 60 | Called by the Convex `verifyRecentRuns` action |
| `POST /api/csp-report` | `ip` | 10 | Unauthenticated report sink |
| `GET /api/health` | — | disabled | Uptime probes must never be throttled |
| `POST /api/webhooks/clerk` | — | 60/min/IP | **Not** via `withApiHandler` — this route calls `createRateLimiter(60)` directly (Svix-verified, not Clerk-JWT-authenticated, so it can't use the `org`/`apiKey` key kinds) |
| All other routes (`GET /api/runs`, `/api/comments`, `/api/diff`, `/api/api-keys`, ...) | `auto` (default) | 300 (GET) / 120 (else) | No explicit override in the route file |

Key derivation (`resolveRateLimitKey`): `'apiKey'` hashes the `x-api-key` header
(SHA-256 prefix, never the raw key) and falls back to IP if absent; `'org'` reads the
Clerk `orgId` from `auth()` and falls back to IP if unauthenticated; `'auto'` (the
default) tries API-key, then org, then IP.

**The per-instance caveat (read this before trusting these numbers under load):**
this limiter lives in the Next.js server process's memory. Vercel Functions are
serverless/multi-instance — each concurrently-running instance has its own bucket
map, so the EFFECTIVE global limit for a bursty caller is `configured limit × number
of warm instances serving that key`, not the configured number. Buckets also reset on
every cold start. This is an intentional, accepted trade-off for a cheap
abuse/flood dampener on unauthenticated or low-stakes routes (Clerk webhook,
verify-derivation, CSP reports). It is explicitly NOT relied on for durable per-key
ingestion limits — that job belongs to Convex's own `api_keys.rateLimitPerMin`
(enforced inside `convex/sdk_ingest.ts`, which is a single durable counter per API
key, immune to the multi-instance problem). If you need a hard, trustworthy cap,
it has to live in Convex, not in `rateLimit.ts`.
