/**
 * blast_radius_adapt.test.ts — the engine→contract adapter.
 *
 * ===========================================================================
 * WHAT IS AT STAKE HERE
 * ===========================================================================
 *
 * `apps/web/src/lib/divergence/adapt.ts` sits between Team A's engine and Team
 * B's contract. Team A's engine does not yet emit the contract's THIRD BAND
 * (`indeterminate`), and the naive adaptation — `indeterminate: []` — is a lie
 * with a mechanical consequence:
 *
 *   isDivergenceAnalysisComplete = coverageComplete && indeterminate.length === 0
 *   computeDivergenceVerdict(complete: true, proven: 0) === 'compatible'
 *
 * i.e. an empty third band manufactures a `compatible` verdict out of an
 * engine's inability to name its own uncertainty. A FALSE CLEAN, produced by an
 * adapter, on the one surface where a false clean ships a breaking change.
 *
 * So the claims under test, in order of damage:
 *
 *   1. Coverage gaps become REAL indeterminate findings, and the resulting
 *      verdict is `indeterminate`, never `compatible`.
 *   2. A proven finding survives incomplete coverage — `incompatible` outranks
 *      `indeterminate`, because a proof does not become less true because
 *      something else went unchecked.
 *   3. Completeness is never rounded UP. Two independent signals report unread
 *      events; the stricter wins.
 *   4. The verdict is RECOMPUTED from contents, never copied from the engine.
 */

