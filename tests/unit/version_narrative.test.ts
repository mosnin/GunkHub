/**
 * versionNarrative.ts — pure "what changed between versions" narrative
 * logic (Team C, Explainability Layer cycle 2).
 *
 * Exercises the four `CohortComparison.failureRateSignificance` verdicts
 * (convex/helpers/analytics.ts) that `compareVersions` can return, plus the
 * grounding contract: the failure-class clause only appears when BOTH
 * cohorts supply `failureClassCounts`, and it never invents a tool name that
 * wasn't supplied via `failureClassExamples`.
 */
import { describe, expect, it } from 'vitest'

import { buildVersionNarrative, type VersionNarrativeInput } from '../../apps/web/src/lib/versionNarrative.js'

function baseInput(overrides: Partial<VersionNarrativeInput> = {}): VersionNarrativeInput {
  return {
    versionA: { version: '1.4', sampleSize: 120, failureRate: 0.08 },
    versionB: { version: '1.5', sampleSize: 100, failureRate: 0.34 },
    significance: 'likely_regression',
    ...overrides,
  }
}

describe('buildVersionNarrative — likely_regression', () => {
  it('states both failure rates, the verdict, and p<0.05 — matching the brief\'s example shape', () => {
    const result = buildVersionNarrative(baseInput())
    expect(result.significance).toBe('likely_regression')
    expect(result.narrative).toContain('v1.5 fails 34%')
    expect(result.narrative).toContain("v1.4's 8%")
    expect(result.narrative).toContain('likely regression')
    expect(result.narrative).toContain('p<0.05')
    expect(result.usedFailureClassBreakdown).toBe(false)
    expect(result.citedFailureClass).toBeUndefined()
  })

  it('accepts a version label with or without a leading "v"', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionA: { version: 'v1.4', sampleSize: 120, failureRate: 0.08 },
      }),
    )
    // No double "vv1.4".
    expect(result.narrative).not.toContain('vv1.4')
    expect(result.narrative).toContain("v1.4's 8%")
  })
})

describe('buildVersionNarrative — likely_improvement', () => {
  it('states the improvement direction, not "regression"', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionA: { version: '1.4', sampleSize: 120, failureRate: 0.34 },
        versionB: { version: '1.5', sampleSize: 100, failureRate: 0.08 },
        significance: 'likely_improvement',
      }),
    )
    expect(result.narrative).toContain('likely improvement')
    expect(result.narrative).not.toContain('regression')
  })
})

describe('buildVersionNarrative — inconclusive', () => {
  it('gives an honest "not statistically significant" narrative, never a fabricated cause', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionA: { version: '1.4', sampleSize: 40, failureRate: 0.1 },
        versionB: { version: '1.5', sampleSize: 40, failureRate: 0.15 },
        significance: 'inconclusive',
      }),
    )
    expect(result.narrative).toContain('not statistically significant')
    expect(result.narrative).toContain('could be noise')
    expect(result.narrative).not.toContain('regression')
    expect(result.narrative).not.toContain('improvement')
    expect(result.usedFailureClassBreakdown).toBe(false)
  })
})

describe('buildVersionNarrative — insufficient_data', () => {
  it('says "not enough data" and cites only the given sample sizes — never a cause', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionA: { version: '1.4', sampleSize: 5, failureRate: 0 },
        versionB: { version: '1.5', sampleSize: 3, failureRate: 0.33 },
        significance: 'insufficient_data',
      }),
    )
    expect(result.narrative).toContain('Not enough data')
    expect(result.narrative).toContain('v1.4: 5 runs')
    expect(result.narrative).toContain('v1.5: 3 runs')
    // Must not smuggle in a failure-rate percentage as if it were meaningful.
    expect(result.narrative).not.toContain('%')
    expect(result.usedFailureClassBreakdown).toBe(false)
  })
})

describe('buildVersionNarrative — failure-class grounding', () => {
  it('omits the failure-class clause when only one cohort supplies the breakdown', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionB: {
          version: '1.5',
          sampleSize: 100,
          failureRate: 0.34,
          failureClassCounts: { tool_timeout: 12, tool_error: 3 },
        },
      }),
    )
    expect(result.usedFailureClassBreakdown).toBe(false)
    expect(result.narrative).not.toContain('failure class')
  })

  it('includes the most-increased failure class when both cohorts supply counts', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionA: {
          version: '1.4',
          sampleSize: 120,
          failureRate: 0.08,
          failureClassCounts: { tool_timeout: 1, tool_error: 2 },
        },
        versionB: {
          version: '1.5',
          sampleSize: 100,
          failureRate: 0.34,
          failureClassCounts: { tool_timeout: 20, tool_error: 3 },
        },
      }),
    )
    expect(result.usedFailureClassBreakdown).toBe(true)
    expect(result.citedFailureClass).toBe('tool_timeout')
    expect(result.narrative).toContain('most common new failure class is tool_timeout')
    // No tool name was supplied via failureClassExamples — must not invent one.
    expect(result.narrative).not.toContain(' on ')
  })

  it('appends the "on <tool>" clause ONLY when failureClassExamples supplies it — never invents one', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionA: {
          version: '1.4',
          sampleSize: 120,
          failureRate: 0.08,
          failureClassCounts: { tool_timeout: 1 },
        },
        versionB: {
          version: '1.5',
          sampleSize: 100,
          failureRate: 0.34,
          failureClassCounts: { tool_timeout: 20 },
          failureClassExamples: { tool_timeout: 'search_docs' },
        },
      }),
    )
    expect(result.narrative).toContain('most common new failure class is tool_timeout on search_docs')
  })

  it('falls back to B\'s most common class (dropping "new") when no class actually increased', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionA: {
          version: '1.4',
          sampleSize: 120,
          failureRate: 0.08,
          failureClassCounts: { tool_timeout: 15, tool_error: 20 },
        },
        versionB: {
          version: '1.5',
          sampleSize: 100,
          failureRate: 0.34,
          // tool_timeout is flat (delta 0), tool_error dropped sharply
          // (delta -16) — tool_timeout has the least-negative/highest delta,
          // so it's still the (non-"new") most-common class cited.
          failureClassCounts: { tool_timeout: 15, tool_error: 4 },
        },
      }),
    )
    expect(result.usedFailureClassBreakdown).toBe(true)
    expect(result.narrative).toContain('most common failure class is tool_timeout')
    expect(result.narrative).not.toContain('new failure class')
  })

  it('omits the clause entirely when B has no classified failures (empty counts map)', () => {
    const result = buildVersionNarrative(
      baseInput({
        versionA: { version: '1.4', sampleSize: 120, failureRate: 0.08, failureClassCounts: {} },
        versionB: { version: '1.5', sampleSize: 100, failureRate: 0.34, failureClassCounts: {} },
      }),
    )
    expect(result.usedFailureClassBreakdown).toBe(false)
    expect(result.citedFailureClass).toBeUndefined()
  })
})
