/**
 * The read client the tools are written against.
 *
 * `FlightReader` (`@agent-flight-recorder/sdk`) is the real implementation and
 * the ONLY HTTP path in this package — this server does not hand-roll fetch
 * calls, envelope parsing, or status mapping. {@link AfrReader} is the narrow
 * slice of it the tools touch, declared as an interface so tests can substitute
 * a stub without a network.
 */
import { FlightReader } from '@agent-flight-recorder/sdk'

import type { McpConfig } from './env.js'
import type { Event } from '@agent-flight-recorder/contracts'
import type {
  AgentDivergenceParams,
  EventWindowParams,
  ListFailurePatternsParams,
  ListRunsParams,
  RunDivergenceParams,
  V1AgentDivergenceData,
  V1EventWindowData,
  V1GetExplanationData,
  V1ListFailurePatternsData,
  V1ListRunsData,
  V1PatternEvidenceData,
  V1RunDivergenceData,
} from '@agent-flight-recorder/sdk'

/**
 * The subset of `FlightReader` this server uses.
 *
 * SERVER-SIDE FIELD PROJECTION. `ListRunsParams`, `ListFailurePatternsParams`
 * and `EventWindowParams` all extend the SDK's `ProjectionParams`, so `fields`
 * rides along on the existing param objects — this package adds no signature of
 * its own. Each tool sends a selection DERIVED from its projection's column
 * table (`PATTERN_REQUEST_FIELDS` / `RUN_REQUEST_FIELDS` /
 * `EVENT_REQUEST_FIELDS` in `projections.ts`).
 *
 * The identity field is never spent on a slot: the SDK guarantees `id` comes
 * back regardless, and `getRunEventWindow` adds `sequenceNumber` itself so its
 * ignored-floor check stays armed.
 *
 * A deployment that predates `?fields=` drops the unknown query param and
 * returns full documents; the client-side projections then produce exactly the
 * same tool output, one tier more expensively. Nothing here depends on the
 * server honoring the selection.
 */
export interface AfrReader {
  listRuns(filters?: ListRunsParams): Promise<V1ListRunsData>
  getFailurePatterns(filters?: ListFailurePatternsParams): Promise<V1ListFailurePatternsData>
  /**
   * Tier 2 takes NO field selection, deliberately. `apiGetFailurePatternEvidence`
   * composes a resolution/exposure/confidence/transitions envelope rather than
   * returning one projectable document, so there is no `fields` vocabulary for
   * it — and a Convex function rejects an argument it does not declare, so
   * sending one speculatively would break the call rather than be ignored.
   * Tier 2's budget is enforced entirely by `toPatternEvidenceResult`.
   */
  getFailurePatternEvidence(fingerprintHash: string): Promise<V1PatternEvidenceData>
  /** Tier 3 takes no field selection either, for the same reason as tier 2. */
  getExplanation(runId: string): Promise<V1GetExplanationData>
  /**
   * Server-side windowed event read, addressed by `sequenceNumber`. Optional so
   * a stub (or a reader pinned to an older SDK) still satisfies this interface;
   * `src/events-window.ts` falls back to paging when it is absent or when the
   * deployment does not honor the sequence floor.
   */
  getRunEventWindow?: (runId: string, options: EventWindowParams) => Promise<V1EventWindowData>
  iterateEvents(runId: string, options?: { pageSize?: number; maxPages?: number }): AsyncIterable<Event>
  /**
   * Version divergence, per run and across an agent's recent history.
   *
   * NO FIELD SELECTION, for the same reason as tiers 2 and 3: a divergence
   * report is a composed envelope (findings + proofs + coverage), not one
   * projectable document, so there is no `fields` vocabulary for it.
   *
   * Both take `targetVersionId` as a REQUIRED parameter. There is deliberately
   * no "compare against the latest" default anywhere in this stack — a gate
   * whose subject is implicit silently changes meaning the moment somebody
   * publishes a new version, which is the one kind of drift a deploy gate must
   * not have.
   *
   * `FlightReader` verifies both responses before they reach a projection: the
   * echoed `targetVersionId`, the presence of `coverage`, the segregation of
   * proven from speculative findings, and the report's `verdict` against its
   * own contents. Every one of those checks exists because its failure mode
   * looks exactly like a clean report to a caller reading `proven.length === 0`.
   */
  getRunDivergence(runId: string, params: RunDivergenceParams): Promise<V1RunDivergenceData>
  getAgentDivergence(agentId: string, params: AgentDivergenceParams): Promise<V1AgentDivergenceData>
}

/**
 * Build the real reader from a validated config.
 *
 * @param config - `{ apiKey, baseUrl }` from {@link resolveConfig}.
 */
export function createReader(config: McpConfig): AfrReader {
  return new FlightReader({ baseUrl: config.baseUrl, apiKey: config.apiKey })
}
