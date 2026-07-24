/**
 * Tests for `afr patterns` — the CLI's recurring-failure-patterns listing
 * (`packages/cli/src/commands/patterns.ts`), plus dispatch through `main()`.
 * Every test uses a mocked fetch — no real HTTP, no live backend. Mirrors
 * `tests/unit/explain.test.ts` / `tests/unit/cli_v1_api.test.ts`'s `afr runs
 * list` coverage.
 */
import { main, parsePatternsArgs, printPatterns, runPatterns } from '@agent-flight-recorder/cli'
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

  it('marks a spiking pattern in the SPIKING column', async () => {
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
