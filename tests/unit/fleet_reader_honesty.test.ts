/**
 * `FlightReader.getFleetHealth` — the honesty checks.
 *
 * Every test here is a server that answers plausibly and WRONGLY, in one of
 * the two directions that matter at this altitude:
 *
 *   - it reads as "nothing is wrong across the fleet" to a caller that trusts
 *     it (the false clean), or
 *   - it reads as a CONFIDENT EXPLANATION of an incident that the data does
 *     not support (the false cause).
 *
 * The second one is specific to this feature and is the more dangerous. A
 * divergence report is read before a deploy by someone with time to think.
 * This one is read during an incident by someone deciding what to roll back,
 * and a confidently-worded wrong answer gets a healthy dependency rolled back
 * while the real cause keeps burning.
 *
 * The house rule this follows (see `getRunEventWindow`'s ignored-floor check
 * and `assertProjectionHonored`): SERVERS LIE BY OMISSION. A deployment that
 * predates a query parameter does not reject it, it DROPS it and answers a
 * different question in the same response shape.
 *
 * Mocked fetch throughout — no network, no backend.
 */
import { FlightReader, V1ApiError } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

import type {
  FleetHealthReport,
  HypothesisedCause,
  ObservedCorrelation,
} from '@agent-flight-recorder/contracts'
import type { V1FetchLike } from '@agent-flight-recorder/sdk'

const config = { baseUrl: 'http://localhost:3000', apiKey: 'k' }

const T0 = 1_721_909_400_000
const MIN = 60_000
const params = { since: T0 - 24 * 60 * MIN, until: T0, burstWindowMs: 15 * MIN }

function serve(data: unknown): V1FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { apiVersion: 'v1', data }
    },
    async text() {
      return JSON.stringify(data)
    },
    headers: { get: () => null },
  })) as unknown as V1FetchLike
}

const correlation: ObservedCorrelation = {
  certainty: 'observed',
  kind: 'temporal_burst',
  correlationKey: 'burst:1',
  observedFact: '12 agents recorded their first failure inside 4 minutes',
  // Coherent by construction: the listed agents match the claimed count (the
  // list is below its ceiling, so it is complete), and the citation sample
  // names more than one agent.
  agentIds: Array.from({ length: 12 }, (_, i) => `ag_${i + 1}`),
  agentCount: 12,
  firstObservedAt: T0 - 4 * MIN,
  lastObservedAt: T0,
  observedBy: [
    { cites: 'failure_occurrence', agentId: 'ag_1', runId: 'run_a', fingerprintHash: '9f3c', occurredAt: T0 - 3 * MIN },
    { cites: 'failure_occurrence', agentId: 'ag_2', runId: 'run_b', fingerprintHash: '9f3c', occurredAt: T0 - 2 * MIN },
  ],
}

const hypothesis: HypothesisedCause = {
  certainty: 'hypothesis',
  kind: 'shared_model',
  hypothesisKey: 'shared_model:m-4',
  sharedValue: 'm-4',
  restingOn: ['burst:1'],
  notEstablishedBecause: 'the event log records only what happened',
  sharedBy: { affectedSharing: 12, affectedTotal: 12, unaffectedSharing: 2, unaffectedTotal: 140, measurementTruncated: false },
  wouldBeTestedBy: 'roll ag_3 onto model `m-3`',
}

/** A whole, clean, honest sweep of a healthy fleet. The control. */
function healthy(overrides: Partial<FleetHealthReport> = {}): FleetHealthReport {
  return {
    analyzedAt: T0,
    verdict: 'healthy',
    roster: [],
    correlations: [],
    hypotheses: [],
    unanswered: [],
    agentsFailing: 0,
    scan: {
      since: params.since,
      until: params.until,
      burstWindowMs: params.burstWindowMs,
      correlationBasis: 'whole_roster',
      agentsInRoster: 152,
      agentsAssessed: 152,
      agentsUnassessable: 0,
      agentsSkippedForBudget: 0,
      occurrencesScanned: 0,
      scanTruncated: false,
      baseRatesMeasured: true,
    },
    ...overrides,
  }
}

async function expectRefusal(report: unknown, fragment: string): Promise<void> {
  const reader = new FlightReader(config, serve({ report }))
  await expect(reader.getFleetHealth(params)).rejects.toThrow(V1ApiError)
  await expect(reader.getFleetHealth(params)).rejects.toThrow(fragment)
}

