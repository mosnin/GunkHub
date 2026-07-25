/**
 * @vitest-environment jsdom
 *
 * fleet_ui_correlation.test.tsx — the rendered proof that an OBSERVED
 * CORRELATION, a HYPOTHESISED CAUSE and an UNANSWERED QUESTION cannot be
 * confused; that the non-answers are separate answers; that findings are
 * ranked by breadth rather than recency; and that an UNMEASURED base rate
 * never renders like a discriminating one.
 *
 * ===========================================================================
 * WHY THIS FILE IS THE DELIVERABLE
 * ===========================================================================
 *
 * Someone reading the fleet page under incident pressure acts on the
 * strongest-looking thing on screen. A hypothesis that reads as a finding gets
 * that person rolling back the wrong dependency at 3am. "We carried the
 * distinction structurally" is a claim, and an untested claim about a visual
 * distinction is how the three-coloured-badges version ships anyway six months
 * later.
 *
 * So §1 RENDERS ALL THREE BANDS, STRIPS EVERY `class`, `style`, `title` AND
 * `data-*` ATTRIBUTE FROM THE TREE, and asserts they remain distinguishable.
 * With no classes there is no colour, no border style, no fill and no glyph
 * styling; with no `data-*` or `title` there is no hook only a machine would
 * read. Nothing survives but text and DOM structure. If the bands are still
 * distinguishable under that amputation they are distinguishable to a screen
 * reader user, in greyscale, in a screenshot pasted into a channel, in
 * forced-colors mode, and to anyone with any colour vision deficiency —
 * because every one of those readers has strictly MORE information than this
 * test does.
 *
 * §2 is the one this iteration needed most and the previous one did not have:
 * `FleetShareMeasurement.unaffectedSharing` is `number | null`, `null` MEANS
 * NOT MEASURED, and `0` means "we checked the healthy agents and none share
 * this" — the strongest possible support. Rendering those two the same way
 * inverts the meaning of the field on exactly the screen where the inversion
 * is most expensive.
 *
 * §3–8 check each channel and state separation by name, so a regression that
 * removes one is reported specifically rather than only in aggregate.
 *
 * WHAT THIS FILE DOES NOT COVER: real composited pixels. jsdom parses no
 * Tailwind stylesheet and runs no layout, so nothing here measures rendered
 * colour — which is exactly why the load-bearing assertion is designed to need
 * no colour information at all.
 */
import {
  fleetReportIncoherences,
  hypothesisQuestion,
  isCorrelationSelfConsistent,
  isFleetHealthScanComplete,
  rankFleetCorrelations,
} from '@agent-flight-recorder/contracts'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type {
  AgentHealthEntry,
  FailurePattern,
  FailurePatternDetail,
  FleetHealthReport,
  FleetHealthScan,
  FleetShareMeasurement,
  HypothesisedCause,
  ObservedCorrelation,
  UnansweredFleetQuestion,
} from '@agent-flight-recorder/contracts'

import {
  HypothesisMarker,
  ObservedMarker,
  UnansweredMarker,
} from '@/components/fleet/EvidenceMarker'
import { FleetIncidentView } from '@/components/fleet/FleetIncidentView'
import { FleetRoster } from '@/components/fleet/FleetRoster'
import {
  FleetScanFailed,
  HealthyResult,
  IncompleteScanBanner,
  IndeterminateResult,
  IsolatedFailuresResult,
} from '@/components/fleet/FleetStates'
import { HypothesisList } from '@/components/fleet/HypothesisList'
import { ObservationSpanCell } from '@/components/fleet/ObservationSpan'
import { ObservedCorrelationTable } from '@/components/fleet/ObservedCorrelationTable'
import { UnansweredList } from '@/components/fleet/UnansweredList'
import { buildInterimFleetReport } from '@/lib/fleet/adapt'
import { resolveFleetWindow } from '@/lib/fleet/window'



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Removes every `class`, `style`, `title` and `data-*` attribute from a tree,
 * leaving only text and element structure.
 *
 * This is the amputation §1 depends on. `class` and `style` carry all colour,
 * border style and fill. `title` and `data-*` go too, so the test cannot pass
 * on a hook only an automated reader would ever see — the surviving
 * distinction must be in content a HUMAN reads.
 */
function stripPresentation(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    node.removeAttribute('class')
    node.removeAttribute('style')
    node.removeAttribute('title')
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('data-')) node.removeAttribute(attr.name)
    }
  }
  return clone
}

/**
 * Find one element, FAILING WITH A DIAGNOSIS rather than throwing a TypeError.
 *
 * `container.querySelector('summary')!` reads as harmless in a test, and it is
 * precisely the mistake §2b of this file exists to record: an assertion that
 * the thing the type promises is really there. When the element is missing —
 * because a component stopped rendering it, which is exactly the regression
 * these tests exist to catch — `!` produces `Cannot read properties of null`
 * pointing at a line, and the reader has to reconstruct which behaviour broke.
 * An explicit expectation names it.
 *
 * The rule is the one `@/lib/fleet/safe` states for the product code: never
 * assert a value the wire (here, the DOM) may not have delivered. A test that
 * crashes and a test that fails are not the same signal, and only one of them
 * says what regressed.
 */
function must<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const el = root.querySelector<E>(selector)
  expect(el, `expected to find \`${selector}\`, but nothing rendered it`).not.toBeNull()
  return el as E
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

const T0 = Date.UTC(2026, 6, 25, 14, 3)
const NOW = Date.UTC(2026, 6, 25, 15, 0)

function scan(over: Partial<FleetHealthScan> = {}): FleetHealthScan {
  return {
    since: NOW - 2 * 60 * 60_000,
    until: NOW,
    burstWindowMs: 60 * 60_000,
    correlationBasis: 'whole_roster',
    agentsInRoster: 64,
    agentsAssessed: 64,
    agentsUnassessable: 0,
    agentsSkippedForBudget: 0,
    occurrencesScanned: 900,
    scanTruncated: false,
    baseRatesMeasured: true,
    ...over,
  }
}

/** 9 agents — the BROAD one, and the OLDEST last observation of the three. */
const BROAD: ObservedCorrelation = {
  certainty: 'observed',
  kind: 'shared_failure_fingerprint',
  correlationKey: 'shared_fingerprint:9f3c',
  observedFact:
    '9 agents recorded failures matching fingerprint 9f3c between 14:03:11 and 14:31:40.',
  agentIds: ['ag_1', 'ag_2', 'ag_3', 'ag_4', 'ag_5', 'ag_6', 'ag_7', 'ag_8', 'ag_9'],
  agentCount: 9,
  firstObservedAt: T0,
  lastObservedAt: T0 + 1_800_000,
  observedBy: [
    {
      cites: 'failure_occurrence',
      agentId: 'ag_1',
      runId: 'run_aaa',
      fingerprintHash: '9f3c',
      occurredAt: T0 + 1_000,
    },
  ],
}

