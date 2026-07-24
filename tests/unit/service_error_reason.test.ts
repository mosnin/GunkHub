/**
 * service_error_reason.test.ts — pins the discriminant that keeps
 * "there is genuinely no data" and "the query blew up" from collapsing into
 * one value.
 *
 * BACKGROUND. Services in apps/web/src/lib/services/ used to do
 * `try { ...query... } catch { return { available: false } }`. The UI read
 * that single boolean and rendered reassuring empty copy for both outcomes —
 * "This fills in once evals have been recorded", "No recurring failures —
 * nice", "This activates once cost rollups have been computed". On a tool
 * whose stated primary outcome is "make failures explainable", that means the
 * more the backend breaks, the calmer the product looks. The same class of
 * defect was found in four places across two cycles, which is what makes it
 * worth a contract and a test file rather than four spot fixes.
 *
 * WHAT THESE TESTS ACTUALLY GUARD. The interesting assertion is not
 * "empty returns 'empty'" or "a throw returns 'error'" in isolation — either
 * could pass while the other regressed. It is the CONJUNCTION, asserted
 * per-service in `never conflates`: the two inputs must produce two different
 * statuses. A regression that reintroduces the swallow (any `catch { return
 * <empty-shaped> }`) makes the thrown case report 'empty' and fails there,
 * even if every other assertion in this file still passes.
 *
 * Also pinned, and just as load-bearing:
 *   - error messages never carry the caught exception's text. The Convex
 *     error prose deliberately used by the throwing mocks below contains a
 *     document ID and a function path; if any of it reaches `message`, the
 *     UI has an information-disclosure bug and, worse, an existence oracle
 *     across the org boundary that CLAUDE.md's Tenancy Rules are built to
 *     deny.
 *   - the 'ok' path still returns its data, so a service cannot "pass" these
 *     tests by reporting 'error' unconditionally.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Harness — mirrors the mocking convention in
// tests/unit/failure_patterns_evidence_mapping.test.ts.
// ---------------------------------------------------------------------------

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(() => ({ userId: 'user_1', orgId: 'clerk_org_1' })),
}))

/**
 * The org lookup succeeds for every case in this file. That is deliberate:
 * these tests are about what happens AFTER the org resolves, which is where
 * the empty/error conflation lived.
 */
const ORG_DOC = { _id: 'convex_org_1', clerkOrgId: 'clerk_org_1' }

type QueryHandler = (ref: string, args: Record<string, unknown>) => unknown

let handler: QueryHandler = () => null

const queryMock = vi.fn(async (ref: unknown, args: Record<string, unknown>) =>
  handler(String(ref), args),
)

vi.mock('@/lib/convexServer', () => ({
  getAuthedClient: vi.fn(async () => ({ query: queryMock, mutation: vi.fn() })),
  resolveConvexOrgId: vi.fn(async () => 'convex_org_1'),
  withConvexTimeout: vi.fn(async (p: Promise<unknown>) => p),
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    organizations: { getOrganization: 'organizations:getOrganization' },
    insights: {
      getAgentCostStats: 'insights:getAgentCostStats',
      getDashboardStats: 'insights:getDashboardStats',
      getPerAgentDashboardStats: 'insights:getPerAgentDashboardStats',
      listEvalsForVersion: 'insights:listEvalsForVersion',
      getRunEvalSummary: 'insights:getRunEvalSummary',
      compareVersions: 'insights:compareVersions',
    },
    agents: { listAgentsByOrg: 'agents:listAgentsByOrg' },
    evals: { listEvalsForRun: 'evals:listEvalsForRun' },
    usage: { listRecentUsage: 'usage:listRecentUsage' },
    projection_verify: {
      batchGetVerificationResults: 'projection_verify:batchGetVerificationResults',
      listRecentFailedVerifications: 'projection_verify:listRecentFailedVerifications',
    },
  },
}))

// The blob storage adapter behind artifacts.getArtifactUrl. Its two rejection
// modes ("key not found" vs "BLOB_STORE_URL is not configured") are the two
// facts that must not collapse.
const { getUrlMock } = vi.hoisted(() => ({ getUrlMock: vi.fn() }))
vi.mock('@/lib/storage', () => ({
  getStorageAdapter: vi.fn(() => ({ getUrl: getUrlMock })),
}))

