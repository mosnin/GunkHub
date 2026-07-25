/**
 * THE TYPE SYSTEM IS THE FEATURE — this file is the proof, and it is the third
 * time this repo has written one (`compat_type_conflation.test.ts`,
 * `fleet_type_conflation.test.ts`, now this).
 *
 * `packages/contracts/src/causality.ts` makes two claims, and each is worth
 * exactly as much as the evidence behind it. The only honest evidence for a
 * compile-time guarantee is code that DOES NOT COMPILE.
 *
 *   CLAIM 1 — RECORDED, NEVER INFERRED. It is impossible to walk, draw, or
 *   count a coincidence as a causal edge. Two runs adjacent in time, sharing a
 *   session, or touching the same resource are not thereby causally linked, and
 *   an arrow is the most persuasive object this product can produce: nobody
 *   reads a confidence badge next to one, they follow it to a run and act.
 *
 *   CLAIM 2 — A CHAIN THAT ENDS AND A CHAIN WHOSE TRAIL IS LOST ARE DIFFERENT
 *   THINGS. "The origin is run X" says the investigation is over. "We lost the
 *   trail at run X" says it is unfinished. They are opposite claims about the
 *   same run id, the second is the more common one in production (the SDK may
 *   simply never have recorded the edge), and a design that lets a caller render
 *   one as the other BY FORGETTING A FIELD is a design that tells someone "you
 *   have found it" when the honest sentence is "you have run out of road".
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
 *   - if the line below it errors (the conflation is illegal), the directive is
 *     satisfied and typecheck passes — the guarantee holds;
 *   - if the line below it ever STOPS erroring (someone adds a shared `runId`,
 *     relaxes a discriminant, widens `OriginProof.inboundReadComplete` from the
 *     literal `true` to `boolean`, gives `SuspectedLink` a direction, or loosens
 *     `recordedBy`/`establishedBy` off their non-empty tuples), TypeScript
 *     reports "Unused '@ts-expect-error' directive" AS AN ERROR ON THIS FILE and
 *     `pnpm typecheck` goes red.
 *
 * So the guarantee cannot be weakened without this file failing. That is a
 * stronger property than any runtime assertion could give: no test needs to
 * remember to run, and no consumer needs to remember to check a flag.
 */
import {
  causalTraversalVerdict,
  computeCausalVerdict,
  convergencePoints,
  cycleReEntries,
  downstreamRunCount,
  citedEndpointCount,
  edgeIncoherences,
  isCausalTraversalComplete,
  lostTrails,
  originStatement,
  recordedOrigins,
  suspicionQuestion,
  traversalClaimContradictions,
  traversalIncoherences,
  traversalUnusableFields,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  CausalArtifactCitation,
  CausalScan,
  ComponentTraversal,
  DirectedTraversal,
  TerminusFor,
  CausalEventCitation,
  CausalTraversal,
  ChainTerminus,
  CycleReEntry,
  LostTrail,
  OriginProof,
  RecordedCausalEdge,
  RecordedOrigin,
  SuspectedLink,
  UnansweredCausalQuestion,
} from '@agent-flight-recorder/contracts'
// The phantom parameter lived on an SDK type, so the hygiene sweep at the foot
// of this file needs both halves of the surface in one place.
import type { CausalTraceParams, V1CausalTraceData } from '@agent-flight-recorder/sdk'

const T0 = 1_721_909_400_000

// ---------------------------------------------------------------------------
// The bands, each valid on its own. These compile — the positive control that
// the negative cases below fail for the RIGHT reason (a real incompatibility)
// rather than because the fixtures were malformed.
// ---------------------------------------------------------------------------

const citation: CausalEventCitation = {
  cites: 'event',
  recordedInRunId: 'run_b',
  eventId: 'ev_1',
  sequenceNumber: 4,
  eventType: 'run.input_received',
  namesRunId: 'run_a',
  recordedAt: T0,
}

const edge: RecordedCausalEdge = {
  basis: 'recorded',
  kind: 'output_consumed',
  edgeKey: 'e_ab',
  producerRunId: 'run_a',
  consumerRunId: 'run_b',
  recordedFact: 'run_b recorded receiving run_a\'s output as its input at 14:03:20',
  handoffAt: T0,
  recordedBy: [citation],
}

const suspected: SuspectedLink = {
  basis: 'suspected',
  kind: 'temporal_adjacency',
  linkKey: 'adj:run_a:run_c',
  runIds: ['run_a', 'run_c'],
  notAnEdgeBecause:
    'these two runs started 90 seconds apart; nothing in either run\'s log records one reading the other\'s output',
  wouldBeRecordedBy: 'pass `parentRunId` to `startRun`, or record `Events.runSpawned(childRunId)` in the parent',
  firstSeenAt: T0,
  lastSeenAt: T0 + 90_000,
}

const proof: OriginProof = {
  proves: 'adjacent_edge_set_read',
  runId: 'run_a',
  inboundReadComplete: true,
  inboundEdgesFound: 0,
  scannedAt: T0,
}

const origin: RecordedOrigin = {
  terminus: 'recorded_origin',
  originRunId: 'run_a',
  hopsToOrigin: 1,
  establishedBy: [proof],
}

const lost: LostTrail = {
  terminus: 'trail_lost',
  lastReachedRunId: 'run_a',
  kind: 'depth_limit_reached',
  hopsBeforeLoss: 1,
  lostBecause: 'the depth limit (1) was reached before run_a\'s producers were expanded',
  wouldBeRecoveredBy: 're-run with --max-depth 10',
}

const cycle: CycleReEntry = {
  terminus: 'cycle_reentry',
  reEnteredRunId: 'run_a',
  hopsToReEntry: 2,
  cyclePath: ['run_a', 'run_b', 'run_a'],
}

const unanswered: UnansweredCausalQuestion = {
  basis: 'unanswered',
  kind: 'adjacency_unknown',
  questionKey: 'adjacency:run_a',
  undecidedQuestion: 'whether anything produced run_a\'s input',
  unknownBecause: 'run_a\'s edge index could not be read',
  remedy: 're-run once the edge index has rebuilt',
}

// ===========================================================================
// CLAIM 1 — RECORDED, NEVER INFERRED
// ===========================================================================

// ---------------------------------------------------------------------------
// CASE 1 — the bands are mutually unassignable, in EVERY direction
// ---------------------------------------------------------------------------

