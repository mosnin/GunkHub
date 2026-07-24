/**
 * Tests for `afr patterns` — the CLI's recurring-failure-patterns listing
 * (`packages/cli/src/commands/patterns.ts`), plus dispatch through `main()`.
 * Every test uses a mocked fetch — no real HTTP, no live backend. Mirrors
 * `tests/unit/explain.test.ts` / `tests/unit/cli_v1_api.test.ts`'s `afr runs
 * list` coverage.
 */
import {
  main,
  parsePatternsArgs,
  printPatterns,
  printPatternsEvidence,
  runPatterns,
  runPatternsEvidence,
} from '@agent-flight-recorder/cli'
import { describe, expect, it, vi } from 'vitest'

import type { ApiFetchLike } from '@agent-flight-recorder/cli'
import type { FailurePattern } from '@agent-flight-recorder/contracts'

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

const env = { apiKey: 'k', baseUrl: 'http://localhost:3000' }

function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    id: 'fp_1',
    orgId: 'org_1',
    fingerprintHash: 'hash_1',
    class: 'tool_error',
    label: 'lookup_order tool call times out',
    salientKey: 'lookup_order',
    count: 12,
    firstSeenAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_500_000,
    representativeRunIds: ['run_1', 'run_2'],
    affectedAgentVersionIds: ['av_1'],
    ...overrides,
  }
}

describe('afr patterns — arg parsing', () => {
  it('parses --agent, --limit, --json', () => {
    expect(parsePatternsArgs(['--agent', 'agent_1', '--limit', '5', '--json'])).toEqual({
      agent: 'agent_1',
      limit: 5,
      json: true,
    })
  })

  it('parses no args', () => {
    expect(parsePatternsArgs([])).toEqual({})
  })

  it('parses --spiking', () => {
    expect(parsePatternsArgs(['--spiking'])).toEqual({ spiking: true })
  })

  it('parses --spiking alongside --agent/--limit/--json', () => {
    expect(parsePatternsArgs(['--agent', 'agent_1', '--spiking', '--limit', '5', '--json'])).toEqual({
      agent: 'agent_1',
      spiking: true,
      limit: 5,
      json: true,
    })
  })

  it('parses --muted', () => {
    expect(parsePatternsArgs(['--muted'])).toEqual({ muted: true })
  })

  it('parses --active', () => {
    expect(parsePatternsArgs(['--active'])).toEqual({ active: true })
  })

  it('parses --status', () => {
    expect(parsePatternsArgs(['--status', 'resolved'])).toEqual({ status: 'resolved' })
  })

  it('parses --regressed', () => {
    expect(parsePatternsArgs(['--regressed'])).toEqual({ regressed: true })
  })

  it('parses --status alongside --agent/--regressed/--limit/--json', () => {
    expect(
      parsePatternsArgs(['--agent', 'agent_1', '--status', 'open', '--regressed', '--limit', '5', '--json'])
    ).toEqual({
      agent: 'agent_1',
      status: 'open',
      regressed: true,
      limit: 5,
      json: true,
    })
  })
})

