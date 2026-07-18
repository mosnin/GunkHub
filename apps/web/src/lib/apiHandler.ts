/**
 * withApiHandler — the single wrapper every API route handler goes through.
 *
 * Provides, in one place:
 *   1. Request-ID mint/propagation — honors inbound `x-request-id` (length-capped
 *      in getRequestId), echoes it on every response.
 *   2. ONE structured request log line per request (route, method, status,
 *      durationMs, orgId when available, requestId) on success AND error paths.
 *   3. Generic error bodies — unexpected errors are logged with full detail but
 *      the response body never contains raw err.message. Clients get
 *      `{ code: 'INTERNAL_ERROR', message: 'Internal error', requestId }`.
 *   4. Per-caller token-bucket rate limiting (best-effort, per-instance — see
 *      lib/rateLimit.ts scope note). Keyed by api-key hash prefix for ingest
 *      routes, Clerk orgId for authenticated routes, client IP as fallback.
 *   5. Convex timeout mapping — ConvexTimeoutError becomes a 503 with requestId.
 *   6. Stable afrError code mapping — Convex mutations throw errors whose
 *      message carries a `CODE: message` prefix (convex/helpers/errors.ts);
 *      mapAfrErrorResponse translates known codes to HTTP statuses and puts
 *      `code` in the JSON body so the SDK can branch on it.
 *
 * Usage:
 *   export const GET = withApiHandler('/api/runs', async (req, ctx) => { ... })
 *   export const POST = withApiHandler(
 *     '/api/events',
 *     async (req, ctx) => { ... },
 *     { rateLimit: { limitPerMin: 600, key: 'apiKey' } },
 *   )
 *
 * Route handlers keep their own try/catch ONLY for route-specific error
 * mappings (404 not-found, 401 invalid key, afr code mapping) and rethrow
 * anything they do not recognize — the wrapper logs it and genericizes.
 */
import {
  parseAfrApiErrorCode,
  type AfrApiErrorCode,
  type ApiError,
} from '@agent-flight-recorder/contracts'
import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import { ConvexTimeoutError, hashApiKey } from './convexServer'
import { getRequestId, logger } from './logger'
import { createRateLimiter, getClientIp } from './rateLimit'

// ---------------------------------------------------------------------------
// afrError code mapping (cross-boundary contract with convex/helpers/errors.ts)
// ---------------------------------------------------------------------------

// HTTP status for each stable code in AFR_API_ERROR_CODES (contracts 0.6.4,
// api_errors.ts) — the shared const mirrored from convex/helpers/errors.ts.
const AFR_CODE_TO_STATUS: Readonly<Record<AfrApiErrorCode, number>> = {
  RUN_NOT_ACTIVE: 409,
  SEQUENCE_CONFLICT: 409,
  EVENT_LIMIT_EXCEEDED: 422,
  ARTIFACT_LIMIT_EXCEEDED: 422,
  COMMENT_LIMIT_EXCEEDED: 422,
  RATE_LIMITED: 429,
}

/**
 * If `err` carries a known `CODE: message` afrError prefix (anywhere in the
 * message — Convex wraps server errors in its own envelope), return the mapped
 * JSON response with `{ code }` in the body so the SDK can branch. Returns
 * null for unrecognized errors so callers fall through to existing behavior.
 * The echoed message is the server-authored text after the code prefix, never
 * the full raw Convex envelope.
 */
export function mapAfrErrorResponse(err: unknown, requestId: string): NextResponse | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const code = parseAfrApiErrorCode(message)
  if (!code) return null
  const status = AFR_CODE_TO_STATUS[code]
  // Server-authored detail after the prefix, first line only, bounded length.
  const idx = message.indexOf(`${code}:`)
  const detail =
    idx === -1
      ? code
      : message
          .slice(idx + code.length + 1)
          .split('\n')[0]
          ?.trim()
          .slice(0, 500)
  return NextResponse.json<ApiError>(
    { code, message: detail?.length ? detail : code, details: { requestId } },
    {
      status,
      headers: {
        'x-request-id': requestId,
        ...(status === 429 ? { 'retry-after': '60' } : {}),
      },
    },
  )
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** How to derive the rate-limit bucket key for a request. */
export type RateLimitKeyKind =
  /** api-key hash prefix → Clerk orgId → IP (default). */
  | 'auto'
  /** SHA-256 prefix of the x-api-key header; falls back to IP when absent. */
  | 'apiKey'
  /** Clerk orgId; falls back to IP when unauthenticated. */
  | 'org'
  /** Client IP only. */
  | 'ip'

export interface ApiHandlerOptions {
  rateLimit?: {
    /** Requests per minute per key. Defaults: 300 for GET, 120 otherwise. */
    limitPerMin?: number
    /** Key derivation strategy. Default 'auto'. */
    key?: RateLimitKeyKind
    /** Skip rate limiting entirely (health, CSP report sink has its own). */
    disabled?: boolean
  }
}

