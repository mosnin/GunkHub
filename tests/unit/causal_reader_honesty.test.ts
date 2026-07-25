/**
 * `FlightReader.getCausalTrace` — THE CLIENT REFUSES RATHER THAN TRUSTS.
 *
 * The type system's guarantees stop at the wire. Everything
 * `packages/contracts/src/causality.ts` makes unspellable in our code —
 * a directed suspicion, an unproven origin, an edge with no record behind it —
 * a JSON body can express in one line, and every consumer downstream of this
 * method (the CLI, the MCP surface, the web, any SDK caller) receives raw
 * objects. So the segregation is re-checked here, at the one layer they all
 * pass through.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE FLEET GATE, WHICH IT IS MODELLED ON: a
 * causal traversal draws ARROWS. A wrong hypothesis on a fleet screen is read
 * with some scepticism because it is labelled a hypothesis; an arrow has no
 * label anyone reads. An operator follows it to a run, reads that run's logs,
 * and acts. So the cost of a fabricated edge is not a misleading dashboard, it
 * is an investigation that terminates on an innocent run while the actual cause
 * keeps running.
 *
 * SERVERS LIE BY OMISSION, and the two omissions that matter here are the ones
 * that make a partial answer look finished:
 *   - dropping a query parameter, so the walk answers a question nobody asked
 *     (including walking the OPPOSITE DIRECTION, which has no analogue anywhere
 *     else in this client);
 *   - serving a terminus that claims the investigation is over when nothing
 *     established that.
 *
 * Every case below is one where the wrong answer looks exactly like the right
 * one to a caller reading `traversal.edges.length` or reading the terminus
 * aloud. No network: an injected fetch returns the body under test.
 */
import { FlightReader, V1ApiError } from '@agent-flight-recorder/sdk'
import { describe, expect, it } from 'vitest'

import type {
  CausalTraceParams,
  ComponentTraversal,
  DirectedTraversal,
  RecordedOrigin,
  V1FetchLike,
} from '@agent-flight-recorder/sdk'

const T0 = 1_721_909_400_000
const CONFIG = { baseUrl: 'https://afr.example.com', apiKey: 'k_read' }
const PARAMS: CausalTraceParams = { runId: 'run_b', direction: 'upstream', maxDepth: 10 }

/** A body that passes every check. Each case below breaks exactly one thing. */
function soundTraversal(): Record<string, unknown> {
  return {
    analyzedAt: T0,
    subjectRunId: 'run_b',
    verdict: 'chain_recorded',
    nodes: [
      { runId: 'run_a', status: 'completed', startedAt: T0 - 60_000, hopsFromSubject: 1, adjacency: 'no_edge_recorded' },
      { runId: 'run_b', status: 'failed', startedAt: T0, hopsFromSubject: 0, adjacency: 'edge_recorded' },
    ],
    edges: [
      {
        basis: 'recorded',
        kind: 'output_consumed',
        edgeKey: 'e_ab',
        producerRunId: 'run_a',
        consumerRunId: 'run_b',
        recordedFact: 'run_b recorded receiving run_a\'s output',
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
      },
    ],
    termini: [
      {
        terminus: 'recorded_origin',
        originRunId: 'run_a',
        hopsToOrigin: 1,
        establishedBy: [
          {
            proves: 'adjacent_edge_set_read',
            runId: 'run_a',
            inboundReadComplete: true,
            inboundEdgesFound: 0,
            scannedAt: T0,
          },
        ],
      },
    ],
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
  }
}

/** Serve one body, over an injected fetch. Nothing here touches the network. */
function readerServing(traversal: unknown): FlightReader {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ apiVersion: 'v1', data: { traversal } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as V1FetchLike
  return new FlightReader(CONFIG, fetchImpl)
}

/** A component walk whose frontier is an honestly closed loop — the shape a component walk CAN report. */
function componentBody(): Record<string, unknown> {
  const body = soundTraversal()
  ;(body.scan as Record<string, unknown>).direction = 'component'
  ;(body.edges as Record<string, unknown>[]).push({
    ...(body.edges as Record<string, unknown>[])[0],
    edgeKey: 'e_ba',
    producerRunId: 'run_b',
    consumerRunId: 'run_a',
  })
  body.termini = [
    { terminus: 'cycle_reentry', reEnteredRunId: 'run_a', hopsToReEntry: 2, cyclePath: ['run_a', 'run_b', 'run_a'] },
  ]
  return body
}

