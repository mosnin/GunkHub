/**
 * services/webhooks_config.ts — Clerk-authed service layer backing
 * /api/webhooks-config/**, wrapping convex/webhooks.ts (data agent,
 * ADR-002/003). Named "_config" (and routed under /api/webhooks-config) to
 * avoid colliding with the existing /api/webhooks/clerk inbound receiver
 * route — this module is about OUTBOUND webhook targets the org configures,
 * not inbound Clerk events.
 */
import { auth } from '@clerk/nextjs/server'

import type { WebhookDelivery, WebhookEventType, WebhookTarget } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId, withConvexTimeout } from '@/lib/convexServer'

function mapWebhookTarget(doc: Record<string, unknown>): WebhookTarget {
  return {
    id: doc['_id'] as string,
    orgId: doc['orgId'] as string,
    url: doc['url'] as string,
    events: (doc['events'] ?? []) as WebhookEventType[],
    enabled: doc['enabled'] as boolean,
    createdAt: doc['createdAt'] as number,
    // Present ONLY in the createWebhook response — every other read strips it.
    ...(doc['secret'] !== undefined && { secret: doc['secret'] as string }),
  }
}

function mapWebhookDelivery(doc: Record<string, unknown>): WebhookDelivery {
  return {
    id: doc['_id'] as string,
    orgId: doc['orgId'] as string,
    webhookId: doc['webhookId'] as string,
    event: doc['event'] as string,
    status: doc['status'] as WebhookDelivery['status'],
    attempts: doc['attempts'] as number,
    createdAt: doc['createdAt'] as number,
    ...(doc['runId'] !== undefined && { runId: doc['runId'] as string }),
    ...(doc['lastAttemptAt'] !== undefined && { lastAttemptAt: doc['lastAttemptAt'] as number }),
    ...(doc['responseCode'] !== undefined && { responseCode: doc['responseCode'] as number }),
    ...(doc['payloadHash'] !== undefined && { payloadHash: doc['payloadHash'] as string }),
    ...(doc['error'] !== undefined && { error: doc['error'] as string }),
  }
}

async function requireConvexOrgId(): Promise<string> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Unauthorized: no organization context')
  return resolveConvexOrgId(clerkOrgId)
}

export async function listWebhooks(): Promise<WebhookTarget[]> {
  const convexOrgId = await requireConvexOrgId()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const hooks = await withConvexTimeout(client.query(convex.webhooks.listWebhooks, { orgId: convexOrgId }))
  return (hooks as Record<string, unknown>[]).map(mapWebhookTarget)
}

/**
 * Create a webhook target. The returned `secret` is the ONLY time the
 * plaintext signing secret is ever surfaced — the route must tell the
 * caller to persist it immediately.
 */
export async function createWebhook(url: string, events: WebhookEventType[]): Promise<WebhookTarget> {
  const convexOrgId = await requireConvexOrgId()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await withConvexTimeout(
    client.mutation(convex.webhooks.createWebhook, { orgId: convexOrgId, url, events }),
  )
  return mapWebhookTarget(doc as Record<string, unknown>)
}

export async function deleteWebhook(webhookId: string): Promise<void> {
  const client = await getAuthedClient()
  await withConvexTimeout(client.mutation(convex.webhooks.deleteWebhook, { webhookId }))
}

export async function listWebhookDeliveries(webhookId: string, limit?: number): Promise<WebhookDelivery[]> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const deliveries = await withConvexTimeout(
    client.query(convex.webhooks.listWebhookDeliveries, {
      webhookId,
      ...(limit !== undefined && { limit }),
    }),
  )
  return (deliveries as Record<string, unknown>[]).map(mapWebhookDelivery)
}
