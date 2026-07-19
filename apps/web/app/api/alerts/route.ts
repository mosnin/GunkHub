import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { AlertChannel, AlertRuleKind, ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { createAlertRule, listAlertRules } from '@/lib/services/alerts'

const ALERT_RULE_KINDS = new Set<string>(['run_failed', 'failure_rate', 'eval_failed'])
const CHANNEL_TYPES = new Set<string>(['webhook', 'email'])

function validateChannelsBody(raw: unknown): AlertChannel[] | NextResponse {
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
// GET /api/alerts — list alert rules for the authenticated org (Clerk auth,
// admin-only — convex/alerts.ts listAlertRules enforces the role check).
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/alerts',
  async (_req: NextRequest, ctx) => {
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
      const rules = await listAlertRules()
      return NextResponse.json({ rules })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Clerk-read rate class: higher than the sibling 60/min write limit,
  // explicit rather than falling back to the global 300/min default, for
  // consistency with this route family's other explicit limits.
  { rateLimit: { key: 'org', limitPerMin: 180 } }
)

// ---------------------------------------------------------------------------
// POST /api/alerts — create an alert rule (Clerk auth, admin-only).
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/alerts',
  async (req: NextRequest, ctx) => {
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

    const name = body['name']
    if (typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'name is required' },
        { status: 422 }
      )
    }
    const kind = body['kind']
    if (typeof kind !== 'string' || !ALERT_RULE_KINDS.has(kind)) {
      return NextResponse.json<ApiError>(
        {
          code: 'VALIDATION_ERROR',
          message: 'kind must be one of run_failed, failure_rate, eval_failed',
        },
        { status: 422 }
      )
    }
    const channels = validateChannelsBody(body['channels'])
    if (channels instanceof NextResponse) return channels

    try {
      const rule = await createAlertRule({
        name: name.trim(),
        kind: kind as AlertRuleKind,
        channels,
        ...(typeof body['projectId'] === 'string' && { projectId: body['projectId'] }),
        ...(typeof body['thresholdPct'] === 'number' && { thresholdPct: body['thresholdPct'] }),
        ...(typeof body['windowMinutes'] === 'number' && { windowMinutes: body['windowMinutes'] }),
        ...(typeof body['enabled'] === 'boolean' && { enabled: body['enabled'] }),
      })
      return NextResponse.json({ rule }, { status: 201 })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Clerk-write rate class: tighter than reads, keyed by org.
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)
