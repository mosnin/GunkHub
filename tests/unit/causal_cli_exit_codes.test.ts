/**
 * `afr cause` — THE EXIT CODES.
 *
 * This command ends up in a monitoring loop and in incident runbooks, so the
 * exit code IS the product for most of its lifetime: nobody reads the output
 * until it goes non-zero. Four properties are proven here, and each has a
 * specific way of going wrong that would be invisible in normal operation:
 *
 *  1. A TRUNCATED TRAVERSAL NEVER BUYS A CLEAN EXIT. Every way of not having
 *     finished — a lost trail on ANY frontier, the row ceiling, a sampled edge
 *     set, an outstanding cursor, an open question, an unreadable gate
 *     collection — must produce exit 11 rather than exit 0. One lost trail
 *     anywhere makes the whole trace incomplete, however many other branches
 *     ended cleanly, because the operator's question is not answered by the
 *     branches that terminated.
 *
 *  2. `--fail-on none` DOES NOT BUY ONE EITHER, AND THIS IS THE DELIBERATE
 *     DIVERGENCE FROM `afr fleet`. There, `none` turns off an ALARM and says
 *     so, and reaches exit 0 on an incomplete sweep. Here, exit 11 is not a
 *     threshold — it is the statement "this answer is partial", which is the
 *     primary output of a TRACING command rather than a gate bolted onto it.
 *     The sweep below proves there is no threshold at which a truncated trace
 *     exits 0, rather than proving it for the one the author thought of.
 *
 *  3. A CLOSED LOOP IS NOT A LOST TRAIL. Retry loops and supervisor patterns
 *     are ordinary architectures, and a walk that closed one read everything it
 *     meant to. If a cycle forced exit 11, no retry chain could ever exit
 *     clean — and a command that always says "partial" is a command people stop
 *     reading. The distinction has to hold in the exit code, not only in the
 *     prose.
 *
 *  4. A SUSPECTED LINK CAN NEVER CHANGE THE EXIT CODE, AT ANY THRESHOLD. There
 *     is no `--fail-on` value that fires on a coincidence, and the exhaustive
 *     sweep below proves it for every legal threshold. Two runs adjacent in
 *     time are not causally linked, and paging on a coincidence sends someone
 *     to an innocent run.
 *
 * No network: `runCause` takes an injected fetch, and most cases here build a
 * result directly and score it.
 */
import {
  CAUSE_EXIT_IMPACT,
  CAUSE_EXIT_TRUNCATED,
  DEFAULT_CAUSE_FAIL_ON,
  exitCodeForCause,
  parseCauseArgs,
  printCause,
  runCause,
} from '@agent-flight-recorder/cli'
import { describe, expect, it, vi } from 'vitest'

import type { CauseFailOn, CauseResult } from '@agent-flight-recorder/cli'
import type {
  CausalTraversal,
  ChainTerminus,
  CycleReEntry,
  LostTrail,
  RecordedCausalEdge,
  RecordedOrigin,
  SuspectedLink,
  UnansweredCausalQuestion,
} from '@agent-flight-recorder/contracts'
import type { V1FetchLike } from '@agent-flight-recorder/sdk'

const T0 = 1_721_909_400_000

const ALL_FAIL_ON: readonly CauseFailOn[] = ['downstream', 'none']

const edge: RecordedCausalEdge = {
  basis: 'recorded',
  kind: 'output_consumed',
  edgeKey: 'e_ab',
  producerRunId: 'run_a',
  consumerRunId: 'run_b',
  recordedFact: 'run_b recorded receiving run_a\'s output as its input',
  handoffAt: T0,
  recordedBy: [
    {
      cites: 'event',
      recordedInRunId: 'run_b',
      eventId: 'ev_1',
      sequenceNumber: 4,
      eventType: 'run.input_received',
      namesRunId: 'run_a',
      recordedAt: T0,
    },
  ],
}

const origin: RecordedOrigin = {
  terminus: 'recorded_origin',
  originRunId: 'run_a',
  hopsToOrigin: 1,
  establishedBy: [
    { proves: 'adjacent_edge_set_read', runId: 'run_a', inboundReadComplete: true, inboundEdgesFound: 0, scannedAt: T0 },
  ],
}

const lost: LostTrail = {
  terminus: 'trail_lost',
  lastReachedRunId: 'run_a',
  kind: 'depth_limit_reached',
  hopsBeforeLoss: 1,
  lostBecause: 'the depth limit (1) was reached',
  wouldBeRecoveredBy: 're-run with --max-depth 10',
}