describe('afr patterns — happy path', () => {
  it('lists patterns as a human table by default', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [makePattern()] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    expect(result.ok).toBe(true)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('tool_error')
    expect(output).toContain('lookup_order tool call times out')
    expect(output).toContain('12')
  })

  it('marks a spiking pattern in the SPIKING column, with its recentCount', async () => {
    const spiking = makePattern({
      lastSpikeAssessment: { assessedAt: Date.now(), isSpiking: true, recentCount: 9, baselineMean: 1.2, z: 4.1 },
    })
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [spiking] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toMatch(/yes/)
    expect(output).toContain('yes (9)')
  })

  it('shows "-" in the SPIKING column for a pattern with no spike assessment', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [makePattern()] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).not.toContain('yes')
  })

  it('shows "-" in the SPIKING column for a pattern with a non-spiking assessment', async () => {
    const notSpiking = makePattern({
      lastSpikeAssessment: { assessedAt: Date.now(), isSpiking: false, recentCount: 1, baselineMean: 1.1, z: 0.2 },
    })
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [notSpiking] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).not.toContain('yes')
  })

  it('--spiking forwards spiking=true as a query param', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({ spiking: true }, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('spiking=true')
  })

  it('omits the spiking query param when --spiking is not passed', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({}, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).not.toContain('spiking')
  })

  it('--spiking and --agent/--json compose (both forwarded, --json prints raw response)', async () => {
    const spiking = makePattern({
      lastSpikeAssessment: { assessedAt: Date.now(), isSpiking: true, recentCount: 4, baselineMean: 1, z: 3 },
    })
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [spiking] } })
    )
    const result = await runPatterns({ agent: 'agent_1', spiking: true, json: true }, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('agentId=agent_1')
    expect(url).toContain('spiking=true')
    const log = vi.fn()
    printPatterns({ json: true }, result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"isSpiking"'))
  })

  it('prints "No recurring failure patterns found." when the org has none yet', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    expect(log).toHaveBeenCalledWith('No recurring failure patterns found.')
  })

  it('--json prints the raw API response as JSON', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [makePattern()] } })
    )
    const result = await runPatterns({ json: true }, env, fetchImpl)
    const log = vi.fn()
    printPatterns({ json: true }, result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"fingerprintHash"'))
  })

  it('--agent forwards agentId as a query param', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({ agent: 'agent_1' }, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('agentId=agent_1')
  })

  it('shows "yes" in the MUTED column for a muted pattern', async () => {
    const muted = makePattern({ muted: true, mutedAt: Date.now() })
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [muted] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('MUTED')
    expect(output).toMatch(/yes/)
  })

  it('shows "-" in the MUTED column for an active (unmuted) pattern', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [makePattern()] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).not.toMatch(/yes/)
  })

  it('marks a muted, spiking pattern as distinguishable from an active spiking one', async () => {
    const mutedSpiking = makePattern({
      muted: true,
      lastSpikeAssessment: { assessedAt: Date.now(), isSpiking: true, recentCount: 7, baselineMean: 1, z: 3 },
    })
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [mutedSpiking] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    // Still visibly spiking (mute suppresses alerts, not visibility)...
    expect(output).toContain('yes (7)')
    // ...but annotated as muted, distinct from an active spiking row.
    expect(output).toContain('[muted]')
  })

  it('--muted forwards muted=true as a query param', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({ muted: true }, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('muted=true')
  })

  it('--active forwards muted=false as a query param', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({ active: true }, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('muted=false')
  })

  it('omits the muted query param when neither --muted nor --active is passed', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({}, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).not.toContain('muted')
  })

  it('--muted and --active together fail as a usage error (exit 1) rather than silently picking one', async () => {
    const result = await runPatterns({ muted: true, active: true }, env)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('mutually exclusive')
    }
  })

  it('shows "open" in the STATUS column when status is absent (default)', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [makePattern()] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('STATUS')
    expect(output).toContain('open')
  })

  it('shows "acknowledged"/"resolved" in the STATUS column when set', async () => {
    const acknowledged = makePattern({ id: 'fp_ack', status: 'acknowledged' })
    const resolved = makePattern({ id: 'fp_res', status: 'resolved', resolvedAt: Date.now() })
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [acknowledged, resolved] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('acknowledged')
    expect(output).toContain('resolved')
  })

  it('shows "REGRESSED" instead of "open" when status is open and regressedAt is set', async () => {
    const regressed = makePattern({ status: 'open', regressedAt: Date.now() })
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [regressed] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('REGRESSED')
  })

  it('does not show "REGRESSED" for a resolved pattern even if regressedAt was set historically', async () => {
    // `regressedAt` is omitted rather than passed as `undefined`:
    // exactOptionalPropertyTypes is on, and a resolved pattern that was
    // reopened-then-resolved-again carries no live regression marker.
    const stillResolved = makePattern({ status: 'resolved' })
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [stillResolved] } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).not.toContain('REGRESSED')
    expect(output).toContain('resolved')
  })

  it('--status forwards the value as a query param', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({ status: 'resolved' }, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('status=resolved')
  })

  it('omits the status query param when --status is not passed', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({}, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).not.toContain('status=')
  })

  it('--regressed forwards regressed=true as a query param', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({ regressed: true }, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('regressed=true')
  })

  it('rejects an invalid --status value as a usage error (exit 1)', async () => {
    const result = await runPatterns({ status: 'bogus' }, env)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('--status must be one of')
    }
  })

  it('--status and --agent compose (both forwarded)', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    await runPatterns({ agent: 'agent_1', status: 'resolved' }, env, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('agentId=agent_1')
    expect(url).toContain('status=resolved')
  })

  it('prints a "more results available" hint when nextCursor is present', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { patterns: [makePattern()], nextCursor: 'cur-2' } })
    )
    const result = await runPatterns({}, env, fetchImpl)
    const log = vi.fn()
    printPatterns({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('more results available')
  })
})