// The logger is the sink for the real error. Silenced here so a suite that
// deliberately throws does not spray stderr, and asserted on in § E.
// `vi.hoisted` because vi.mock factories are hoisted above const declarations.
const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: loggerError },
  getRequestId: vi.fn(() => 'req_1'),
}))

import type { ServiceUnavailable } from '@/lib/services/serviceResult'

import { compareVersions } from '@/lib/services/agent_versions'
import { getArtifactUrl } from '@/lib/services/artifacts'
import { getAgentCostStats } from '@/lib/services/cost'
import { getDashboardStats, getPerAgentDashboardStats } from '@/lib/services/dashboard'
import { getEvalRollupForVersion, getRunEvalSummary } from '@/lib/services/evals'
import {
  batchGetRunVerificationStatuses,
  getRecentFailedVerifications,
} from '@/lib/services/projection_verify'
import { getUsageData } from '@/lib/services/usage'

/**
 * Convex-flavoured error prose, chosen to be exactly the kind of string that
 * must never reach a user: it names a function path and embeds a document ID.
 * Every `message` assertion below checks against these fragments.
 */
const CONVEX_ERROR_MESSAGE =
  '[CONVEX Q(insights:getAgentCostStats)] ArgumentValidationError: Object is missing the required field `orgId`. Document jd7abc123secretid in table organizations'

const LEAKY_FRAGMENTS = [
  'ArgumentValidationError',
  'jd7abc123secretid',
  'CONVEX',
  'insights:',
  'orgId',
]

function throwsConvexError(): never {
  throw new Error(CONVEX_ERROR_MESSAGE)
}

beforeEach(() => {
  queryMock.mockClear()
  loggerError.mockClear()
  handler = () => null
})

// ---------------------------------------------------------------------------
// The table. One row per service that carries the ServiceResult contract.
// ---------------------------------------------------------------------------

interface ServiceCase {
  name: string
  /** The service ref whose result decides empty-vs-error (not the org lookup). */
  dataRef: string
  call: () => Promise<{ status: string } | ServiceUnavailable>
  /**
   * What the underlying query returns when it succeeds with data. `null` in
   * the `emptyValue` position is how Convex reports "no rollup computed".
   */
  okValue: unknown
  emptyValue: unknown
  /**
   * True when the service has no legitimate 'empty' branch — see usage.ts,
   * where a zero-filled series IS the answer and the only non-'ok' outcomes
   * are ones where the question could not be asked.
   */
  noEmptyBranch?: boolean
}

const CASES: ServiceCase[] = [
  {
    name: 'cost.getAgentCostStats',
    dataRef: 'insights:getAgentCostStats',
    call: () => getAgentCostStats('agent_1', '7d'),
    okValue: {
      sampleSize: 3,
      truncated: false,
      totalCostUsd: 1.25,
      byModel: [{ model: 'claude', tokensIn: 10, tokensOut: 5, costUsd: 1.25, matched: true }],
      tokensIn: 10,
      tokensOut: 5,
      unmatchedModels: [],
    },
    emptyValue: null,
  },
  {
    name: 'dashboard.getDashboardStats',
    dataRef: 'insights:getDashboardStats',
    call: () => getDashboardStats('7d'),
    okValue: {
      totals: {
        runsTotal: 4,
        runsFailed: 1,
        runsCompleted: 3,
        runsCancelled: 0,
        runsTimedOut: 0,
        failureRate: 0.25,
        tokensIn: 100,
        tokensOut: 50,
      },
      series: [],
    },
    emptyValue: null,
  },
  {
    name: 'evals.getEvalRollupForVersion',
    dataRef: 'insights:listEvalsForVersion',
    call: () => getEvalRollupForVersion('ver_1', '7d'),
    okValue: {
      agentVersionId: 'ver_1',
      sampleSize: 6,
      passed: 5,
      failed: 1,
      passRate: 83.3,
      recentFailures: [],
      truncated: false,
    },
    emptyValue: null,
  },
  {
    name: 'agent_versions.compareVersions',
    dataRef: 'insights:compareVersions',
    call: () => compareVersions('convex_org_1', 'ver_a', 'ver_b'),
    okValue: {
      agentId: 'agent_1',
      versionA: { countsByStatus: { completed: 2 } },
      versionB: { countsByStatus: { failed: 1 } },
      comparison: { verdict: 'inconclusive' },
    },
    emptyValue: null,
  },
  {
    // The worst instance in the repo. Empty here drives a GREEN DOT and the
    // words "No recent verification issues" on the dashboard, so 'empty' and
    // 'error' arriving as the same value is a fabricated integrity claim.
    name: 'projection_verify.getRecentFailedVerifications',
    dataRef: 'projection_verify:listRecentFailedVerifications',
    call: () => getRecentFailedVerifications(5),
    okValue: [
      {
        runId: 'run_1',
        verifiedAt: 5_000,
        isValid: false,
        checksRan: ['sequence'],
        failureReason: 'gap',
        sequenceGaps: [3],
        duplicateSeqNums: [],
      },
    ],
    emptyValue: [],
  },
  {
    name: 'usage.getUsageData',
    dataRef: 'usage:listRecentUsage',
    call: () => getUsageData(7),
    okValue: [{ day: '2026-07-24', runsStarted: 2, eventsIngested: 9, bytesIngested: 10, artifactBytes: 0 }],
    emptyValue: [],
    noEmptyBranch: true,
  },
]