import {
  isDivergenceAnalysisComplete,
  isFleetDivergenceAnalysisComplete,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import {
  adaptFleetReport,
  adaptRunReport,
  liftUnassessedToIndeterminate,
} from '../../apps/web/src/lib/divergence/adapt.js'

import type {
  EngineFleetEnvelope,
  EngineRunEnvelope,
} from '../../apps/web/src/lib/divergence/adapt.js'
import type {
  DivergenceCoverage,
  ProvenDivergence,
  SpeculativeDivergence,
} from '@agent-flight-recorder/contracts'


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_DIMENSIONS: DivergenceCoverage['assessed'] = [
  'tools',
  'model',
  'system_prompt',
  'budgets',
  'decoding_params',
  'capabilities',
]

/** Coverage with nothing missing — the only shape that may yield `compatible`. */
function fullCoverage(overrides: Partial<DivergenceCoverage> = {}): DivergenceCoverage {
  return {
    assessed: [...ALL_DIMENSIONS],
    unassessed: [],
    eventsExamined: 120,
    eventHistoryComplete: true,
    ...overrides,
  }
}

const PROVEN: ProvenDivergence = {
  certainty: 'proven',
  kind: 'tool_removed',
  dimension: 'tools',
  reasonKey: 'tool_removed:search_web',
  provenClaim: 'called tool `search_web` at sequence 42; target declares no such tool.',
  provenBy: [
    {
      citedEvent: { sequenceNumber: 42, eventId: 'evt_42', eventType: 'tool.call' },
      targetConfigPath: 'tools[].name',
      recordedValue: 'search_web',
      targetValue: null,
    },
  ],
}

const SPECULATIVE: SpeculativeDivergence = {
  certainty: 'speculative',
  kind: 'system_prompt_changed',
  dimension: 'system_prompt',
  reasonKey: 'system_prompt_changed:systemPrompt',
  speculativeConcern: 'system prompt changed; tool selection may differ.',
  speculativeBecause: 'nothing recorded can establish how a different prompt would have been followed.',
  changedConfigPath: 'systemPrompt',
}

function runEnvelope(overrides: Partial<EngineRunEnvelope> = {}): EngineRunEnvelope {
  return {
    runId: 'run_1',
    baselineVersionId: 'ver_0',
    targetVersionId: 'ver_1',
    baselineVersion: '1.0.0',
    targetVersion: '2.0.0',
    analyzedAt: 1_700_000_000_000,
    proven: [],
    speculative: [],
    coverage: fullCoverage(),
    nextEventCursor: null,
    ...overrides,
  }
}

function fleetEnvelope(overrides: Partial<EngineFleetEnvelope> = {}): EngineFleetEnvelope {
  return {
    agentId: 'agent_1',
    baselineVersionId: 'ver_0',
    targetVersionId: 'ver_1',
    baselineVersion: '1.0.0',
    targetVersion: '2.0.0',
    analyzedAt: 1_700_000_000_000,
    provenReasons: [],
    speculativeReasons: [],
    runsWithProvenDivergence: 0,
    window: {
      runsScanned: 25,
      runsAnalyzed: 25,
      runsUnassessable: 0,
      runsSkippedForBudget: 0,
      scanTruncated: false,
    },
    runsSkippedForBudget: 0,
    nextCursor: null,
    ...overrides,
  }
}

// ===========================================================================
// §1. The false clean this adapter exists to prevent
// ===========================================================================

describe('§1 an unchecked dimension can never render as compatible', () => {
  it('promotes an unassessed dimension into a real indeterminate finding', () => {
    const report = adaptRunReport(
      runEnvelope({
        coverage: fullCoverage({
          assessed: ['model'],
          unassessed: [{ dimension: 'tools', reason: 'target_dimension_absent' }],
        }),
      }),
    )

    expect(report.indeterminate).toHaveLength(1)
    expect(report.indeterminate[0]!.certainty).toBe('indeterminate')
    expect(report.indeterminate[0]!.dimension).toBe('tools')
    // The contract REQUIRES an explanation. An unexplained "unknown" gets ignored.
    // The operator-facing LABEL, not the wire enum. `tools` in a sentence is a
    // snake_case identifier leaking into prose.
    expect(report.indeterminate[0]!.unknownBecause).toMatch(/does not describe its tool set/i)
    // Phrased as an open question, never as a claim.
    expect(report.indeterminate[0]!.undecidedQuestion).toMatch(/^Whether /)
  })

  it('yields verdict `indeterminate`, NOT `compatible`, when a dimension was skipped', () => {
    const report = adaptRunReport(
      runEnvelope({
        coverage: fullCoverage({
          assessed: ['model'],
          unassessed: [{ dimension: 'tools', reason: 'target_dimension_absent' }],
        }),
      }),
    )

    expect(report.proven).toHaveLength(0)
    expect(report.speculative).toHaveLength(0)
    // The exact bug: zero findings, but the analysis never looked.
    expect(report.verdict).toBe('indeterminate')
    expect(isDivergenceAnalysisComplete(report)).toBe(false)
  })

  it('DOES yield `compatible` when coverage is genuinely complete and nothing was found', () => {
    // The control. If this ever fails the adapter has become paranoid rather
    // than honest, and a paranoid gate gets switched off.
    const report = adaptRunReport(runEnvelope())

    expect(report.indeterminate).toHaveLength(0)
    expect(report.verdict).toBe('compatible')
    expect(isDivergenceAnalysisComplete(report)).toBe(true)
  })

  it('gives each unassessed reason its own distinct explanation', () => {
    const report = adaptRunReport(
      runEnvelope({
        coverage: fullCoverage({
          assessed: [],
          unassessed: [
            { dimension: 'tools', reason: 'unsupported_config_shape' },
            { dimension: 'model', reason: 'baseline_config_missing' },
            { dimension: 'budgets', reason: 'engine_limit' },
          ],
        }),
      }),
    )

    expect(report.indeterminate).toHaveLength(3)
    const explanations = report.indeterminate.map((f) => f.unknownBecause)
    // Three different operator actions, so three different sentences.
    expect(new Set(explanations).size).toBe(3)
    expect(explanations.some((e) => /shape the engine cannot read/i.test(e))).toBe(true)
    expect(explanations.some((e) => /no configuration snapshot/i.test(e))).toBe(true)
    expect(explanations.some((e) => /own ceiling/i.test(e))).toBe(true)

    // Kinds are mapped, not invented.
    expect(report.indeterminate.map((f) => f.kind).sort()).toEqual([
      'engine_limit',
      'target_config_unreadable',
      'target_config_unreadable',
    ])
  })

  it('carries the engine detail through when one is supplied', () => {
    const report = adaptRunReport(
      runEnvelope({
        coverage: fullCoverage({
          unassessed: [
            { dimension: 'tools', reason: 'unsupported_config_shape', detail: 'tools was a string' },
          ],
        }),
      }),
    )
    expect(report.indeterminate[0]!.unknownBecause).toContain('tools was a string')
  })
})

// ===========================================================================
// §2. A proof survives incomplete coverage
// ===========================================================================

describe('§2 incompatible outranks indeterminate', () => {
  it('keeps `incompatible` even when coverage is incomplete', () => {
    // A proof does not become less true because something else went unchecked.
    // Demoting it would let an incomplete scan HIDE a certainty.
    const report = adaptRunReport(
      runEnvelope({
        proven: [PROVEN],
        coverage: fullCoverage({
          assessed: ['tools'],
          unassessed: [{ dimension: 'model', reason: 'target_dimension_absent' }],
        }),
      }),
    )

    expect(report.verdict).toBe('incompatible')
    expect(isDivergenceAnalysisComplete(report)).toBe(false)
    // The open question is still reported alongside the proof.
    expect(report.indeterminate.length).toBeGreaterThan(0)
    // And the proof keeps its citation.
    expect(report.proven[0]!.provenBy[0].citedEvent.sequenceNumber).toBe(42)
  })

  it('speculative findings alone with full coverage give compatible_with_caveats', () => {
    const report = adaptRunReport(runEnvelope({ speculative: [SPECULATIVE] }))
    expect(report.verdict).toBe('compatible_with_caveats')
  })

  it('speculative findings with INCOMPLETE coverage give indeterminate, not caveats', () => {
    const report = adaptRunReport(
      runEnvelope({
        speculative: [SPECULATIVE],
        coverage: fullCoverage({ eventHistoryComplete: false }),
      }),
    )
    expect(report.verdict).toBe('indeterminate')
  })
})

// ===========================================================================
// §3. Completeness is never rounded up
// ===========================================================================

describe('§3 the stricter of two completeness signals wins', () => {
  it('a non-null event cursor makes history incomplete even when coverage claims otherwise', () => {
    const report = adaptRunReport(
      runEnvelope({
        coverage: fullCoverage({ eventHistoryComplete: true }),
        nextEventCursor: 'cursor_abc',
      }),
    )

    expect(report.coverage.eventHistoryComplete).toBe(false)
    expect(report.verdict).toBe('indeterminate')
    expect(report.indeterminate.some((f) => f.kind === 'recorded_history_incomplete')).toBe(true)
  })

  it('coverage claiming incomplete history is honoured even with a null cursor', () => {
    const report = adaptRunReport(
      runEnvelope({ coverage: fullCoverage({ eventHistoryComplete: false }) }),
    )
    expect(report.coverage.eventHistoryComplete).toBe(false)
    expect(report.verdict).toBe('indeterminate')
  })

  it('the history finding states what WAS read, so a proof inside it still stands', () => {
    const report = adaptRunReport(
      runEnvelope({
        proven: [PROVEN],
        coverage: fullCoverage({ eventsExamined: 200, eventHistoryComplete: false }),
      }),
    )
    const f = report.indeterminate.find((x) => x.kind === 'recorded_history_incomplete')
    expect(f?.unknownBecause).toContain('200')
    expect(f?.unknownBecause).toMatch(/still stands/i)
    expect(report.verdict).toBe('incompatible')
  })
})

// ===========================================================================
// §4. The verdict is recomputed, never trusted
// ===========================================================================

describe('§4 the adapter never copies the engine verdict', () => {
  it('overrides a verdict that disagrees with the report contents', () => {
    // The envelope type has no `verdict` field at all, so an engine claim
    // cannot even reach the report. This asserts the resulting value is the
    // one the CONTRACT's rule implies for these contents.
    const report = adaptRunReport(runEnvelope({ proven: [PROVEN] }))
    expect(report.verdict).toBe('incompatible')
  })

  it('echoes the target version id back so a caller can detect a dropped parameter', () => {
    const report = adaptRunReport(runEnvelope({ targetVersionId: 'ver_asked_for' }))
    expect(report.targetVersionId).toBe('ver_asked_for')
  })
})

// ===========================================================================
// §5. Idempotence — an engine that gains a third band is not double-counted
// ===========================================================================

describe('§5 lifting yields to engine-authored findings', () => {
  it('does not duplicate a finding the engine already emitted for the same reasonKey', () => {
    const coverage = fullCoverage({
      unassessed: [{ dimension: 'tools', reason: 'target_dimension_absent' }],
    })
    const lifted = liftUnassessedToIndeterminate(coverage)
    expect(lifted).toHaveLength(1)

    // Feed the lifted finding back in as if the engine had authored it.
    const again = liftUnassessedToIndeterminate(coverage, lifted)
    expect(again).toHaveLength(0)
  })

  it('never lifts `target_config_missing` — that is a whole-analysis non-answer, not a gap', () => {
    // It is handled by the service layer as `status: 'unanalysable'`. Burying
    // a total non-answer inside a list of partial ones would hide it.
    const lifted = liftUnassessedToIndeterminate(
      fullCoverage({ unassessed: [{ dimension: 'tools', reason: 'target_config_missing' }] }),
    )
    expect(lifted).toHaveLength(0)
  })
})

// ===========================================================================
// §6. Fleet — a first page is never the fleet answer
// ===========================================================================

describe('§6 a bounded fleet batch never presents itself as a population answer', () => {
  it('carries a remaining cursor onto the window, making the scan incomplete', () => {
    const report = adaptFleetReport(fleetEnvelope({ nextCursor: 'page_2' }))

    // Carried as its own field rather than squashed into `scanTruncated`:
    // "stopped at the row ceiling" and "there is a next page" call for
    // different affordances, and the contract folds the cursor into
    // completeness itself.
    expect(report.window.nextCursor).toBe('page_2')
    expect(report.window.scanTruncated).toBe(false)
    expect(isFleetDivergenceAnalysisComplete(report)).toBe(false)
    expect(report.verdict).toBe('indeterminate')
  })

  it('reports remaining pages as a distinct question, phrased as a lower bound', () => {
    const report = adaptFleetReport(fleetEnvelope({ nextCursor: 'page_2' }))
    const f = report.indeterminateReasons.find(
      (r) => r.reasonKey === 'recorded_history_incomplete:pages_remain',
    )

    expect(f).toBeDefined()
    expect(f!.exemplar.unknownBecause).toMatch(/LOWER BOUND/i)
    expect(f!.exemplar.undecidedQuestion).toMatch(/^Whether /)
  })

  it('reports runs the budget never reached as their own question, not as clean', () => {
    const report = adaptFleetReport(fleetEnvelope({ runsSkippedForBudget: 7 }))

    // Kept DISTINCT from `runsUnassessable`: visited-and-unreadable and
    // never-reached are different facts calling for different actions.
    expect(report.window.runsSkippedForBudget).toBe(7)
    expect(report.window.runsUnassessable).toBe(0)
    expect(isFleetDivergenceAnalysisComplete(report)).toBe(false)
    expect(report.verdict).toBe('indeterminate')

    const f = report.indeterminateReasons.find((r) => r.kind === 'engine_limit')
    expect(f?.affectedRunCount).toBe(7)
    expect(f?.exemplar.unknownBecause).toMatch(/not runs that passed/i)
    // And it is actionable.
    expect(f?.exemplar.remedy).toMatch(/continue the scan/i)
  })

  it('every lifted question carries a remedy, so the band is actionable', () => {
    const run = adaptRunReport(
      runEnvelope({
        coverage: fullCoverage({
          unassessed: [{ dimension: 'tools', reason: 'target_dimension_absent' }],
        }),
      }),
    )
    expect(run.indeterminate.every((f) => (f.remedy ?? '').length > 0)).toBe(true)

    const fleet = adaptFleetReport(fleetEnvelope({ nextCursor: 'p2', runsSkippedForBudget: 3 }))
    expect(fleet.indeterminateReasons.every((r) => (r.exemplar.remedy ?? '').length > 0)).toBe(true)
  })

  it('NEVER certifies a version on zero analysed runs', () => {
    // Regression, found adversarially. Without the guard this folds to
    // `proven: 0, speculative: 0, complete: true` and the contract's rule
    // correctly returns `compatible` — a GREEN LIGHT DERIVED FROM ZERO RUNS.
    // The rule is not wrong; the input is. Reachable in ordinary operation
    // whenever a version's runs have aged out of the retention window.
    const report = adaptFleetReport(
      fleetEnvelope({
        window: {
          runsScanned: 0,
          runsAnalyzed: 0,
          runsUnassessable: 0,
          runsSkippedForBudget: 0,
          scanTruncated: false,
        },
      }),
    )

    expect(report.verdict).toBe('indeterminate')
    const f = report.indeterminateReasons.find(
      (r) => r.reasonKey === 'engine_limit:no_runs_analysed',
    )
    expect(f).toBeDefined()
    expect(f!.exemplar.unknownBecause).toMatch(/absence of evidence, not evidence of safety/i)
    expect(f!.exemplar.remedy).toMatch(/retention window/i)
  })

  it('NEVER certifies when runs were visited but none analysed', () => {
    const report = adaptFleetReport(
      fleetEnvelope({
        window: {
          runsScanned: 25,
          runsAnalyzed: 0,
          runsUnassessable: 0,
          runsSkippedForBudget: 0,
          scanTruncated: false,
        },
      }),
    )
    expect(report.verdict).toBe('indeterminate')
    expect(
      report.indeterminateReasons.some((r) => r.reasonKey === 'engine_limit:no_runs_analysed'),
    ).toBe(true)
  })

  it('a complete final page with nothing found IS compatible', () => {
    const report = adaptFleetReport(fleetEnvelope())
    expect(report.indeterminateReasons).toHaveLength(0)
    expect(report.verdict).toBe('compatible')
  })

  it('keeps runsWithProvenDivergence separate from any reason count', () => {
    // One run can break for several reasons, so the two numbers are unrelated
    // and the contract never sums them.
    const report = adaptFleetReport(
      fleetEnvelope({
        runsWithProvenDivergence: 218,
        provenReasons: [
          {
            reasonKey: 'tool_removed:search_web',
            kind: 'tool_removed',
            certainty: 'proven',
            affectedRunCount: 200,
            representativeRunIds: ['r1'],
            exemplar: PROVEN,
          },
          {
            reasonKey: 'tool_removed:read_file',
            kind: 'tool_removed',
            certainty: 'proven',
            affectedRunCount: 100,
            representativeRunIds: ['r2'],
            exemplar: { ...PROVEN, reasonKey: 'tool_removed:read_file' },
          },
        ],
      }),
    )

    expect(report.runsWithProvenDivergence).toBe(218)
    // 200 + 100 = 300 != 218, and that is CORRECT — runs overlap between reasons.
    const sum = report.provenReasons.reduce((n, r) => n + r.affectedRunCount, 0)
    expect(sum).not.toBe(report.runsWithProvenDivergence)
    // And there is no field that presents the sum as an answer.
    expect('totalAffectedRuns' in report).toBe(false)
  })
})
