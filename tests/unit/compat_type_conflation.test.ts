/**
 * THE TYPE SYSTEM IS THE FEATURE — this file is the proof.
 *
 * `packages/contracts/src/divergence.ts` claims it is IMPOSSIBLE to conflate a
 * PROVABLE divergence ("the run called a tool the target does not have — it
 * could not have done this") with a SPECULATIVE one ("the system prompt
 * changed, so behaviour may differ"). That claim is worth exactly as much as
 * the evidence behind it, and the only honest evidence for a compile-time
 * guarantee is code that DOES NOT COMPILE.
 *
 * ---------------------------------------------------------------------------
 * HOW TO READ THIS FILE — `@ts-expect-error` IS THE ASSERTION
 * ---------------------------------------------------------------------------
 *
 * A test file that simply failed to compile would take the whole repo's
 * `pnpm typecheck` down with it, so the negative cases are written under
 * `@ts-expect-error`, which inverts the check and is SELF-VERIFYING IN BOTH
 * DIRECTIONS:
 *
 *   - if the line below it errors (the conflation is illegal), the directive
 *     is satisfied and typecheck passes — the guarantee holds;
 *   - if the line below it ever STOPS erroring (someone adds a shared
 *     `message` field, relaxes a discriminant, loosens `provenBy`), TypeScript
 *     reports "Unused '@ts-expect-error' directive" AS AN ERROR ON THIS FILE,
 *     and `pnpm typecheck` goes red.
 *
 * So the guarantee cannot be weakened without this file failing. That is a
 * stronger property than any runtime assertion could give: no test needs to
 * remember to run, and no consumer needs to remember to check a severity enum.
 * These are checked by `pnpm --filter @agent-flight-recorder/tests typecheck`
 * (tests/tsconfig.json includes every .ts file in the package), which
 * `pnpm typecheck` runs from the repo root.
 *
 * The `it()` blocks below carry the runtime half — the verdict rules — plus a
 * documentation assertion per compile-time case, so a reader of the test
 * REPORT sees what was proven, not just a file that quietly compiled.
 */