/** Route the org lookup to a real doc and everything else to `dataFn`. */
function route(dataRef: string, dataFn: () => unknown): QueryHandler {
  return (ref) => {
    if (ref === 'organizations:getOrganization') return ORG_DOC
    if (ref === dataRef) return dataFn()
    return null
  }
}

// ---------------------------------------------------------------------------
// A. The success path still works.
// ---------------------------------------------------------------------------

describe('ServiceResult — the ok path is unaffected', () => {
  for (const c of CASES) {
    it(`${c.name} reports status 'ok' when the query returns data`, async () => {
      handler = route(c.dataRef, () => c.okValue)
      const result = await c.call()
      expect(result.status).toBe('ok')
    })
  }
})

// ---------------------------------------------------------------------------
// B. Empty means empty.
// ---------------------------------------------------------------------------

describe("ServiceResult — a successful query with no data reports 'empty'", () => {
  for (const c of CASES.filter((x) => !x.noEmptyBranch)) {
    it(`${c.name} reports status 'empty', never 'error'`, async () => {
      handler = route(c.dataRef, () => c.emptyValue)
      const result = await c.call()
      expect(result.status).toBe('empty')
    })

    it(`${c.name} does not log an error for a legitimately empty result`, async () => {
      handler = route(c.dataRef, () => c.emptyValue)
      await c.call()
      expect(loggerError).not.toHaveBeenCalled()
    })
  }

  it('usage.getUsageData has no empty branch by design — a zero-filled series is the answer', async () => {
    handler = route('usage:listRecentUsage', () => [])
    const result = await getUsageData(7)
    // Not 'empty': "no usage in the last 7 days" is data, not an absence of
    // data. Asserting 'ok' here is what stops a future refactor from
    // "helpfully" turning a quiet week into an unavailable state.
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.eventCount).toBe(0)
      expect(result.dailyCounts).toHaveLength(7)
    }
  })
})

// ---------------------------------------------------------------------------
// C. A thrown query means error.
// ---------------------------------------------------------------------------

describe("ServiceResult — a thrown query reports 'error'", () => {
  for (const c of CASES) {
    it(`${c.name} reports status 'error' when the query throws`, async () => {
      handler = route(c.dataRef, throwsConvexError)
      const result = await c.call()
      expect(result.status).toBe('error')
    })

    it(`${c.name} reports 'error' when the ORG lookup itself throws`, async () => {
      // A failure earlier in the chain is still a failure. Before the fix this
      // also landed in the same `catch { return { available: false } }`.
      handler = throwsConvexError
      const result = await c.call()
      expect(result.status).toBe('error')
    })
  }
})

// ---------------------------------------------------------------------------
// D. The two are never conflated. This is the assertion that actually
//    catches a reintroduced swallow.
// ---------------------------------------------------------------------------

