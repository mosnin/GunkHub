/* eslint-disable */
// Tests for the hardened HttpExplanationLLM (ADR-004 follow-up, Cycle 2):
// request timeout, bounded single retry on 5xx/network failure, max-output
// -size guard, and robust/defensive output parsing. `explain()` must NEVER
// throw and must degrade to `undefined` (heuristic fallback) on any failure
// mode — see convex/run_explanations.ts for how the caller uses this.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  HttpExplanationLLM,
  NoopExplanationLLM,
  getConfiguredExplanationLLM,
  parseExplanationLLMResponse,
} from './llm_provider'

const prompt = { prompt: 'explain this', availableSequenceNumbers: [1, 2, 3] }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete process.env['AFR_LLM_PROVIDER']
  delete process.env['AFR_LLM_ENDPOINT']
  delete process.env['AFR_LLM_API_KEY']
})

// ---------------------------------------------------------------------------
// parseExplanationLLMResponse — defensive parsing
// ---------------------------------------------------------------------------
describe('parseExplanationLLMResponse', () => {
  it('extracts a clean, well-formed object', () => {
    const result = parseExplanationLLMResponse({
      summary: 'S',
      rootCause: 'R',
      suggestedFix: 'F',
      citedSeqNums: [1, 2],
    })
    expect(result).toEqual({ summary: 'S', rootCause: 'R', suggestedFix: 'F', citedSeqNums: [1, 2] })
  })

  it('tolerates prose wrapped around a JSON object', () => {
    const raw = 'Sure, here is the explanation:\n{"summary":"S","rootCause":"R","citedSeqNums":[1]}\nHope that helps!'
    const result = parseExplanationLLMResponse(raw)
    expect(result?.summary).toBe('S')
    expect(result?.rootCause).toBe('R')
    expect(result?.citedSeqNums).toEqual([1])
  })

  it('returns undefined for a bare string with no JSON object at all', () => {
    expect(parseExplanationLLMResponse('just prose, no json here')).toBeUndefined()
  })

  it('tolerates missing suggestedFix and missing citedSeqNums', () => {
    const result = parseExplanationLLMResponse({ summary: 'S', rootCause: 'R' })
    expect(result).toEqual({ summary: 'S', rootCause: 'R', suggestedFix: undefined, citedSeqNums: [] })
  })

  it('drops unknown/extra fields without failing the parse', () => {
    const result = parseExplanationLLMResponse({
      summary: 'S',
      rootCause: 'R',
      citedSeqNums: [1],
      unexpectedVendorField: { nested: true },
      confidence: 0.99,
    })
    expect(result).toEqual({ summary: 'S', rootCause: 'R', suggestedFix: undefined, citedSeqNums: [1] })
  })

  it('returns undefined when summary is missing', () => {
    expect(parseExplanationLLMResponse({ rootCause: 'R' })).toBeUndefined()
  })

  it('returns undefined when rootCause is missing', () => {
    expect(parseExplanationLLMResponse({ summary: 'S' })).toBeUndefined()
  })

  it('returns undefined when summary/rootCause are present but blank', () => {
    expect(parseExplanationLLMResponse({ summary: '   ', rootCause: 'R' })).toBeUndefined()
  })

  it('returns undefined for non-object input (array, number, null)', () => {
    expect(parseExplanationLLMResponse([1, 2, 3])).toBeUndefined()
    expect(parseExplanationLLMResponse(42)).toBeUndefined()
    expect(parseExplanationLLMResponse(null)).toBeUndefined()
  })

  it('filters non-number entries out of citedSeqNums (wrong-typed elements)', () => {
    const result = parseExplanationLLMResponse({
      summary: 'S',
      rootCause: 'R',
      citedSeqNums: [1, 'two', 3, null, NaN, Infinity],
    })
    expect(result?.citedSeqNums).toEqual([1, 3])
  })

  // Injection-defense belt-and-suspenders: an LLM returning a huge summary or
  // an enormous fake citation list must be bounded here, before
  // run_explanations.ts's own truncateToBytes/validateCitedSeqNums even run.
  it('clamps a 100 KB summary field to a bounded character length', () => {
    const hugeSummary = 'x'.repeat(100 * 1024)
    const result = parseExplanationLLMResponse({ summary: hugeSummary, rootCause: 'R', citedSeqNums: [] })
    expect(result).toBeDefined()
    expect(result!.summary.length).toBeLessThan(100 * 1024)
    expect(result!.summary.length).toBeLessThanOrEqual(8 * 1024)
  })

  it('clamps a 100 KB rootCause / suggestedFix field similarly', () => {
    const huge = 'y'.repeat(100 * 1024)
    const result = parseExplanationLLMResponse({ summary: 'S', rootCause: huge, suggestedFix: huge, citedSeqNums: [] })
    expect(result!.rootCause.length).toBeLessThanOrEqual(8 * 1024)
    expect(result!.suggestedFix!.length).toBeLessThanOrEqual(8 * 1024)
  })

  it('bounds a citedSeqNums array of 500 fake sequence numbers', () => {
    const fakeCites = Array.from({ length: 500 }, (_, i) => 10_000 + i)
    const result = parseExplanationLLMResponse({ summary: 'S', rootCause: 'R', citedSeqNums: fakeCites })
    expect(result!.citedSeqNums.length).toBeLessThan(500)
    expect(result!.citedSeqNums.length).toBeLessThanOrEqual(100)
  })
})

