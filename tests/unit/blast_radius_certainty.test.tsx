/**
 * @vitest-environment jsdom
 *
 * blast_radius_certainty.test.tsx — the rendered proof that the three certainty
 * bands are unmistakable WITHOUT COLOUR, and that the three non-answers are
 * three distinct answers.
 *
 * ===========================================================================
 * WHY THIS FILE IS THE DELIVERABLE, NOT A FORMALITY
 * ===========================================================================
 *
 * An operator who reads a speculative finding as proven will ship a breaking
 * change; one who reads "could not check" as "nothing found" will do the same.
 * Both destroy trust in the feature permanently.
 *
 * The design decision was to carry the distinction structurally rather than
 * chromatically — but "we used a structural cue" is a claim, and an untested
 * claim about accessibility is how the coloured-badge version ships anyway six
 * months later.
 *
 * So §1 RENDERS ALL THREE BANDS, STRIPS EVERY CLASS AND STYLE ATTRIBUTE FROM
 * THE TREE, and asserts they remain distinguishable. With no classes there is
 * no colour, no border style, no fill and no glyph styling — nothing survives
 * but text and DOM structure. If the bands are still distinguishable under that
 * amputation they are distinguishable to a screen-reader user, in greyscale, in
 * forced-colors mode, and to anyone with any colour vision deficiency, because
 * every one of those readers has strictly MORE information than this test does.
 *
 * §2–7 verify the redundant channels and the state separations individually, so
 * a regression that removes one is caught by name rather than only in aggregate.
 *
 * WHAT THIS FILE DOES NOT COVER: real composited pixels. jsdom parses no
 * Tailwind stylesheet and runs no layout, so nothing here measures rendered
 * colour — which is precisely why the load-bearing assertion is designed to need
 * no colour information at all.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'


import { BlastRadiusView } from '../../apps/web/src/components/divergence/BlastRadiusView.js'
import { CertaintyMarker } from '../../apps/web/src/components/divergence/CertaintyMarker.js'
import { CoveragePanel } from '../../apps/web/src/components/divergence/CoveragePanel.js'
import {
  DivergenceErrorResult,
  UnanalysableResult,
  VerdictBanner,
} from '../../apps/web/src/components/divergence/DivergenceStates.js'
import {
  IndeterminateReasonTable,
  ProvenReasonTable,
  SpeculativeReasonTable,
} from '../../apps/web/src/components/divergence/ReasonTables.js'
import { RunDivergenceView } from '../../apps/web/src/components/divergence/RunDivergenceView.js'

import type {
  DivergenceReport,
  IndeterminateDivergenceReason,
  ProvenDivergenceReason,
  SpeculativeDivergenceReason,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Removes every `class`, `style`, `data-certainty` and `title` attribute from a
 * tree, leaving only text and element structure.
 *
 * This is the amputation §1 depends on. `class` and `style` carry all colour,
 * border style and fill. `data-certainty` and `title` go too, so the test cannot
 * pass on a hook only an automated reader would ever see — the surviving
 * distinction must be in content a HUMAN reads.
 */
function stripPresentation(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    node.removeAttribute('class')
    node.removeAttribute('style')
    node.removeAttribute('data-certainty')
    node.removeAttribute('title')
  }
  return clone
}