describe('ServiceResult — empty and error are never the same value', () => {
  for (const c of CASES.filter((x) => !x.noEmptyBranch)) {
    it(`${c.name} produces two distinct statuses for the two distinct facts`, async () => {
      handler = route(c.dataRef, () => c.emptyValue)
      const emptyResult = await c.call()

      handler = route(c.dataRef, throwsConvexError)
      const errorResult = await c.call()

      expect(emptyResult.status).not.toBe(errorResult.status)
      expect(emptyResult.status).toBe('empty')
      expect(errorResult.status).toBe('error')
    })

    it(`${c.name} shows the user different copy for the two cases`, async () => {
      // Distinct statuses would be worthless if both rendered the same string.
      handler = route(c.dataRef, () => c.emptyValue)
      const emptyResult = (await c.call()) as ServiceUnavailable

      handler = route(c.dataRef, throwsConvexError)
      const errorResult = (await c.call()) as ServiceUnavailable

      expect(emptyResult.message).toBeTruthy()
      expect(errorResult.message).toBeTruthy()
      expect(emptyResult.message).not.toBe(errorResult.message)
    })
  }

  it('the error message never claims there is no data', async () => {
    // The specific regression: reassuring copy over a swallowed exception.
    const reassuring = /no .*(yet|recorded)|nothing (here|yet)|fills in once|activates once|nice\b/i
    for (const c of CASES) {
      handler = route(c.dataRef, throwsConvexError)
      const result = (await c.call()) as ServiceUnavailable
      expect(result.status).toBe('error')
      expect(result.message).not.toMatch(reassuring)
    }
  })
})

// ---------------------------------------------------------------------------
// E. Nothing internal reaches the user; everything internal reaches the log.
// ---------------------------------------------------------------------------

describe('ServiceResult — error messages are safe to render', () => {
  for (const c of CASES) {
    it(`${c.name} leaks no part of the caught Convex error into message`, async () => {
      handler = route(c.dataRef, throwsConvexError)
      const result = (await c.call()) as ServiceUnavailable
      for (const fragment of LEAKY_FRAGMENTS) {
        expect(result.message).not.toContain(fragment)
      }
      expect(result.message).not.toContain(CONVEX_ERROR_MESSAGE)
    })

    it(`${c.name} carries no stack trace into message`, async () => {
      handler = route(c.dataRef, throwsConvexError)
      const result = (await c.call()) as ServiceUnavailable
      expect(result.message).not.toMatch(/\bat\s+\S+\s+\(/)
      expect(result.message).not.toContain('.ts:')
    })

    it(`${c.name} does not swallow the error — it reaches the logger`, async () => {
      // "Do not conflate" must not become "do not record". The real error is
      // still actionable, it just lives in the log rather than the DOM.
      handler = route(c.dataRef, throwsConvexError)
      await c.call()
      expect(loggerError).toHaveBeenCalled()
      const [, context] = loggerError.mock.calls[0] as [string, Record<string, unknown>]
      expect(context['err']).toBeInstanceOf(Error)
      expect((context['err'] as Error).message).toBe(CONVEX_ERROR_MESSAGE)
    })
  }
})

// ---------------------------------------------------------------------------
// F. evals.getRunEvalSummary — the nested-fallback case.
//
// This one is not a plain catch. The outer catch deliberately falls back to
// summarizing the run's own eval list (a real degraded mode, and the same
// list the Evals tab already renders). The distinction that matters is that a
// SUCCESSFUL fallback is 'ok'/'empty' — it produced real data — while only a
// fallback that ALSO fails is 'error'. Getting this wrong in either direction
// is a bug: report 'error' on a working fallback and the panel goes dark for
// no reason; report 'ok'/'empty' when both paths failed and we are straight
// back to reassuring copy over a swallowed exception.
// ---------------------------------------------------------------------------

describe('evals.getRunEvalSummary — fallback is a degraded mode, not a swallow', () => {
  const EVAL_DOCS = [
    { _id: 'ev_1', orgId: 'o', runId: 'run_1', name: 'a', kind: 'assertion', passed: true, createdAt: 1, createdBy: 'u', score: 1 },
    { _id: 'ev_2', orgId: 'o', runId: 'run_1', name: 'b', kind: 'assertion', passed: false, createdAt: 2, createdBy: 'u', score: 0 },
  ]

  it("reports 'ok' from the primary query when it succeeds", async () => {
    handler = route('insights:getRunEvalSummary', () => ({
      total: 2,
      passed: 1,
      failed: 1,
      passRatePct: 50,
    }))
    const result = await getRunEvalSummary('run_1')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.total).toBe(2)
  })

  it("reports 'empty' when the primary query succeeds with nothing recorded", async () => {
    handler = route('insights:getRunEvalSummary', () => null)
    const result = await getRunEvalSummary('run_1')
    expect(result.status).toBe('empty')
  })

  it("reports 'ok' when the primary throws but the fallback list succeeds", async () => {
    handler = (ref) => {
      if (ref === 'organizations:getOrganization') return ORG_DOC
      if (ref === 'insights:getRunEvalSummary') throwsConvexError()
      if (ref === 'evals:listEvalsForRun') return EVAL_DOCS
      return null
    }
    const result = await getRunEvalSummary('run_1')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.total).toBe(2)
      expect(result.passed).toBe(1)
    }
  })

  it("reports 'empty' when the primary throws and the fallback finds no evals", async () => {
    handler = (ref) => {
      if (ref === 'organizations:getOrganization') return ORG_DOC
      if (ref === 'insights:getRunEvalSummary') throwsConvexError()
      if (ref === 'evals:listEvalsForRun') return []
      return null
    }
    const result = await getRunEvalSummary('run_1')
    expect(result.status).toBe('empty')
  })

  it("reports 'error' only when BOTH the primary and the fallback fail", async () => {
    handler = (ref) => {
      if (ref === 'organizations:getOrganization') return ORG_DOC
      throwsConvexError()
    }
    const result = await getRunEvalSummary('run_1')
    expect(result.status).toBe('error')
  })

  it('leaks nothing when both paths fail, and still logs both errors', async () => {
    handler = (ref) => {
      if (ref === 'organizations:getOrganization') return ORG_DOC
      throwsConvexError()
    }
    const result = (await getRunEvalSummary('run_1')) as ServiceUnavailable
    for (const fragment of LEAKY_FRAGMENTS) {
      expect(result.message).not.toContain(fragment)
    }
    expect(loggerError).toHaveBeenCalled()
    const [, context] = loggerError.mock.calls[0] as [string, Record<string, unknown>]
    // The primary error is preserved alongside the fallback error — losing it
    // would hide the original cause behind the symptom.
    expect(context['primaryErr']).toBeInstanceOf(Error)
    expect(context['err']).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// G. projection_verify — the integrity surfaces.
//
// These deserve their own section beyond the shared table because the claim
// they make is not "here is some data" but "your event log is intact". A
// fabricated version of that claim is worse than a fabricated chart.
// ---------------------------------------------------------------------------

describe('projection_verify.getRecentFailedVerifications — the green-dot case', () => {
  it("reports 'empty' for a successful query with no failures, so the green dot stays truthful", async () => {
    handler = route('projection_verify:listRecentFailedVerifications', () => [])
    const result = await getRecentFailedVerifications(5)
    expect(result.status).toBe('empty')
  })

  it("reports 'error' when the query throws — NEVER the green dot", async () => {
    handler = route('projection_verify:listRecentFailedVerifications', throwsConvexError)
    const result = await getRecentFailedVerifications(5)
    expect(result.status).toBe('error')
    // The specific regression: "No recent verification issues" over an
    // exception. If this string can be reached from a throw, the widget is
    // lying about the one thing it exists to report.
    expect((result as ServiceUnavailable).message).not.toMatch(/no recent verification issues/i)
  })

  it('surfaces real failures as ok with the rows intact', async () => {
    handler = route('projection_verify:listRecentFailedVerifications', () => [
      { runId: 'run_9', verifiedAt: 1, isValid: false, checksRan: ['sequence'], sequenceGaps: [2], duplicateSeqNums: [] },
    ])
    const result = await getRecentFailedVerifications(5)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.runId).toBe('run_9')
    }
  })
})

