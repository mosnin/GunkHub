import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, WebhookEventType } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from '@/lib/delivery'
import { createWebhook, listWebhooks } from '@/lib/services/webhooks_config'

const VALID_EVENTS = new Set<string>(['run.completed', 'run.failed', 'eval.failed', 'alert.fired'])

// ---------------------------------------------------------------------------
// GET /api/webhooks-config — list outbound webhook targets for the org
// (Clerk auth, admin-only — convex/webhooks.ts listWebhooks strips the
// signing secret from every entry).
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/webhooks-config',
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
      const webhooks = await listWebhooks()
      return NextResponse.json({ webhooks })
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
// POST /api/webhooks-config — create an outbound webhook target
// (Clerk auth, admin-only). The response is the ONLY place the plaintext
// signing secret is ever returned — the caller must persist it now.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/webhooks-config',
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

    const url = body['url']
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'url is required and must be an https:// URL' },
        { status: 422 }
      )
    }
    // Defense in depth: reject SSRF-unsafe targets (private/reserved IPs,
    // localhost, .internal/.local suffixes) at registration time too, not
    // only at delivery time. deliverWebhook (lib/delivery.ts) already refuses
    // to send to these — validating here means an admin gets an immediate,
    // actionable 422 instead of a webhook target that will silently never
    // deliver once the delivery worker is wired (docs/design/action_layer.md).
    try {
      assertSafeWebhookUrl(url)
    } catch (err) {
      if (err instanceof UnsafeWebhookUrlError) {
        return NextResponse.json<ApiError>(
          { code: 'VALIDATION_ERROR', message: err.message },
          { status: 422 }
        )
      }
      throw err
    }
    const events = body['events']
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.some((e) => typeof e !== 'string' || !VALID_EVENTS.has(e))
    ) {
      return NextResponse.json<ApiError>(
        {
          code: 'VALIDATION_ERROR',
          message:
            'events must be a non-empty array of run.completed|run.failed|eval.failed|alert.fired',
        },
        { status: 422 }
      )
    }

    try {
      const webhook = await createWebhook(url, events as WebhookEventType[])
      return NextResponse.json({ webhook }, { status: 201 })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Clerk-write rate class: tighter than reads, keyed by org.
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)
