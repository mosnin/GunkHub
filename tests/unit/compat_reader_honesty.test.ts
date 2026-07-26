/**
 * `FlightReader.getRunDivergence` / `.getAgentDivergence` — the honesty checks.
 *
 * Every test here is a server that answers plausibly and WRONGLY, in the one
 * direction that matters: the response reads as "nothing wrong, ship it" to a
 * caller that trusts it. That is the whole threat model of this endpoint. A
 * divergence report is read by a CI gate that authorises a fleet-wide deploy,
 * so the failure mode is not "the SDK throws when it shouldn't" — it is a
 * green build over a version that removes a tool three hundred runs depend on.
 *
 * The house rule this follows (see `getRunEventWindow`'s ignored-floor check
 * and `assertProjectionHonored`): SERVERS LIE BY OMISSION. A deployment that
 * predates a query parameter does not reject it, it DROPS it and answers a
 * different question in the same response shape. So a parameter that changes
 * the meaning of the answer must be echoed back and verified, never assumed.
 *
 * Mocked fetch throughout — no network, no backend.
 */
import { FlightReader, V1ApiError } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

import type {
  DivergenceReport,
  FleetDivergenceReport,
  ProvenDivergence,
  SpeculativeDivergence,
} from '@agent-flight-recorder/contracts'
import type { V1FetchLike } from '@agent-flight-recorder/sdk'

const config = { baseUrl: 'http://localhost:3000', apiKey: 'k' }

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
    async text() {
      return JSON.stringify(body)
    },
    headers: { get: () => null },
  }
}

function serve(data: unknown): V1FetchLike {
  return vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
}

