/**
 * `afr compat --agent` — a page is not a fleet answer.
 *
 * THE WORST BUG THIS FEATURE CAN HAVE is exiting zero on a partial scan. A
 * fleet scan is a bounded batch with a cursor — one paginated pass per
 * execution, over runs whose event logs run to `MAX_EVENTS_PER_RUN`, with no
 * index that would make it one query. So the first page comes back looking
 * exactly like a finished scan: full, clean, and silent about the four hundred
 * runs nobody read. The twelfth reason, on the run that matters, is on page
 * four.
 *
 * Two mechanisms are pinned here:
 *
 *   1. The CLI FOLLOWS the cursor and merges pages with contracts'
 *      `mergeFleetDivergenceReports` — one implementation, so a CI gate and a
 *      dashboard cannot add the same pages up differently.
 *   2. Stopping early — at `--max-pages`, or anywhere else — leaves the
 *      outstanding cursor in the merged window, which makes the scan
 *      incomplete, which makes the verdict `indeterminate`, which is exit 11.
 *      The page budget can cost a conclusive answer. It can never buy a green
 *      build.
 */
import {
  COMPAT_EXIT_DIVERGENCE,
  COMPAT_EXIT_INDETERMINATE,
  DEFAULT_MAX_PAGES,
  exitCodeForCompat,
  parseCompatArgs,
  runCompat,
} from '@agent-flight-recorder/cli'
import { fleetDivergenceVerdict, mergeFleetDivergenceReports } from '@agent-flight-recorder/contracts'
import { describe, expect, it, vi } from 'vitest'

import type { CompatFleetResult } from '@agent-flight-recorder/cli'
import type { FleetDivergenceReport, ProvenDivergence } from '@agent-flight-recorder/contracts'
import type { V1FetchLike } from '@agent-flight-recorder/sdk'

const env = { apiKey: 'k', baseUrl: 'http://localhost:3000' }

const proven: ProvenDivergence = {
  certainty: 'proven',
  kind: 'tool_removed',
  dimension: 'tools',
  reasonKey: 'tool_removed:search_web',
  provenClaim: 'called `search_web`; target declares no such tool',
  provenBy: [
    {
      citedEvent: { sequenceNumber: 42, eventType: 'tool.call' },
      targetConfigPath: 'tools[].name',
      recordedValue: 'search_web',
      targetValue: null,
    },
  ],
}

/**
 * A served page.
 *
 * Its `verdict` is COMPUTED from its own contents rather than hard-coded, and
 * that is not a convenience: `FlightReader` refuses any report whose verdict
 * disagrees with its findings, so a hand-written fixture claiming `compatible`
 * while carrying a `nextCursor` is rejected before it reaches the CLI. Writing
 * these by hand caught exactly that, which is the check working — a page with
 * pages behind it cannot call itself compatible.
 */
function page(overrides: Partial<FleetDivergenceReport> = {}): FleetDivergenceReport {
  const base: FleetDivergenceReport = {
    agentId: 'ag_1',
    targetVersionId: 'ver_new',
    analyzedAt: 1_700_000_000_000,
    verdict: 'compatible',
    provenReasons: [],
    speculativeReasons: [],
    indeterminateReasons: [],
    runsWithProvenDivergence: 0,
    window: {
      runsScanned: 100,
      runsAnalyzed: 100,
      runsUnassessable: 0,
      runsSkippedForBudget: 0,
      scanTruncated: false,
    },
    ...overrides,
  }
  return { ...base, verdict: fleetDivergenceVerdict(base) }
}

/** Serve a sequence of pages, one per request, and record the cursors asked for. */
function servePages(pages: FleetDivergenceReport[]): V1FetchLike & { cursors: (string | null)[] } {
  const cursors: (string | null)[] = []
  let index = 0
  const impl = vi.fn(async (url: string) => {
    cursors.push(new URL(url).searchParams.get('cursor'))
    const report = pages[Math.min(index, pages.length - 1)]
    index++
    return {
      ok: true,
      status: 200,
      async json() {
        return { apiVersion: 'v1', data: { report } }
      },
      async text() {
        return ''
      },
      headers: { get: () => null },
    }
  })
  return Object.assign(impl as unknown as V1FetchLike, { cursors })
}

