/**
 * divergence/adapt.ts — the seam between Team A's engine and Team B's contract.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ===========================================================================
 *
 * `packages/contracts/src/divergence.ts` (Team B) is the authoritative shape of
 * a divergence answer, and CLAUDE.md § Repo Conventions is unambiguous: the web
 * app imports entity types from contracts and never redeclares them. Every
 * divergence type below is therefore IMPORTED, not defined. The only local
 * interfaces are descriptions of Convex's transport envelopes, which have no
 * contract type of their own.
 *
 * `convex/divergence.ts` (Team A) returns almost exactly the contract shape,
 * with three differences the web tier has to reconcile:
 *
 *   1. THE ENGINE DOES NOT EMIT THE THIRD BAND. `RunDivergenceAnalysis` carries
 *      `proven`, `speculative` and `coverage` — but no `indeterminate`, which
 *      `DivergenceReport` requires. Same for `indeterminateReasons` on the
 *      fleet side.
 *   2. `analyzeRun` reports unread events two ways — inside `coverage`, and via
 *      a non-null `nextEventCursor`.
 *   3. `analyzeFleet` is one BOUNDED BATCH keyed on a (baseline, target)
 *      version pair; the contract's report is the whole answer for an agent.
 *
 * ---------------------------------------------------------------------------
 * THE MISSING THIRD BAND IS FILLED HONESTLY, NOT SILENTLY
 * ---------------------------------------------------------------------------
 *
 * The tempting adaptation is `indeterminate: []`. That is a lie with a specific
 * and dangerous consequence. `isDivergenceAnalysisComplete` is
 * `coverageComplete && indeterminate.length === 0`, so an empty third band
 * makes a report look complete purely because the engine has no vocabulary for
 * its own uncertainty — and `computeDivergenceVerdict` then returns
 * `compatible` instead of `indeterminate`. That is a FALSE CLEAN manufactured
 * by an adapter, on the one surface where a false clean ships a breaking
 * change.
 *
 * So {@link liftUnassessedToIndeterminate} PROMOTES the engine's coverage gaps
 * into real `IndeterminateDivergence` findings: every `unassessed` dimension,
 * and an incomplete event history, become explicit third-band findings with a
 * stated `unknownBecause`. The verdict then falls out of the contract's own
 * rule with no special-casing, and "we could not check the tool list" can never
 * render as "compatible".
 *
 * The lift is idempotent with respect to `reasonKey`, so when Team A's engine
 * starts emitting its own third band, engine-authored findings win and nothing
 * is duplicated.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A SECOND OPINION, NOT A PATCH — AND IT MUST STAY ONE
 * ---------------------------------------------------------------------------
 *
 * At the time of writing this adapter independently recovers to
 * `indeterminate` in cases where Team A's `foldFleetDivergence` still reports
 * `compatible` — notably per-run truncated history, which is the DEFAULT path
 * for any run over the fleet per-run event bound. Team A is fixing the fold.
 *
 * That fix must not make this code wrong, and this code must not hide that fix
 * being needed. Both properties come from the same design choice: everything
 * here is derived from the OBSERVABLE FACTS in `coverage` and `window` —
 * unassessed dimensions, unread events, unanalysed runs, remaining pages — and
 * NEVER from the engine's `verdict`, which the envelope types do not even
 * carry. So:
 *
 *   - when the fold starts reporting these cases correctly, the facts this
 *     module reads are unchanged and it keeps reaching the same conclusion. It
 *     does not double-correct, because it corrects nothing: it recomputes.
 *   - if a future engine regression starts UNDER-reporting a gap in `coverage`
 *     or `window`, this module goes quiet with it rather than silently papering
 *     over it — which is why tests/unit/blast_radius_adapt.test.ts asserts on
 *     the facts→verdict mapping directly, and why the engine keeps its own
 *     tests. A defence that conceals the thing it defends against is how the
 *     real fix gets reverted later as "unnecessary".
 *
 * ---------------------------------------------------------------------------
 * THE VERDICT IS RECOMPUTED, NEVER COPIED
 * ---------------------------------------------------------------------------
 *
 * The engine sends a `verdict`. This adapter ignores it and recomputes from the
 * report's own contents via the contract's `computeDivergenceVerdict`. That is
 * the posture the contract itself prescribes ("a response whose verdict
 * disagrees with its own contents is a response that cannot be trusted with a
 * deploy decision"), and it is load-bearing here: after lifting coverage gaps
 * into the third band, the report's contents have changed, so the engine's
 * verdict is stale by construction.
 */