const proven: ProvenDivergence = {
  certainty: 'proven',
  kind: 'tool_removed',
  dimension: 'tools',
  reasonKey: 'tool_removed:search_web',
  provenClaim: 'called tool `search_web` at sequence 42; target declares no such tool',
  provenBy: [
    {
      citedEvent: { sequenceNumber: 42, eventType: 'tool.call' },
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
  speculativeBecause: 'a prompt effect is not derivable from a recorded history',
  changedConfigPath: 'systemPrompt',
}

/** A clean, complete, honest report about `ver_new`. The control. */
function cleanReport(overrides: Partial<DivergenceReport> = {}): DivergenceReport {
  return {
    runId: 'run_1',
    baselineVersionId: 'ver_old',
    targetVersionId: 'ver_new',
    analyzedAt: 1_700_000_000_000,
    verdict: 'compatible',
    proven: [],
    speculative: [],
    indeterminate: [],
    coverage: {
      assessed: ['tools', 'model', 'system_prompt', 'budgets', 'decoding_params', 'capabilities'],
      unassessed: [],
      eventsExamined: 120,
      eventHistoryComplete: true,
    },
    ...overrides,
  }
}

function cleanFleetReport(overrides: Partial<FleetDivergenceReport> = {}): FleetDivergenceReport {
  return {
    agentId: 'ag_1',
    targetVersionId: 'ver_new',
    analyzedAt: 1_700_000_000_000,
    verdict: 'compatible',
    provenReasons: [],
    speculativeReasons: [],
    indeterminateReasons: [],
    runsWithProvenDivergence: 0,
    window: { runsScanned: 512, runsAnalyzed: 512, runsUnassessable: 0, runsSkippedForBudget: 0, scanTruncated: false },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The request it makes
// ---------------------------------------------------------------------------

describe('getRunDivergence — request', () => {
  it('sends targetVersionId to the run-scoped divergence endpoint', async () => {
    const fetchImpl = serve({ report: cleanReport() })
    await new FlightReader(config, fetchImpl).getRunDivergence('run_1', { targetVersionId: 'ver_new' })

    const mock = fetchImpl as unknown as { mock: { calls: [string][] } }
    expect(mock.mock.calls).toHaveLength(1)
    const url = new URL(mock.mock.calls[0]![0])
    expect(url.pathname).toBe('/api/v1/runs/run_1/divergence')
    expect(url.searchParams.get('targetVersionId')).toBe('ver_new')
  })

  it('refuses an empty targetVersionId before spending a request', async () => {
    const fetchImpl = serve({ report: cleanReport() })
    await expect(
      new FlightReader(config, fetchImpl).getRunDivergence('run_1', { targetVersionId: '' })
    ).rejects.toThrow(RangeError)
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('resolves normally on an honest clean report', async () => {
    const { report } = await new FlightReader(config, serve({ report: cleanReport() })).getRunDivergence('run_1', {
      targetVersionId: 'ver_new',
    })
    expect(report.verdict).toBe('compatible')
    expect(report.proven).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// THE IGNORED PARAMETER — the false clean this method exists to refuse
// ---------------------------------------------------------------------------

describe('getRunDivergence — a server that IGNORED targetVersionId', () => {
  it('refuses a report about a DIFFERENT version rather than reporting a false clean', async () => {
    // The realistic shape of this bug: a deployment that predates the
    // parameter drops it and analyses the run against its OWN recorded
    // version — against which every recorded run is trivially compatible. The
    // response is a perfectly well-formed, perfectly clean report. It is also
    // an answer to a question nobody asked.
    const fetchImpl = serve({ report: cleanReport({ targetVersionId: 'ver_old' }) })

    const error = await new FlightReader(config, fetchImpl)
      .getRunDivergence('run_1', { targetVersionId: 'ver_new' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(V1ApiError)
    expect((error as V1ApiError).kind).toBe('invalid_response')
    // The message must name the actual hazard, not just "mismatch" — whoever
    // reads it is mid-deploy and needs to know why their clean report is void.
    expect((error as V1ApiError).message).toContain('ver_new')
    expect((error as V1ApiError).message).toContain('ignored the parameter')
  })

  it('treats an ABSENT echo as just as fatal as a wrong one', async () => {
    // Absence proves nothing was honored either. "The field is missing so it
    // probably worked" is precisely the reasoning that ships the false clean.
    const { targetVersionId: _dropped, ...noEcho } = cleanReport()
    const fetchImpl = serve({ report: noEcho })

    await expect(
      new FlightReader(config, fetchImpl).getRunDivergence('run_1', { targetVersionId: 'ver_new' })
    ).rejects.toBeInstanceOf(V1ApiError)
  })
})

// ---------------------------------------------------------------------------
// The other three ways a clean report can be a lie
// ---------------------------------------------------------------------------

describe('getRunDivergence — an unverifiable clean report', () => {
  it('refuses a report with no coverage record: "found nothing" and "checked nothing" are different answers', async () => {
    const { coverage: _dropped, ...noCoverage } = cleanReport()
    const error = await new FlightReader(config, serve({ report: noCoverage }))
      .getRunDivergence('run_1', { targetVersionId: 'ver_new' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(V1ApiError)
    expect((error as V1ApiError).message).toContain('coverage')
  })

  it('refuses a SPECULATIVE finding served inside the proven list', async () => {
    // The type system makes this impossible in our code. It cannot make it
    // impossible in a JSON body — TypeScript's guarantee stops at the wire —
    // so the same segregation is re-checked at runtime, before any caller
    // renders "the prompt changed" as "this run could not have happened".
    const report = cleanReport({
      verdict: 'incompatible',
      proven: [speculative as unknown as ProvenDivergence],
    })
    const error = await new FlightReader(config, serve({ report }))
      .getRunDivergence('run_1', { targetVersionId: 'ver_new' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(V1ApiError)
    expect((error as V1ApiError).message).toContain('conflation')
  })

  it('refuses a proven finding with no evidence attached', async () => {
    const proofless = { ...proven, provenBy: [] } as unknown as ProvenDivergence
    const error = await new FlightReader(config, serve({ report: cleanReport({ verdict: 'incompatible', proven: [proofless] }) }))
      .getRunDivergence('run_1', { targetVersionId: 'ver_new' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(V1ApiError)
    expect((error as V1ApiError).message).toContain('provenBy')
  })

  it('refuses an absent `indeterminate` list — it would read as "nothing went unanswered"', async () => {
    const { indeterminate: _dropped, ...noIndeterminate } = cleanReport()
    await expect(
      new FlightReader(config, serve({ report: noIndeterminate })).getRunDivergence('run_1', {
        targetVersionId: 'ver_new',
      })
    ).rejects.toBeInstanceOf(V1ApiError)
  })

  it('refuses a verdict that contradicts the report it summarises', async () => {
    // A server saying `compatible` while carrying a proven divergence is a
    // server whose other fields have earned no benefit of the doubt.
    const lying = cleanReport({ verdict: 'compatible', proven: [proven] })
    const error = await new FlightReader(config, serve({ report: lying }))
      .getRunDivergence('run_1', { targetVersionId: 'ver_new' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(V1ApiError)
    expect((error as V1ApiError).message).toContain('incompatible')
  })

  it('does NOT refuse an honestly-declared incomplete analysis — that is the gate’s call, not the client’s', async () => {
    // The distinction that keeps this from being over-defensive: an ignored
    // parameter is the server returning a WRONG answer indistinguishable from
    // a right one. Incomplete coverage is the server TELLING THE TRUTH, in a
    // field. It resolves, with `indeterminate`, and `afr compat` exits 11.
    const partial = cleanReport({
      verdict: 'indeterminate',
      coverage: {
        assessed: ['model'],
        unassessed: [{ dimension: 'tools', reason: 'unsupported_config_shape' }],
        eventsExamined: 120,
        eventHistoryComplete: true,
      },
    })
    const { report } = await new FlightReader(config, serve({ report: partial })).getRunDivergence('run_1', {
      targetVersionId: 'ver_new',
    })
    expect(report.verdict).toBe('indeterminate')
  })
})

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

describe('getAgentDivergence', () => {
  it('sends target, window and limit to the agent-scoped endpoint', async () => {
    const fetchImpl = serve({ report: cleanFleetReport({ window: { since: 1_699_000_000_000, runsScanned: 10, runsAnalyzed: 10, runsUnassessable: 0, runsSkippedForBudget: 0, scanTruncated: false } }) })
    await new FlightReader(config, fetchImpl).getAgentDivergence('ag_1', {
      targetVersionId: 'ver_new',
      since: 1_699_000_000_000,
      limit: 200,
    })

    const url = new URL((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0])
    expect(url.pathname).toBe('/api/v1/agents/ag_1/divergence')
    expect(url.searchParams.get('targetVersionId')).toBe('ver_new')
    expect(url.searchParams.get('since')).toBe('1699000000000')
    expect(url.searchParams.get('limit')).toBe('200')
  })

  it('refuses a scan that IGNORED `since` and answered about a different set of runs', async () => {
    // Not the same hazard as a dropped target version, but the same class: the
    // reasons returned are real, and they belong to a question nobody asked.
    // A clean answer over runs that predate the change is a false clean.
    const fetchImpl = serve({ report: cleanFleetReport() }) // window has no `since`
    const error = await new FlightReader(config, fetchImpl)
      .getAgentDivergence('ag_1', { targetVersionId: 'ver_new', since: 1_699_000_000_000 })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(V1ApiError)
    expect((error as V1ApiError).message).toContain('ignored the window bound')
  })

  it('refuses a fleet report with no scan window', async () => {
    const { window: _dropped, ...noWindow } = cleanFleetReport()
    await expect(
      new FlightReader(config, serve({ report: noWindow })).getAgentDivergence('ag_1', { targetVersionId: 'ver_new' })
    ).rejects.toBeInstanceOf(V1ApiError)
  })

  it('surfaces a truncated scan rather than refusing it — and it can never read as compatible', async () => {
    const truncated = cleanFleetReport({
      verdict: 'indeterminate',
      window: { runsScanned: 2000, runsAnalyzed: 2000, runsUnassessable: 0, runsSkippedForBudget: 0, scanTruncated: true, scanRowCeiling: 2000 },
    })
    const { report } = await new FlightReader(config, serve({ report: truncated })).getAgentDivergence('ag_1', {
      targetVersionId: 'ver_new',
    })
    expect(report.window.scanTruncated).toBe(true)
    expect(report.verdict).toBe('indeterminate')
  })

  it('refuses a grouped speculative reason filed under provenReasons', async () => {
    const crossed = cleanFleetReport({
      verdict: 'incompatible',
      provenReasons: [
        {
          reasonKey: 'system_prompt_changed',
          kind: 'tool_removed',
          certainty: 'proven',
          affectedRunCount: 300,
          representativeRunIds: ['run_a'],
          exemplar: speculative as unknown as ProvenDivergence,
        },
      ],
    })
    await expect(
      new FlightReader(config, serve({ report: crossed })).getAgentDivergence('ag_1', { targetVersionId: 'ver_new' })
    ).rejects.toBeInstanceOf(V1ApiError)
  })
})