describe('the control: an honest report is returned unchanged', () => {
  it('accepts a whole, clean, self-consistent sweep', async () => {
    const reader = new FlightReader(config, serve({ report: healthy() }))
    await expect(reader.getFleetHealth(params)).resolves.toEqual({ report: healthy() })
  })

  it('accepts an honestly-declared INCOMPLETE sweep — that is the server telling the truth', async () => {
    // Deliberately not refused. An incomplete sweep already forces
    // `indeterminate`, and deciding what an unfinished sweep means is the
    // gate's call (exit 11), not the client's.
    const incomplete = healthy({
      verdict: 'indeterminate',
      scan: { ...healthy().scan, scanTruncated: true, nextCursor: 'c_2', correlationBasis: 'page_local' },
    })
    const reader = new FlightReader(config, serve({ report: incomplete }))
    await expect(reader.getFleetHealth(params)).resolves.toEqual({ report: incomplete })
  })
})

describe('IGNORED WINDOW PARAMETERS — the ignored-parameter tell', () => {
  it('refuses a report whose burst width is not the one asked for', async () => {
    // THE DANGEROUS ONE. A deployment that predates `burstWindowMs` drops it
    // and correlates over its own, far wider, default — so a "burst" it
    // reports may be a whole day of ordinary background failure rendered as
    // fifteen minutes of one incident. That is a confidently-worded wrong
    // answer produced at exactly the moment someone is looking for permission
    // to roll something back.
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        correlations: [correlation],
        agentsFailing: 12,
        scan: { ...healthy().scan, burstWindowMs: 86_400_000 },
      }),
      'burstWindowMs'
    )
  })

  it('refuses an ABSENT burst width as firmly as a mismatched one', async () => {
    // Absence proves nothing was honored either — the same rule as the
    // divergence report's `targetVersionId` echo.
    const { burstWindowMs: _dropped, ...scanWithout } = healthy().scan
    await expectRefusal({ ...healthy(), scan: scanWithout }, 'burstWindowMs')
  })

  it('refuses a report whose observation window is not the one asked for', async () => {
    await expectRefusal(healthy({ scan: { ...healthy().scan, since: params.since - 86_400_000 } }), 'since')
    await expectRefusal(healthy({ scan: { ...healthy().scan, until: params.until + 86_400_000 } }), 'until')
  })
})

describe('A MISSING SCAN RECORD IS AN UNREADABLE ANSWER, NOT A WEAKER ONE', () => {
  it('refuses a report with no scan — "no correlations" would read as a fleet-wide all-clear', async () => {
    const { scan: _dropped, ...withoutScan } = healthy()
    await expectRefusal(withoutScan, 'no usable `scan`')
  })

  it('refuses a scan missing the fields completeness is computed from', async () => {
    const { correlationBasis: _b, ...noBasis } = healthy().scan
    await expectRefusal({ ...healthy(), scan: noBasis }, 'no usable `scan`')
  })

  it('refuses absent findings arrays — an absent list reads as "nothing found"', async () => {
    const { correlations: _c, ...noCorrelations } = healthy()
    await expectRefusal(noCorrelations, 'were not arrays')
    const { unanswered: _u, ...noUnanswered } = healthy()
    await expectRefusal(noUnanswered, 'were not arrays')
  })
})

describe('THE SEGREGATION IS RE-CHECKED ON THE WIRE (TypeScript stops at the JSON body)', () => {
  it('refuses a HYPOTHESIS served in the observed list', async () => {
    // The catastrophic conflation, arriving over HTTP where the type system
    // cannot reach it. Rendered, this would put a guess on an incident screen
    // wearing the styling of something that demonstrably happened.
    await expectRefusal(
      healthy({ verdict: 'correlated_failures', correlations: [hypothesis as unknown as ObservedCorrelation] }),
      'would be rendered as something that demonstrably happened'
    )
  })

  it('refuses an OBSERVATION served among the hypotheses', async () => {
    await expectRefusal(
      healthy({ hypotheses: [correlation as unknown as HypothesisedCause] }),
      'declares certainty "observed"'
    )
  })

  it('refuses an observation citing NO evidence', async () => {
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        correlations: [{ ...correlation, observedBy: [] } as unknown as ObservedCorrelation],
      }),
      'cites no evidence'
    )
  })
})

