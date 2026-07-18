import { auth } from '@clerk/nextjs/server'

import type {
  CreateRunRequest,
  CreateRunResponse,
  GetRunResponse,
  ListRunsRequest,
  ListRunsResponse,
  Run,
} from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

function mapRun(doc: Record<string, unknown>): Run {
  return {
    id: doc._id as string,
    orgId: doc.orgId as string,
    projectId: doc.projectId as string,
    agentId: doc.agentId as string,
    status: doc.status as Run['status'],
    startedAt: doc.startedAt as number,
    metadata: (doc.metadata ?? {}) as Record<string, unknown>,
    tags: (doc.tags ?? []) as string[],
    ...(doc.agentVersionId !== undefined && { agentVersionId: doc.agentVersionId as string }),
    ...(doc.endedAt !== undefined && { endedAt: doc.endedAt as number }),
    ...(doc.triggeredBy !== undefined && { triggeredBy: doc.triggeredBy as string }),
    ...(doc.sdkVersion !== undefined && { sdkVersion: doc.sdkVersion as string }),
  }
}

/**
 * List runs for the authenticated organization.
 * Requires an active Clerk session with an org context.
 */
export async function listRuns(params: ListRunsRequest): Promise<ListRunsResponse> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found — run onboarding first')

  const orgDoc = org as Record<string, unknown>

  // The integrity filter is answered by a dedicated, differently-indexed query
  // (convex/runs.ts `listRunsByVerification`) — see that function's doc comment
  // for why it isn't folded into `listRuns`. It wins over the other filters as
  // the base result set; they still narrow within it.
  const queryRef = params.verifyFilter !== undefined ? convex.runs.listRunsByVerification : convex.runs.listRuns

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(queryRef, {
    orgId: orgDoc._id,
    ...(params.verifyFilter !== undefined && { verifyFilter: params.verifyFilter }),
    ...(params.projectId !== undefined && { projectId: params.projectId }),
    ...(params.agentId !== undefined && { agentId: params.agentId }),
    ...(params.status !== undefined && { status: params.status }),
    ...(params.startedAfter !== undefined && { startedAfter: params.startedAfter }),
    ...(params.limit !== undefined && { limit: params.limit }),
    ...(params.cursor !== undefined && { cursor: params.cursor }),
  })

  // Backend renamed `total` → `pageSize` (it was only ever the current page's
  // length, never a grand total). ListRunsResponse keeps the `total` field name
  // for now (contracts are owned by the data team); it is not surfaced as a
  // grand-total count anywhere in the UI, so no display change is needed.
  const res = result as {
    runs: Record<string, unknown>[]
    pageSize: number
    nextCursor?: string
  }
  return {
    runs: (res.runs ?? []).map(mapRun),
    total: res.pageSize ?? 0,
    nextCursor: res.nextCursor,
  }
}

/**
 * Get a single run by its Convex document ID.
 * Includes event count and artifact count.
 */
export async function getRun(id: string): Promise<GetRunResponse> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.query(convex.runs.getRun, { runId: id })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const eventsRes = await client.query(convex.events.listEvents, { runId: id, limit: 100 })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const artifacts = await client.query(convex.artifacts.listArtifacts, { runId: id })

  const eventsResTyped = eventsRes as { events: unknown[] }
  const artifactsTyped = artifacts as unknown[]

  return {
    run: mapRun(doc as Record<string, unknown>),
    eventCount: eventsResTyped.events?.length ?? 0,
    artifactCount: artifactsTyped?.length ?? 0,
  }
}

/**
 * Create a new run. Used by the web UI (Clerk auth).
 * For SDK-initiated runs use the /api/runs ingestion route with x-api-key.
 */
export async function createRun(req: CreateRunRequest): Promise<CreateRunResponse> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated')

  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found')

  const orgDoc = org as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.runs.createRun, {
    orgId: orgDoc._id,
    agentId: req.agentId,
    ...(req.agentVersionId !== undefined && { agentVersionId: req.agentVersionId }),
    ...(req.metadata !== undefined && { metadata: req.metadata }),
    ...(req.tags !== undefined && { tags: req.tags }),
    ...(req.triggeredBy !== undefined && { triggeredBy: req.triggeredBy }),
    ...(req.sdkVersion !== undefined && { sdkVersion: req.sdkVersion }),
  })

  return { run: mapRun(doc as Record<string, unknown>) }
}

/**
 * Update tags on a run.
 */
export async function updateRunTags(runId: string, tags: string[]): Promise<void> {
  const client = await getAuthedClient()
  await client.mutation(convex.runs.updateRunTags, { runId, tags })
}