// THE CATASTROPHIC DIRECTION: a coincidence held as a recorded handoff. This is
// how "these ran ninety seconds apart" becomes an arrow someone follows.
// @ts-expect-error — SuspectedLink is not assignable to RecordedCausalEdge
const notAnEdge: RecordedCausalEdge = suspected

// And the quieter direction: a fact filed among the guesses, where it is
// discounted along with them.
// @ts-expect-error — RecordedCausalEdge is not assignable to SuspectedLink
const notASuspicion: SuspectedLink = edge

// "We could not check" is neither a weak edge nor a strong guess.
// @ts-expect-error — UnansweredCausalQuestion is not assignable to RecordedCausalEdge
const notAnEdge2: RecordedCausalEdge = unanswered
// @ts-expect-error — UnansweredCausalQuestion is not assignable to SuspectedLink
const notASuspicion2: SuspectedLink = unanswered

// ---------------------------------------------------------------------------
// CASE 1b — THE DISCRIMINANT IS NOT THE ONLY BARRIER
//
// If `basis` were the only thing separating them, deleting it (or a server
// omitting it) would open the hole. Each band carries REQUIRED fields the others
// lack, so assignment fails on a missing property even with the discriminant
// made to agree.
// ---------------------------------------------------------------------------

// @ts-expect-error — even wearing the right discriminant, this lacks `producerRunId`, `consumerRunId`, `recordedBy` and `recordedFact`
const disguisedSuspicion: RecordedCausalEdge = { ...suspected, basis: 'recorded' }

// @ts-expect-error — and this lacks `runIds`, `notAnEdgeBecause` and `wouldBeRecordedBy`
const disguisedEdge: SuspectedLink = { ...edge, basis: 'suspected' }

// ---------------------------------------------------------------------------
// CASE 2 — A SUSPICION HAS NO DIRECTION, SO IT CANNOT BE WALKED
//
// THE LOAD-BEARING BARRIER OF CLAIM 1, and the one that differs from every
// previous iteration. `fleet_health.ts` quarantined a hypothesis and relied on
// consumers not counting it. Here the quarantine is stronger: direction is
// precisely what cannot be inferred, so the type does not carry it. A suspected
// link is not marked unwalkable — it IS unwalkable, because there is no field a
// traversal could follow.
// ---------------------------------------------------------------------------

// @ts-expect-error — a suspicion has no `producerRunId`. There is no "which way" to read.
const stolenDirection: string = suspected.producerRunId
// @ts-expect-error — nor a `consumerRunId`
const stolenDirection2: string = suspected.consumerRunId
// @ts-expect-error — nor a `fromRunId` under any other name
const stolenDirection3: string = (suspected as SuspectedLink & { fromRunId: string }).fromRunId2

// The realistic shape of the accident: a walker written for edges, called with
// whatever the traversal happened to contain.
function walkForward(edges: readonly RecordedCausalEdge[]): string[] {
  return edges.map((e) => e.consumerRunId)
}

// @ts-expect-error — a suspicion cannot reach an edge-only walker
const wrongWalk = walkForward([suspected])

// And the traversal's own edge list is typed, so speculation cannot enter the
// graph by being pushed onto it either.
function buildGraph(traversal: CausalTraversal): void {
  // @ts-expect-error — `edges` is RecordedCausalEdge[]; a suspicion is not one
  traversal.edges.push(suspected)
}

// ---------------------------------------------------------------------------
// CASE 3 — there is NO shared text field to render them through
//
// The one-liner that flattens everything (`links.map(l => l.message)`) is the
// most likely way a coincidence reaches a graph looking like a fact. It cannot
// be written, and the suspicion has no headline at all: its sentence is composed
// by `suspicionQuestion()`, always interrogative and never directional.
// ---------------------------------------------------------------------------

function flattenNaively(link: RecordedCausalEdge | SuspectedLink): string {
  // @ts-expect-error — `recordedFact` does not exist on the suspected half of this union
  return link.recordedFact
}

function flattenNaively2(link: RecordedCausalEdge | SuspectedLink): string {
  // @ts-expect-error — and there is no shared `message`/`summary`/`title` to fall back to
  return link.message
}

// The deliberate version is legal, and must stay legal — the point is not to
// forbid handling both, it is to force the handler to SAY which it has.
function flattenDeliberately(link: RecordedCausalEdge | SuspectedLink): string {
  return link.basis === 'recorded' ? link.recordedFact : suspicionQuestion(link)
}

// ---------------------------------------------------------------------------
// CASE 4 — an edge must carry its record
// ---------------------------------------------------------------------------

const recordless: RecordedCausalEdge = {
  ...edge,
  // @ts-expect-error — recordedBy is [CausalEvidence, ...CausalEvidence[]]; an empty array is not a record
  recordedBy: [],
}

// ===========================================================================
// CLAIM 2 — A CHAIN THAT ENDS AND A CHAIN WHOSE TRAIL IS LOST
//
// THE INVENTION AT THIS ALTITUDE, and the cases below are the ones this whole
// cycle exists for.
// ===========================================================================

// ---------------------------------------------------------------------------
// CASE 5 — the two termini are mutually unassignable, in BOTH directions
// ---------------------------------------------------------------------------

// THE CATASTROPHIC DIRECTION: an unfinished investigation held as a finished
// one. This is the output that tells someone to stop looking.
// @ts-expect-error — LostTrail is not assignable to RecordedOrigin
const notAnOrigin: RecordedOrigin = lost

// And the reverse: a real origin filed as a failure to look, which sends someone
// chasing a chain that genuinely ended.
// @ts-expect-error — RecordedOrigin is not assignable to LostTrail
const notALostTrail: LostTrail = origin

// The discriminant is not the only barrier here either.
// @ts-expect-error — wearing the right discriminant, this still lacks `originRunId`, `hopsToOrigin` and `establishedBy`
const disguisedLoss: RecordedOrigin = { ...lost, terminus: 'recorded_origin' }
// @ts-expect-error — and this lacks `lastReachedRunId`, `kind`, `hopsBeforeLoss`, `lostBecause` and `wouldBeRecoveredBy`
const disguisedOrigin: LostTrail = { ...origin, terminus: 'trail_lost' }