describe('CHECK ORDERING IS LOAD-BEARING, so it is asserted rather than left to be rearranged', () => {
  // The SDK path is safe against a null correlation element, and it is worth
  // preserving WHY: the certainty loop runs BEFORE `fleetReportIncoherences`,
  // and `c?.certainty !== 'observed'` is true for `null`, so the gate refuses
  // first. That is an ordering dependency invisible from either site — nothing
  // at the certainty loop says "something downstream needs me to run first".
  // Asserting the resulting MESSAGE pins the order behaviourally, so a
  // rearrangement shows up as a failing test rather than as a crash in
  // production.

  it('refuses a null correlation element via the certainty check, not by throwing downstream', async () => {
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [null as unknown as ObservedCorrelation],
      }),
      'declares certainty'
    )
  })

  it('refuses a correlation made of NaN — which used to produce ZERO incoherence codes and page someone', async () => {
    // Refused by the USABILITY sweep, which runs before the coherence sweep —
    // so the message names the field rather than the code, and that is the
    // documented ordering being asserted rather than assumed. The coherence
    // sweep now catches it too (see fleet_coherence), and the redundancy is
    // deliberate: `correlationIncoherences` is exported and reached directly
    // by the web, so it must not depend on this ordering.
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [{ ...correlation, agentCount: Number.NaN, lastObservedAt: Number.NaN }],
      }),
      'correlations[burst:1].agentCount (not_a_count)'
    )
  })
})

describe('CONTENTS THAT ARE NOT USABLE ARE REFUSED AT THE BOUNDARY', () => {
  // The boundary is the right home for this rather than a defence each verdict
  // function carries forever: a measurement that arrives unusable is a REPORT
  // TO REFUSE, alongside the other grounds — the wire said something the type
  // cannot vouch for, exactly like a transmitted prose headline.
  //
  // Positive assertions, one per row that used to get through.

  it('refuses a base rate whose counts arrive as STRINGS — this used to read as DISCRIMINATING', async () => {
    // THE DANGEROUS DIRECTION: `'0'/'188'` is 0 by JS coercion, so the margin
    // cleared and a guess was promoted to the top of an incident screen on the
    // strength of two strings that nothing had vouched for.
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [correlation],
        hypotheses: [
          {
            ...hypothesis,
            sharedBy: { ...hypothesis.sharedBy, unaffectedSharing: '0', unaffectedTotal: '188' },
          } as unknown as HypothesisedCause,
        ],
      }),
      'unusable_measurement'
    )
  })

  it('refuses a base rate whose truncation flag was DROPPED — the guard fails CLOSED', async () => {
    const { measurementTruncated: _dropped, ...noFlag } = hypothesis.sharedBy
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [correlation],
        hypotheses: [{ ...hypothesis, sharedBy: noFlag } as unknown as HypothesisedCause],
      }),
      'unusable_measurement'
    )
  })

  it('refuses ABSENT base-rate fields — a measured verdict from no measurement', async () => {
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [correlation],
        hypotheses: [
          {
            ...hypothesis,
            sharedBy: { affectedSharing: 12, affectedTotal: 12, measurementTruncated: false },
          } as unknown as HypothesisedCause,
        ],
      }),
      'unusable_measurement'
    )
  })

  it('refuses NaN by RULE — it was previously safe only by IEEE coincidence', async () => {
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [correlation],
        hypotheses: [
          { ...hypothesis, sharedBy: { ...hypothesis.sharedBy, unaffectedSharing: Number.NaN } },
        ],
      }),
      'unusable_measurement'
    )
  })

  it('refuses garbage timestamps, which would make the burst-span rule silently unenforceable', async () => {
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [{ ...correlation, lastObservedAt: '2024-01-01' as unknown as number }],
      }),
      'not_a_finite_number'
    )
  })

  it('refuses an `agentsFailing` that would turn a failing fleet into `healthy`', async () => {
    await expectRefusal(healthy({ agentsFailing: Number.NaN }), 'agentsFailing')
  })

  it('STILL accepts an honestly unmeasured base rate — `null` is a legal statement', async () => {
    // The distinction that matters: `unusable` is refused, `not_measured` is
    // accepted and surfaced. Collapsing them would make honest engines
    // unserveable.
    const report = healthy({
      verdict: 'correlated_failures',
      agentsFailing: 12,
      correlations: [correlation],
      hypotheses: [
        { ...hypothesis, sharedBy: { ...hypothesis.sharedBy, unaffectedSharing: null, unaffectedTotal: null } },
      ],
      scan: { ...healthy().scan, baseRatesMeasured: false },
    })
    const reader = new FlightReader(config, serve({ report }))
    await expect(reader.getFleetHealth(params)).resolves.toEqual({ report })
  })
})

