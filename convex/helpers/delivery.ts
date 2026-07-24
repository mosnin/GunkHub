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
 *
 * RUNTIME NOTE (deploy blocker fixed 2026-07-24): this file used to
 * `import { createHmac } from "node:crypto"` and `{ isIP } from "node:net"`.
 * Convex's DEFAULT runtime is a V8 isolate with no Node builtins; a module may
 * only use them under a `"use node"` directive, which is legal only in files
 * exporting exclusively actions. This module is imported by `webhooks.ts` and
 * `alerts.ts` (both mutation modules), so `"use node"` was never available to
 * it. Both imports are gone:
 *   - HMAC now uses Web Crypto (`crypto.subtle`), which the isolate provides.
 *     Its API is async, so `signWebhookPayload` is now async.
 *   - `isIP` is reimplemented in pure TS below (`ipVersion`), differential-
 *     tested against `node:net.isIP` over millions of vectors.
 * The apps/web mirror still runs under Node and keeps its `node:crypto` path;
 * the two remain byte-for-byte equivalent (see webhook_crypto.test.ts).
 */
import { bytesToHex } from "./random.js";

// ---------------------------------------------------------------------------
// Signature (svix-style: t=<unix-seconds>,v1=<hex hmac-sha256>)
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256-sign a webhook payload, svix-style. See
 * apps/web/src/lib/delivery.ts's signWebhookPayload for the full consumer
 * verification-steps doc comment (identical format here).
 *
 * ASYNC (Web Crypto), unlike the apps/web mirror which is sync (node:crypto).
 * The BYTES are identical: Web Crypto's HMAC key material is the UTF-8 encoding
 * of `secret` (exactly what `createHmac("sha256", secret)` uses for a string
 * key), and the signed content is the UTF-8 encoding of `${timestamp}.${body}`
 * (exactly what `.update(string)` uses). Wire format is unchanged, so already-
 * shipped consumers keep verifying.
 */
export async function signWebhookPayload(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const signedContent = `${String(timestamp)}.${body}`;
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  // node:crypto accepts a zero-length HMAC key; Web Crypto's importKey rejects
  // one with a DataError. HMAC zero-pads any key shorter than the hash's
  // 64-byte block, so an all-zero 64-byte key is bit-identical to the empty
  // key — asserted against a node:crypto vector in webhook_crypto.test.ts.
  // No live secret is empty (they are all randomHex(32)); this only keeps a
  // hypothetical legacy/blank row signing instead of throwing.
  const keyBytes = secretBytes.length === 0 ? new Uint8Array(64) : secretBytes;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signedContent));
  const hex = bytesToHex(new Uint8Array(signature));
  return `t=${String(timestamp)},v1=${hex}`;
}

// ---------------------------------------------------------------------------
// SSRF guard — identical matrix to apps/web/src/lib/delivery.ts
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAME_SUFFIXES = [".internal", ".local"];
const BLOCKED_HOSTNAME_EXACT = new Set(["localhost"]);

// --- pure-TS replacement for node:net's isIP (see RUNTIME NOTE at the top) ---
//
// Semantics must match `node:net.isIP` EXACTLY, in both directions: a literal
// this function fails to recognise as an IP would skip the private/reserved
// range checks below and silently WEAKEN the SSRF guard. `webhook_crypto.test.ts`
// differential-tests `ipVersion` against the real `node:net.isIP` over a
// hand-written edge-case corpus plus millions of generated vectors.
//
// Rules replicated (all verified against Node 20's isIP):
//   IPv4: exactly four decimal octets 0-255, NO leading zeros ("01" is not an IP).
//   IPv6: hex groups of 1-4 digits; at most one "::"; "::" must stand for at
//         least one group (8 explicit groups + "::" is invalid); an embedded
//         IPv4 tail is legal only as the final textual group and counts as two
//         groups; an optional "%zone" suffix is accepted (Node accepts one on
//         any IPv6 literal, not just link-local) with charset [0-9A-Za-z.:-]+.
const IPV4_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
const IPV6_ZONE_RE = /^[0-9A-Za-z.:-]+$/;

function isIPv4Literal(s: string): boolean {
  return IPV4_RE.test(s);
}

function isIPv6Literal(s: string): boolean {
  let address = s;
  const pct = s.indexOf("%");
  if (pct !== -1) {
    if (!IPV6_ZONE_RE.test(s.slice(pct + 1))) return false;
    address = s.slice(0, pct);
  }
  if (address.length === 0) return false;

  const dbl = address.indexOf("::");
  let left: string[];
  let right: string[];
  if (dbl === -1) {
    left = address.split(":");
    right = [];
  } else {
    if (address.indexOf("::", dbl + 1) !== -1) return false; // more than one "::"
    const leftStr = address.slice(0, dbl);
    const rightStr = address.slice(dbl + 2);
    left = leftStr === "" ? [] : leftStr.split(":");
    right = rightStr === "" ? [] : rightStr.split(":");
  }

  const groups = [...left, ...right];
  if (groups.length === 0) return dbl !== -1; // "::" on its own is valid

  // An embedded IPv4 tail is only legal as the very last textual group. When
  // the address ends in "::", the last atom lives in `left` and is therefore
  // not trailing ("1.2.3.4::" is not an IPv6 address).
  const ipv4TailIndex = dbl !== -1 && right.length === 0 ? -1 : groups.length - 1;

  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] as string;
    if (i === ipv4TailIndex && group.includes(".")) {
      if (!isIPv4Literal(group)) return false;
      count += 2;
      continue;
    }
    if (!IPV6_GROUP_RE.test(group)) return false;
    count += 1;
  }
  return dbl === -1 ? count === 8 : count <= 7;
}

/** Drop-in replacement for `node:net`'s `isIP`: 4, 6, or 0. Exported for the differential test. */
export function ipVersion(host: string): 0 | 4 | 6 {
  if (isIPv4Literal(host)) return 4;
  if (isIPv6Literal(host)) return 6;
  return 0;
}

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

  const version = ipVersion(hostname);
  if (version === 4 && isPrivateIpv4(hostname)) {
    throw new UnsafeWebhookUrlError(`IP literal "${hostname}" is in a private/reserved range`);
  }
  if (version === 6 && isPrivateIpv6(hostname)) {
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
  const signature = await signWebhookPayload(secret, body, timestamp);

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
