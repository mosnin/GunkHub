/**
 * Shared HTTP + envelope-parsing core for the Agent Flight Recorder public
 * v1 read API (`GET /api/v1/**`, documented in `docs/api_reference.md`).
 *
 * This is the ONE source of truth for:
 *   - the fetch call itself (native `fetch`, no HTTP framework dependency)
 *   - tolerant parsing of the `{ apiVersion, data }` / `{ apiVersion, error }`
 *     response envelope
 *   - mapping HTTP status codes to a small, stable `V1ApiErrorKind` taxonomy
 *
 * Two consumers share this module:
 *   - `FlightReader` (`./reader.ts`), the SDK's own read client.
 *   - `@agent-flight-recorder/cli`'s `apiClient.ts`, which wraps
 *     {@link V1ApiError} in its own `ApiClientError` (adding a CLI process
 *     exit code) but delegates all fetch/envelope/status-mapping logic here
 *     rather than re-implementing it. See `packages/cli/src/apiClient.ts`
 *     for that wrapper.
 *
 * Kept dependency-free beyond `fetch` — no Convex, no Next.js, importable
 * from any Node.js environment (CLAUDE.md SDK boundary rules).
 */

// ---------------------------------------------------------------------------
// Config and injectable fetch
// ---------------------------------------------------------------------------

/** Base URL + API key needed to call the v1 read API. */
export interface V1ApiConfig {
  baseUrl: string
  apiKey: string
}

/** Minimal fetch shape so tests/consumers can inject a mock without touching the network. */
export type V1FetchLike = (url: string, init?: RequestInit) => Promise<{
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
 * Broad category a v1 API failure maps to. Deliberately small and stable —
 * consumers (CLI exit codes, SDK callers) branch on this rather than on raw
 * HTTP status or `error.code`.
 */
export type V1ApiErrorKind = 'auth' | 'not_found' | 'rate_limited' | 'server' | 'network' | 'invalid_response'

/**
 * Thrown by every function in this module (and by {@link FlightReader}) on
 * any non-2xx response, network failure, or malformed envelope. Never a raw
 * fetch error escapes.
 */
export class V1ApiError extends Error {
  readonly kind: V1ApiErrorKind
  readonly status?: number
  readonly retryAfterSeconds?: number
  /** The v1 envelope's `error.code`, when the response body provided one (e.g. `RUN_NOT_ACTIVE`, `FORBIDDEN`). */
  readonly code?: string

  constructor(
    kind: V1ApiErrorKind,
    message: string,
    opts: { status?: number; retryAfterSeconds?: number; code?: string } = {}
  ) {
    super(message)
    this.name = 'V1ApiError'
    this.kind = kind
    if (opts.status !== undefined) this.status = opts.status
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds
    if (opts.code !== undefined) this.code = opts.code
  }
}

/** The `{ apiVersion, data }` / `{ apiVersion, error }` v1 response envelope, parsed tolerantly. */
export interface V1Envelope<T> {
  apiVersion?: string
  data?: T
  error?: { code?: string; message?: string; details?: unknown }
}

/** Tolerantly parse a Response body as JSON. Never throws — returns undefined on failure. */
export async function tryParseV1Json(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** Pull `error.message` out of a parsed v1 error body, falling back when absent/malformed. */
export function messageFromV1Body(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error
    if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
      return (err as { message: string }).message
    }
  }
  return fallback
}

/** Pull `error.code` out of a parsed v1 error body, when present. */
function codeFromV1Body(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error
    if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
      return (err as { code: string }).code
    }
  }
  return undefined
}

/**
 * Perform a GET request against the v1 read API and return the parsed `data`
 * envelope field. This is the single shared implementation used by both
 * {@link FlightReader} and the CLI's `apiClient.ts`.
 *
 * @throws {@link V1ApiError} on any auth/not-found/rate-limit/server/network/parse failure.
 */
export async function fetchV1<T>(
  config: V1ApiConfig,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  fetchImpl: V1FetchLike = fetch as unknown as V1FetchLike
): Promise<T> {
  const url = new URL(`${config.baseUrl.replace(/\/$/, '')}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  let res: Awaited<ReturnType<V1FetchLike>>
  try {
    res = await fetchImpl(url.toString(), { headers: { 'x-api-key': config.apiKey } })
  } catch (err) {
    throw new V1ApiError('network', `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (res.status === 401 || res.status === 403) {
    const body = await tryParseV1Json(res)
    const code = codeFromV1Body(body)
    throw new V1ApiError(
      'auth',
      messageFromV1Body(
        body,
        res.status === 401
          ? 'Authentication failed — check your API key.'
          : "API key lacks the 'read' scope required for this command."
      ),
      { status: res.status, ...(code !== undefined && { code }) }
    )
  }

  if (res.status === 404) {
    const body = await tryParseV1Json(res)
    const code = codeFromV1Body(body)
    throw new V1ApiError('not_found', messageFromV1Body(body, 'Not found.'), { status: 404, ...(code !== undefined && { code }) })
  }

  if (res.status === 429) {
    const retryAfterHeader = res.headers.get('retry-after')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
    const body = await tryParseV1Json(res)
    const code = codeFromV1Body(body)
    const hint =
      retryAfterSeconds !== undefined && !Number.isNaN(retryAfterSeconds)
        ? ` Retry after ${retryAfterSeconds}s.`
        : ''
    throw new V1ApiError('rate_limited', `${messageFromV1Body(body, 'Rate limited.')}${hint}`, {
      status: 429,
      ...(code !== undefined && { code }),
      ...(retryAfterSeconds !== undefined && !Number.isNaN(retryAfterSeconds) && { retryAfterSeconds }),
    })
  }

  if (res.status >= 500) {
    const body = await tryParseV1Json(res)
    const code = codeFromV1Body(body)
    throw new V1ApiError('server', messageFromV1Body(body, `Server error: HTTP ${res.status}`), {
      status: res.status,
      ...(code !== undefined && { code }),
    })
  }

  if (!res.ok) {
    const body = await tryParseV1Json(res)
    const code = codeFromV1Body(body)
    throw new V1ApiError('invalid_response', messageFromV1Body(body, `Unexpected HTTP ${res.status}`), {
      status: res.status,
      ...(code !== undefined && { code }),
    })
  }

  const body = await tryParseV1Json(res)
  const envelope = body as V1Envelope<T> | undefined
  if (!envelope || typeof envelope !== 'object' || envelope.data === undefined) {
    throw new V1ApiError('invalid_response', `Malformed response body from ${path} (expected { apiVersion, data }).`)
  }
  return envelope.data
}