async function runFleet(fetchImpl: V1FetchLike, argv: string[] = []) {
  const args = parseCompatArgs(['--agent', 'ag_1', '--target', 'ver_new', ...argv])
  const result = await runCompat(args, env, fetchImpl)
  expect(result.ok).toBe(true)
  return result as CompatFleetResult
}

// ---------------------------------------------------------------------------
// It pages, and it merges
// ---------------------------------------------------------------------------

describe('the fleet scan is assembled from pages, not assumed to arrive whole', () => {
  it('follows nextCursor until the scan finishes', async () => {
    const fetchImpl = servePages([
      page({ window: { ...page().window, nextCursor: 'c1' } }),
      page({ window: { ...page().window, nextCursor: 'c2' } }),
      page(),
    ])
    const result = await runFleet(fetchImpl)

    expect(result.pagesFetched).toBe(3)
    expect(fetchImpl.cursors).toEqual([null, 'c1', 'c2'])
    expect(result.report.window.nextCursor).toBeUndefined()
    expect(exitCodeForCompat(result)).toBe(0)
  })

  it('merges reasons across pages by reasonKey, so counts add and causes do not duplicate', async () => {
    // Pages partition the run set and reason keys are run-independent, so this
    // merge is exact rather than approximate. 211 + 129 runs broken for ONE
    // reason must read as one reason affecting 340 runs — the entire value of
    // the fleet view is that the number an engineer acts on is the number of
    // causes.
    const reason = (runs: number, runIds: string[]) => ({
      reasonKey: 'tool_removed:search_web',
      kind: 'tool_removed' as const,
      certainty: 'proven' as const,
      affectedRunCount: runs,
      representativeRunIds: runIds,
      exemplar: proven,
    })
    const fetchImpl = servePages([
      page({
        verdict: 'incompatible',
        provenReasons: [reason(211, ['run_a', 'run_b'])],
        runsWithProvenDivergence: 211,
        window: { ...page().window, nextCursor: 'c1' },
      }),
      page({
        verdict: 'incompatible',
        provenReasons: [reason(129, ['run_c'])],
        runsWithProvenDivergence: 129,
      }),
    ])
    const result = await runFleet(fetchImpl)

    expect(result.report.provenReasons).toHaveLength(1)
    expect(result.report.provenReasons[0]!.affectedRunCount).toBe(340)
    expect(result.report.provenReasons[0]!.representativeRunIds).toEqual(['run_a', 'run_b', 'run_c'])
    expect(result.report.runsWithProvenDivergence).toBe(340)
    expect(result.report.window.runsScanned).toBe(200)
    expect(exitCodeForCompat(result)).toBe(COMPAT_EXIT_DIVERGENCE)
  })
})

// ---------------------------------------------------------------------------
// A partial scan is NEVER a pass
// ---------------------------------------------------------------------------