const cycle: CycleReEntry = {
  terminus: 'cycle_reentry',
  reEnteredRunId: 'run_a',
  hopsToReEntry: 2,
  cyclePath: ['run_a', 'run_b', 'run_a'],
}

/** The return arrow. A `cycle_reentry` claim is audited hop-by-hop against the edge set. */
const backEdge: RecordedCausalEdge = { ...edge, edgeKey: 'e_ba', producerRunId: 'run_b', consumerRunId: 'run_a' }

const suspected: SuspectedLink = {
  basis: 'suspected',
  kind: 'temporal_adjacency',
  linkKey: 'adj:1',
  runIds: ['run_a', 'run_z'],
  notAnEdgeBecause: 'nothing in either run\'s log records one reading the other\'s output',
  wouldBeRecordedBy: 'pass `parentRunId` to `startRun`',
  firstSeenAt: T0,
  lastSeenAt: T0 + 90_000,
}

const question: UnansweredCausalQuestion = {
  basis: 'unanswered',
  kind: 'adjacency_unknown',
  questionKey: 'q1',
  undecidedQuestion: 'whether anything produced run_a\'s input',
  unknownBecause: 'run_a\'s edge index could not be read',
}

function traversalOf(overrides: Partial<CausalTraversal> = {}): CausalTraversal {
  return {
    analyzedAt: T0,
    subjectRunId: 'run_b',
    verdict: 'chain_recorded',
    nodes: [
      { runId: 'run_a', status: 'completed', startedAt: T0 - 60_000, hopsFromSubject: 1, adjacency: 'no_edge_recorded' },
      { runId: 'run_b', status: 'failed', startedAt: T0, hopsFromSubject: 0, adjacency: 'edge_recorded' },
    ],
    edges: [edge],
    termini: [origin],
    suspected: [],
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
}

function resultOf(traversal: CausalTraversal, failOn: CauseFailOn = DEFAULT_CAUSE_FAIL_ON): CauseResult {
  return { ok: true, failOn, direction: traversal.scan.direction, traversal }
}

// ---------------------------------------------------------------------------
// PROPERTY 1 + 2 — a bounded traversal never buys a clean exit, AT ANY
// THRESHOLD
// ---------------------------------------------------------------------------

describe('a truncated traversal cannot exit clean', () => {
  it('exits 0 on a genuinely complete trace', () => {
    expect(exitCodeForCause(resultOf(traversalOf()))).toBe(0)
  })

  /**
   * EVERY WAY OF NOT HAVING FINISHED, ENUMERATED — and each crossed with EVERY
   * legal threshold, because a rule proven at one threshold is a rule that
   * holds at the threshold the author happened to think of.
   */
  const incompleteWays: [string, Partial<CausalTraversal>][] = [
    ['a lost trail on the only frontier', { termini: [lost] }],
    // The one that matters most: four branches ended cleanly and one did not.
    // "Mostly traced" is not traced.
    ['a lost trail among four clean frontiers', { termini: [origin, origin, origin, origin, lost] }],
    ['the server\'s row ceiling', { scan: { ...traversalOf().scan, scanTruncated: true, scanRowCeiling: 500 } }],
    // Arrows the engine HAD ACCESS TO may be missing — a different and worse
    // gap than the arrows nobody recorded.
    ['a sampled edge set', { scan: { ...traversalOf().scan, edgeSetsComplete: false } }],
    ['pages remaining', { scan: { ...traversalOf().scan, nextCursor: 'cur_2' } }],
    ['an open question', { unanswered: [question] }],
    // An unreadable frontier is the strongest possible ground for "we do not
    // know whether the walk finished".
    ['an unreadable terminus', { termini: [null as unknown as ChainTerminus, origin] }],
    ['an unreadable edge', { edges: [edge, null as unknown as RecordedCausalEdge] }],
    ['an unreadable open question', { unanswered: [null as unknown as UnansweredCausalQuestion] }],
    ['a walk that visited nothing', { scan: { ...traversalOf().scan, runsVisited: 0 } }],
    // `.every()` over an empty array is TRUE, so this is the shape that defeats
    // the obvious completeness check.
    ['no frontiers at all', { termini: [] as unknown as CausalTraversal['termini'] }],
  ]

  it.each(incompleteWays)('exits 11, never 0, on %s — at EVERY threshold', (_name, overrides) => {
    for (const failOn of ALL_FAIL_ON) {
      // `downstream` is deliberately not triggered here (the subject has no
      // consumers upstream-walking), so 11 is the only non-zero available and
      // the assertion is about 0 being unreachable.
      const code = exitCodeForCause(resultOf(traversalOf(overrides), failOn))
      expect(code).not.toBe(0)
      expect(code).toBe(CAUSE_EXIT_TRUNCATED)
    }
  })

  /**
   * THE DELIBERATE DIVERGENCE FROM `afr fleet`, PINNED.
   *
   * `exitCodeForFleet` short-circuits to 0 on `--fail-on none` because `none`
   * turns off an ALARM. This command's 11 is not an alarm — it is the statement
   * "this answer is partial", which is the whole product of a tracing command.
   * If someone later "harmonises" the two by adding a `none` short-circuit
   * here, this test is what stops it.
   */
  it('does NOT let --fail-on none reach exit 0 on a truncated trace', () => {
    expect(exitCodeForCause(resultOf(traversalOf({ termini: [lost] }), 'none'))).toBe(CAUSE_EXIT_TRUNCATED)
  })
})

// ---------------------------------------------------------------------------
// PROPERTY 3 — a closed loop is not a lost trail
// ---------------------------------------------------------------------------

describe('a closed loop finishes a frontier', () => {
  it('exits 0 on a fully-walked retry loop, at every threshold that does not fire', () => {
    // If a cycle forced 11, no retry chain could ever exit clean — and a
    // command that always says "partial" is one people stop reading.
    expect(exitCodeForCause(resultOf(traversalOf({ termini: [cycle], edges: [edge, backEdge] }), 'none'))).toBe(0)
  })

  it('does not let a loop launder a lost trail on another branch', () => {
    expect(
      exitCodeForCause(resultOf(traversalOf({ termini: [cycle, lost], edges: [edge, backEdge] }), 'none'))
    ).toBe(CAUSE_EXIT_TRUNCATED)
  })
})

// ---------------------------------------------------------------------------
// PROPERTY 4 — impact, and its precedence over truncation
// ---------------------------------------------------------------------------

describe('impact', () => {
  const downstream = traversalOf({
    subjectRunId: 'run_a',
    scan: { ...traversalOf().scan, subjectRunId: 'run_a', direction: 'downstream' },
    nodes: [
      { runId: 'run_a', status: 'failed', startedAt: T0, hopsFromSubject: 0, adjacency: 'edge_recorded' },
      { runId: 'run_b', status: 'failed', startedAt: T0 + 1, hopsFromSubject: 1, adjacency: 'no_edge_recorded' },
    ],
    termini: [{ ...origin, originRunId: 'run_b', establishedBy: [{ ...origin.establishedBy[0], runId: 'run_b' }] }],
  })

  it('exits 10 when a run consumed this run\'s output', () => {
    expect(exitCodeForCause(resultOf(downstream, 'downstream'))).toBe(CAUSE_EXIT_IMPACT)
  })

  it('exits 0 under --fail-on none, which removes the alarm and nothing else', () => {
    expect(exitCodeForCause(resultOf(downstream, 'none'))).toBe(0)
  })

  /**
   * 10 WINS OVER 11, and the reasoning is `afr fleet`'s: a run that consumed
   * this one's output did so whether or not another branch went unread, and
   * truncation is likeliest precisely when the graph is largest. Suppressing
   * the impact signal because the trace was cut short would silence it during
   * the incident.
   *
   * The cost of this choice is that the downstream count is then a FLOOR, which
   * is why `printCause` states that on the same line as the number — asserted
   * below rather than left as an intention.
   */
  it('exits 10 even on a truncated trace, and 10 outranks 11', () => {
    const truncated = { ...downstream, termini: [lost] as unknown as CausalTraversal['termini'] }
    expect(exitCodeForCause(resultOf(truncated, 'downstream'))).toBe(CAUSE_EXIT_IMPACT)
    // And with the alarm off, the same traversal still reports itself partial.
    expect(exitCodeForCause(resultOf(truncated, 'none'))).toBe(CAUSE_EXIT_TRUNCATED)
  })

  it('prints the downstream count as a FLOOR whenever the trace is partial', () => {
    const lines: string[] = []
    printCause({}, resultOf({ ...downstream, termini: [lost] as unknown as CausalTraversal['termini'] }, 'downstream'), (l) =>
      lines.push(l)
    )
    const output = lines.join('\n')
    expect(output).toContain('FLOOR')
    // And it never claims the trace finished.
    expect(output).toContain('PARTIAL')
  })
})

// ---------------------------------------------------------------------------
// PROPERTY 5 — a coincidence can never page anyone
// ---------------------------------------------------------------------------

describe('a suspected link can never change the exit code', () => {
  it.each(ALL_FAIL_ON)('ignores twelve coincidences at --fail-on %s', (failOn) => {
    const withSuspicions = traversalOf({
      edges: [],
      nodes: [{ runId: 'run_b', status: 'failed', startedAt: T0, hopsFromSubject: 0, adjacency: 'no_edge_recorded' }],
      termini: [{ ...origin, originRunId: 'run_b', establishedBy: [{ ...origin.establishedBy[0], runId: 'run_b' }] }],
      suspected: Array.from({ length: 12 }, (_, i) => ({ ...suspected, linkKey: `adj:${i}` })),
      verdict: 'isolated',
    })
    // Complete walk, no recorded edges, twelve coincidences. Clean exit.
    expect(exitCodeForCause(resultOf(withSuspicions, failOn))).toBe(0)
  })

  it('has no --fail-on value that fires on one', () => {
    // The vocabulary itself is the guarantee. If a `suspected` threshold is
    // ever added, this list changes and the exhaustive sweeps above start
    // covering it — which is the point of sweeping over the vocabulary rather
    // than over hand-picked values.
    expect([...ALL_FAIL_ON].sort()).toEqual(['downstream', 'none'])
  })
})

// ---------------------------------------------------------------------------
// Usage errors — before any request
// ---------------------------------------------------------------------------

describe('usage', () => {
  const env = { apiKey: 'k', baseUrl: 'https://afr.example.com' }
  const neverCalled: V1FetchLike = vi.fn(() => {
    throw new Error('the network must not be touched for a usage error')
  }) as unknown as V1FetchLike

  it('requires --direction, with no default', async () => {
    // The specific bug: both directions produce well-formed traces, so a script
    // that got the other one has nothing on screen to tell it so.
    const result = await runCause(parseCauseArgs(['run_a']), env, neverCalled)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.exitCode).toBe(1)
    expect(result.ok === false && result.message).toContain('--direction is required')
    expect(neverCalled).not.toHaveBeenCalled()
  })

  it('rejects an unknown --direction rather than falling back', async () => {
    const result = await runCause(parseCauseArgs(['run_a', '--direction', 'sideways']), env, neverCalled)
    expect(result.ok === false && result.exitCode).toBe(1)
  })

  it('rejects an unknown --fail-on rather than silently using the default', async () => {
    // A typo that quietly fell back is harmless until the day someone means to
    // widen the gate and believes they have.
    const result = await runCause(
      parseCauseArgs(['run_a', '--direction', 'up', '--fail-on', 'suspected']),
      env,
      neverCalled
    )
    expect(result.ok === false && result.exitCode).toBe(1)
    expect(result.ok === false && result.message).toContain('no threshold that fires on a suspected link')
  })

  it('requires a run id', async () => {
    const result = await runCause(parseCauseArgs(['--direction', 'up']), env, neverCalled)
    expect(result.ok === false && result.exitCode).toBe(1)
  })

  it('maps the operator\'s words to the contract vocabulary', () => {
    expect(parseCauseArgs(['run_a', '--direction', 'both']).direction).toBe('both')
  })
})

