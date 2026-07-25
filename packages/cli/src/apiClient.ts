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
import { FlightReader, postV1, V1ApiError } from '@agent-flight-recorder/sdk'

import type {
  AgentDivergenceParams,
  BudgetMutationResult,
  BudgetSnapshotParams,
  ManualResetRequest,
  ManualTripRequest,
  V1BudgetSnapshotData,
  CausalDirection,
  CausalTraceParams,
  FleetHealthParams,
  ListEventsParams,
  ListFailurePatternsParams,
  ListRunsParams,
  RunDivergenceParams,
  V1AgentDivergenceData,
  V1ApiErrorKind,
  V1CausalTraceData,
  V1FleetHealthData,
  V1FetchLike,
  V1RunDivergenceData,
  V1GetExplanationData,
  V1GetRunData,
  V1ListEventsData,
  V1ListFailurePatternsData,
  V1ListRunsData,
  V1PatternEvidenceData,
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

export type {
  V1ListRunsData,
  V1GetRunData,
  V1ListEventsData,
  V1ReplayData,
  V1GetExplanationData,
  V1ListFailurePatternsData,
  V1PatternEvidenceData,
  ListRunsParams,
  ListEventsParams,
  ListFailurePatternsParams,
  V1RunDivergenceData,
  V1AgentDivergenceData,
  RunDivergenceParams,
  AgentDivergenceParams,
  V1FleetHealthData,
  FleetHealthParams,
}

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

export async function getRunExplanation(
  config: ApiClientConfig,
  runId: string,
  fetchImpl?: ApiFetchLike
): Promise<V1GetExplanationData> {
  try {
    return await new FlightReader(config, fetchImpl).getExplanation(runId)
  } catch (err) {
    toApiClientError(err)
  }
}

export async function listFailurePatterns(
  config: ApiClientConfig,
  params: ListFailurePatternsParams = {},
  fetchImpl?: ApiFetchLike
): Promise<V1ListFailurePatternsData> {
  try {
    return await new FlightReader(config, fetchImpl).getFailurePatterns(params)
  } catch (err) {
    toApiClientError(err)
  }
}

/**
 * "Would this recorded run still have been possible on `targetVersionId`?"
 *
 * Thin `FlightReader` wrapper like every other function here — which matters
 * more than usual on this one: the reader's refusal to return an unverifiable
 * clean report (ignored `targetVersionId`, missing coverage, a speculative
 * finding served as proven, a verdict that contradicts its own findings) is
 * what stands between `afr compat` and a green exit code it did not earn.
 * Those checks arrive here as `ApiClientError` with `kind: 'invalid_response'`
 * and therefore exit code 4 — a wire failure, not a pass.
 */
export async function getRunDivergence(
  config: ApiClientConfig,
  runId: string,
  params: RunDivergenceParams,
  fetchImpl?: ApiFetchLike
): Promise<V1RunDivergenceData> {
  try {
    return await new FlightReader(config, fetchImpl).getRunDivergence(runId, params)
  } catch (err) {
    toApiClientError(err)
  }
}

/** The fleet form of {@link getRunDivergence}: the same question over an agent's recent runs. */
export async function getAgentDivergence(
  config: ApiClientConfig,
  agentId: string,
  params: AgentDivergenceParams,
  fetchImpl?: ApiFetchLike
): Promise<V1AgentDivergenceData> {
  try {
    return await new FlightReader(config, fetchImpl).getAgentDivergence(agentId, params)
  } catch (err) {
    toApiClientError(err)
  }
}

/**
 * "What is wrong across everything?" — the org-wide sweep behind `afr fleet`.
 *
 * Thin `FlightReader` wrapper, and the reader's refusals matter more here than
 * anywhere else in this file: an ignored `burstWindowMs`, a correlation citing
 * evidence outside its own window, or a hypothesis with no base rate all
 * arrive as `ApiClientError` with `kind: 'invalid_response'` and therefore
 * exit code 4 — a wire failure, never a clean sweep and never a fleet event.
 */
export async function getFleetHealth(
  config: ApiClientConfig,
  params: FleetHealthParams,
  fetchImpl?: ApiFetchLike
): Promise<V1FleetHealthData> {
  try {
    return await new FlightReader(config, fetchImpl).getFleetHealth(params)
  } catch (err) {
    toApiClientError(err)
  }
}

/**
 * Walk the recorded causal graph around one run — up, down, or the whole
 * connected component. See `FlightReader.getCausalTrace`.
 *
 * Routes through `FlightReader`, so every refusal in that gate (a suspected
 * link served as an edge, a suspicion carrying a direction, an ORIGIN WITH NO
 * PROOF, an empty terminus list) reaches the CLI as an `ApiClientError` with
 * exit code 4 rather than as a plausible-looking traversal.
 *
 * GENERIC OVER `D` SO THE COMPONENT BARRIER SURVIVES THE WRAPPER. Declaring
 * `params: CausalTraceParams` here would flatten `D` to its default for every
 * caller of this module and re-open, one layer out, the phantom-parameter hole
 * that made the barrier inert inside `FlightReader` itself.
 */
export async function getCausalTrace<D extends CausalDirection>(
  config: ApiClientConfig,
  params: CausalTraceParams<D>,
  fetchImpl?: ApiFetchLike
): Promise<V1CausalTraceData<D>> {
  try {
    return await new FlightReader(config, fetchImpl).getCausalTrace(params)
  } catch (err) {
    toApiClientError(err)
  }
}

/**
 * Read every budget circuit breaker governing a subject, in ONE call.
 *
 * Routes through `FlightReader`, so every refusal in that gate reaches the CLI
 * as an `ApiClientError` rather than as a plausible-looking snapshot. The one
 * to know about: a breaker reported ARMED on an approximate spend figure that
 * straddles its own cap is refused, not rendered — "we could not tell" shown as
 * "there is room" is the failure the whole feature exists against.
 */
export async function getBudgetSnapshot(
  config: ApiClientConfig,
  params: BudgetSnapshotParams,
  fetchImpl?: ApiFetchLike
): Promise<V1BudgetSnapshotData> {
  try {
    return await new FlightReader(config, fetchImpl).getBudgetSnapshot(params)
  } catch (err) {
    toApiClientError(err)
  }
}

/**
 * Trip a breaker by hand. PRIVILEGED — admin-gated and audited server-side into
 * the append-only admin audit log (CLAUDE.md Event Log Rule 6).
 *
 * The `reason` is not optional and is not defaulted anywhere in this path: a
 * manual trip has no meter reading behind it, so the audit entry's only content
 * is the sentence an operator wrote.
 *
 * SERVER SUPPORT: the route is Team A's / the web layer's to build. Until it
 * exists this surfaces `not_found` (exit 3), which is the honest outcome — a
 * privileged mutation that silently no-ops would be far worse.
 */
export async function tripBudget(
  config: ApiClientConfig,
  request: ManualTripRequest,
  fetchImpl?: ApiFetchLike
): Promise<BudgetMutationResult> {
  try {
    return await postV1<BudgetMutationResult>(config, '/api/v1/budgets/trip', request, fetchImpl)
  } catch (err) {
    toApiClientError(err)
  }
}

/** Clear a tripped breaker. PRIVILEGED and audited — see {@link tripBudget}. */
export async function resetBudget(
  config: ApiClientConfig,
  request: ManualResetRequest,
  fetchImpl?: ApiFetchLike
): Promise<BudgetMutationResult> {
  try {
    return await postV1<BudgetMutationResult>(config, '/api/v1/budgets/reset', request, fetchImpl)
  } catch (err) {
    toApiClientError(err)
  }
}

export async function getFailurePatternEvidence(
  config: ApiClientConfig,
  fingerprintHash: string,
  fetchImpl?: ApiFetchLike
): Promise<V1PatternEvidenceData> {
  try {
    return await new FlightReader(config, fetchImpl).getFailurePatternEvidence(fingerprintHash)
  } catch (err) {
    toApiClientError(err)
  }
}
