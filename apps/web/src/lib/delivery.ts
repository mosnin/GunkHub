/**
 * delivery.ts — pure/transport-level webhook + alert-email delivery engine.
 *
 * This module is intentionally decoupled from Convex and from Team A's
 * `webhook_deliveries` / `alert_rules` tables (owned by the data agent). It
 * ships now as pure, independently testable building blocks:
 *
 *   - signWebhookPayload / verify steps documented below (svix-style HMAC)
 *   - deliverWebhook (fetch POST with signature headers + timeout)
 *   - computeBackoff (exponential + full jitter, mirrors packages/sdk/src/transport.ts)
 *   - assertSafeWebhookUrl (SSRF guard)
 *   - renderAlertEmailText (provider-agnostic plain-text renderer)
 *
 * Cycle-2 wiring plan (which Convex table/action calls into this) lives in
 * docs/design/action_layer.md. Nothing here reads or writes Convex.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

// ---------------------------------------------------------------------------
// Signature (svix-style: t=<unix-seconds>,v1=<hex hmac-sha256>)
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256-sign a webhook payload, svix-style.
 *
 * Signed content is `${timestamp}.${body}` (timestamp in whole seconds,
 * body the exact raw bytes/string sent on the wire — sign it BEFORE
 * JSON.stringify-ing anything twice). Returns a header value of the form
 * `t=<timestamp>,v1=<hex-hmac>` so a consumer can recover the timestamp
 * used and, per svix convention, support multiple signature versions/keys
 * in the future without breaking existing verifiers.
 *
 * Consumer-side verification steps (document alongside the SDK):
 *   1. Parse the header into its `t=` and `v1=` components.
 *   2. Reject if `now - t` exceeds your replay-tolerance window (e.g. 5 min).
 *   3. Recompute `hex(hmac_sha256(secret, `${t}.${rawBody}`))` and compare to
 *      `v1` using a constant-time comparison (never `===` on secrets/HMACs).
 *   4. Only accept the delivery if the comparison succeeds.
 */
export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  const signedContent = `${String(timestamp)}.${body}`
  const hex = createHmac('sha256', secret).update(signedContent).digest('hex')
  return `t=${String(timestamp)},v1=${hex}`
}

/**
 * Verify a `t=...,v1=...` signature header against a secret and raw body.
 * `toleranceSeconds` bounds replay — a signature older (or newer, allowing
 * for clock skew) than this is rejected even if the HMAC matches.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=')
      return idx === -1 ? [kv, ''] : [kv.slice(0, idx), kv.slice(idx + 1)]
    }),
  )
  const t = parts['t']
  const v1 = parts['v1']
  if (!t || !v1) return false

  const timestamp = Number(t)
  if (!Number.isFinite(timestamp)) return false
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false

  const expected = createHmac('sha256', secret)
    .update(`${t}.${body}`)
    .digest('hex')

  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(v1, 'hex')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/**
 * Known-unsafe hostname suffixes/exacts, beyond literal private/reserved IPs.
 * `.internal` / `.local` are common self-hosted conventions for
 * intranet-only services; blocking them is a heuristic, not a guarantee
 * (an operator could still point a public DNS name at an internal IP —
 * see the DNS-rebinding note below).
 */
const BLOCKED_HOSTNAME_SUFFIXES = ['.internal', '.local']
const BLOCKED_HOSTNAME_EXACT = new Set(['localhost'])

/** Reserved/private IPv4 CIDR ranges rejected as webhook targets. */
function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 10) return true // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 127) return true // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 0) return true // 0.0.0.0/8
  return false
}

/** Reserved/private IPv6 ranges rejected as webhook targets. */
function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  if (normalized === '::1') return true // loopback
  if (normalized === '::') return true // unspecified
  // fc00::/7 (unique local) — first 7 bits are 1111 110, i.e. fc00-fdff
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true
  // fe80::/10 (link-local)
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true
  return false
}

export class UnsafeWebhookUrlError extends Error {
  constructor(reason: string) {
    super(`Refusing to deliver webhook: ${reason}`)
    this.name = 'UnsafeWebhookUrlError'
  }
}

/**
 * Reject webhook target URLs that are not safe to let the server fetch:
 * non-HTTPS, literal private/reserved IPs, and well-known internal hostname
 * conventions.
 *
 * KNOWN LIMITATION (flagged for the audit cycle): this is a syntactic check
 * against the URL/hostname at call time. It does NOT resolve DNS and pin the
 * resolved IP for the actual outbound fetch, so a public hostname that
 * currently resolves to a public IP but is rebound (via a short-TTL DNS
 * record) to a private IP between this check and the fetch is not caught.
 * Full mitigation requires resolve-then-pin (resolve the hostname once,
 * validate the resolved IP, then connect directly to that IP while still
 * sending the original Host/SNI) — deferred to the security-hardening pass
 * noted in docs/design/action_layer.md.
 */
export function assertSafeWebhookUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnsafeWebhookUrlError('not a valid URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new UnsafeWebhookUrlError('only https:// targets are allowed')
  }

  // Hostname without brackets (URL keeps IPv6 literals bracketed, e.g. "[::1]").
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  const lowerHost = hostname.toLowerCase()

  if (BLOCKED_HOSTNAME_EXACT.has(lowerHost)) {
    throw new UnsafeWebhookUrlError(`hostname "${hostname}" is not allowed`)
  }
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lowerHost.endsWith(suffix))) {
    throw new UnsafeWebhookUrlError(`hostname "${hostname}" uses a blocked internal suffix`)
  }

  const ipVersion = isIP(hostname)
  if (ipVersion === 4 && isPrivateIpv4(hostname)) {
    throw new UnsafeWebhookUrlError(`IP literal "${hostname}" is in a private/reserved range`)
  }
  if (ipVersion === 6 && isPrivateIpv6(hostname)) {
    throw new UnsafeWebhookUrlError(`IP literal "${hostname}" is in a private/reserved range`)
  }
}