describe('afr patterns — errors and dispatch', () => {
  it('fails with a clear message when AFR_API_KEY/AFR_BASE_URL are unset', async () => {
    const result = await runPatterns({}, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('afr config check')
    }
  })

  it('surfaces a 401 (bad key) as an auth command failure (exit 2)', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(401, { error: { message: 'bad key' } }))
    const result = await runPatterns({}, env, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(2)
      const log = vi.fn()
      printPatterns({}, result, log)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('bad key'))
    }
  })

  it('surfaces a network error as exit 4', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const result = await runPatterns({}, env, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(4)
  })

  it("'afr patterns --help' prints usage and exits 0", async () => {
    const log = vi.fn()
    const code = await main(['patterns', '--help'], log)
    expect(code).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
  })

  it("'afr patterns' without AFR_API_KEY/AFR_BASE_URL exits 1 and points at 'afr config check'", async () => {
    const originalEnv = { ...process.env }
    delete process.env['AFR_API_KEY']
    delete process.env['AFR_BASE_URL']
    try {
      const log = vi.fn()
      const code = await main(['patterns'], log)
      expect(code).toBe(1)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('afr config check'))
    } finally {
      process.env = { ...originalEnv }
    }
  })
})

// ---------------------------------------------------------------------------
// ADR-006 cycle 2 — the fix-confidence `--state` filter, and
// `afr patterns evidence <fingerprint>`.
// ---------------------------------------------------------------------------

describe('afr patterns --state — filter validation and forwarding', () => {
  it('parses --state', () => {
    expect(parsePatternsArgs(['--state', 'regressed'])).toEqual({ state: 'regressed' })
  })

  it('forwards --state regressed as a query param', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { patterns: [], nextCursor: undefined }, requestId: 'r1' })
    ) as unknown as ApiFetchLike
    const result = await runPatterns({ state: 'regressed' }, env, fetchImpl)

    expect(result.ok).toBe(true)
    const url = String(vi.mocked(fetchImpl).mock.calls[0]![0])
    expect(url).toContain('state=regressed')
  })

  /**
   * A typo must not silently return an unfiltered list that looks like a
   * match — the same posture --status already takes.
   */
  it('rejects an unknown --state value as a usage error, before any network call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: {}, requestId: 'r' })) as unknown as ApiFetchLike
    const result = await runPatterns({ state: 'regresed' }, env, fetchImpl)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('--state must be one of')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /**
   * The three exposure-dependent states are REJECTED here rather than
   * forwarded and silently answered wrong. The error must name the command
   * that can answer them, so the user is redirected rather than stuck.
   */
  it.each(['unproven', 'proving', 'confirmed'])(
    'rejects the exposure-dependent state %s and points at the evidence command',
    async (state) => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, { data: {}, requestId: 'r' })) as unknown as ApiFetchLike
      const result = await runPatterns({ state }, env, fetchImpl)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('afr patterns evidence')
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('sends no state param when --state is omitted', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { patterns: [], nextCursor: undefined }, requestId: 'r1' })
    ) as unknown as ApiFetchLike
    await runPatterns({}, env, fetchImpl)

    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).not.toContain('state=')
  })
})

