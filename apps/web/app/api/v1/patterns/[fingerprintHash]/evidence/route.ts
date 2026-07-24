import { type NextRequest, NextResponse } from 'next/server'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetFailurePatternEvidence } from '@/lib/services/api_v1'
import { isValidFingerprint } from '@/lib/services/fingerprintValidation'

interface RouteParams {
  params: { fingerprintHash: string }
}

// ---------------------------------------------------------------------------
// GET /api/v1/patterns/[fingerprintHash]/evidence — public read API,
// x-api-key auth (`read` scope).
//
// "Did the fix actually hold?" (ADR-006 cycle 2). A resolution on its own is
// an unearned human assertion; this endpoint returns the evidence that grades
// it: the resolution claim, the post-resolution run exposure measured since,
// the lifecycle transition history (reconstructed from the append-only audit
// log, including the regression guard's own automatic reopens), and Team B's
// `confidence` verdict (`convex/insights.ts` §12 — `score` 0..0.95, `state`
// one of unproven/proving/confirmed/regressed, plus every driver that
// produced them).
//
// Wraps convex/read_api.ts `apiGetFailurePatternEvidence`, which enforces org
// scoping and the `read` scope for the resolved key. Powers
// `afr patterns evidence <fingerprint>` and `FlightReader.getFailurePatternEvidence`.
//
// READ-ONLY, like every other v1 surface. Nothing here sets lifecycle state:
// acknowledging/resolving/reopening a pattern remains a member-gated,
// audited, Clerk-authed action on a separate route. An API key has no human
// actor, and `audit_log.actorClerkUserId` exists precisely to record which
// person made a privileged change — reading proof that a fix held needs no
// actor, asserting that it held does.
//
// 404 (not 200-with-null) when the fingerprint is unknown to the key's org:
// "never existed" and "belongs to another org" are deliberately
// indistinguishable, so this route cannot be used as an existence oracle for
// another org's data.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/patterns/[fingerprintHash]/evidence',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    // Reject obviously-malformed fingerprints with a clean 400 before any
    // Convex call, same guard every other fingerprint-scoped route uses.
    if (!isValidFingerprint(params.fingerprintHash)) {
      return NextResponse.json(
        {
          error: { code: 'INVALID_ARGUMENT', message: 'Invalid fingerprint hash' },
          requestId: ctx.requestId,
        },
        { status: 400 },
      )
    }

    try {
      const result = await apiGetFailurePatternEvidence(hashApiKey(apiKey), {
        fingerprintHash: params.fingerprintHash,
      })
      if (result === null) {
        return NextResponse.json(
          {
            error: { code: 'NOT_FOUND', message: 'Failure pattern not found' },
            requestId: ctx.requestId,
          },
          { status: 404 },
        )
      }
      return NextResponse.json(apiV1Envelope(result, ctx.requestId))
    } catch (err) {
      const mapped = mapApiErrorV1(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Same "ingest-key" rate class as the other v1 read routes.
  { rateLimit: { key: 'apiKey', limitPerMin: 300 } },
)
