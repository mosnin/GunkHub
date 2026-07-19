/**
 * services/alerts.ts — Clerk-authed service layer backing
 * /api/alerts/**, wrapping convex/alerts.ts (data agent, ADR-002/003).
 * Mirrors services/runs.ts: resolves the Clerk org to a Convex orgId, then
 * calls the org-scoped, admin-gated Convex mutations/queries. Convex itself
 * enforces the admin-role check (requireOrgMembership) — this layer does not
 * duplicate that logic, it only surfaces whatever Convex throws.
 */
import { auth } from '@clerk/nextjs/server'

import type { AlertChannel, AlertEvent, AlertRule, AlertRuleKind } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId, withConvexTimeout } from '@/lib/convexServer'

function mapAlertRule(doc: Record<string, unknown>): AlertRule {
  return {
    id: doc['_id'] as string,
    orgId: doc['orgId'] as string,
    name: doc['name'] as string,
    kind: doc['kind'] as AlertRuleKind,
    channels: (doc['channels'] ?? []) as AlertChannel[],
    enabled: doc['enabled'] as boolean,
    createdAt: doc['createdAt'] as number,
    updatedAt: doc['updatedAt'] as number,
    ...(doc['projectId'] !== undefined && { projectId: doc['projectId'] as string }),
    ...(doc['thresholdPct'] !== undefined && { thresholdPct: doc['thresholdPct'] as number }),
    ...(doc['windowMinutes'] !== undefined && { windowMinutes: doc['windowMinutes'] as number }),
  }
}

function mapAlertEvent(doc: Record<string, unknown>): AlertEvent {
  return {
    id: doc['_id'] as string,
    orgId: doc['orgId'] as string,
    ruleId: doc['ruleId'] as string,
    firedAt: doc['firedAt'] as number,
    summary: doc['summary'] as string,
    deliveryStatus: doc['deliveryStatus'] as AlertEvent['deliveryStatus'],
    ...(doc['runId'] !== undefined && { runId: doc['runId'] as string }),
    ...(doc['deliveredAt'] !== undefined && { deliveredAt: doc['deliveredAt'] as number }),
  }
}

async function requireOrgContext(): Promise<{ clerkOrgId: string; convexOrgId: string }> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Unauthorized: no organization context')
  const convexOrgId = await resolveConvexOrgId(clerkOrgId)
  return { clerkOrgId, convexOrgId }
}

export async function listAlertRules(): Promise<AlertRule[]> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const rules = await withConvexTimeout(client.query(convex.alerts.listAlertRules, { orgId: convexOrgId }))
  return (rules as Record<string, unknown>[]).map(mapAlertRule)
}

export interface CreateAlertRuleInput {
  projectId?: string
  name: string
  kind: AlertRuleKind
  thresholdPct?: number
  windowMinutes?: number
  channels: AlertChannel[]
  enabled?: boolean
}

export async function createAlertRule(input: CreateAlertRuleInput): Promise<AlertRule> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await withConvexTimeout(
    client.mutation(convex.alerts.createAlertRule, {
      orgId: convexOrgId,
      name: input.name,
      kind: input.kind,
      channels: input.channels,
      ...(input.projectId !== undefined && { projectId: input.projectId }),
      ...(input.thresholdPct !== undefined && { thresholdPct: input.thresholdPct }),
      ...(input.windowMinutes !== undefined && { windowMinutes: input.windowMinutes }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    }),
  )
  return mapAlertRule(doc as Record<string, unknown>)
}

export interface UpdateAlertRuleInput {
  name?: string
  thresholdPct?: number
  windowMinutes?: number
  channels?: AlertChannel[]
  enabled?: boolean
}

export async function updateAlertRule(ruleId: string, input: UpdateAlertRuleInput): Promise<AlertRule> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await withConvexTimeout(
    client.mutation(convex.alerts.updateAlertRule, {
      ruleId,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.thresholdPct !== undefined && { thresholdPct: input.thresholdPct }),
      ...(input.windowMinutes !== undefined && { windowMinutes: input.windowMinutes }),
      ...(input.channels !== undefined && { channels: input.channels }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    }),
  )
  return mapAlertRule(doc as Record<string, unknown>)
}

export async function deleteAlertRule(ruleId: string): Promise<void> {
  const client = await getAuthedClient()
  await withConvexTimeout(client.mutation(convex.alerts.deleteAlertRule, { ruleId }))
}

export async function listAlertEvents(limit?: number): Promise<AlertEvent[]> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const events = await withConvexTimeout(
    client.query(convex.alerts.listAlertEvents, {
      orgId: convexOrgId,
      ...(limit !== undefined && { limit }),
    }),
  )
  return (events as Record<string, unknown>[]).map(mapAlertEvent)
}
