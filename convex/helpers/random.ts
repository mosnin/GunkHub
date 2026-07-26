/**
 * helpers/random.ts — Web Crypto randomness + hex encoding for the DEFAULT
 * Convex runtime (the V8 isolate).
 *
 * WHY THIS EXISTS: Convex's default runtime is a V8 isolate with Web APIs but
 * WITHOUT Node builtins. A module may only use Node builtins if it carries the
 * `"use node"` directive, and that directive is legal ONLY in files that export
 * exclusively actions. Secret generation happens inside MUTATIONS
 * (`webhooks.ts:createWebhook`, and the alert-engine's
 * `findOrCreateAlertWebhookTarget`), so `node:crypto`'s `randomBytes` is not
 * available to them at any price — a `"use node"` file cannot hold a mutation.
 * `crypto.getRandomValues` is part of the Web Crypto API that IS present in the
 * isolate, is synchronous (so it does not change any call-site shape), and is
 * a CSPRNG. Convex seeds per-execution randomness from a cryptographically
 * secure source, so values are unpredictable across invocations.
 *
 * See also `helpers/delivery.ts`, which uses `crypto.subtle` for the same
 * reason (HMAC signing).
 */

/** Lowercase hex-encode bytes — the same encoding as Node's `.digest("hex")` / `.toString("hex")`. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Generate `byteLength` cryptographically random bytes, hex-encoded.
 *
 * Byte-for-byte a drop-in replacement for `randomBytes(n).toString("hex")`:
 * same alphabet, same `2 * n` length, same entropy source class.
 */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
