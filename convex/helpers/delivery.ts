/**
 * helpers/delivery.ts — Convex-side mirror of the PURE parts of
 * `apps/web/src/lib/delivery.ts` (the Cycle-1 pure/transport-level webhook
 * delivery engine), so `convex/webhook_engine.ts` (a Convex `internalAction`,
 * which CAN call `fetch`) can sign and send outbound webhook deliveries
 * without an import that crosses the apps/web <-> convex deployment
 * boundary (`docs/design/action_layer.md` flagged this as an open decision
 * for Cycle 2 to resolve explicitly — this file resolves it in favor of
 * mirroring, not importing directly, because this repo's workspace/tsconfig
 * boundaries make a `convex/` -> `apps/web/` import fragile and untested).
 *
 * KEEP IN SYNC with `apps/web/src/lib/delivery.ts`. Both files must agree on:
 *   - the HMAC-SHA256 signature format (`t=<ts>,v1=<hex>`)
 *   - the SSRF-guard matrix (https-only, private/reserved IP ranges,
 *     blocked hostname suffixes/exacts)
 *   - the backoff formula (exponential + full jitter, capped)
 *   - the retryable/non-retryable HTTP status classification
 * A fix to one must be mirrored in the other — see ADR-002's action_layer
 * doc for the shared-test-fixture recommendation (tests/unit/delivery.test.ts
 * and convex/*.test.ts assert both engines against the same vectors).
 *
 * This module does not read or write Convex tables — it is pure/transport
 * logic only, exactly like its apps/web counterpart.
 */
import { createHmac } from "node:crypto";
import { isIP } from "node:net";

// ---------------------------------------------------------------------------
// Signature (svix-style: t=<unix-seconds>,v1=<hex hmac-sha256>)
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256-sign a webhook payload, svix-style. See
 * apps/web/src/lib/delivery.ts's signWebhookPayload for the full consumer
 * verification-steps doc comment (identical format here).
 */
export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  const signedContent = `${String(timestamp)}.${body}`;
  const hex = createHmac("sha256", secret).update(signedContent).digest("hex");
  return `t=${String(timestamp)},v1=${hex}`;
}

// ---------------------------------------------------------------------------
// SSRF guard — identical matrix to apps/web/src/lib/delivery.ts
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAME_SUFFIXES = [".internal", ".local"];
const BLOCKED_HOSTNAME_EXACT = new Set(["localhost"]);

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local
  return false;
}

export class UnsafeWebhookUrlError extends Error {
  constructor(reason: string) {
    super(`Refusing to deliver webhook: ${reason}`);
    this.name = "UnsafeWebhookUrlError";
  }
}

/**
 * Reject webhook target URLs that are not safe to let the server fetch.
 * See apps/web/src/lib/delivery.ts's assertSafeWebhookUrl for the full
 * KNOWN LIMITATION note (syntactic check only, no resolve-then-pin — this
 * mirror carries the same limitation and must be hardened alongside it).
 */
export function assertSafeWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeWebhookUrlError("not a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new UnsafeWebhookUrlError("only https:// targets are allowed");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const lowerHost = hostname.toLowerCase();

  if (BLOCKED_HOSTNAME_EXACT.has(lowerHost)) {
    throw new UnsafeWebhookUrlError(`hostname "${hostname}" is not allowed`);
  }
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lowerHost.endsWith(suffix))) {
    throw new UnsafeWebhookUrlError(`hostname "${hostname}" uses a blocked internal suffix`);
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isPrivateIpv4(hostname)) {
    throw new UnsafeWebhookUrlError(`IP literal "${hostname}" is in a private/reserved range`);
  }
  if (ipVersion === 6 && isPrivateIpv6(hostname)) {
    throw new UnsafeWebhookUrlError(`IP literal "${hostname}" is in a private/reserved range`);
  }
}

// ---------------------------------------------------------------------------
// Backoff — identical formula to apps/web/src/lib/delivery.ts
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** Initial back-off in ms (doubled each attempt). Default: 500. */
  backoffMs?: number;
  /** Upper bound on any single back-off delay, before jitter. Default: 30 000. */
  maxBackoffMs?: number;
}

/**
 * Exponential back-off capped at `maxBackoffMs`, with full jitter. `attempt`
 * is 0-indexed (the delay before the FIRST retry).
 */
export function computeBackoff(attempt: number, options: BackoffOptions = {}): number {
  const backoffMs = options.backoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const exponential = backoffMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxBackoffMs);
  return Math.floor(Math.random() * capped);
}

// ---------------------------------------------------------------------------
// deliverWebhook — identical classification rules to apps/web/src/lib/delivery.ts
// ---------------------------------------------------------------------------

export interface DeliverWebhookParams {
  url: string;
  secret: string;
  /** Event type name, e.g. "run.failed" — sent verbatim as `x-afr-event`. */
  event: string;
  /** JSON-serializable payload; this module owns the JSON.stringify + signing. */
  payload: unknown;
  /** Idempotency/tracing id for this delivery attempt. */
  deliveryId: string;
  /** Fetch timeout in ms. Default: 10 000. */
  timeoutMs?: number;
}

export interface DeliverWebhookResult {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * POST a signed webhook payload to `url`. Classification:
 *   - 2xx -> ok, not retryable (success)
 *   - 4xx -> not ok, NOT retryable (client/consumer error)
 *   - 5xx -> not ok, retryable
 *   - network error / timeout -> not ok, retryable
 *
 * Always calls {@link assertSafeWebhookUrl} first — the only sanctioned way
 * to make an outbound webhook request from convex/webhook_engine.ts.
 */
export async function deliverWebhook(params: DeliverWebhookParams): Promise<DeliverWebhookResult> {
  const { url, secret, event, payload, deliveryId, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  assertSafeWebhookUrl(url);

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(secret, body, timestamp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-afr-signature": signature,
        "x-afr-event": event,
        "x-afr-delivery-id": deliveryId,
      },
      body,
      signal: controller.signal,
    });

    if (res.ok) {
      return { ok: true, status: res.status, retryable: false };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, retryable: true, error: `HTTP ${String(res.status)}` };
    }
    return { ok: false, status: res.status, retryable: false, error: `HTTP ${String(res.status)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    return { ok: false, status: null, retryable: true, error: message };
  } finally {
    clearTimeout(timer);
  }
}
