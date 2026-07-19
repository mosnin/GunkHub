/**
 * Error-code -> HTTP status mapping tests for
 * apps/web/src/lib/apiErrorMapping.ts — the superset mapper used by the v1
 * read API and the alerts/webhooks-config management API. Covers:
 *   - the stable, contracts-recognized codes (delegated to mapAfrErrorResponse)
 *   - the extended local codes, including the new SCOPE_DENIED (403) this
 *     cycle introduces for a write-only API key calling a read-scoped route
 *   - the string-matching fallback for pre-afrError-convention throws
 *     (e.g. requireOrgMembership's "Forbidden: ..." / "Unauthorized: ...")
 *   - the "unrecognized error -> null" contract callers rely on to decide
 *     whether to rethrow
 *
 * No live Convex or Next.js request/response plumbing required — `err` is a
 * plain Error, matching exactly what a caught convex client.query/mutation
 * rejection looks like.
 */
import { describe, expect, it } from 'vitest'

import { mapApiError, mapApiErrorV1, v1UnauthorizedNoKey } from '../../apps/web/src/lib/apiErrorMapping.js'
import { API_V1_VERSION } from '../../apps/web/src/lib/apiV1Envelope.js'

async function statusAndCode(res: ReturnType<typeof mapApiError>) {
  expect(res).not.toBeNull()
  const body = (await res!.json()) as { code: string; message: string; details?: { requestId?: string } }
  return { status: res!.status, code: body.code, message: body.message, requestId: body.details?.requestId }
}

describe('mapApiError — HTTP status table', () => {
  const REQUEST_ID = 'req-abc-123'

  it('RUN_NOT_ACTIVE -> 409 (stable AFR code, via mapAfrErrorResponse)', async () => {
    const res = mapApiError(new Error('RUN_NOT_ACTIVE: run is not running'), REQUEST_ID)
    const { status, code } = await statusAndCode(res)
    expect(status).toBe(409)
    expect(code).toBe('RUN_NOT_ACTIVE')
  })

  it('SEQUENCE_CONFLICT -> 409', async () => {
    const res = mapApiError(new Error('SEQUENCE_CONFLICT: bad sequence'), REQUEST_ID)
    const { status } = await statusAndCode(res)
    expect(status).toBe(409)
  })

  it('EVENT_LIMIT_EXCEEDED -> 422', async () => {
    const res = mapApiError(new Error('EVENT_LIMIT_EXCEEDED: too many events'), REQUEST_ID)
    const { status } = await statusAndCode(res)
    expect(status).toBe(422)
  })

  it('ARTIFACT_LIMIT_EXCEEDED -> 422', async () => {
    const res = mapApiError(new Error('ARTIFACT_LIMIT_EXCEEDED: too many artifacts'), REQUEST_ID)
    const { status } = await statusAndCode(res)
    expect(status).toBe(422)
  })

  it('COMMENT_LIMIT_EXCEEDED -> 422', async () => {
    const res = mapApiError(new Error('COMMENT_LIMIT_EXCEEDED: too many comments'), REQUEST_ID)
    const { status } = await statusAndCode(res)
    expect(status).toBe(422)
  })

  it('RATE_LIMITED -> 429 with retry-after header', () => {
    const res = mapApiError(new Error('RATE_LIMITED: slow down'), REQUEST_ID)
    expect(res!.status).toBe(429)
    expect(res!.headers.get('retry-after')).toBe('60')
  })

  it('SCOPE_DENIED -> 403 (new this cycle: write-only key calling a read route)', async () => {
    const res = mapApiError(
      new Error('SCOPE_DENIED: API key lacks required scope "read"'),
      REQUEST_ID,
    )
    const { status, code, message } = await statusAndCode(res)
    expect(status).toBe(403)
    expect(code).toBe('SCOPE_DENIED')
    expect(message).toContain('lacks required scope')
  })

  it('FORBIDDEN (CODE: prefix form) -> 403', async () => {
    const res = mapApiError(new Error('FORBIDDEN: admin role required'), REQUEST_ID)
    const { status, code } = await statusAndCode(res)
    expect(status).toBe(403)
    expect(code).toBe('FORBIDDEN')
  })

  it('UNAUTHORIZED (CODE: prefix form) -> 401', async () => {
    const res = mapApiError(new Error('UNAUTHORIZED: bad key'), REQUEST_ID)
    const { status } = await statusAndCode(res)
    expect(status).toBe(401)
  })

  it('NOT_FOUND (CODE: prefix form) -> 404', async () => {
    const res = mapApiError(new Error('NOT_FOUND: no such run'), REQUEST_ID)
    const { status } = await statusAndCode(res)
    expect(status).toBe(404)
  })

  it('INVALID_ARGUMENT -> 422', async () => {
    const res = mapApiError(new Error('INVALID_ARGUMENT: bad channel'), REQUEST_ID)
    const { status } = await statusAndCode(res)
    expect(status).toBe(422)
  })

  it('PURGE_FAILED -> 500', async () => {
    const res = mapApiError(new Error('PURGE_FAILED: could not purge'), REQUEST_ID)
    const { status } = await statusAndCode(res)
    expect(status).toBe(500)
  })

  it('prose "Forbidden: ..." (no CODE: prefix, requireOrgMembership convention) -> 403', async () => {
    const res = mapApiError(
      new Error('Forbidden: this action requires the "admin" role or higher'),
      REQUEST_ID,
    )
    const { status, code } = await statusAndCode(res)
    expect(status).toBe(403)
    expect(code).toBe('FORBIDDEN')
  })

  it('prose "Unauthorized: ..." (no CODE: prefix) -> 401', async () => {
    const res = mapApiError(new Error('Unauthorized: not a member of this organization'), REQUEST_ID)
    const { status, code } = await statusAndCode(res)
    expect(status).toBe(401)
    expect(code).toBe('UNAUTHORIZED')
  })

  it('prose "... not found" anywhere in the message -> 404', async () => {
    const res = mapApiError(new Error('Alert rule not found'), REQUEST_ID)
    const { status, code } = await statusAndCode(res)
    expect(status).toBe(404)
    expect(code).toBe('NOT_FOUND')
  })

  it('unrecognized error -> null (caller must rethrow, never leak raw text)', () => {
    expect(mapApiError(new Error('kaboom, something truly unexpected'), REQUEST_ID)).toBeNull()
  })

  it('non-Error thrown value -> null', () => {
    expect(mapApiError({ weird: true }, REQUEST_ID)).toBeNull()
  })

  it('string thrown value without a recognizable code -> null', () => {
    expect(mapApiError('just a string', REQUEST_ID)).toBeNull()
  })

  it('every mapped response echoes the requestId in details and the x-request-id header', async () => {
    const res = mapApiError(new Error('SCOPE_DENIED: nope'), REQUEST_ID)
    const { requestId } = await statusAndCode(res)
    expect(requestId).toBe(REQUEST_ID)
    expect(res!.headers.get('x-request-id')).toBe(REQUEST_ID)
  })

  it('does not misfire on ordinary prose containing a colon (e.g. api_keys expiry message)', () => {
    // "Unauthorized: API key has expired" — the token before the first colon
    // is "Unauthorized" (mixed case), not an ALL_CAPS code, so this must be
    // caught by the prose fallback (401), not misparsed as a bogus code.
    const res = mapApiError(new Error('Unauthorized: API key has expired'), REQUEST_ID)
    expect(res!.status).toBe(401)
  })
})

