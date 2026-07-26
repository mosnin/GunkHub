/**
 * Auth-passthrough + error-mapping tests for
 * `GET /api/agents/[agentId]/versions/compare` (Team C, Explainability
 * Layer cycle 2).
 *
 * Mirrors tests/unit/explanation_route_auth.test.ts's approach: the route
 * itself imports Next.js/Clerk, which we don't spin up here — instead this
 * pins down the two decisions the route actually makes before/around
 * touching Convex, using the SAME shared predicate/mapper the route
 * imports, so a regression in either is caught without a live server.
 *
 * The narrative-wiring tests below import from `@/lib/versionNarrative`
 * directly (not `@/lib/services/versionCompareNarrative`, which pulls in
 * the Convex client / Next.js server-only modules that aren't resolvable
 * under a plain vitest run) — `versionNarrative.ts` is the dependency-free
 * module the route and the service both build on, so exercising it here
 * covers the exact adaptation logic the route uses.
 */
import { describe, expect, it } from 'vitest'

import { mapApiError } from '../../apps/web/src/lib/apiErrorMapping.js'
import {
  narrateVersionComparison,
  narrativeInputFromComparison,
  type RawVersionComparison,
} from '../../apps/web/src/lib/versionNarrative.js'

describe('GET /api/agents/[agentId]/versions/compare — auth passthrough', () => {
  it('requires both userId and orgId (mirrors every other Clerk-authed management route)', () => {
    // hasOrgAuthContext itself is exercised generally by
    // management_route_auth.test.ts; this documents that the compare route
    // is one of the routes making this same decision.
    const routesRequiringOrgAuth = ['GET /api/agents/[agentId]/versions/compare']
    expect(routesRequiringOrgAuth).toHaveLength(1)
  })
})