/** 3 agents but the MOST RECENT. Under a recency sort this would lead. */
const RECENT: ObservedCorrelation = {
  certainty: 'observed',
  kind: 'temporal_burst',
  correlationKey: 'burst:1721908800000',
  observedFact: '3 agents began failing between 14:55:02 and 14:59:10.',
  agentIds: ['ag_20', 'ag_21', 'ag_22'],
  agentCount: 3,
  firstObservedAt: NOW - 300_000,
  lastObservedAt: NOW,
  observedBy: [
    {
      cites: 'failure_occurrence',
      agentId: 'ag_20',
      runId: 'run_ccc',
      fingerprintHash: 'aa11',
      occurredAt: NOW - 200_000,
    },
  ],
}

/** 2 agents, oldest, and the one that cites a DECLARATION rather than a run. */
const NARROW: ObservedCorrelation = {
  certainty: 'observed',
  kind: 'shared_declared_attribute',
  correlationKey: 'shared_attr:model',
  observedFact: '2 agents declare the same model at model.models[].',
  agentIds: ['ag_30', 'ag_31'],
  agentCount: 2,
  firstObservedAt: T0 - 3_600_000,
  lastObservedAt: T0,
  observedBy: [
    {
      cites: 'declared_attribute',
      agentId: 'ag_30',
      agentVersionId: 'ver_30',
      declaredConfigPath: 'model.models[]',
      declaredValue: 'm-4',
    },
  ],
}

function measurement(over: Partial<FleetShareMeasurement> = {}): FleetShareMeasurement {
  return {
    affectedSharing: 9,
    affectedTotal: 9,
    unaffectedSharing: 2,
    unaffectedTotal: 51,
    measurementTruncated: false,
    ...over,
  }
}

function hypothesis(over: Partial<HypothesisedCause> = {}): HypothesisedCause {
  return {
    certainty: 'hypothesis',
    kind: 'shared_model',
    hypothesisKey: 'shared_model:m-4',
    // A VALUE, not a sentence. The headline is composed by
    // `hypothesisQuestion` (contracts 0.18.0) — the engine has no field in
    // which to write an accusation.
    sharedValue: 'm-4',
    restingOn: ['shared_fingerprint:9f3c'],
    notEstablishedBecause:
      'Nothing recorded distinguishes a degrading model from nine agents hitting the same bad input.',
    sharedBy: measurement(),
    wouldBeTestedBy: 'Roll ag_3 onto model `m-3` and watch whether its failures stop.',
    attributeConfigPath: 'model.models[]',
    ...over,
  }
}

const QUESTION: UnansweredFleetQuestion = {
  certainty: 'unanswered',
  kind: 'roster_incomplete',
  questionKey: 'roster:ceiling',
  undecidedQuestion: 'whether the 40 agents after the roster ceiling also failed in this window',
  unknownBecause: 'The roster ceiling (200) was reached.',
  remedy: 'Re-run with a higher roster limit.',
}

const ROSTER: AgentHealthEntry[] = [
  {
    agentId: 'ag_1',
    agentName: 'checkout-agent',
    state: 'failing',
    runsObserved: 120,
    runsFailed: 88,
    distinctFingerprints: 2,
    observationTruncated: false,
  },
  {
    agentId: 'ag_50',
    agentName: 'nightly-agent',
    state: 'unobserved',
    runsObserved: 0,
    runsFailed: 0,
    distinctFingerprints: 0,
    observationTruncated: false,
  },
  {
    agentId: 'ag_60',
    agentName: 'report-agent',
    state: 'healthy',
    runsObserved: 40,
    runsFailed: 0,
    distinctFingerprints: 0,
    observationTruncated: true,
  },
]

function report(over: Partial<FleetHealthReport> = {}): FleetHealthReport {
  return {
    analyzedAt: NOW,
    verdict: 'correlated_failures',
    roster: ROSTER,
    correlations: [RECENT, NARROW, BROAD],
    hypotheses: [hypothesis()],
    unanswered: [QUESTION],
    agentsFailing: 12,
    scan: scan(),
    ...over,
  }
}

function renderView(over: Partial<FleetHealthReport> = {}) {
  return render(
    <FleetIncidentView
      report={report(over)}
      widenHref="/fleet?window=6h"
      widenLabel="last 6 hours"
      narrowHref="/fleet?window=30m"
      narrowLabel="last 30 minutes"
    />,
  )
}

// ===========================================================================
// §1. THE CENTRAL CLAIM
// ===========================================================================

