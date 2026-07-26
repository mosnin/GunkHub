/**
 * @vitest-environment jsdom
 *
 * causal_ui_chain.test.tsx — the rendered proof that a chain which ENDS and a
 * chain whose TRAIL IS LOST cannot be confused; that the non-answers are
 * separate answers; and that nothing on this surface draws a link the data
 * does not assert.
 *
 * ===========================================================================
 * WHY THIS FILE IS THE DELIVERABLE
 * ===========================================================================
 *
 * "The recorded chain starts at run X" means the investigation is over. "We
 * lost the trail at run X" means it is unfinished — and it is the MORE COMMON
 * case, because recording is opt-in and best-effort. An operator who reads the
 * second as the first stops at the wrong place and blames the wrong agent
 * while the real cause keeps firing. Every other property of this screen is
 * downstream of that one distinction.
 *
 * "We carried it structurally" is a claim, and an untested claim about a
 * visual distinction is how the two-badges-in-different-colours version ships
 * anyway six months later. So:
 *
 * §1 RENDERS BOTH TERMINI, STRIPS EVERY `class`, `style`, `title` AND `data-*`
 * ATTRIBUTE, and asserts they remain distinguishable. With no classes there is
 * no colour, no border style, no fill, no glyph styling; with no `data-*` or
 * `title` there is no hook only a machine would read. Nothing survives but
 * text and DOM structure. If they are still distinguishable under that
 * amputation they are distinguishable to a screen-reader user, in greyscale,
 * in a screenshot pasted into an incident channel, in forced-colors mode, and
 * to anyone with any colour vision deficiency — every one of whom has strictly
 * MORE information than this test does.
 *
 * §2 checks the DOM-shape channel specifically: an origin is a RUNG INSIDE the
 * ladder's ordered list, and a lost trail is an `<aside>` AFTER it closes. A
 * regression that moved a lost trail into the list would still read as text —
 * and would put a MISSING run on a numbered rung, which is the visual claim
 * that a run is there.
 *
 * §3 is the three-way non-answer separation the brief calls load-bearing, and
 * it is checked through the CONTRACT's verdict rule rather than through list
 * emptiness.
 *
 * §4 is the "recorded, never inferred" rule, checked on LAYOUT and not only on
 * copy — a caption cannot undo a list that looks like a chain.
 *
 * §5 is the adapter, where six Convex dispositions collapse onto two contract
 * termini and exactly one of them may become an origin.
 *
 * §6 is navigation and direction.
 *
 * WHAT THIS FILE DOES NOT COVER: real composited pixels. jsdom parses no
 * Tailwind stylesheet and runs no layout, so nothing here measures rendered
 * colour — which is precisely why the load-bearing assertion is designed to
 * need no colour information at all.
 */
import {
  causalTraversalVerdict,
  isCausalTraversalComplete,
  traversalClaimContradictions,
  traversalIncoherences,
  traversalUnusableFields,
} from '@agent-flight-recorder/contracts'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type {
  CausalEventCitation,
  CausalNode,
  CausalScan,
  CausalTraversal,
  ChainTerminus,
  CycleReEntry,
  LostTrail,
  RecordedCausalEdge,
  RecordedOrigin,
  SuspectedLink,
} from '@agent-flight-recorder/contracts'

import { CausalChainView } from '@/components/causal/CausalChainView'
import { CausalLadder } from '@/components/causal/CausalLadder'
import {
  CausalWalkFailed,
  IncoherentTraversalNotice,
  NothingRecordedResult,
  WalkDidNotFinishResult,
} from '@/components/causal/CausalStates'
import {
  SuspectedLinksPanel,
  UnansweredCausalList,
} from '@/components/causal/SuspectedLinksPanel'
import {
  CycleReEntryTerminus,
  LostTrailTerminus,
  RecordedOriginTerminus,
} from '@/components/causal/Terminus'
import { auditTraversal } from '@/lib/causal/audit'
import { buildLadder } from '@/lib/causal/ladder'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Removes every `class`, `style`, `title` and `data-*` attribute from a tree,
 * leaving only text and element structure.
 *
 * This is the amputation §1 depends on. `class` and `style` carry all colour,
 * border style, fill and indentation. `title` and `data-*` go too, so the test
 * cannot pass on a hook only an automated reader would ever see — the
 * surviving distinction must live in content a HUMAN reads.
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

/** Find one element, FAILING WITH A DIAGNOSIS rather than throwing a TypeError. */
function must<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const el = root.querySelector<E>(selector)
  expect(el, `expected to find \`${selector}\`, but nothing rendered it`).not.toBeNull()
  return el as E
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 6, 25, 14, 3)

const ORIGIN: RecordedOrigin = {
  terminus: 'recorded_origin',
  originRunId: 'run_root',
  hopsToOrigin: 2,
  establishedBy: [
    {
      proves: 'adjacent_edge_set_read',
      runId: 'run_root',
      inboundReadComplete: true,
      inboundEdgesFound: 0,
      scannedAt: T0,
    },
  ],
}

const LOST: LostTrail = {
  terminus: 'trail_lost',
  lastReachedRunId: 'run_root',
  kind: 'adjacency_unconfirmed',
  hopsBeforeLoss: 2,
  lostBecause: 'The inbound edge set came back empty but the read could not be confirmed complete.',
  wouldBeRecoveredBy: 'Record the handoff into run_root at run start, then walk again.',
}

const CYCLE: CycleReEntry = {
  terminus: 'cycle_reentry',
  reEnteredRunId: 'run_mid',
  hopsToReEntry: 2,
  // NON-EMPTY BY TYPE, and closed: every consecutive pair must be a recorded
  // edge in the same traversal, which is what makes the loop checkable rather
  // than a shape the reader has to take on faith.
  cyclePath: ['run_mid', 'run_subject', 'run_mid'],
}

function edge(producer: string, consumer: string, key = `e_${producer}_${consumer}`): RecordedCausalEdge {
  return {
    basis: 'recorded',
    kind: 'spawned',
    edgeKey: key,
    producerRunId: producer,
    consumerRunId: consumer,
    recordedFact: `a spawned edge was recorded from ${producer} to ${consumer}`,
    handoffAt: T0,
    recordedBy: [
      {
        cites: 'run_field',
        recordedInRunId: consumer,
        field: 'parentRunId',
        namesRunId: producer,
        recordedAt: T0,
      },
    ],
  }
}

/**
 * An edge cited by an EVENT, with a real sequence number.
 *
 * `17`, not `0`. Event Log Rule 4 starts sequences at 1, so a `0` is a sentinel
 * written where the real position was lost — and the contract now rejects it as
 * `not_a_sequence_number` precisely because a sentinel inside the data's own
 * domain reads as a measurement.
 */
function eventEdge(producer: string, consumer: string): RecordedCausalEdge {
  return {
    basis: 'recorded',
    kind: 'output_consumed',
    edgeKey: `ev_${producer}_${consumer}`,
    producerRunId: producer,
    consumerRunId: consumer,
    recordedFact: `${consumer} recorded reading the output of ${producer}`,
    handoffAt: T0,
    recordedBy: [
      {
        cites: 'event',
        recordedInRunId: consumer,
        eventId: 'evt_9f3c',
        sequenceNumber: 17,
        eventType: 'run.input',
        namesRunId: producer,
        recordedAt: T0,
      },
    ],
  }
}

/**
 * An edge cited by an ARTIFACT, with the digest AND the role.
 *
 * `role` is what carries the direction: a shared hash has no direction, a
 * recorded read does. Both are required by the contract, and neither can be
 * fabricated — which is why the earlier adapter, which had access to neither,
 * could not build one of these at all.
 */
