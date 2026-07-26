/**
 * `afr fleet` — THE EXIT CODES.
 *
 * This command ends up in a monitoring loop, so the exit code IS the product
 * for most of its lifetime: nobody reads the output until it goes non-zero.
 * Three properties are being proven here, and each has a specific way of going
 * wrong that would be invisible in normal operation:
 *
 *  1. A BOUNDED SWEEP NEVER BUYS A GREEN EXIT. Every way of not having looked
 *     — roster ceiling, skipped agents, unassessable agents, an outstanding
 *     cursor, a page-local correlation basis, an unanswered question — must
 *     produce exit 11 rather than exit 0. AND NOTE WHEN THIS MATTERS: data
 *     volume spikes during an incident, so truncation is likeliest during
 *     exactly the event the command exists to catch. A completeness rule that
 *     is decorative on a quiet day is the whole product on a bad one.
 *
 *  2. AN OBSERVATION OUTRANKS AN INCOMPLETE SWEEP (10 beats 11). Same reason:
 *     a correlation found in a partial sweep is still true, and demoting it to
 *     "cannot tell" would silence the alarm precisely when it is right.
 *
 *  3. A HYPOTHESIS CAN NEVER CHANGE THE EXIT CODE, AT ANY THRESHOLD. There is
 *     no `--fail-on` value that fires on a guess, and the exhaustive sweep
 *     below proves it for every legal threshold rather than for the one the
 *     author happened to think of. Paging on a guess is how the healthy
 *     dependency gets rolled back while the actual cause keeps burning.
 *
 * No network: `runFleet` takes an injected fetch, and most cases here build a
 * result directly and score it.
 */
import {
  DEFAULT_BURST_WINDOW_MINUTES,
  DEFAULT_FLEET_FAIL_ON,
  DEFAULT_SINCE_HOURS,
  FLEET_EXIT_CORRELATED,
  FLEET_EXIT_INDETERMINATE,
  exitCodeForFleet,
  parseFleetArgs,
  printFleet,
  runFleet,
} from '@agent-flight-recorder/cli'
import { describe, expect, it, vi } from 'vitest'

import type { FleetFailOn, FleetResult } from '@agent-flight-recorder/cli'
import type {
  FleetHealthReport,
  HypothesisedCause,
  ObservedCorrelation,
  UnansweredFleetQuestion,
} from '@agent-flight-recorder/contracts'
import type { V1FetchLike } from '@agent-flight-recorder/sdk'

const T0 = 1_721_909_400_000
const MIN = 60_000

const correlation: ObservedCorrelation = {
  certainty: 'observed',
  kind: 'temporal_burst',
  correlationKey: 'burst:1',
  observedFact: '12 agents recorded their first failure inside 4 minutes',
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
  notEstablishedBecause: 'the event log records only what happened; no counterfactual run exists to compare against',
  sharedBy: { affectedSharing: 12, affectedTotal: 12, unaffectedSharing: 2, unaffectedTotal: 140, measurementTruncated: false },
  wouldBeTestedBy: 'roll ag_3 onto model `m-3` and watch whether its failures stop',
}

