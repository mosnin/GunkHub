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
export { V1ApiError, fetchV1, postV1, tryParseV1Json, messageFromV1Body } from './v1-client.js'

// BUDGET CIRCUIT BREAKERS — the first thing in this SDK that does something
// other than record, and the only thing here that can change what an agent
// DOES. `BudgetGuard` is the in-process seam: it holds a server-evaluated
// snapshot, answers `check()` synchronously with no I/O so a per-model-call
// breaker is affordable, and NEVER THROWS — an exception in an enforcement path
// is an enforcement outcome nobody chose, and inside somebody's try/catch it is
// the permissive one.
//
// IT DECLINES; IT DOES NOT STOP. Nothing exported here asserts that an agent
// halted, that spend was prevented, or that a limit was enforced — those are
// facts about a process this library sits inside and does not control. See
// `packages/contracts/src/budgets.ts`, invariant 1.
export { BudgetGuard, snapshotRefusals } from './budget-guard.js'
export type { BudgetGuardConfig, SnapshotAcceptance } from './budget-guard.js'

// DECLARATIVE POLICY — the second thing in this SDK that does something other
// than record. `PolicyPreflight` is the in-process seam: it holds a listing of
// the policies governing a subject, answers `check(act)` synchronously with NO
// I/O AT ALL (a prohibition is decidable in the client; only spend needs the
// server), and NEVER THROWS.
//
// IT ADVISES; IT DOES NOT PREVENT. Nothing exported here asserts that a call was
// blocked, prevented or enforced — those are facts about a process this library
// sits inside and does not control. And it decides A DESCRIPTION OF AN ACT, not
// an act: nothing binds the tool name passed to `check()` to the call
// subsequently made (ADR-009 §7.7).
//
// ABOVE ALL, IT HAS NO CHANNEL TO THE RECORDER. There is no way for an answer
// from this class to cause an event not to be recorded, and every band carries
// `recordRegardless: true` — the literal type — to say so in the value an
// integrator reads. A flight recorder must never refuse to record a violation;
// the breach is the most valuable row in the log. See
// `packages/contracts/src/policy.ts`, invariant 0.
export { PolicyPreflight } from './policy-preflight.js'
export type { PolicyPreflightConfig, PolicySnapshotAcceptance } from './policy-preflight.js'

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
  FleetHealthParams,
  V1FleetHealthData,
  CausalTraceParams,
  V1CausalTraceData,
  BudgetSnapshotParams,
  V1BudgetSnapshotData,
  PolicySubjectParams,
  V1PolicySnapshotData,
  V1PolicyEvaluationData,
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
  ResolutionHealthSummary,
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
  // Fleet health ("what is wrong across everything?"). The observed/hypothesis
  // separation is STRUCTURAL, exactly as proven/speculative is one altitude
  // down: `ObservedCorrelation` and `HypothesisedCause` are mutually
  // unassignable, share no text field, and a hypothesis additionally cannot
  // exist without a base-rate measurement and an observation under it. NOT
  // collapsed into a convenience union, for the reasons written up in
  // `packages/contracts/src/fleet_health.ts`.
  FleetHealthReport,
  FleetHealthScan,
  FleetHealthVerdict,
  FleetHealthVerdictInput,
  AgentHealthEntry,
  AgentHealthState,
  CorrelationBasis,
  ObservedCorrelation,
  ObservedCorrelationKind,
  FleetObservationEvidence,
  FailureOccurrenceCitation,
  DeclaredAttributeCitation,
  HypothesisedCause,
  HypothesisedCauseKind,
  FleetShareMeasurement,
  ShareDiscrimination,
  UnansweredFleetQuestion,
  UnansweredFleetQuestionKind,
  CorrelationIncoherence,
  FleetIncoherenceFinding,
  UnusableReason,
  UnusableFieldFinding,
  BaseRateUsability,
  // Cross-run causality ("what caused this, and what did it break?"). TWO
  // structural separations, and both are load-bearing:
  //
  //   RECORDED vs INFERRED — `RecordedCausalEdge` and `SuspectedLink` are
  //   mutually unassignable, and a suspicion carries NO DIRECTION of any name,
  //   so it is unwalkable rather than merely marked do-not-walk. Every
  //   collection a walk consumes is typed `RecordedCausalEdge[]`.
  //
  //   ENDED vs LOOPED vs LOST — `RecordedOrigin`, `CycleReEntry` and
  //   `LostTrail` are three dispositions of a frontier sharing NO FIELD except
  //   the discriminant (`originRunId`/`hopsToOrigin` vs
  //   `reEnteredRunId`/`hopsToReEntry` vs `lastReachedRunId`/`hopsBeforeLoss`),
  //   so no template can render one as another by forgetting a field and
  //   `originRunId ?? lastReachedRunId` cannot be written. Two of the three mean
  //   the investigation FINISHED and one means it did not; an origin can only be
  //   built from an `OriginProof` whose `inboundReadComplete` is the literal type
  //   `true` and whose `inboundEdgesFound` is the literal type `0`.
  //
  // NOT collapsed into convenience unions, for the reasons written up in
  // `packages/contracts/src/causality.ts`. `ChainTerminus` is the one exception
  // and its own doc explains why a single-slot union of two field-disjoint types
  // is safe where a findings union is not.
  CausalTraversal,
  CausalScan,
  CausalVerdict,
  CausalVerdictInput,
  CausalDirection,
  DirectedWalk,
  ComponentTerminus,
  TerminusFor,
  ComponentTraversal,
  DirectedTraversal,
  CausalNode,
  EdgeAdjacency,
  RecordedCausalEdge,
  RecordedCausalEdgeKind,
  CausalEvidence,
  CausalEventCitation,
  CausalArtifactCitation,
  CausalRunFieldCitation,
  SuspectedLink,
  SuspectedLinkKind,
  ChainTerminus,
  RecordedOrigin,
  OriginProof,
  CycleReEntry,
  LostTrail,
  TrailLossKind,
  UnansweredCausalQuestion,
  UnansweredCausalQuestionKind,
  CausalIncoherence,
  CausalIncoherenceFinding,
  CausalUnusableReason,
  CausalUnusableFieldFinding,
  CausalClaim,
  CausalClaimContradiction,
  CausalClaimFinding,
  // Budget circuit breakers ("may this agent spend any more?"). THREE
  // structural separations, and all three are load-bearing:
  //
  //   TOLD-YES vs NOT-ASKED — `AllowedByArmedBreaker`, `AllowedWithinGrace`,
  //   `AllowedNoBudgetGoverns` and `AllowedWithoutAnswer` are four different
  //   ways of proceeding and they share no field. There is deliberately no
  //   `allowed: boolean`, because it would have made "the breaker said yes" and
  //   "we never asked and the policy says go" the same number on the same graph.
  //
  //   EXACT vs APPROXIMATE — `ReconciledSpend` carries `reconciledAmount` and
  //   `ApproximateSpend` carries `estimatedAmount`; there is no `amount`, so
  //   `spend.amount >= limit.limitAmount` does not compile and the only
  //   comparison is `compareSpendToLimit`, which is three-valued. ADR-002's
  //   counters are approximate and NOT billing-grade, and an approximate $99
  //   against a $100 cap is `not_decidable`, never `provably_under`.
  //
  //   THE BREAKER vs THE SDK vs THE AGENT — "the breaker is tripped" and "the
  //   SDK declined" are facts we own. "The agent halted" is not, and no type or
  //   field below can express it; `FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS` is the
  //   vocabulary the wire gate refuses.
  //
  // NOT collapsed into convenience unions, for the reasons written up in
  // `packages/contracts/src/budgets.ts`.
  BudgetLimit,
  BudgetScope,
  BudgetPeriod,
  BudgetMeter,
  BudgetSubject,
  SpendFigure,
  ReconciledSpend,
  ApproximateSpend,
  SpendReconciliation,
  SpendApproximationKind,
  SpendUsability,
  LimitComparison,
  BreakerState,
  BreakerTripped,
  BreakerArmed,
  BreakerStateUndetermined,
  BreakerUndeterminedKind,
  BreakerTripCause,
  BreakerSnapshot,
  BreakerScan,
  BudgetDecision,
  BudgetDecisionInput,
  BudgetUnavailablePolicy,
  AllowedByArmedBreaker,
  AllowedNoBudgetGoverns,
  AllowedWithinGrace,
  AllowedWithoutAnswer,
  DeclinedBreakerTripped,
  DeclinedNoAnswer,
  BudgetUnusableReason,
  BudgetUnusableFieldFinding,
  BudgetClaim,
  BudgetClaimContradiction,
  BudgetClaimFinding,
  UpsertBudgetRequest,
  ManualTripRequest,
  ManualResetRequest,
  BudgetMutationResult,
  // Declarative policy ("may this agent call that tool?"). THE EVIDENTIAL
  // ASYMMETRY IS INVERTED FROM SPEND, and every separation below follows from
  // that:
  //
  //   VIOLATED IS CHEAP, SATISFIED IS NEARLY UNPROVABLE. A `PolicyViolationProof`
  //   is one event citation. A `PolicyCoverageProof` needs five literal-typed
  //   fields — and a sixth that no amount of reading can supply, because
  //   `Events.toolCall` and `Events.httpRequest` are MANUAL BUILDERS with no
  //   interception behind them: a complete read of an incomplete recording
  //   proves nothing about the world. So satisfaction requires an
  //   `InstrumentationClaim` the AGENT made, and `{ claims: 'undeclared' }` — the
  //   state of every agent today — makes `satisfied` UNREACHABLE. That is the
  //   honest answer, the same way `provably_under` is unreachable for a
  //   counter-backed budget.
  //
  //   `SatisfactionLicence` IS A ONE-MEMBER UNION. Exactly one way to establish
  //   satisfaction, and the extension point is a single greppable line.
  //
  //   NOT-EVALUABLE vs SATISFIED — `violatedPolicyId` / `satisfiedPolicyId` /
  //   `undecidedPolicyId` share no field, so `o.satisfiedPolicyId ??
  //   o.undecidedPolicyId` does not compile. There is no one-word name for the
  //   good outcome anywhere, and `PolicyOutcomeCounts` requires all three counts
  //   so a bare `satisfiedCount` — the figure that leaves the type system and
  //   ends up in a questionnaire — is unconstructible.
  //
  //   THE POLICY vs THE SDK vs THE CALL — "a policy forbids this" and "the SDK
  //   advised against" are ours. "The call was prevented" is not, and
  //   `FORBIDDEN_PREVENTION_CLAIM_FIELDS` is the vocabulary the wire gate
  //   refuses, alongside `FORBIDDEN_SUPPRESSION_FIELDS` (invariant 0) and
  //   `FORBIDDEN_COMPLIANCE_CLAIM_FIELDS` (invariant 2).
  //
  // See `packages/contracts/src/policy.ts` and ADR-009.
  PolicyRule,
  PolicyRuleKind,
  PolicySubject,
  PolicyDefinition,
  InstrumentationClaim,
  CompleteInstrumentationClaim,
  PolicyEventCitation,
  ViolationDecidedBy,
  RuleMatch,
  RecordedActEvent,
  PolicyViolationProof,
  PolicyCoverageProof,
  SatisfactionLicence,
  PolicyOutcome,
  PolicyViolated,
  PolicySatisfied,
  PolicyNotEvaluable,
  PolicyNotEvaluableKind,
  PolicyOutcomeCounts,
  PolicyEvaluation,
  PolicyEvaluationScan,
  PolicyVerdict,
  PolicyUnusableReason,
  PolicyUnusableFieldFinding,
  PolicyClaim,
  PolicyClaimContradiction,
  PolicyClaimFinding,
  PolicySnapshot,
  ProposedAct,
  PolicyUnavailablePolicy,
  PolicyPreflightAnswer,
  PolicyPreflightInput,
  AdvisedAgainstByPolicy,
  NoListedPolicyForbidsThisAct,
  NoPolicyGovernsThisSubject,
  ProceededWithinGrace,
  AdvisedAgainstWithoutAnswer,
  ProceededWithoutPolicyAnswer,
  UpsertPolicyRequest,
  DisablePolicyRequest,
  PolicyMutationResult,
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
  // Blast radius and org health, rendered honestly in ONE place: a saturated
  // affected-agent set reads "20+", and an org with no patterns has NO health
  // score rather than a perfect one. Same rule in both — an unmeasured
  // quantity is not a measured extreme.
  affectedAgentCountLabel,
  healthScoreLabel,
  MAX_AFFECTED_AGENT_IDS,
  readAgentConfigSnapshot,
  declaredDimensions,
  supportsProof,
  AGENT_CONFIG_SNAPSHOT_SCHEMA,
  // Fleet health RULES (runtime). Same single-definition posture: one
  // completeness predicate, one verdict rule, one ranking, one base-rate
  // interpretation — shared by `afr fleet`, the web UI, the MCP surface and
  // `FlightReader`'s own response verification.
  computeFleetHealthVerdict,
  fleetHealthReportVerdict,
  isFleetHealthAnalysisComplete,
  isFleetHealthScanComplete,
  rankFleetCorrelations,
  hypothesesFor,
  orphanHypotheses,
  isCorrelationSelfConsistent,
  // Cross-field coherence — "do the report's own numbers agree WITH EACH
  // OTHER?". `fleetReportIncoherences` is the one a GATE calls: it is the only
  // entry point holding both the correlation and the `burstWindowMs` it was
  // computed under, so it is the only one that can catch a "four-minute burst"
  // that actually spans a day.
  fleetReportIncoherences,
  // "Is what arrived something arithmetic can be done with?" — asked at the
  // boundary, BEFORE any coherence check or verdict, because those do
  // arithmetic and arithmetic on a string does not throw.
  fleetReportUnusableFields,
  baseRateUsability,
  correlationIncoherences,
  citedAgentCount,
  // The hypothesis sentence is COMPOSED, never transmitted — the mood is a
  // property of the type rather than of whoever wrote the engine. Render this,
  // never a string from the wire.
  hypothesisQuestion,
  SHARED_ATTRIBUTE_HYPOTHESIS_KINDS,
  discriminationOf,
  FLEET_DISCRIMINATION_MARGIN,
  MAX_FLEET_CORRELATION_AGENTS,
  // Causality RULES (runtime). Same single-definition posture: one completeness
  // predicate, one verdict rule, one coherence sweep, one usability sweep —
  // shared by `afr cause`, the web UI, the MCP surface and `FlightReader`'s own
  // response verification. A second copy is how a monitoring loop and a graph
  // view come to disagree about whether a trace finished.
  computeCausalVerdict,
  causalTraversalVerdict,
  isCausalTraversalComplete,
  lostTrails,
  recordedOrigins,
  cycleReEntries,
  convergencePoints,
  edgesInto,
  edgesOutOf,
  downstreamRunCount,
  // "Do the traversal's own contents agree with each other?" — the one a GATE
  // calls, because it is the only entry point holding both the edges and the
  // node set they must live inside.
  traversalIncoherences,
  // "Do the traversal's CLAIMS agree with its own edge set?" — the prior
  // question to both of the above, and the one that four defects came through.
  // Driven by a total table over the claim kinds, so a new self-claim is a
  // compile error until it has an audit. Do NOT re-implement any part of it at
  // a call site: three layers each had their own emptiness check, all three
  // caught the empty-citation case, and that redundancy is what hid the hole in
  // the primitive underneath them.
  traversalClaimContradictions,
  edgeIncoherences,
  citedEndpointCount,
  // "Is what arrived something arithmetic can be done with?" — asked at the
  // boundary, BEFORE any coherence check or verdict. It is also where
  // `unproven_origin` is reported: an origin without a complete, empty
  // adjacency read behind it is a lost trail wearing an origin's clothes.
  traversalUnusableFields,
  // The suspicion sentence is COMPOSED, never transmitted — always
  // interrogative, never directional. Render this, never a string from the wire.
  suspicionQuestion,
  // The terminus sentence, likewise composed, so no surface can render a lost
  // trail in the confident register.
  originStatement,
  RECORDED_CAUSAL_EDGE_KINDS,
  MAX_SUSPECTED_LINK_RUNS,
  MAX_CAUSAL_NODES,
  DEFAULT_CAUSAL_MAX_DEPTH,
  // Budget RULES (runtime). Same single-definition posture, and here it is not
  // a consistency nicety — two implementations of "may this agent spend more?"
  // is two different answers to the same question in the same company, one of
  // which lets spend past a cap.
  //
  // `decideBudget` is THE rule, shared by `BudgetGuard` and `afr budget check`.
  // `mayProceed` is the boolean a control-flow site needs, backed by a TOTAL
  // map over the decision bands so a seventh band cannot ship unclassified.
  // `compareSpendToLimit` is the ONLY way to compare a spend to a limit, and it
  // is three-valued because an approximate figure near a cap decides nothing.
  decideBudget,
  mayProceed,
  wasDeclinedBySdk,
  compareSpendToLimit,
  spendUsability,
  isBreakerSnapshotComplete,
  breakerSnapshotRefusals,
  breakerCadenceInvariant,
  // "Which tripped breaker may a decision rely on?" — scoped, so a typo in a
  // sibling field cannot erase a genuine trip's identity and reason.
  establishedTrip,
  // The shelf life a snapshot states, as a DURATION — the one reader, so the
  // decision rule and the refresh scheduler cannot end up on different clocks.
  // Prefers the explicit `shelfLifeMs`; a duration means the same thing whenever
  // it arrives, where an absolute instant silently spends the cadence margin on
  // network transit — fleet-wide and simultaneously, at the worst moment.
  statedShelfLifeMs,
  // "Do the snapshot's claims agree with the figures it ships with?" — the one
  // a GATE calls. `armed_on_undecidable_spend` is the ADR-002 audit.
  snapshotClaimContradictions,
  // "Is what arrived something a comparison can be trusted with?" — asked at the
  // boundary, BEFORE any limit check. '9900' >= 10000 is false by JS coercion,
  // so a wrong-typed spend figure does not FAIL a limit check, it PASSES one.
  snapshotUnusableFields,
  // The decision sentence is COMPOSED, never transmitted — so no surface can
  // phrase a decline as an outcome. Render this, never a string from the wire.
  decisionStatement,
  spendStatement,
  FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS,
  BUDGET_SCOPES,
  BUDGET_PERIODS,
  BUDGET_METERS,
  MAX_BREAKER_STATES,
  BREAKER_EVALUATION_CADENCE_MS,
  BREAKER_FRESHNESS_CADENCE_MULTIPLE,
  MAX_BREAKER_ANSWER_FRESHNESS_MS,
  MAX_BREAKER_GRACE_MS,
  // Policy RULES (runtime). Same single-definition posture, and here it is the
  // matching predicate that matters most: the preflight answers "may I call
  // this" from a raw URL a caller holds, and the evaluator answers "did this
  // happen" from a recorded `http.request` payload. TWO IMPLEMENTATIONS OF ONE
  // PREDICATE means an act the preflight permitted is later reported as a
  // violation, or the reverse.
  //
  // `decidePreflight` is THE rule, shared by `PolicyPreflight` and `afr policy
  // check`. `mayProceedWithAct` is the boolean, backed by a TOTAL map so a
  // seventh band cannot ship unclassified. `computePolicyVerdict` is
  // four-valued, and only its longest-named band is an all-clear.
  decidePreflight,
  mayProceedWithAct,
  wasAdvisedAgainstBySdk,
  actIsForbiddenBy,
  hostFallsUnder,
  // EXTRACTION AND MATCHING TOGETHER, IN ONE FUNCTION. `matchRecordedEventAgainstPolicy`
  // takes a whole recorded event and answers in four bands, because the obvious
  // factoring — a reader handing a string to a matcher — produced a live false
  // all-clear: the reader accepted `host` as well as `url`, the matcher only
  // parsed URLs, and a recorded egress to a denied host was counted fully
  // legible, matched against nothing, and cleared the run. There is deliberately
  // no exported function that does half of this. `undecidable` is NOT
  // `permitted_by_this_rule`, and a value present but uninterpretable is
  // evidence we could not read, never evidence of compliance.
  matchRecordedEventAgainstPolicy,
  hostForMatching,
  isExternalizedPayload,
  // `[]` is a misconfiguration, not a deny-all — a rule that forbids nothing
  // while looking exactly like one that checked. Read at EVALUATION time, not
  // only at write time, so a row written by another client cannot grade runs
  // clean.
  isInterpretableRule,
  // "Does this policy govern anything?" — enabled AND interpretable, read once
  // so a loader cannot filter on a different notion than the matcher uses. A
  // disabled policy reaching the evaluator is `not_evaluable`, never a
  // violation: a false all-clear is believed, but A FALSE VIOLATION IS ACTED ON
  // — somebody rolls back on a rule that was explicitly turned off.
  policyGoverns,
  // "Can this rule be decided from the event TYPE alone?" — true ONLY for a rule
  // that denies the operation itself, and that is the one case where an
  // externalized payload still proves a violation. Widening it to partial lists
  // manufactures proofs (ADR-009 §4.3).
  ruleIsDecidableFromEventTypeAlone,
  // "Does this agent's declaration cover the operation class this rule is
  // about?" — what stops a tool-call declaration licensing an egress all-clear.
  instrumentationCovers,
  // The gate. `isCoverageProof` is the single most important validator in the
  // feature: it is what stands between a partial read of an undeclared agent and
  // a false all-clear.
  isCoverageProof,
  isEstablishedSatisfied,
  isAllClear,
  computePolicyVerdict,
  establishedViolations,
  countPolicyOutcomes,
  policyEvaluationRefusals,
  policySnapshotRefusals,
  evaluationUnusableFields,
  evaluationClaimContradictions,
  complianceClaimIn,
  // The sentences are COMPOSED, never transmitted — so no surface can render an
  // unevaluable policy in the all-clear register. Render these, never a string
  // from the wire.
  policyOutcomeStatement,
  policyVerdictStatement,
  preflightStatement,
  PREFLIGHT_STILL_RECORDS,
  FORBIDDEN_PREVENTION_CLAIM_FIELDS,
  FORBIDDEN_COMPLIANCE_CLAIM_FIELDS,
  FORBIDDEN_SUPPRESSION_FIELDS,
  FORBIDDEN_POLICY_WIRE_FIELDS,
  FORBIDDEN_COMPLIANCE_PROSE,
  POLICY_RULE_KINDS,
  POLICY_SUBJECT_KINDS,
  POLICY_NOT_EVALUABLE_KINDS,
  RULE_DECIDING_EVIDENCE,
  MAX_POLICIES_PER_ORG,
  MAX_POLICY_OUTCOMES,
  MAX_POLICY_ANSWER_FRESHNESS_MS,
  MAX_POLICY_GRACE_MS,
} from '@agent-flight-recorder/contracts'