import {
  computeDivergenceVerdict,
  isDivergenceAnalysisComplete,
  isFleetDivergenceAnalysisComplete,
  MAX_DIVERGENCE_REPRESENTATIVE_RUNS,
  type DivergenceCoverage,
  type DivergenceDimension,
  type DivergenceReport,
  type DivergenceScanWindow,
  type DivergenceUnassessedDimension,
  type FleetDivergenceReport,
  type IndeterminateDivergence,
  type IndeterminateDivergenceKind,
  type IndeterminateDivergenceReason,
  type ProvenDivergence,
  type ProvenDivergenceReason,
  type SpeculativeDivergence,
  type SpeculativeDivergenceReason,
} from '@agent-flight-recorder/contracts'

import { DIMENSION_LABEL, UNASSESSED_REMEDY } from '@/lib/divergence/labels'

// ---------------------------------------------------------------------------
// Transport envelopes
// ---------------------------------------------------------------------------
//
// NOT redeclared entities — these describe what `convex/divergence.ts` puts on
// the wire. Their inner findings are contract types, imported above.

/** `convex/divergence.ts` → `analyzeRun`. */
export interface EngineRunEnvelope {
  runId: string
  baselineVersionId: string | null
  targetVersionId: string
  baselineVersion: string | null
  targetVersion: string
  analyzedAt: number
  proven: ProvenDivergence[]
  speculative: SpeculativeDivergence[]
  coverage: DivergenceCoverage
  /** Non-null means this run's event history was NOT read to the end. */
  nextEventCursor: string | null
}

