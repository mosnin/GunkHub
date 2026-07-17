/**
 * Best-effort, per-instance, in-memory token-bucket rate limiter.
 *
 * IMPORTANT SCOPE NOTE: this limiter lives in the Next.js server process
 * memory. In a serverless / multi-instance deployment each instance has its
 * own buckets, so the effective global limit is (limit x instance count) and
 * buckets reset on cold starts. That is acceptable here: it is a cheap
 * abuse/flood dampener for UNAUTHENTICATED routes (Clerk webhook, internal
 * verify-derivation). Durable, per-key rate limiting for the ingestion path
 * stays in Convex (api_keys.rateLimitPerMin) — do not move it here.
 */

interface Bucket {
  tokens: number
  lastRefillMs: number
}

export interface RateLimiter {
  /** Returns true if the caller identified by `key` may proceed, false if rate-limited. */
  check(key: string): boolean
}

const MAX_BUCKETS = 10_000 // hard cap so hostile IP churn cannot exhaust memory

/**
 * Create a token-bucket limiter allowing `limit` requests per `windowMs`
 * (default one minute), refilled continuously.
 */
export function createRateLimiter(limit: number, windowMs = 60_000): RateLimiter {
  const buckets = new Map<string, Bucket>()
  const refillPerMs = limit / windowMs

  return {
    check(key: string): boolean {
      const now = Date.now()
      let bucket = buckets.get(key)
      if (!bucket) {
        if (buckets.size >= MAX_BUCKETS) {
          // Evict the oldest entry (Map preserves insertion order).
          const oldest = buckets.keys().next()
          if (!oldest.done) buckets.delete(oldest.value)
        }
        bucket = { tokens: limit, lastRefillMs: now }
        buckets.set(key, bucket)
      }
      // Continuous refill up to the bucket capacity.
      const elapsed = now - bucket.lastRefillMs
      bucket.tokens = Math.min(limit, bucket.tokens + elapsed * refillPerMs)
      bucket.lastRefillMs = now

      if (bucket.tokens < 1) return false
      bucket.tokens -= 1
      return true
    },
  }
}

/**
 * Extract the client IP for rate-limit keying. Prefers the first entry of
 * x-forwarded-for (set by the hosting proxy), then x-real-ip. Falls back to a
 * shared key so the limiter still bounds total throughput when no IP header
 * is present (e.g. local dev).
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const real = req.headers.get('x-real-ip')
  if (real) return real
  return 'unknown'
}
