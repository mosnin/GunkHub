import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { AlertChannel, ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { deleteAlertRule, updateAlertRule } from '@/lib/services/alerts'

const CHANNEL_TYPES = new Set<string>(['webhook', 'email'])

interface RouteParams {
  params: { id: string }
}

function validateChannelsBody(raw: unknown): AlertChannel[] | undefined | NextResponse {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0) {
    return NextResponse.json<ApiError>(
      { code: 'VALIDATION_ERROR', message: 'channels must be a non-empty array' },
      { status: 422 }
    )
  }
  const channels: AlertChannel[] = []
  for (const c of raw as Record<string, unknown>[]) {
    const type = c['type']
    const target = c['target']
    if (
      typeof type !== 'string' ||
      !CHANNEL_TYPES.has(type) ||
      typeof target !== 'string' ||
      !target
    ) {
      return NextResponse.json<ApiError>(
        {
          code: 'VALIDATION_ERROR',
          message: 'each channel needs a type ("webhook"|"email") and a target',
        },
        { status: 422 }
      )
    }
    channels.push({ type: type as AlertChannel['type'], target })
  }
  return channels
}

// ---------------------------------------------------------------------------
// PUT /api/alerts/[id] — update an alert rule (Clerk auth, admin-only —
// convex/alerts.ts updateAlertRule enforces the role check against the
// rule's own org, so this route does not need to resolve orgId itself).
// ---------------------------------------------------------------------------
export const PUT = withApiHandler(
  '/api/alerts/[id]',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      )
    }
    const { orgId } = authResult
    ctx.setOrgId(orgId)

    let body: Record<string, unknown>
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      body = await req.json()
    } catch {
      return NextResponse.json<ApiError>(
        { code: 'BAD_REQUEST', message: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const channels = validateChannelsBody(body['channels'])
    if (channels instanceof NextResponse) return channels

    try {
      const rule = await updateAlertRule(params.id, {
        ...(typeof body['name'] === 'string' && { name: body['name'] }),
        ...(typeof body['thresholdPct'] === 'number' && { thresholdPct: body['thresholdPct'] }),
        ...(typeof body['windowMinutes'] === 'number' && { windowMinutes: body['windowMinutes'] }),
        ...(channels !== undefined && { channels }),
        ...(typeof body['enabled'] === 'boolean' && { enabled: body['enabled'] }),
      })
      return NextResponse.json({ rule })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)

// ---------------------------------------------------------------------------
// DELETE /api/alerts/[id] — delete an alert rule (Clerk auth, admin-only).
// ---------------------------------------------------------------------------
export const DELETE = withApiHandler(
  '/api/alerts/[id]',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      )
    }
    const { orgId } = authResult
    ctx.setOrgId(orgId)

    try {
      await deleteAlertRule(params.id)
      return NextResponse.json({ deleted: true })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)
