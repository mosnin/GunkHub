/**
 * `afr_triage`'s ranking — MOVED TO `@agent-flight-recorder/sdk`, re-exported
 * here.
 *
 * WHY IT MOVED. `afr triage` (the CLI) must answer the question this tool
 * answers, with the SAME ordering and the SAME next-hop pointers. Two rankings
 * that can disagree is the drift this project keeps paying for, so there is
 * exactly one implementation and both surfaces import it.
 *
 * It landed in the SDK rather than staying here because `packages/mcp` is a
 * leaf APPLICATION (a `bin`), not a shared library: a CLI depending on it would
 * invert the dependency graph and drag an MCP server and its stdio transport
 * into a published command-line binary. Both `packages/cli` and `packages/mcp`
 * already depend on the SDK, and `FailurePattern`, `V1ListFailurePatternsData`
 * and `FixConfidenceEntry` already live there — so the SDK is where the ranking
 * belongs.
 *
 * The full design rationale — the signal ordering and why it is that ordering,
 * the 40-point weight spacing that keeps tie-breakers from promoting an item
 * across a signal class, the token budget, the pointer rules, and the
 * `clear`/`unknown` distinction — travelled WITH the code. It is in
 * `packages/sdk/src/triage.ts`, not summarised here, so there is one place to
 * read and one place to change.
 *
 * This module is a pure re-export. Nothing is redeclared, wrapped, or defaulted
 * — `tools/triage.ts`, `index.ts` and the MCP triage tests all import from here
 * unchanged.
 */
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
} from '@agent-flight-recorder/sdk'

export type { TriageSignal, TriageItem, TriagePointer, TriageVerdict, TriageResult } from '@agent-flight-recorder/sdk'