function artifactEdge(producer: string, consumer: string): RecordedCausalEdge {
  return {
    basis: 'recorded',
    kind: 'artifact_handoff',
    edgeKey: `art_${producer}_${consumer}`,
    producerRunId: producer,
    consumerRunId: consumer,
    recordedFact: `${consumer} recorded reading artifact 4f2a written by ${producer}`,
    handoffAt: T0,
    recordedBy: [
      {
        cites: 'artifact',
        recordedInRunId: consumer,
        artifactId: 'art_4f2a',
        sha256: '9c31aa77bb0142ef9c31aa77bb0142ef9c31aa77bb0142ef9c31aa77bb0142ef',
        role: 'consumed',
        recordedAt: T0,
      },
    ],
  }
}

function node(runId: string, hops: number, adjacency: CausalNode['adjacency']): CausalNode {
  return { runId, agentId: 'ag_1', status: 'failed', startedAt: T0, hopsFromSubject: hops, adjacency }
}

function scan(over: Partial<CausalScan> = {}): CausalScan {
  return {
    subjectRunId: 'run_subject',
    direction: 'component',
    maxDepthRequested: 8,
    deepestReached: 2,
    runsVisited: 4,
    edgesRead: 3,
    scanTruncated: false,
    edgeSetsComplete: true,
    ...over,
  }
}

function traversal(over: Partial<CausalTraversal> = {}): CausalTraversal {
  return {
    analyzedAt: T0,
    subjectRunId: 'run_subject',
    verdict: 'chain_recorded',
    nodes: [
      node('run_subject', 0, 'edge_recorded'),
      node('run_mid', 1, 'edge_recorded'),
      node('run_root', 2, 'no_edge_recorded'),
      node('run_kid', 1, 'adjacency_unread'),
    ],
    edges: [edge('run_root', 'run_mid'), edge('run_mid', 'run_subject'), edge('run_subject', 'run_kid')],
    termini: [ORIGIN],
    suspected: [],
    unanswered: [],
    scan: scan(),
    ...over,
  }
}

/**
 * The DOWNSTREAM half.
 *
 * A separate traversal, because the two directions are walked separately —
 * `origin_has_no_adjacent_edge` is audited against `scan.direction`, and under
 * a single `component` walk any edge on a run contradicts an origin claim
 * about it, which would make `ENDS AT RECORDED ORIGIN` unreachable for every
 * run that is actually on a chain. See `@/lib/services/causal`.
 */
function downTraversal(over: Partial<CausalTraversal> = {}): CausalTraversal {
  return traversal({
    scan: scan({ direction: 'downstream' }),
    termini: [{ ...LOST, lastReachedRunId: 'run_kid', kind: 'depth_limit_reached' }],
    ...over,
  })
}

/** The upstream half, whose scan direction makes an origin auditable. */
function upTraversal(over: Partial<CausalTraversal> = {}): CausalTraversal {
  return traversal({ scan: scan({ direction: 'upstream' }), ...over })
}

function upLadder(t: CausalTraversal = traversal()) {
  return buildLadder(t, 'upstream')
}

function renderLadder(termini: readonly ChainTerminus[], t = traversal()) {
  return render(
    <CausalLadder
      ladder={upLadder(t)}
      termini={termini}
      headingId="h"
      heading="What produced this run"
      caption="c"
    />,
  ).container
}

// ===========================================================================
// §1. THE CENTRAL CLAIM
// ===========================================================================

describe('§1 ENDED and LOST are distinguishable with NO colour, NO style, NO classes, NO data-attributes', () => {
  it('the three termini differ in TEXT alone once all presentation is stripped', () => {
    const trees = [
      <RecordedOriginTerminus origin={ORIGIN} />,
      <CycleReEntryTerminus cycle={CYCLE} />,
      <LostTrailTerminus lost={LOST} />,
    ].map((el) => stripPresentation(render(el).container))

    // Nothing presentational survives the amputation.
    for (const t of trees) expect(classesIn(t).size).toBe(0)

    const [ended, looped, lost] = trees.map(textOf)
    expect(new Set([ended, looped, lost]).size).toBe(3)

    // The difference is a WORD, not a hue — and no word appears under more than
    // one, so a text assertion cannot silently pass on the wrong one. (An
    // earlier surface in this codebase used PROVEN/UNPROVEN, where it can, and
    // COMPLETE/INCOMPLETE would have repeated the mistake exactly.)
    expect(ended).toContain('RECORDED ORIGIN')
    expect(ended).not.toContain('TRAIL LOST')
    expect(ended).not.toContain('CYCLE RE-ENTRY')

    expect(looped).toContain('CYCLE RE-ENTRY')
    expect(looped).not.toContain('RECORDED ORIGIN')
    expect(looped).not.toContain('TRAIL LOST')

    expect(lost).toContain('TRAIL LOST')
    expect(lost).not.toContain('RECORDED ORIGIN')
    expect(lost).not.toContain('CYCLE RE-ENTRY')
  })

  it('a CLOSED LOOP is neither an origin nor a lost trail, and says both', () => {
    // A walk that closed read everything it meant to, so reporting it as lost
    // states something false about the SCAN — and a ring has no earliest run,
    // so reporting it as an origin states something false about the GRAPH.
    const t = textOf(stripPresentation(render(<CycleReEntryTerminus cycle={CYCLE} />).container))
    expect(t).toMatch(/there is no beginning to reach/i)
    expect(t).toMatch(/the walk closed rather than stopped — nothing went unread/i)
    // Its own hop count is a TOTAL, like an origin's and unlike a lost trail's.
    expect(t).toMatch(/a total, because the walk closed the loop/i)
    expect(t).not.toMatch(/at least/i)
  })

  it('the loop is SHOWN, so a reader can check it rather than assume a tool bug', () => {
    const c = render(<CycleReEntryTerminus cycle={CYCLE} />).container
    // The only terminus containing an ordered list of its own.
    const items = Array.from(must(c, 'aside ol').querySelectorAll('li')).map(
      (li) => li.textContent ?? '',
    )
    expect(items).toHaveLength(3)
    expect(items[0]).toContain('run_mid')
    expect(items[2]).toContain('run_mid')
    // Neither of the other two carries one.
    expect(render(<LostTrailTerminus lost={LOST} />).container.querySelector('ol')).toBeNull()
    expect(render(<RecordedOriginTerminus origin={ORIGIN} />).container.querySelector('ol')).toBeNull()
  })

  it('the LOST terminus denies the origin reading outright, in words', () => {
    // The single most expensive misreading on this screen, refused explicitly
    // rather than left to be inferred from a border style under pressure.
    const lost = textOf(stripPresentation(render(<LostTrailTerminus lost={LOST} />).container))
    expect(lost).toMatch(/this is not where the chain began/i)
    // …and the contract's own composed sentence says the same thing again.
    expect(lost).toMatch(/it is where we stopped following it/i)
  })

  it('the ENDED terminus states the walk is finished AND states its own limit', () => {
    const ended = textOf(stripPresentation(render(<RecordedOriginTerminus origin={ORIGIN} />).container))
    expect(ended).toMatch(/the recorded chain starts at run_root/i)
    // The bound is inseparable from the claim: an origin of what was RECORDED
    // is not a root cause, and an operator will not supply that for themselves.
    expect(ended).toMatch(/an uninstrumented handoff would be invisible here/i)
    // An origin always names its proof. An uncited origin is a guess.
    expect(ended).toMatch(/complete inbound edge set of run_root was read/i)
  })

  it('the three carry disjoint FIELD LABELS — the cue a scanner gets before reading', () => {
    const ended = textOf(stripPresentation(render(<RecordedOriginTerminus origin={ORIGIN} />).container))
    const looped = textOf(stripPresentation(render(<CycleReEntryTerminus cycle={CYCLE} />).container))
    const lost = textOf(stripPresentation(render(<LostTrailTerminus lost={LOST} />).container))

    expect(ended).toContain('Established by')
    expect(ended).toContain('Hops to origin')
    expect(ended).not.toContain('Why the trail stops here')
    expect(ended).not.toContain('The loop')

    expect(looped).toContain('The loop')
    expect(looped).toContain('Hops to re-entry')
    expect(looped).not.toContain('Established by')
    expect(looped).not.toContain('Why the trail stops here')

    expect(lost).toContain('Why the trail stops here')
    expect(lost).toContain('To recover the trail')
    expect(lost).toContain('Hops before loss')
    expect(lost).not.toContain('Established by')
    expect(lost).not.toContain('Hops to origin')
    expect(lost).not.toContain('Hops to re-entry')
  })

  it('a TOTAL and a FLOOR are never printed the same way', () => {
    // The contract named `hopsToOrigin` and `hopsBeforeLoss` differently so a
    // floor could not be summed, averaged or compared as though it were a
    // total. Rendering both as a bare "2 hops" would undo that at the last
    // step — the `null`-versus-`0` defect in numeric form.
    const ended = textOf(stripPresentation(render(<RecordedOriginTerminus origin={ORIGIN} />).container))
    const lost = textOf(stripPresentation(render(<LostTrailTerminus lost={LOST} />).container))
    expect(ended).toMatch(/a total, because the walk reached the end/i)
    expect(lost).toMatch(/at least 2/)
    expect(lost).toMatch(/a floor, because the chain continues past here/i)
    expect(lost).not.toMatch(/a total/i)

    // The cycle's count is a total too — it closed the loop — and it must not
    // borrow the floor's hedge.
    const looped = textOf(stripPresentation(render(<CycleReEntryTerminus cycle={CYCLE} />).container))
    expect(looped).toMatch(/a total/i)
    expect(looped).not.toMatch(/at least/i)
  })

  it('the LOST terminus carries a trailing glyph, as literal text', () => {
    // A character rather than an icon, so it survives being read aloud, being
    // pasted as plain text, and being stripped of every style.
    const lost = textOf(stripPresentation(render(<LostTrailTerminus lost={LOST} />).container))
    expect(lost).toContain('TRAIL LOST ...')
    const ended = textOf(stripPresentation(render(<RecordedOriginTerminus origin={ORIGIN} />).container))
    expect(ended).not.toContain('...')
  })

  it('the accessible sentences are in different grammatical moods', () => {
    const ended = textOf(render(<RecordedOriginTerminus origin={ORIGIN} />).container)
    const lost = textOf(render(<LostTrailTerminus lost={LOST} />).container)
    expect(ended).toMatch(/the walk upstream is finished/i)
    expect(lost).toMatch(/is this the origin\? no\./i)
  })

  it('the header STATE WORDS share no word between the two', () => {
    const ended = textOf(stripPresentation(must(renderLadder([ORIGIN]), 'section')))
    const lost = textOf(stripPresentation(must(renderLadder([LOST]), 'section')))
    expect(ended).toContain('ENDS AT RECORDED ORIGIN')
    expect(lost).toContain('TRAIL LOST')
    // COMPLETE / INCOMPLETE would fail this: one contains the other.
    expect(lost).not.toContain('ENDS AT RECORDED ORIGIN')
  })

  it('the "looks exactly like an origin" loss kind says so, in capitals', () => {
    // `adjacency_unconfirmed` is the single most dangerous member of
    // TrailLossKind — an empty edge set whose read was not confirmed. The
    // remedy language for it must not read like any of the budget kinds.
    const t = textOf(stripPresentation(render(<LostTrailTerminus lost={LOST} />).container))
    expect(t).toContain('THIS IS THE CASE THAT LOOKS EXACTLY LIKE AN ORIGIN AND IS NOT ONE')
    expect(t).toContain('adjacency_unconfirmed')

    // …and a budget kind sends the reader somewhere completely different.
    const budget = textOf(
      stripPresentation(
        render(<LostTrailTerminus lost={{ ...LOST, kind: 'depth_limit_reached' }} />).container,
      ),
    )
    expect(budget).toMatch(/we stopped, not the record/i)
    expect(budget).not.toContain('LOOKS EXACTLY LIKE AN ORIGIN')
  })
})

