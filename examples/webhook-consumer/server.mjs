#!/usr/bin/env node
// Agent Flight Recorder — example webhook consumer.
//
// A tiny, dependency-free, standalone Node HTTP server that receives an
// outbound webhook delivery, verifies its signature, and acknowledges it.
// No framework (no express/fastify/etc.) — only Node's built-in `http` and
// `crypto` modules, so it runs anywhere `node` runs with zero `npm install`.
//
// This matches the delivery format AFR actually sends, byte-for-byte:
//   - Signature header:  x-afr-signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
//   - HMAC input:         `${t}.${rawRequestBody}` (the EXACT raw bytes — do
//                          not re-serialize the JSON before verifying)
//   - Event header:       x-afr-event: e.g. "run.failed"
//   - Delivery id header: x-afr-delivery-id (use for idempotency/dedup)
//
// See convex/helpers/delivery.ts (signWebhookPayload / deliverWebhook) and
// docs/api_reference.md section 3 ("Consuming an outbound webhook delivery")
// for the full contract this implements.
//
// Usage:
//   AFR_WEBHOOK_SECRET=whsec_your_secret_here node server.mjs
//   AFR_WEBHOOK_SECRET=whsec_your_secret_here PORT=8787 node server.mjs
//
// Then configure this URL as a webhook target via
//   POST /api/webhooks-config  (see docs/api_reference.md) — the response's
// `webhook.secret` is what you set as AFR_WEBHOOK_SECRET here.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

// Delivery attempts older than this are rejected as stale/possibly-replayed,
// matching the 300s (5 minute) tolerance documented in docs/api_reference.md.
const DEFAULT_TOLERANCE_SECONDS = 300

// Hard cap on request body size. AFR webhook payloads are small JSON event
// envelopes (never large blobs — those stay externalized as artifact
// pointers per the event-log rules), so this is generous headroom, not a
// tight fit. Without a cap, a slow/hostile sender (or a bug on either side)
// could stream an unbounded body and exhaust this process's memory before
// signature verification ever runs.
const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 MiB

/**
 * Parse an `x-afr-signature` header of the form `t=<seconds>,v1=<hex>` into
 * its parts. Returns null if the header is missing or malformed.
 */
export function parseSignatureHeader(header) {
  if (!header) return null
  const parts = Object.fromEntries(
    header
      .split(',')
      .map((kv) => kv.split('='))
      .filter((kv) => kv.length === 2),
  )
  if (typeof parts.t !== 'string' || typeof parts.v1 !== 'string') return null
  return { t: parts.t, v1: parts.v1 }
}

/**
 * Verify a webhook delivery's signature against the raw (unparsed) request
 * body. Returns `{ valid: true }` or `{ valid: false, reason }`.
 *
 * IMPORTANT: `rawBody` must be the exact bytes AFR sent — a re-serialized
 * JSON string (different key order or whitespace) will not match.
 */
export function verifyWebhookSignature(secret, rawBody, signatureHeader, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS) {
  const parsed = parseSignatureHeader(signatureHeader)
  if (!parsed) return { valid: false, reason: 'missing or malformed x-afr-signature header' }

  const t = Number(parsed.t)
  if (!Number.isFinite(t)) return { valid: false, reason: 'x-afr-signature "t" is not a valid timestamp' }

  const ageSeconds = Math.abs(Date.now() / 1000 - t)
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: `timestamp outside tolerance (${String(Math.round(ageSeconds))}s old)` }
  }

  const expectedHex = createHmac('sha256', secret).update(`${parsed.t}.${rawBody}`).digest('hex')

  let expected
  let actual
  try {
    expected = Buffer.from(expectedHex, 'hex')
    actual = Buffer.from(parsed.v1, 'hex')
  } catch {
    return { valid: false, reason: 'x-afr-signature "v1" is not valid hex' }
  }

  // Constant-time comparison — never `===` on a secret-derived value, and
  // never compare buffers of different lengths with timingSafeEqual
  // (it throws instead of returning false).
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { valid: false, reason: 'signature mismatch' }
  }

  return { valid: true }
}

/** In-memory idempotency set — a real consumer should persist this durably. */
const seenDeliveryIds = new Set()
const MAX_TRACKED_DELIVERIES = 10_000