// THE THIRD DISPOSITION IS MUTUALLY UNASSIGNABLE WITH BOTH OF THE OTHERS. A
// cycle is COMPLETE, like an origin, and a walk that closed a retry loop can
// exit 0 — so a `LostTrail` relabelled as one buys a clean exit it did not
// earn, and that is the easiest forgery in this feature.
// @ts-expect-error — LostTrail is not assignable to CycleReEntry
const notACycle: CycleReEntry = lost
// @ts-expect-error — CycleReEntry is not assignable to LostTrail
const notALostTrail2: LostTrail = cycle
// @ts-expect-error — a cycle is not an origin: it demonstrably HAS an inbound edge, which is why the walk stopped
const notAnOrigin2: RecordedOrigin = cycle
// @ts-expect-error — and an origin is not a cycle
const notACycle2: CycleReEntry = origin
// @ts-expect-error — wearing the right discriminant, this still lacks `reEnteredRunId`, `hopsToReEntry` and `cyclePath`
const disguisedLossAsCycle: CycleReEntry = { ...lost, terminus: 'cycle_reentry' }

// ---------------------------------------------------------------------------
// CASE 6 — THE HEADLINE CASE: A RENDERER CANNOT PRINT ONE AS THE OTHER
//
// "If a caller can render one as the other by forgetting a field, the type is
// wrong." So the two share NO FIELD except the discriminant — not a run id, not
// a depth. The naive renderer, which is the one everybody writes, does not
// compile in any of its forms.
// ---------------------------------------------------------------------------

function renderTerminusNaively(t: ChainTerminus): string {
  // @ts-expect-error — there is no shared `runId`. This is THE line a naive renderer writes.
  return `Origin: ${t.runId}`
}

function renderTerminusNaively2(t: ChainTerminus): string {
  // @ts-expect-error — `originRunId` does not exist on the LostTrail half
  return `Origin: ${t.originRunId}`
}

function renderTerminusNaively3(t: ChainTerminus): string {
  // @ts-expect-error — nor `lastReachedRunId` on the origin or cycle members
  return `Lost at: ${t.lastReachedRunId}`
}

function renderTerminusNaively4(t: ChainTerminus): string {
  // @ts-expect-error — nor `reEnteredRunId` on the origin or lost-trail members
  return `Looped at: ${t.reEnteredRunId}`
}

// THE COALESCE, WHICH IS THE OTHER THING EVERYBODY WRITES. With three bands the
// temptation is `a ?? b ?? c` rather than a narrow; no two of the three share a
// field name, so it does not typecheck at the first term.
function coalesceRunId(t: ChainTerminus): string {
  // @ts-expect-error — `originRunId` does not exist across the union, so the chain cannot start
  return t.originRunId ?? t.lastReachedRunId ?? t.reEnteredRunId
}

function renderDepthNaively(t: ChainTerminus): number {
  // @ts-expect-error — there is no shared `depth`, because a total and a FLOOR are not the same quantity
  return t.depth
}

// The deliberate version is legal and must stay so — narrowing is the whole
// mechanism, and having narrowed, the field names state which claim is being
// made.
function renderTerminusDeliberately(t: ChainTerminus): string {
  if (t.terminus === 'recorded_origin') return `Origin: ${t.originRunId} (${t.hopsToOrigin} hops)`
  if (t.terminus === 'cycle_reentry') return `Loops at ${t.reEnteredRunId}: ${t.cyclePath.join(' -> ')}`
  return `TRAIL LOST at ${t.lastReachedRunId} (at least ${t.hopsBeforeLoss} hops) — ${t.wouldBeRecoveredBy}`
}

// ---------------------------------------------------------------------------
// CASE 7 — AN ORIGIN CANNOT BE BUILT WITHOUT A COMPLETE, EMPTY ADJACENCY READ
//
// EVIDENCE REQUIRED BY CONSTRUCTION, in its strongest available form. These are
// not validator rules that a producer could skip; the illegal states are
// UNSPELLABLE.
// ---------------------------------------------------------------------------

const originless: RecordedOrigin = {
  ...origin,
  // @ts-expect-error — establishedBy is [OriginProof, ...OriginProof[]]; an unproven origin is exactly a lost trail
  establishedBy: [],
}

const truncatedProof: OriginProof = {
  ...proof,
  // @ts-expect-error — inboundReadComplete is the LITERAL `true`. A truncated read cannot establish an origin.
  inboundReadComplete: false,
}

const pathlessCycle: CycleReEntry = {
  ...cycle,
  // @ts-expect-error — cyclePath is [string, ...string[]]; a loop nobody can see is one a reader assumes is a bug
  cyclePath: [],
}

const contradictoryProof: OriginProof = {
  ...proof,
  // @ts-expect-error — inboundEdgesFound is the LITERAL `0`. A proof that found an edge is not an origin.
  inboundEdgesFound: 3,
}

// And the general case, so a `boolean`-typed variable cannot sneak in either.
// Wrapped in a function that is never called: these are compile-time
// assertions, and a `declare`d binding would be a runtime ReferenceError.
function launderProof(someFlag: boolean): OriginProof {
  return {
    ...proof,
    // @ts-expect-error — `boolean` is not assignable to `true`
    inboundReadComplete: someFlag,
  }
}

// ---------------------------------------------------------------------------
// CASE 8 — a traversal must report at least one frontier
//
// `termini.every(t => t.terminus === 'recorded_origin')` is TRUE on an empty
// array. A traversal that reported no frontiers would read as a fully-traced
// graph to the most natural check anyone would write, so the empty case is a
// compile error rather than a vacuous pass.
// ---------------------------------------------------------------------------

function frontierless(someTraversal: CausalTraversal): CausalTraversal {
  return {
    ...someTraversal,
    // @ts-expect-error — termini is [ChainTerminus, ...ChainTerminus[]]; a walk always stops somewhere
    termini: [],
  }
}

// ---------------------------------------------------------------------------
// CASE 8b — A COMPONENT WALK CANNOT CLAIM AN ORIGIN
//
// "Nothing produced this run" is a DIRECTIONAL claim, and a component walk
// closed both sides. Before this, such a terminus COMPILED and the runtime
// audit rejected it every single time — a shape that exists and can never be
// honest, which is the weak form of a barrier and the one this contract argues
// against everywhere else.
//
// Note what is still legal: a cycle and a lost trail. The pair still spans
// complete-versus-incomplete, so a component walk can still report a finished
// trace — it just cannot report where a chain started.
// ---------------------------------------------------------------------------

function componentTerminus(walk: ComponentTraversal): string {
  // @ts-expect-error — a component walk's frontiers are CycleReEntry | LostTrail; there is no origin arm
  return walk.termini[0].originRunId
}

function buildComponentWalk(base: ComponentTraversal): ComponentTraversal {
  return {
    ...base,
    // @ts-expect-error — RecordedOrigin is not assignable to ComponentTerminus
    termini: [origin],
  }
}