import {
  computeDivergenceVerdict,
  divergenceReportVerdict,
  fleetDivergenceVerdict,
  isDivergenceAnalysisComplete,
  isDivergenceCoverageComplete,
  isFleetDivergenceAnalysisComplete,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  DivergenceReport,
  FleetDivergenceReport,
  IndeterminateDivergence,
  ProvenDivergence,
  SpeculativeDivergence,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// The three findings, each valid on its own. These compile — the positive
// control that the negative cases below fail for the RIGHT reason (a real
// incompatibility) rather than because the fixtures were malformed.
// ---------------------------------------------------------------------------

const proven: ProvenDivergence = {
  certainty: 'proven',
  kind: 'tool_removed',
  dimension: 'tools',
  reasonKey: 'tool_removed:search_web',
  provenClaim: 'called tool `search_web` at sequence 42; target declares no such tool',
  provenBy: [
    {
      citedEvent: { sequenceNumber: 42, eventId: 'evt_42', eventType: 'tool.call' },
      targetConfigPath: 'tools[].name',
      recordedValue: 'search_web',
      targetValue: null,
    },
  ],
}

const speculative: SpeculativeDivergence = {
  certainty: 'speculative',
  kind: 'system_prompt_changed',
  dimension: 'system_prompt',
  reasonKey: 'system_prompt_changed',
  speculativeConcern: 'system prompt changed; tool selection may differ',
  speculativeBecause: "a prompt's effect on behaviour is not derivable from a recorded history",
  changedConfigPath: 'systemPrompt',
}

const indeterminate: IndeterminateDivergence = {
  certainty: 'indeterminate',
  kind: 'target_config_unreadable',
  reasonKey: 'target_config_unreadable:tools',
  undecidedQuestion: 'whether the tool calls at sequences 12, 19 target tools this version still declares',
  unknownBecause: "the target's `tools` key is a string, not an array",
  dimension: 'tools',
}

// ---------------------------------------------------------------------------
// CASE 1 — the two finding types are mutually unassignable, in BOTH directions
// ---------------------------------------------------------------------------

// A speculative finding cannot be held as proof. This is the catastrophic
// direction: it is how "the prompt changed" gets rendered as "this run could
// not have happened".
// @ts-expect-error — SpeculativeDivergence is not assignable to ProvenDivergence
const notProof: ProvenDivergence = speculative

// And proof cannot be filed as speculation — the quieter failure, but the one
// that lets a real, checkable breakage be dismissed as a maybe.
// @ts-expect-error — ProvenDivergence is not assignable to SpeculativeDivergence
const notSpeculation: SpeculativeDivergence = proven

// The third band is assignable to neither. "We could not check" is not a
// weaker proof and it is not a stronger guess.
// @ts-expect-error — IndeterminateDivergence is not assignable to ProvenDivergence
const notProof2: ProvenDivergence = indeterminate
// @ts-expect-error — IndeterminateDivergence is not assignable to SpeculativeDivergence
const notSpeculation2: SpeculativeDivergence = indeterminate

// ---------------------------------------------------------------------------
// CASE 2 — a gate that takes proof cannot be handed speculation
//
// This is the realistic shape of the accident: not a variable assignment, but
// a CI gate or a Slack formatter that was written for proof and gets called
// with whatever the report happened to contain.
// ---------------------------------------------------------------------------

function blockDeployOn(findings: readonly ProvenDivergence[]): boolean {
  return findings.length > 0
}

// @ts-expect-error — an array of speculative findings cannot reach a proof-only gate
const wrongGate = blockDeployOn([speculative])
// @ts-expect-error — nor can unanswered questions
const wrongGate2 = blockDeployOn([indeterminate])

// ---------------------------------------------------------------------------
// CASE 3 — there is NO shared message field to render them through
//
// The one-liner that flattens everything (`findings.map(f => f.message)`) is
// the most likely way speculation reaches a page that reads as evidence. It
// cannot be written, because the two types name their text differently on
// purpose and neither name exists on the union.
// ---------------------------------------------------------------------------

function flattenNaively(finding: ProvenDivergence | SpeculativeDivergence): string {
  // @ts-expect-error — `provenClaim` does not exist on the speculative half of this union
  return finding.provenClaim
}

function flattenNaively2(finding: ProvenDivergence | SpeculativeDivergence): string {
  // @ts-expect-error — and there is no shared `message`/`summary` to fall back to
  return finding.message
}

// The deliberate version is legal, and must stay legal — the point is not to
// forbid handling both, it is to force the handler to SAY which it has.
function flattenDeliberately(finding: ProvenDivergence | SpeculativeDivergence): string {
  return finding.certainty === 'proven' ? finding.provenClaim : finding.speculativeConcern
}

// ---------------------------------------------------------------------------
// CASE 4 — proof must carry its proof
//
// A "proven" finding with nothing behind it is speculation wearing the wrong
// badge. `provenBy` is a non-empty tuple type, so the empty case is a compile
// error rather than a runtime convention nobody enforces.
// ---------------------------------------------------------------------------

const proofless: ProvenDivergence = {
  certainty: 'proven',
  kind: 'tool_removed',
  dimension: 'tools',
  reasonKey: 'tool_removed:search_web',
  provenClaim: 'trust me',
  // @ts-expect-error — provenBy is [DivergenceProof, ...DivergenceProof[]]; an empty array is not a proof
  provenBy: [],
}

// ---------------------------------------------------------------------------
// CASE 5 — the report's own arrays cannot be crossed
//
// The wire-level version of this is re-checked at runtime by FlightReader
// (a JSON body is not typechecked by us); this is the half that protects
// everything built ON TOP of a report inside our own code.
// ---------------------------------------------------------------------------

const report: DivergenceReport = {
  runId: 'run_1',
  baselineVersionId: 'ver_old',
  targetVersionId: 'ver_new',
  analyzedAt: 1_700_000_000_000,
  verdict: 'incompatible',
  proven: [proven],
  speculative: [speculative],
  indeterminate: [],
  coverage: {
    assessed: ['tools', 'model', 'system_prompt', 'budgets', 'decoding_params', 'capabilities'],
    unassessed: [],
    eventsExamined: 120,
    eventHistoryComplete: true,
  },
}

// Never invoked — the assertions are the compile errors inside it, and the
// runtime `report` fixture below must stay unmutated for the suite that reads
// it. Typechecking a function body does not require calling it.
function crossTheStreams(): void {
  // @ts-expect-error — a speculative finding cannot be pushed into `proven`
  report.proven.push(speculative)
  // @ts-expect-error — nor an unanswered question
  report.proven.push(indeterminate)
  // @ts-expect-error — and the reverse crossing is equally illegal
  report.speculative.push(proven)
}

// ---------------------------------------------------------------------------
// Runtime half: the verdict rules, which are what a gate actually reads.
// ---------------------------------------------------------------------------

describe('proven/speculative conflation is a COMPILE error (see @ts-expect-error cases above)', () => {
  it('documents what this file proves at compile time', () => {
    // These values exist only so the compile-time cases above are not dead
    // code to the linter. The assertion that matters already happened: this
    // file typechecking AT ALL means every `@ts-expect-error` above found a
    // real error, and any weakening of the contract turns each unused
    // directive into a typecheck failure.
    expect([notProof, notSpeculation, notProof2, notSpeculation2, proofless]).toHaveLength(5)
    expect([wrongGate, wrongGate2]).toHaveLength(2)
    expect(typeof flattenNaively).toBe('function')
    expect(typeof flattenNaively2).toBe('function')
    expect(typeof crossTheStreams).toBe('function')
    expect(flattenDeliberately(proven)).toContain('declares no such tool')
    expect(flattenDeliberately(speculative)).toContain('may differ')
  })

  it('keeps the two kinds in separate arrays, with no union to flatten them through', () => {
    expect(report.proven.every((f) => f.certainty === 'proven')).toBe(true)
    expect(report.speculative.every((f) => f.certainty === 'speculative')).toBe(true)
    // Every proven finding cites at least one recorded event. Guaranteed by
    // the tuple type; asserted here because it is the property an operator
    // relies on when they click through from a claim to the event log.
    for (const finding of report.proven) {
      expect(finding.provenBy.length).toBeGreaterThan(0)
      expect(finding.provenBy[0].citedEvent.sequenceNumber).toBeGreaterThan(0)
    }
  })
})

describe('computeDivergenceVerdict — the single rule every surface states', () => {
  it('a PROOF outranks incomplete coverage: proven findings are never downgraded to indeterminate', () => {
    expect(computeDivergenceVerdict({ provenCount: 1, speculativeCount: 0, complete: false })).toBe('incompatible')
    expect(computeDivergenceVerdict({ provenCount: 1, speculativeCount: 9, complete: true })).toBe('incompatible')
  })

  it('an incomplete analysis with nothing proven is INDETERMINATE, never compatible', () => {
    expect(computeDivergenceVerdict({ provenCount: 0, speculativeCount: 0, complete: false })).toBe('indeterminate')
    // Speculative findings do not rescue an incomplete analysis into a
    // "caveats" verdict — that would read as "we checked and it is fine, ish".
    expect(computeDivergenceVerdict({ provenCount: 0, speculativeCount: 3, complete: false })).toBe('indeterminate')
  })

  it('only a COMPLETE analysis with nothing proven can say compatible', () => {
    expect(computeDivergenceVerdict({ provenCount: 0, speculativeCount: 0, complete: true })).toBe('compatible')
    expect(computeDivergenceVerdict({ provenCount: 0, speculativeCount: 2, complete: true })).toBe(
      'compatible_with_caveats'
    )
  })
})

describe('completeness folds BOTH ways of not having looked', () => {
  it('an unassessed dimension makes the analysis incomplete', () => {
    const partial: DivergenceReport = {
      ...report,
      proven: [],
      speculative: [],
      coverage: {
        assessed: ['model'],
        unassessed: [{ dimension: 'tools', reason: 'unsupported_config_shape' }],
        eventsExamined: 120,
        eventHistoryComplete: true,
      },
    }
    expect(isDivergenceCoverageComplete(partial.coverage)).toBe(false)
    expect(isDivergenceAnalysisComplete(partial)).toBe(false)
    expect(divergenceReportVerdict(partial)).toBe('indeterminate')
  })

  it('a truncated event history makes the analysis incomplete even with every dimension assessed', () => {
    const truncated: DivergenceReport = {
      ...report,
      proven: [],
      speculative: [],
      coverage: { ...report.coverage, eventHistoryComplete: false },
    }
    expect(isDivergenceAnalysisComplete(truncated)).toBe(false)
    expect(divergenceReportVerdict(truncated)).toBe('indeterminate')
  })

  it('an UNANSWERED QUESTION makes the analysis incomplete even under full coverage', () => {
    // The reason the third band exists: with only two buckets this finding
    // would have been filed as speculative, and a full-coverage report with
    // only speculative findings reads `compatible_with_caveats` — a false
    // clean produced by an engine that could not read the tool list.
    const unanswered: DivergenceReport = { ...report, proven: [], speculative: [], indeterminate: [indeterminate] }
    expect(isDivergenceCoverageComplete(unanswered.coverage)).toBe(true)
    expect(isDivergenceAnalysisComplete(unanswered)).toBe(false)
    expect(divergenceReportVerdict(unanswered)).toBe('indeterminate')
  })

  it('a clean, complete report says compatible', () => {
    const clean: DivergenceReport = { ...report, proven: [], speculative: [], indeterminate: [] }
    expect(divergenceReportVerdict(clean)).toBe('compatible')
  })
})

describe('fleet reports follow the same rules, one level up', () => {
  const fleet: FleetDivergenceReport = {
    agentId: 'ag_1',
    targetVersionId: 'ver_new',
    analyzedAt: 1_700_000_000_000,
    verdict: 'compatible',
    provenReasons: [],
    speculativeReasons: [],
    indeterminateReasons: [],
    runsWithProvenDivergence: 0,
    window: { runsScanned: 512, runsAnalyzed: 512, runsUnassessable: 0, runsSkippedForBudget: 0, scanTruncated: false },
  }

  it('a truncated scan can never read as clean', () => {
    const truncated: FleetDivergenceReport = { ...fleet, window: { ...fleet.window, scanTruncated: true } }
    expect(isFleetDivergenceAnalysisComplete(truncated)).toBe(false)
    expect(fleetDivergenceVerdict(truncated)).toBe('indeterminate')
  })

  it('runs that could not be analysed are not runs that passed', () => {
    const skipped: FleetDivergenceReport = {
      ...fleet,
      window: { ...fleet.window, runsAnalyzed: 500, runsUnassessable: 12 },
    }
    expect(fleetDivergenceVerdict(skipped)).toBe('indeterminate')
  })

  it('a whole scan with no reasons says compatible', () => {
    expect(fleetDivergenceVerdict(fleet)).toBe('compatible')
  })

  it('groups by DISTINCT REASON, so the headline is causes and not incident count', () => {
    const withReasons: FleetDivergenceReport = {
      ...fleet,
      verdict: 'incompatible',
      provenReasons: [
        {
          reasonKey: 'tool_removed:search_web',
          kind: 'tool_removed',
          certainty: 'proven',
          affectedRunCount: 211,
          representativeRunIds: ['run_a', 'run_b'],
          exemplar: proven,
        },
      ],
      runsWithProvenDivergence: 340,
    }
    // One reason, 340 affected runs: the number an engineer acts on is 1.
    expect(withReasons.provenReasons).toHaveLength(1)
    expect(withReasons.runsWithProvenDivergence).toBe(340)
    expect(fleetDivergenceVerdict(withReasons)).toBe('incompatible')
  })
})
