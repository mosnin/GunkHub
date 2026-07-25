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

// Structured agent config snapshots — what makes the divergence engine able to
// PROVE anything rather than answering "I cannot tell" on a free-form blob.
// Additive and opt-in: free-form snapshots stay legal and unchanged.
export {
  buildAgentConfigSnapshot,
  enumeratedTools,
  partialTools,
  toolsFromCalls,
  digestSystemPrompt,
} from './agent-config.js'
export type { AgentConfigSnapshotInput } from './agent-config.js'
export {
  FlightReader,
  DEFAULT_EVENT_WINDOW_SIZE,
  PROJECTION_IDENTITY_FIELDS,
  isPatternScanComplete,
} from './reader.js'
export { V1ApiError, fetchV1, tryParseV1Json, messageFromV1Body } from './v1-client.js'

// Generic projection primitives — shared by the MCP server's projections and
// by anything else shaping a v1 response into a budgeted one. See
// `./projection.ts` for why these live here rather than in `packages/mcp`.
export { columnsOf, requestFieldsOf, truncateProse } from './projection.js'
export type { ProjectedColumn } from './projection.js'

// Triage ranking — ONE implementation, imported by both the `afr_triage` MCP
// tool and the `afr triage` CLI command. Two rankings that can disagree is
// exactly the drift this placement exists to prevent.
export {
  SIGNAL_WEIGHT,
  RECENCY_WEIGHT,
  RECENCY_HALF_LIFE_MS,
  VOLUME_WEIGHT,
  VOLUME_SATURATION,
  MAX_TIEBREAK,
  MUTE_DEMOTION,
  SCAN_LIMIT,
  MAX_ITEMS,
  LABEL_BYTE_CAP,
  TRIAGE_UNEVALUATED_SAMPLE_CAP,
  TRIAGE_COLUMNS,
  TRIAGE_FIELDS,
  TRIAGE_RANKING_SOURCES,
  TRIAGE_REQUEST_FIELDS,
  classifySignal,
  scorePattern,
  choosePointer,
  toTriageItem,
  toTriageResult,
} from './triage.js'
export type { TriageSignal, TriageItem, TriagePointer, TriageVerdict, TriageResult } from './triage.js'

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
  GetRunParams,
  ListEventsParams,
  ProjectionParams,
  ProjectableResource,
  EventWindowParams,
  V1EventWindowData,
  V1GetExplanationData,
  V1ListFailurePatternsData,
  ListFailurePatternsParams,
  V1PatternEvidenceData,
  V1ListFixConfidenceEnvelope,
  FixConfidenceEntry,
  RunDivergenceParams,
  AgentDivergenceParams,
  V1RunDivergenceData,
  V1AgentDivergenceData,
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
  // Divergence ("would this run still have been possible on version X?").
  // The proven/speculative separation is STRUCTURAL — `ProvenDivergence` and
  // `SpeculativeDivergence` are mutually unassignable and share no message
  // field, so a consumer cannot render speculation as evidence by accident.
  // Re-exported here, and NOT collapsed into a convenience union, for the
  // reasons written up in `packages/contracts/src/divergence.ts`.
  DivergenceReport,
  FleetDivergenceReport,
  ProvenDivergence,
  SpeculativeDivergence,
  IndeterminateDivergence,
  ProvenDivergenceKind,
  SpeculativeDivergenceKind,
  IndeterminateDivergenceKind,
  ProvenDivergenceReason,
  SpeculativeDivergenceReason,
  IndeterminateDivergenceReason,
  DivergenceProof,
  DivergenceEventCitation,
  DivergenceCoverage,
  DivergenceDimension,
  DivergenceUnassessedDimension,
  DivergenceUnassessedReason,
  DivergenceScanWindow,
  DivergenceVerdict,
  DivergenceVerdictInput,
  ConfigDivergenceReport,
  DimensionOutcome,
  DimensionState,
  // Structured config snapshot (contracts) — the declaration side of the same
  // feature. `configSnapshot` stays `v.any()`; this is what a producer can
  // choose to put in it.
  AgentConfigSnapshot,
  DeclaredTool,
  DeclaredToolset,
  DeclaredModels,
  DeclaredBudgets,
  DeclaredDecodingParams,
  DeclaredPrompt,
  DeclaredCapabilities,
  DeclarationCompleteness,
} from '@agent-flight-recorder/contracts'

// Divergence verdict/coverage RULES (runtime). One implementation of "is this
// complete?" and "what does this add up to?", shared by the CLI gate, the web
// UI, and `FlightReader`'s own response verification — a second copy is how a
// list view and a detail view come to disagree about whether a version ships.
export {
  computeDivergenceVerdict,
  divergenceReportVerdict,
  fleetDivergenceVerdict,
  isDivergenceAnalysisComplete,
  isFleetDivergenceAnalysisComplete,
  isDivergenceCoverageComplete,
  isFleetScanComplete,
  divergenceByDimension,
  mergeFleetDivergenceReports,
  DIVERGENCE_DIMENSIONS,
  MAX_DIVERGENCE_REPRESENTATIVE_RUNS,
  // Snapshot readers — one tolerant parser, shared, so nothing invents a
  // second opinion about what a stored blob declares.
  readAgentConfigSnapshot,
  declaredDimensions,
  supportsProof,
  AGENT_CONFIG_SNAPSHOT_SCHEMA,
} from '@agent-flight-recorder/contracts'