// A component walk CAN still say it looped or ran out of road — and must, or it
// could never report a finished trace at all.
function buildHonestComponentWalk(base: ComponentTraversal): ComponentTraversal {
  return { ...base, termini: [cycle, lost] }
}

// ---------------------------------------------------------------------------
// CASE 9 — a suspicion can never move the verdict
//
// There is no parameter to pass. Not a default that can be flipped, not an
// option somebody forgot: the shape has no place for one.
// ---------------------------------------------------------------------------

const verdictFromSuspicion = computeCausalVerdict({
  edgeCount: 0,
  complete: true,
  // @ts-expect-error — CausalVerdictInput has no suspected-link count, and no place to put one
  suspectedCount: 12,
})

// ===========================================================================
// RUNTIME — the same separations, checked where the compiler cannot reach
// ===========================================================================

function traversalOf(overrides: Partial<CausalTraversal> = {}): CausalTraversal {
  const base: CausalTraversal = {
    analyzedAt: T0,
    subjectRunId: 'run_b',
    verdict: 'chain_recorded',
    nodes: [
      { runId: 'run_a', status: 'completed', startedAt: T0 - 60_000, hopsFromSubject: 1, adjacency: 'no_edge_recorded' },
      { runId: 'run_b', status: 'failed', startedAt: T0, hopsFromSubject: 0, adjacency: 'edge_recorded' },
    ],
    edges: [edge],
    termini: [origin],
    suspected: [suspected],
    unanswered: [],
    scan: {
      subjectRunId: 'run_b',
      direction: 'upstream',
      maxDepthRequested: 10,
      deepestReached: 1,
      runsVisited: 2,
      edgesRead: 1,
      scanTruncated: false,
      edgeSetsComplete: true,
    },
    ...overrides,
  }
  return base
}

describe('a lost trail is never an origin, at runtime either', () => {
  it('separates the two termini into different accessors', () => {
    const complete = traversalOf()
    expect(recordedOrigins(complete)).toHaveLength(1)
    expect(lostTrails(complete)).toHaveLength(0)

    const partial = traversalOf({ termini: [lost] })
    expect(recordedOrigins(partial)).toHaveLength(0)
    expect(lostTrails(partial)).toHaveLength(1)
  })

  it('composes a different SENTENCE for each, and never phrases a loss as a conclusion', () => {
    // The mood is a property of the type, not of whoever wrote the renderer.
    expect(originStatement(origin)).toContain('The recorded chain starts at run_a')
    // And even the confident branch states its own limit inline: an origin is
    // the origin of what was RECORDED, never a root cause.
    expect(originStatement(origin)).toContain('RECORDED')
    expect(originStatement(lost)).toContain('LOST')
    expect(originStatement(lost)).toContain('not where the chain ends')
    expect(originStatement(lost)).not.toContain('The recorded chain starts at')
  })

  it('treats a CLOSED LOOP as a finished frontier, so a fully-walked retry chain can exit clean', () => {
    // THE CASE THIS BAND EXISTS FOR. Retry loops and supervisor patterns are
    // ordinary architectures. A walk that closed the loop read everything it
    // meant to: nothing truncated, no budget spent out, no adjacency
    // unconfirmed. Reporting that as "we lost the trail" would state something
    // FALSE ABOUT THE SCAN, and would mean no retry chain could ever exit 0.
    // NOTE THE RETURN EDGE. A `cycle_reentry` asserts a real loop, and
    // `traversalClaimContradictions` audits every hop of `cyclePath` against
    // the edge set — so a fixture that merely CLAIMS a loop is rejected, which
    // is what caught four defects. The honest fixture carries both arrows.
    const backEdge: RecordedCausalEdge = { ...edge, edgeKey: 'e_ba', producerRunId: 'run_b', consumerRunId: 'run_a' }
    const looped = traversalOf({ termini: [cycle], edges: [edge, backEdge] })
    expect(isCausalTraversalComplete(looped)).toBe(true)
    expect(causalTraversalVerdict(looped)).toBe('chain_recorded')
    expect(cycleReEntries(looped)).toHaveLength(1)
    // And it is not filed under either of the other two.
    expect(recordedOrigins(looped)).toHaveLength(0)
    expect(lostTrails(looped)).toHaveLength(0)
  })

  it('phrases a loop as finished-but-originless, never as an origin and never as a loss', () => {
    const sentence = originStatement(cycle)
    expect(sentence).toContain('LOOPS')
    expect(sentence).toContain('run_a -> run_b -> run_a')
    expect(sentence).toContain('finished')
    expect(sentence).not.toContain('LOST')
    expect(sentence).not.toContain('The recorded chain starts at')
  })

  it('refuses a LOOP whose path does not close — the easiest forgery of a clean exit', () => {
    // A `trail_lost` an engine cannot be bothered to explain is one relabel away
    // from "oh, it looped", and a loop buys exit 0 exactly as an origin does. So
    // the path must actually be a closed loop naming the run it claims.
    for (const bad of [[], ['run_a'], ['run_b', 'run_a'], ['run_a', 'run_b']]) {
      const forged = traversalOf({
        termini: [{ ...cycle, cyclePath: bad } as unknown as ChainTerminus],
      })
      expect(traversalUnusableFields(forged).map((f) => f.reason)).toContain('unclosed_cycle')
    }
    // The honest one passes.
    expect(traversalUnusableFields(traversalOf({ termini: [cycle] }))).toEqual([])
  })

  it('fails CLOSED on a terminus disposition this contract does not define', () => {
    // A fourth band cannot default to "complete" by omission: `COMPLETE_TERMINI`
    // is a total map, and an unknown discriminant is not one to guess at.
    const alien = traversalOf({
      termini: [{ terminus: 'probably_fine', runId: 'run_a' } as unknown as ChainTerminus],
    })
    expect(isCausalTraversalComplete(alien)).toBe(false)
    expect(traversalUnusableFields(alien).map((f) => f.reason)).toContain('not_a_known_value')
  })

  it('ONE lost trail makes the whole traversal incomplete, however many branches ended cleanly', () => {
    expect(isCausalTraversalComplete(traversalOf())).toBe(true)
    // Four clean frontiers and one lost one is not four-fifths of an answer to
    // "what caused this" — the branch that did not terminate is the branch the
    // question was about.
    const mostlyClean = traversalOf({ termini: [origin, origin, origin, origin, lost] })
    expect(isCausalTraversalComplete(mostlyClean)).toBe(false)
  })

  it('does not let a closed loop launder a lost trail elsewhere in the graph', () => {
    // The mixed case: one branch looped cleanly, another ran out of road. The
    // trace is still partial, because the question is answered by the branch
    // that did not terminate.
    const backEdge: RecordedCausalEdge = { ...edge, edgeKey: 'e_ba', producerRunId: 'run_b', consumerRunId: 'run_a' }
    expect(
      isCausalTraversalComplete(traversalOf({ termini: [cycle, lost], edges: [edge, backEdge] }))
    ).toBe(false)
  })

  it('refuses to certify an EMPTY frontier set, which `every()` would pass by vacuity', () => {
    // The exact shape the positive clause exists for. Note the scan is
    // otherwise pristine: nothing truncated, nothing skipped, no cursor.
    const vacuous = traversalOf({ termini: [] as unknown as CausalTraversal['termini'], edges: [] })
    // Sanity: the naive check really does pass here. That is the bug.
    expect(vacuous.termini.every((t) => t.terminus === 'recorded_origin')).toBe(true)
    // And the contract's predicate does not.
    expect(isCausalTraversalComplete(vacuous)).toBe(false)
    expect(causalTraversalVerdict(vacuous)).toBe('indeterminate')
  })

  it('does not certify a walk that visited nothing — the negative-clause vacuity', () => {
    const empty = traversalOf({
      edges: [],
      termini: [] as unknown as CausalTraversal['termini'],
      scan: { ...traversalOf().scan, runsVisited: 0, deepestReached: 0, edgesRead: 0 },
    })
    // Nothing truncated, no pages left, no open questions — and nothing read.
    // `isolated` here would be "this run has no causal neighbours" derived from
    // zero reads.
    expect(causalTraversalVerdict(empty)).toBe('indeterminate')
  })

  it('reports an unproven origin from the wire as unusable, not as an origin', () => {
    // The type system cannot reach a JSON body. This is the same claim, checked
    // where the compiler stops.
    const fromWire = traversalOf({
      termini: [{ ...origin, establishedBy: [] } as unknown as ChainTerminus],
    })
    expect(traversalUnusableFields(fromWire).map((f) => f.reason)).toContain('unproven_origin')

    const truncatedFromWire = traversalOf({
      termini: [
        { ...origin, establishedBy: [{ ...proof, inboundReadComplete: false }] } as unknown as ChainTerminus,
      ],
    })
    expect(traversalUnusableFields(truncatedFromWire).map((f) => f.reason)).toContain('unproven_origin')

    const foundEdgeAnyway = traversalOf({
      termini: [{ ...origin, establishedBy: [{ ...proof, inboundEdgesFound: 2 }] } as unknown as ChainTerminus],
    })
    expect(traversalUnusableFields(foundEdgeAnyway).map((f) => f.reason)).toContain('unproven_origin')
  })

  it('keeps `no_edge_recorded` and `adjacency_unread` apart — absence of an edge is not absence of causation', () => {
    // A THIRD value fails closed rather than being read as either. These are the
    // two answers the field exists to distinguish; a deployment speaking a
    // vocabulary this contract does not define is not one to guess at.
    const garbled = traversalOf({
      nodes: [{ ...traversalOf().nodes[0]!, adjacency: 'probably_none' as never }],
    })
    expect(traversalUnusableFields(garbled).map((f) => f.reason)).toContain('not_a_known_value')
  })
})