/** `convex/divergence.ts` → `analyzeFleet`. One bounded batch. */
export interface EngineFleetEnvelope {
  agentId: string
  baselineVersionId: string
  targetVersionId: string
  baselineVersion: string
  targetVersion: string
  analyzedAt: number
  provenReasons: ProvenDivergenceReason[]
  speculativeReasons: SpeculativeDivergenceReason[]
  runsWithProvenDivergence: number
  window: DivergenceScanWindow
  /** Runs visited but dropped on the batch event budget. Not clean — unlooked-at. */
  runsSkippedForBudget: number
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Lifting coverage gaps into the third band
// ---------------------------------------------------------------------------

/**
 * Map a coverage gap to the indeterminate KIND that describes it.
 *
 * Note what is deliberately absent: `target_config_missing`. A target with no
 * snapshot at all is not one unanswered question — it is the analysis never
 * having been possible, and the service layer surfaces it as its own result
 * status. Folding it in here would bury a total non-answer inside a list of
 * partial ones.
 */
function kindForUnassessed(
  reason: DivergenceUnassessedDimension['reason'],
): IndeterminateDivergenceKind | null {
  switch (reason) {
    case 'target_dimension_absent':
    case 'unsupported_config_shape':
    case 'baseline_config_missing':
      return 'target_config_unreadable'
    case 'engine_limit':
      return 'engine_limit'
    case 'target_config_missing':
      return null
  }
}

/**
 * Operator-facing prose for one coverage gap.
 *
 * Note `DIMENSION_LABEL[u.dimension]` rather than `u.dimension`. The raw
 * contract value is a wire enum (`system_prompt`, `decoding_params`) and
 * interpolating it puts a snake_case identifier in front of an operator mid-
 * sentence. Every dimension reaching prose goes through the label map, which is
 * exhaustively keyed so a new dimension upstream cannot silently leak its enum.
 */
function unassessedExplanation(u: DivergenceUnassessedDimension): string {
  const dim = DIMENSION_LABEL[u.dimension]
  const base = ((): string => {
    switch (u.reason) {
      case 'target_dimension_absent':
        return `The target version's configuration does not describe its ${dim}, so whether the recorded run is compatible with it is unknown — not clean.`
      case 'unsupported_config_shape':
        return `The target version describes its ${dim} in a shape the engine cannot read, so it was not checked. Present-but-unreadable is not the same as absent.`
      case 'baseline_config_missing':
        return `The version this run executed under has no configuration snapshot, so no change in ${dim} could be established either way.`
      case 'engine_limit':
        return `The analysis reached its own ceiling before finishing the ${dim} check.`
      case 'target_config_missing':
        return 'The target version has no configuration snapshot at all.'
    }
  })()
  return u.detail === undefined ? base : `${base} (${u.detail})`
}

/**
 * Promote an engine coverage record into explicit third-band findings.
 *
 * Two sources of "we did not look", both of which must produce a finding:
 *   - each `coverage.unassessed` dimension;
 *   - `coverage.eventHistoryComplete === false`, which belongs to no single
 *     dimension and becomes a `recorded_history_incomplete` finding.
 *
 * `existing` lets an engine that HAS begun emitting its own third band win: a
 * lifted finding is dropped when a real one already carries its `reasonKey`.
 */
export function liftUnassessedToIndeterminate(
  coverage: DivergenceCoverage,
  existing: readonly IndeterminateDivergence[] = [],
): IndeterminateDivergence[] {
  const seen = new Set(existing.map((f) => f.reasonKey))
  const out: IndeterminateDivergence[] = []

  for (const u of coverage.unassessed) {
    const kind = kindForUnassessed(u.reason)
    if (kind === null) continue
    const reasonKey = `${kind}:${u.dimension}:${u.reason}`
    if (seen.has(reasonKey)) continue
    seen.add(reasonKey)
    out.push({
      certainty: 'indeterminate',
      kind,
      reasonKey,
      undecidedQuestion: `Whether this run's use of ${DIMENSION_LABEL[u.dimension]} is still possible on the target version.`,
      unknownBecause: unassessedExplanation(u),
      // The contract's optional `remedy` is what turns "I cannot tell" into "I
      // cannot tell YET, and here is what to do". Populated for every lifted
      // gap, because a gap the operator cannot act on is a gap they learn to
      // click past.
      remedy: UNASSESSED_REMEDY[u.reason],
      dimension: u.dimension,
    })
  }

  if (!coverage.eventHistoryComplete) {
    const reasonKey = 'recorded_history_incomplete:events'
    if (!seen.has(reasonKey)) {
      const dimension: DivergenceDimension = coverage.assessed[0] ?? 'tools'
      out.push({
        certainty: 'indeterminate',
        kind: 'recorded_history_incomplete',
        reasonKey,
        undecidedQuestion:
          'Whether the unread part of this run does anything the target version cannot do.',
        unknownBecause: `Only ${coverage.eventsExamined.toLocaleString()} events were read before the analysis stopped. A divergence proven in the part that WAS read still stands; the absence of one in the unread part is unknown.`,
        remedy:
          'Continue the analysis until the full event history has been read. Until then every finding is a lower bound.',
        dimension,
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Single run
// ---------------------------------------------------------------------------

/** Adapt the engine's run envelope into the contract's `DivergenceReport`. */
export function adaptRunReport(envelope: EngineRunEnvelope): DivergenceReport {
  // The engine reports history completeness two ways. The STRICTER of the two
  // wins: an adapter must never round completeness up.
  const coverage: DivergenceCoverage = {
    ...envelope.coverage,
    eventHistoryComplete:
      envelope.coverage.eventHistoryComplete && envelope.nextEventCursor === null,
  }

  const draft: DivergenceReport = {
    runId: envelope.runId,
    baselineVersionId: envelope.baselineVersionId,
    targetVersionId: envelope.targetVersionId,
    analyzedAt: envelope.analyzedAt,
    // Replaced below. Never copied from the engine — see the header.
    verdict: 'indeterminate',
    proven: envelope.proven,
    speculative: envelope.speculative,
    indeterminate: liftUnassessedToIndeterminate(coverage),
    coverage,
  }

  return {
    ...draft,
    verdict: computeDivergenceVerdict({
      provenCount: draft.proven.length,
      speculativeCount: draft.speculative.length,
      complete: isDivergenceAnalysisComplete(draft),
    }),
  }
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

/**
 * Adapt the engine's fleet batch into the contract's `FleetDivergenceReport`.
 *
 * `nextCursor` is carried ONTO THE WINDOW rather than folded into
 * `scanTruncated`. The contract added a first-class `nextCursor` field for
 * exactly this and folds it into `isFleetScanComplete` itself, so a page that
 * came back full and clean cannot look like a finished scan. Squashing it into
 * `scanTruncated` would still produce the right verdict, but would lose the
 * distinction the UI needs — "stopped at the row ceiling" and "there is a next
 * page you can fetch" call for different affordances.
 *
 * `runsSkippedForBudget` is likewise passed through as its own field rather
 * than added to `runsUnassessable`. They are different facts: visited and
 * unreadable versus never reached. The contract counts both as
 * not-having-looked, and the operator needs to know which.
 */
export function adaptFleetReport(envelope: EngineFleetEnvelope): FleetDivergenceReport {
  const window: DivergenceScanWindow = {
    ...envelope.window,
    runsSkippedForBudget: envelope.runsSkippedForBudget,
    ...(envelope.nextCursor !== null && { nextCursor: envelope.nextCursor }),
  }

  const draft: FleetDivergenceReport = {
    agentId: envelope.agentId,
    targetVersionId: envelope.targetVersionId,
    analyzedAt: envelope.analyzedAt,
    verdict: 'indeterminate',
    provenReasons: envelope.provenReasons,
    speculativeReasons: envelope.speculativeReasons,
    indeterminateReasons: fleetIndeterminateReasons(window),
    runsWithProvenDivergence: envelope.runsWithProvenDivergence,
    window,
  }

  return {
    ...draft,
    verdict: computeDivergenceVerdict({
      provenCount: draft.provenReasons.length,
      speculativeCount: draft.speculativeReasons.length,
      complete: isFleetDivergenceAnalysisComplete(draft),
    }),
  }
}

/**
 * Runs the scan could not analyse are a DISTINCT REASON in their own right.
 *
 * "The scan never reached 300 runs" is one fixable fact about the scan, not 300
 * incidents — grouping it like the other two bands is what keeps the fleet
 * view's promise that an operator reads reasons and never runs.
 */
function fleetIndeterminateReasons(window: DivergenceScanWindow): IndeterminateDivergenceReason[] {
  const out: IndeterminateDivergenceReason[] = []

  const reason = (
    reasonKey: string,
    kind: IndeterminateDivergenceKind,
    affectedRunCount: number,
    undecidedQuestion: string,
    unknownBecause: string,
    remedy: string,
  ): IndeterminateDivergenceReason => ({
    reasonKey,
    kind,
    certainty: 'indeterminate',
    affectedRunCount,
    // Deliberately empty: these reasons are properties of the SCAN, not of
    // particular runs, and inventing representative ids for them would imply
    // an inspectable exemplar that does not exist.
    representativeRunIds: [],
    exemplar: {
      certainty: 'indeterminate',
      kind,
      reasonKey,
      undecidedQuestion,
      unknownBecause,
      remedy,
      dimension: 'tools',
    },
  })

  // ---------------------------------------------------------------------
  // ZERO RUNS ANALYSED IS NOT A CLEAN FLEET.
  //
  // Without this, an empty batch folds to `provenCount: 0, speculativeCount: 0,
  // complete: true` and the contract's own rule correctly returns `compatible`
  // — a GREEN LIGHT DERIVED FROM ZERO RUNS. The rule is not wrong; the input is.
  // "We found no evidence" is not "we found no problems", and this is the most
  // dangerous instance of that confusion in the product because it lands on the
  // happy path with nothing on screen to contradict it.
  //
  // It is reachable in ordinary operation, not just adversarially: a version
  // whose runs have aged out of the org retention window (ADR-001) scans zero
  // runs and would otherwise be certified safe on the strength of having no
  // history left to check.
  //
  // Checked FIRST so it is the first question an operator reads.
  // ---------------------------------------------------------------------
  if (window.runsAnalyzed === 0) {
    out.push(
      reason(
        'engine_limit:no_runs_analysed',
        'engine_limit',
        0,
        'Whether this version would break anything at all — no recorded run was analysed.',
        window.runsScanned === 0
          ? 'The scan found no recorded runs to check this version against. That is an absence of evidence, not evidence of safety: a version with no history cannot be shown to be compatible with it.'
          : `The scan visited ${window.runsScanned.toLocaleString()} runs but analysed none of them. Nothing was checked, so nothing was established.`,
        'Record runs against the baseline version — or check whether its runs have aged out of this organisation\'s retention window — then re-run this analysis.',
      ),
    )
  }

  if (window.runsUnassessable > 0) {
    out.push(
      reason(
        'target_config_unreadable:runs_unassessable',
        'target_config_unreadable',
        window.runsUnassessable,
        'Whether the runs this scan could not read would have broken on the target version.',
        'These runs were visited but could not be analysed — their events were not retained, or their snapshot was unreadable. An unreadable run is not a run that passed.',
        'Check whether these runs fall outside the org retention window, or were recorded against a version with no snapshot.',
      ),
    )
  }

  if (window.runsSkippedForBudget > 0) {
    out.push(
      reason(
        'engine_limit:runs_skipped_for_budget',
        'engine_limit',
        window.runsSkippedForBudget,
        'Whether the runs this batch never reached would have broken on the target version.',
        'The execution budget ran out before these runs were examined. Unexamined runs are not runs that passed — continue the scan to cover them.',
        'Continue the scan to cover the runs this batch never reached.',
      ),
    )
  }

  if (window.nextCursor !== undefined) {
    out.push(
      reason(
        'recorded_history_incomplete:pages_remain',
        'recorded_history_incomplete',
        window.runsScanned,
        'Whether runs on later pages would have broken on the target version.',
        'Pages remain in this scan, so every count here is a LOWER BOUND rather than a total. The twelfth reason, on the run that matters, may be on page four — continue the scan before treating this as an answer.',
        'Continue the scan to the final page before treating any count here as an answer.',
      ),
    )
  }

  if (window.scanTruncated) {
    out.push(
      reason(
        'recorded_history_incomplete:scan_truncated',
        'recorded_history_incomplete',
        window.runsScanned,
        'Whether runs beyond the row ceiling would have broken on the target version.',
        'The scan stopped at the server row ceiling, so the counts here are a LOWER BOUND rather than a total. A reason absent here may still exist beyond the window.',
        'Narrow the scan window, or continue paging, to cover the runs beyond the ceiling.',
      ),
    )
  }

  return out
}

export { MAX_DIVERGENCE_REPRESENTATIVE_RUNS }
