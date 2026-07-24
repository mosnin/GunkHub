/**
 * services/api_v1.ts — key-authed service layer backing the public
 * `/api/v1/**` read API. Mirrors services/runs.ts / services/events.ts /
 * services/replay.ts but authenticates via `x-api-key` (hashed, forwarded
 * to Convex) instead of a Clerk session, and calls Team A's
 * `convex/read_api.ts` functions (`apiListRuns` / `apiGetRun` /
 * `apiGetRunEvents` / `apiGetReplay`) instead of the Clerk-authed
 * `runs.ts` / `events.ts` queries.
 *
 * IMPORTANT: convex/read_api.ts's functions are Convex `mutation`s, not
 * `query`s — they share sdk_ingest.ts's per-key rate-limit/lastUsedAt
 * bookkeeping, which needs write access to the api_keys document (see that
 * file's header comment). Call them with `client.mutation`, not
 * `client.query`, even though they are read-only from the caller's
 * perspective.
 *
 * Response shapes match the `ApiListRunsResponse` / `ApiGetRunResponse` /
 * `ApiGetRunEventsResponse` / `ApiGetReplayResponse` contract types Team A
 * published in `@agent-flight-recorder/contracts` alongside `read_api.ts` —
 * this layer passes them through directly rather than re-deriving them.
 *
 * Org scoping and the `read` scope check happen INSIDE the Convex function
 * (it resolves `apiKeyHash` to an API key document, same as
 * convex/sdk_ingest.ts's resolveApiKey) — this layer never sees or needs an
 * orgId. A write-only key calling any of these gets
 * `Forbidden: API key lacks required scope "read"`, mapped to 403 by
 * apps/web/src/lib/apiErrorMapping.ts (the prose-fallback path, not a
 * dedicated error code — read_api.ts reuses sdk_ingest.ts's existing
 * Forbidden-prose convention rather than introducing a new one).
 */
import type {
  ApiGetRunEventsResponse,
  ApiGetRunResponse,
  ApiGetReplayResponse,
  ApiListRunsRequest,
  ApiListRunsResponse,
} from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getPublicClient, withConvexTimeout } from '@/lib/convexServer'

// ---------------------------------------------------------------------------
// GET /api/v1/runs -> apiListRuns
// ---------------------------------------------------------------------------

export async function apiListRuns(
  apiKeyHash: string,
  params: ApiListRunsRequest,
): Promise<ApiListRunsResponse> {
  const client = getPublicClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.mutation(convex.read_api.apiListRuns, {
      apiKeyHash,
      ...(params.status !== undefined && { status: params.status }),
      ...(params.agentId !== undefined && { agentId: params.agentId }),
      ...(params.environment !== undefined && { environment: params.environment }),
      ...(params.sessionId !== undefined && { sessionId: params.sessionId }),
      ...(params.limit !== undefined && { limit: params.limit }),
      ...(params.cursor !== undefined && { cursor: params.cursor }),
    }),
  )
  const typed = result as ApiListRunsResponse
  // `total` is a back-compat alias for `pageSize` (the current page's length,
  // not a grand total — same caveat as services/runs.ts's listRuns) — kept
  // for consumers written against the Clerk-authed ListRunsResponse's field
  // name before ApiListRunsResponse's `pageSize` was finalized.
  return { ...typed, total: typed.pageSize } as ApiListRunsResponse & { total: number }
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/[runId] -> apiGetRun
// ---------------------------------------------------------------------------

export async function apiGetRun(apiKeyHash: string, runId: string): Promise<ApiGetRunResponse> {
  const client = getPublicClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.mutation(convex.read_api.apiGetRun, { apiKeyHash, runId }),
  )
  return result as ApiGetRunResponse
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/[runId]/events -> apiGetRunEvents (paginated)
// ---------------------------------------------------------------------------

export interface ApiV1ListEventsParams {
  runId: string
  limit?: number
  cursor?: string
}

export async function apiGetRunEvents(
  apiKeyHash: string,
  params: ApiV1ListEventsParams,
): Promise<ApiGetRunEventsResponse> {
  const client = getPublicClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.mutation(convex.read_api.apiGetRunEvents, {
      apiKeyHash,
      runId: params.runId,
      ...(params.limit !== undefined && { limit: params.limit }),
      ...(params.cursor !== undefined && { cursor: params.cursor }),
    }),
  )
  return result as ApiGetRunEventsResponse
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/[runId]/replay -> apiGetReplay
// ---------------------------------------------------------------------------

/**
 * INTEGRATION NOTE: convex/read_api.ts's apiGetReplay currently returns the
 * bare `ReplayProjection` (via `buildReplayProjectionMirror`), not the
 * `{ projection: ReplayProjection }` shape its own published contract type
 * `ApiGetReplayResponse` declares. This wraps the raw result to conform to
 * the published contract regardless — if convex/read_api.ts is later
 * updated to return the wrapped shape directly, this wrap becomes a no-op
 * only after also unwrapping here (flag for reconciliation once that lands).
 */
export async function apiGetReplay(apiKeyHash: string, runId: string): Promise<ApiGetReplayResponse> {
  const client = getPublicClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.mutation(convex.read_api.apiGetReplay, { apiKeyHash, runId }),
  )
  if (result && typeof result === 'object' && 'projection' in result) {
    return result as ApiGetReplayResponse
  }
  return { projection: result as ApiGetReplayResponse['projection'] }
}

/**
 * v1 read-API: the run's root-cause explanation ("Why did this fail?"), keyed
 * by a `read`-scoped API key. Returns `{ explanation: RunExplanation | null }`
 * — null when the run isn't in an explainable state or has no explanation yet.
 * Mirrors the Clerk-authed `GET /api/runs/[id]/explanation` shape so the SDK
 * `FlightReader.getExplanation` / `afr explain` consume one contract.
 */
export async function apiGetExplanation(
  apiKeyHash: string,
  runId: string,
): Promise<{ explanation: unknown }> {
  const client = getPublicClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.mutation(convex.read_api.apiGetExplanation, { apiKeyHash, runId }),
  )
  if (result && typeof result === 'object' && 'explanation' in result) {
    return result as { explanation: unknown }
  }
  return { explanation: null }
}

// ---------------------------------------------------------------------------
// GET /api/v1/patterns -> apiListFailurePatterns
// ---------------------------------------------------------------------------

/**
 * v1 read-API: recurring failure patterns for the key's org (PREVENTION
 * cycle 1, ADR-005) — a durable memory of fingerprinted, recurring failures
 * derived from failed runs. Powers the SDK's `FlightReader.getFailurePatterns`
 * and `afr patterns`. Returns `{ patterns, nextCursor }`, most-recently-seen
 * first, optionally narrowed by `agentId`.
 */
export interface ApiV1ListFailurePatternsParams {
  agentId?: string
  limit?: number
  cursor?: string
}

export async function apiListFailurePatterns(
  apiKeyHash: string,
  params: ApiV1ListFailurePatternsParams,
): Promise<{ patterns: unknown[]; nextCursor?: string }> {
  const client = getPublicClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.mutation(convex.read_api.apiListFailurePatterns, {
      apiKeyHash,
      ...(params.agentId !== undefined && { agentId: params.agentId }),
      ...(params.limit !== undefined && { limit: params.limit }),
      ...(params.cursor !== undefined && { cursor: params.cursor }),
    }),
  )
  return result as { patterns: unknown[]; nextCursor?: string }
}
