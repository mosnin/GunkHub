import { auth } from '@clerk/nextjs/server'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

/**
 * A single audit trail row. Mirrors the `audit_log` table shape in
 * convex/schema.ts. There is no shared contracts entity for this yet — the
 * audit log is admin-only tooling, not one of the core hierarchy entities
 * (Organization/Project/Agent/AgentVersion/Run/Event) that live in
 * @agent-flight-recorder/contracts. If this needs to be consumed outside
 * apps/web, coordinate with the data team on adding it to contracts first.
 */
export interface AuditLogEntry {
  id: string
  orgId: string
  actorClerkUserId: string
  action: string
  targetType: string
  targetId: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface ListAuditLogResult {
  entries: AuditLogEntry[]
  nextCursor?: string
}

/** Thrown when the caller is authenticated and org-scoped but lacks the admin role. */
export class AuditAccessDeniedError extends Error {
  constructor() {
    super('Admin role required to view the audit log')
    this.name = 'AuditAccessDeniedError'
  }
}

function mapAuditEntry(doc: Record<string, unknown>): AuditLogEntry {
  return {
    id: doc._id as string,
    orgId: doc.orgId as string,
    actorClerkUserId: doc.actorClerkUserId as string,
    action: doc.action as string,
    targetType: doc.targetType as string,
    targetId: doc.targetId as string,
    timestamp: doc.timestamp as number,
    ...(doc.metadata !== undefined && { metadata: doc.metadata as Record<string, unknown> }),
  }
}

/**
 * List the audit log for the authenticated organization. Admin-only —
 * convex/audit.ts:listAuditLog throws (message containing "Forbidden") for
 * non-admin members, which is translated here to AuditAccessDeniedError so
 * the page can render a dedicated "admin access required" state instead of a
 * generic error.
 */
export async function listAuditLog(params: {
  limit?: number
  cursor?: string
}): Promise<ListAuditLogResult> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found — run onboarding first')

  const orgDoc = org as Record<string, unknown>

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await client.query(convex.audit.listAuditLog, {
      orgId: orgDoc._id,
      ...(params.limit !== undefined && { limit: params.limit }),
      ...(params.cursor !== undefined && { cursor: params.cursor }),
    })

    const res = result as { entries: Record<string, unknown>[]; nextCursor?: string }
    return {
      entries: (res.entries ?? []).map(mapAuditEntry),
      nextCursor: res.nextCursor,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('Forbidden')) {
      throw new AuditAccessDeniedError()
    }
    throw err
  }
}