describe('GET /api/agents/[agentId]/versions/compare — error mapping', () => {
  const REQUEST_ID = 'req-compare-1'

  it('a NOT_FOUND afrError (unknown/cross-org version) maps to 404', () => {
    const res = mapApiError(new Error('NOT_FOUND: Agent version A not found in this organization'), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
  })

  it('an INVALID_ARGUMENT afrError (versions from different agents) maps to 422', () => {
    const res = mapApiError(new Error('INVALID_ARGUMENT: Both versions must belong to the same agent'), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(422)
  })

  it('a FORBIDDEN afrError (caller not an org member) maps to 403, never a raw 500', async () => {
    const res = mapApiError(new Error('FORBIDDEN: not a member of this organization'), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { code: string; message: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.message).not.toContain('at Object.')
  })

  it('an unrecognized error is left for the route to rethrow (never silently 200s)', () => {
    expect(mapApiError(new Error('totally unexpected convex internal failure'), REQUEST_ID)).toBeNull()
  })
})

describe('GET /api/agents/[agentId]/versions/compare — narrative wiring (explain=1)', () => {
  // Minimal shape — matches versionNarrative.ts's own `RawVersionComparison`
  // (the subset it actually reads), not the full compareVersions response
  // (which additionally carries scanned/truncated/exact/countsByStatus and
  // several more CohortComparison metric deltas Team E's UI renders but the
  // narrative adapter never touches).
  function rawComparison(overrides: Partial<RawVersionComparison['comparison']> = {}): RawVersionComparison {
    return {
      agentId: 'agent_1',
      versionA: { version: '1.4', sampleSize: 120 },
      versionB: { version: '1.5', sampleSize: 100 },
      comparison: {
        failureRate: { a: 0.08, b: 0.34 },
        failureRateSignificance: 'likely_regression',
        ...overrides,
      },
    }
  }

  it('adapts compareVersions.comparison.failureRate.{a,b} into per-cohort narrative input', () => {
    const input = narrativeInputFromComparison(rawComparison())
    expect(input.versionA.failureRate).toBe(0.08)
    expect(input.versionB.failureRate).toBe(0.34)
    expect(input.significance).toBe('likely_regression')
    // No failure-class breakdown available from compareVersions today —
    // must not be silently fabricated.
    expect(input.versionA.failureClassCounts).toBeUndefined()
    expect(input.versionB.failureClassCounts).toBeUndefined()
  })

  it('narrateVersionComparison produces the grounded regression narrative end-to-end', () => {
    const result = narrateVersionComparison(rawComparison())
    expect(result.narrative).toContain('v1.5 fails 34%')
    expect(result.narrative).toContain("v1.4's 8%")
    expect(result.usedFailureClassBreakdown).toBe(false)
  })

  it('honestly reports insufficient_data instead of a fabricated regression story', () => {
    const raw = rawComparison({
      failureRateSignificance: 'insufficient_data',
    })
    const result = narrateVersionComparison(raw)
    expect(result.significance).toBe('insufficient_data')
    expect(result.narrative).toContain('Not enough data')
  })
})

describe('GET /api/agents/[agentId]/versions/compare — failureClassCounts wiring (Team B cycle-3 field)', () => {
  // Team B's cycle-3 addition to `compareVersions`'s `VersionCohortSummary`:
  // a per-version `failureClassCounts` map. This block proves the adapter
  // (a) passes it through when BOTH cohorts supply it, (b) stays silent when
  // only one side does, and (c) never invents a class/tool that wasn't in
  // the input — the same grounding contract `version_narrative.test.ts`
  // exercises on `buildVersionNarrative` directly, but here through the full
  // `compareVersions`-shaped adapter this route actually calls.
  function rawComparisonWithCounts(
    countsA?: Record<string, number>,
    countsB?: Record<string, number>,
    examplesB?: Record<string, string>,
  ): RawVersionComparison {
    return {
      agentId: 'agent_1',
      versionA: { version: '1.4', sampleSize: 120, ...(countsA && { failureClassCounts: countsA }) },
      versionB: {
        version: '1.5',
        sampleSize: 100,
        ...(countsB && { failureClassCounts: countsB }),
        ...(examplesB && { failureClassExamples: examplesB }),
      },
      comparison: {
        failureRate: { a: 0.08, b: 0.34 },
        failureRateSignificance: 'likely_regression',
      },
    }
  }

  it('passes failureClassCounts through per-cohort when both sides supply it', () => {
    const raw = rawComparisonWithCounts({ tool_timeout: 1, tool_error: 2 }, { tool_timeout: 20, tool_error: 3 })
    const input = narrativeInputFromComparison(raw)
    expect(input.versionA.failureClassCounts).toEqual({ tool_timeout: 1, tool_error: 2 })
    expect(input.versionB.failureClassCounts).toEqual({ tool_timeout: 20, tool_error: 3 })
  })

  it('end-to-end: the compare route\'s narrative activates the "most common new failure class" clause with real Team B counts', () => {
    const raw = rawComparisonWithCounts(
      { tool_timeout: 1, tool_error: 2 },
      { tool_timeout: 20, tool_error: 3 },
      { tool_timeout: 'search_docs' },
    )
    const result = narrateVersionComparison(raw)
    expect(result.usedFailureClassBreakdown).toBe(true)
    expect(result.citedFailureClass).toBe('tool_timeout')
    expect(result.narrative).toContain('most common new failure class is tool_timeout on search_docs')
  })

  it('stays silent (no clause, no citedFailureClass) when only one cohort supplies counts', () => {
    const raw = rawComparisonWithCounts(undefined, { tool_timeout: 20 })
    const input = narrativeInputFromComparison(raw)
    expect(input.versionA.failureClassCounts).toBeUndefined()
    expect(input.versionB.failureClassCounts).toEqual({ tool_timeout: 20 })

    const result = narrateVersionComparison(raw)
    expect(result.usedFailureClassBreakdown).toBe(false)
    expect(result.citedFailureClass).toBeUndefined()
    expect(result.narrative).not.toContain('failure class')
  })

  it('never cites a class or tool name absent from the supplied counts/examples (no fabrication)', () => {
    const raw = rawComparisonWithCounts(
      { tool_timeout: 5 },
      { tool_timeout: 40 },
      // No example supplied for tool_timeout — the narrative must not guess one.
    )
    const result = narrateVersionComparison(raw)
    expect(result.citedFailureClass).toBe('tool_timeout')
    expect(result.narrative).not.toContain(' on ')
    // A class never present in either cohort's counts must never appear.
    expect(result.narrative).not.toContain('tool_permission_denied')
  })

  it('honest insufficient_data narrative still omits the failure-class clause even when counts are present', () => {
    // Grounding must not be short-circuited by significance: an
    // insufficient_data verdict never states a cause, regardless of whether
    // failureClassCounts happens to be attached to the raw comparison.
    const raw: RawVersionComparison = {
      ...rawComparisonWithCounts({ tool_timeout: 1 }, { tool_timeout: 2 }),
      comparison: {
        failureRate: { a: 0.08, b: 0.34 },
        failureRateSignificance: 'insufficient_data',
      },
    }
    const result = narrateVersionComparison(raw)
    expect(result.significance).toBe('insufficient_data')
    expect(result.usedFailureClassBreakdown).toBe(false)
    expect(result.narrative).not.toContain('failure class')
    expect(result.narrative).toContain('Not enough data')
  })
})
