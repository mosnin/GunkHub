export { buildReplayProjection, MAX_REPLAY_DEPTH } from './projection'
export { buildFailureSummary } from './failure'
export { buildRunDiff } from './diff'
export { verifyProjectionIntegrity } from './verify'
export type { ProjectionVerifyResult } from './verify'

// Temporal ordering (`analyzeRunOrdering`, `compareTemporalOrder`,
// `orderEventsForProjection`, `readTemporalOrder`, `readEventTiming`,
// `formatSkew`, and the `TemporalOrderKey` / `EventTiming` / `RunOrdering` /
// `OrderingBasis` types) lives in `@agent-flight-recorder/contracts` and is
// imported from there directly. It is deliberately NOT re-exported here: a
// second import path for the same symbols is how the mirror that this barrel
// used to front came to exist in the first place.