const unanswered: UnansweredFleetQuestion = {
  certainty: 'unanswered',
  kind: 'roster_incomplete',
  questionKey: 'roster_incomplete',
  undecidedQuestion: 'whether the 40 agents after the roster ceiling also failed inside this window',
  unknownBecause: 'the roster ceiling (200) was reached',
  remedy: 're-run with --limit 500',
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
      since: T0 - 24 * 60 * MIN,
      until: T0,
      burstWindowMs: 15 * MIN,
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

function result(report: FleetHealthReport, failOn: FleetFailOn = DEFAULT_FLEET_FAIL_ON): FleetResult {
  return { ok: true, failOn, report }
}

describe('afr fleet — exit 0 is earned, not defaulted', () => {
  it('a whole, clean sweep exits 0', () => {
    expect(exitCodeForFleet(result(healthy()))).toBe(0)
  })

  it('an OBSERVED correlation exits 10 at the default threshold', () => {
    expect(exitCodeForFleet(result(healthy({ correlations: [correlation], agentsFailing: 12 })))).toBe(
      FLEET_EXIT_CORRELATED
    )
  })

  it('failing agents with nothing connecting them exit 0 by default, and 10 under --fail-on any', () => {
    // The default gate is for FLEET events. Individual agents failing is what
    // `afr triage` is for; paging the whole org on it makes the fleet alarm
    // the noisy one, and a noisy alarm gets muted — taking the real signal
    // with it.
    const isolated = healthy({ agentsFailing: 3, verdict: 'isolated_failures' })
    expect(exitCodeForFleet(result(isolated, 'correlated'))).toBe(0)
    expect(exitCodeForFleet(result(isolated, 'any'))).toBe(FLEET_EXIT_CORRELATED)
  })

  it('--fail-on none never exits 10, even on a fleet-wide event — it is not a gate and says so', () => {
    expect(exitCodeForFleet(result(healthy({ correlations: [correlation], agentsFailing: 12 }), 'none'))).toBe(0)
  })
})

describe('A TRUNCATED SWEEP CAN NEVER EXIT CLEAN', () => {
  // Each entry is a different way of not having finished looking. Every one of
  // them leaves `correlations` empty, so every one of them looks like a
  // healthy fleet to anything that reads only the findings.
  const incompleteScans: Array<[string, FleetHealthReport]> = [
    ['the server hit its row ceiling', healthy({ scan: { ...healthy().scan, scanTruncated: true, scanRowCeiling: 2000 } })],
    ['agents could not be assessed', healthy({ scan: { ...healthy().scan, agentsUnassessable: 4 } })],
    ['agents were skipped for budget', healthy({ scan: { ...healthy().scan, agentsSkippedForBudget: 40 } })],
    ['pages remain in the roster', healthy({ scan: { ...healthy().scan, nextCursor: 'c_2' } })],
    [
      'the correlation pass saw only one page of the roster',
      healthy({ scan: { ...healthy().scan, correlationBasis: 'page_local' } }),
    ],
    ['no agent was assessed at all', healthy({ scan: { ...healthy().scan, agentsInRoster: 0, agentsAssessed: 0 } })],
    ['a question was reached and left open', healthy({ unanswered: [unanswered] })],
  ]

  for (const [why, report] of incompleteScans) {
    it(`exits 11, not 0, when ${why}`, () => {
      expect(exitCodeForFleet(result(report, 'correlated'))).toBe(FLEET_EXIT_INDETERMINATE)
      // And widening the gate does not accidentally narrow it back to a pass.
      expect(exitCodeForFleet(result(report, 'any'))).toBe(FLEET_EXIT_INDETERMINATE)
    })
  }

  it('the EMPTY sweep is the one that used to go green — nothing truncated, nothing skipped, nothing examined', () => {
    // Every negative clause is satisfied here. Only the positive one
    // (`agentsAssessed > 0`) catches it, and without it this input produces an
    // org-wide all-clear derived from zero agents.
    const empty = healthy({ scan: { ...healthy().scan, agentsInRoster: 0, agentsAssessed: 0 } })
    expect(exitCodeForFleet(result(empty))).toBe(FLEET_EXIT_INDETERMINATE)
  })

  it('10 WINS OVER 11: a correlation found in a truncated sweep still pages', () => {
    // The precedence that matters most here. Volume spikes during an incident,
    // so the sweep is likeliest to truncate DURING the event — if truncation
    // downgraded the observation to "cannot tell", the alarm would go quiet at
    // exactly the moment it is correct.
    const truncatedButBurning = healthy({
      correlations: [correlation],
      agentsFailing: 12,
      scan: { ...healthy().scan, scanTruncated: true, nextCursor: 'c_2' },
    })
    expect(exitCodeForFleet(result(truncatedButBurning))).toBe(FLEET_EXIT_CORRELATED)
  })

  it('--fail-on none is the ONLY way to reach 0 on an incomplete sweep', () => {
    const incomplete = healthy({ scan: { ...healthy().scan, nextCursor: 'c_2' } })
    expect(exitCodeForFleet(result(incomplete, 'none'))).toBe(0)
    for (const failOn of ['correlated', 'any'] as const) {
      expect(exitCodeForFleet(result(incomplete, failOn))).not.toBe(0)
    }
  })
})

describe('A HYPOTHESIS CANNOT CHANGE THE EXIT CODE, AT ANY THRESHOLD', () => {
  const ALL_THRESHOLDS: readonly FleetFailOn[] = ['correlated', 'any', 'none']

  it('adding hypotheses to any report leaves every threshold`s exit code unchanged', () => {
    // Exhaustive over the legal thresholds rather than over the one the author
    // thought of — the failure this guards against is a future `--fail-on
    // hypothesis` being added because it seemed useful during an incident
    // retro, which is exactly when it seems useful and exactly when it is
    // wrong.
    const bases = [
      healthy(),
      healthy({ agentsFailing: 5 }),
      healthy({ correlations: [correlation], agentsFailing: 12 }),
      healthy({ scan: { ...healthy().scan, nextCursor: 'c_2' } }),
    ]
    for (const base of bases) {
      for (const failOn of ALL_THRESHOLDS) {
        const without = exitCodeForFleet(result(base, failOn))
        const withGuesses = exitCodeForFleet(
          result({ ...base, hypotheses: [hypothesis, { ...hypothesis, hypothesisKey: 'h2' }] }, failOn)
        )
        expect(withGuesses).toBe(without)
      }
    }
  })

  it('a report that is ONLY hypotheses — no observation at all — is still just a healthy fleet', () => {
    // This is the shape a nervous engine produces: nothing actually
    // co-occurred, but it has theories. The exit code must not budge.
    const guessesOnly = healthy({ hypotheses: [{ ...hypothesis, restingOn: ['burst:1'] }] })
    expect(exitCodeForFleet(result(guessesOnly, 'correlated'))).toBe(0)
    expect(exitCodeForFleet(result(guessesOnly, 'any'))).toBe(0)
  })
})

describe('afr fleet — argument handling', () => {
  it('rejects an unknown --fail-on rather than silently falling back to the default', () => {
    // A typo that quietly used the default is harmless until the day someone
    // means to widen the gate and believes they have.
    return runFleet({ failOn: 'hypothesis' }, { apiKey: 'k', baseUrl: 'http://x' }).then((r) => {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.exitCode).toBe(1)
        expect(r.message).toContain('--fail-on must be one of')
        // And the error explains WHY the obvious-looking value is absent.
        expect(r.message).toContain('hypothesis')
      }
    })
  })

  it('rejects a non-positive window or lookback (exit 1), before spending a request', async () => {
    for (const args of [{ sinceHours: 0 }, { sinceHours: -1 }, { windowMinutes: 0 }, { limit: 0 }]) {
      const r = await runFleet(args, { apiKey: 'k', baseUrl: 'http://x' })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.exitCode).toBe(1)
    }
  })

  it('missing credentials is a usage error (exit 1), not a network one', async () => {
    const r = await runFleet({}, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.exitCode).toBe(1)
  })

  it('parses the flags it documents', () => {
    expect(parseFleetArgs(['--since-hours', '2', '--window', '5', '--limit', '500', '--fail-on', 'any', '--json'])).toEqual(
      { sinceHours: 2, windowMinutes: 5, limit: 500, failOn: 'any', json: true }
    )
  })

  it('sends the resolved window and burst width, in ms, derived from the injected clock', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/v1/fleet/health')
      expect(url).toContain(`since=${T0 - 2 * 60 * MIN}`)
      expect(url).toContain(`until=${T0}`)
      expect(url).toContain(`burstWindowMs=${5 * MIN}`)
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            apiVersion: 'v1',
            data: {
              report: healthy({
                scan: { ...healthy().scan, since: T0 - 2 * 60 * MIN, until: T0, burstWindowMs: 5 * MIN },
              }),
            },
          }
        },
        async text() {
          return ''
        },
        headers: { get: () => null },
      }
    }) as unknown as V1FetchLike

    const r = await runFleet({ sinceHours: 2, windowMinutes: 5 }, { apiKey: 'k', baseUrl: 'http://x' }, fetchImpl, T0)
    expect(r.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('makes exactly ONE request — it does not follow the roster cursor', async () => {
    // Deliberate departure from `afr compat --agent`, which pages and merges.
    // Cross-agent correlation does not compose across pages: a burst split
    // across two roster pages is two sub-threshold clusters, invisible on
    // every page and in any merge of them. Paging would manufacture a report
    // about a fleet that does not exist; the outstanding cursor is reported
    // and keeps the sweep incomplete instead.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        // `verdict: 'indeterminate'` is not decoration: the reader refuses a
        // report whose verdict disagrees with its own contents, and an
        // outstanding cursor makes `healthy` unreachable.
        return {
          apiVersion: 'v1',
          data: { report: healthy({ verdict: 'indeterminate', scan: { ...healthy().scan, nextCursor: 'c_2' } }) },
        }
      },
      async text() {
        return ''
      },
      headers: { get: () => null },
    })) as unknown as V1FetchLike

    const r = await runFleet({}, { apiKey: 'k', baseUrl: 'http://x' }, fetchImpl, T0)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
    if (r.ok) expect(exitCodeForFleet(r)).toBe(FLEET_EXIT_INDETERMINATE)
  })

  it('NEVER RANKS AN UNGATED REPORT — the dependency that makes ungated ranking safe', async () => {
    // LOAD-BEARING AND INVISIBLE, so it is pinned here. `printFleet` calls
    // `rankFleetCorrelations` with no coherence check of its own; that is safe
    // ONLY because `apiClient.getFleetHealth` routes through `FlightReader`,
    // which refuses a report with a non-empty incoherence list before the CLI
    // ever sees it. If the CLI is ever changed to fetch directly, it starts
    // ranking unchecked breadth immediately — and this test is what says so.
    //
    // Note the deliberate difference in severity from the web, which renders
    // partially with a named withholding: the CLI HARD REFUSES. Both are
    // honest; neither is silent.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          apiVersion: 'v1',
          data: {
            report: healthy({
              verdict: 'correlated_failures',
              agentsFailing: 12,
              // A fabricated breadth that would otherwise rank FIRST.
              correlations: [{ ...correlation, agentCount: 500, agentIds: ['ag_1'] }],
            }),
          },
        }
      },
      async text() {
        return ''
      },
      headers: { get: () => null },
    })) as unknown as V1FetchLike

    const r = await runFleet({}, { apiKey: 'k', baseUrl: 'http://x' }, fetchImpl, T0)
    expect(r.ok).toBe(false)
    // Exit 4 — a wire failure. Never 10 (a fleet event) and never 0.
    if (!r.ok) {
      expect(r.exitCode).toBe(4)
      expect(r.message).toContain('agent_count_contradicts_listed_agents')
    }
  })

  it('never exits 10 on a correlation made of NaN', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          apiVersion: 'v1',
          data: {
            report: healthy({
              verdict: 'correlated_failures',
              agentsFailing: 12,
              correlations: [{ ...correlation, agentCount: Number.NaN, lastObservedAt: Number.NaN }],
            }),
          },
        }
      },
      async text() {
        return ''
      },
      headers: { get: () => null },
    })) as unknown as V1FetchLike

    const r = await runFleet({}, { apiKey: 'k', baseUrl: 'http://x' }, fetchImpl, T0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.exitCode).toBe(4)
  })

  it('documents its defaults as constants, so a log can state what was actually swept', () => {
    expect(DEFAULT_SINCE_HOURS).toBeGreaterThan(0)
    expect(DEFAULT_BURST_WINDOW_MINUTES).toBeGreaterThan(0)
    expect(DEFAULT_FLEET_FAIL_ON).toBe('correlated')
  })
})