function rememberDelivery(deliveryId) {
  if (!deliveryId) return false // no id to dedup on — treat as never seen
  const alreadySeen = seenDeliveryIds.has(deliveryId)
  seenDeliveryIds.add(deliveryId)
  if (seenDeliveryIds.size > MAX_TRACKED_DELIVERIES) {
    // Bound memory: drop the oldest entry (Sets preserve insertion order).
    const oldest = seenDeliveryIds.values().next().value
    seenDeliveryIds.delete(oldest)
  }
  return alreadySeen
}

class PayloadTooLargeError extends Error {}

/**
 * Read the full request body, bounded to `maxBytes`. Once the running total
 * crosses the cap, further chunks are dropped (not buffered — this is what
 * bounds memory) but the stream keeps draining until `end` rather than
 * destroying the socket outright: cutting the connection mid-upload can race
 * the client's own write and surface as a confusing connection-reset error
 * instead of the intended 413 response. Draining to completion lets the
 * handler respond normally once the client finishes sending.
 */
function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let exceeded = false
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        exceeded = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (exceeded) {
        reject(new PayloadTooLargeError(`body exceeds ${String(maxBytes)} bytes`))
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

/**
 * Build the request handler. Exported (rather than only wired to `http`)
 * so tests/tooling can drive it without binding a real socket.
 */
export function createHandler(secret, { log = console.log } = {}) {
  return async function handleRequest(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'method not allowed' }))
      return
    }

    let rawBody
    try {
      rawBody = await readRawBody(req)
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        log(`[webhook-consumer] rejected oversized request body: ${err.message}`)
        if (!res.headersSent) {
          res.writeHead(413, { 'content-type': 'application/json' }).end(
            JSON.stringify({ error: 'payload too large' }),
          )
        }
        return
      }
      throw err
    }
    const signatureHeader = req.headers['x-afr-signature']
    const eventType = req.headers['x-afr-event'] ?? 'unknown'
    const deliveryId = req.headers['x-afr-delivery-id'] ?? null

    const verification = verifyWebhookSignature(secret, rawBody, signatureHeader)
    if (!verification.valid) {
      log(`[webhook-consumer] REJECTED delivery ${deliveryId ?? '(no id)'}: ${verification.reason}`)
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'invalid signature', reason: verification.reason }),
      )
      return
    }

    // Idempotency: a delivery may be retried even after we already
    // successfully processed it (e.g. our 2xx response was lost in
    // transit) — consumers must tolerate that, not just senders.
    const isRetry = rememberDelivery(deliveryId)

    let payload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      // Signature was valid but the body isn't JSON — extremely unlikely
      // from a real AFR delivery, but ack anyway (2xx) rather than trigger
      // a retry storm for a payload we could still receive fine.
      log(`[webhook-consumer] delivery ${deliveryId ?? '(no id)'} (${eventType}) had a non-JSON body; acking anyway`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ received: true }))
      return
    }

    if (isRetry) {
      log(`[webhook-consumer] duplicate delivery ${deliveryId} (${eventType}) — already processed, re-acking`)
    } else {
      log(
        `[webhook-consumer] verified delivery ${deliveryId ?? '(no id)'}: event=${eventType} ` +
          `run=${payload?.run?.id ?? '?'} status=${payload?.run?.status ?? '?'}`,
      )
      // ---- Your business logic goes here ----
      // e.g. update a ticket, page someone, kick off a re-run, etc.
      // Keep this fast: AFR times out a delivery attempt and treats a slow
      // response as a failure (retryable) exactly like a 5xx.
    }

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ received: true }))
  }
}

// Only start listening when run directly (`node server.mjs`), not when
// imported by a test.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const secret = process.env.AFR_WEBHOOK_SECRET
  if (!secret) {
    console.error('Missing required env var: AFR_WEBHOOK_SECRET (the webhook.secret from POST /api/webhooks-config)')
    process.exit(1)
  }
  const port = Number(process.env.PORT ?? 8787)
  const server = createServer(createHandler(secret))
  server.listen(port, () => {
    console.log(`[webhook-consumer] listening on http://localhost:${String(port)}`)
    console.log('[webhook-consumer] configure this URL (behind a public https:// endpoint) as an AFR webhook target')
  })
}