describe('mapApiErrorV1 — the v1 read API envelope shape', () => {
  const REQUEST_ID = 'req-v1-456'

  // packages/cli/src/apiClient.ts (the CLI's v1 client) parses errors as
  // `{ apiVersion, error: { code, message } }`, NOT the flat ApiError shape
  // the rest of this app uses — this is the cross-team contract these tests
  // pin down.
  async function envelopeBody(res: ReturnType<typeof mapApiErrorV1>) {
    expect(res).not.toBeNull()
    return (await res!.json()) as {
      apiVersion: string
      error: { code: string; message: string; details?: { requestId?: string } }
    }
  }

  it('wraps a stable AFR code (RUN_NOT_ACTIVE) in the { apiVersion, error } envelope', async () => {
    const res = mapApiErrorV1(new Error('RUN_NOT_ACTIVE: run is not running'), REQUEST_ID)
    const body = await envelopeBody(res)
    expect(res!.status).toBe(409)
    expect(body.apiVersion).toBe(API_V1_VERSION)
    expect(body.error.code).toBe('RUN_NOT_ACTIVE')
    expect(body.error.details?.requestId).toBe(REQUEST_ID)
  })

  it('maps the actual read_api.ts scope-denied prose ("Forbidden: API key lacks required scope...") to 403', async () => {
    // This is what convex/read_api.ts's resolveApiKey (shared with
    // sdk_ingest.ts) actually throws for a write-only key calling a
    // read-scoped v1 route — not a dedicated SCOPE_DENIED code.
    const res = mapApiErrorV1(
      new Error('Forbidden: API key lacks required scope "read"'),
      REQUEST_ID,
    )
    const body = await envelopeBody(res)
    expect(res!.status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toContain('required scope')
  })

  it('maps NOT_FOUND prose (e.g. "Run not found in this organization") to 404', async () => {
    const res = mapApiErrorV1(new Error('Run not found in this organization'), REQUEST_ID)
    const body = await envelopeBody(res)
    expect(res!.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('RATE_LIMITED -> 429 with retry-after, still in the v1 envelope shape', async () => {
    const res = mapApiErrorV1(new Error('RATE_LIMITED: slow down'), REQUEST_ID)
    const body = await envelopeBody(res)
    expect(res!.status).toBe(429)
    expect(res!.headers.get('retry-after')).toBe('60')
    expect(body.error.code).toBe('RATE_LIMITED')
  })

  it('unrecognized error -> null (caller must rethrow)', () => {
    expect(mapApiErrorV1(new Error('totally unexpected'), REQUEST_ID)).toBeNull()
  })

  it('v1UnauthorizedNoKey produces the same envelope shape for a missing x-api-key header', async () => {
    const res = v1UnauthorizedNoKey(REQUEST_ID)
    const body = (await res.json()) as {
      apiVersion: string
      error: { code: string; message: string; details?: { requestId?: string } }
    }
    expect(res.status).toBe(401)
    expect(body.apiVersion).toBe(API_V1_VERSION)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toContain('x-api-key')
    expect(body.error.details?.requestId).toBe(REQUEST_ID)
  })
})