describe('afr fleet — the printed page never renders a guess as a finding', () => {
  function render(report: FleetHealthReport, failOn: FleetFailOn = 'correlated'): string[] {
    const lines: string[] = []
    printFleet({}, result(report, failOn), (line) => lines.push(line))
    return lines
  }

  it('labels every hypothesis, and prints its denominator on the same screen', () => {
    const lines = render(healthy({ correlations: [correlation], hypotheses: [hypothesis], agentsFailing: 12 }))
    const text = lines.join('\n')
    expect(text).toContain('OBSERVED ACROSS AGENTS')
    expect(text).toContain('HYPOTHESIS')
    expect(text).toContain('DISCRIMINATING')
    // The denominator, not just the numerator. "12/12 failing agents share it"
    // alone is the misleading sentence this feature exists to prevent.
    expect(text).toContain('healthy agents sharing it: 2/140')
    expect(text).toContain('to test it:')
  })

  it('says BASE RATE UNKNOWN rather than implying support, when nothing was measured', () => {
    const unmeasured: HypothesisedCause = {
      ...hypothesis,
      sharedBy: { ...hypothesis.sharedBy, unaffectedSharing: null, unaffectedTotal: null },
    }
    const text = render(
      healthy({ correlations: [correlation], hypotheses: [unmeasured], agentsFailing: 12 })
    ).join('\n')
    expect(text).toContain('BASE RATE UNKNOWN')
    expect(text).toContain('NOT MEASURED')
  })

  it('says NOT DISCRIMINATING when the healthy agents share it too', () => {
    const useless: HypothesisedCause = {
      ...hypothesis,
      sharedBy: { affectedSharing: 12, affectedTotal: 12, unaffectedSharing: 186, unaffectedTotal: 188, measurementTruncated: false },
    }
    const text = render(healthy({ correlations: [correlation], hypotheses: [useless], agentsFailing: 12 })).join('\n')
    expect(text).toContain('NOT DISCRIMINATING')
  })

  it('states the incompleteness in words as well as in the exit code', () => {
    // The person reading a monitoring log is not the person who wrote the
    // exit-code table.
    const text = render(healthy({ scan: { ...healthy().scan, nextCursor: 'c_2', correlationBasis: 'page_local' } })).join('\n')
    expect(text).toContain('PAGES REMAIN')
    expect(text).toContain('CORRELATED OVER ONE PAGE ONLY')
    expect(text).toContain('are not agents that are healthy')
  })

  it('leads with the BROADEST correlation, not the most recent', () => {
    const narrowButRecent: ObservedCorrelation = {
      ...correlation,
      correlationKey: 'burst:2',
      observedFact: '2 agents failed just now',
      agentIds: ['ag_9', 'ag_10'],
      agentCount: 2,
      lastObservedAt: T0 + 10 * MIN,
      firstObservedAt: T0 + 9 * MIN,
      observedBy: [
        { cites: 'failure_occurrence', agentId: 'ag_9', runId: 'run_z', fingerprintHash: 'aaaa', occurredAt: T0 + 9 * MIN },
      ],
    }
    const lines = render(healthy({ correlations: [narrowButRecent, correlation], agentsFailing: 14 }))
    const first = lines.findIndex((l) => l.includes('12 agents recorded'))
    const second = lines.findIndex((l) => l.includes('2 agents failed just now'))
    expect(first).toBeGreaterThan(-1)
    expect(first).toBeLessThan(second)
  })

  it('--json prints the raw report and nothing else', () => {
    const lines: string[] = []
    printFleet({ json: true }, result(healthy()), (line) => lines.push(line))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).verdict).toBe('healthy')
  })
})