describe('a partial fleet scan can never exit 0', () => {
  it('exits 11 when the page budget runs out with pages remaining', async () => {
    // Every page is clean, every page is full, and the scan is not finished.
    // This is precisely the shape that would go green if `nextCursor` were not
    // folded into completeness.
    const fetchImpl = servePages([
      page({ window: { ...page().window, nextCursor: 'c1' } }),
      page({ window: { ...page().window, nextCursor: 'c2' } }),
      page({ window: { ...page().window, nextCursor: 'c3' } }),
    ])
    const result = await runFleet(fetchImpl, ['--max-pages', '2'])

    expect(result.pagesFetched).toBe(2)
    expect(result.report.provenReasons).toHaveLength(0)
    expect(result.report.window.nextCursor).toBe('c2')
    expect(result.report.verdict).toBe('indeterminate')
    expect(exitCodeForCompat(result)).toBe(COMPAT_EXIT_INDETERMINATE)
  })

  it('says so in words, not only in the exit code', async () => {
    // The person reading a CI log is not the person who wrote the exit-code
    // table.
    const fetchImpl = servePages([page({ window: { ...page().window, nextCursor: 'more' } })])
    const args = parseCompatArgs(['--agent', 'ag_1', '--target', 'ver_new', '--max-pages', '1'])
    const result = await runCompat(args, env, fetchImpl)
    const lines: string[] = []
    const { printCompat } = await import('@agent-flight-recorder/cli')
    printCompat(args, result, (line) => lines.push(line))

    const output = lines.join('\n')
    expect(output).toContain('PAGES REMAIN')
    expect(output).toContain('NOT THE WHOLE FLEET')
  })

  it('still exits 10 when a partial scan found a proof — 10 wins over 11', async () => {
    const fetchImpl = servePages([
      page({
        verdict: 'incompatible',
        provenReasons: [
          {
            reasonKey: 'tool_removed:search_web',
            kind: 'tool_removed',
            certainty: 'proven',
            affectedRunCount: 12,
            representativeRunIds: ['run_a'],
            exemplar: proven,
          },
        ],
        runsWithProvenDivergence: 12,
        window: { ...page().window, nextCursor: 'more' },
      }),
    ])
    const result = await runFleet(fetchImpl, ['--max-pages', '1'])
    expect(exitCodeForCompat(result)).toBe(COMPAT_EXIT_DIVERGENCE)
  })

  it('exits 11 when runs were skipped for budget, even on a finished scan', async () => {
    const fetchImpl = servePages([
      page({ window: { ...page().window, runsAnalyzed: 80, runsSkippedForBudget: 20 } }),
    ])
    const result = await runFleet(fetchImpl)
    expect(result.report.verdict).toBe('indeterminate')
    expect(exitCodeForCompat(result)).toBe(COMPAT_EXIT_INDETERMINATE)
  })

  it('refuses a non-advancing cursor instead of looping a CI job forever', async () => {
    const stalled = page({ window: { ...page().window, nextCursor: 'stuck' } })
    let first = true
    const fetchImpl = vi.fn(async () => {
      // First call has no cursor; every call after is handed 'stuck' and
      // returns 'stuck' again.
      first = false
      return {
        ok: true,
        status: 200,
        async json() {
          return { apiVersion: 'v1', data: { report: stalled } }
        },
        async text() {
          return ''
        },
        headers: { get: () => null },
      }
    }) as unknown as V1FetchLike
    expect(first || true).toBe(true)

    const args = parseCompatArgs(['--agent', 'ag_1', '--target', 'ver_new'])
    const result = await runCompat(args, env, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(4)
      expect(result.message).toContain('non-advancing')
    }
  })

  it('has a page budget that is finite', () => {
    // An unbounded loop in a CI step is a hung build. The bound exists; the
    // tests above are what stop it from being the reason a build goes green.
    expect(DEFAULT_MAX_PAGES).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_MAX_PAGES)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The merge itself
// ---------------------------------------------------------------------------

describe('mergeFleetDivergenceReports', () => {
  it('is conservative about the window: any incomplete page makes the whole scan incomplete', () => {
    const merged = mergeFleetDivergenceReports([
      page({ window: { ...page().window, scanTruncated: true } }),
      page(),
    ])
    expect(merged.window.scanTruncated).toBe(true)
    expect(merged.verdict).toBe('indeterminate')
  })

  it('recomputes the verdict from merged contents rather than inheriting a page’s', () => {
    // Each page said `compatible` about its own slice. Neither was wrong; the
    // merged scan is still unfinished, and inheriting either verdict would
    // report a partial scan as a whole-fleet all-clear.
    const merged = mergeFleetDivergenceReports([
      page({ verdict: 'compatible', window: { ...page().window, nextCursor: 'more' } }),
    ])
    expect(merged.verdict).toBe('indeterminate')
  })

  it('refuses to merge pages about different versions', () => {
    expect(() =>
      mergeFleetDivergenceReports([page(), page({ targetVersionId: 'ver_other' })])
    ).toThrow(RangeError)
  })

  it('requires at least one page', () => {
    expect(() => mergeFleetDivergenceReports([])).toThrow(RangeError)
  })
})