// ---------------------------------------------------------------------------
// HttpExplanationLLM — timeout, retry, size guard, never-throws
// ---------------------------------------------------------------------------
describe('HttpExplanationLLM', () => {
  it('returns a result and a generationMs note on a clean 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ summary: 'S', rootCause: 'R', citedSeqNums: [1] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const llm = new HttpExplanationLLM('https://llm.example.test/explain')
    const result = await llm.explain(prompt)
    expect(result?.summary).toBe('S')
    expect(result?.citedSeqNums).toEqual([1])
    expect(typeof result?.generationMs).toBe('number')
    expect(result?.generationMs).toBeGreaterThanOrEqual(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never throws and returns undefined when fetch rejects (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)

    const llm = new HttpExplanationLLM('https://llm.example.test/explain')
    await expect(llm.explain(prompt)).resolves.toBeUndefined()
    // Network error is retryable — one bounded retry, no more.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries exactly once on a 5xx and succeeds on the second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ summary: 'S', rootCause: 'R', citedSeqNums: [2] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const llm = new HttpExplanationLLM('https://llm.example.test/explain')
    const result = await llm.explain(prompt)
    expect(result?.summary).toBe('S')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 4xx response (not a transient failure)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    vi.stubGlobal('fetch', fetchMock)

    const llm = new HttpExplanationLLM('https://llm.example.test/explain')
    await expect(llm.explain(prompt)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up (bounded retry, never infinite) after two consecutive 5xx failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)

    const llm = new HttpExplanationLLM('https://llm.example.test/explain')
    await expect(llm.explain(prompt)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a malformed (non-JSON, no extractable object) 2xx body as a non-retryable bad response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => 'not json at all' })
    vi.stubGlobal('fetch', fetchMock)

    const llm = new HttpExplanationLLM('https://llm.example.test/explain')
    await expect(llm.explain(prompt)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversized response body without attempting to parse it', async () => {
    const oversized = 'a'.repeat(300 * 1024) // > 256 KB guard
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => oversized })
    vi.stubGlobal('fetch', fetchMock)

    const llm = new HttpExplanationLLM('https://llm.example.test/explain')
    await expect(llm.explain(prompt)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1) // oversized body is non-retryable
  })

  it('times out and degrades to undefined (with a single bounded retry) when the endpoint never responds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => new Promise(() => {})) // never resolves, never rejects
    vi.stubGlobal('fetch', fetchMock)

    const llm = new HttpExplanationLLM('https://llm.example.test/explain')
    const resultPromise = llm.explain(prompt)

    // Advance past both attempts' 20s timeouts.
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.advanceTimersByTimeAsync(20_000)

    await expect(resultPromise).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// NoopExplanationLLM / getConfiguredExplanationLLM — unaffected by hardening
// ---------------------------------------------------------------------------
describe('NoopExplanationLLM / getConfiguredExplanationLLM', () => {
  it('NoopExplanationLLM always resolves to undefined', async () => {
    await expect(new NoopExplanationLLM().explain(prompt)).resolves.toBeUndefined()
  })

  it('falls back to Noop when AFR_LLM_PROVIDER is unset', () => {
    expect(getConfiguredExplanationLLM()).toBeInstanceOf(NoopExplanationLLM)
  })

  it('falls back to Noop when AFR_LLM_PROVIDER=http but AFR_LLM_ENDPOINT is unset', () => {
    process.env['AFR_LLM_PROVIDER'] = 'http'
    expect(getConfiguredExplanationLLM()).toBeInstanceOf(NoopExplanationLLM)
  })

  it('returns an HttpExplanationLLM when both are configured', () => {
    process.env['AFR_LLM_PROVIDER'] = 'http'
    process.env['AFR_LLM_ENDPOINT'] = 'https://llm.example.test/explain'
    expect(getConfiguredExplanationLLM()).toBeInstanceOf(HttpExplanationLLM)
  })
})
