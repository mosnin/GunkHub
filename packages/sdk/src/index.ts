/**
 * @agent-flight-recorder/sdk
 *
 * TypeScript SDK for recording agent executions to Agent Flight Recorder.
 *
 * Usage:
 *   import { Recorder, Events } from '@agent-flight-recorder/sdk'
 *   const recorder = new Recorder({ endpoint, apiKey, agentId })
 *   const run = await recorder.startRun(input)
 *   recorder.recordEvent('llm.request', Events.llmRequest(...).payload)
 *   await recorder.endRun(output)
 */

export { Recorder } from './recorder.js'
export { Events, buildEvent } from './events.js'
export {
  HttpTransport,
  defaultBatchingStrategy,
  defaultRetryStrategy,
  createRetryStrategy,
} from './transport.js'
export { FlightRecorder, RunRecorder } from './flight-recorder.js'
// FileSpool loads node:fs via a guarded dynamic import only when its methods
// run, so exporting it here keeps the main entry browser/edge-safe.
export { FileSpool } from './file-spool.js'
export { SDK_VERSION } from './version.js'
export { redactPayload } from './redaction.js'
export { buildErrorSummary, ERROR_SUMMARY_MAX_LENGTH } from './error-summary.js'
export { decideSampling, hashString } from './sampling.js'
export { FlightReader, DEFAULT_EVENT_WINDOW_SIZE } from './reader.js'
export { V1ApiError, fetchV1, tryParseV1Json, messageFromV1Body } from './v1-client.js'

export type {
  RecorderConfig,
  RecorderOptions,
  RunContext,
  RecordEventOptions,
  FlushResult,
  FlushError,
  TransportResponse,
  EventSpool,
  StoredEvent,
  DropReason,
} from './types.js'
export type { FileSpoolOptions } from './file-spool.js'
export type { RedactionConfig, RedactionPattern, RedactedPayload } from './redaction.js'
export type { ErrorSummaryInput } from './error-summary.js'
export type { SamplingConfig, SamplingContext } from './sampling.js'

export type {
  Transport,
  TransportAuth,
  BatchingStrategy,
  RetryStrategy,
  HttpTransportOptions,
  RetryStrategyOptions,
} from './transport.js'
export type { FlightRecorderConfig } from './flight-recorder.js'
export type {
  FlightReaderConfig,
  V1ListRunsData,
  V1GetRunData,
  V1ListEventsData,
  V1ReplayData,
  ListRunsParams,
  ListEventsParams,
  EventWindowParams,
  V1EventWindowData,
  V1GetExplanationData,
  V1ListFailurePatternsData,
  ListFailurePatternsParams,
  V1PatternEvidenceData,
  V1ListFixConfidenceEnvelope,
  FixConfidenceEntry,
} from './reader.js'
export type { V1ApiConfig, V1FetchLike, V1ApiErrorKind, V1Envelope } from './v1-client.js'

// Re-export key contract types so SDK consumers don't need a separate import
export type {
  EventType,
  Run,
  RunStatus,
  Event,
  RunExplanation,
  RunExplanationKind,
  RunExplanationQueryStatus,
  FailurePattern,
  FailurePatternClass,
  FailurePatternStatus,
  // Fix confidence (ADR-006 cycle 2). Canonical declarations live in
  // contracts; re-exported so a consumer reading `V1PatternEvidenceData` gets
  // its member types from the same import.
  FixConfidenceResult,
  FixConfidenceState,
  FixConfidenceLimit,
  FixVersionAttribution,
  PatternResolutionEvidence,
  PatternResolutionMetadata,
  PatternResolutionExposure,
  PatternLifecycleTransition,
} from '@agent-flight-recorder/contracts'
