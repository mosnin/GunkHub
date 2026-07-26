/**
 * divergence/labels.ts — operator-facing wording for the divergence vocabulary.
 *
 * The contract carries per-finding prose already (`provenClaim`,
 * `speculativeConcern`, `undecidedQuestion`), and the UI renders those verbatim
 * — they are the engine's own words about a specific finding and must not be
 * paraphrased. What the contract does NOT carry is wording for the KIND and
 * VERDICT enums, which the UI needs for column labels, group headings and the
 * one-word answer at the top of the page.
 *
 * Every record here is exhaustively keyed on a contract union, so adding a kind
 * upstream without giving it wording is a compile error rather than a raw enum
 * string rendered at an operator.
 *
 * ---------------------------------------------------------------------------
 * GRAMMAR IS PART OF THE SPECIFICATION
 * ---------------------------------------------------------------------------
 *
 * The contract is explicit that the three bands must never read alike, and the
 * wording below is the first line of that separation — before any styling, and
 * surviving being read aloud:
 *
 *   PROVEN         indicative, past tense, about what WAS recorded.
 *   SPECULATIVE    conditional — "may", never "would have".
 *   INDETERMINATE  interrogative — an open question, never a claim.
 *
 * A change that puts a proven label in the conditional, or a speculative one in
 * the indicative, is a defect even if it renders identically.
 */

import type {
  DivergenceDimension,
  DivergenceUnassessedReason,
  DivergenceVerdict,
  IndeterminateDivergenceKind,
  ProvenDivergenceKind,
  SpeculativeDivergenceKind,
} from '@agent-flight-recorder/contracts'

/** The three certainty bands, in the order they are always rendered. */
export const CERTAINTY_ORDER = ['proven', 'speculative', 'indeterminate'] as const
export type Certainty = (typeof CERTAINTY_ORDER)[number]

export const PROVEN_KIND_LABEL: Readonly<Record<ProvenDivergenceKind, string>> = {
  tool_removed: 'Tool no longer declared',
  tool_call_rejected_by_schema: 'Recorded arguments rejected by target schema',
  model_removed: 'Model no longer permitted',
  budget_exceeded: 'Recorded usage exceeds target budget',
  capability_removed: 'Capability no longer declared',
}

export const SPECULATIVE_KIND_LABEL: Readonly<Record<SpeculativeDivergenceKind, string>> = {
  system_prompt_changed: 'System prompt changed',
  model_substituted: 'Model substituted',
  decoding_params_changed: 'Decoding parameters changed',
  tool_added: 'Tool added',
  tool_description_changed: 'Tool description changed',
  tool_schema_widened: 'Tool schema widened',
  config_changed: 'Configuration changed',
}

export const INDETERMINATE_KIND_LABEL: Readonly<Record<IndeterminateDivergenceKind, string>> = {
  target_config_unreadable: 'Target configuration unreadable',
  recorded_history_incomplete: 'Recorded history incomplete',
  evidence_externalized: 'Deciding evidence externalized',
  engine_limit: 'Analysis ceiling reached',
}

/**
 * What an operator should DO about a coverage gap, keyed by the contract's
 * reason.
 *
 * ONE MAP, used by both the coverage panel and the adapter's lifted
 * `IndeterminateDivergence.remedy`. They were briefly two maps with drifting
 * wording, which is precisely the failure this file exists to prevent: the same
 * gap explained two different ways in two places on the same page reads as two
 * different problems.
 *
 * Deliberately per-reason. "Record a snapshot" and "fix the snapshot's shape"
 * are different jobs for different people, and collapsing them to "not checked"
 * leaves someone knowing they have a problem but not which one.
 */
export const UNASSESSED_REMEDY: Readonly<Record<DivergenceUnassessedReason, string>> = {
  target_config_missing:
    'Record a configuration snapshot on the target version. Without one, no dimension can ever be checked.',
  target_dimension_absent:
    'Declare this dimension in the target version\'s configuration snapshot. Its absence is unknown, not empty — the engine will not infer "no tools" from a missing tool list.',
  baseline_config_missing:
    'The version this run executed under has no snapshot, so no CHANGE can be established. Record snapshots on new versions and future runs will be fully analysable.',
  unsupported_config_shape:
    'Correct the shape of this dimension in the target version\'s snapshot and re-run. Present-but-unreadable is not absent.',
  engine_limit:
    'Re-run the single-run analysis for a complete answer on this dimension — this is a scale limit, not a data problem.',
}

/** Short tag for a coverage gap, for dense table cells. */
export const UNASSESSED_REASON_LABEL: Readonly<Record<DivergenceUnassessedReason, string>> = {
  target_config_missing: 'no target snapshot',
  target_dimension_absent: 'not declared on target',
  baseline_config_missing: 'no baseline snapshot',
  unsupported_config_shape: 'unreadable shape',
  engine_limit: 'analysis ceiling',
}