describe('§1 the three bands are distinguishable with NO colour, NO style, NO classes, NO data-attributes', () => {
  it('the three markers differ in TEXT alone once all presentation is stripped', () => {
    const trees = [<ObservedMarker />, <HypothesisMarker />, <UnansweredMarker />].map((el) =>
      stripPresentation(render(el).container),
    )

    // Nothing presentational survives the amputation.
    for (const t of trees) expect(classesIn(t).size).toBe(0)

    const [a, b, c] = trees.map(textOf)
    expect(new Set([a, b, c]).size).toBe(3)

    // The difference is a WORD, not a hue — and no word is a substring of
    // another, so a text assertion cannot silently pass on the wrong band.
    // (The previous surface used PROVEN/UNPROVEN, where it can.)
    expect(a).toContain('OBSERVED')
    expect(a).not.toContain('HYPOTHESIS')
    expect(a).not.toContain('UNANSWERED')
    expect(b).toContain('HYPOTHESIS')
    expect(b).not.toContain('OBSERVED')
    expect(b).not.toContain('UNANSWERED')
    expect(c).toContain('UNANSWERED')
    expect(c).not.toContain('OBSERVED')
    expect(c).not.toContain('HYPOTHESIS')

    // Each states its full epistemic claim, in a different grammatical mood.
    expect(a).toMatch(/a fact about what happened, and it says nothing about why/i)
    expect(b).toMatch(/a question to test, not a finding to act on/i)
    expect(c).toMatch(/neither a finding nor the absence of one/i)
  })

  it('the three bands differ in text alone, including their field labels', () => {
    const observed = textOf(
      stripPresentation(
        render(<ObservedCorrelationTable items={[BROAD]} scan={scan()} />).container,
      ),
    )
    const hyp = textOf(
      stripPresentation(
        render(<HypothesisList items={[hypothesis()]} observedFacts={new Map()} />).container,
      ),
    )
    const unans = textOf(
      stripPresentation(render(<UnansweredList items={[QUESTION]} />).container),
    )

    expect(new Set([observed, hyp, unans]).size).toBe(3)

    // THE FIELD LABELS DIFFER — the cue a scanning reader gets before reading
    // any content. An observation is tabulated and cited; a hypothesis is
    // questioned, measured against a denominator and given a test; an
    // unanswered question names its obstacle and its remedy.
    expect(observed).toContain('What was recorded')
    expect(observed).toContain('Observed in')
    expect(observed).not.toContain('Would be tested by')
    expect(observed).not.toContain('What blocked it')

    expect(hyp).toContain('Would be tested by')
    expect(hyp).toContain('Why this is not established')
    expect(hyp).toContain('Shared by')
    expect(hyp).toContain('Rests on these observations')
    expect(hyp).not.toContain('Observed in')
    expect(hyp).not.toContain('What blocked it')

    expect(unans).toContain('What blocked it')
    expect(unans).toContain('To make this answerable')
    expect(unans).not.toContain('Observed in')
    expect(unans).not.toContain('Would be tested by')
  })

  it('the bands are different ELEMENT TYPES: a grid of rows vs lists of prose', () => {
    const observed = render(
      <ObservedCorrelationTable items={[BROAD]} scan={scan()} />,
    ).container
    const hyp = render(
      <HypothesisList items={[hypothesis()]} observedFacts={new Map()} />,
    ).container
    const unans = render(<UnansweredList items={[QUESTION]} />).container

    // Observations are disclosure rows and carry no definition list.
    expect(observed.querySelectorAll('details').length).toBeGreaterThan(0)
    expect(observed.querySelectorAll('dl').length).toBe(0)

    // The other two are lists of definition lists, with no disclosure at all —
    // distinguishable from DOM shape alone, with no text read.
    for (const c of [hyp, unans]) {
      expect(c.querySelectorAll('details').length).toBe(0)
      expect(c.querySelectorAll('dl').length).toBeGreaterThan(0)
    }
  })

  it('the section captions state three different epistemic positions, in text', () => {
    const text = textOf(stripPresentation(renderView().container))

    expect(text).toMatch(/Each row is a recorded fact/i)
    expect(text).toMatch(/None of it says why/i)
    expect(text).toMatch(/Nothing below is a finding/i)
    expect(text).toMatch(/Test before acting/i)
    expect(text).toMatch(/Neither findings nor the absence of findings/i)
    expect(text).toMatch(/nothing on this page is a clean bill of health/i)
  })
})

// ===========================================================================
// §2. THE DENOMINATOR — an unmeasured base rate is not a weak finding
// ===========================================================================

describe('§2 `null` base rate never renders like a measured one', () => {
  const textFor = (m: Partial<FleetShareMeasurement>) =>
    textOf(
      stripPresentation(
        render(
          <HypothesisList
            items={[hypothesis({ sharedBy: measurement(m) })]}
            observedFacts={new Map()}
          />,
        ).container,
      ),
    )

  it('a discriminating measurement shows BOTH populations', () => {
    const t = textFor({ unaffectedSharing: 2, unaffectedTotal: 51 })
    expect(t).toContain('9 of 9 FAILING agents')
    expect(t).toContain('2 of 51 HEALTHY agents')
    expect(t).toContain('MORE COMMON AMONG THE FAILING')
  })

  it('a non-discriminating measurement says the attribute explains nothing', () => {
    const t = textFor({ unaffectedSharing: 49, unaffectedTotal: 51 })
    // The "all 12 failing agents use m-4" sentence, defused by its denominator.
    expect(t).toContain('49 of 51 HEALTHY agents')
    expect(t).toContain('JUST AS COMMON AMONG THE HEALTHY')
    expect(t).toMatch(/does not distinguish them, so it explains nothing on its own/i)
    expect(t).not.toContain('MORE COMMON AMONG THE FAILING')
  })

  it('an UNMEASURED base rate says there is no denominator, and claims nothing', () => {
    const t = textFor({ unaffectedSharing: null, unaffectedTotal: null })
    expect(t).toContain('healthy agents NOT CHECKED')
    expect(t).toContain('BASE RATE NOT MEASURED')
    expect(t).toMatch(/cannot support or weaken the hypothesis/i)
    // It must borrow neither of the measured verdicts' language.
    expect(t).not.toContain('MORE COMMON AMONG THE FAILING')
    expect(t).not.toContain('JUST AS COMMON AMONG THE HEALTHY')
  })

  it('`null` and `0` are rendered as OPPOSITE things, never the same thing', () => {
    // 0 is the STRONGEST possible support: we checked the healthy agents and
    // none of them share it. `null` is no information at all. If these two ever
    // render alike, the field's meaning is inverted on the screen where the
    // inversion costs most.
    const zero = textFor({ unaffectedSharing: 0, unaffectedTotal: 51 })
    const unmeasured = textFor({ unaffectedSharing: null, unaffectedTotal: null })

    expect(zero).not.toBe(unmeasured)
    expect(zero).toContain('0 of 51 HEALTHY agents')
    expect(zero).toContain('MORE COMMON AMONG THE FAILING')
    expect(zero).not.toContain('NOT CHECKED')
    expect(unmeasured).not.toContain('0 of')
  })

  it('a truncated measurement is reported as unsound however favourable it looks', () => {
    const t = textFor({ unaffectedSharing: 0, unaffectedTotal: 51, measurementTruncated: true })
    expect(t).toContain('BASE RATE NOT MEASURED')
    expect(t).toMatch(/both numbers are floors and the comparison is not sound/i)
  })
})


// ===========================================================================
// §2b. THE BUG FAMILY: a check for `null` is not a check for USABILITY
// ===========================================================================