describe('projection_verify.batchGetRunVerificationStatuses', () => {
  const RUN_IDS = ['run_1', 'run_2']

  it("reports 'ok' when the query succeeds, even if every run is unverified", async () => {
    // "These runs have not been verified" is a real finding and must remain
    // distinguishable from "I could not find out whether they were verified".
    handler = route('projection_verify:batchGetVerificationResults', () =>
      RUN_IDS.map((runId) => ({ runId, result: null })),
    )
    const result = await batchGetRunVerificationStatuses(RUN_IDS)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.statuses['run_1']?.verified).toBe(false)
      expect(result.statuses['run_2']?.verified).toBe(false)
    }
  })

  it("reports 'error' when the batch throws, rather than marking every run unverified", async () => {
    handler = route('projection_verify:batchGetVerificationResults', throwsConvexError)
    const result = await batchGetRunVerificationStatuses(RUN_IDS)
    expect(result.status).toBe('error')
  })

  it('never conflates a genuinely-unverified batch with a failed one', async () => {
    handler = route('projection_verify:batchGetVerificationResults', () =>
      RUN_IDS.map((runId) => ({ runId, result: null })),
    )
    const unverified = await batchGetRunVerificationStatuses(RUN_IDS)

    handler = route('projection_verify:batchGetVerificationResults', throwsConvexError)
    const failed = await batchGetRunVerificationStatuses(RUN_IDS)

    expect(unverified.status).not.toBe(failed.status)
  })

  it("reports 'empty' for an empty input without issuing a query", async () => {
    handler = route('projection_verify:batchGetVerificationResults', throwsConvexError)
    const result = await batchGetRunVerificationStatuses([])
    expect(result.status).toBe('empty')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('maps a stored result to a verified status', async () => {
    handler = route('projection_verify:batchGetVerificationResults', () => [
      {
        runId: 'run_1',
        result: { isValid: true, verifiedAt: 10, summary: 'ok', checksRan: ['sequence'] },
      },
    ])
    const result = await batchGetRunVerificationStatuses(['run_1'])
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.statuses['run_1']?.verified).toBe(true)
      expect(result.statuses['run_1']?.isValid).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // TENANCY. convex/projection_verify.ts filters each row with
  // `result?.orgId === args.orgId ? result : null`, so a runId belonging to
  // another org arrives as `{ runId, result: null }` — the SAME shape as a run
  // with no verification record. Adding a per-run error branch to this service
  // would turn that into an existence oracle across the org boundary. This
  // test asserts the two remain byte-identical to the caller.
  // -------------------------------------------------------------------------
  it('makes a cross-org run indistinguishable from a run that was never verified', async () => {
    // 'run_mine' has no record; 'run_other_org' belongs to another org and was
    // nulled out by the Convex-side tenancy filter. Both arrive as result:null.
    handler = route('projection_verify:batchGetVerificationResults', () => [
      { runId: 'run_mine', result: null },
      { runId: 'run_other_org', result: null },
    ])
    const result = await batchGetRunVerificationStatuses(['run_mine', 'run_other_org'])
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.statuses['run_other_org']).toEqual(result.statuses['run_mine'])
    }
  })
})

