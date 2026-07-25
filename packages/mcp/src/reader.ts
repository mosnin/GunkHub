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
  EventWindowParams,
  ListFailurePatternsParams,
  ListRunsParams,
  V1EventWindowData,
  V1GetExplanationData,
  V1ListFailurePatternsData,
  V1ListRunsData,
  V1PatternEvidenceData,
} from '@agent-flight-recorder/sdk'

/** The subset of `FlightReader` this server uses. */
export interface AfrReader {
  listRuns(filters?: ListRunsParams): Promise<V1ListRunsData>
  getFailurePatterns(filters?: ListFailurePatternsParams): Promise<V1ListFailurePatternsData>
  getFailurePatternEvidence(fingerprintHash: string): Promise<V1PatternEvidenceData>
  getExplanation(runId: string): Promise<V1GetExplanationData>
  /**
   * Server-side windowed event read, addressed by `sequenceNumber`. Optional so
   * a stub (or a reader pinned to an older SDK) still satisfies this interface;
   * `src/events-window.ts` falls back to paging when it is absent or when the
   * deployment does not honor the sequence floor.
   */
  getRunEventWindow?: (runId: string, options: EventWindowParams) => Promise<V1EventWindowData>
  iterateEvents(runId: string, options?: { pageSize?: number; maxPages?: number }): AsyncIterable<Event>
}

/**
 * Build the real reader from a validated config.
 *
 * @param config - `{ apiKey, baseUrl }` from {@link resolveConfig}.
 */
export function createReader(config: McpConfig): AfrReader {
  return new FlightReader({ baseUrl: config.baseUrl, apiKey: config.apiKey })
}
