/**
 * apiErrorMapping.ts — error-code -> HTTP status mapping for the v1 public
 * read API and the alerts/webhooks-config management API.
 *
 * `mapAfrErrorResponse` in `apiHandler.ts` only recognizes the stable, SDK-
 * facing codes in `@agent-flight-recorder/contracts` (AFR_API_ERROR_CODES).
 * The resolver here is a superset that ALSO recognizes:
 *   - The general-purpose codes already thrown by convex/helpers/errors.ts
 *     (FORBIDDEN, UNAUTHORIZED, NOT_FOUND, INVALID_ARGUMENT, PURGE_FAILED)
 *     that never made it into the "stable API" subset because they were
 *     previously only used internally, not across the API boundary.
 *   - SCOPE_DENIED, in case a future convex error path introduces it as a
 *     dedicated code — today, a write-only key calling a read-scoped v1
 *     route actually throws the same `Forbidden: API key lacks required
 *     scope "read"` prose sdk_ingest.ts's resolveApiKey already uses (see
 *     convex/read_api.ts), which the string-matching fallback below already
 *     maps to 403. Both are covered so this module works whichever path a
 *     given convex function takes.
 *   - A string-matching fallback for the handful of existing convex throws
 *     that predate the `afrError` CODE: prefix convention (e.g.
 *     `requireOrgMembership`'s "Forbidden: ..." / "Unauthorized: ..." and
 *     sdk_ingest.ts's resolveApiKey "Forbidden: API key lacks required
 *     scope ..."), mirroring the pattern already used in
 *     apps/web/app/api/api-keys/[id]/route.ts.
 *
 * Two body shapes are built from the same resolved {code, status, message}:
 *   - `mapApiError` — the flat `ApiError` shape (`{ code, message, details }`)
 *     used by the alerts/webhooks-config management API and the rest of this
 *     app's existing routes.
 *   - `mapApiErrorV1` — the `{ apiVersion, error: { code, message, details } }`
 *     envelope the public v1 read API uses on every non-2xx response (see
 *     apiV1Envelope.ts for the matching success envelope, and
 *     packages/cli/src/apiClient.ts for the consumer this shape is a
 *     cross-team contract with).
 */
import { NextResponse } from 'next/server'

import { mapAfrErrorResponse } from './apiHandler'
import { API_V1_VERSION } from './apiV1Envelope'

import type { ApiError } from '@agent-flight-recorder/contracts'

/** Codes recognized here but not (yet) in contracts' stable AFR_API_ERROR_CODES set. */
const EXTRA_CODE_TO_STATUS: Readonly<Record<string, number>> = {
  SCOPE_DENIED: 403,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 422,
  PURGE_FAILED: 500,
}

interface ResolvedApiError {
  code: string
  status: number
  message: string
}

/**
 * Extract a `CODE:` prefix from an error message. Deliberately stricter than
 * a plain colon-split: only matches all-caps, underscore-only tokens, so it
 * does not misfire on ordinary prose like `"Unauthorized: API key expired"`
 * (whose first token is "Unauthorized", not upper-cased) — those are instead
 * handled by the string-matching fallback below.
 */