export interface ApiHandlerContext {
  requestId: string
  /**
   * Record the caller's org for the request log line. Optional — the wrapper
   * also picks up the Clerk orgId automatically when it resolves one for
   * rate-limit keying.
   */
  setOrgId(orgId: string): void
}

const DEFAULT_READ_LIMIT_PER_MIN = 300
const DEFAULT_WRITE_LIMIT_PER_MIN = 120

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

export function withApiHandler<Args extends unknown[]>(
  routeName: string,
  handler: (req: NextRequest, ctx: ApiHandlerContext, ...args: Args) => Promise<Response>,
  opts: ApiHandlerOptions = {},
): (req: NextRequest, ...args: Args) => Promise<Response> {
  // One limiter per wrapped handler (module scope) — buckets are per-key inside.
  const keyKind: RateLimitKeyKind = opts.rateLimit?.key ?? 'auto'
  const limiterFor = new Map<number, ReturnType<typeof createRateLimiter>>()
  const getLimiter = (limit: number) => {
    let limiter = limiterFor.get(limit)
    if (!limiter) {
      limiter = createRateLimiter(limit)
      limiterFor.set(limit, limiter)
    }
    return limiter
  }

  return async (req: NextRequest, ...args: Args): Promise<Response> => {
    const requestId = getRequestId(req)
    const startedAt = Date.now()
    const method = req.method
    let orgId: string | undefined

    const ctx: ApiHandlerContext = {
      requestId,
      setOrgId(id: string) {
        orgId = id
      },
    }

    const logLine = (status: number, extra: Record<string, unknown> = {}) => {
      const context = {
        route: routeName,
        method,
        status,
        durationMs: Date.now() - startedAt,
        requestId,
        ...(orgId !== undefined && { orgId }),
        ...extra,
      }
      if (status >= 500) logger.error('request', context)
      else logger.info('request', context)
    }

    // -- Rate limiting -----------------------------------------------------
    if (!opts.rateLimit?.disabled) {
      const limit =
        opts.rateLimit?.limitPerMin ??
        (method === 'GET' ? DEFAULT_READ_LIMIT_PER_MIN : DEFAULT_WRITE_LIMIT_PER_MIN)
      const key = resolveRateLimitKey(req, keyKind, ctx)
      if (!getLimiter(limit).check(key)) {
        logLine(429, { rateLimitKey: key })
        return NextResponse.json<ApiError>(
          { code: 'RATE_LIMITED', message: 'Too many requests', details: { requestId } },
          { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60' } },
        )
      }
    }

    // -- Handler + error normalization ------------------------------------
    try {
      const res = await handler(req, ctx, ...args)
      try {
        res.headers.set('x-request-id', requestId)
      } catch {
        // Immutable headers (rare) — the requestId is still in the log line.
      }
      logLine(res.status)
      return res
    } catch (err) {
      // Known afrError code prefixes from Convex map to stable statuses even
      // if a route forgot to handle them explicitly.
      const mapped = mapAfrErrorResponse(err, requestId)
      if (mapped) {
        logLine(mapped.status, { err })
        return mapped
      }
      if (err instanceof ConvexTimeoutError) {
        logLine(503, { err })
        return NextResponse.json<ApiError>(
          { code: 'SERVICE_UNAVAILABLE', message: `Backend unavailable (request ${requestId})` },
          { status: 503, headers: { 'x-request-id': requestId } },
        )
      }
      // Unexpected error: full detail goes to the log, NEVER to the client.
      logLine(500, { err })
      return NextResponse.json<ApiError>(
        { code: 'INTERNAL_ERROR', message: 'Internal error', details: { requestId } },
        { status: 500, headers: { 'x-request-id': requestId } },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Rate-limit key resolution
// ---------------------------------------------------------------------------

function apiKeyBucketKey(req: NextRequest): string | null {
  const apiKey = req.headers.get('x-api-key')
  if (!apiKey) return null
  // Hash prefix — never key buckets (or logs) on the raw secret.
  return `key:${hashApiKey(apiKey).slice(0, 16)}`
}

function clerkOrgBucketKey(ctx: ApiHandlerContext): string | null {
  try {
    const { orgId } = auth()
    if (orgId) {
      ctx.setOrgId(orgId)
      return `org:${orgId}`
    }
  } catch {
    // Outside Clerk middleware context (e.g. unauthenticated ingest route).
  }
  return null
}

function resolveRateLimitKey(
  req: NextRequest,
  kind: RateLimitKeyKind,
  ctx: ApiHandlerContext,
): string {
  const ip = `ip:${getClientIp(req)}`
  switch (kind) {
    case 'apiKey':
      return apiKeyBucketKey(req) ?? ip
    case 'org':
      return clerkOrgBucketKey(ctx) ?? ip
    case 'ip':
      return ip
    case 'auto':
      return apiKeyBucketKey(req) ?? clerkOrgBucketKey(ctx) ?? ip
  }
}