describe('THE NUMBERS MUST AGREE WITH EACH OTHER, NOT MERELY BE PRESENT', () => {
  // The class of defect, not four separate ones. Every check in this block was
  // passing before: the field was there, well-formed, and internally sensible.
  // What was never checked is whether the number it carries agrees with
  // ANOTHER number in the same report.

  it('refuses a "four minute burst" that declares a twenty-four hour span', async () => {
    // THE SERIOUS ONE. The echo check above confirms the server HONOURED
    // `burstWindowMs`; it says nothing about whether the burst it returned
    // actually FITS that width. Same wrong answer — a day of ordinary
    // background failure rendered as a four-minute incident — arriving by the
    // route the echo check does not cover.
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [
          {
            ...correlation,
            firstObservedAt: T0 - 24 * 60 * MIN,
            lastObservedAt: T0,
            observedBy: [
              { cites: 'failure_occurrence', agentId: 'ag_1', runId: 'run_a', fingerprintHash: '9f3c', occurredAt: T0 - 12 * 60 * MIN },
              { cites: 'failure_occurrence', agentId: 'ag_2', runId: 'run_b', fingerprintHash: '9f3c', occurredAt: T0 - 60 * MIN },
            ],
          },
        ],
      }),
      'burst_span_exceeds_window'
    )
  })

  it('refuses a claimed breadth the listed agents contradict', async () => {
    // `agentCount` is the number that decides what an operator reads first
    // during an incident. An unvalidated one delegates that decision to
    // whoever produced it.
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [{ ...correlation, agentCount: 500, agentIds: ['ag_1'] }],
      }),
      'agent_count_contradicts_listed_agents'
    )
  })

  it('refuses a multi-agent claim whose whole citation sample names one agent', async () => {
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [
          {
            ...correlation,
            agentIds: ['ag_1', 'ag_2'],
            agentCount: 2,
            observedBy: [
              { cites: 'failure_occurrence', agentId: 'ag_1', runId: 'run_a', fingerprintHash: '9f3c', occurredAt: T0 - 3 * MIN },
              { cites: 'failure_occurrence', agentId: 'ag_1', runId: 'run_b', fingerprintHash: '9f3c', occurredAt: T0 - 2 * MIN },
            ],
          },
        ],
      }),
      'evidence_confined_to_one_agent'
    )
  })
})

describe('AN OBSERVATION MUST AGREE WITH ITS OWN EVIDENCE', () => {
  it('refuses a "four minute burst" citing a failure from a day earlier', async () => {
    // The fleet counterpart of "a proven divergence must cite the recorded
    // event it contradicts". Mislabelling a wide scan as a burst manufactures
    // an incident out of ordinary background failure — and it is checkable
    // from the report's own contents, at no extra request.
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [
          {
            ...correlation,
            observedBy: [
              {
                cites: 'failure_occurrence',
                agentId: 'ag_1',
                runId: 'run_a',
                fingerprintHash: '9f3c',
                occurredAt: correlation.firstObservedAt - 86_400_000,
              },
            ],
          },
        ],
      }),
      'citation_outside_window'
    )
  })

  it('refuses an inverted observation window', async () => {
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [{ ...correlation, lastObservedAt: correlation.firstObservedAt - 1 }],
      }),
      'inverted_window'
    )
  })
})