describe('§2b malformed share measurements degrade, and never crash or promote', () => {
  const renderWith = (m: unknown) =>
    render(
      <HypothesisList
        items={[hypothesis({ sharedBy: m as FleetShareMeasurement })]}
        observedFacts={new Map()}
      />,
    ).container

  // Each of these passes a `!== null` guard. Each previously reached a branch
  // it must never reach: `undefined` threw on `.toLocaleString()`, the strings
  // and the NaN produced a discrimination VERDICT from unvalidated wire data,
  // and the dropped flag compared floors as if they were totals.
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['absent fields', { affectedSharing: 9, affectedTotal: 9, measurementTruncated: false }],
    [
      'string counts',
      {
        affectedSharing: '9',
        affectedTotal: '9',
        unaffectedSharing: '0',
        unaffectedTotal: '188',
        measurementTruncated: false,
      },
    ],
    [
      'NaN base rate',
      {
        affectedSharing: 9,
        affectedTotal: 9,
        unaffectedSharing: Number.NaN,
        unaffectedTotal: 51,
        measurementTruncated: false,
      },
    ],
    [
      'dropped truncation flag',
      { affectedSharing: 9, affectedTotal: 9, unaffectedSharing: 0, unaffectedTotal: 51 },
    ],
    [
      'numerator exceeding its denominator',
      {
        affectedSharing: 9,
        affectedTotal: 9,
        unaffectedSharing: 60,
        unaffectedTotal: 51,
        measurementTruncated: false,
      },
    ],
    ['not an object at all', null],
  ]

  for (const [name, m] of malformed) {
    it(`renders — and does not throw — on ${name}`, () => {
      // The crash is the headline defect: a malformed hypothesis must not take
      // down the one screen whose purpose is to be readable during an outage.
      expect(() => renderWith(m)).not.toThrow()
    })

    it(`reports ${name} as BASE RATE NOT MEASURED, never as a verdict`, () => {
      const t = textOf(stripPresentation(renderWith(m)))
      expect(t).toContain('BASE RATE NOT MEASURED')
      // Neither claim about the healthy population may be manufactured from
      // data that could not be read. Two of these previously promoted the
      // hypothesis to `discriminating` — i.e. to the top of what is read first.
      expect(t).not.toContain('MORE COMMON AMONG THE FAILING')
      expect(t).not.toContain('JUST AS COMMON AMONG THE HEALTHY')
    })
  }

  it('degrades toward the WEAKER claim: an unusable count renders `—`, never `0`', () => {
    // `0` is a strong claim ("we checked and none share it"). `—` is no claim.
    // Malformed data must only ever make this screen say LESS.
    const t = textOf(renderWith({ affectedSharing: Number.NaN, affectedTotal: 9 }))
    expect(t).toContain('—')
    expect(t).not.toMatch(/\b0 of\b/)
  })

  it('a WELL-FORMED measurement still reaches the contract’s own verdict', () => {
    // The gate must not swallow the good case — otherwise the band is uniformly
    // useless and nobody notices the guard is over-firing.
    const t = textOf(renderWith(measurement({ unaffectedSharing: 0, unaffectedTotal: 51 })))
    expect(t).toContain('MORE COMMON AMONG THE FAILING')
    expect(t).not.toContain('BASE RATE NOT MEASURED')
  })
})

// ===========================================================================
// §2c. The headline is COMPOSED, not transmitted
// ===========================================================================

describe('§2c the hypothesis heading comes from the contract composer', () => {
  it('renders `hypothesisQuestion` verbatim, and it names the shared value', () => {
    const h = hypothesis()
    const { container } = render(<HypothesisList items={[h]} observedFacts={new Map()} />)
    expect(textOf(container)).toContain(hypothesisQuestion(h))
    expect(textOf(container)).toContain('m-4')
  })

  it('every hypothesis kind composes to a QUESTION — checked over the whole enum', () => {
    const kinds = [
      'shared_model',
      'shared_tool',
      'shared_capability',
      'shared_version_lineage',
      'coincident_in_time',
      'unattributed',
    ] as const
    for (const kind of kinds) {
      // `coincident_in_time` and `unattributed` are about NO attribute, so the
      // shared value is omitted rather than set to undefined — the contract
      // runs with exactOptionalPropertyTypes.
      const { sharedValue, ...rest } = hypothesis({ kind })
      const h: HypothesisedCause =
        kind.startsWith('shared_') && sharedValue !== undefined
          ? { ...rest, sharedValue }
          : rest
      const { container } = render(<HypothesisList items={[h]} observedFacts={new Map()} />)
      const heading = must<HTMLElement>(container, 'h3')
      expect(textOf(heading).trimEnd().endsWith('?')).toBe(true)
    }
  })
})

// ===========================================================================
// §3. A hypothesis is subordinate: no blast radius, no rank, no verdict power
// ===========================================================================

describe('§3 a hypothesis carries no blast radius and cannot move the screen’s state', () => {
  it('the contract type has no count, no span and no evidence field', () => {
    for (const forbidden of [
      'agentCount',
      'agentIds',
      'observedBy',
      'firstObservedAt',
      'lastObservedAt',
      // Removed in contracts 0.18.0. A free-prose headline is the one field no
      // amount of surrounding chrome survives at 3am.
      'candidateExplanation',
    ]) {
      expect(Object.keys(hypothesis())).not.toContain(forbidden)
    }
  })

  it('the section header says UNRANKED and carries no tally at all', () => {
    renderView()
    const region = screen.getByRole('region', { name: /might explain/i })
    const head = must<HTMLElement>(region, 'div')
    expect(textOf(head)).toMatch(/Unranked/i)
    expect(textOf(head)).not.toMatch(/\d/)
  })

  it('the observed section DOES carry its tallies — the asymmetry is the point', () => {
    renderView()
    const region = screen.getByRole('region', { name: /what was recorded/i })
    expect(textOf(region)).toMatch(/3 correlations/i)
  })

  it('hypotheses do not change the verdict banner', () => {
    // Same observations, same scan, zero hypotheses: the screen's state word is
    // identical. The contract has no slot for a hypothesis count and neither
    // does the UI.
    const withH = must(renderView().container, '[data-verdict]').getAttribute('data-verdict')
    const withoutH = must(
      renderView({ hypotheses: [] }).container,
      '[data-verdict]',
    ).getAttribute('data-verdict')
    expect(withH).toBe(withoutH)
  })

  it('a hypothesis whose observation is absent is WITHHELD, and the withholding is stated', () => {
    const { container } = renderView({
      hypotheses: [hypothesis({ restingOn: ['shared_fingerprint:does_not_exist'] })],
    })
    // An orphan renders identically to a grounded hypothesis, so it never
    // reaches the band — but it is reported rather than silently dropped.
    expect(screen.queryByRole('region', { name: /might explain/i })).toBeNull()
    expect(textOf(container)).toMatch(/names an observation this report does not contain/i)
  })
})

// ===========================================================================
// §4. Separate landmarks
// ===========================================================================

describe('§4 the three bands occupy separate, separately-named regions', () => {
  it('renders three regions with distinct accessible names', () => {
    renderView()
    const names = [/what was recorded across agents/i, /might explain them — untested/i, /could not check/i]
    const regions = names.map((n) => screen.getByRole('region', { name: n }))
    expect(new Set(regions).size).toBe(3)
  })

  it('each region contains only its own band marker', () => {
    renderView()
    const markersIn = (el: HTMLElement) =>
      new Set(
        Array.from(el.querySelectorAll('[data-band]')).map((n) => n.getAttribute('data-band')),
      )

    expect(markersIn(screen.getByRole('region', { name: /what was recorded/i }))).toEqual(
      new Set(['observed']),
    )
    expect(markersIn(screen.getByRole('region', { name: /might explain/i }))).toEqual(
      new Set(['hypothesis']),
    )
    expect(markersIn(screen.getByRole('region', { name: /could not check/i }))).toEqual(
      new Set(['unanswered']),
    )
  })
})

// ===========================================================================
// §5. Ranked by breadth, NOT recency
// ===========================================================================