// ===========================================================================
// §2. THE DOM-SHAPE CHANNEL: an origin is a run, a lost trail is not
// ===========================================================================

describe('§2 an origin occupies a rung; a lost trail does not', () => {
  it('the ORIGIN renders INSIDE the <li> of the rung it proved', () => {
    const c = renderLadder([ORIGIN])
    const items = Array.from(must(c, 'ol').querySelectorAll(':scope > li'))
    // Upstream is ordered furthest-first, so run_root leads.
    const first = items[0] as HTMLElement
    expect(first.querySelector('[data-terminus="recorded_origin"]')).toBeTruthy()
    expect(c.querySelector('aside')).toBeNull()
  })

  it('a LOST TRAIL renders as an <aside> AFTER the list closes, on no rung', () => {
    const c = renderLadder([LOST])
    const aside = must<HTMLElement>(c, 'aside[data-terminus="trail_lost"]')
    // It is not inside the ordered list at all — so it cannot be read as a run.
    expect(must(c, 'ol').contains(aside)).toBe(false)
    expect(c.querySelectorAll('ol [data-terminus]').length).toBe(0)
    expect(aside.getAttribute('data-rung')).toBeNull()
  })

  it('the RUN COUNT is identical either way — the difference is what follows', () => {
    // A count that changed would be a second, quieter way to conflate the two.
    for (const t of [[ORIGIN], [LOST]]) {
      expect(renderLadder(t).querySelectorAll('ol > li')).toHaveLength(3)
    }
  })

  it('rungs are numbered; the lost trail is not', () => {
    const c = renderLadder([LOST])
    const ordinals = Array.from(c.querySelectorAll('ol > li')).map((li) => li.getAttribute('data-rung'))
    expect(ordinals).toEqual(['1', '2', '3'])
  })

  it('a CYCLE renders outside the list too — only an origin is a rung', () => {
    const c = renderLadder([CYCLE])
    const aside = must<HTMLElement>(c, 'aside[data-terminus="cycle_reentry"]')
    expect(must(c, 'ol:not(aside ol)').contains(aside)).toBe(false)
    expect(aside.getAttribute('data-rung')).toBeNull()
  })

  it('a frontier kind this build does not know is NAMED, never dropped', () => {
    // A frontier that vanishes makes an unfinished trace look finished, so an
    // unrecognised discriminant fails loudly rather than silently.
    const c = renderLadder([{ terminus: 'something_new' } as never])
    const el = must<HTMLElement>(c, '[data-terminus="unknown"]')
    expect(textOf(el)).toMatch(/do not read the chain above as finished/i)
  })

  it('MULTIPLE frontiers each get their own state word — never summarised into one', () => {
    // A ladder with two frontiers, one ended and one lost, must not be reduced
    // to a single word. Summarising is what turns "mostly finished" into
    // "finished".
    const c = renderLadder([ORIGIN, { ...LOST, lastReachedRunId: 'run_mid' }, CYCLE])
    expect(c.querySelectorAll('[data-chain-state]')).toHaveLength(3)
    expect(c.querySelector('[data-terminus="recorded_origin"]')).toBeTruthy()
    expect(c.querySelector('aside[data-terminus="trail_lost"]')).toBeTruthy()
    expect(c.querySelector('aside[data-terminus="cycle_reentry"]')).toBeTruthy()

    // The three state words share no word, so a summary line cannot silently
    // read as any one of them.
    const head = textOf(stripPresentation(must<HTMLElement>(c, 'section > div')))
    expect(head).toContain('ENDS AT RECORDED ORIGIN')
    expect(head).toContain('CLOSED ON A LOOP')
    expect(head).toContain('TRAIL LOST')
  })
})