// ---------------------------------------------------------------------------
// Backoff (mirrors packages/sdk/src/transport.ts createRetryStrategy)
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** Initial back-off in ms (doubled each attempt). Default: 500. */
  backoffMs?: number
  /** Upper bound on any single back-off delay, before jitter. Default: 30 000. */
  maxBackoffMs?: number
}

/**
 * Exponential back-off capped at `maxBackoffMs`, with full jitter (a random
 * value in `[0, capped]`) to avoid synchronized retries against a recovering
 * endpoint. `attempt` is 0-indexed (the delay before the FIRST retry, i.e.
 * after the initial attempt has already failed once).
 */
export function computeBackoff(attempt: number, options: BackoffOptions = {}): number {
  const backoffMs = options.backoffMs ?? 500
  const maxBackoffMs = options.maxBackoffMs ?? 30_000
  const exponential = backoffMs * Math.pow(2, attempt)
  const capped = Math.min(exponential, maxBackoffMs)
  return Math.floor(Math.random() * capped)
}

// ---------------------------------------------------------------------------
// deliverWebhook
// ---------------------------------------------------------------------------

export interface DeliverWebhookParams {
  url: string
  secret: string
  /** Event type name, e.g. "run.failed" — sent verbatim as `x-afr-event`. */
  event: string
  /** JSON-serializable payload; this module owns the JSON.stringify + signing. */
  payload: unknown
  /** Idempotency/tracing id for this delivery attempt. */
  deliveryId: string
  /** Fetch timeout in ms. Default: 10 000. */
  timeoutMs?: number
}

export interface DeliverWebhookResult {
  ok: boolean
  status: number | null
  retryable: boolean
  error?: string
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * POST a signed webhook payload to `url`.
 *
 * Classification (mirrors the SDK transport's rules):
 *   - 2xx → ok, not retryable (success)
 *   - 4xx → not ok, NOT retryable (client/consumer error — retrying won't help)
 *   - 5xx → not ok, retryable
 *   - network error / timeout → not ok, retryable
 *
 * Always calls {@link assertSafeWebhookUrl} first — a caller that skips this
 * function and calls fetch directly bypasses the SSRF guard, so this is the
 * only sanctioned way to make an outbound webhook request.
 */
export async function deliverWebhook(params: DeliverWebhookParams): Promise<DeliverWebhookResult> {
  const { url, secret, event, payload, deliveryId, timeoutMs = DEFAULT_TIMEOUT_MS } = params

  assertSafeWebhookUrl(url)

  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = signWebhookPayload(secret, body, timestamp)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-afr-signature': signature,
        'x-afr-event': event,
        'x-afr-delivery-id': deliveryId,
      },
      body,
      signal: controller.signal,
    })

    if (res.ok) {
      return { ok: true, status: res.status, retryable: false }
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, retryable: true, error: `HTTP ${String(res.status)}` }
    }
    // 4xx (or other non-2xx/5xx) — not retryable.
    return { ok: false, status: res.status, retryable: false, error: `HTTP ${String(res.status)}` }
  } catch (err) {
    // Network error, DNS failure, or AbortError from the timeout — all retryable.
    const message = err instanceof Error ? err.message : 'network error'
    return { ok: false, status: null, retryable: true, error: message }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Alert email rendering (provider-agnostic — no provider wired yet)
// ---------------------------------------------------------------------------

/**
 * Minimal shape this renderer needs from an alert firing. Deliberately
 * decoupled from Team A's `alert_rules`/`alert_events` schema (not yet
 * defined) — the cycle-2 wiring plan (docs/design/action_layer.md) maps the
 * real Convex record onto this shape before calling the renderer.
 */
export interface AlertEmailInput {
  alertName: string
  orgName: string
  runId: string
  runStatus: string
  agentName: string
  firedAt: number
  /** Human-readable condition that triggered the alert, e.g. "run.failed". */
  condition: string
  /** Link back to the run in the web UI. */
  runUrl: string
}

/**
 * Render a plain-text email body for a fired alert. No email provider (SES,
 * Resend, Postmark, ...) is wired yet — provider selection and the actual
 * SMTP/API send are an operator step documented in
 * docs/design/action_layer.md. This function only produces the body text so
 * it can be unit tested and reused regardless of the provider chosen later.
 */
export function renderAlertEmailText(alert: AlertEmailInput): string {
  const firedAtIso = new Date(alert.firedAt).toISOString()
  return [
    `Agent Flight Recorder alert: ${alert.alertName}`,
    '',
    `Organization: ${alert.orgName}`,
    `Agent:        ${alert.agentName}`,
    `Run:          ${alert.runId}`,
    `Status:       ${alert.runStatus}`,
    `Condition:    ${alert.condition}`,
    `Fired at:     ${firedAtIso}`,
    '',
    `View run: ${alert.runUrl}`,
    '',
    '— Agent Flight Recorder',
  ].join('\n')
}