/** A valid origin terminus, used only to prove it is NOT assignable to a component frontier. */
const originTerminus: RecordedOrigin = {
  terminus: 'recorded_origin',
  originRunId: 'run_a',
  hopsToOrigin: 1,
  establishedBy: [
    { proves: 'adjacent_edge_set_read', runId: 'run_a', inboundReadComplete: true, inboundEdgesFound: 0, scannedAt: T0 },
  ],
}

async function refusal(traversal: unknown, params: CausalTraceParams = PARAMS): Promise<V1ApiError> {
  try {
    await readerServing(traversal).getCausalTrace(params)
  } catch (err) {
    expect(err).toBeInstanceOf(V1ApiError)
    return err as V1ApiError
  }
  throw new Error('expected the reader to refuse this body, and it did not')
}

describe('the positive control', () => {
  it('accepts a traversal it can verify', async () => {
    const { traversal } = await readerServing(soundTraversal()).getCausalTrace(PARAMS)
    expect(traversal.edges).toHaveLength(1)
    // Without this passing, every refusal below could be firing for the wrong
    // reason.
  })
})

// ---------------------------------------------------------------------------
// GROUNDS 1-2 — the scan record, and the ignored-parameter tell
// ---------------------------------------------------------------------------

describe('an unverifiable scan', () => {
  it('refuses a traversal with no usable `scan`', async () => {
    // `edges: []` means "this run is an island" or "we walked nothing", and the
    // scan record is the only thing that tells them apart.
    const err = await refusal({ ...soundTraversal(), scan: undefined })
    expect(err.kind).toBe('invalid_response')
    expect(err.message).toContain('no usable `scan`')
  })

  it('refuses a walk in the WRONG DIRECTION — a well-formed answer to the opposite question', async () => {
    // The tell with no analogue elsewhere in this client. "Here is what caused
    // it" rendered under a heading that says "here is what it broke" is not a
    // degraded answer, it is a confident wrong one.
    const body = soundTraversal()
    ;(body.scan as Record<string, unknown>).direction = 'downstream'
    const err = await refusal(body)
    expect(err.message).toContain('OPPOSITE')
  })

  it('refuses a dropped maxDepth — a "depth limit reached" at a depth nobody chose', async () => {
    const body = soundTraversal()
    delete (body.scan as Record<string, unknown>).maxDepthRequested
    expect((await refusal(body)).message).toContain('ignored the parameter')
  })

  it('refuses a scan about a different subject run', async () => {
    const body = soundTraversal()
    ;(body.scan as Record<string, unknown>).subjectRunId = 'run_somebody_else'
    expect((await refusal(body)).kind).toBe('invalid_response')
  })
})

// ---------------------------------------------------------------------------
// GROUNDS 5-7 — RECORDED vs INFERRED, re-checked on the wire
// ---------------------------------------------------------------------------