// ---------------------------------------------------------------------------
// H. artifacts.getArtifactUrl — a total storage outage must not look like an
//    artifact that was simply never uploaded.
// ---------------------------------------------------------------------------

describe('artifacts.getArtifactUrl', () => {
  const NOT_FOUND = 'StubBlobStorage: key not found: org_1/run_1/secret-artifact-key'
  const MISCONFIGURED = 'BLOB_STORE_URL is not configured'

  beforeEach(() => {
    getUrlMock.mockReset()
  })

  it("reports 'ok' with the url when the adapter resolves", async () => {
    getUrlMock.mockResolvedValue('https://blob.example/artifact')
    const result = await getArtifactUrl('key_1')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.url).toBe('https://blob.example/artifact')
  })

  it("reports 'error' when the key is not found, not a silent empty string", async () => {
    getUrlMock.mockRejectedValue(new Error(NOT_FOUND))
    const result = await getArtifactUrl('key_1')
    expect(result.status).toBe('error')
  })

  it("reports 'error' when the blob store is misconfigured", async () => {
    getUrlMock.mockRejectedValue(new Error(MISCONFIGURED))
    const result = await getArtifactUrl('key_1')
    expect(result.status).toBe('error')
  })

  it('does not leak the storage key into the user-facing message', async () => {
    // The stub's rejection embeds the full storage key, which encodes org and
    // run IDs. It belongs in the log, not on the page.
    getUrlMock.mockRejectedValue(new Error(NOT_FOUND))
    const result = (await getArtifactUrl('org_1/run_1/secret-artifact-key')) as ServiceUnavailable
    expect(result.message).not.toContain('secret-artifact-key')
    expect(result.message).not.toContain('StubBlobStorage')
    expect(result.message).not.toContain('org_1')
  })

  it('does not leak configuration details into the user-facing message', async () => {
    getUrlMock.mockRejectedValue(new Error(MISCONFIGURED))
    const result = (await getArtifactUrl('key_1')) as ServiceUnavailable
    expect(result.message).not.toContain('BLOB_STORE_URL')
  })

  it('still records the real cause in the log', async () => {
    getUrlMock.mockRejectedValue(new Error(MISCONFIGURED))
    await getArtifactUrl('key_1')
    expect(loggerError).toHaveBeenCalled()
    const [, context] = loggerError.mock.calls[0] as [string, Record<string, unknown>]
    expect((context['err'] as Error).message).toBe(MISCONFIGURED)
    expect(context['storageKey']).toBe('key_1')
  })
})

