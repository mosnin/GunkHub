/**
 * `afr triage` — the CLI's cheap first hop, and a CI GATE.
 *
 * THE EXIT CODES ARE THE POINT OF THIS FILE. The table renders; the exit code
 * decides whether a build goes red. Iteration 2 fixed a defect where an empty
 * page could mean "nothing matched on the slice I looked at" rather than
 * "nothing matched", and the response now carries explicit truncation markers.
 * A gate that exits 0 on a scan it could not finish turns a red build green,
 * which is the exact failure this product exists to prevent — so the emptiness
 * cases below are asserted far more heavily than the happy path.
 *
 * The ranking itself is NOT re-tested here. It lives in
 * `packages/sdk/src/triage.ts` and is covered by `tests/unit/mcp_triage*.test.ts`
 * against the MCP surface. Re-asserting the ordering here would create a second
 * specification of the same behaviour that could drift from the first — which is
 * precisely why there is one ranking rather than two. What IS asserted here is
 * that the CLI reaches that one ranking and does not reinterpret it.
 */
import {
  TRIAGE_EXIT_FINDINGS,
  TRIAGE_EXIT_INCOMPLETE,
  exitCodeForTriage,
  main,
  parseTriageArgs,
  printTriage,
  runTriage,
  type ApiFetchLike,
  type TriageCommandResult,
} from '@agent-flight-recorder/cli'
import { SCAN_LIMIT, TRIAGE_REQUEST_FIELDS, type FailurePattern } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

const env = { apiKey: 'k', baseUrl: 'https://afr.example.com' }
const NOW = 1_700_000_000_000

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response
}

/**
 * The `fixConfidence` envelope a CURRENT deployment always sends.
 *
 * Included by default because omitting it is itself a caveat ("this deployment
 * served no fix confidence"), which makes the result incomplete and every
 * verdict `unknown`. A fixture without it silently tests the degraded path, so
 * the cases that mean to exercise it opt IN via `patternsResponse`'s override.
 */
const FRESH_CONFIDENCE = { stalenessBoundMs: 86_400_000, entries: [], staleCount: 0, unevaluated: [] }

/**
 * A v1 `GET /api/v1/patterns` success envelope with whatever `data` the case
 * needs, defaulting to a current deployment's `fixConfidence` envelope.
 */
function patternsResponse(data: Record<string, unknown>): ApiFetchLike {
  const body = { fixConfidence: FRESH_CONFIDENCE, ...data }
  return vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: body })) as unknown as ApiFetchLike
}

/**
 * A PROJECTED pattern — exactly the fields `TRIAGE_REQUEST_FIELDS` asks for,
 * plus `fingerprintHash`, the identity field the read API returns whether or
 * not it was requested.
 *
 * Deliberately NOT a full `FailurePattern`. The SDK refuses a response carrying
 * fields that were not requested, because an older deployment silently ignores
 * `?fields=` and returns the whole document — which looks exactly like a
 * projection that happened to include everything. Building the fixture from the
 * real field list keeps this test honest about what the wire actually carries,
 * and means a change to the ranking's inputs shows up here rather than passing
 * against a fixture richer than production.
 */
function makePattern(over: Partial<FailurePattern> = {}): FailurePattern {
  return {
    fingerprintHash: 'a1b2c3d4e5f6a1b2',
    class: 'tool_error',
    label: 'lookup_order tool call times out',
    count: 12,
    lastSeenAt: NOW - 3_600_000,
    representativeRunIds: ['run_abc123'],
    ...over,
  } as FailurePattern
}

// ---------------------------------------------------------------------------
// Exit codes — the CI gate
// ---------------------------------------------------------------------------

