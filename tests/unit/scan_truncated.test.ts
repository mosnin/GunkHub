/**
 * The truncation marker, end to end: server field -> SDK type -> `afr patterns`
 * output -> process exit code.
 *
 * WHAT THIS GUARDS. `GET /api/v1/patterns` overfetches a bounded window of rows
 * and filters it, so a FILTERED request can come back short or empty purely
 * because it hit `PATTERN_SCAN_ROW_CEILING` rather than the end of the table.
 * Convex declares that with `scanTruncated`/`scannedRows`/`scanRowCeiling`
 * (`convex/read_api.ts`). Before this cycle nothing downstream read it:
 * `V1ListFailurePatternsData` did not declare the field, so it arrived at
 * runtime and was invisible to the type system, and `afr patterns --state
 * regressed` — the CI gate the CLI README documents — printed "No recurring
 * failure patterns found." and exited 0 on a scan it could not complete. A
 * regression past the ceiling meant a green build.
 *
 * WHY THE TESTS BELOW ASSERT ON *ABSENCE* OF A SENTENCE AND ON THE EXIT CODE,
 * not merely on the presence of a warning: the buggy behaviour produces a
 * well-formed, plausible, entirely successful-looking response. Nothing about
 * it looks wrong. The only observable difference between "clean" and "never
 * checked" is whether the truncation marker was read, so that is what is
 * pinned.
 *
 * Every test uses a mocked fetch — no real HTTP, no live backend.
 */
import { main, printPatterns, runPatterns } from '@agent-flight-recorder/cli'
import { isPatternScanComplete } from '@agent-flight-recorder/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApiFetchLike, PatternsArgs, PatternsResult } from '@agent-flight-recorder/cli'
import type { FailurePattern } from '@agent-flight-recorder/contracts'
import type { V1ListFailurePatternsData } from '@agent-flight-recorder/sdk'

/**
 * The exit code is written out literally, never imported from the source. A
 * test that reads the constant it is checking passes just as happily after
 * someone changes the constant, which is exactly the change this needs to
 * catch — `11` is a wire contract with CI scripts, not an implementation
 * detail.
 */
const EXIT_COULD_NOT_EVALUATE = 11

const env = { apiKey: 'k', baseUrl: 'http://localhost:3000' }

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
    representativeRunIds: ['run_1'],
    affectedAgentVersionIds: ['av_1'],
    ...overrides,
  }
}

/** A `/api/v1/patterns` response body, shaped exactly as `convex/read_api.ts` returns it. */
function patternsBody(data: Partial<V1ListFailurePatternsData>) {
  return {
    apiVersion: 'v1',
    data: { patterns: [], ...data },
  }
}

function fetchReturning(data: Partial<V1ListFailurePatternsData>): ApiFetchLike {
  return vi.fn(async () => jsonResponse(200, patternsBody(data))) as unknown as ApiFetchLike
}