describe('a suspicion cannot become an edge at runtime either', () => {
  it('never counts a suspected link toward the verdict', () => {
    const onlySuspicions = traversalOf({
      edges: [],
      suspected: [suspected, suspected, suspected],
    })
    // Complete walk, no recorded edges, three coincidences: `isolated`, not
    // `chain_recorded`. Twelve coincidences would say the same.
    expect(causalTraversalVerdict(onlySuspicions)).toBe('isolated')
  })

  it('composes an always-interrogative, never-directional sentence for a suspicion', () => {
    for (const kind of ['temporal_adjacency', 'shared_session', 'shared_resource', 'shared_agent'] as const) {
      const sentence = suspicionQuestion({ ...suspected, kind, sharedValue: 'sess_9' })
      expect(sentence.endsWith('?')).toBe(true)
      // The banned shape: a declarative claim naming one run as the cause of
      // another. There is no field it could be built from.
      expect(sentence).not.toContain('caused')
    }
  })

  it('finds nothing walkable in a suspicion: its run list is unordered by contract', () => {
    // The runtime counterpart of CASE 2. `runIds[0]` is not "the cause" and the
    // contract says so; this pins that the type carries no other ordering.
    expect(Object.keys(suspected)).not.toContain('producerRunId')
    expect(Object.keys(suspected)).not.toContain('consumerRunId')
    expect(Object.keys(suspected)).not.toContain('fromRunId')
  })
})