describe('A HYPOTHESIS WITHOUT ITS DENOMINATOR, OR WITHOUT ITS FACT, IS REFUSED', () => {
  it('refuses a hypothesis with no base-rate measurement', async () => {
    // "All 12 failing agents use model m-4" is not evidence when 198 of the
    // org's 200 agents use m-4, and the denominator is the only thing on the
    // screen that separates those two readings.
    const { sharedBy: _dropped, ...noBaseRate } = hypothesis
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [correlation],
        hypotheses: [noBaseRate as unknown as HypothesisedCause],
      }),
      'no base-rate measurement'
    )
  })

  it('refuses a hypothesis resting on nothing', async () => {
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [correlation],
        hypotheses: [{ ...hypothesis, restingOn: [] } as unknown as HypothesisedCause],
      }),
      'rests on no observation'
    )
  })

  it('refuses an ORPHAN hypothesis — one naming an observation this report does not contain', async () => {
    // On a dashboard a free-floating "model m-4 may be degrading" renders
    // identically to one backed by twelve cited occurrences. Refusing the
    // response is the last place that difference can be enforced.
    await expectRefusal(
      healthy({ hypotheses: [{ ...hypothesis, restingOn: ['a-cluster-that-is-not-here'] }] }),
      'that this report does not contain'
    )
  })

  it('refuses a PARTIALLY orphaned hypothesis — one real key plus one fabricated', async () => {
    // A partially-grounded explanation is more persuasive than a wholly
    // invented one: the half that resolves lends its credibility to the half
    // that does not.
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [correlation],
        hypotheses: [{ ...hypothesis, restingOn: ['burst:1', 'a-cluster-that-was-never-observed'] }],
      }),
      'that this report does not contain'
    )
  })

  it('accepts a hypothesis whose base rate is honestly NOT MEASURED', async () => {
    // `null` is a legal, meaningful answer — "we did not measure" — and is
    // exactly what an engine should say rather than reporting a favourable
    // zero. It is the CLI's job to mark it BASE RATE UNKNOWN, not the
    // reader's job to refuse it.
    const report = healthy({
      verdict: 'correlated_failures',
      agentsFailing: 12,
      correlations: [correlation],
      hypotheses: [
        { ...hypothesis, sharedBy: { ...hypothesis.sharedBy, unaffectedSharing: null, unaffectedTotal: null } },
      ],
      scan: { ...healthy().scan, baseRatesMeasured: false },
    })
    const reader = new FlightReader(config, serve({ report }))
    await expect(reader.getFleetHealth(params)).resolves.toEqual({ report })
  })
})

describe('A TRANSMITTED SENTENCE IS REFUSED — the mood belongs to the type', () => {
  it('refuses a hypothesis carrying a prose headline, under any of the names one would reach for', async () => {
    // The web surface defended itself locally by building its heading from
    // `kind`. The CLI, the MCP tool and every other SDK consumer get the raw
    // object, so the guarantee has to live at the layer they all pass through.
    for (const banned of ['candidateExplanation', 'message', 'summary', 'title', 'description', 'headline']) {
      await expectRefusal(
        healthy({
          verdict: 'correlated_failures',
          agentsFailing: 12,
          correlations: [correlation],
          hypotheses: [{ ...hypothesis, [banned]: 'model m-4 is failing' } as unknown as HypothesisedCause],
        }),
        'carries a prose headline'
      )
    }
  })

  it('refuses a shared-attribute hypothesis that names no value to ask about', async () => {
    const { sharedValue: _dropped, ...vague } = hypothesis
    await expectRefusal(
      healthy({
        verdict: 'correlated_failures',
        agentsFailing: 12,
        correlations: [correlation],
        hypotheses: [vague as HypothesisedCause],
      }),
      'names no `sharedValue`'
    )
  })

  it('accepts an `unattributed` hypothesis with no shared value — that IS the honest answer', async () => {
    const { sharedValue: _dropped, ...unattributed } = hypothesis
    const report = healthy({
      verdict: 'correlated_failures',
      agentsFailing: 12,
      correlations: [correlation],
      hypotheses: [{ ...unattributed, kind: 'unattributed' } as HypothesisedCause],
    })
    const reader = new FlightReader(config, serve({ report }))
    await expect(reader.getFleetHealth(params)).resolves.toEqual({ report })
  })
})

describe('A VERDICT THAT CONTRADICTS ITS OWN CONTENTS MAKES EVERY OTHER FIELD SUSPECT', () => {
  it('refuses `healthy` served alongside an observed correlation', async () => {
    await expectRefusal(
      healthy({ verdict: 'healthy', correlations: [correlation], agentsFailing: 12 }),
      'reported verdict'
    )
  })

  it('refuses `healthy` served over a truncated sweep', async () => {
    await expectRefusal(healthy({ verdict: 'healthy', scan: { ...healthy().scan, scanTruncated: true } }), 'reported verdict')
  })

  it('refuses `healthy` served over a sweep that assessed nothing', async () => {
    await expectRefusal(
      healthy({ verdict: 'healthy', scan: { ...healthy().scan, agentsInRoster: 0, agentsAssessed: 0 } }),
      'reported verdict'
    )
  })
})

describe('caller bugs are caught before a request is spent', () => {
  it('rejects an inverted window', async () => {
    const fetchImpl = serve({ report: healthy() })
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.getFleetHealth({ ...params, until: params.since - 1 })).rejects.toThrow(RangeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a non-positive burst width', async () => {
    const reader = new FlightReader(config, serve({ report: healthy() }))
    await expect(reader.getFleetHealth({ ...params, burstWindowMs: 0 })).rejects.toThrow(RangeError)
  })
})