describe('afr triage — exit codes', () => {
  it('exits 0 ONLY on a complete scan that found nothing', () => {
    expect(exitCodeForTriage({ verdict: 'clear', complete: true, scanned: 40, items: [] })).toBe(0)
  })

  it('exits 10 when items were found', () => {
    expect(
      exitCodeForTriage({ verdict: 'issues', complete: true, scanned: 40, items: [] as never[] })
    ).toBe(TRIAGE_EXIT_FINDINGS)
    expect(TRIAGE_EXIT_FINDINGS).toBe(10)
  })

  it('exits 11 when nothing was found but the view was incomplete', () => {
    expect(
      exitCodeForTriage({
        verdict: 'unknown',
        complete: false,
        scanned: 50,
        items: [],
        caveats: ['Server scan hit its row ceiling; patterns may be missing entirely.'],
      })
    ).toBe(TRIAGE_EXIT_INCOMPLETE)
    expect(TRIAGE_EXIT_INCOMPLETE).toBe(11)
  })

  /**
   * THE LOAD-BEARING ASSERTION. `verdict` is computed as
   * `items.length > 0 ? 'issues' : complete ? 'clear' : 'unknown'`, so `'clear'`
   * implies `complete`. That makes exit 0 structurally unreachable on an
   * incomplete scan rather than merely conventionally avoided.
   *
   * Asserted over the whole verdict/complete cross-product so that if anyone
   * ever decouples the two — or maps a verdict differently — the failure lands
   * here rather than in a CI job that silently went green.
   */
  it('NEVER exits 0 on an incomplete view, for any verdict', () => {
    for (const verdict of ['issues', 'clear', 'unknown'] as const) {
      for (const complete of [true, false]) {
        const code = exitCodeForTriage({ verdict, complete, scanned: 1, items: [] })
        if (!complete) {
          expect(code, `verdict=${verdict} complete=false must not be 0`).not.toBe(0)
        }
      }
    }
  })

  /**
   * `verdict: 'clear', complete: false` is UNREACHABLE from the real ranking —
   * `'clear'` is only produced when `complete` is true. This asserts the
   * defensive branch anyway, because the invariant it relies on lives in
   * `@agent-flight-recorder/sdk` and is shared with the MCP server: a change
   * made there for the MCP surface must not quietly turn this gate green.
   */
  it('refuses to exit 0 even on a hand-built clear-but-incomplete result', () => {
    expect(exitCodeForTriage({ verdict: 'clear', complete: false, scanned: 1, items: [] })).toBe(
      TRIAGE_EXIT_INCOMPLETE
    )
  })

  it('keeps findings (10) above the transport band, so it can never be read as a network error', () => {
    // 0-4 are usage/auth/not-found/network. 10 and 11 sit clear of them.
    expect(TRIAGE_EXIT_FINDINGS).toBeGreaterThan(4)
    expect(TRIAGE_EXIT_INCOMPLETE).toBeGreaterThan(4)
    expect(TRIAGE_EXIT_FINDINGS).not.toBe(TRIAGE_EXIT_INCOMPLETE)
  })
})

// ---------------------------------------------------------------------------
// End-to-end through main(), which is what CI actually invokes
// ---------------------------------------------------------------------------

describe('afr triage — exit codes through main()', () => {
  const origKey = process.env['AFR_API_KEY']
  const origUrl = process.env['AFR_BASE_URL']

  function withEnv(fn: () => Promise<number>): Promise<number> {
    process.env['AFR_API_KEY'] = env.apiKey
    process.env['AFR_BASE_URL'] = env.baseUrl
    return fn().finally(() => {
      if (origKey === undefined) delete process.env['AFR_API_KEY']
      else process.env['AFR_API_KEY'] = origKey
      if (origUrl === undefined) delete process.env['AFR_BASE_URL']
      else process.env['AFR_BASE_URL'] = origUrl
    })
  }

  it('--help exits 0 without calling the API', async () => {
    const lines: string[] = []
    const code = await main(['triage', '--help'], (l) => lines.push(l))
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('EXIT CODES')
  })

  it('missing credentials is a usage error (exit 1), not a false all-clear', async () => {
    delete process.env['AFR_API_KEY']
    delete process.env['AFR_BASE_URL']
    const lines: string[] = []
    const code = await main(['triage'], (l) => lines.push(l))
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('AFR_API_KEY')
    if (origKey !== undefined) process.env['AFR_API_KEY'] = origKey
    if (origUrl !== undefined) process.env['AFR_BASE_URL'] = origUrl
  })

  it('a truncated, EMPTY scan exits 11 — never 0', async () => {
    const code = await withEnv(async () => {
      const result = await runTriage(
        {},
        env,
        patternsResponse({ patterns: [], scanTruncated: true, nextCursor: 'c1' }),
        NOW
      )
      expect(result.ok).toBe(true)
      return result.ok ? exitCodeForTriage(result) : -1
    })
    expect(code).toBe(TRIAGE_EXIT_INCOMPLETE)
  })

  it('a complete, empty scan exits 0', async () => {
    const result = await runTriage({}, env, patternsResponse({ patterns: [] }), NOW)
    expect(result.ok).toBe(true)
    expect(result.ok && result.verdict).toBe('clear')
    expect(result.ok ? exitCodeForTriage(result) : -1).toBe(0)
  })

  it('findings exit 10 even when the scan was also truncated', async () => {
    const result = await runTriage(
      {},
      env,
      patternsResponse({ patterns: [makePattern()], scanTruncated: true, nextCursor: 'c1' }),
      NOW
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.verdict).toBe('issues')
    expect(result.ok && result.complete).toBe(false)
    expect(result.ok ? exitCodeForTriage(result) : -1).toBe(TRIAGE_EXIT_FINDINGS)
  })
})

// ---------------------------------------------------------------------------
// The upstream request — composition over the existing endpoint
// ---------------------------------------------------------------------------