// ===========================================================================
// §3. THE THREE NON-ANSWERS ARE THREE ANSWERS
// ===========================================================================

describe('§3 no-edges, walk-unfinished and query-failed never share a treatment', () => {
  const isolated = () =>
    render(<NothingRecordedResult subjectRunId="run_subject" docsHref="/docs" />).container
  const indeterminate = () =>
    render(
      <WalkDidNotFinishResult
        scan={scan({ scanTruncated: true })}
        reasons={['depth_limit_reached: the depth limit (8) was reached — walk deeper']}
        continueHref="/c"
      />,
    ).container
  const failed = () =>
    render(<CausalWalkFailed message="The query failed." retryHref="/r" />).container

  it('all three remain distinguishable with every presentation attribute stripped', () => {
    const els = [isolated(), indeterminate(), failed()]
    const ids = els.map((c) => c.querySelector('[data-testid]')?.getAttribute('data-testid'))
    expect(new Set(ids).size).toBe(3)
    const texts = els.map((c) => textOf(stripPresentation(c)))
    expect(new Set(texts).size).toBe(3)
  })

  it('the EARNED answer is stated positively AND bounded in the same breath', () => {
    const t = textOf(stripPresentation(isolated()))
    expect(t).toContain('NO RECORDED EDGES — AND THE WALK FINISHED')
    expect(t).toMatch(/this is an answer, not an absence of data/i)
    // The bound is what stops it being over-read as "unrelated to anything".
    expect(t).toMatch(/a handoff nobody instrumented is invisible to any walk/i)
    expect(t).toMatch(/not a finding that the run is unrelated to anything/i)
  })

  it('the UNFINISHED walk says outright that it is NOT a result, and names what stopped it', () => {
    const t = textOf(stripPresentation(indeterminate()))
    expect(t).toContain('WALK DID NOT FINISH — THIS IS NOT A RESULT')
    expect(t).toMatch(/not a finding that the run stands alone/i)
    // The direction of the error is the actionable part.
    expect(t).toContain('LOWER BOUND')
    expect(t).toMatch(/can only be larger, never smaller/i)
    expect(t).toContain('depth_limit_reached')
    expect(t).not.toContain('NO RECORDED EDGES')
  })

  it('a FAILED query claims nothing at all, and says so', () => {
    const t = textOf(stripPresentation(failed()))
    expect(t).toContain('QUERY FAILED')
    expect(t).toMatch(/do not read this as a run with no lineage/i)
    expect(t).not.toContain('NO RECORDED EDGES')
    expect(t).not.toContain('WALK DID NOT FINISH')
  })

  it('an unexplained stop is called out as a defect rather than shrugged at', () => {
    const t = textOf(
      render(
        <WalkDidNotFinishResult scan={scan()} reasons={[]} continueHref="/c" />,
      ).container,
    )
    expect(t).toMatch(/indistinguishable from laziness/i)
  })

  it('which non-answer applies is the CONTRACT’s verdict, not list emptiness', () => {
    const noEdges = traversal({ edges: [], nodes: [node('run_subject', 0, 'no_edge_recorded')] })
    // The origin must name a run the walk REACHED — the contract audits
    // `terminus_run_was_reached`, because a frontier at a run nobody can go
    // and read is a frontier nobody can check.
    const selfOrigin: RecordedOrigin = {
      terminus: 'recorded_origin',
      originRunId: 'run_subject',
      hopsToOrigin: 0,
      // The proof must name the SAME run as the terminus. A proof that read
      // some other run's edge set establishes nothing about this one, and the
      // contract reports it as `unproven_origin`.
      establishedBy: [
        {
          proves: 'adjacent_edge_set_read',
          runId: 'run_subject',
          inboundReadComplete: true,
          inboundEdgesFound: 0,
          scannedAt: T0,
        },
      ],
    }

    // Complete walk, no edges -> an earned `isolated`.
    // DIRECTIONAL, and it has to be: `ComponentTerminus` has no origin arm, so
    // an origin under a `component` scan is now unrepresentable rather than
    // merely always-false. A run certified as an island must have been walked
    // in a named direction.
    const complete = {
      ...noEdges,
      scan: scan({ direction: 'upstream', runsVisited: 1 }),
      termini: [selfOrigin] as [RecordedOrigin],
    }
    expect(isCausalTraversalComplete(complete)).toBe(true)
    expect(causalTraversalVerdict(complete)).toBe('isolated')

    // SAME empty edge list, one lost frontier -> `indeterminate`.
    const lost = { ...complete, termini: [{ ...LOST, lastReachedRunId: 'run_subject' }] as [LostTrail] }
    expect(isCausalTraversalComplete(lost)).toBe(false)
    expect(causalTraversalVerdict(lost)).toBe('indeterminate')

    // SAME empty edge list, nothing visited -> `indeterminate`, never isolated.
    const vacuous = { ...complete, scan: scan({ direction: 'upstream', runsVisited: 0 }) }
    expect(causalTraversalVerdict(vacuous)).toBe('indeterminate')

    // And the same origin under a COMPONENT scan is not an answer either: a
    // component walk cannot make an origin claim at all, so certifying an
    // island from one would be certifying it from a shape that cannot hold the
    // proof.
    const componentScan = { ...complete, scan: scan({ direction: 'component', runsVisited: 1 }) }
    expect(causalTraversalVerdict(componentScan)).toBe('indeterminate')
  })

  it('an incomplete traversal WITH edges caveats them rather than replacing them', () => {
    const { container } = render(
      <CausalChainView
        upstream={upTraversal({ termini: [LOST] })}
        downstream={downTraversal()}
        incoherences={[]}
      />,
    )
    expect(container.querySelector('[data-testid="causal-incomplete-banner"]')).toBeTruthy()
    // The ladders are still there — a real edge does not become less real.
    expect(screen.getByRole('region', { name: /what produced this run/i })).toBeTruthy()
    expect(textOf(container)).toContain('EVERY COUNT BELOW IS A LOWER BOUND')
  })

  it('the blast radius states FLOOR-or-TOTAL on the same line as the number', () => {
    const incomplete = render(
      <CausalChainView
        upstream={upTraversal({ termini: [LOST] })}
        downstream={downTraversal()}
        incoherences={[]}
      />,
    ).container
    expect(textOf(must<HTMLElement>(incomplete, '[data-testid="causal-blast-radius"]'))).toMatch(
      /a FLOOR, the walk did not finish/i,
    )

    const complete = render(
      <CausalChainView
        upstream={upTraversal()}
        downstream={downTraversal({
          termini: [{ ...ORIGIN, originRunId: 'run_kid', hopsToOrigin: 1 }],
        })}
        incoherences={[]}
      />,
    ).container
    expect(textOf(must<HTMLElement>(complete, '[data-testid="causal-blast-radius"]'))).toMatch(
      /a total/i,
    )
  })

  it('coverage is rendered on every outcome, including the successful one', () => {
    for (const up of [upTraversal(), upTraversal({ termini: [LOST] })]) {
      const { container } = render(
        <CausalChainView upstream={up} downstream={downTraversal()} incoherences={[]} />,
      )
      expect(container.querySelector('[data-testid="causal-walk-coverage"]')).toBeTruthy()
    }
  })

  it('a sampled edge set is called out as WORSE than a missing record', () => {
    const { container } = render(
      <CausalChainView
        upstream={upTraversal({ scan: scan({ direction: 'upstream', edgeSetsComplete: false }) })}
        downstream={downTraversal()}
        incoherences={[]}
      />,
    )
    expect(textOf(container)).toMatch(
      /arrows the engine could have read may be missing from this graph/i,
    )
  })
})

