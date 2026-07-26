// Clerk webhook handler — receives organization lifecycle events from Clerk.
// Authentication is via Svix signature verification (not Clerk JWT).
// This route must remain unauthenticated at the HTTP level.

import { makeFunctionReference } from 'convex/server'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { Webhook } from 'svix'

import { convex } from '@/lib/convexFunctions'
import { ConvexTimeoutError, getPublicClient, withConvexTimeout } from '@/lib/convexServer'
import { assertServerEnv, env, getAcceptedSecrets } from '@/lib/env'
import { getRequestId, logger } from '@/lib/logger'
import { createRateLimiter, getClientIp } from '@/lib/rateLimit'

const ROUTE = '/api/webhooks/clerk'

// Local references for webhook-only lifecycle mutations not (yet) exported from
// lib/convexFunctions. This route owns the webhook↔convex contract.
const removeMembershipRef = makeFunctionReference<'mutation'>('organizations:removeMembership')
const markOrgPendingDeletionRef = makeFunctionReference<'mutation'>(
  'organizations:markOrganizationPendingDeletion',
)

// Best-effort per-instance rate limit for this unauthenticated route
// (60 req/min/IP). Durable rate limiting stays in Convex — see lib/rateLimit.ts.
const rateLimiter = createRateLimiter(60)

// Convex's assertWebhookSecret (convex/organizations.ts) rejects a mismatched
// secret with `throw new Error("Unauthorized")`. That message is what
// surfaces here on a rejected mutation.
const CONVEX_UNAUTHORIZED_PATTERN = /Unauthorized/i

/**
 * Call a webhook-only Convex lifecycle mutation with dual-accept rotation
 * support. CONVEX_WEBHOOK_SECRET may hold `current,previous` during a
 * rotation window (see docs/operations_runbook.md → "Secret rotation").
 * Convex itself only ever compares against ONE value at a time, so the web
 * tier — not Convex — is what needs to be rotation-aware here: it forwards
 * the FIRST (current) value, and if Convex rejects it as unauthorized,
 * retries once with the second (previous) value in case Convex's env var
 * has not been flipped to the new secret yet.
 */
async function callWebhookMutationWithRotation<T>(
  mutationFn: (webhookSecret: string) => Promise<T>,
  requestId: string,
): Promise<T> {
  const accepted = getAcceptedSecrets('CONVEX_WEBHOOK_SECRET')
  const [current, ...previous] = accepted
  // assertServerEnv('CONVEX_WEBHOOK_SECRET') already ran before any handler
  // that reaches this function, so `current` is only undefined here if that
  // guard's contract is violated — fail loudly rather than forwarding
  // `undefined` to Convex.
  if (current === undefined) {
    throw new Error('CONVEX_WEBHOOK_SECRET resolved to no accepted values')
  }
  try {
    return await withConvexTimeout(mutationFn(current))
  } catch (err) {
    const isUnauthorized = err instanceof Error && CONVEX_UNAUTHORIZED_PATTERN.test(err.message)
    if (isUnauthorized && previous.length > 0) {
      logger.warn(
        'Convex rejected CONVEX_WEBHOOK_SECRET (current) — retrying with previous value; secret rotation appears in progress',
        { requestId, route: ROUTE },
      )
      return await withConvexTimeout(mutationFn(previous[0] as string))
    }
    throw err
  }
}

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
        await handleOrganizationUpsert(data, requestId)
        break
      }
      case 'organizationMembership.created':
      case 'organizationMembership.updated': {
        const data = event.data as unknown as ClerkOrganizationMembershipData
        await handleOrganizationMembershipCreated(data, requestId)
        break
      }
      case 'organizationMembership.deleted': {
        const data = event.data as unknown as ClerkOrganizationMembershipData
        await handleOrganizationMembershipDeleted(data, requestId)
        break
      }
      case 'organization.deleted': {
        // Clerk sends a slimmer payload for deletions — only `id` is guaranteed.
        const data = event.data as unknown as { id: string }
        await handleOrganizationDeleted(data, requestId)
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

async function handleOrganizationUpsert(data: ClerkOrganizationData, requestId: string) {
  const client = getPublicClient()
  await callWebhookMutationWithRotation(
    (webhookSecret) =>
      client.mutation(convex.organizations.upsertOrganization, {
        webhookSecret,
        clerkOrgId: data.id,
        name: data.name,
        slug: data.slug,
      }),
    requestId,
  )
}

async function handleOrganizationMembershipCreated(
  data: ClerkOrganizationMembershipData,
  requestId: string,
) {
  const org = data.organization
  const client = getPublicClient()

  // Ensure the org record exists before creating the membership.
  // In normal Clerk flow, organization.created fires first, but we handle
  // reordered delivery defensively.
  await callWebhookMutationWithRotation(
    (webhookSecret) =>
      client.mutation(convex.organizations.upsertOrganization, {
        webhookSecret,
        clerkOrgId: org.id,
        name: org.name,
        slug: org.slug,
      }),
    requestId,
  )

  // Create or update the user membership record in Convex.
  // Without this row, requireOrgMembership rejects the user on every query/mutation.
  await callWebhookMutationWithRotation(
    (webhookSecret) =>
      client.mutation(convex.organizations.upsertMembership, {
        webhookSecret,
        clerkUserId: data.public_user_data.user_id,
        clerkOrgId: org.id,
        role: clerkRoleToInternal(data.role),
      }),
    requestId,
  )
}

async function handleOrganizationMembershipDeleted(
  data: ClerkOrganizationMembershipData,
  requestId: string,
) {
  // Revoke the membership row so requireOrgMembership stops authorizing a user
  // Clerk has already removed. Idempotent on the Convex side — a missing org or
  // membership is a no-op, so webhook retries and reordered deliveries are safe.
  const client = getPublicClient()
  await callWebhookMutationWithRotation(
    (webhookSecret) =>
      client.mutation(removeMembershipRef, {
        webhookSecret,
        clerkUserId: data.public_user_data.user_id,
        clerkOrgId: data.organization.id,
      }),
    requestId,
  )
}

async function handleOrganizationDeleted(data: { id: string }, requestId: string) {
  // Deliberately NOT an auto-purge: ADR 001 keeps erasure operator-invoked
  // (retention:purgeOrganization from the Convex dashboard/CLI on a verified
  // request). We stamp pendingDeletionAt so the erasure obligation is visible,
  // and log a structured warning so operators see it.
  const client = getPublicClient()
  const result: unknown = await callWebhookMutationWithRotation(
    (webhookSecret) =>
      client.mutation(markOrgPendingDeletionRef, {
        webhookSecret,
        clerkOrgId: data.id,
      }),
    requestId,
  )
  logger.warn('Clerk organization deleted — erasure obligation pending', {
    requestId,
    route: ROUTE,
    clerkOrgId: data.id,
    result,
    action: 'Operator must run retention:purgeOrganization to fulfill erasure (ADR 001)',
  })
}