/** Collect `printPatterns` output as one string. */
function render(args: PatternsArgs, result: PatternsResult): string {
  const lines: string[] = []
  printPatterns(args, result, (line) => lines.push(line))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 1. The SDK types the field at all.
// ---------------------------------------------------------------------------

describe('V1ListFailurePatternsData carries the scan-window marker', () => {
  it('surfaces scanTruncated/scannedRows/scanRowCeiling from the response', async () => {
    const result = await runPatterns(
      { state: 'regressed' },
      env,
      fetchReturning({ scanTruncated: true, scannedRows: 2000, scanRowCeiling: 2000 })
    )
    const data = result.ok ? result : (result as { data: V1ListFailurePatternsData }).data
    // Read WITHOUT a cast. If the interface stops declaring these, this file
    // fails to typecheck — which is the real regression guard, since the bug
    // was precisely that the values arrived untyped.
    expect(data.scanTruncated).toBe(true)
    expect(data.scannedRows).toBe(2000)
    expect(data.scanRowCeiling).toBe(2000)
  })

  it('isPatternScanComplete: false only for an explicit true', () => {
    expect(isPatternScanComplete({ scanTruncated: true })).toBe(false)
    expect(isPatternScanComplete({ scanTruncated: false })).toBe(true)
    // Absent = deployment predates the marker. Reported as complete so an
    // older deployment behaves as it already did, rather than becoming
    // permanently inconclusive.
    expect(isPatternScanComplete({})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. The empty page stops making a whole-dataset claim.
// ---------------------------------------------------------------------------

describe('afr patterns — a truncated scan is not "nothing found"', () => {
  it('does NOT print the whole-dataset sentence when the scan was truncated', async () => {
    const result = await runPatterns(
      { state: 'regressed' },
      env,
      fetchReturning({ patterns: [], scanTruncated: true, scannedRows: 2000, scanRowCeiling: 2000 })
    )
    const out = render({ state: 'regressed' }, result)

    // The sentence is a claim about the entire dataset. After a truncated scan
    // it is false, and printing it is the whole bug.
    expect(out).not.toContain('No recurring failure patterns found.')
    expect(out).toContain('No matching patterns in the rows scanned')
    expect(out).toContain('NOT "none exist"')
  })

  it('annotates with the existing bracket idiom, carrying the row counts', async () => {
    const result = await runPatterns(
      { state: 'regressed' },
      env,
      fetchReturning({ patterns: [], scanTruncated: true, scannedRows: 2000, scanRowCeiling: 2000 })
    )
    // Same shape as `[muted]` / `[stale 9h]` — not a second idiom.
    expect(render({ state: 'regressed' }, result)).toContain('[scan truncated 2000/2000 rows]')
  })

  it('degrades to a bare [scan truncated] when the deployment sends no row counts', async () => {
    const result = await runPatterns({ state: 'regressed' }, env, fetchReturning({ patterns: [], scanTruncated: true }))
    const out = render({ state: 'regressed' }, result)
    expect(out).toContain('[scan truncated]')
    expect(out).not.toContain('No recurring failure patterns found.')
  })

  it('STILL prints the plain sentence on a complete scan — the honest empty answer', async () => {
    const result = await runPatterns(
      { state: 'regressed' },
      env,
      fetchReturning({ patterns: [], scanTruncated: false, scannedRows: 137, scanRowCeiling: 2000 })
    )
    expect(render({ state: 'regressed' }, result)).toContain('No recurring failure patterns found.')
  })

  it('and on a deployment that never declares the marker at all', async () => {
    const result = await runPatterns({ state: 'regressed' }, env, fetchReturning({ patterns: [] }))
    expect(render({ state: 'regressed' }, result)).toContain('No recurring failure patterns found.')
  })

  it('footnotes a NON-empty truncated page as partial, after the table', async () => {
    const args: PatternsArgs = { state: 'regressed' }
    const result = await runPatterns(
      args,
      env,
      fetchReturning({
        patterns: [makePattern()],
        scanTruncated: true,
        scannedRows: 2000,
        scanRowCeiling: 2000,
      })
    )
    const out = render(args, result)
    // The rows are real and are still shown — truncation makes the list
    // incomplete, not wrong.
    expect(out).toContain('lookup_order tool call times out')
    expect(out).toContain('This list is PARTIAL [scan truncated 2000/2000 rows]')
  })
})

// ---------------------------------------------------------------------------
// 3. The exit code — the part CI actually reads.
// ---------------------------------------------------------------------------

describe('afr patterns — exit code on an incomplete scan', () => {
  it('a filtered truncated scan does not report success', async () => {
    const result = await runPatterns(
      { state: 'regressed' },
      env,
      fetchReturning({ patterns: [], scanTruncated: true, scannedRows: 2000, scanRowCeiling: 2000 })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.exitCode).toBe(EXIT_COULD_NOT_EVALUATE)
    // Must not collide with the request-level band, which means something else.
    expect([0, 1, 2, 3, 4]).not.toContain(result.exitCode)
  })

  it.each([
    ['--state', { state: 'regressed' } as PatternsArgs],
    ['--status', { status: 'resolved' } as PatternsArgs],
    ['--regressed', { regressed: true } as PatternsArgs],
    ['--agent', { agent: 'agent_1' } as PatternsArgs],
    ['--spiking', { spiking: true } as PatternsArgs],
    ['--muted', { muted: true } as PatternsArgs],
    ['--active', { active: true } as PatternsArgs],
  ])('%s is a filter, so a truncated scan under it exits 11', async (_flag, args) => {
    const result = await runPatterns(args, env, fetchReturning({ patterns: [], scanTruncated: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(EXIT_COULD_NOT_EVALUATE)
  })

  it('an UNFILTERED listing still exits 0 — it makes no whole-dataset claim', async () => {
    const result = await runPatterns(
      {},
      env,
      fetchReturning({ patterns: [makePattern()], scanTruncated: true, scannedRows: 2000, scanRowCeiling: 2000 })
    )
    expect(result.ok).toBe(true)
    // ...but the reader is still told. Only the exit code is withheld.
    expect(render({}, result)).toContain('[scan truncated 2000/2000 rows]')
  })

  it('a complete filtered scan with no matches still exits 0', async () => {
    const result = await runPatterns(
      { state: 'regressed' },
      env,
      fetchReturning({ patterns: [], scanTruncated: false, scannedRows: 12, scanRowCeiling: 2000 })
    )
    expect(result.ok).toBe(true)
  })

  it('--json carries the incompleteness rather than hiding it behind the exit code', async () => {
    const args: PatternsArgs = { state: 'regressed', json: true }
    const result = await runPatterns(
      args,
      env,
      fetchReturning({ patterns: [], scanTruncated: true, scannedRows: 2000, scanRowCeiling: 2000 })
    )
    const parsed = JSON.parse(render(args, result)) as Record<string, unknown>
    expect(parsed['ok']).toBe(false)
    expect(parsed['scanIncomplete']).toBe(true)
    expect(parsed['exitCode']).toBe(EXIT_COULD_NOT_EVALUATE)
    expect(parsed['scanTruncated']).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Through main(), because that is the number the shell sees.
//
// runPatterns returning `{ ok: false, exitCode: 11 }` is only half the story —
// index.ts turns a result into a process exit code, and a gate that never
// reaches the shell is not a gate.
// ---------------------------------------------------------------------------

describe('afr patterns — the process exit code', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...originalEnv }
  })

  async function runMain(argv: string[], body: Partial<V1ListFailurePatternsData>) {
    process.env['AFR_API_KEY'] = 'k'
    process.env['AFR_BASE_URL'] = 'http://localhost:3000'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, patternsBody(body)))
    )
    const lines: string[] = []
    const code = await main(argv, (line) => lines.push(line))
    return { code, out: lines.join('\n') }
  }

  it('`afr patterns --state regressed` exits 11, not 0, on a truncated scan', async () => {
    const { code, out } = await runMain(['patterns', '--state', 'regressed'], {
      patterns: [],
      scanTruncated: true,
      scannedRows: 2000,
      scanRowCeiling: 2000,
    })
    expect(code).toBe(EXIT_COULD_NOT_EVALUATE)
    expect(out).not.toContain('No recurring failure patterns found.')
  })

  it('the same command exits 0 when the scan actually completed and found nothing', async () => {
    const { code, out } = await runMain(['patterns', '--state', 'regressed'], {
      patterns: [],
      scanTruncated: false,
      scannedRows: 12,
      scanRowCeiling: 2000,
    })
    expect(code).toBe(0)
    expect(out).toContain('No recurring failure patterns found.')
  })

  it('and exits 0 when the scan completed and DID find a regression (10 is not ours)', async () => {
    const { code } = await runMain(['patterns', '--state', 'regressed'], {
      patterns: [makePattern()],
      scanTruncated: false,
    })
    expect(code).toBe(0)
  })
})