// ---------------------------------------------------------------------------
// I. dashboard.getPerAgentDashboardStats — fallback, again a degraded mode
//    rather than a swallow, plus the row-drop accounting.
// ---------------------------------------------------------------------------

describe('dashboard.getPerAgentDashboardStats', () => {
  const ROWS = [
    {
      agentId: 'agent_1',
      agentName: 'A',
      totals: {
        runsTotal: 2,
        runsFailed: 0,
        runsCompleted: 2,
        runsCancelled: 0,
        runsTimedOut: 0,
        failureRate: 0,
        tokensIn: 1,
        tokensOut: 1,
      },
    },
  ]

  it("reports 'ok' and not degraded when the fast rollup succeeds", async () => {
    handler = route('insights:getPerAgentDashboardStats', () => ({ rows: ROWS }))
    const result = await getPerAgentDashboardStats('7d')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.degraded).toBe(false)
      expect(result.omittedAgentCount).toBe(0)
      expect(result.rows).toHaveLength(1)
    }
  })

  it("reports 'empty' when the rollup succeeds with no rows", async () => {
    handler = route('insights:getPerAgentDashboardStats', () => ({ rows: [] }))
    const result = await getPerAgentDashboardStats('7d')
    expect(result.status).toBe('empty')
  })

  it("reports 'ok' but degraded when the rollup throws and the fallback works", async () => {
    handler = (ref) => {
      if (ref === 'organizations:getOrganization') return ORG_DOC
      if (ref === 'insights:getPerAgentDashboardStats') throwsConvexError()
      if (ref === 'agents:listAgentsByOrg') {
        return [
          { _id: 'agent_1', orgId: 'o', projectId: 'p', name: 'A', slug: 'a', createdAt: 1, updatedAt: 1 },
        ]
      }
      if (ref === 'insights:getDashboardStats') return { totals: ROWS[0]!.totals, series: [] }
      return null
    }
    const result = await getPerAgentDashboardStats('7d')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.degraded).toBe(true)
      expect(result.rows).toHaveLength(1)
    }
  })

  it("reports 'error' when the rollup AND the agent list both fail", async () => {
    handler = (ref) => {
      if (ref === 'organizations:getOrganization') return ORG_DOC
      throwsConvexError()
    }
    const result = await getPerAgentDashboardStats('7d')
    expect(result.status).toBe('error')
  })

  it("reports 'error', not 'empty', when every agent's stats fail to load", async () => {
    // The table would otherwise render as "this org has no agent activity"
    // when in fact nothing could be read — the row-granularity version of the
    // same defect.
    handler = (ref) => {
      if (ref === 'organizations:getOrganization') return ORG_DOC
      if (ref === 'insights:getPerAgentDashboardStats') throwsConvexError()
      if (ref === 'agents:listAgentsByOrg') {
        return [
          { _id: 'agent_1', orgId: 'o', projectId: 'p', name: 'A', slug: 'a', createdAt: 1, updatedAt: 1 },
        ]
      }
      if (ref === 'insights:getDashboardStats') throwsConvexError()
      return null
    }
    const result = await getPerAgentDashboardStats('7d')
    expect(result.status).toBe('error')
  })

  it('counts agents omitted by a per-agent failure instead of dropping them silently', async () => {
    handler = (ref, args) => {
      if (ref === 'organizations:getOrganization') return ORG_DOC
      if (ref === 'insights:getPerAgentDashboardStats') throwsConvexError()
      if (ref === 'agents:listAgentsByOrg') {
        return [
          { _id: 'agent_1', orgId: 'o', projectId: 'p', name: 'A', slug: 'a', createdAt: 1, updatedAt: 1 },
          { _id: 'agent_2', orgId: 'o', projectId: 'p', name: 'B', slug: 'b', createdAt: 1, updatedAt: 1 },
        ]
      }
      if (ref === 'insights:getDashboardStats') {
        if (args['agentId'] === 'agent_2') throwsConvexError()
        return { totals: ROWS[0]!.totals, series: [] }
      }
      return null
    }
    const result = await getPerAgentDashboardStats('7d')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rows).toHaveLength(1)
      // The reader can now tell this table is incomplete.
      expect(result.omittedAgentCount).toBe(1)
    }
  })
})
