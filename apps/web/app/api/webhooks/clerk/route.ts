// Clerk webhook handler — receives organization lifecycle events from Clerk.
// Authentication is via Svix signature verification (not Clerk JWT).
// This route must remain unauthenticated at the HTTP level.

import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { Webhook } from 'svix'

import { convex } from '@/lib/convexFunctions'
import { ConvexTimeoutError, getPublicClient, withConvexTimeout } from '@/lib/convexServer'
import { assertServerEnv, env } from '@/lib/env'
import { getRequestId, logger } from '@/lib/logger'
import { createRateLimiter, getClientIp } from '@/lib/rateLimit'

const ROUTE = '/api/webhooks/clerk'

// Best-effort per-instance rate limit for this unauthenticated route
// (60 req/min/IP). Durable rate limiting stays in Convex — see lib/rateLimit.ts.
const rateLimiter = createRateLimiter(60)

// ---------------------------------------------------------------------------
// Clerk webhook event shapes (minimal — only the fields we consume)
// ---------------------------------------------------------------------------

interface ClerkOrganizationData {
  id: string
  name: string
  slug: string
}

interface ClerkOrganizationMembershipData {
  id: string
  organization: ClerkOrganizationData
  public_user_data: {
    user_id: string
  }
  /** Clerk role: "org:admin" or "org:member". Viewer role is set manually. */
  role: string
}

/**
 * Map a Clerk organization role to our internal role model.
 * Clerk uses "org:admin" and "org:member". We use "admin", "member", "viewer".
 * "viewer" is a local concept — Clerk does not have this role.
 */
function clerkRoleToInternal(clerkRole: string): 'admin' | 'member' | 'viewer' {
  if (clerkRole === 'org:admin') return 'admin'
  return 'member'
}

interface ClerkWebhookEvent {
  type: string
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/clerk
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const requestId = getRequestId(req)

  if (!rateLimiter.check(getClientIp(req))) {
    return NextResponse.json(
      { error: 'Too many requests', requestId },
      { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60' } },
    )
  }

  try {
    assertServerEnv('CLERK_WEBHOOK_SECRET', 'CONVEX_WEBHOOK_SECRET')
  } catch (err) {
    logger.error('Webhook route misconfigured', { requestId, route: ROUTE, err })
    return NextResponse.json(
      { error: 'Webhook secret not configured', requestId },
      { status: 500, headers: { 'x-request-id': requestId } },
    )
  }
  const webhookSecret = env.CLERK_WEBHOOK_SECRET

  // Collect the Svix headers required for signature verification
  const headerPayload = headers()
  const svixId = headerPayload.get('svix-id')
  const svixTimestamp = headerPayload.get('svix-timestamp')
  const svixSignature = headerPayload.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json(
      { error: 'Missing Svix headers' },
      { status: 400 },
    )
  }

  // Read the raw body text for signature verification
  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return NextResponse.json(
      { error: 'Failed to read request body' },
      { status: 400 },
    )
  }

  // Verify the Svix signature
  const wh = new Webhook(webhookSecret)
  let event: ClerkWebhookEvent
  try {
    event = wh.verify(rawBody, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkWebhookEvent
  } catch (err) {
    logger.error('Svix signature verification failed', { requestId, route: ROUTE, err })
    return NextResponse.json(
      { error: 'Invalid signature', requestId },
      { status: 400, headers: { 'x-request-id': requestId } },
    )
  }

  // Route to the appropriate handler
  try {
    switch (event.type) {
      case 'organization.created':
      case 'organization.updated': {
        const data = event.data as unknown as ClerkOrganizationData
        await handleOrganizationUpsert(data)
        break
      }
      case 'organizationMembership.created':
      case 'organizationMembership.updated': {
        const data = event.data as unknown as ClerkOrganizationMembershipData
        await handleOrganizationMembershipCreated(data)
        break
      }
      default:
        // Unrecognised event type — acknowledge receipt without acting
        break
    }
  } catch (err) {
    logger.error(`Failed to handle Clerk webhook event "${event.type}"`, {
      requestId,
      route: ROUTE,
      eventType: event.type,
      err,
    })
    if (err instanceof ConvexTimeoutError) {
      return NextResponse.json(
        { error: 'Backend unavailable', requestId },
        { status: 503, headers: { 'x-request-id': requestId } },
      )
    }
    return NextResponse.json(
      { error: 'Internal server error', requestId },
      { status: 500, headers: { 'x-request-id': requestId } },
    )
  }

  return NextResponse.json(
    { received: true },
    { status: 200, headers: { 'x-request-id': requestId } },
  )
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleOrganizationUpsert(data: ClerkOrganizationData) {
  const client = getPublicClient()
  await withConvexTimeout(
    client.mutation(convex.organizations.upsertOrganization, {
      webhookSecret: env.CONVEX_WEBHOOK_SECRET,
      clerkOrgId: data.id,
      name: data.name,
      slug: data.slug,
    }),
  )
}

async function handleOrganizationMembershipCreated(
  data: ClerkOrganizationMembershipData,
) {
  const org = data.organization
  const client = getPublicClient()

  // Ensure the org record exists before creating the membership.
  // In normal Clerk flow, organization.created fires first, but we handle
  // reordered delivery defensively.
  await withConvexTimeout(
    client.mutation(convex.organizations.upsertOrganization, {
      webhookSecret: env.CONVEX_WEBHOOK_SECRET,
      clerkOrgId: org.id,
      name: org.name,
      slug: org.slug,
    }),
  )

  // Create or update the user membership record in Convex.
  // Without this row, requireOrgMembership rejects the user on every query/mutation.
  await withConvexTimeout(
    client.mutation(convex.organizations.upsertMembership, {
      webhookSecret: env.CONVEX_WEBHOOK_SECRET,
      clerkUserId: data.public_user_data.user_id,
      clerkOrgId: org.id,
      role: clerkRoleToInternal(data.role),
    }),
  )
}
