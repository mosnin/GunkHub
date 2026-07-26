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
import { mapAlertEvent, mapAlertRule } from '@/lib/services/alertRules'

export { ALERT_RULE_KINDS, isValidAlertRuleKind, isValidChannelType } from '@/lib/services/alertRules'

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
