/**
 * Typed client for the Agent Flight Recorder public v1 read API, used by
 * `afr runs list|get`, `afr replay`, `afr tail`, and `afr export`.
 *
 * This is a THIN wrapper over `@agent-flight-recorder/sdk`'s `FlightReader` —
 * the CLI does not re-implement the v1 fetch/envelope/status-mapping logic.
 * That logic (the fetch call, envelope parsing, HTTP-status -> error-kind
 * mapping) lives in exactly one place: `packages/sdk/src/v1-client.ts`
 * (`fetchV1` / `V1ApiError`), shared by both `FlightReader` and this module.
 * See `packages/sdk/src/reader.ts` for the read client itself.
 *
 * The only CLI-specific thing added here is `ApiClientError.exitCode` — the
 * `afr` process exit-code convention (0 ok, 1 usage, 2 auth, 3 not-found,
 * 4 network/server/other) — computed from the shared `V1ApiError.kind`.
 */
import { FlightReader, V1ApiError } from '@agent-flight-recorder/sdk'

import type {
  ListEventsParams,
  ListRunsParams,
  V1ApiErrorKind,
  V1FetchLike,
  V1GetRunData,
  V1ListEventsData,
  V1ListRunsData,
  V1ReplayData,
} from '@agent-flight-recorder/sdk'

// ---------------------------------------------------------------------------
// Config and injectable fetch (aliased from the SDK's shared v1-client types)
// ---------------------------------------------------------------------------

export interface ApiClientConfig {
  baseUrl: string
  apiKey: string
}

/** Minimal fetch shape so tests can inject a mock without touching the network. Same shape `FlightReader` uses. */
export type ApiFetchLike = V1FetchLike

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Broad category an API failure maps to. Drives both the CLI's exit code and
 * the message shown to the user. Re-exported from the SDK's shared
 * {@link V1ApiErrorKind} so CLI code has one name to import.
 */
export type ApiErrorKind = V1ApiErrorKind

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

/**
 * Thrown by every apiClient function on any non-2xx response or network
 * failure. Never a raw fetch error. Wraps the SDK's {@link V1ApiError},
 * adding the CLI's process `exitCode`.
 */
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

/** Rethrow a {@link V1ApiError} from the shared SDK client as this package's `ApiClientError` (adds `exitCode`). Any other error propagates unchanged. */
function toApiClientError(err: unknown): never {
  if (err instanceof V1ApiError) {
    throw new ApiClientError(err.kind, err.message, {
      ...(err.status !== undefined && { status: err.status }),
      ...(err.retryAfterSeconds !== undefined && { retryAfterSeconds: err.retryAfterSeconds }),
    })
  }
  throw err
}

// ---------------------------------------------------------------------------
// v1 response data shapes — re-exported from the SDK reader, the source of truth
// ---------------------------------------------------------------------------

export type { V1ListRunsData, V1GetRunData, V1ListEventsData, V1ReplayData, ListRunsParams, ListEventsParams }

// ---------------------------------------------------------------------------
// Public API — thin FlightReader wrappers
// ---------------------------------------------------------------------------

export async function listRuns(
  config: ApiClientConfig,
  params: ListRunsParams = {},
  fetchImpl?: ApiFetchLike
): Promise<V1ListRunsData> {
  try {
    return await new FlightReader(config, fetchImpl).listRuns(params)
  } catch (err) {
    toApiClientError(err)
  }
}

export async function getRun(config: ApiClientConfig, runId: string, fetchImpl?: ApiFetchLike): Promise<V1GetRunData> {
  try {
    return await new FlightReader(config, fetchImpl).getRun(runId)
  } catch (err) {
    toApiClientError(err)
  }
}

export async function getRunEvents(
  config: ApiClientConfig,
  runId: string,
  params: ListEventsParams = {},
  fetchImpl?: ApiFetchLike
): Promise<V1ListEventsData> {
  try {
    return await new FlightReader(config, fetchImpl).getRunEvents(runId, params)
  } catch (err) {
    toApiClientError(err)
  }
}

export async function getRunReplay(config: ApiClientConfig, runId: string, fetchImpl?: ApiFetchLike): Promise<V1ReplayData> {
  try {
    return await new FlightReader(config, fetchImpl).getReplay(runId)
  } catch (err) {
    toApiClientError(err)
  }
}
