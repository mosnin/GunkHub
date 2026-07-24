import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { getPatternResolutionEvidence } from '@/lib/services/failurePatterns'
import { isValidFingerprint } from '@/lib/services/fingerprintValidation'

interface RouteParams {
  params: { fingerprint: string }
}

// ---------------------------------------------------------------------------
// GET /api/patterns/[fingerprint]/evidence — the "did the fix actually hold?"
// evidence for one fingerprint (docs/adr/006-failure-resolution.md cycle 2).
//
// Returns `{ pattern, resolution | null, exposure | null, transitions[] }`
// (contracts' `PatternResolutionEvidence`). Everything in it is a DERIVED
// projection computed at query time from `runs`, the rollup's `count`, and
// the append-only audit log — never stored, never source of truth, the same
// posture replay/diff have over the event log.
//
// Clerk auth, member-gated (not admin) — same tier as GET
// /api/patterns/[fingerprint], because reading the evidence behind a
// resolution is normal triage, not privileged configuration.
//
// Tenancy: the service returns `null` for a fingerprint absent from THIS org,
// collapsing "never existed" and "belongs to a different org" into one value;
// this route maps both to an identical generic 404. That is load-bearing here
// — an evidence endpoint that 404'd differently for a real-but-foreign
// fingerprint would be an existence oracle for other orgs' failure data
// (CLAUDE.md tenancy rule 3).
//
// Reading the response: `resolution`/`exposure` are null after a MANUAL
// reopen, but NON-NULL after the regression guard's automatic reopen (which
// keeps `resolvedAt` so the "it didn't hold" evidence stays computable). A
// pattern with `status === "open"` AND non-null `exposure` is valid and is
// the whole point of this endpoint — do not treat it as inconsistent.
//
// Two numbers that are easy to misread, and must not be combined:
//   - `exposure.baselineRunCount` is a 14-day TRAILING BASELINE from BEFORE
//     the resolution. `exposure.runCount` is runs SINCE it. They are two
//     different windows: present them as "before" and "since", never subtract
//     one from the other.
//   - `exposure.runCountTruncated: true` means `runCount` is a FLOOR (the
//     backend hit its scan ceiling), so render it as "2000+", never as exact.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/patterns/[fingerprint]/evidence',
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
      const evidence = await getPatternResolutionEvidence(fingerprint)
      if (!evidence) {
        return NextResponse.json<ApiError>(
          { code: 'NOT_FOUND', message: 'Failure pattern not found' },
          { status: 404 }
        )
      }
      return NextResponse.json(evidence)
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 180 } }
)