function textOf(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function classesIn(el: HTMLElement): Set<string> {
  const out = new Set<string>()
  for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
    for (const c of Array.from(node.classList)) out.add(c)
  }
  return out
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROVEN_REASON: ProvenDivergenceReason = {
  reasonKey: 'tool_removed:search_web',
  kind: 'tool_removed',
  certainty: 'proven',
  affectedRunCount: 218,
  representativeRunIds: ['run_a', 'run_b'],
  exemplar: {
    certainty: 'proven',
    kind: 'tool_removed',
    dimension: 'tools',
    reasonKey: 'tool_removed:search_web',
    provenClaim: 'called tool `search_web` at sequence 14; target declares no such tool.',
    provenBy: [
      {
        citedEvent: { sequenceNumber: 14, eventId: 'evt_14', eventType: 'tool.call' },
        targetConfigPath: 'tools[].name',
        recordedValue: 'search_web',
        targetValue: null,
      },
    ],
  },
}

const SPECULATIVE_REASON: SpeculativeDivergenceReason = {
  reasonKey: 'system_prompt_changed:systemPrompt',
  kind: 'system_prompt_changed',
  certainty: 'speculative',
  affectedRunCount: 122,
  representativeRunIds: ['run_c'],
  exemplar: {
    certainty: 'speculative',
    kind: 'system_prompt_changed',
    dimension: 'system_prompt',
    reasonKey: 'system_prompt_changed:systemPrompt',
    speculativeConcern: 'system prompt changed; tool selection may differ.',
    speculativeBecause:
      'nothing recorded can establish how a different prompt would have been followed.',
    changedConfigPath: 'systemPrompt',
  },
}

const INDETERMINATE_REASON: IndeterminateDivergenceReason = {
  reasonKey: 'target_config_unreadable:tools',
  kind: 'target_config_unreadable',
  certainty: 'indeterminate',
  affectedRunCount: 300,
  representativeRunIds: [],
  exemplar: {
    certainty: 'indeterminate',
    kind: 'target_config_unreadable',
    dimension: 'tools',
    reasonKey: 'target_config_unreadable:tools',
    undecidedQuestion: 'Whether the tool calls in these runs target tools this version declares.',
    unknownBecause: "The target's `tools` key is a string, not an array.",
    remedy: 'Re-publish this version with a structured `tools` declaration.',
  },
}

function fleetReport(over: Partial<Parameters<typeof BlastRadiusView>[0]['report']> = {}) {
  return {
    agentId: 'agent_1',
    targetVersionId: 'ver_1',
    analyzedAt: 0,
    verdict: 'incompatible' as const,
    provenReasons: [PROVEN_REASON],
    speculativeReasons: [SPECULATIVE_REASON],
    indeterminateReasons: [INDETERMINATE_REASON],
    runsWithProvenDivergence: 218,
    window: {
      runsScanned: 400,
      runsAnalyzed: 400,
      runsUnassessable: 0,
      runsSkippedForBudget: 0,
      scanTruncated: false,
    },
    ...over,
  }
}

function runReport(over: Partial<DivergenceReport> = {}): DivergenceReport {
  return {
    runId: 'run_1',
    baselineVersionId: 'ver_0',
    targetVersionId: 'ver_1',
    analyzedAt: 0,
    verdict: 'incompatible',
    proven: [PROVEN_REASON.exemplar],
    speculative: [SPECULATIVE_REASON.exemplar],
    indeterminate: [INDETERMINATE_REASON.exemplar],
    coverage: {
      assessed: ['tools', 'model'],
      unassessed: [{ dimension: 'system_prompt', reason: 'target_dimension_absent' }],
      eventsExamined: 40,
      eventHistoryComplete: true,
    },
    ...over,
  }
}

function renderFleet(over = {}) {
  return render(
    <BlastRadiusView
      report={fleetReport(over)}
      baselineVersionLabel="1.0.0"
      targetVersionLabel="2.0.0"
      nextCursor={null}
      continueHrefBase="/agents/agent_1/blast-radius?baseline=ver_0&target=ver_1"
    />,
  )
}

// ===========================================================================
// §1. THE CENTRAL CLAIM
// ===========================================================================

describe('§1 the three bands are distinguishable with NO colour, NO style, NO classes', () => {
  it('the three markers differ in TEXT alone once every class and style is stripped', () => {
    const trees = (['proven', 'speculative', 'indeterminate'] as const).map((c) =>
      stripPresentation(render(<CertaintyMarker certainty={c} />).container),
    )

    // Nothing presentational survives the amputation.
    for (const t of trees) expect(classesIn(t).size).toBe(0)

    const texts = trees.map(textOf)

    // Three distinct texts — the difference is a WORD, not a hue.
    expect(new Set(texts).size).toBe(3)
    expect(texts[0]).toContain('PROVEN')
    expect(texts[1]).toContain('UNPROVEN')
    expect(texts[2]).toContain('UNKNOWN')

    // And each states its full epistemic claim, in a different grammatical mood.
    expect(texts[0]).toMatch(/could not have happened/i)
    expect(texts[1]).toMatch(/not evidence of a break/i)
    expect(texts[2]).toMatch(/neither a finding nor the absence of one/i)
  })

  it('the three fleet tables differ in text alone, including their column headers', () => {
    const proven = textOf(
      stripPresentation(
        render(<ProvenReasonTable reasons={[PROVEN_REASON]} targetVersionId="v" />).container,
      ),
    )
    const speculative = textOf(
      stripPresentation(
        render(<SpeculativeReasonTable reasons={[SPECULATIVE_REASON]} targetVersionId="v" />)
          .container,
      ),
    )
    const indeterminate = textOf(
      stripPresentation(
        render(<IndeterminateReasonTable reasons={[INDETERMINATE_REASON]} targetVersionId="v" />)
          .container,
      ),
    )

    expect(proven).toContain('PROVEN')
    expect(speculative).toContain('UNPROVEN')
    expect(indeterminate).toContain('UNKNOWN')

    // THE COLUMN HEADERS DIFFER — the cue a scanning reader gets before reading
    // any row. A proven table cites an event; a speculative one cannot, so it
    // cites a config path; an indeterminate one cites the obstacle.
    expect(proven).toContain('Evidence')
    expect(proven).not.toContain('Config change')
    expect(proven).not.toContain('Blocked by')

    expect(speculative).toContain('Config change')
    expect(speculative).not.toContain('Evidence')

    expect(indeterminate).toContain('Blocked by')
    expect(indeterminate).not.toContain('Evidence')
  })

  it('the three captions state three different epistemic positions, in text', () => {
    const text = textOf(stripPresentation(renderFleet().container))

    expect(text).toMatch(/proven by a recorded event/i)
    expect(text).toMatch(/may alter behaviour — or may change nothing at all/i)
    expect(text).toMatch(/could not be answered from what is recorded/i)
    expect(text).toMatch(/no result on this page is a clean bill of health/i)
  })
})

// ===========================================================================
// §2. Separate landmarks
// ===========================================================================

describe('§2 the three bands occupy separate, separately-labelled regions', () => {
  it('renders three regions with distinct accessible names', () => {
    renderFleet()

    const names = [/could not have happened/i, /may behave differently/i, /could not be checked/i]
    const regions = names.map((n) => screen.getByRole('region', { name: n }))
    expect(new Set(regions).size).toBe(3)
  })

  it('each region contains only its own band marker', () => {
    renderFleet()

    // `UNPROVEN` contains `PROVEN` as a substring, so this must read the marker
    // elements rather than raw text.
    const markersIn = (el: HTMLElement) =>
      new Set(
        Array.from(el.querySelectorAll('[data-certainty]')).map((n) =>
          n.getAttribute('data-certainty'),
        ),
      )

    expect(markersIn(screen.getByRole('region', { name: /could not have happened/i }))).toEqual(
      new Set(['proven']),
    )
    expect(markersIn(screen.getByRole('region', { name: /may behave differently/i }))).toEqual(
      new Set(['speculative']),
    )
    expect(markersIn(screen.getByRole('region', { name: /could not be checked/i }))).toEqual(
      new Set(['indeterminate']),
    )
  })
})

// ===========================================================================
// §3. Counts are three, never one
// ===========================================================================

describe('§3 the headline never sums the bands', () => {
  it('reports each band separately and never their sum', () => {
    const text = textOf(stripPresentation(renderFleet().container))

    expect(text).toContain('218') // runs with a proven break
    expect(text).toContain('400') // runs scanned — the real scope

    // 218 + 122 = 340, the laundered "affected runs" figure. It must not exist.
    expect(text).not.toContain('340')
    // 218 + 122 + 300 = 640, the worse version of the same lie.
    expect(text).not.toContain('640')
  })

  it('leads each tile with the DISTINCT REASON count, not the run count', () => {
    const { container } = renderFleet()
    // One reason per band in the fixture, against 218/122/300 affected runs —
    // so the metric values are the small numbers, and the run counts are prose.
    const metrics = Array.from(container.querySelectorAll('.tabular-nums'))
      .map((n) => n.textContent?.trim())
      .filter((t) => t === '1')
    expect(metrics.length).toBeGreaterThanOrEqual(3)
  })
})

// ===========================================================================
// §4. Three non-answers are three distinct answers
// ===========================================================================

describe('§4 clean, unanalysable and failed never share a treatment', () => {
  it('a compatible verdict is marked shippable and carries the replay-limit caveat', () => {
    const { container } = render(<VerdictBanner verdict="compatible" scope="This run." />)
    const text = textOf(container)

    expect(container.querySelector('[data-shippable="true"]')).toBeTruthy()
    expect(text).toContain('COMPATIBLE')
    // The framing that matters most when the news is GOOD: a clean report says
    // the target would not have BROKEN, never that it would BEHAVE the same.
    expect(container.querySelector('[data-testid="divergence-clean-limit"]')).toBeTruthy()
    expect(text).toMatch(/would not have BROKEN on recorded history/)
    expect(text).toMatch(/does not say it would BEHAVE the same/)
    expect(text).toMatch(/added tools, widened schemas and prompt changes are invisible/i)
  })

  it('an indeterminate verdict is NOT shippable and says so is not a green light', () => {
    const { container } = render(<VerdictBanner verdict="indeterminate" scope="This run." />)
    const text = textOf(container)

    expect(container.querySelector('[data-shippable="false"]')).toBeTruthy()
    expect(text).toContain('INDETERMINATE')
    expect(text).toMatch(/did not finish looking/i)
    expect(text).toMatch(/not a green light/i)
    // It must never borrow the clean state's reassurance.
    expect(container.querySelector('[data-testid="divergence-clean-limit"]')).toBeNull()
  })

  it('the unanalysable state says outright it is NOT a finding of "no divergences"', () => {
    const { container } = render(
      <UnanalysableResult
        why="The target version has no configuration snapshot recorded."
        remedy="Record a configuration snapshot when creating the version."
      />,
    )
    const text = textOf(container)

    expect(container.querySelector('[data-testid="divergence-unanalysable"]')).toBeTruthy()
    expect(container.querySelector('[data-shippable="false"]')).toBeTruthy()
    expect(text).toContain('CANNOT ANALYSE')
    expect(text).toMatch(/not a finding of .no divergences./i)
    expect(text).not.toContain('COMPATIBLE')
    // It is actionable.
    expect(text).toMatch(/Record a configuration snapshot/i)
  })

  it('the error state is distinct from both, and from a verdict', () => {
    const { container } = render(<DivergenceErrorResult message="The query failed." />)
    const text = textOf(container)

    expect(container.querySelector('[data-testid="divergence-error"]')).toBeTruthy()
    expect(text).toContain('ANALYSIS FAILED')
    expect(text).not.toContain('CANNOT ANALYSE')
    expect(text).not.toContain('COMPATIBLE')
  })

  it('the three remain distinguishable with all presentation stripped', () => {
    const clean = render(<VerdictBanner verdict="compatible" scope="This run." />).container
    const unanalysable = render(<UnanalysableResult why="w" remedy="r" />).container
    const error = render(<DivergenceErrorResult message="m" />).container

    const ids = [clean, unanalysable, error].map((c) =>
      c.querySelector('[data-testid]')?.getAttribute('data-testid'),
    )
    expect(new Set(ids).size).toBe(3)

    const texts = [clean, unanalysable, error].map((c) => textOf(stripPresentation(c)))
    expect(new Set(texts).size).toBe(3)
  })
})

// ===========================================================================
// §5. Coverage — a zero-finding report without it is the false clean
// ===========================================================================

describe('§5 coverage is always rendered, and every gap states its remedy', () => {
  it('renders on a COMPLETE analysis too — this is where an unrendered figure does its damage', () => {
    const { container } = render(
      <CoveragePanel
        coverage={{
          assessed: ['tools', 'model', 'system_prompt', 'budgets', 'decoding_params', 'capabilities'],
          unassessed: [],
          eventsExamined: 120,
          eventHistoryComplete: true,
        }}
      />,
    )
    expect(container.querySelector('[data-coverage-complete="true"]')).toBeTruthy()
    expect(textOf(container)).toMatch(/nothing was found, not that nothing was looked for/i)
  })

  it('names each unchecked dimension, why, and what to do about it', () => {
    const { container } = render(
      <CoveragePanel
        coverage={{
          assessed: ['model'],
          unassessed: [
            { dimension: 'tools', reason: 'unsupported_config_shape' },
            { dimension: 'budgets', reason: 'engine_limit' },
          ],
          eventsExamined: 40,
          eventHistoryComplete: true,
        }}
      />,
    )
    const text = textOf(container)

    expect(container.querySelector('[data-coverage-complete="false"]')).toBeTruthy()
    expect(text).toMatch(/not evidence that it is safe/i)
    // Human labels, never wire enums, and two DIFFERENT remedies.
    expect(text).toContain('tool set')
    expect(text).toContain('budgets')
    expect(text).not.toContain('decoding_params')
    expect(text).toMatch(/correct the shape/i)
    expect(text).toMatch(/scale limit, not a data problem/i)
  })

  it('the run view renders coverage unconditionally', () => {
    const { container } = render(
      <RunDivergenceView report={runReport()} targetVersionLabel="2.0.0" />,
    )
    expect(container.querySelector('[data-testid="divergence-coverage"]')).toBeTruthy()
  })
})

// ===========================================================================
// §6. Single-run view
// ===========================================================================

describe('§6 the single-run view leads with the first proven break', () => {
  it('names the earliest cited event as the break point', () => {
    const { container } = render(
      <RunDivergenceView report={runReport()} targetVersionLabel="2.0.0" />,
    )
    const text = textOf(container)

    expect(text).toMatch(/trajectory breaks at event 14/i)
    expect(text).toMatch(/Every event after this point is counterfactual/i)
  })

  it('links a proven finding to the event that proves it', () => {
    render(<RunDivergenceView report={runReport()} targetVersionLabel="2.0.0" />)
    const link = screen.getByRole('link', { name: /event 14/i })
    expect(link.getAttribute('href')).toBe('/runs/run_1/events?seq=14')
  })

  it('gives the unproven and unknown findings no event link — there is none to give', () => {
    render(<RunDivergenceView report={runReport()} targetVersionLabel="2.0.0" />)

    for (const name of [/may behave differently/i, /could not be checked/i]) {
      const region = screen.getByRole('region', { name })
      expect(within(region).queryAllByRole('link')).toHaveLength(0)
    }
  })

  it('shows no break verdict when nothing is proven', () => {
    const { container } = render(
      <RunDivergenceView
        report={runReport({ proven: [], verdict: 'indeterminate' })}
        targetVersionLabel="2.0.0"
      />,
    )
    expect(textOf(container)).not.toMatch(/trajectory breaks at event/i)
  })

  it('renders the remedy on an unknown finding, so the band is actionable', () => {
    const { container } = render(
      <RunDivergenceView report={runReport()} targetVersionLabel="2.0.0" />,
    )
    expect(textOf(container)).toMatch(/To make this answerable: Re-publish this version/i)
  })
})

// ===========================================================================
// §7. Scan completeness and keyboard navigation
// ===========================================================================

describe('§7 a bounded fleet batch offers to continue rather than claiming an answer', () => {
  it('states a lower bound and offers the next batch when pages remain', () => {
    const { container } = render(
      <BlastRadiusView
        report={fleetReport({
          verdict: 'indeterminate',
          window: {
            runsScanned: 25,
            runsAnalyzed: 25,
            runsUnassessable: 0,
            runsSkippedForBudget: 0,
            scanTruncated: false,
            nextCursor: 'page_2',
          },
        })}
        baselineVersionLabel="1.0.0"
        targetVersionLabel="2.0.0"
        nextCursor="page_2"
        continueHrefBase="/agents/agent_1/blast-radius?baseline=ver_0&target=ver_1"
      />,
    )

    expect(container.querySelector('[data-testid="divergence-continue-scan"]')).toBeTruthy()
    expect(textOf(container)).toMatch(/lower bound until the walk finishes/i)

    const link = screen.getByRole('link', { name: /scan the next batch/i })
    expect(link.getAttribute('href')).toBe(
      '/agents/agent_1/blast-radius?baseline=ver_0&target=ver_1&cursor=page_2',
    )
  })

  it('offers no continue affordance when the scan is finished', () => {
    const { container } = renderFleet()
    expect(container.querySelector('[data-testid="divergence-continue-scan"]')).toBeNull()
  })

  it('states the population caveat whenever the scan is incomplete', () => {
    const { container } = render(
      <BlastRadiusView
        report={fleetReport({
          window: {
            runsScanned: 25,
            runsAnalyzed: 20,
            runsUnassessable: 0,
            runsSkippedForBudget: 5,
            scanTruncated: false,
          },
        })}
        baselineVersionLabel="1.0.0"
        targetVersionLabel="2.0.0"
        nextCursor={null}
        continueHrefBase="/x"
      />,
    )
    expect(textOf(container)).toMatch(/LOWER BOUND/)
  })
})

describe('§7b reason drill-down is keyboard-operable without JavaScript', () => {
  it('uses native <details>/<summary> disclosure', () => {
    const { container } = render(
      <ProvenReasonTable reasons={[PROVEN_REASON]} targetVersionId="ver_1" />,
    )
    const details = container.querySelector('details')
    expect(details).toBeTruthy()
    expect(details?.querySelector('summary')).toBeTruthy()
  })

  it('exposes representative runs with stable, shareable hrefs', () => {
    render(<ProvenReasonTable reasons={[PROVEN_REASON]} targetVersionId="ver_1" />)
    const link = screen.getByRole('link', { name: 'run_a' })
    expect(link.getAttribute('href')).toBe('/runs/run_a/divergence?target=ver_1')
  })

  it('says when the representative run list is a sample of a larger set', () => {
    const { container } = render(
      <ProvenReasonTable reasons={[PROVEN_REASON]} targetVersionId="ver_1" />,
    )
    expect(textOf(container)).toMatch(/Showing 2 of 218 affected runs/i)
  })

  it('explains rather than fabricating runs for a scan-level reason', () => {
    const { container } = render(
      <IndeterminateReasonTable reasons={[INDETERMINATE_REASON]} targetVersionId="ver_1" />,
    )
    expect(textOf(container)).toMatch(/property of the scan itself/i)
  })
})
