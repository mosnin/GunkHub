/**
 * Tests for `afr explain <runId>` — the CLI's root-cause explanation
 * rendering (`packages/cli/src/commands/explain.ts`), plus dispatch through
 * `main()`. Every test uses a mocked fetch — no real HTTP, no live backend.
 *
 * The v1 explanation endpoint itself only ever resolves `{ explanation:
 * RunExplanation | null }` (mirroring the existing Clerk-authed
 * `GET /api/runs/:id/explanation` — see docs/design/explanations.md's
 * "Known gap: coarse null state"), so `runExplain` also fetches the run
 * itself (`GET /api/v1/runs/:id`) to disambiguate "not failed" from
 * "pending" client-side. Every test mocks both calls.
 */
import { main, parseExplainArgs, printExplain, runExplain } from '@agent-flight-recorder/cli'
import { describe, expect, it, vi } from 'vitest'

import type { ApiFetchLike } from '@agent-flight-recorder/cli'
import type { Run, RunExplanation, RunStatus } from '@agent-flight-recorder/contracts'

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

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    agentId: 'agent_1',
    status: 'failed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_500,
    metadata: {},
    tags: [],
    ...overrides,
  }
}

/** Mock fetch that routes /explanation vs everything else (getRun) to different bodies. */
function mockFetch(runStatus: RunStatus, explanation: RunExplanation | null): ApiFetchLike {
  return vi.fn(async (url: string) => {
    if (url.includes('/explanation')) return jsonResponse(200, { apiVersion: 'v1', data: { explanation } })
    return jsonResponse(200, { apiVersion: 'v1', data: { run: makeRun({ status: runStatus }), eventCount: 4, artifactCount: 0 } })
  })
}

describe('afr explain — arg parsing', () => {
  it('parses the runId positional and --json', () => {
    expect(parseExplainArgs(['run_1', '--json'])).toEqual({ runId: 'run_1', json: true })
  })

  it('parses no args', () => {
    expect(parseExplainArgs([])).toEqual({})
  })
})

describe('afr explain — rendering by failure class', () => {
  const readyExplanation: RunExplanation = {
    id: 'exp_1',
    orgId: 'org_1',
    runId: 'run_1',
    kind: 'heuristic',
    summary: 'The agent called a tool that timed out and never recovered.',
    rootCause: 'The `lookup_order` tool call at seq=4 exceeded its timeout.',
    suggestedFix: 'Add a retry with backoff around `lookup_order`.',
    citedSequenceNumbers: [3, 4, 5],
    failureClass: 'tool_error',
    generatedAt: 1_700_000_000_000,
    version: 1,
  }

  for (const failureClass of ['tool_error', 'llm_error', 'timeout', 'upstream_dependency', 'invalid_output', 'unknown', 'some_new_class']) {
    it(`renders header/summary/root-cause/fix/cited-events for failureClass=${failureClass}`, async () => {
      const fetchImpl = mockFetch('failed', { ...readyExplanation, failureClass })
      const result = await runExplain('run_1', env, fetchImpl)
      const log = vi.fn()
      printExplain({}, result, log)
      const output = log.mock.calls.map((c) => c[0] as string).join('\n')

      expect(output).toContain('The agent called a tool that timed out and never recovered.')
      expect(output).toContain('The `lookup_order` tool call at seq=4 exceeded its timeout.')
      expect(output).toContain('Add a retry with backoff around `lookup_order`.')
      expect(output).toContain('3, 4, 5')
      expect(output).toContain('afr replay run_1')
    })
  }

  it('omits the suggested-fix section when suggestedFix is absent', async () => {
    const { suggestedFix: _drop, ...withoutFix } = readyExplanation
    const fetchImpl = mockFetch('failed', withoutFix as RunExplanation)
    const result = await runExplain('run_1', env, fetchImpl)
    const log = vi.fn()
    printExplain({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).not.toContain('Suggested fix:')
  })

  it('an llm-kind explanation with a model name appends it to the Generated line', async () => {
    const fetchImpl = mockFetch('failed', { ...readyExplanation, kind: 'llm', model: 'claude-3-5-haiku-20241022' })
    const result = await runExplain('run_1', env, fetchImpl)
    const log = vi.fn()
    printExplain({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('model: claude-3-5-haiku-20241022')
  })

  it('--json prints the raw derived result', async () => {
    const fetchImpl = mockFetch('failed', readyExplanation)
    const result = await runExplain('run_1', env, fetchImpl)
    const log = vi.fn()
    printExplain({ json: true }, result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"rootCause"'))
  })
})

describe('afr explain — honest states', () => {
  it('a completed run prints a plain "nothing to explain" message', async () => {
    const fetchImpl = mockFetch('completed', null)
    const result = await runExplain('run_1', env, fetchImpl)
    const log = vi.fn()
    printExplain({}, result, log)
    expect(log).toHaveBeenCalledWith('This run completed successfully — nothing to explain.')
  })

  it('a still-running run prints a status-specific "nothing to explain yet" message', async () => {
    const fetchImpl = mockFetch('running', null)
    const result = await runExplain('run_1', env, fetchImpl)
    const log = vi.fn()
    printExplain({}, result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining("hasn't failed"))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('running'))
  })

  it('a cancelled run also reads as "nothing to explain"', async () => {
    const fetchImpl = mockFetch('cancelled', null)
    const result = await runExplain('run_1', env, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status).toBe('not_failed')
  })

  it('a failed run with no explanation yet prints a clear "not generated yet" message', async () => {
    const fetchImpl = mockFetch('failed', null)
    const result = await runExplain('run_1', env, fetchImpl)
    const log = vi.fn()
    printExplain({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain("hasn't been generated")
    expect(output).toContain('afr replay run_1')
  })

  it('a timed_out run with no explanation yet is also treated as pending (ADR-004 covers failed + timed_out)', async () => {
    const fetchImpl = mockFetch('timed_out', null)
    const result = await runExplain('run_1', env, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status).toBe('pending')
  })

  it('--json still prints raw JSON for honest states', async () => {
    const fetchImpl = mockFetch('completed', null)
    const result = await runExplain('run_1', env, fetchImpl)
    const log = vi.fn()
    printExplain({ json: true }, result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"not_failed"'))
  })
})

describe('afr explain — errors and dispatch', () => {
  it('fails with a clear message when AFR_API_KEY/AFR_BASE_URL are unset', async () => {
    const result = await runExplain('run_1', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('afr config check')
    }
  })

  it('surfaces a 404 (run not found) as a not-found command failure (exit 3)', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'Run not found' } }))
    const result = await runExplain('missing', env, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(3)
      const log = vi.fn()
      printExplain({}, result, log)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Run not found'))
    }
  })

  it("'afr explain --help' prints usage and exits 0", async () => {
    const log = vi.fn()
    const code = await main(['explain', '--help'], log)
    expect(code).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
  })

  it("'afr explain' without a runId exits 1 with a usage message", async () => {
    const log = vi.fn()
    const code = await main(['explain'], log)
    expect(code).toBe(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
  })
})
