import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { reopenPattern, resolvePattern } from '@/lib/services/failurePatterns'
import { isValidFingerprint } from '@/lib/services/fingerprintValidation'
import { isValidationError, validateResolveBody } from '@/lib/services/resolutionFieldValidation'

interface RouteParams {
  params: { fingerprint: string }
}

// ---------------------------------------------------------------------------
// POST   /api/patterns/[fingerprint]/resolve — resolve a failure pattern,
//        with an optional bounded { note?, ref? } body.
// DELETE /api/patterns/[fingerprint]/resolve — reopen a resolved (or
//        acknowledged) failure pattern.
//
// Resolution lifecycle (docs/adr/006-failure-resolution.md, cycle 1).
// Structured identically to the sibling mute route
// (apps/web/app/api/patterns/[fingerprint]/mute/route.ts): this route
// supplies org-scoped auth context and maps whatever Convex throws, it does
// not re-implement the member gate or the audit write, both of which live in
// Team A's `resolvePattern`/`reopenPattern` (convex/failure_patterns.ts).
// Unlike mute/unmute (admin-gated org-wide alert config), resolve/reopen —
// like acknowledge — are MEMBER-gated: this is normal triage, the same tier
// as commenting on a run.
//
// Tenancy: resolvePattern/reopenPattern (services/failurePatterns.ts) return
// `null` for a fingerprint that does not exist IN THIS ORG, collapsing
// "never existed" and "belongs to a different org" into one value, exactly
// like every other fingerprint-scoped route in this family — this route maps
// that to a single generic 404, so a resolve/reopen call can never be used
// to probe another org's fingerprint existence.
//
// Body validation: `note`/`ref` are bounded, opaque plain-text fields
// (resolutionFieldValidation.ts — mirrors convex's own 2048-char server-side
// ceiling). Oversized or malformed (non-string) values are rejected with 422
// before any Convex call. `ref` is never parsed as a URL or fetched/followed
// by this layer, even when it looks like one.
//
// CYCLE 2 — optional `versionId`: which agent version the operator believes
// contains the fix. This route validates its SHAPE only and forwards it; the
// real check (exists / in this org / belongs to an agent this pattern was
// observed on) is Team A's `validateResolutionVersion` and is deliberately
// NOT duplicated here — a web-side ownership check would have to read another
// org's data to be accurate.
//
// That rejection must stay VISIBLE and DISTINCT: Convex throws
// `INVALID_ARGUMENT`, mapApiError turns it into a real 422 carrying the
// actionable message, and this route does not catch it into the generic 404
// below. An unknown FINGERPRINT is a 404; an unusable VERSION is a 422 — the
// operator fixes those two differently, so collapsing them would be a
// regression, not a simplification.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/patterns/[fingerprint]/resolve',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      )
    }
    ctx.setOrgId(authResult.orgId)

    const fingerprint = params.fingerprint
    if (typeof fingerprint !== 'string' || !isValidFingerprint(fingerprint)) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'fingerprint must be a hex digest' },
        { status: 422 }
      )
    }

    let rawBody: unknown = undefined
    const bodyText = await req.text()
    if (bodyText.length > 0) {
      try {
        rawBody = JSON.parse(bodyText)
      } catch {
        return NextResponse.json<ApiError>(
          { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' },
          { status: 422 }
        )
      }
    }

    const validated = validateResolveBody(rawBody)
    if (isValidationError(validated)) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: validated.message },
        { status: 422 }
      )
    }

    try {
      const pattern = await resolvePattern(fingerprint, validated)
      if (!pattern) {
        return NextResponse.json<ApiError>(
          { code: 'NOT_FOUND', message: 'Failure pattern not found' },
          { status: 404 }
        )
      }
      return NextResponse.json({ pattern })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)

export const DELETE = withApiHandler(
  '/api/patterns/[fingerprint]/resolve',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      )
    }
    ctx.setOrgId(authResult.orgId)

    const fingerprint = params.fingerprint
    if (typeof fingerprint !== 'string' || !isValidFingerprint(fingerprint)) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'fingerprint must be a hex digest' },
        { status: 422 }
      )
    }

    try {
      const pattern = await reopenPattern(fingerprint)
      if (!pattern) {
        return NextResponse.json<ApiError>(
          { code: 'NOT_FOUND', message: 'Failure pattern not found' },
          { status: 404 }
        )
      }
      return NextResponse.json({ pattern })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)