describe('§5 findings are ranked by how many agents they hit', () => {
  it('the broadest correlation leads even though another is far more recent', () => {
    const ranked = rankFleetCorrelations([RECENT, NARROW, BROAD])
    expect(ranked.map((r) => r.correlationKey)).toEqual([
      'shared_fingerprint:9f3c',
      'burst:1721908800000',
      'shared_attr:model',
    ])

    // Sanity: the one that would lead under a recency sort is NOT first.
    const byRecency = [...ranked].sort((a, b) => b.lastObservedAt - a.lastObservedAt)
    expect(byRecency[0].correlationKey).toBe('burst:1721908800000')
    expect(ranked[0].correlationKey).not.toBe(byRecency[0].correlationKey)
  })

  it('the rendered order matches the ranked order and is numbered', () => {
    const { container } = renderView()
    const rows = Array.from(container.querySelectorAll('details'))
    expect(rows[0].id).toBe('observed-shared_fingerprint:9f3c')
    expect(rows[2].id).toBe('observed-shared_attr:model')

    // Explicit ordinals: "sorted by impact" is stated, not left to be inferred
    // from two adjacent numbers by a reader under stress. The rank CELL is read
    // rather than the row text, which has no word boundaries once concatenated.
    const ordinals = rows.map((d) => d.querySelector('summary')?.children[1]?.textContent ?? '')
    expect(ordinals).toEqual(['1', '2', '3'])
  })

  it('names the sort key in the column header', () => {
    const { container } = render(<ObservedCorrelationTable items={[BROAD]} scan={scan()} />)
    expect(textOf(container)).toContain('Agents ▼')
  })

  it('the headline number is `agentCount`, never the bounded id list', () => {
    // A cluster of 40 whose id list is capped at 20 must read as 40. Rendering
    // the list length would under-report exactly the biggest incidents.
    const wide: ObservedCorrelation = { ...BROAD, agentCount: 40 }
    const { container } = render(<ObservedCorrelationTable items={[wide]} scan={scan()} />)
    const summary = must<HTMLElement>(container, 'summary')
    expect(textOf(summary)).toContain('40')
    expect(textOf(container)).toMatch(/Showing 9 of 40 agents/i)
  })

  it('the RECORDED FACT leads the row, not the agent list', () => {
    const { container } = render(<ObservedCorrelationTable items={[BROAD]} scan={scan()} />)
    const summary = must<HTMLElement>(container, 'summary')
    expect(textOf(summary)).toContain('9 agents recorded failures matching fingerprint 9f3c')
    // Individual agent ids are drill-down, not headline.
    expect(textOf(summary)).not.toContain('ag_4')
  })
})

// ===========================================================================
// §6. The non-answers are separate answers
// ===========================================================================

describe('§6 healthy, isolated, indeterminate and failed never share a treatment', () => {
  const healthyEl = () =>
    render(<HealthyResult scan={scan()} widenHref="/w" widenLabel="last 6 hours" />).container
  const isolatedEl = () =>
    render(
      <IsolatedFailuresResult
        scan={scan()}
        agentsFailing={7}
        widenHref="/w"
        widenLabel="last 6 hours"
      />,
    ).container
  const indetEl = () =>
    render(
      <IndeterminateResult
        scan={scan({ scanTruncated: true, scanRowCeiling: 200, agentsSkippedForBudget: 40 })}
        continueHref="/fleet?cursor=p2"
        narrowHref="/n"
        narrowLabel="last 30 minutes"
      />,
    ).container
  const failEl = () =>
    render(<FleetScanFailed message="The query failed." retryHref="/fleet" />).container

  it('an earned all-clear is stated positively AND bounded', () => {
    const c = healthyEl()
    expect(c.querySelector('[data-testid="fleet-healthy"]')).toBeTruthy()
    const t = textOf(c)
    expect(t).toContain('NOTHING CORRELATED — AND NOTHING FAILING')
    expect(t).toMatch(/The scan finished over the whole roster/i)
    expect(t).toMatch(/This is an answer, not an absence of data/i)
    expect(t).toMatch(/covers only this window, and only failures that were recorded/i)
  })

  it('isolated failures is neither an all-clear nor an incident, and says so', () => {
    const c = isolatedEl()
    expect(c.querySelector('[data-testid="fleet-isolated-failures"]')).toBeTruthy()
    const t = textOf(c)
    expect(t).toContain('AGENTS FAILING — NOTHING CONNECTS THEM')
    expect(t).toMatch(/These are real problems\. They are not one incident/i)
    // It must not borrow the all-clear's reassurance.
    expect(t).not.toContain('NOTHING CORRELATED — AND NOTHING FAILING')
    // Nor overclaim: absence of an observed link is not evidence of independence.
    expect(t).toMatch(/Nothing here says the failures are unrelated/i)
  })

  it('an unfinished scan says outright that it is NOT a result, and names what stopped it', () => {
    const c = indetEl()
    expect(c.querySelector('[data-testid="fleet-indeterminate"]')).toBeTruthy()
    expect(c.querySelector('[data-scan-complete="false"]')).toBeTruthy()
    const t = textOf(c)
    expect(t).toContain('SCAN DID NOT FINISH — THIS IS NOT A RESULT')
    expect(t).toMatch(/not a finding that the fleet is healthy/i)
    // The specific limits, not a generic shrug.
    expect(t).toMatch(/the row ceiling \(200\) was reached/i)
    expect(t).toMatch(/40 agents were never reached/i)
    // The direction of the error is the actionable part.
    expect(t).toMatch(/LOWER BOUND/)
    expect(t).toMatch(/can only be larger, never smaller/i)
    expect(t).toMatch(/likeliest during an incident, when volume spikes/i)
    expect(t).not.toContain('NOTHING CORRELATED')
  })

  it('a failed scan is distinct from all of them, and claims nothing', () => {
    const c = failEl()
    expect(c.querySelector('[data-testid="fleet-scan-failed"]')).toBeTruthy()
    const t = textOf(c)
    expect(t).toContain('SCAN FAILED')
    expect(t).toMatch(/Do not read this as a healthy fleet/i)
    expect(t).not.toContain('SCAN DID NOT FINISH')
    expect(t).not.toContain('NOTHING CORRELATED')
  })

  it('all four remain distinguishable with every presentation attribute stripped', () => {
    const els = [healthyEl(), isolatedEl(), indetEl(), failEl()]
    const ids = els.map((c) => c.querySelector('[data-testid]')?.getAttribute('data-testid'))
    expect(new Set(ids).size).toBe(4)
    const texts = els.map((c) => textOf(stripPresentation(c)))
    expect(new Set(texts).size).toBe(4)
  })

  it('each non-answer offers a different next move', () => {
    expect(within(healthyEl()).getByRole('link', { name: /widen to/i })).toBeTruthy()
    const i = indetEl()
    expect(within(i).getByRole('link', { name: /continue the scan/i })).toBeTruthy()
    expect(within(i).getByRole('link', { name: /narrow to/i })).toBeTruthy()
    expect(within(failEl()).getByRole('link', { name: /retry the scan/i })).toBeTruthy()
  })

  it('which non-answer appears turns on the CONTRACT’s completeness rule, not list emptiness', () => {
    const empty = { correlations: [], hypotheses: [] }

    const healthy = renderView({ ...empty, agentsFailing: 0, verdict: 'healthy' }).container
    expect(healthy.querySelector('[data-testid="fleet-healthy"]')).toBeTruthy()

    const isolated = renderView({
      ...empty,
      agentsFailing: 7,
      verdict: 'isolated_failures',
    }).container
    expect(isolated.querySelector('[data-testid="fleet-isolated-failures"]')).toBeTruthy()
    expect(isolated.querySelector('[data-testid="fleet-healthy"]')).toBeNull()

    // Same empty list, but the scan did not finish. Completely different answer.
    const indet = renderView({
      ...empty,
      agentsFailing: 0,
      verdict: 'indeterminate',
      scan: scan({ scanTruncated: true }),
    }).container
    expect(indet.querySelector('[data-testid="fleet-indeterminate"]')).toBeTruthy()
    expect(indet.querySelector('[data-testid="fleet-healthy"]')).toBeNull()
  })

  it('an empty scan can never render as an all-clear', () => {
    // Nothing truncated, nothing skipped, nothing failed — and nothing
    // examined. The vacuous-completeness trap.
    const vacuous = scan({ agentsInRoster: 0, agentsAssessed: 0 })
    expect(isFleetHealthScanComplete(vacuous)).toBe(false)
    const { container } = renderView({
      correlations: [],
      hypotheses: [],
      agentsFailing: 0,
      verdict: 'indeterminate',
      scan: vacuous,
    })
    expect(container.querySelector('[data-testid="fleet-healthy"]')).toBeNull()
    expect(container.querySelector('[data-testid="fleet-indeterminate"]')).toBeTruthy()
  })

  it('a page-local correlation basis is called out as a WRONG answer, not a partial one', () => {
    const { container } = renderView({ scan: scan({ correlationBasis: 'page_local' }) })
    expect(textOf(container)).toMatch(/not a small answer, it is the wrong one/i)
  })

  it('an incomplete scan WITH findings caveats them rather than replacing them', () => {
    const { container } = renderView({ scan: scan({ scanTruncated: true }) })
    expect(container.querySelector('[data-testid="fleet-incomplete-banner"]')).toBeTruthy()
    expect(screen.getByRole('region', { name: /what was recorded/i })).toBeTruthy()
    expect(container.querySelector('[data-testid="fleet-indeterminate"]')).toBeNull()
    expect(textOf(container)).toMatch(/EVERY COUNT BELOW IS A LOWER BOUND/)
  })

  it('coverage is rendered on every outcome, including the successful one', () => {
    expect(renderView().container.querySelector('[data-testid="fleet-scan-coverage"]')).toBeTruthy()
    expect(
      renderView({ correlations: [], hypotheses: [] }).container.querySelector(
        '[data-testid="fleet-scan-coverage"]',
      ),
    ).toBeTruthy()
  })

  it('an unmeasured base rate is disclosed at scan level too', () => {
    const { container } = renderView({ scan: scan({ baseRatesMeasured: false }) })
    expect(textOf(container)).toMatch(/no hypothesis below can be ranked or ruled out/i)
  })

  it('the banner and the standalone panel are two components, not one with a flag', () => {
    const banner = render(
      <IncompleteScanBanner scan={scan({ scanTruncated: true })} />,
    ).container
    const standalone = indetEl()
    expect(textOf(banner)).not.toBe(textOf(standalone))
    expect(textOf(banner)).toContain('EVERY COUNT BELOW IS A LOWER BOUND')
    expect(textOf(standalone)).toContain('THIS IS NOT A RESULT')
  })
})