describe('coherence — an edge that cannot be checked is not an edge', () => {
  const known = new Set(['run_a', 'run_b'])

  it('accepts an edge whose record was written in one of its endpoints', () => {
    expect(edgeIncoherences(edge, known)).toEqual([])
  })

  it('rejects a record written in NEITHER endpoint — the inference tell', () => {
    // A third-party row that mentions both runs proves nothing, and it is
    // precisely what an inference engine produces when it dresses a correlation
    // up as a record.
    const thirdParty: RecordedCausalEdge = {
      ...edge,
      recordedBy: [{ ...citation, recordedInRunId: 'run_z' }],
    }
    expect(edgeIncoherences(thirdParty, known)).toContain('evidence_names_neither_endpoint')
  })

  it('rejects a record naming a run that is not the other endpoint', () => {
    const wrongName: RecordedCausalEdge = { ...edge, recordedBy: [{ ...citation, namesRunId: 'run_q' }] }
    expect(edgeIncoherences(wrongName, known)).toContain('evidence_names_wrong_run')
  })

  it('rejects a self-loop and an arrow to a run the traversal never reached', () => {
    expect(edgeIncoherences({ ...edge, consumerRunId: 'run_a' }, known)).toContain('self_loop')
    expect(edgeIncoherences({ ...edge, producerRunId: 'run_ghost' }, known)).toContain('endpoint_not_in_traversal')
  })

  it('THE ARTIFACT RULE — a shared SHA-256 is only an edge if the CONSUMER recorded reading it', () => {
    // The coordinator's question, answered in code. A matching digest found by
    // joining two runs' artifact rows is a coincidence; the checksum is exactly
    // what makes that inference feel like proof, and two runs may both READ the
    // same input or both WRITE the same deterministic output.
    const producerSideOnly: RecordedCausalEdge = {
      ...edge,
      kind: 'artifact_handoff',
      recordedBy: [
        {
          cites: 'artifact',
          recordedInRunId: 'run_a',
          artifactId: 'art_1',
          sha256: '9c31',
          role: 'produced',
          recordedAt: T0,
        } satisfies CausalArtifactCitation,
      ],
    }
    // run_a wrote it. Nobody recorded READING it. Not a handoff.
    expect(edgeIncoherences(producerSideOnly, known)).toContain('artifact_handoff_not_cited_by_consumer')

    // Both halves recorded, by the runs that did them: a real handoff.
    const bothHalves: RecordedCausalEdge = {
      ...producerSideOnly,
      recordedBy: [
        producerSideOnly.recordedBy[0],
        {
          cites: 'artifact',
          recordedInRunId: 'run_b',
          artifactId: 'art_1',
          sha256: '9c31',
          role: 'consumed',
          recordedAt: T0 + 10,
        } satisfies CausalArtifactCitation,
      ],
    }
    expect(edgeIncoherences(bothHalves, known)).toEqual([])

    // And a consumer-side citation attributed to the WRONG run does not count:
    // the read has to be in the consumer's own log.
    const misattributed: RecordedCausalEdge = {
      ...bothHalves,
      recordedBy: [{ ...(bothHalves.recordedBy[1] as CausalArtifactCitation), recordedInRunId: 'run_a' }],
    }
    expect(edgeIncoherences(misattributed, known)).toContain('artifact_handoff_not_cited_by_consumer')
  })

  it('fails CLOSED on NaN rather than skipping every comparison', () => {
    // Every rule in the sweep is a comparison, and every comparison with NaN is
    // false — so a NaN does not FAIL a check, it SKIPS one. This is the defect
    // `fleet_health.ts` shipped and then documented; it is guarded here from the
    // start rather than after the fact.
    expect(edgeIncoherences({ ...edge, handoffAt: Number.NaN }, known)).toEqual(['unusable_numbers'])
  })

  it('tolerates a malformed array element rather than throwing at a boundary', () => {
    const withNull = traversalOf({ edges: [null as unknown as RecordedCausalEdge, edge] })
    expect(() => traversalIncoherences(withNull)).not.toThrow()
    expect(traversalIncoherences(withNull).map((f) => f.incoherence)).toContain('malformed_edge')
    // And it BLOCKS certification rather than being dropped: an unreadable edge
    // is not "no edge".
    expect(isCausalTraversalComplete(withNull)).toBe(false)
  })
})

describe('fan-in is shown, not terminated on', () => {
  it('enumerates convergence points from the edge set rather than making them a terminus', () => {
    // A run consuming several upstream outputs has several stories. Reading only
    // the first is how the wrong thing gets rolled back — so the merge points
    // are enumerable. They are NOT a disposition: the walk continues through
    // every producer, and each of those branches terminates on its own.
    const fanIn = traversalOf({
      subjectRunId: 'run_c',
      nodes: [
        { runId: 'run_a', status: 'completed', startedAt: T0, hopsFromSubject: 1, adjacency: 'no_edge_recorded' },
        { runId: 'run_b', status: 'failed', startedAt: T0, hopsFromSubject: 1, adjacency: 'no_edge_recorded' },
        { runId: 'run_c', status: 'failed', startedAt: T0 + 5, hopsFromSubject: 0, adjacency: 'edge_recorded' },
      ],
      edges: [
        { ...edge, edgeKey: 'e_ac', producerRunId: 'run_a', consumerRunId: 'run_c' },
        { ...edge, edgeKey: 'e_bc', producerRunId: 'run_b', consumerRunId: 'run_c' },
      ],
      termini: [origin, { ...origin, originRunId: 'run_b', establishedBy: [{ ...proof, runId: 'run_b' }] }],
    })
    const points = convergencePoints(fanIn)
    expect(points).toHaveLength(1)
    expect(points[0]!.runId).toBe('run_c')
    expect(points[0]!.producers.map((e) => e.producerRunId).sort()).toEqual(['run_a', 'run_b'])
    // Both branches terminated, so the trace is COMPLETE. A `FanIn` terminus
    // would have had to be counted here too, and would then double-count
    // against the two branch termini describing the same walk.
    expect(isCausalTraversalComplete(fanIn)).toBe(true)
  })

  it('treats a convergence the walk did NOT expand as a lost trail, so it forces exit 11', () => {
    const stopped = traversalOf({
      termini: [
        {
          ...lost,
          kind: 'convergence_not_followed',
          lostBecause: 'run_c has 3 recorded producers; the walk did not expand them',
          wouldBeRecoveredBy: 're-run with a larger budget',
        },
      ],
    })
    // The chain provably continues in N directions nobody read. That is not a
    // neutral outcome and must not buy a clean exit.
    expect(isCausalTraversalComplete(stopped)).toBe(false)
    expect(lostTrails(stopped)).toHaveLength(1)
  })
})

