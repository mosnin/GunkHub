/**
 * Typed client for the Agent Flight Recorder public v1 read API, used by
 * `afr runs list|get`, `afr replay`, `afr tail`, and `afr export`.
 *
 * v1 endpoints (all GET, `x-api-key` auth with `read` scope):
 *   GET /api/v1/runs                 -> ListRunsData
 *   GET /api/v1/runs/:id             -> GetRunData
 *   GET /api/v1/runs/:id/events      -> ListEventsData
 *   GET /api/v1/runs/:id/replay      -> ReplayData
 *
 * Every response is wrapped in an envelope: `{ apiVersion, data }` on
 * success, `{ apiVersion, error: { code, message } }` on failure — this
 * client parses both tolerantly (missing/extra fields never throw; they
 * degrade to `invalid_response`).
 *
 * No HTTP framework or third-party HTTP client is used — only the native
 * `fetch`, consistent with the rest of the SDK/CLI.
 */
import type { Event, FailureSummary, ReplayProjection, Run, RunStatus } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Config and injectable fetch
// ---------------------------------------------------------------------------

export interface ApiClientConfig {
  baseUrl: string
  apiKey: string
}

/** Minimal fetch shape so tests can inject a mock without touching the network. */
export type ApiFetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
  headers: { get(name: string): string | null }
}>

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Broad category an API failure maps to. Drives both the CLI's exit code and
 * the message shown to the user.
 */
export type ApiErrorKind = 'auth' | 'not_found' | 'rate_limited' | 'server' | 'network' | 'invalid_response'

/** Process exit codes per the CLI convention: 0 ok, 1 usage, 2 auth, 3 not-found, 4 network/other. */
export function exitCodeForApiErrorKind(kind: ApiErrorKind): number {
  switch (kind) {
    case 'auth':
      return 2
    case 'not_found':
      return 3
    default:
      // rate_limited / server / network / invalid_response are all
      // "something on the wire went wrong" from the CLI's point of view.
      return 4
  }
}

/** Thrown by every apiClient function on any non-2xx response or network failure. Never a raw fetch error. */
export class ApiClientError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly retryAfterSeconds?: number
  readonly exitCode: number

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number; retryAfterSeconds?: number } = {}) {
    super(message)
    this.name = 'ApiClientError'
    this.kind = kind
    if (opts.status !== undefined) this.status = opts.status
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds
    this.exitCode = exitCodeForApiErrorKind(kind)
  }
}

interface V1Envelope<T> {
  apiVersion?: string
  data?: T
  error?: { code?: string; message?: string; details?: unknown }
}

/** Tolerantly parse a Response body as JSON. Never throws — returns undefined on failure. */
async function tryParseJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error
    if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
      return (err as { message: string }).message
    }
  }
  return fallback
}

/**
 * Perform a GET request against the v1 API and return the parsed `data`
 * envelope field.
 *
 * @throws {@link ApiClientError} on any auth/not-found/rate-limit/server/network/parse failure.
 */
async function getV1<T>(
  config: ApiClientConfig,
  path: string,
  params: Record<string, string | number | undefined> = {},
  fetchImpl: ApiFetchLike = fetch as unknown as ApiFetchLike
): Promise<T> {
  const url = new URL(`${config.baseUrl.replace(/\/$/, '')}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  let res: Awaited<ReturnType<ApiFetchLike>>
  try {
    res = await fetchImpl(url.toString(), { headers: { 'x-api-key': config.apiKey } })
  } catch (err) {
    throw new ApiClientError('network', `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (res.status === 401 || res.status === 403) {
    const body = await tryParseJson(res)
    throw new ApiClientError(
      'auth',
      messageFromBody(
        body,
        res.status === 401
          ? 'Authentication failed — check AFR_API_KEY.'
          : "API key lacks the 'read' scope required for this command."
      ),
      { status: res.status }
    )
  }

  if (res.status === 404) {
    const body = await tryParseJson(res)
    throw new ApiClientError('not_found', messageFromBody(body, 'Not found.'), { status: 404 })
  }

  if (res.status === 429) {
    const retryAfterHeader = res.headers.get('retry-after')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
    const body = await tryParseJson(res)
    const hint =
      retryAfterSeconds !== undefined && !Number.isNaN(retryAfterSeconds)
        ? ` Retry after ${retryAfterSeconds}s.`
        : ''
    throw new ApiClientError('rate_limited', `${messageFromBody(body, 'Rate limited.')}${hint}`, {
      status: 429,
      ...(retryAfterSeconds !== undefined && !Number.isNaN(retryAfterSeconds) && { retryAfterSeconds }),
    })
  }

  if (res.status >= 500) {
    const body = await tryParseJson(res)
    throw new ApiClientError('server', messageFromBody(body, `Server error: HTTP ${res.status}`), {
      status: res.status,
    })
  }

  if (!res.ok) {
    const body = await tryParseJson(res)
    throw new ApiClientError('invalid_response', messageFromBody(body, `Unexpected HTTP ${res.status}`), {
      status: res.status,
    })
  }

  const body = await tryParseJson(res)
  const envelope = body as V1Envelope<T> | undefined
  if (!envelope || typeof envelope !== 'object' || envelope.data === undefined) {
    throw new ApiClientError('invalid_response', `Malformed response body from ${path} (expected { apiVersion, data }).`)
  }
  return envelope.data
}

// ---------------------------------------------------------------------------
// v1 response data shapes (entity types reused from contracts — read-only)
// ---------------------------------------------------------------------------

export interface V1ListRunsData {
  runs: Run[]
  nextCursor?: string
  total?: number
}

export interface V1GetRunData {
  run: Run
  eventCount: number
  artifactCount: number
}

export interface V1ListEventsData {
  events: Event[]
  nextCursor?: string
}

export interface V1ReplayData {
  projection: ReplayProjection
  failureSummary: FailureSummary
}

export interface ListRunsParams {
  status?: RunStatus
  agentId?: string
  environment?: string
  sessionId?: string
  limit?: number
  cursor?: string
}

export interface ListEventsParams {
  limit?: number
  cursor?: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listRuns(
  config: ApiClientConfig,
  params: ListRunsParams = {},
  fetchImpl?: ApiFetchLike
): Promise<V1ListRunsData> {
  return getV1<V1ListRunsData>(
    config,
    '/api/v1/runs',
    {
      status: params.status,
      agentId: params.agentId,
      environment: params.environment,
      sessionId: params.sessionId,
      limit: params.limit,
      cursor: params.cursor,
    },
    fetchImpl
  )
}

export function getRun(config: ApiClientConfig, runId: string, fetchImpl?: ApiFetchLike): Promise<V1GetRunData> {
  return getV1<V1GetRunData>(config, `/api/v1/runs/${encodeURIComponent(runId)}`, {}, fetchImpl)
}

export function getRunEvents(
  config: ApiClientConfig,
  runId: string,
  params: ListEventsParams = {},
  fetchImpl?: ApiFetchLike
): Promise<V1ListEventsData> {
  return getV1<V1ListEventsData>(
    config,
    `/api/v1/runs/${encodeURIComponent(runId)}/events`,
    { limit: params.limit, cursor: params.cursor },
    fetchImpl
  )
}

export function getRunReplay(config: ApiClientConfig, runId: string, fetchImpl?: ApiFetchLike): Promise<V1ReplayData> {
  return getV1<V1ReplayData>(config, `/api/v1/runs/${encodeURIComponent(runId)}/replay`, {}, fetchImpl)
}