// ===========================================================================
// §7. Evidence asymmetry, and time
// ===========================================================================

describe('§7 an observation cites recorded rows; a hypothesis structurally cannot', () => {
  it('a failure-occurrence citation links to the run that records it', () => {
    render(<ObservedCorrelationTable items={[BROAD]} scan={scan()} />)
    expect(screen.getByRole('link', { name: /run_aaa/ }).getAttribute('href')).toBe('/runs/run_aaa')
  })

  it('a declared-attribute citation renders a config path and NO run link', () => {
    const { container } = render(<ObservedCorrelationTable items={[NARROW]} scan={scan()} />)
    const t = textOf(container)
    expect(t).toContain('model.models[]')
    expect(t).toContain('declared')
    expect(container.querySelector('a[href^="/runs/"]')).toBeNull()
  })

  it('the hypothesis band links only BACK to observations — never to a run', () => {
    renderView()
    const region = screen.getByRole('region', { name: /might explain/i })
    const hrefs = within(region)
      .queryAllByRole('link')
      .map((l) => l.getAttribute('href') ?? '')

    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) {
      expect(href.startsWith('#observed-')).toBe(true)
      expect(href).not.toMatch(/^\/runs\//)
    }
  })

  it('the unanswered band cites nothing at all — there is nothing recorded to cite', () => {
    renderView()
    const region = screen.getByRole('region', { name: /could not check/i })
    for (const l of within(region).queryAllByRole('link')) {
      expect(l.getAttribute('href')).not.toMatch(/^\/runs\//)
    }
  })

  it('the back-link lands on a real anchor in the findings band', () => {
    const { container } = renderView()
    expect(container.querySelector('#observed-shared_fingerprint\\:9f3c')).toBeTruthy()
  })

  it('every fixture correlation satisfies the contract’s own self-consistency check', () => {
    for (const c of [BROAD, RECENT, NARROW]) expect(isCorrelationSelfConsistent(c)).toBe(true)
  })
})

describe('§7b the observation span is drawn only from measurements', () => {
  it('states start, end and width in words, not only in a bar', () => {
    const { container } = render(<ObservationSpanCell correlation={BROAD} scan={scan()} />)
    const t = textOf(container)
    expect(t).toContain('14:03Z')
    expect(t).toContain('14:33Z')
    expect(t).toContain('ENDED')
    expect(t).toMatch(/spans/)
  })

  it('marks a cluster still producing observations as STILL RUNNING', () => {
    const { container } = render(<ObservationSpanCell correlation={RECENT} scan={scan()} />)
    const t = textOf(container)
    expect(t).toContain('STILL RUNNING')
    expect(t).not.toContain('ENDED')
  })

  it('all times are UTC-labelled, so two readers in two timezones agree', () => {
    const { container } = render(<ObservationSpanCell correlation={BROAD} scan={scan()} />)
    expect(textOf(container)).toMatch(/\d{2}:\d{2}Z/)
  })
})

// ===========================================================================
// §8. Roster, keyboard, and the interim adapter's honesty
// ===========================================================================

describe('§8 the roster never lets "not observed" read as a pass', () => {
  it('orders by concern and puts unobserved above healthy', () => {
    const { container } = render(<FleetRoster roster={ROSTER} />)
    const states = Array.from(container.querySelectorAll('[data-agent-state]')).map((n) =>
      n.getAttribute('data-agent-state'),
    )
    expect(states).toEqual(['failing', 'unobserved', 'healthy'])
  })

  it('spells out that an unobserved agent was not tested', () => {
    const { container } = render(<FleetRoster roster={ROSTER} />)
    const t = textOf(container)
    expect(t).toContain('NOT OBSERVED')
    expect(t).toMatch(/nothing was tested, so this is not a pass/i)
  })

  it('marks a truncated row’s counts as floors on the row itself', () => {
    const { container } = render(<FleetRoster roster={ROSTER} />)
    expect(textOf(container)).toMatch(/counts are floors — this agent’s scan was truncated/i)
  })
})

describe('§8b drill-down is keyboard-operable without JavaScript', () => {
  it('uses native <details>/<summary> disclosure', () => {
    const { container } = render(<ObservedCorrelationTable items={[BROAD]} scan={scan()} />)
    expect(container.querySelector('details > summary')).toBeTruthy()
  })
})

describe('§8c the interim adapter never fabricates and never silently drops', () => {
  const window = resolveFleetWindow({ window: '2h' }, NOW)

  function pattern(over: Partial<FailurePattern> = {}): FailurePattern {
    return {
      id: 'p1',
      orgId: 'org_1',
      fingerprintHash: 'fp_1',
      class: 'upstream_5xx',
      label: 'Upstream 5xx',
      salientKey: 'stripe.charges.create',
      count: 40,
      firstSeenAt: NOW - 3_600_000,
      lastSeenAt: NOW - 60_000,
      representativeRunIds: ['run_1'],
      affectedAgentVersionIds: [],
      affectedAgentIds: ['ag_1', 'ag_2', 'ag_3'],
      ...over,
    }
  }

  function detail(p: FailurePattern, occurredAt: number): FailurePatternDetail {
    return {
      pattern: p,
      recentOccurrences: [
        {
          id: 'o1',
          orgId: 'org_1',
          fingerprintHash: p.fingerprintHash,
          runId: 'run_1',
          agentId: 'ag_1',
          occurredAt,
          heuristicClass: p.class,
          salientKey: p.salientKey,
        },
      ],
      trend: [],
    }
  }

  const base = {
    window,
    burstWindowMs: 60 * 60_000,
    agentsInRoster: 10,
    listTruncated: false,
    listCeiling: 200,
    patternsNotDetailed: 0,
  }

  it('builds a self-consistent correlation from real occurrence rows', () => {
    const p = pattern()
    const r = buildInterimFleetReport({
      ...base,
      patterns: [p],
      details: new Map([[p.fingerprintHash, detail(p, NOW - 120_000)]]),
    })
    expect(r.correlations).toHaveLength(1)
    const c = r.correlations[0]
    expect(c.agentCount).toBe(3)
    // The invariant the SDK checks, satisfied by construction rather than luck.
    expect(isCorrelationSelfConsistent(c)).toBe(true)
  })

  it('drops a cluster whose occurrences fall outside its own window, and SAYS SO', () => {
    const p = pattern()
    const r = buildInterimFleetReport({
      ...base,
      patterns: [p],
      // Occurrence a week before the fingerprint's own firstSeenAt — an
      // invented citation here would break isCorrelationSelfConsistent.
      details: new Map([[p.fingerprintHash, detail(p, NOW - 7 * 24 * 3_600_000)]]),
    })
    expect(r.correlations).toHaveLength(0)
    expect(r.unanswered.some((q) => q.kind === 'occurrence_history_truncated')).toBe(true)
  })

  it('excludes single-agent failures — this surface is about the fleet', () => {
    const p = pattern({ affectedAgentIds: ['ag_1'] })
    const r = buildInterimFleetReport({
      ...base,
      patterns: [p],
      details: new Map([[p.fingerprintHash, detail(p, NOW - 120_000)]]),
    })
    expect(r.correlations).toHaveLength(0)
  })

  it('CANNOT return `healthy`, because this source cannot see health', () => {
    const r = buildInterimFleetReport({ ...base, patterns: [], details: new Map() })
    expect(isFleetHealthScanComplete(r.scan)).toBe(false)
    expect(r.verdict).toBe('indeterminate')
    // …and it says why, rather than leaving a blank.
    expect(r.unanswered.some((q) => q.kind === 'roster_incomplete')).toBe(true)
    expect(r.unanswered.some((q) => q.kind === 'base_rate_unmeasurable')).toBe(true)
  })

  it('emits an empty roster rather than guessing every agent into `unobserved`', () => {
    const r = buildInterimFleetReport({ ...base, patterns: [], details: new Map() })
    expect(r.roster).toEqual([])
  })

  it('reports the detail budget as an engine limit rather than omitting silently', () => {
    const r = buildInterimFleetReport({
      ...base,
      patterns: [],
      details: new Map(),
      patternsNotDetailed: 5,
    })
    const q = r.unanswered.find((x) => x.questionKey === 'interim:details_budget')
    // Optional chaining rather than `!`: a missing question then fails on the
    // FIELD assertion, naming what was expected of it, instead of throwing.
    expect(q, 'expected an interim:details_budget question').toBeDefined()
    expect(q?.undecidedQuestion).toContain('5')
    expect(q?.remedy).toBeTruthy()
  })

  it('its only hypothesis carries a NULL base rate — it has measured no denominator', () => {
    const a = pattern({ fingerprintHash: 'fp_a', firstSeenAt: NOW - 600_000 })
    const b = pattern({
      id: 'p2',
      fingerprintHash: 'fp_b',
      firstSeenAt: NOW - 500_000,
      affectedAgentIds: ['ag_4', 'ag_5'],
    })
    const r = buildInterimFleetReport({
      ...base,
      patterns: [a, b],
      details: new Map([
        [a.fingerprintHash, detail(a, NOW - 300_000)],
        [b.fingerprintHash, detail(b, NOW - 300_000)],
      ]),
    })
    expect(r.hypotheses).toHaveLength(1)
    const h = r.hypotheses[0]
    // NULL, never 0 — 0 would claim the healthy agents were checked and clean,
    // which is the strongest possible support and the opposite of the truth.
    expect(h.sharedBy.unaffectedSharing).toBeNull()
    expect(h.sharedBy.unaffectedTotal).toBeNull()
    // It names nothing it did not look at.
    expect(h.kind).toBe('coincident_in_time')
    expect(h.wouldBeTestedBy.length).toBeGreaterThan(0)
    expect(h.notEstablishedBecause.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// §9. correlationBasis answers a different question from scanTruncated
// ===========================================================================

describe('§9 a bounded correlation pass reports `page_local`', () => {
  const window = resolveFleetWindow({ window: '2h' }, NOW)
  const base = {
    window,
    burstWindowMs: 60 * 60_000,
    agentsInRoster: 10,
    listTruncated: false,
    listCeiling: 200,
    patternsNotDetailed: 0,
    patterns: [],
    details: new Map<string, FailurePatternDetail>(),
  }

  it('a truncated pattern listing means a cluster may have been CUT IN HALF', () => {
    // These answer different questions by the contract's design: `scanTruncated`
    // says "we stopped early", `correlationBasis` says "could a cluster have
    // been split". Hardcoding `whole_roster` meant the reader's and the CLI's
    // dedicated page-local warning could never fire — suppressed for exactly
    // the largest orgs, where clusters most often straddle a page.
    const r = buildInterimFleetReport({ ...base, listTruncated: true })
    expect(r.scan.correlationBasis).toBe('page_local')
    expect(r.scan.scanTruncated).toBe(true)
  })

  it('an exhausted DETAIL budget also splits the pass, even with a complete listing', () => {
    // The second bound, and the one a truncation flag cannot express: these
    // fingerprints were seen but never correlated.
    const r = buildInterimFleetReport({ ...base, patternsNotDetailed: 3 })
    expect(r.scan.correlationBasis).toBe('page_local')
    expect(r.scan.scanTruncated).toBe(false)
  })

  it('reports `whole_roster` only when NEITHER bound bound', () => {
    // Firing the warning unconditionally would train operators to ignore the
    // one signal that matters when it is real, and leave `whole_roster` as a
    // value the code can never produce.
    const r = buildInterimFleetReport(base)
    expect(r.scan.correlationBasis).toBe('whole_roster')
  })

  it('a page-local basis can never be complete, whatever else is true', () => {
    const r = buildInterimFleetReport({ ...base, listTruncated: true })
    expect(isFleetHealthScanComplete(r.scan)).toBe(false)
  })

  it('the reader calls a page-local basis out as a WRONG answer, not a partial one', () => {
    const { container } = renderView({ scan: scan({ correlationBasis: 'page_local' }) })
    expect(textOf(container)).toMatch(/not a small answer, it is the wrong one/i)
  })
})

// ===========================================================================
// §10. Incoherent correlations are withheld BEFORE ranking
// ===========================================================================

describe('§10 a correlation whose numbers refute each other is never ranked', () => {
  // `rankFleetCorrelations` sorts on `agentCount` first, so an unchecked
  // breadth decides what an operator reads first.
  const incoherent: ObservedCorrelation = {
    ...BROAD,
    correlationKey: 'shared_fingerprint:bad',
    agentCount: 999,
    observedFact: '999 agents recorded failures matching fingerprint bad.',
  }

  it('withholds it from the table', () => {
    const { container } = renderView({ correlations: [BROAD, incoherent] })
    expect(container.querySelector('#observed-shared_fingerprint\\:bad')).toBeNull()
    expect(container.querySelector('#observed-shared_fingerprint\\:9f3c')).toBeTruthy()
  })

  it('states the withholding and names the incoherence, rather than dropping it silently', () => {
    const { container } = renderView({ correlations: [BROAD, incoherent] })
    const el = container.querySelector('[data-testid="fleet-incoherent-withheld"]')
    expect(el).toBeTruthy()
    expect(textOf(el as HTMLElement)).toMatch(/own numbers contradict each other/i)
    expect(textOf(el as HTMLElement)).toContain('agent_count_contradicts_listed_agents')
  })

  it('the fabricated breadth never reaches the top of the list', () => {
    const { container } = renderView({ correlations: [BROAD, incoherent] })
    const first = must<HTMLElement>(container, 'details')
    expect(textOf(first)).not.toContain('999')
  })

  it('says nothing about incoherence when the report is coherent', () => {
    const { container } = renderView()
    expect(container.querySelector('[data-testid="fleet-incoherent-withheld"]')).toBeNull()
    expect(fleetReportIncoherences(report())).toHaveLength(0)
  })

  it('a SINGLE-citation correlation is legitimate and is NOT withheld', () => {
    // Silence is only evidence when the sample had room to speak. The contract
    // exempts a one-citation sample from the coverage rule deliberately, and a
    // reader that flagged it as suspect would be arguing with the contract.
    const single: ObservedCorrelation = { ...BROAD, observedBy: [BROAD.observedBy[0]] }
    expect(fleetReportIncoherences(report({ correlations: [single] }))).toHaveLength(0)
    const { container } = renderView({ correlations: [single] })
    expect(container.querySelector('[data-testid="fleet-incoherent-withheld"]')).toBeNull()
    expect(container.querySelector('#observed-shared_fingerprint\\:9f3c')).toBeTruthy()
  })
})

// ===========================================================================
// §11. Malformed collections and timestamps never blank the screen
// ===========================================================================

describe('§11 the incident panel survives a malformed report', () => {
  it('does not throw when the report’s collections are not arrays', () => {
    // Every contract helper walks these with `.flatMap`/`.filter`, so a
    // non-array throws before any of this component's own guards would run.
    const broken = {
      ...report(),
      correlations: null,
      hypotheses: undefined,
      unanswered: 'nope',
      roster: 7,
    } as unknown as FleetHealthReport
    expect(() =>
      render(
        <FleetIncidentView
          report={broken}
          widenHref="/w"
          widenLabel="w"
          narrowHref="/n"
          narrowLabel="n"
        />,
      ),
    ).not.toThrow()
  })

  it('an unreadable observation window shows NO bar and no fabricated clock', () => {
    // A NaN offset resolves to 0 in CSS, pinning the bar to the far left — a
    // confident "this started at the very beginning" built from a broken field.
    const { container } = render(
      <ObservationSpanCell
        correlation={{ ...BROAD, firstObservedAt: Number.NaN }}
        scan={scan()}
      />,
    )
    const t = textOf(container)
    expect(t).toMatch(/observation window unreadable/i)
    expect(t).not.toMatch(/\d{2}:\d{2}Z/)
    expect(t).not.toContain('STILL RUNNING')
  })

  it('unusable roster counts render `—`, never `0`', () => {
    const { container } = render(
      <FleetRoster
        roster={[{ ...ROSTER[0], runsFailed: Number.NaN, distinctFingerprints: '3' as never }]}
      />,
    )
    expect(textOf(container)).toContain('—')
  })
})
