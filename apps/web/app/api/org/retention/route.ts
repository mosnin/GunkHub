// Org retention policy — Clerk-authenticated.
// GET: current retentionDays + pendingDeletionAt for the caller's org (any member).
// PUT: set/clear retentionDays (admin-gated by convex/organizations.ts:updateRetentionPolicy).

import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { withApiHandler } from '@/lib/apiHandler'
import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId, withConvexTimeout } from '@/lib/convexServer'
import { getOrganizationSettings } from '@/lib/services/organizations'

// Mirrors convex/helpers/pagination.ts MIN_RETENTION_DAYS / MAX_RETENTION_DAYS.
// This is a client-facing UX check only — the Convex mutation is the source of
// truth and re-validates independently of anything this route does.
const MIN_RETENTION_DAYS = 1
const MAX_RETENTION_DAYS = 3_650

interface RetentionResponseBody {
  retentionDays: number | null
  pendingDeletionAt: number | null
}

// ---------------------------------------------------------------------------
// GET /api/org/retention — current policy, readable by any org member
// ---------------------------------------------------------------------------

export const GET = withApiHandler('/api/org/retention', async (_req: NextRequest, ctx) => {
  const { userId, orgId: clerkOrgId } = auth()
  if (!userId || !clerkOrgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    )
  }
  ctx.setOrgId(clerkOrgId)

  try {
    const settings = await getOrganizationSettings()
    return NextResponse.json<RetentionResponseBody>(settings)
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (message.includes('Unauthorized')) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    throw err
  }
})

// ---------------------------------------------------------------------------
// PUT /api/org/retention — set (1-3650) or clear (null) the retention window.
// Admin-only: the Convex mutation enforces this; this route just maps the
// resulting Forbidden error to a clean 403 rather than a generic 500.
// ---------------------------------------------------------------------------

export const PUT = withApiHandler('/api/org/retention', async (req: NextRequest, ctx) => {
  const { userId, orgId: clerkOrgId } = auth()
  if (!userId || !clerkOrgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    )
  }
  ctx.setOrgId(clerkOrgId)

  let body: Record<string, unknown>
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    body = await req.json()
  } catch {
    return NextResponse.json<ApiError>(
      { code: 'BAD_REQUEST', message: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  const raw = body['retentionDays']
  let retentionDays: number | undefined
  if (raw === null || raw === undefined) {
    retentionDays = undefined
  } else if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < MIN_RETENTION_DAYS ||
    raw > MAX_RETENTION_DAYS
  ) {
    return NextResponse.json<ApiError>(
      {
        code: 'VALIDATION_ERROR',
        message: `retentionDays must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}, or null to retain forever`,
      },
      { status: 422 },
    )
  } else {
    retentionDays = raw
  }

  try {
    const convexOrgId = await resolveConvexOrgId(clerkOrgId)
    const client = await getAuthedClient()
    const updated = (await withConvexTimeout(
      client.mutation(convex.organizations.updateRetentionPolicy, {
        orgId: convexOrgId,
        ...(retentionDays !== undefined && { retentionDays }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    )) as { retentionDays?: number; pendingDeletionAt?: number } | null

    return NextResponse.json<RetentionResponseBody>({
      retentionDays: updated?.retentionDays ?? null,
      pendingDeletionAt: updated?.pendingDeletionAt ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (message.includes('Forbidden')) {
      return NextResponse.json<ApiError>(
        { code: 'FORBIDDEN', message: 'Only org admins can change the retention policy' },
        { status: 403 },
      )
    }
    if (message.includes('Unauthorized')) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    if (message.includes('INVALID_ARGUMENT')) {
      return NextResponse.json<ApiError>(
        {
          code: 'VALIDATION_ERROR',
          message: `retentionDays must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
        },
        { status: 422 },
      )
    }
    if (message.includes('NOT_FOUND')) {
      return NextResponse.json<ApiError>(
        { code: 'NOT_FOUND', message: 'Organization not found' },
        { status: 404 },
      )
    }
    throw err
  }
})
