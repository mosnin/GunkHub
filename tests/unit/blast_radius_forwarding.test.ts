/**
 * blast_radius_forwarding.test.ts — the `convexFunctions.ts` seam for
 * divergence.
 *
 * ===========================================================================
 * WHY A TABLE-DRIVEN FORWARDING TEST, AND NOT JUST TYPES
 * ===========================================================================
 *
 * `apps/web/src/lib/convexFunctions.ts` is a hand-maintained table of
 * `makeFunctionReference('module:fn')` string refs. There is NO structural type
 * checked against the real Convex handler's `args`, so a forwarder that
 * silently omits a declared parameter is not a type error. Seven runtime bugs
 * have shipped through this seam — including a filter that was parsed correctly
 * by the route, sent correctly by the CLI, implemented correctly in Convex, and
 * dropped on the floor by the forwarder in between (see
 * tests/unit/api_v1_failure_patterns_params.test.ts, the precedent this file
 * follows).
 *
 * `scripts/check-convex-refs.ts` catches a ref naming a function that does not
 * exist, or passing an arg the validator does not declare. What it cannot catch
 * is the case this file exists for: a parameter the CALLER accepts and then
 * never forwards, which is invisible to both TypeScript and the ref checker.
 *
 * ---------------------------------------------------------------------------
 * THE FIELDS THAT MATTER MOST ARE THE COMPLETENESS FIELDS
 * ---------------------------------------------------------------------------
 *
 * `coverage`, `eventHistoryComplete`, `scanTruncated`, `runsSkippedForBudget`
 * and the cursors are the fields most likely to be dropped by a forwarder that
 * "tidies" a response shape — and they are exactly the fields that decide
 * between an honest `indeterminate` and a false `compatible`. A forwarder that
 * loses them turns a partial scan into a green build. So this file asserts on
 * their SURVIVAL through the service layer, not just on the request direction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/convexServer', () => ({
  getAuthedClient: vi.fn(),
  getPublicClient: vi.fn(() => ({})),
  hashApiKey: vi.fn((k: string) => `hash:${k}`),
  withConvexTimeout: vi.fn(async (p: Promise<unknown>) => p),
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    divergence: {
      compareVersionConfigs: 'divergence:compareVersionConfigs',
      analyzeRun: 'divergence:analyzeRun',
      analyzeFleet: 'divergence:analyzeFleet',
    },
  },
}))

// The argument signature is declared explicitly so `mock.calls[0]` is typed as
// the real 2-tuple this test destructures, not the empty tuple a zero-arg
// inference produces.
const queryMock = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => ({}) as unknown)

const getAgentVersionMock = vi.fn()
const getRunMock = vi.fn()

vi.mock('@/lib/services/agent_versions', () => ({
  getAgentVersion: (...a: unknown[]) => getAgentVersionMock(...a),
}))
vi.mock('@/lib/services/runs', () => ({
  getRun: (...a: unknown[]) => getRunMock(...a),
}))

import { getAuthedClient } from '@/lib/convexServer'
import { getBlastRadius, getRunDivergence } from '@/lib/services/divergence'

const VERSION_WITH_SNAPSHOT = {
  id: 'ver_1',
  agentId: 'agent_1',
  orgId: 'org_1',
  version: '2.0.0',
  createdAt: 0,
  configSnapshot: { tools: ['a'] },
}

const FULL_COVERAGE = {
  assessed: ['tools', 'model', 'system_prompt', 'budgets', 'decoding_params', 'capabilities'],
  unassessed: [],
  eventsExamined: 40,
  eventHistoryComplete: true,
}

beforeEach(() => {
  queryMock.mockReset()
  getAgentVersionMock.mockReset()
  getRunMock.mockReset()
  vi.mocked(getAuthedClient).mockResolvedValue({
    query: queryMock,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  getAgentVersionMock.mockResolvedValue(VERSION_WITH_SNAPSHOT)
  getRunMock.mockResolvedValue({
    run: { id: 'run_1', agentId: 'agent_1', agentVersionId: 'ver_0' },
  })
})

// ===========================================================================
// §1. Request direction — every parameter reaches Convex, under its real name
// ===========================================================================

describe('§1 getRunDivergence forwards to divergence:analyzeRun', () => {
  beforeEach(() => {
    queryMock.mockResolvedValue({
      runId: 'run_1',
      baselineVersionId: 'ver_0',
      targetVersionId: 'ver_1',
      baselineVersion: '1.0.0',
      targetVersion: '2.0.0',
      analyzedAt: 0,
      proven: [],
      speculative: [],
      coverage: FULL_COVERAGE,
      nextEventCursor: null,
    })
  })

  it('calls the analyzeRun ref, not compareVersionConfigs or analyzeFleet', async () => {
    await getRunDivergence('run_1', 'ver_1')
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0]![0]).toBe('divergence:analyzeRun')
  })

  it('forwards runId and targetVersionId under exactly those names', async () => {
    await getRunDivergence('run_1', 'ver_1')
    expect(queryMock.mock.calls[0]![1]).toEqual({ runId: 'run_1', targetVersionId: 'ver_1' })
  })
})

describe('§2 getBlastRadius forwards to divergence:analyzeFleet', () => {
  beforeEach(() => {
    queryMock.mockResolvedValue({
      agentId: 'agent_1',
      baselineVersionId: 'ver_0',
      targetVersionId: 'ver_1',
      baselineVersion: '1.0.0',
      targetVersion: '2.0.0',
      analyzedAt: 0,
      provenReasons: [],
      speculativeReasons: [],
      runsWithProvenDivergence: 0,
      window: {
        runsScanned: 25,
        runsAnalyzed: 25,
        runsUnassessable: 0,
        runsSkippedForBudget: 0,
        scanTruncated: false,
      },
      runsSkippedForBudget: 0,
      nextCursor: null,
    })
  })

  it('calls the analyzeFleet ref', async () => {
    await getBlastRadius('ver_0', 'ver_1')
    expect(queryMock.mock.calls[0]![0]).toBe('divergence:analyzeFleet')
  })

  it('uses `baselineVersionId`, NOT `sourceVersionId`', async () => {
    // The engine renamed this parameter mid-cycle. A forwarder still sending
    // `sourceVersionId` typechecks, passes the ref checker's name resolution,
    // and fails at runtime with ArgumentValidationError.
    await getBlastRadius('ver_0', 'ver_1')
    const args = queryMock.mock.calls[0]![1]
    expect(args).toHaveProperty('baselineVersionId', 'ver_0')
    expect(args).not.toHaveProperty('sourceVersionId')
  })

  it('omits the cursor entirely on a first page rather than sending undefined', async () => {
    // Convex validators reject an explicitly-passed `undefined` for an optional
    // arg, so an omitted optional must be OMITTED, not set to undefined.
    await getBlastRadius('ver_0', 'ver_1')
    expect(Object.keys(queryMock.mock.calls[0]![1]).sort()).toEqual([
      'baselineVersionId',
      'targetVersionId',
    ])
  })

  it('FORWARDS the cursor when continuing a scan', async () => {
    // The bug class this file exists for: a parameter the caller accepts and
    // never forwards. Dropping this one silently re-scans page one forever,
    // and the operator sees a stable-looking answer that never completes.
    await getBlastRadius('ver_0', 'ver_1', 'cursor_page_2')
    expect(queryMock.mock.calls[0]![1]).toEqual({
      baselineVersionId: 'ver_0',
      targetVersionId: 'ver_1',
      cursor: 'cursor_page_2',
    })
  })
})

// ===========================================================================
// §3. Response direction — the completeness fields survive
// ===========================================================================
//
// These are the fields a forwarder "tidying" a response shape drops first, and
// they are the difference between an honest `indeterminate` and a false
// `compatible`. If they do not survive the service layer, a partial scan exits
// zero in someone's CI.

describe('§3 completeness fields survive the service layer', () => {
  it('preserves run coverage, including unassessed dimensions and their reasons', async () => {
    queryMock.mockResolvedValue({
      runId: 'run_1',
      baselineVersionId: 'ver_0',
      targetVersionId: 'ver_1',
      baselineVersion: '1.0.0',
      targetVersion: '2.0.0',
      analyzedAt: 0,
      proven: [],
      speculative: [],
      coverage: {
        assessed: ['model'],
        unassessed: [{ dimension: 'tools', reason: 'target_dimension_absent' }],
        eventsExamined: 12,
        eventHistoryComplete: true,
      },
      nextEventCursor: null,
    })

    const result = await getRunDivergence('run_1', 'ver_1')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.report.coverage.unassessed).toEqual([
      { dimension: 'tools', reason: 'target_dimension_absent' },
    ])
    expect(result.report.coverage.eventsExamined).toBe(12)
    // And the gap has been promoted into the third band, so the verdict cannot
    // read as compatible.
    expect(result.report.indeterminate.length).toBeGreaterThan(0)
    expect(result.report.verdict).toBe('indeterminate')
  })

  it('preserves eventHistoryComplete=false, and never rounds it up', async () => {
    queryMock.mockResolvedValue({
      runId: 'run_1',
      baselineVersionId: 'ver_0',
      targetVersionId: 'ver_1',
      baselineVersion: '1.0.0',
      targetVersion: '2.0.0',
      analyzedAt: 0,
      proven: [],
      speculative: [],
      coverage: { ...FULL_COVERAGE, eventHistoryComplete: false },
      nextEventCursor: null,
    })

    const result = await getRunDivergence('run_1', 'ver_1')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.report.coverage.eventHistoryComplete).toBe(false)
    expect(result.report.verdict).toBe('indeterminate')
  })

  it('treats a non-null nextEventCursor as unread history even when coverage disagrees', async () => {
    queryMock.mockResolvedValue({
      runId: 'run_1',
      baselineVersionId: 'ver_0',
      targetVersionId: 'ver_1',
      baselineVersion: '1.0.0',
      targetVersion: '2.0.0',
      analyzedAt: 0,
      proven: [],
      speculative: [],
      coverage: FULL_COVERAGE,
      nextEventCursor: 'more_events',
    })

    const result = await getRunDivergence('run_1', 'ver_1')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.report.coverage.eventHistoryComplete).toBe(false)
    expect(result.report.verdict).toBe('indeterminate')
  })

  it('preserves the fleet scan window and surfaces the continuation cursor', async () => {
    queryMock.mockResolvedValue({
      agentId: 'agent_1',
      baselineVersionId: 'ver_0',
      targetVersionId: 'ver_1',
      baselineVersion: '1.0.0',
      targetVersion: '2.0.0',
      analyzedAt: 0,
      provenReasons: [],
      speculativeReasons: [],
      runsWithProvenDivergence: 0,
      window: {
        runsScanned: 25,
        runsAnalyzed: 20,
        runsUnassessable: 2,
        runsSkippedForBudget: 3,
        scanTruncated: true,
        scanRowCeiling: 25,
      },
      runsSkippedForBudget: 3,
      nextCursor: 'page_2',
    })

    const result = await getBlastRadius('ver_0', 'ver_1')
    if (result.status !== 'ok') throw new Error('expected ok')

    // Every incompleteness signal survives, each as its own field.
    expect(result.report.window.scanTruncated).toBe(true)
    expect(result.report.window.runsUnassessable).toBe(2)
    expect(result.report.window.runsSkippedForBudget).toBe(3)
    expect(result.report.window.nextCursor).toBe('page_2')
    expect(result.report.window.scanRowCeiling).toBe(25)

    // The cursor also reaches the UI, so the operator can continue the scan.
    expect(result.nextCursor).toBe('page_2')

    // And the verdict reflects all of it.
    expect(result.report.verdict).toBe('indeterminate')
  })
})

// ===========================================================================
// §4. The query is not issued at all when the analysis cannot run
// ===========================================================================

describe('§4 unanalysable inputs short-circuit before the query', () => {
  it('does not query when the target version has no config snapshot', async () => {
    getAgentVersionMock.mockResolvedValue({ ...VERSION_WITH_SNAPSHOT, configSnapshot: undefined })

    const result = await getRunDivergence('run_1', 'ver_1')
    expect(result.status).toBe('unanalysable')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('does not query when the run has no baseline version', async () => {
    getRunMock.mockResolvedValue({ run: { id: 'run_1', agentId: 'agent_1' } })

    const result = await getRunDivergence('run_1', 'ver_1')
    expect(result.status).toBe('unanalysable')
    if (result.status !== 'unanalysable') return
    // Distinct remedy — this one is not fixable by editing the target version.
    expect(result.remedy).toMatch(/agentVersionId/)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('reports unanalysable, never empty, for a missing snapshot on the fleet path', async () => {
    getAgentVersionMock.mockResolvedValue({ ...VERSION_WITH_SNAPSHOT, configSnapshot: {} })

    const result = await getBlastRadius('ver_0', 'ver_1')
    // `empty` would render as "no divergences found" — the false clean.
    expect(result.status).toBe('unanalysable')
  })
})

// ===========================================================================
// §5. A thrown query is never an empty result
// ===========================================================================

describe('§5 a failed query is an error, never a clean answer', () => {
  it('maps a thrown query to status error with no leaked backend prose', async () => {
    queryMock.mockRejectedValue(new Error('Convex: document ktx123 not found in org org_9'))

    const result = await getRunDivergence('run_1', 'ver_1')
    expect(result.status).toBe('error')
    if (result.status !== 'error') return

    // Backend prose can carry document ids and org ids; this codebase keeps a
    // cross-org lookup indistinguishable from a missing record, so echoing it
    // would hand back the exact oracle that design removes.
    expect(result.message).not.toContain('ktx123')
    expect(result.message).not.toContain('org_9')
    expect(result.message).toMatch(/not a statement that there is no data/i)
  })
})