// ===========================================================================
// §4. A CAUSAL EDGE IS RECORDED, NEVER INFERRED
// ===========================================================================

describe('§4 nothing renders an unrecorded adjacency as a link', () => {
  it('every rung states the stored row that records its edge, always visible', () => {
    const c = renderLadder([ORIGIN])
    const t = textOf(c)
    // Not behind a disclosure: "these two runs are connected" is the one claim
    // that must not be taken on trust while its evidence is one click away.
    expect(c.querySelector('details')).toBeNull()
    expect(t).toContain('recorded in run field parentRunId')
  })

  it('the SUBJECT states that it is on the chain for a non-causal reason', () => {
    expect(textOf(renderLadder([ORIGIN]))).toMatch(
      /on this chain because you asked about it — not because of a recorded edge/i,
    )
  })

  it('a node no recorded edge reaches is NEVER placed on the ladder', () => {
    // `nodes` is every run the walk READ, which is not every run on a chain —
    // a node can be present because it sat on the frontier when a budget ran
    // out. Building rows from edges means such a run cannot reach the ladder.
    const t = traversal({
      nodes: [...traversal().nodes, node('run_stranger', 1, 'adjacency_unread')],
    })
    const ladder = buildLadder(t, 'upstream')
    expect(ladder.rows.map((r) => r.node.runId)).not.toContain('run_stranger')
    expect(ladder.orphanNodeIds).toContain('run_stranger')
  })

  it('an orphan node is STATED, not silently dropped', () => {
    const t = traversal({
      nodes: [...traversal().nodes, node('run_stranger', 1, 'adjacency_unread')],
    })
    const c = renderLadder([ORIGIN], t)
    // Two orphans on the UPSTREAM ladder: the stranger, and `run_kid`, which
    // is genuinely downstream-only. Both are reported rather than dropped.
    expect(textOf(must<HTMLElement>(c, '[data-testid="causal-orphan-nodes"]'))).toMatch(
      /no recorded edge places them on this chain/i,
    )
  })

  it('every LadderRow except the subject carries the edge that put it there', () => {
    // The structural half: a row without an edge cannot be built, so no
    // renderer can be handed one.
    for (const dir of ['upstream', 'downstream'] as const) {
      for (const row of buildLadder(traversal(), dir).rows) {
        if (row.isSubject) continue
        expect(row.arrivedBy, `row ${row.node.runId} arrived with no edge`).toBeDefined()
      }
    }
  })

  it('per-node adjacency is THREE-VALUED on the row, and "unread" is never silent', () => {
    // Read over the whole view: `run_root` (read, empty) is upstream and
    // `run_kid` (never read) is downstream, so both words appear on one page.
    const c = render(<CausalChainView upstream={upTraversal()} downstream={downTraversal()} incoherences={[]} />).container
    const words = Array.from(c.querySelectorAll('[data-adjacency]')).map((n) => n.textContent ?? '')
    // "we looked and it is empty" and "we did not look" are opposite claims,
    // and a blank cell reads as the reassuring one.
    expect(words.some((w) => w.includes('edge set read — empty'))).toBe(true)
    expect(words.some((w) => w.includes('edge set NOT READ'))).toBe(true)
    expect(new Set(words).size).toBeGreaterThan(1)
  })

  it('the ladder is not ordered by time — reversing every timestamp changes nothing', () => {
    // The strongest available statement that no position on this surface is
    // derived from a clock.
    const forward = buildLadder(traversal(), 'upstream').rows.map((r) => r.node.runId)
    const reversedClocks = traversal({
      nodes: traversal().nodes.map((n, i) => ({ ...n, startedAt: T0 - i * 100_000 })),
    })
    const after = buildLadder(reversedClocks, 'upstream').rows.map((r) => r.node.runId)
    expect(after).toEqual(forward)
  })

  it('suspected links live OUTSIDE every ordered list, with no ordinals and no direction', () => {
    const s: SuspectedLink = {
      basis: 'suspected',
      kind: 'shared_session',
      linkKey: 'sess:s_1',
      runIds: ['run_zzz', 'run_aaa'],
      sharedValue: 's_1',
      notAnEdgeBecause: 'Nothing in either log records one reading the other’s output.',
      wouldBeRecordedBy: 'Pass parentRunId to startRun.',
      firstSeenAt: T0,
      lastSeenAt: T0 + 1000,
    }
    const { container } = render(<SuspectedLinksPanel items={[s]} headingId="u" />)
    // A <ul>, never an <ol>: an ordinal is the mark of a position in a chain.
    expect(container.querySelector('ol')).toBeNull()
    expect(container.querySelector('ul')).toBeTruthy()
    expect(container.querySelectorAll('[data-rung]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-depth]')).toHaveLength(0)

    // The contract says `runIds` order carries no meaning; the panel sorts, so
    // an arrival-ordered list cannot invite a reader to find one anyway.
    const ids = Array.from(container.querySelectorAll('dd a')).map((a) => a.textContent ?? '')
    expect(ids[0]).toContain('run_aaa')
    expect(ids[1]).toContain('run_zzz')
  })

  it('a suspicion is rendered as a QUESTION, never as a claim or an arrow', () => {
    const s: SuspectedLink = {
      basis: 'suspected',
      kind: 'temporal_adjacency',
      linkKey: 'temp:1',
      runIds: ['run_a', 'run_b'],
      notAnEdgeBecause: 'They merely ran close together.',
      wouldBeRecordedBy: 'Record the handoff.',
      firstSeenAt: T0,
      lastSeenAt: T0 + 10,
    }
    const { container } = render(<SuspectedLinksPanel items={[s]} headingId="u" />)
    const heading = must<HTMLElement>(container, 'h3')
    expect(textOf(heading).endsWith('?')).toBe(true)
    // The most seductive false arrow there is, and it must not be drawn.
    expect(textOf(heading)).toMatch(/ran close together in time/i)
    expect(textOf(container)).not.toMatch(/caused/i)
    expect(textOf(container)).toMatch(
      /an ordering by time would read as a sequence, and a sequence would read as a chain/i,
    )
  })

  it('a suspicion carries NO DIRECTION of any name — and layout supplies none', () => {
    // `producerRunId`/`consumerRunId` exist only on a recorded edge. A
    // suspicion is not MARKED unwalkable, it IS unwalkable, because there is no
    // field a traversal could follow. An arrow drawn between two suspected runs
    // would reinstate exactly the claim the contract deleted, so nothing here
    // may imply one: no ordinals, no connectors, no sorted-by-time sequence,
    // and no producer/consumer wording.
    const s: SuspectedLink = {
      basis: 'suspected',
      kind: 'shared_resource',
      linkKey: 'res:q',
      runIds: ['run_b', 'run_a'],
      sharedValue: 'queue://jobs',
      notAnEdgeBecause: 'Whether one wrote what the other read is what was not recorded.',
      wouldBeRecordedBy: 'Record the artifact handoff.',
      firstSeenAt: T0 + 5000,
      lastSeenAt: T0 + 9000,
    }
    expect(Object.keys(s)).not.toContain('producerRunId')
    expect(Object.keys(s)).not.toContain('consumerRunId')

    const { container } = render(<SuspectedLinksPanel items={[s]} headingId="u" />)
    const t = textOf(stripPresentation(container))
    // No directional vocabulary anywhere in the rendered band.
    for (const word of ['produced', 'consumed', 'caused', 'led to', 'downstream', 'upstream']) {
      expect(t.toLowerCase()).not.toContain(word)
    }
    // And no arrow glyph, which is the wordless way to say the same thing.
    for (const arrow of ['->', '\u2192', '\u2190']) expect(t).not.toContain(arrow)
  })

  it('an empty suspicion band is not a finding either, and says so', () => {
    const { container } = render(<SuspectedLinksPanel items={[]} headingId="u" />)
    expect(textOf(container)).toMatch(/not that nothing is related/i)
  })

  it('the unanswered band names its obstacle and its remedy', () => {
    const { container } = render(
      <UnansweredCausalList
        items={[
          {
            questionKey: 'q1',
            kind: 'component_unclosed',
            undecidedQuestion: 'which run in the loop came first',
            unknownBecause: 'The recorded edges form a cycle.',
            remedy: 'Correct the edge that closes the loop.',
          },
        ]}
        headingId="q"
      />,
    )
    const t = textOf(stripPresentation(container))
    expect(t).toContain('What blocked it')
    expect(t).toContain('To make this answerable')
    expect(t).toMatch(/neither findings nor the absence of findings/i)
  })

  it('an edge withheld during adaptation is REPORTED, not silently dropped', () => {
    const { container } = render(
      <IncoherentTraversalNotice
        findings={[{ where: 'e_1', what: 'nothing checkable was cited for this edge' }]}
      />,
    )
    const t = textOf(stripPresentation(container))
    expect(t).toContain('1 PART OF THIS TRAVERSAL CONTRADICTS ITSELF')
    expect(t).toMatch(/the chain shown may therefore stop earlier than the record does/i)
  })

  it('says nothing about incoherence when the traversal is coherent', () => {
    const { container } = render(<CausalChainView upstream={upTraversal()} downstream={downTraversal()} incoherences={[]} />)
    expect(container.querySelector('[data-testid="causal-incoherent"]')).toBeNull()
  })

  it('a FORK is enumerated, because a path can only show one of its branches', () => {
    // "What caused this?" has a different answer at a convergence: a single
    // chain has one story, a run with three producers has three, and reading
    // only the first is how the wrong thing gets rolled back.
    const forked = upTraversal({
      nodes: [
        node('run_subject', 0, 'edge_recorded'),
        node('run_p1', 1, 'no_edge_recorded'),
        node('run_p2', 1, 'no_edge_recorded'),
      ],
      edges: [edge('run_p1', 'run_subject'), edge('run_p2', 'run_subject')],
    })
    const { container } = render(
      <CausalChainView upstream={forked} downstream={downTraversal()} incoherences={[]} />,
    )
    const panel = must<HTMLElement>(container, '[data-testid="causal-convergence"]')
    const t = textOf(stripPresentation(panel))
    expect(t).toContain('run_p1')
    expect(t).toContain('run_p2')
    expect(t).toMatch(/2 stories here, not one/i)
    // It is NOT a terminus band: no terminus markup, no ordinals.
    expect(panel.querySelector('[data-terminus]')).toBeNull()
    expect(panel.querySelectorAll('[data-rung]')).toHaveLength(0)
  })

  it('no fork panel appears when nothing converges', () => {
    // A band that always renders trains people to ignore it.
    const { container } = render(
      <CausalChainView upstream={upTraversal()} downstream={downTraversal()} incoherences={[]} />,
    )
    expect(container.querySelector('[data-testid="causal-convergence"]')).toBeNull()
  })

  it('the coverage footer states the walk sees recorded edges and nothing else', () => {
    const { container } = render(<CausalChainView upstream={upTraversal()} downstream={downTraversal()} incoherences={[]} />)
    const cov = must<HTMLElement>(container, '[data-testid="causal-walk-coverage"]')
    expect(textOf(cov)).toMatch(/a handoff that happened without being recorded is not on this page/i)
    // The two halves are two snapshots, and the page says so rather than
    // stitching them into a claim neither engine made.
    expect(textOf(cov)).toMatch(/two snapshots rather than one/i)
    expect(textOf(cov)).toMatch(/nothing here is evidence that two runs are unrelated/i)
  })
})