function parseLooseCodePrefix(message: string): string | undefined {
  for (const token of message.split(':')) {
    const candidate = token.trim()
    if (candidate.length > 0 && /^[A-Z][A-Z_]*$/.test(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Resolve a caught error to `{ code, status, message }`, checking (in order)
 * contracts' stable AFR codes, the extended local codes, then the prose
 * fallback. Returns null when nothing matches — callers must rethrow so
 * withApiHandler logs the detail and returns a generic 500 (never leak raw
 * error text to clients).
 */
function resolveApiError(err: unknown): ResolvedApiError | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!message) return null

  // 1. Stable, contracts-recognized codes (RUN_NOT_ACTIVE, RATE_LIMITED, ...).
  const stableCode = (() => {
    // Reuse the same CODE-prefix scan mapAfrErrorResponse uses internally,
    // restricted to codes we know the status for via AFR_CODE_TO_STATUS.
    for (const token of message.split(':')) {
      const candidate = token.trim()
      if (STABLE_CODE_TO_STATUS[candidate] !== undefined) return candidate
    }
    return undefined
  })()
  if (stableCode) {
    const idx = message.indexOf(`${stableCode}:`)
    const detail =
      idx === -1 ? stableCode : message.slice(idx + stableCode.length + 1).split('\n')[0]?.trim().slice(0, 500)
    return { code: stableCode, status: STABLE_CODE_TO_STATUS[stableCode] ?? 500, message: detail?.length ? detail : stableCode }
  }

  // 2. Extended local codes (SCOPE_DENIED and the general-purpose afrError codes).
  const code = parseLooseCodePrefix(message)
  if (code && code in EXTRA_CODE_TO_STATUS) {
    const idx = message.indexOf(`${code}:`)
    const detail =
      idx === -1 ? code : message.slice(idx + code.length + 1).split('\n')[0]?.trim().slice(0, 500)
    return { code, status: EXTRA_CODE_TO_STATUS[code] ?? 500, message: detail?.length ? detail : code }
  }

  // 3. Pre-afrError-convention throws that only carry prose, not a CODE: prefix.
  // Bounded to 500 chars, first line only — same discipline as the CODE-prefix
  // paths above. These messages are expected to be short, server-authored
  // strings (e.g. "Run not found", "Webhook not found"), but this is a
  // catch-all string-matching fallback, not a closed set of known throws, so
  // it must not become a way for an unexpectedly-long or multi-line error
  // (stack trace, internal path) to reach the client unbounded.
  const boundedFirstLine = (s: string): string => (s.split('\n')[0] ?? s).slice(0, 500)
  const lower = message.toLowerCase()
  if (lower.startsWith('forbidden')) return { code: 'FORBIDDEN', status: 403, message: boundedFirstLine(message) }
  if (lower.startsWith('unauthorized'))
    return { code: 'UNAUTHORIZED', status: 401, message: boundedFirstLine(message) }
  if (lower.includes('not found')) return { code: 'NOT_FOUND', status: 404, message: boundedFirstLine(message) }

  return null
}

// Mirrors apiHandler.ts's AFR_CODE_TO_STATUS (contracts' stable AFR_API_ERROR_CODES).
// Duplicated here (rather than imported) so resolveApiError has a single
// code -> status table to scan without re-parsing via mapAfrErrorResponse's
// NextResponse-returning API. Keep in sync with apiHandler.ts.
const STABLE_CODE_TO_STATUS: Readonly<Record<string, number>> = {
  RUN_NOT_ACTIVE: 409,
  SEQUENCE_CONFLICT: 409,
  EVENT_LIMIT_EXCEEDED: 422,
  ARTIFACT_LIMIT_EXCEEDED: 422,
  COMMENT_LIMIT_EXCEEDED: 422,
  RATE_LIMITED: 429,
}

function retryAfterHeader(status: number): Record<string, string> {
  return status === 429 ? { 'retry-after': '60' } : {}
}

/**
 * Map a caught error to the flat `ApiError` JSON shape (`{ code, message,
 * details: { requestId } }`) used by the management API and the rest of
 * this app. Returns null for unrecognized errors — rethrow in that case.
 */
export function mapApiError(err: unknown, requestId: string): NextResponse | null {
  // Delegate to mapAfrErrorResponse first so its exact body/behavior (and any
  // future changes to it) stay authoritative for the codes it already knows.
  const stable = mapAfrErrorResponse(err, requestId)
  if (stable) return stable

  const resolved = resolveApiError(err)
  if (!resolved) return null
  return NextResponse.json<ApiError>(
    { code: resolved.code, message: resolved.message, details: { requestId } },
    { status: resolved.status, headers: { 'x-request-id': requestId, ...retryAfterHeader(resolved.status) } },
  )
}

/**
 * Map a caught error to the v1 read API's envelope shape (`{ apiVersion,
 * error: { code, message, details: { requestId } } }`) — see
 * packages/cli/src/apiClient.ts's `messageFromBody`/`V1Envelope` for the
 * consumer this shape is a cross-team contract with. Returns null for
 * unrecognized errors — rethrow in that case.
 */
export function mapApiErrorV1(err: unknown, requestId: string): NextResponse | null {
  const resolved = resolveApiError(err)
  if (!resolved) return null
  return NextResponse.json(
    {
      apiVersion: API_V1_VERSION,
      error: { code: resolved.code, message: resolved.message, details: { requestId } },
    },
    { status: resolved.status, headers: { 'x-request-id': requestId, ...retryAfterHeader(resolved.status) } },
  )
}

/** Build a v1 envelope 401 for "no x-api-key header at all" (pre-Convex-call check). */
export function v1UnauthorizedNoKey(requestId: string): NextResponse {
  return NextResponse.json(
    {
      apiVersion: API_V1_VERSION,
      error: { code: 'UNAUTHORIZED', message: 'API key required (x-api-key header)', details: { requestId } },
    },
    { status: 401, headers: { 'x-request-id': requestId } },
  )
}

/**
 * A v1 `INVALID_ARGUMENT` for a malformed or missing QUERY PARAMETER, in the
 * same envelope shape as `v1UnauthorizedNoKey`.
 *
 * Exists because parameter validation must happen BEFORE the API key is
 * resolved and before any Convex call. That ordering is what keeps a malformed
 * request from being an existence oracle: `?target=` missing must produce an
 * identical response whether the run exists, does not exist, or belongs to
 * another org.
 *
 * `message` must be static route copy naming the parameter and what it expects
 * — never anything derived from a caught exception or echoed back from user
 * input, per the rule in services/serviceResult.ts.
 */
export function v1InvalidArgument(message: string, requestId: string): NextResponse {
  return NextResponse.json(
    {
      apiVersion: API_V1_VERSION,
      error: { code: 'INVALID_ARGUMENT', message, details: { requestId } },
    },
    { status: 400, headers: { 'x-request-id': requestId } },
  )
}