describe('recorded, never inferred', () => {
  it('refuses a suspected link served in the EDGE list', async () => {
    // It would be WALKED and DRAWN AS AN ARROW.
    const body = soundTraversal()
    body.edges = [{ basis: 'suspected', linkKey: 'adj:1', kind: 'temporal_adjacency', runIds: ['run_a', 'run_b'] }]
    expect((await refusal(body)).message).toContain('would be WALKED and DRAWN AS AN ARROW')
  })

  it('refuses an edge that cites no record', async () => {
    const body = soundTraversal()
    ;(body.edges as Record<string, unknown>[])[0]!.recordedBy = []
    expect((await refusal(body)).message).toContain('cites no record')
  })

  it('refuses a SUSPICION THAT CARRIES A DIRECTION — the central wire-level check', async () => {
    // Contracts gives a suspicion no from/to field, which is what makes it
    // unwalkable rather than merely marked do-not-walk. The wire can put one
    // back, and then a consumer reading raw objects has everything it needs to
    // draw the arrow.
    for (const field of ['producerRunId', 'consumerRunId', 'fromRunId', 'toRunId', 'causeRunId', 'effectRunId']) {
      const body = soundTraversal()
      body.suspected = [
        {
          basis: 'suspected',
          kind: 'temporal_adjacency',
          linkKey: 'adj:1',
          runIds: ['run_a', 'run_z'],
          notAnEdgeBecause: 'nothing recorded a handoff',
          wouldBeRecordedBy: 'pass parentRunId to startRun',
          firstSeenAt: T0,
          lastSeenAt: T0,
          [field]: 'run_a',
        },
      ]
      expect((await refusal(body)).message).toContain('carries a DIRECTION')
    }
  })

  it('refuses a SUSPICION THAT CARRIES A PROSE HEADLINE', async () => {
    // The route by which an ENGINE, rather than a forgetful consumer, turns
    // "these ran close together" into "run_a caused run_b".
    for (const field of ['message', 'summary', 'title', 'description', 'headline', 'explanation', 'causedBy']) {
      const body = soundTraversal()
      body.suspected = [
        {
          basis: 'suspected',
          kind: 'temporal_adjacency',
          linkKey: 'adj:1',
          runIds: ['run_a', 'run_z'],
          notAnEdgeBecause: 'nothing recorded a handoff',
          wouldBeRecordedBy: 'pass parentRunId to startRun',
          firstSeenAt: T0,
          lastSeenAt: T0,
          [field]: 'run_a caused run_b to fail',
        },
      ]
      expect((await refusal(body)).message).toContain('prose headline')
    }
  })

  it('refuses an edge whose record was written in NEITHER endpoint — the inference tell', async () => {
    const body = soundTraversal()
    ;((body.edges as Record<string, unknown>[])[0]!.recordedBy as Record<string, unknown>[])[0]!.recordedInRunId =
      'run_z'
    expect((await refusal(body)).message).toContain('evidence_names_neither_endpoint')
  })

  it('refuses an ARTIFACT HANDOFF with no recorded read by the consumer', async () => {
    // A matching SHA-256 found by joining two runs' artifact rows is a
    // coincidence — however cryptographically exact. The checksum is what makes
    // this inference feel like proof.
    const body = soundTraversal()
    ;(body.edges as Record<string, unknown>[])[0] = {
      ...(body.edges as Record<string, unknown>[])[0],
      kind: 'artifact_handoff',
      recordedBy: [
        {
          cites: 'artifact',
          recordedInRunId: 'run_a',
          artifactId: 'art_1',
          sha256: '9c31',
          role: 'produced',
          recordedAt: T0,
        },
      ],
    }
    expect((await refusal(body)).message).toContain('artifact_handoff_not_cited_by_consumer')
  })
})

// ---------------------------------------------------------------------------
// GROUNDS 8-9 — ENDED vs LOST, re-checked on the wire
// ---------------------------------------------------------------------------

describe('an origin that was never established', () => {
  it('refuses an origin with an EMPTY proof list', async () => {
    // "The origin is run X" ends an investigation. Without a complete, empty
    // adjacency read behind it, the honest answer was "we lost the trail" — and
    // the two are opposite claims about the same run id.
    const body = soundTraversal()
    ;(body.termini as Record<string, unknown>[])[0]!.establishedBy = []
    expect((await refusal(body)).message).toContain('unproven_origin')
  })

  it('refuses an origin proved by a TRUNCATED adjacency read', async () => {
    const body = soundTraversal()
    ;((body.termini as Record<string, unknown>[])[0]!.establishedBy as Record<string, unknown>[])[0]!
      .inboundReadComplete = false
    expect((await refusal(body)).message).toContain('unproven_origin')
  })

  it('refuses an origin whose proof FOUND an inbound edge', async () => {
    const body = soundTraversal()
    ;((body.termini as Record<string, unknown>[])[0]!.establishedBy as Record<string, unknown>[])[0]!
      .inboundEdgesFound = 2
    expect((await refusal(body)).message).toContain('unproven_origin')
  })

  it('refuses an origin whose proof is about a DIFFERENT run', async () => {
    // A proof borrowed from a run that really did end is the subtlest version:
    // every field is well-formed and the claim is still unsupported.
    const body = soundTraversal()
    ;((body.termini as Record<string, unknown>[])[0]!.establishedBy as Record<string, unknown>[])[0]!.runId = 'run_q'
    expect((await refusal(body)).message).toContain('unproven_origin')
  })

  it('names the stakes in the refusal, so the message is actionable at 3am', async () => {
    const body = soundTraversal()
    ;(body.termini as Record<string, unknown>[])[0]!.establishedBy = []
    expect((await refusal(body)).message).toContain('LOST TRAIL WEARING AN ORIGIN')
  })
})

