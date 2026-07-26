/**
 * `FlightReader.getExplanation` — the `status` discriminant (SDK 0.14.0).
 *
 * `convex/read_api.ts`'s `apiGetExplanation` has returned
 * `{ status, explanation, runStatus, runEndedAt }` since the coarse-null audit
 * fix, but `V1GetExplanationData` only declared `explanation`, so an SDK
 * consumer could not see the discriminant without casting. These pin that the
 * fields survive the envelope AND that the type stays tolerant of an older
 * deployment that omits them.
 *
 * Mocked fetch throughout — no real HTTP.
 */
import { FlightReader } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { V1FetchLike, V1GetExplanationData } from '@agent-flight-recorder/sdk'

const config = { baseUrl: 'http://localhost:3000', apiKey: 'k' }

function dataResponse(data: unknown): V1FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { apiVersion: 'v1', data }
    },
    async text() {
      return ''
    },
    headers: { get: () => null },
  }))
}

describe('getExplanation — status discriminant', () => {
  it("surfaces status 'ready' alongside the explanation", async () => {
    const explanation = {
      runId: 'run_1',
      kind: 'heuristic',
      summary: 'tool timeout',
      rootCause: 'search tool exceeded 30s',
      citedSequenceNumbers: [41, 42],
      failureClass: 'tool_timeout',
      generatedAt: 1_700_000_000_000,
      version: 1,
    }
    const reader = new FlightReader(config, dataResponse({ status: 'ready', explanation, runStatus: 'failed', runEndedAt: 1_700_000_000_500 }))

    const result = await reader.getExplanation('run_1')
    expect(result.status).toBe('ready')
    expect(result.runStatus).toBe('failed')
    expect(result.runEndedAt).toBe(1_700_000_000_500)
    expect(result.explanation?.rootCause).toBe('search tool exceeded 30s')
  })

  it("distinguishes 'pending' from 'not_eligible' — both of which carry explanation: null", async () => {
    const pending = new FlightReader(config, dataResponse({ status: 'pending', explanation: null, runStatus: 'failed' }))
    const notEligible = new FlightReader(
      config,
      dataResponse({ status: 'not_eligible', explanation: null, runStatus: 'completed' }),
    )

    const a = await pending.getExplanation('run_1')
    const b = await notEligible.getExplanation('run_2')

    expect(a.explanation).toBeNull()
    expect(b.explanation).toBeNull()
    // The whole point: identical `explanation`, different `status`.
    expect(a.status).toBe('pending')
    expect(b.status).toBe('not_eligible')
  })

  it('a null explanation resolves successfully — it is never an error', async () => {
    const reader = new FlightReader(config, dataResponse({ status: 'pending', explanation: null, runStatus: 'failed' }))
    await expect(reader.getExplanation('run_1')).resolves.toBeDefined()
  })

  it('stays typecheckable against an older deployment that sends only `explanation`', async () => {
    const reader = new FlightReader(config, dataResponse({ explanation: null }))

    const result: V1GetExplanationData = await reader.getExplanation('run_1')
    expect(result.explanation).toBeNull()
    expect(result.status).toBeUndefined()
    expect(result.runStatus).toBeUndefined()
  })
})