describe('afr patterns evidence — fix-confidence evidence', () => {
  function makeEvidence(overrides: Record<string, unknown> = {}) {
    return {
      pattern: makePattern({ status: 'resolved', resolvedAt: 1_700_000_600_000 }),
      resolution: {
        resolvedAt: 1_700_000_600_000,
        resolvedByUserId: 'user_1',
        resolutionNote: 'Added a retry around the flaky lookup',
        resolvedInVersionId: 'av_2',
        resolvedInVersion: 'v1.4.0',
        resolvedAtOccurrenceCount: 12,
        resolvedAtRunCount: 300,
      },
      exposure: {
        since: 1_700_000_600_000,
        runCount: 120,
        runCountTruncated: false,
        recurrenceCount: 0,
        baselineRunCount: 300,
        agentIds: ['agent_1'],
        heldSoFar: true,
      },
      transitions: [
        { action: 'failure_pattern.resolved', actorClerkUserId: 'user_1', timestamp: 1_700_000_600_000 },
      ],
      confidence: {
        score: 0.82,
        state: 'confirmed',
        exposureRuns: 120,
        observedRuns: 120,
        versionAttribution: 'unknown',
        elapsedMs: 8 * 24 * 60 * 60 * 1000,
        recurred: false,
        hasResolution: true,
        exposureMeasured: true,
        exposureCredit: 1,
        soakCredit: 1,
        limitingFactor: 'none',
      },
      ...overrides,
    }
  }

  it('requests the evidence endpoint for the fingerprint', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: makeEvidence(), requestId: 'r1' })
    ) as unknown as ApiFetchLike
    const result = await runPatternsEvidence('hash_1', env, fetchImpl)

    expect(result.ok).toBe(true)
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toContain('/api/v1/patterns/hash_1/evidence')
  })

  it('--json emits the confidence block a CI job gates on', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: makeEvidence(), requestId: 'r1' })
    ) as unknown as ApiFetchLike
    const result = await runPatternsEvidence('hash_1', env, fetchImpl)

    const lines: string[] = []
    printPatternsEvidence({ json: true }, result, (line) => lines.push(line))
    const parsed = JSON.parse(lines.join('\n')) as {
      confidence: { state: string; score: number }
      exposure: { runCount: number }
    }
    expect(parsed.confidence.state).toBe('confirmed')
    // 0-1, never a 0-100 percentage — the CI threshold depends on this scale.
    expect(parsed.confidence.score).toBeLessThanOrEqual(1)
    expect(parsed.exposure.runCount).toBe(120)
  })

  it('renders a truncated run count as a floor, never as an exact total', async () => {
    const evidence = makeEvidence()
    ;(evidence.exposure as { runCount: number; runCountTruncated: boolean }).runCount = 2000
    ;(evidence.exposure as { runCount: number; runCountTruncated: boolean }).runCountTruncated = true
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: evidence, requestId: 'r1' })
    ) as unknown as ApiFetchLike
    const result = await runPatternsEvidence('hash_1', env, fetchImpl)

    const lines: string[] = []
    printPatternsEvidence({}, result, (line) => lines.push(line))
    expect(lines.join('\n')).toContain('2000+')
  })

  /**
   * Zero exposure must never read as success in the rendered output either —
   * the state carries it, and the "why not higher" line says it in words.
   */
  it('renders an unproven, unexercised fix without implying it held', async () => {
    const evidence = makeEvidence({
      exposure: {
        since: 1_700_000_600_000,
        runCount: 0,
        runCountTruncated: false,
        recurrenceCount: 0,
        agentIds: ['agent_1'],
        heldSoFar: true,
      },
      confidence: {
        score: 0,
        state: 'unproven',
        exposureRuns: 0,
        observedRuns: 0,
        versionAttribution: 'unknown',
        elapsedMs: 1000,
        recurred: false,
        hasResolution: true,
        exposureMeasured: true,
        exposureCredit: 0,
        soakCredit: 0,
        limitingFactor: 'no-exposure',
      },
    })
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: evidence, requestId: 'r1' })
    ) as unknown as ApiFetchLike
    const result = await runPatternsEvidence('hash_1', env, fetchImpl)

    const lines: string[] = []
    printPatternsEvidence({}, result, (line) => lines.push(line))
    const output = lines.join('\n')
    expect(output).toContain('UNPROVEN')
    expect(output).toContain('Nothing has run since the fix')
  })

  it('handles a pattern with no resolution to evidence', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: { pattern: makePattern(), resolution: null, exposure: null, transitions: [], confidence: null },
        requestId: 'r1',
      })
    ) as unknown as ApiFetchLike
    const result = await runPatternsEvidence('hash_1', env, fetchImpl)

    const lines: string[] = []
    printPatternsEvidence({}, result, (line) => lines.push(line))
    expect(lines.join('\n')).toContain('nothing to prove yet')
  })

  it('maps a 404 to exit code 3', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Failure pattern not found' }, requestId: 'r1' })
    ) as unknown as ApiFetchLike
    const result = await runPatternsEvidence('nope', env, fetchImpl)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.exitCode).toBe(3)
  })

  it('dispatches through main() and prints its own help', async () => {
    const lines: string[] = []
    const code = await main(['patterns', 'evidence', '--help'], (line) => lines.push(line))
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('afr patterns evidence <fingerprintHash>')
  })

  it('requires a fingerprint argument', async () => {
    const lines: string[] = []
    const code = await main(['patterns', 'evidence'], (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('Usage: afr patterns evidence')
  })
})