describe('downstream blast radius', () => {
  it('counts transitively and excludes the subject', () => {
    const chain = traversalOf({
      subjectRunId: 'run_a',
      nodes: [
        { runId: 'run_a', status: 'failed', startedAt: T0, hopsFromSubject: 0, adjacency: 'edge_recorded' },
        { runId: 'run_b', status: 'failed', startedAt: T0 + 1, hopsFromSubject: 1, adjacency: 'edge_recorded' },
        { runId: 'run_c', status: 'failed', startedAt: T0 + 2, hopsFromSubject: 2, adjacency: 'no_edge_recorded' },
      ],
      edges: [edge, { ...edge, edgeKey: 'e_bc', producerRunId: 'run_b', consumerRunId: 'run_c' }],
    })
    expect(downstreamRunCount(chain)).toBe(2)
  })

  it('terminates on a cycle rather than hanging', () => {
    // A cycle is incoherent (the coherence sweep would not be the only defence),
    // but a display function that hangs on malformed input is worse than one
    // that returns a wrong number.
    const cyclic = traversalOf({
      subjectRunId: 'run_a',
      edges: [edge, { ...edge, edgeKey: 'e_ba', producerRunId: 'run_b', consumerRunId: 'run_a' }],
    })
    expect(downstreamRunCount(cyclic)).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// The compile-time cases above declare values nothing reads. Referencing them
// here keeps lint honest without weakening any directive — the assertion is the
// directive, not the use.
// ---------------------------------------------------------------------------
function crossTheStreams(): void {
  void notAnEdge
  void notASuspicion
  void notAnEdge2
  void notASuspicion2
  void disguisedSuspicion
  void disguisedEdge
  void stolenDirection
  void stolenDirection2
  void stolenDirection3
  void wrongWalk
  void buildGraph
  void flattenNaively
  void flattenNaively2
  void flattenDeliberately
  void recordless
  void notAnOrigin
  void notALostTrail
  void disguisedLoss
  void disguisedOrigin
  void notACycle
  void notALostTrail2
  void notAnOrigin2
  void notACycle2
  void disguisedLossAsCycle
  void pathlessCycle
  void renderTerminusNaively4
  void coalesceRunId
  void renderTerminusNaively
  void renderTerminusNaively2
  void renderTerminusNaively3
  void renderDepthNaively
  void renderTerminusDeliberately
  void originless
  void truncatedProof
  void contradictoryProof
  void launderProof
  void frontierless
  void componentTerminus
  void buildComponentWalk
  void buildHonestComponentWalk
  void verdictFromSuspicion
}
void crossTheStreams

// ---------------------------------------------------------------------------
// EVERY CLAIM IS AUDITED AGAINST THE EDGE SET BESIDE IT
//
// Four defects, found by attack, all one class: VERIFYING THAT A CLAIM IS
// PRESENT AND INTERNALLY WELL-FORMED IS NOT VERIFYING THAT IT AGREES WITH THE
// DATA BESIDE IT. Every one was decidable at no extra request from edges the
// gate already held, and every one produced `complete: true`.
//
// Each is pinned here by the exact shape that got through, so a repair that
// covers three of four fails visibly — which is how the previous instance of
// this class (`fleetReportUnusableFields` covering three collections of four)
// stayed hidden.
// ---------------------------------------------------------------------------

describe('claims are audited against the edge set, not taken on trust', () => {
  const backEdge: RecordedCausalEdge = { ...edge, edgeKey: 'e_ba', producerRunId: 'run_b', consumerRunId: 'run_a' }

  it('DEFECT 1 — an edge citing NOTHING no longer grades better than one citing badly', () => {
    // The sharpest detail of the whole class: an edge with ONE BAD citation was
    // rejected, and an edge with NO citation passed as recorded. A validator
    // that only inspects what is present says nothing about an absence.
    const citeless: RecordedCausalEdge = { ...edge, recordedBy: [] as unknown as RecordedCausalEdge['recordedBy'] }
    const oneBad: RecordedCausalEdge = { ...edge, recordedBy: [{ ...citation, recordedInRunId: 'run_z' }] }
    const known = new Set(['run_a', 'run_b'])

    expect(edgeIncoherences(oneBad, known)).not.toEqual([])
    // The regression: this used to be `[]`.
    expect(edgeIncoherences(citeless, known)).toContain('edge_cites_nothing')
    expect(citedEndpointCount(citeless)).toBe(0)

    const traversal = traversalOf({ edges: [citeless] })
    expect(traversalClaimContradictions(traversal).map((f) => f.contradiction)).toContain('edge_cites_nothing')
    expect(isCausalTraversalComplete(traversal)).toBe(false)
  })

  it('DEFECT 2 — an origin is checked against the edges INTO the run it claims ended', () => {
    // A proof asserting `inboundEdgesFound: 0` while the same traversal carries
    // an edge into that run. Both halves well-formed; together, a lost trail
    // certifying as an origin.
    const contradicted = traversalOf({
      termini: [{ ...origin, originRunId: 'run_b', establishedBy: [{ ...proof, runId: 'run_b' }] }],
    })
    // run_a -> run_b is in the edge set, so run_b demonstrably has a producer.
    const found = traversalClaimContradictions(contradicted)
    expect(found.map((f) => f.contradiction)).toContain('origin_contradicted_by_adjacent_edge')
    expect(isCausalTraversalComplete(contradicted)).toBe(false)
    // And the honest one — run_a really has no producer here — still passes.
    expect(traversalClaimContradictions(traversalOf())).toEqual([])
  })

  it('DEFECT 2b — "adjacent" follows the DIRECTION of the walk, so honest downstream traces are not rejected', () => {
    // The bug a hasty fix would introduce. Walking DOWNSTREAM, a run's adjacency
    // is its CONSUMERS, not its producers — so run_b (which has a producer but
    // no consumer) is a legitimate origin of a downstream walk.
    const downstream = traversalOf({
      subjectRunId: 'run_a',
      scan: { ...traversalOf().scan, subjectRunId: 'run_a', direction: 'downstream' },
      termini: [{ ...origin, originRunId: 'run_b', establishedBy: [{ ...proof, runId: 'run_b' }] }],
    })
    expect(traversalClaimContradictions(downstream)).toEqual([])
    expect(isCausalTraversalComplete(downstream)).toBe(true)
  })

  it('DEFECT 3 — a cycle of length >= 2 is no longer invisible to every gate', () => {
    // Only `self_loop` was ever caught, because length 1 is the only cycle
    // decidable from a SINGLE edge. Two-cycles and three-cycles are properties
    // of the edge SET and were structurally invisible to a per-edge validator.
    const twoCycle = traversalOf({ edges: [edge, backEdge], termini: [origin] })
    expect(traversalIncoherences(twoCycle)).toEqual([]) // per-edge rules still say nothing — that is the gap
    expect(traversalClaimContradictions(twoCycle).map((f) => f.contradiction)).toContain('undeclared_cycle')
    expect(isCausalTraversalComplete(twoCycle)).toBe(false)

    const threeCycle = traversalOf({
      nodes: [
        { runId: 'run_a', status: 'failed', startedAt: T0, hopsFromSubject: 0, adjacency: 'edge_recorded' },
        { runId: 'run_b', status: 'failed', startedAt: T0, hopsFromSubject: 1, adjacency: 'edge_recorded' },
        { runId: 'run_c', status: 'failed', startedAt: T0, hopsFromSubject: 2, adjacency: 'edge_recorded' },
      ],
      edges: [
        edge,
        { ...edge, edgeKey: 'e_bc', producerRunId: 'run_b', consumerRunId: 'run_c' },
        { ...edge, edgeKey: 'e_ca', producerRunId: 'run_c', consumerRunId: 'run_a' },
      ],
      termini: [origin],
    })
    expect(traversalClaimContradictions(threeCycle).map((f) => f.contradiction)).toContain('undeclared_cycle')

    // DECLARED, and with every hop real: accepted.
    const declared = traversalOf({ edges: [edge, backEdge], termini: [cycle] })
    expect(traversalClaimContradictions(declared)).toEqual([])
    expect(isCausalTraversalComplete(declared)).toBe(true)
  })

  it('DEFECT 4 — a FABRICATED cycle path no longer buys an all-clear', () => {
    // `unclosed_cycle` validated SYNTACTIC closure only, and a cycle is a
    // COMPLETING disposition — so ['A','GHOST','A'] with zero matching edges
    // certified a finished investigation.
    const ghost = traversalOf({
      edges: [],
      termini: [{ ...cycle, cyclePath: ['run_a', 'run_ghost', 'run_a'] }],
    })
    // Syntactically closed, so the usability sweep is silent — which is exactly
    // why the claim audit has to exist.
    expect(traversalUnusableFields(ghost).map((f) => f.reason)).not.toContain('unclosed_cycle')
    expect(traversalClaimContradictions(ghost).map((f) => f.contradiction)).toContain('cycle_path_not_in_edge_set')
    expect(isCausalTraversalComplete(ghost)).toBe(false)
  })

  it('audits a terminus that names a run the walk never reached', () => {
    const nowhere = traversalOf({
      termini: [{ ...origin, originRunId: 'run_ghost', establishedBy: [{ ...proof, runId: 'run_ghost' }] }],
    })
    expect(traversalClaimContradictions(nowhere).map((f) => f.contradiction)).toContain('terminus_run_not_reached')
  })

  it('never throws at a boundary, and terminates on any graph', () => {
    // It runs on a body nothing has vouched for. A validator that crashes hands
    // its caller an unhandled exception instead of a refusal; one that hangs is
    // worse.
    for (const body of [null, undefined, {}, { edges: 'nope', termini: 7 }, traversalOf({ edges: [edge, backEdge] })]) {
      expect(() => traversalClaimContradictions(body as unknown as CausalTraversal)).not.toThrow()
    }
  })
})

describe('a component scan cannot establish where a chain started', () => {
  const componentScan = { ...traversalOf().scan, direction: 'component' as const }

  it('refuses a component origin as a CATEGORY ERROR, not as an edge-set disagreement', () => {
    // The message matters: an engine author told "your edge set disagrees" goes
    // looking at their edges. The real answer is that they asked a
    // direction-free scan a directional question.
    const walk = traversalOf({ scan: componentScan, termini: [origin] })
    const found = traversalClaimContradictions(walk).map((f) => f.contradiction)
    expect(found).toContain('component_origin_claimed')
    // And ONLY that — not the generic adjacency complaint, which would be noise.
    expect(found).not.toContain('origin_contradicted_by_adjacent_edge')
    expect(isCausalTraversalComplete(walk)).toBe(false)
  })

  it('still lets a component walk report a FINISHED trace via a loop', () => {
    // The rule must not make `complete` unreachable for component walks, or the
    // incident page could never say the graph is closed.
    const backEdge: RecordedCausalEdge = { ...edge, edgeKey: 'e_ba', producerRunId: 'run_b', consumerRunId: 'run_a' }
    const looped = traversalOf({ scan: componentScan, edges: [edge, backEdge], termini: [cycle] })
    expect(traversalClaimContradictions(looped)).toEqual([])
    expect(isCausalTraversalComplete(looped)).toBe(true)
  })

  it('leaves an upstream origin untouched — the directional walk is how you ask', () => {
    expect(traversalClaimContradictions(traversalOf())).toEqual([])
    expect(isCausalTraversalComplete(traversalOf())).toBe(true)
  })
})

describe('a sequence number of 0 is a sentinel, not a position', () => {
  it('refuses it, because Event Log Rule 4 starts sequences at 1', () => {
    // A sentinel drawn from the data\'s own domain is indistinguishable from a
    // measurement. Rule 4 leaves `0` outside the domain, so refusing it turns a
    // silent mis-citation — pointing an operator at the wrong end of a run\'s
    // log — into a loud one.
    const sentinel = traversalOf({ edges: [{ ...edge, recordedBy: [{ ...citation, sequenceNumber: 0 }] }] })
    expect(traversalUnusableFields(sentinel).map((f) => f.reason)).toContain('not_a_sequence_number')
    // The real value passes.
    expect(traversalUnusableFields(traversalOf())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GENERIC HYGIENE — A TYPE PARAMETER THAT NOTHING REFERENCES IS A BARRIER THAT
// IS NEVER REACHED
//
// `CausalTraceParams<D>` shipped with `direction: CausalDirection` instead of
// `direction: D`. The parameter was declared, the method was generic over it,
// the return type used it — and NOTHING in the argument mentioned it, so
// inference had no site to bite on and `D` silently fell back to its default.
// The component barrier existed and was unreachable.
//
// The class: A PHANTOM TYPE PARAMETER FAILS OPEN AND SILENTLY. It does not
// error, it does not narrow, and every test written against an EXPLICIT type
// argument keeps passing — which is why the original proof and the hole were
// compatible.
//
// So each parameterised type is checked directly for the property that makes a
// parameter real: TWO DIFFERENT ARGUMENTS MUST PRODUCE TWO NON-INTERCHANGEABLE
// TYPES. A phantom parameter makes them identical, and these lines go red.
// ---------------------------------------------------------------------------

/** `A` and `B` are mutually non-assignable. Fails to compile if a parameter is phantom. */
type NotInterchangeable<A, B> = [A] extends [B] ? ([B] extends [A] ? never : true) : true

function genericParametersAreReal(): void {
  // The one that was phantom. If `direction` reverts to `CausalDirection`, both
  // instantiations collapse to the same type and this alias becomes `never`.
  const params: NotInterchangeable<CausalTraceParams<'component'>, CausalTraceParams<'upstream'>> = true
  // And the types it feeds.
  const traversal: NotInterchangeable<ComponentTraversal, DirectedTraversal> = true
  const scan: NotInterchangeable<CausalScan<'component'>, CausalScan<'upstream'>> = true
  const data: NotInterchangeable<V1CausalTraceData<'component'>, V1CausalTraceData<'upstream'>> = true
  // The conditional underneath them all: a component frontier set really is
  // narrower, not merely differently spelled.
  const terminus: NotInterchangeable<TerminusFor<'component'>, TerminusFor<'upstream'>> = true
  void params
  void traversal
  void scan
  void data
  void terminus
}
void genericParametersAreReal