// ===========================================================================
// §4b. THE DIRECT ENGINE SHAPE
//
// `convex/causality.ts` now returns a `CausalTraversal` itself, so nothing
// stands between the engine and these components. This section is the
// pre-deletion verification the adapter's removal rested on: a traversal built
// the way the engine builds one must pass the contract's OWN three gates with
// nothing to report, and must render.
//
// It is also where the adapter's real defects are recorded, because they are
// findings rather than merge noise. Against contracts 0.24.x the adapter was
// emitting data the contract REJECTS:
//
//   - every event citation carried `sequenceNumber: 0`, which the contract
//     flags as `not_a_sequence_number` — a sentinel inside the data's own
//     domain, which reads as a measurement;
//   - every artifact citation fell back to naming the edge-index row, which the
//     contract now forbids outright as CIRCULAR SELF-EVIDENCE: "an edge whose
//     evidence is a row in the table that asserts this edge" is exactly what an
//     inference engine emits.
//
// Both were unavoidable given what the old Convex shape carried, and both are
// gone with the seam rather than fixed inside it.
// ===========================================================================

describe('§4b a traversal shaped as the engine builds it passes the contract’s own gates', () => {
  const direct = traversal({
    nodes: [
      node('run_subject', 0, 'edge_recorded'),
      node('run_mid', 1, 'edge_recorded'),
      node('run_root', 2, 'no_edge_recorded'),
    ],
    edges: [eventEdge('run_root', 'run_mid'), artifactEdge('run_mid', 'run_subject')],
    scan: scan({ direction: 'upstream', runsVisited: 3, edgesRead: 2 }),
  })

  it('reports nothing unusable — including the sequence number', () => {
    const findings = traversalUnusableFields(direct)
    expect(findings).toEqual([])
    // The specific one the sentinel would have tripped.
    expect(findings.map((f) => f.reason)).not.toContain('not_a_sequence_number')
  })

  it('reports nothing incoherent and nothing contradicted', () => {
    expect(traversalIncoherences(direct)).toEqual([])
    expect(traversalClaimContradictions(direct)).toEqual([])
  })

  it('is COMPLETE, and the contract calls it a recorded chain', () => {
    expect(isCausalTraversalComplete(direct)).toBe(true)
    expect(causalTraversalVerdict(direct)).toBe('chain_recorded')
  })

  it('renders every citation kind, naming the record a reader can open', () => {
    const c = renderLadder([ORIGIN], direct)
    const t = textOf(stripPresentation(c))
    // An event citation names its position in the log — the real one.
    expect(t).toContain('run.input')
    expect(t).toContain('17')
    expect(t).not.toMatch(/#0\b/)
    // An artifact citation names the digest AND the role. The digest is what
    // makes it an identity claim rather than a filename collision; the role is
    // what gives it a direction, since a shared hash has none.
    expect(t).toContain('9c31aa77')
    expect(t).toContain('consumed')
  })

  it('an event citation with a `0` sequence is REJECTED by the contract, not rendered as fact', () => {
    // The adapter's sentinel, checked against the gate that now catches it — so
    // this stays a finding rather than becoming folklore about a deleted file.
    const base = eventEdge('run_root', 'run_mid')
    const cite = base.recordedBy[0] as CausalEventCitation
    const sentinel = traversal({
      edges: [{ ...base, recordedBy: [{ ...cite, sequenceNumber: 0 }] }],
    })
    expect(traversalUnusableFields(sentinel).map((f) => f.reason)).toContain(
      'not_a_sequence_number',
    )
  })

  it('SESSION SIBLINGS reach the real suspicion band, as run ids', () => {
    // They arrive as ids now, not a count, so they can be a `SuspectedLink`
    // instead of prose folded into a terminus. The band is directionless by
    // type, so surfacing them here cannot become an arrow.
    const siblings: SuspectedLink = {
      basis: 'suspected',
      kind: 'shared_session',
      linkKey: 'sess:s_9f3c',
      runIds: ['run_sib_b', 'run_sib_a'],
      sharedValue: 's_9f3c',
      notAnEdgeBecause:
        'These runs share a session id; nothing in either log records one reading the other’s output.',
      wouldBeRecordedBy: 'Pass parentRunId to startRun, or record the handoff event.',
      firstSeenAt: T0,
      lastSeenAt: T0 + 1000,
    }
    const { container } = render(
      <CausalChainView
        upstream={upTraversal({ suspected: [siblings] })}
        downstream={downTraversal()}
        incoherences={[]}
      />,
    )
    const band = must<HTMLElement>(container, '[data-testid="causal-suspected"]')
    const t = textOf(stripPresentation(band))
    expect(t).toContain('run_sib_a')
    expect(t).toContain('s_9f3c')
    expect(t).toMatch(/is there a handoff between them that nothing recorded\?/i)
    // And they are nowhere near a ladder.
    expect(band.querySelector('[data-rung]')).toBeNull()
  })
})

// ===========================================================================
// §4c. A REQUIRED ARRAY'S ELEMENTS ARE AS UNTRUSTED AS A REQUIRED FIELD
//
// Both cases here were found by a lint error, not by a test — two
// `Array.isArray(...)` guards that checked the CONTAINER and let the elements
// through as `any`. The rule fired on the widened type; the defect underneath
// it was that a malformed element reached `truncateId`, which slices its
// argument, on the one screen whose purpose is to be readable during an
// incident.
//
// The more expensive half is the second one, and it does not crash: a proof
// that establishes nothing, printed under a confident RECORDED ORIGIN badge.
// ===========================================================================

describe('§4c a malformed element degrades the CLAIM, and never renders a partial one', () => {
  it('an unreadable loop path renders NO loop — not a shorter one', () => {
    // A cycle path is checkable precisely because every consecutive pair must
    // be a recorded edge. Filtering the bad entries out yields a shorter ring
    // whose hops correspond to nothing — a fabricated loop rendered as a
    // verified one.
    const broken = {
      ...CYCLE,
      cyclePath: ['run_mid', null, 'run_mid'] as unknown as CycleReEntry['cyclePath'],
    }
    const c = render(<CycleReEntryTerminus cycle={broken} />).container
    const t = textOf(stripPresentation(c))
    expect(t).toContain('LOOP PATH UNREADABLE')
    expect(t).toMatch(/treat the chain as unfinished/i)
    // No partial list is drawn.
    expect(c.querySelector('aside ol')).toBeNull()
  })

  it('a readable loop still renders — the guard must not swallow the good case', () => {
    const c = render(<CycleReEntryTerminus cycle={CYCLE} />).container
    expect(c.querySelectorAll('aside ol li')).toHaveLength(3)
    expect(textOf(c)).not.toContain('LOOP PATH UNREADABLE')
  })

  it('malformed elements do not throw', () => {
    for (const bad of [[null], [{}], [1, 2], []]) {
      expect(() =>
        render(
          <CycleReEntryTerminus
            cycle={{ ...CYCLE, cyclePath: bad as unknown as CycleReEntry['cyclePath'] }} />,
        ),
      ).not.toThrow()
    }
  })

  it('an ORIGIN whose proof establishes nothing is RETRACTED, not decorated', () => {
    // `unproven_origin`: the contract's own words are "a lost trail wearing an
    // origin's clothes". The literal types (`true`, `0`) make it unspellable in
    // our code; a JSON body is typechecked by nobody.
    const unproven: RecordedOrigin[] = [
      // No proof at all.
      { ...ORIGIN, establishedBy: [] as unknown as RecordedOrigin['establishedBy'] },
      // A proof that did not finish reading.
      {
        ...ORIGIN,
        establishedBy: [
          { ...ORIGIN.establishedBy[0], inboundReadComplete: false as unknown as true },
        ],
      },
      // A proof that FOUND an edge — self-contradictory.
      {
        ...ORIGIN,
        establishedBy: [{ ...ORIGIN.establishedBy[0], inboundEdgesFound: 3 as unknown as 0 }],
      },
      // A proof that read some OTHER run's edge set.
      {
        ...ORIGIN,
        establishedBy: [{ ...ORIGIN.establishedBy[0], runId: 'run_somewhere_else' }],
      },
      // A malformed element.
      {
        ...ORIGIN,
        establishedBy: [null] as unknown as RecordedOrigin['establishedBy'],
      },
    ]

    for (const o of unproven) {
      const c = render(<RecordedOriginTerminus origin={o} />).container
      const t = textOf(stripPresentation(c))
      expect(t).toContain('THIS ORIGIN IS UNPROVEN')
      expect(t).toMatch(/a lost trail wearing an origin’s clothes/i)
      // It must NOT print the proof sentence over data that proves nothing.
      expect(t).not.toMatch(/was read, and it held/i)
    }
  })

  it('a SOUND origin still prints its proof — the guard must not swallow the good case', () => {
    const t = textOf(stripPresentation(render(<RecordedOriginTerminus origin={ORIGIN} />).container))
    expect(t).toMatch(/complete inbound edge set of run_root was read/i)
    expect(t).not.toContain('THIS ORIGIN IS UNPROVEN')
  })

  it('the retraction is legible with all presentation stripped', () => {
    // It sits under a RECORDED ORIGIN badge, so it has to survive the same
    // amputation the badge does — otherwise the badge outlives its retraction.
    const c = render(
      <RecordedOriginTerminus
        origin={{ ...ORIGIN, establishedBy: [] as unknown as RecordedOrigin['establishedBy'] }}
      />,
    ).container
    const t = textOf(stripPresentation(c))
    expect(t).toContain('RECORDED ORIGIN')
    expect(t).toContain('THIS ORIGIN IS UNPROVEN')
  })
})

// ===========================================================================
// §5. THE SERVER IS CROSS-CHECKED, NOT OVERWRITTEN
//
// The engine speaks the contract, so there is no adapter left to test. What
// replaces it is the audit seam: everything the server already answered is
// recomputed, and a DISAGREEMENT IS REPORTED rather than absorbed.
//
// This is the section that stops the seam from becoming the bug it replaced. A
// gate that silently corrects what it finds makes the defect unobservable at
// its source — which is how a recovery path in this codebase once hid a
// backend fold bug for an entire iteration.
// ===========================================================================

describe('§5 a disagreement with the server is a finding, never a silent fix', () => {
  /**
   * NOTE the proof's `runId`. `OriginProof.runId` must equal the terminus's
   * `originRunId` — an origin whose proof read some OTHER run's edge set has
   * established nothing, and the contract reports it as `unproven_origin`.
   * This fixture originally carried the mismatch and the gate caught it, which
   * is the behaviour §5 exists to keep.
   */
  const good = (over: Partial<CausalTraversal> = {}): CausalTraversal =>
    traversal({
      nodes: [node('run_subject', 0, 'no_edge_recorded')],
      edges: [],
      termini: [
        {
          terminus: 'recorded_origin',
          originRunId: 'run_subject',
          hopsToOrigin: 0,
          establishedBy: [
            {
              proves: 'adjacent_edge_set_read',
              runId: 'run_subject',
              inboundReadComplete: true,
              inboundEdgesFound: 0,
              scannedAt: T0,
            },
          ],
        },
      ],
      scan: scan({ direction: 'upstream', runsVisited: 1, edgesRead: 0 }),
      verdict: 'isolated',
      ...over,
    })

  it('a clean traversal produces NO findings — the gate must not over-fire', () => {
    // If the audit reported on healthy data, the band would be uniformly
    // useless and nobody would notice it firing for real.
    const r = auditTraversal(good(), 'upstream', 8)
    expect(r.findings).toEqual([])
    expect(r.complete).toBe(true)
    expect(r.traversal.verdict).toBe('isolated')
  })

  it('a DIRECTION ECHO mismatch is reported — the walk answered another question', () => {
    const r = auditTraversal(good({ scan: scan({ direction: 'downstream', runsVisited: 1 }) }), 'upstream', 8)
    expect(r.findings.some((f) => f.where === 'upstream: scan.direction')).toBe(true)
    expect(r.findings.find((f) => f.where === 'upstream: scan.direction')?.what).toMatch(
      /answered a different question/i,
    )
  })

  it('a DEPTH ECHO mismatch is reported — a limit reached at a bound nobody chose', () => {
    // A deployment that drops the parameter reports `depth_limit_reached` at
    // its own default, which is indistinguishable from an honest answer.
    const r = auditTraversal(good(), 'upstream', 16)
    expect(r.findings.some((f) => f.where === 'upstream: scan.maxDepthRequested')).toBe(true)
  })

  it('an EMPTY terminus list is reported, and the verdict cannot be isolated', () => {
    // The shape Team A hit on an ordinary parent/child pair. It is unspellable
    // in typed code and it arrived on the wire anyway.
    const r = auditTraversal(good({ termini: [] as unknown as CausalTraversal['termini'] }), 'upstream', 8)
    expect(r.findings.some((f) => f.where === 'upstream: termini')).toBe(true)
    expect(r.findings.find((f) => f.where === 'upstream: termini')?.what).toMatch(
      /a walk always stops somewhere/i,
    )
    // And it must not certify an island by vacuity.
    expect(r.complete).toBe(false)
    expect(r.traversal.verdict).toBe('indeterminate')
  })

  it('an empty terminus list RENDERS, as loudly as a lost trail', () => {
    const c = renderLadder([])
    const el = must<HTMLElement>(c, '[data-terminus="absent"]')
    const t = textOf(stripPresentation(el))
    expect(t).toContain('NO FRONTIER REPORTED')
    expect(t).toMatch(/do not read the rungs above as complete/i)
    // It must borrow neither of the real termini's words.
    expect(t).not.toContain('RECORDED ORIGIN')
    expect(t).not.toContain('TRAIL LOST')
  })

  it('a SERVER VERDICT that disagrees is reported, and the recomputed one wins', () => {
    // The server calling an unfinished walk `isolated` is the single most
    // expensive thing it can say, so it is contradicted out loud.
    const r = auditTraversal(good({ termini: [LOST], verdict: 'isolated' }), 'upstream', 8)
    const f = r.findings.find((x) => x.where === 'upstream: verdict')
    expect(f).toBeDefined()
    expect(f?.what).toMatch(/reported rather than absorbed/i)
    expect(r.traversal.verdict).toBe('indeterminate')
  })

  it('a body that is not a traversal reports rather than throwing', () => {
    for (const junk of [null, undefined, 42, 'nope', []]) {
      expect(() => auditTraversal(junk, 'upstream', 8)).not.toThrow()
      const r = auditTraversal(junk, 'upstream', 8)
      expect(r.findings.length).toBeGreaterThan(0)
      expect(r.complete).toBe(false)
      expect(r.traversal.verdict).toBe('indeterminate')
    }
  })

  it('findings name WHICH half they came from', () => {
    // Two walks, two snapshots. A finding that did not say which one would
    // send a reader to the wrong query.
    const r = auditTraversal(good({ termini: [] as unknown as CausalTraversal['termini'] }), 'downstream', 8)
    for (const f of r.findings) expect(f.where.startsWith('downstream: ')).toBe(true)
  })
})

// ===========================================================================
// §6. DIRECTION, KEYBOARD, AND SHAREABLE URLS
// ===========================================================================

describe('§6 the two directions are separate landmarks, and everything is navigable', () => {
  it('renders two separately-named regions, never one merged list', () => {
    render(<CausalChainView upstream={upTraversal()} downstream={downTraversal()} incoherences={[]} />)
    const up = screen.getByRole('region', { name: /what produced this run/i })
    const down = screen.getByRole('region', { name: /what ran on this run's output/i })
    expect(up).not.toBe(down)
  })

  it('a frontier is placed on the ladder that contains its run', () => {
    render(<CausalChainView upstream={upTraversal()} downstream={downTraversal()} incoherences={[]} />)
    const up = screen.getByRole('region', { name: /what produced this run/i })
    const down = screen.getByRole('region', { name: /what ran on this run's output/i })
    // Settled upstream, unfinished downstream — a common combination that must
    // read as exactly that.
    expect(up.querySelector('[data-terminus="recorded_origin"]')).toBeTruthy()
    expect(down.querySelector('[data-terminus="trail_lost"]')).toBeTruthy()
  })

  it('a frontier matching NO ladder is named, never dropped', () => {
    // A frontier that vanishes makes an unfinished trace look finished.
    const { container } = render(
      <CausalChainView
        upstream={upTraversal({ termini: [{ ...LOST, lastReachedRunId: 'run_nowhere' }] })}
        downstream={downTraversal()}
        incoherences={[]}
      />,
    )
    const el = must<HTMLElement>(container, '[data-testid="causal-unplaced-termini"]')
    expect(textOf(el)).toContain('run_nowhere')
    expect(textOf(el)).toMatch(/a frontier that vanishes makes an unfinished trace look finished/i)
  })

  it('the subject is marked in both directions', () => {
    const { container } = render(<CausalChainView upstream={upTraversal()} downstream={downTraversal()} incoherences={[]} />)
    const marks = Array.from(container.querySelectorAll('li')).filter((li) =>
      (li.textContent ?? '').includes('YOU ARE HERE'),
    )
    expect(marks).toHaveLength(2)
  })

  it('every rung is a real link to the run, reachable by keyboard with no JavaScript', () => {
    const c = renderLadder([ORIGIN])
    const hrefs = Array.from(c.querySelectorAll('ol > li a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/runs/run_root')
    expect(hrefs).toContain('/runs/run_subject')
  })

  it('every run id is copyable', () => {
    const c = renderLadder([ORIGIN])
    expect(c.querySelectorAll('button[aria-label^="Copy run id"]')).toHaveLength(3)
  })

  it('the unfinished-walk state offers a stable, shareable resume URL', () => {
    const { container } = render(
      <WalkDidNotFinishResult
        scan={scan()}
        reasons={['depth_limit_reached: x']}
        continueHref="/runs/run_subject/causal?depth=16"
      />,
    )
    expect(
      within(container).getByRole('link', { name: /walk again with a larger depth/i }).getAttribute('href'),
    ).toBe('/runs/run_subject/causal?depth=16')
  })

  it('downstream depth is stated in WORDS, not only as indentation', () => {
    // Indentation is a styling channel, and a styling channel carries nothing
    // once the classes are gone.
    const c = render(
      <CausalLadder
        ladder={buildLadder(traversal(), 'downstream')}
        termini={[]}
        headingId="h"
        heading="What ran on this run's output"
        caption="c"
      />,
    ).container
    expect(textOf(stripPresentation(c))).toContain('1 hop away')
  })

  it('a malformed traversal does not blank the screen', () => {
    const broken = {
      ...traversal(),
      nodes: null,
      edges: undefined,
      termini: 'nope',
      suspected: 7,
      unanswered: null,
      scan: null,
    } as unknown as CausalTraversal
    expect(() =>
      render(<CausalChainView upstream={broken} downstream={broken} incoherences={[]} />),
    ).not.toThrow()
  })
})