export const DIMENSION_LABEL: Readonly<Record<DivergenceDimension, string>> = {
  tools: 'tool set',
  model: 'model',
  system_prompt: 'system prompt',
  budgets: 'budgets',
  decoding_params: 'decoding parameters',
  capabilities: 'capabilities',
}

// ---------------------------------------------------------------------------
// Section identity
// ---------------------------------------------------------------------------

/**
 * The heading, the caption and the marker word for one band.
 *
 * These three strings ARE the non-colour distinction. Read the trio down each
 * column and the epistemic difference is stated three times over, in three
 * different grammatical moods, before any pixel is styled.
 */
export const CERTAINTY_COPY: Readonly<
  Record<Certainty, { word: string; heading: string; caption: string }>
> = {
  proven: {
    word: 'PROVEN',
    heading: 'Could not have happened',
    caption:
      'Each reason below is proven by a recorded event: the run did something the target version cannot do. These are facts about history, not predictions. Safe to block a release on.',
  },
  speculative: {
    word: 'UNPROVEN',
    heading: 'May behave differently',
    caption:
      'Each reason below is a configuration change that may alter behaviour — or may change nothing at all. Nothing here is evidence that a run would break.',
  },
  indeterminate: {
    word: 'UNKNOWN',
    heading: 'Could not be checked',
    caption:
      'Each question below could not be answered from what is recorded. These are neither findings nor the absence of findings — while any remain, no result on this page is a clean bill of health.',
  },
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * The one-word answer, plus the sentence that stops it being misread.
 *
 * `indeterminate` is the load-bearing entry. It is NOT a hedge and must never
 * be worded like one: it is the answer that exists specifically to stop a false
 * clean, so its copy says outright that nothing was established.
 */
export const VERDICT_COPY: Readonly<
  Record<DivergenceVerdict, { word: string; certainty: Certainty | null; detail: string }>
> = {
  incompatible: {
    word: 'INCOMPATIBLE',
    certainty: 'proven',
    detail:
      'At least one recorded step could not have happened on the target version. This is proven from the event log, and remains true regardless of anything that went unchecked.',
  },
  compatible_with_caveats: {
    word: 'COMPATIBLE, WITH CAVEATS',
    certainty: 'speculative',
    detail:
      'Nothing recorded contradicts the target version, and the analysis was complete. Configuration changes exist that may alter behaviour, but none of them is evidence of a break.',
  },
  compatible: {
    word: 'COMPATIBLE',
    certainty: null,
    detail:
      'The analysis was complete: every dimension was examined, the full event history was read, and nothing recorded contradicts the target version.',
  },
  indeterminate: {
    word: 'INDETERMINATE',
    certainty: 'indeterminate',
    detail:
      'Nothing was proven — but the analysis did not finish looking, so "nothing found" is not evidence here. This is not a green light.',
  },
}

/** True when a verdict may be presented as a green light. Exactly two qualify. */
export function isShippableVerdict(verdict: DivergenceVerdict): boolean {
  return verdict === 'compatible' || verdict === 'compatible_with_caveats'
}

/**
 * THE LIMIT OF A CLEAN RESULT, stated on every clean result.
 *
 * ===========================================================================
 * WHY GOOD NEWS NEEDS A DISCLAIMER MORE THAN BAD NEWS DOES
 * ===========================================================================
 *
 * A clean divergence report says the target would not have BROKEN on recorded
 * history. It does NOT say the target would BEHAVE the same, and the gap
 * between those two claims is not a technicality — it is structural, and it is
 * permanent.
 *
 * Replay checks a new configuration against events that have already happened.
 * ADDED capability is invisible to it by construction: a new tool the agent
 * never had cannot contradict anything in a log recorded before it existed, so
 * a version that adds a tool, widens a schema or rewrites a prompt can be
 * perfectly `compatible` and still behave completely differently in production.
 * That is exactly why the engine emits `tool_added` as SPECULATIVE rather than
 * dropping it.
 *
 * An operator who reads `COMPATIBLE` as "this change is safe" has been
 * overpromised by us, and they will read it that way unless told otherwise —
 * which is why this sentence renders on the green states rather than only on
 * the red ones. A caveat that appears only when the news is bad trains people
 * to skip it precisely when it matters.
 */
export const CLEAN_RESULT_LIMIT =
  'This says the target version would not have BROKEN on recorded history. It does not say it would BEHAVE the same. Replay can only contradict what was recorded, so added tools, widened schemas and prompt changes are invisible to it by construction — a compatible version can still behave differently in production.'