describe('afr triage — upstream request', () => {
  it('reads the EXISTING /api/v1/patterns endpoint, not a new triage route', async () => {
    const fetchImpl = patternsResponse({ patterns: [] })
    await runTriage({}, env, fetchImpl, NOW)
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('/api/v1/patterns')
    expect(url).not.toContain('/api/v1/triage')
  })

  it("sends the ranking's own field selection and scan limit, not hand-written ones", async () => {
    const fetchImpl = patternsResponse({ patterns: [] })
    await runTriage({}, env, fetchImpl, NOW)
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    // Derived from the SDK constants so this cannot drift from what the MCP
    // tool asks for — a divergent field selection would silently change the
    // ranking's inputs on one surface only.
    expect(url).toContain(`limit=${String(SCAN_LIMIT)}`)
    const fields = new URL(url).searchParams.get('fields')
    expect(fields).not.toBeNull()
    expect((fields ?? '').split(',').sort()).toEqual([...TRIAGE_REQUEST_FIELDS].sort())
  })

  it('forwards --agent as agentId', async () => {
    const fetchImpl = patternsResponse({ patterns: [] })
    await runTriage({ agent: 'agent_support' }, env, fetchImpl, NOW)
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('agentId=agent_support')
  })

  it('maps auth failures to the shared convention (exit 2), not to a triage code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { apiVersion: 'v1', error: { code: 'FORBIDDEN', message: 'no read scope' } })
    ) as unknown as ApiFetchLike
    const result = await runTriage({}, env, fetchImpl, NOW)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.exitCode).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

describe('afr triage — output', () => {
  function render(result: TriageCommandResult, json = false): string {
    const lines: string[] = []
    printTriage(json ? { json: true } : {}, result, (l) => lines.push(l))
    return lines.join('\n')
  }

  it('never reports an incomplete empty scan as healthy', async () => {
    const result = await runTriage(
      {},
      env,
      patternsResponse({ patterns: [], scanTruncated: true }),
      NOW
    )
    const out = render(result)
    expect(out).toContain('COULD NOT DETERMINE')
    expect(out).toContain('NOT a clean bill of health')
    expect(out).not.toMatch(/Nothing to triage/)
  })

  it('states plainly when a complete scan found nothing', async () => {
    const result = await runTriage({}, env, patternsResponse({ patterns: [] }), NOW)
    expect(render(result)).toContain('Nothing to triage')
  })

  it('prints caveats alongside findings, so a partial list is never read as whole', async () => {
    const result = await runTriage(
      {},
      env,
      patternsResponse({ patterns: [makePattern()], scanTruncated: true, nextCursor: 'c1' }),
      NOW
    )
    const out = render(result)
    expect(out).toContain('Incomplete view:')
    expect(out).toContain('row ceiling')
  })

  it('renders next hops as runnable afr commands, not MCP tool names', async () => {
    const result = await runTriage({}, env, patternsResponse({ patterns: [makePattern()] }), NOW)
    const out = render(result)
    expect(out).toContain('afr explain run_abc123')
    expect(out).not.toContain('afr_explain_run')
  })

  it('points a resolved pattern at the evidence command instead of a run', async () => {
    const resolved = makePattern({ status: 'resolved', resolvedAt: NOW - 7_200_000 })
    const result = await runTriage({}, env, patternsResponse({ patterns: [resolved] }), NOW)
    expect(render(result)).toContain('afr patterns evidence')
  })

  /**
   * `--json` must be the RANKING's result verbatim — the same object the MCP
   * tool serves, pointers in their MCP tool-name form. A consumer diffing the
   * two surfaces should find nothing, so the CLI's human-facing command
   * translation must NOT leak into the machine surface.
   */
  it('--json emits untranslated MCP pointers and no CLI-only keys', async () => {
    const result = await runTriage({}, env, patternsResponse({ patterns: [makePattern()] }), NOW)
    const parsed = JSON.parse(render(result, true)) as Record<string, unknown> & {
      items: { next: { tool: string } }[]
    }
    expect(parsed.items[0]?.next.tool).toBe('afr_explain_run')
    // `ok` is the CLI's own discriminator and must not appear on the wire shape.
    expect('ok' in parsed).toBe(false)
    expect(parsed['verdict']).toBe('issues')
    expect(parsed['complete']).toBe(true)
  })

  it('flags a muted pattern rather than hiding it', async () => {
    const muted = makePattern({ muted: true })
    const result = await runTriage({}, env, patternsResponse({ patterns: [muted] }), NOW)
    const out = render(result)
    expect(out).toContain('MUTED')
    expect(out).toMatch(/\byes\b/)
  })
})

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

describe('afr triage — arg parsing', () => {
  it('requires no arguments at all', () => {
    expect(parseTriageArgs([])).toEqual({})
  })

  it('parses --agent, --json and --help', () => {
    expect(parseTriageArgs(['--agent', 'a1'])).toEqual({ agent: 'a1' })
    expect(parseTriageArgs(['--json'])).toEqual({ json: true })
    expect(parseTriageArgs(['--help'])).toEqual({ help: true })
    expect(parseTriageArgs(['-h'])).toEqual({ help: true })
  })

  it('offers no --limit, so the documented cost stays the real cost', () => {
    expect(() => parseTriageArgs(['--limit', '50'])).toThrow()
  })
})
