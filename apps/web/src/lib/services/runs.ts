import { auth } from '@clerk/nextjs/server'

import { getAgent } from './agents'

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
    // ADR-002 — run hierarchy / sessions / environment / triage / search.
    ...(doc.parentRunId !== undefined && { parentRunId: doc.parentRunId as string }),
    ...(doc.sessionId !== undefined && { sessionId: doc.sessionId as string }),
    ...(doc.environment !== undefined && { environment: doc.environment as string }),
    ...(doc.labels !== undefined && { labels: doc.labels as string[] }),
    // `NonNullable`, not `Run['triageState']`: the contract type is
    // `RunTriageState | undefined`, so casting to it lets the conditional
    // spread produce `{ triageState: undefined }` — which is a DIFFERENT value
    // from an absent key under `exactOptionalPropertyTypes` (the setting the
    // tests package typechecks with). The guard above already proves it is
    // defined here.
    ...(doc.triageState !== undefined && {
      triageState: doc.triageState as NonNullable<Run['triageState']>,
    }),
    ...(doc.tokensIn !== undefined && { tokensIn: doc.tokensIn as number }),
    ...(doc.tokensOut !== undefined && { tokensOut: doc.tokensOut as number }),
  }
}

/**
 * ListRunsRequest + the ADR-002 `environment` filter. `environment` is not
 * yet part of the shared `ListRunsRequest` contract (contracts are owned by
 * the data team) even though convex/runs.ts `listRuns` already accepts it —
 * kept as a local extension here rather than editing packages/contracts
 * unilaterally. Only applied when `verifyFilter` is unset (listRunsByVerification
 * does not accept it); the /runs page combines the two client-side same as
 * it already does for the fine-grained verify split.
 */
export interface ListRunsParams extends ListRunsRequest {
  environment?: string
}

/**
 * List runs for the authenticated organization.
 * Requires an active Clerk session with an org context.
 */
export async function listRuns(params: ListRunsParams): Promise<ListRunsResponse> {
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
    ...(params.verifyFilter === undefined &&
      params.environment !== undefined && { environment: params.environment }),
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
    // Spread rather than assigned: `nextCursor` is OPTIONAL on
    // `ListRunsResponse`, and under `exactOptionalPropertyTypes` an explicit
    // `undefined` is not the same as an absent key. Assigning it also puts
    // `nextCursor: undefined` on the JSON, which a client can misread as "the
    // server answered the cursor question" rather than "there is no next page".
    ...(res.nextCursor !== undefined && { nextCursor: res.nextCursor }),
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
 *
 * PROJECT ID IS DERIVED, NOT SUPPLIED. `convex/runs.ts` `createRun` declares
 * `projectId: v.id("projects")` as REQUIRED, but `CreateRunRequest` in
 * @agent-flight-recorder/contracts does not carry one — and must not start
 * carrying one, because the same request type is the SDK's transport shape
 * and the SDK's ingest path deliberately derives projectId server-side from
 * the agent (convex/sdk_ingest.ts, `projectId: agent.projectId`). Adding a
 * required field to the shared type to fix a web-only defect would break
 * every SDK consumer.
 *
 * So this path mirrors sdk_ingest: resolve the agent, take its projectId.
 * Convex re-validates that both the project and the agent belong to the
 * caller's org and that the agent belongs to the project, so this derivation
 * is a convenience, never the tenancy check.
 *
 * Until this cycle the argument was simply omitted, so every Clerk-authed run
 * creation from the web app failed with ArgumentValidationError. TypeScript
 * could not see it: the args cross the hand-maintained `makeFunctionReference`
 * string-ref seam in convexFunctions.ts. Found by scripts/check-convex-refs.ts.
 */
export async function createRun(req: CreateRunRequest): Promise<CreateRunResponse> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated')

  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found')

  // TENANCY: `getAgent` (services/agents.ts) returns null for BOTH a
  // nonexistent agentId and one belonging to another org — the underlying
  // Convex query throws "Agent not found" in the first case and a membership
  // Forbidden in the second, and collapsing them here is deliberate. A caller
  // probing agent IDs must not be able to tell "does not exist" from "exists,
  // but not yours"; that distinction is an existence oracle across the org
  // boundary (CLAUDE.md, Tenancy Rules #3). One message covers both.
  const agent = await getAgent(req.agentId)
  if (!agent) throw new Error('Agent not found in this organization')

  const orgDoc = org as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.runs.createRun, {
    orgId: orgDoc._id,
    projectId: agent.projectId,
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

// ---------------------------------------------------------------------------
// ADR-002 — hierarchy / sessions / triage / labels / search
// ---------------------------------------------------------------------------

/** Direct children of a run (one level), newest-first as returned by Convex. */
export async function listChildRuns(parentRunId: string): Promise<Run[]> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.runs.listChildRuns, { parentRunId })
  const res = result as { runs: Record<string, unknown>[] }
  return (res.runs ?? []).map(mapRun)
}

/** All runs sharing a sessionId, scoped to the caller's org, newest first. */
export async function listSessionRuns(sessionId: string): Promise<Run[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found — run onboarding first')
  const orgDoc = org as Record<string, unknown>

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.runs.listSessionRuns, {
    orgId: orgDoc._id,
    sessionId,
  })
  const res = result as { runs: Record<string, unknown>[] }
  return (res.runs ?? []).map(mapRun)
}

/**
 * Full-text search over runs (name/tags/error text), org-scoped via the
 * search index's filterFields (see convex/runs.ts `searchRuns`).
 */
export async function searchRuns(searchTerm: string, limit = 25): Promise<Run[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Not authenticated — no org context')

  const trimmed = searchTerm.trim()
  if (trimmed.length === 0) return []

  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error('Organization not found — run onboarding first')
  const orgDoc = org as Record<string, unknown>

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.runs.searchRuns, {
    orgId: orgDoc._id,
    searchTerm: trimmed,
    limit,
  })
  const res = result as { runs: Record<string, unknown>[] }
  return (res.runs ?? []).map(mapRun)
}

/**
 * Set a run's triage state (open/investigating/resolved). Only valid on
 * failed/timed_out runs — the Convex mutation enforces the linear state
 * machine and throws INVALID_ARGUMENT on an illegal transition or wrong
 * status; this function surfaces that message rather than swallowing it.
 */
export async function setRunTriage(
  runId: string,
  triageState: 'open' | 'investigating' | 'resolved',
): Promise<Run> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.runs.setRunTriage, { runId, triageState })
  return mapRun(doc as Record<string, unknown>)
}

/** Replace a run's labels wholesale (distinct from `tags` — ADR-002). */
export async function setRunLabels(runId: string, labels: string[]): Promise<Run> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.runs.setRunLabels, { runId, labels })
  return mapRun(doc as Record<string, unknown>)
}