describe('a cycle that was never closed', () => {
  it('refuses a loop whose path does not return to the run it claims', async () => {
    // A cycle is the OTHER complete disposition, so it buys exit 0 exactly as an
    // origin does — and it is the easier forgery, because a lost trail an engine
    // cannot explain is one relabel away from "oh, it looped".
    const body = soundTraversal()
    body.termini = [
      { terminus: 'cycle_reentry', reEnteredRunId: 'run_a', hopsToReEntry: 2, cyclePath: ['run_a', 'run_b'] },
    ]
    expect((await refusal(body)).message).toContain('unclosed_cycle')
  })

  it('accepts an honestly closed loop — one whose hops are actually in the edge set', async () => {
    const body = soundTraversal()
    // The RETURN ARROW. Without it the loop is a claim the edge set refutes,
    // and the claim audit rejects it — which is the whole repair.
    ;(body.edges as Record<string, unknown>[]).push({
      ...(body.edges as Record<string, unknown>[])[0],
      edgeKey: 'e_ba',
      producerRunId: 'run_b',
      consumerRunId: 'run_a',
    })
    body.termini = [
      { terminus: 'cycle_reentry', reEnteredRunId: 'run_a', hopsToReEntry: 2, cyclePath: ['run_a', 'run_b', 'run_a'] },
    ]
    const { traversal } = await readerServing(body).getCausalTrace(PARAMS)
    expect(traversal.termini[0].terminus).toBe('cycle_reentry')
  })
})

describe('a walk that reported stopping nowhere', () => {
  it('refuses an EMPTY terminus list — the vacuity that defeats the obvious check', async () => {
    // `termini.every(t => t.terminus === 'recorded_origin')` is TRUE on an empty
    // array, so this body would read as a fully-traced graph to the most natural
    // code anyone would write.
    const body = soundTraversal()
    body.termini = []
    const err = await refusal(body)
    expect(err.message).toContain('NO termini')
    expect(err.message).toContain('TRUE on an empty array')
  })
})

// ---------------------------------------------------------------------------
// GROUNDS 3-4 and 10 — usability, coherence, and the verdict cross-check
// ---------------------------------------------------------------------------

describe('contents that arithmetic cannot be done with', () => {
  it('refuses counts that arrived as strings', async () => {
    // A guard written as a comparison does not reject a non-number, it takes the
    // other branch — and whether that branch is safe is luck.
    // `edgesRead` rather than `runsVisited`: the latter is also inspected by
    // the earlier structural scan check, so the refusal would fire there and
    // this test would pass without ever reaching the usability sweep.
    const body = soundTraversal()
    ;(body.scan as Record<string, unknown>).edgesRead = '1'
    expect((await refusal(body)).message).toContain('not_a_count')
  })

  it('refuses a DROPPED completeness flag rather than reading it as false', async () => {
    const body = soundTraversal()
    delete (body.scan as Record<string, unknown>).edgeSetsComplete
    expect((await refusal(body)).kind).toBe('invalid_response')
  })

  it('refuses a NaN timestamp, which every comparison would silently skip', async () => {
    const body = soundTraversal()
    ;(body.edges as Record<string, unknown>[])[0]!.handoffAt = 'not-a-time'
    expect((await refusal(body)).message).toContain('not_a_finite_number')
  })

  it('refuses an adjacency vocabulary this contract does not define', async () => {
    // "There is no edge here" and "I do not know whether there is" are the two
    // answers this field exists to keep apart. A third value is not one to guess
    // at.
    const body = soundTraversal()
    ;(body.nodes as Record<string, unknown>[])[0]!.adjacency = 'probably_none'
    expect((await refusal(body)).message).toContain('not_a_known_value')
  })

  it('refuses a self-loop and an arrow to a run the traversal never reached', async () => {
    const selfLoop = soundTraversal()
    ;(selfLoop.edges as Record<string, unknown>[])[0]!.consumerRunId = 'run_a'
    expect((await refusal(selfLoop)).message).toContain('self_loop')

    const ghost = soundTraversal()
    ;(ghost.edges as Record<string, unknown>[])[0]!.producerRunId = 'run_ghost'
    expect((await refusal(ghost)).message).toContain('endpoint_not_in_traversal')
  })

  it('refuses a verdict that contradicts the traversal\'s own contents', async () => {
    // The CLI derives its exit code from the contents rather than this string,
    // so the two can only ever agree — which is why cross-checking costs nothing
    // and removes a whole class of "the string said complete" failure.
    const body = soundTraversal()
    body.verdict = 'isolated'
    expect((await refusal(body)).kind).toBe('invalid_response')
  })
})

