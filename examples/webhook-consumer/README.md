# webhook-consumer (example)

A tiny, standalone Node HTTP server that shows how to **receive, verify, and
acknowledge** an Agent Flight Recorder outbound webhook delivery. No
framework — just Node's built-in `http` and `crypto` modules, so it runs
anywhere `node` (>= 18) runs with zero `npm install`.

This matches the delivery format AFR actually sends — see
[`docs/api_reference.md`](../../docs/api_reference.md), section 3
("Consuming an outbound webhook delivery"), and
[`convex/helpers/delivery.ts`](../../convex/helpers/delivery.ts) for the
canonical implementation this example verifies against.

## Run it

```bash
# 1. Create a webhook target in AFR (Clerk-authed, admin role):
curl -s -X POST "https://your-afr-host/api/webhooks-config" \
  -H "Cookie: __session=..." -H "Content-Type: application/json" \
  -d '{ "url": "https://your-public-host/webhook", "events": ["run.failed", "run.completed"] }'
# => { "webhook": { "id": "...", "url": "...", "secret": "<64-hex-chars, SAVE THIS NOW>", ... } }
# The secret is returned ONLY in this response — it cannot be retrieved again.

# 2. Run this server with that secret:
AFR_WEBHOOK_SECRET=<the secret from step 1> node server.mjs
# optionally: PORT=8787 (default)

# 3. Expose it at a public https:// URL (AFR only delivers to https:// targets —
#    e.g. via a tunnel like ngrok/cloudflared while testing) matching the
#    "url" you registered in step 1.
```

When a run reaches a terminal state (or an alert fires), AFR POSTs a signed
JSON envelope to your URL. This server verifies the signature, logs a
one-line summary, and responds `200 { "received": true }`.

## What it does, step by step

1. Reads the **raw** request body (not `JSON.parse`d yet — signature
   verification needs the exact bytes AFR signed).
2. Parses the `x-afr-signature: t=<unix-seconds>,v1=<hex-hmac-sha256>` header.
3. Rejects timestamps more than 300 seconds (5 minutes) old or in the future
   — a basic replay-window guard.
4. Recomputes `hex(hmac_sha256(secret, "${t}.${rawBody}"))` and compares it to
   the received `v1` value using `crypto.timingSafeEqual` (constant-time —
   never compare secrets with `===`).
5. On success: dedups on `x-afr-delivery-id` (an in-memory `Set` here — use a
   durable store in production, e.g. your database's primary key constraint),
   parses the JSON payload, and (in this example) just logs it — this is
   where you'd plug in real business logic (update a ticket, page someone,
   trigger a re-run, etc).
6. Responds `200` to acknowledge. AFR treats `2xx` as delivered, `4xx`
   (except `429`) as non-retryable ("don't try again"), and `5xx`/`429` as
   retryable.

## Retry / idempotency behavior to design around

- A delivery may be retried by AFR even after you already processed it
  successfully (e.g. if your `200` response was lost in transit) — always be
  idempotent on `x-afr-delivery-id`, don't assume "first time I've seen this
  ID" per attempt.
- An invalid signature gets `401` here (non-retryable from AFR's
  perspective — a wrong/rotated secret won't fix itself by retrying).
- Keep your handler fast. AFR applies a delivery timeout and treats a slow
  response the same as a failure.

## Testing the verification logic without a live AFR deployment

`server.mjs` exports `verifyWebhookSignature` and `parseSignatureHeader` as
plain functions (no server required to call them) — see
`tests/unit/webhook_consumer_example.test.ts` in this repo for signed-request
fixtures built the same way `convex/helpers/delivery.ts`'s `signWebhookPayload`
builds them, verified end-to-end against this example.

## Payload shape (for reference)

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
customer data).