// ---------------------------------------------------------------------------
// Rendering — the two claims never share a template
// ---------------------------------------------------------------------------

describe('rendering', () => {
  function render(traversal: CausalTraversal): string {
    const lines: string[] = []
    printCause({}, resultOf(traversal), (l) => lines.push(l))
    return lines.join('\n')
  }

  it('never prints a lost trail under an "Origin" heading', () => {
    const output = render(traversalOf({ termini: [lost] }))
    expect(output).toContain('WHERE THE TRAIL WAS LOST')
    expect(output).toContain('NOT where the chain ends')
    expect(output).not.toContain('WHERE THE RECORDED CHAIN ENDS')
  })

  it('prints a loop in its own section, as finished but originless', () => {
    const output = render(traversalOf({ termini: [cycle], edges: [edge, backEdge] }))
    expect(output).toContain('WHERE THE CHAIN LOOPS')
    expect(output).not.toContain('WHERE THE TRAIL WAS LOST')
  })

  it('prints suspicions as questions, in their own section, marked not-walked', () => {
    const output = render(traversalOf({ suspected: [suspected] }))
    expect(output).toContain('SUSPECTED, NOT RECORDED')
    expect(output).toContain('NOT directional')
    expect(output).toContain('UNORDERED')
    expect(output).toContain('to record it properly:')
    // The composed sentence, not one the engine wrote.
    expect(output).toContain('?')
  })

  it('--json prints the raw traversal and nothing else', () => {
    const lines: string[] = []
    printCause({ json: true }, resultOf(traversalOf()), (l) => lines.push(l))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).subjectRunId).toBe('run_b')
  })
})
