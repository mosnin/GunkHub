// Clerk webhook handler — receives organization lifecycle events from Clerk.
// Authentication is via Svix signature verification (not Clerk JWT).
// This route must remain unauthenticated at the HTTP level.

import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { Webhook } from 'svix'

import { convex } from '@/lib/convexFunctions'
import { getPublicClient } from '@/lib/convexServer'
import { env } from '@/lib/env'

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
}

interface ClerkWebhookEvent {
  type: string
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/clerk
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const webhookSecret = env.CLERK_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('CLERK_WEBHOOK_SECRET is not set')
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: 500 },
    )
  }

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
    console.error('Svix signature verification failed:', err)
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 400 },
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
      case 'organizationMembership.created': {
        const data = event.data as unknown as ClerkOrganizationMembershipData
        await handleOrganizationMembershipCreated(data)
        break
      }
      default:
        // Unrecognised event type — acknowledge receipt without acting
        break
    }
  } catch (err) {
    console.error(`Failed to handle Clerk webhook event "${event.type}":`, err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }

  return NextResponse.json({ received: true }, { status: 200 })
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleOrganizationUpsert(data: ClerkOrganizationData) {
  const client = getPublicClient()
  await client.mutation(convex.organizations.upsertOrganization, {
    clerkOrgId: data.id,
    name: data.name,
    slug: data.slug,
  })
}

async function handleOrganizationMembershipCreated(
  data: ClerkOrganizationMembershipData,
) {
  // Ensure the org record exists before the membership is processed.
  // In normal Clerk flow, organization.created fires first, but we handle
  // the membership event defensively in case of delivery reordering.
  const org = data.organization
  const client = getPublicClient()
  await client.mutation(convex.organizations.upsertOrganization, {
    clerkOrgId: org.id,
    name: org.name,
    slug: org.slug,
  })
  // Member-level user record creation (e.g. user_memberships) is deferred
  // to when the user first authenticates via the Clerk JWT path, which
  // already resolves org membership from the auth context.
}