// ---------------------------------------------------------------------------
// WHAT IS NOT REFUSED — the server telling the truth
// ---------------------------------------------------------------------------

describe('honest incompleteness is reported, never refused', () => {
  it('accepts a lost trail and lets the GATE decide what it means', async () => {
    // Refusing here would be wrong: an honestly-declared partial walk is the
    // most useful thing a bounded engine can produce. It already yields
    // `indeterminate`, and `afr cause` exits 11 on it.
    const body = soundTraversal()
    body.termini = [
      {
        terminus: 'trail_lost',
        lastReachedRunId: 'run_a',
        kind: 'depth_limit_reached',
        hopsBeforeLoss: 1,
        lostBecause: 'the depth limit (10) was reached',
        wouldBeRecoveredBy: 're-run with --max-depth 25',
      },
    ]
    const { traversal } = await readerServing(body).getCausalTrace(PARAMS)
    expect(traversal.termini[0].terminus).toBe('trail_lost')
  })

  it('accepts a truncated scan, a sampled edge set and an outstanding cursor', async () => {
    const body = soundTraversal()
    body.verdict = 'chain_recorded'
    Object.assign(body.scan as Record<string, unknown>, {
      scanTruncated: true,
      edgeSetsComplete: false,
      nextCursor: 'cur_2',
    })
    await expect(readerServing(body).getCausalTrace(PARAMS)).resolves.toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Caller bugs — surfaced before any request is spent
// ---------------------------------------------------------------------------

describe('caller bugs', () => {
  const neverServed = new FlightReader(CONFIG, (() => {
    throw new Error('no request should be made for a caller bug')
  }) as unknown as V1FetchLike)

  it('rejects an empty run id before the request', async () => {
    await expect(neverServed.getCausalTrace({ ...PARAMS, runId: '' })).rejects.toBeInstanceOf(RangeError)
  })

  it('rejects an illegal direction before the request', async () => {
    await expect(
      neverServed.getCausalTrace({ ...PARAMS, direction: 'sideways' as never })
    ).rejects.toBeInstanceOf(RangeError)
  })

  it('rejects a missing maxDepth — there is no implicit ceiling', async () => {
    await expect(
      neverServed.getCausalTrace({ runId: 'run_b', direction: 'upstream' } as CausalTraceParams)
    ).rejects.toBeInstanceOf(RangeError)
  })
})

// ---------------------------------------------------------------------------
// THE READ PATH CARRIES THE COMPONENT BARRIER
//
// This is the load-bearing placement. Every consumer of a traversal — an
// adapter, a UI, the CLI, the MCP surface — gets it from this method, so
// narrowing the return type here makes a component origin unrepresentable for
// all of them rather than merely rejected at runtime.
// ---------------------------------------------------------------------------

describe('asking for a component narrows the result', () => {
  /**
   * THE PROOF THAT DISCRIMINATES, AND WHY THE PREVIOUS ONE DID NOT.
   *
   * The first version of this test read `.originRunId` off the result under
   * `@ts-expect-error`. That errors on the ordinary three-band `ChainTerminus`
   * union too — `originRunId` is absent from `CycleReEntry` and `LostTrail` —
   * so it passed WHETHER OR NOT `D` inferred. And `D` did not: `direction` was
   * typed `CausalDirection` rather than `D`, leaving the parameter with no
   * mention of `D` for inference to bite on, so it fell back to its default and
   * `TerminusFor<CausalDirection>` widened straight back to `ChainTerminus`.
   * The barrier was inert and the proof was compatible with the hole.
   *
   * So the assertion is POSITIVE and only satisfiable by inference: the
   * traversal returned for `direction: 'component'` must be assignable to
   * `ComponentTraversal`. Under the phantom parameter that assignment fails
   * (`CausalTraversal<CausalDirection>` is not a `CausalTraversal<'component'>`)
   * and this file goes red — which is what a proof of a type-level mechanism has
   * to do.
   */
  it('INFERS the component narrowing from the argument, with no explicit type argument', async () => {
    const { traversal } = await readerServing(componentBody()).getCausalTrace({
      runId: 'run_b',
      direction: 'component',
      maxDepth: 10,
    })
    // The load-bearing line. Nothing here mentions `'component'` as a type
    // argument; it flows from the `direction` property alone.
    const narrowed: ComponentTraversal = traversal
    expect(narrowed.termini[0].terminus).toBe('cycle_reentry')

    // And the frontier element type really is the two-band one: a RecordedOrigin
    // is not assignable to it.
    // @ts-expect-error — RecordedOrigin is not a ComponentTerminus
    const notAFrontier: (typeof narrowed.termini)[number] = originTerminus
    void notAFrontier
  })

  /**
   * THE ESCAPE HATCH THE PHANTOM PARAMETER LEFT OPEN, pinned shut.
   *
   * With `D` unreferenced by the parameter object, an explicit type argument was
   * unconstrained by the argument's contents, so a caller could ask for a
   * component walk and be handed a traversal typed as a directed one — origins
   * included. That is the conflation in full, spelled in one call.
   */
  it('rejects an explicit type argument that contradicts the argument', async () => {
    const reader = readerServing(componentBody())
    await reader.getCausalTrace<'component'>({ runId: 'run_b', direction: 'component', maxDepth: 10 })
    // @ts-expect-error — 'component' is not assignable to 'upstream'; the literal now flows from the argument
    await reader.getCausalTrace<'upstream'>({ runId: 'run_b', direction: 'component', maxDepth: 10 })
  })

  /**
   * THE BARRIER MUST NOT BE OVER-BROAD. A directed walk still carries origins —
   * establishing where a chain started is the entire point of asking upstream,
   * and a rule that took that away would be a worse bug than the one it fixed.
   */
  it('leaves a DIRECTED walk able to carry an origin', async () => {
    const { traversal } = await readerServing(soundTraversal()).getCausalTrace({
      runId: 'run_b',
      direction: 'upstream',
      maxDepth: 10,
    })
    const directed: DirectedTraversal = traversal
    const first = directed.termini[0]
    // Legal on a directed walk, and this line is the positive control: if
    // `TerminusFor` ever stripped origins from directed walks too, it fails.
    expect(first.terminus === 'recorded_origin' ? first.originRunId : null).toBe('run_a')
  })

  it('will not let a caller read an originRunId off a component walk', async () => {
    const { traversal } = await readerServing(componentBody()).getCausalTrace({
      runId: 'run_b',
      direction: 'component',
      maxDepth: 10,
    })
    // @ts-expect-error — a component walk's frontiers are CycleReEntry | LostTrail; there is no origin arm
    void traversal.termini[0].originRunId
    expect(traversal.termini[0].terminus).toBe('cycle_reentry')
  })

  it('refuses a component ORIGIN from the wire, and names the category error', async () => {
    // The type cannot reach a JSON body, and the engine may not be TypeScript at
    // all. So the wire check stays, and its message points at the real mistake
    // rather than at the edge set.
    const body = soundTraversal()
    ;(body.scan as Record<string, unknown>).direction = 'component'
    const err = await refusal(body, { runId: 'run_b', direction: 'component', maxDepth: 10 })
    expect(err.message).toContain('component_origin_claimed')
    expect(err.message).toContain('run an upstream walk instead')
  })
})

describe('a sequence number of 0', () => {
  it('is refused as a sentinel rather than cited as a position', async () => {
    const body = soundTraversal()
    ;((body.edges as Record<string, unknown>[])[0]!.recordedBy as Record<string, unknown>[])[0]!.sequenceNumber = 0
    expect((await refusal(body)).message).toContain('not_a_sequence_number')
  })
})
