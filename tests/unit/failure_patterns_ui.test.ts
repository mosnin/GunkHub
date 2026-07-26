/**
 * Pure-logic tests for the Patterns UI (Team E, "Failure Patterns" /
 * PREVENTION feature, cycle 1) — the reconciliation adapter
 * (apps/web/src/components/patterns/adapt.ts) and the sparkline geometry
 * builder (apps/web/src/components/patterns/sparkline.ts). Both are plain
 * TypeScript with no React/DOM dependency, so — mirroring
 * tests/unit/reverify_panel.test.ts and explanation_route_auth.test.ts —
 * they're exercised directly here without a component-rendering harness
 * (this repo's vitest config runs in a `node` environment with no jsdom /
 * @testing-library/react set up; adding that is a root-config change outside
 * this team's boundary).
 */
import { describe, expect, it } from 'vitest'

import {
  adaptFailurePattern,
  adaptFailurePatternDetail,
  adaptOccurrence,
  adaptTrendPoint,
} from '../../apps/web/src/components/patterns/adapt.js'
import { buildSparklineGeometry } from '../../apps/web/src/components/patterns/sparkline.js'

describe('adaptFailurePattern', () => {
  it('maps the real contract shape (label/class/count) straight through', () => {
    const adapted = adaptFailurePattern({
      id: 'p1',
      orgId: 'org1',
      fingerprintHash: 'abc123',
      class: 'tool_timeout',
      label: 'Tool timeout: search_web',
      salientKey: 'search_web',
      count: 7,
      firstSeenAt: 100,
      lastSeenAt: 200,
      representativeRunIds: ['r1', 'r2'],
      affectedAgentVersionIds: ['v1'],
      lastSpikeAssessment: { assessedAt: 300, isSpiking: true, recentCount: 5, baselineMean: 1, z: 4.2 },
    })

    expect(adapted.label).toBe('Tool timeout: search_web')
    expect(adapted.class).toBe('tool_timeout')
    expect(adapted.count).toBe(7)
    expect(adapted.representativeRunIds).toEqual(['r1', 'r2'])
    expect(adapted.affectedAgentVersionIds).toEqual(['v1'])
    expect(adapted.hasRepresentativeRuns).toBe(true)
    expect(adapted.hasAffectedVersions).toBe(true)
    expect(adapted.hasSpikeAssessment).toBe(true)
    expect(adapted.lastSpikeAssessment?.isSpiking).toBe(true)
  })

  it("falls back to Team C's current stub shape (title/failureClass/occurrenceCount)", () => {
    const adapted = adaptFailurePattern({
      id: 'p2',
      orgId: 'org1',
      fingerprintHash: 'def456',
      title: 'Rate limited by search_web',
      failureClass: 'tool_error',
      occurrenceCount: 3,
      firstSeenAt: 100,
      lastSeenAt: 200,
    })

    expect(adapted.label).toBe('Rate limited by search_web')
    expect(adapted.class).toBe('tool_error')
    expect(adapted.count).toBe(3)
  })

  it('marks representative runs / affected versions / spike assessment as absent, not zero, when the service omits them', () => {
    const adapted = adaptFailurePattern({
      id: 'p3',
      orgId: 'org1',
      fingerprintHash: 'ghi789',
      title: 'Something',
      failureClass: 'unknown',
      occurrenceCount: 1,
      firstSeenAt: 1,
      lastSeenAt: 2,
    })

    expect(adapted.hasRepresentativeRuns).toBe(false)
    expect(adapted.hasAffectedVersions).toBe(false)
    expect(adapted.hasSpikeAssessment).toBe(false)
    expect(adapted.representativeRunIds).toEqual([])
    expect(adapted.affectedAgentVersionIds).toEqual([])
    expect(adapted.lastSpikeAssessment).toBeUndefined()
  })

  it('never invents a label or class for a malformed/empty input', () => {
    const adapted = adaptFailurePattern({})
    expect(adapted.label).toBe('Unlabeled failure pattern')
    expect(adapted.class).toBe('unknown')
    expect(adapted.count).toBe(0)
  })
})

describe('adaptTrendPoint', () => {
  it('passes through the real { day, count } shape', () => {
    expect(adaptTrendPoint({ day: '2026-07-20', count: 4 })).toEqual({ day: '2026-07-20', count: 4 })
  })

  it("converts the stub's { bucketStart, count } shape to a UTC day string", () => {
    const bucketStart = Date.UTC(2026, 6, 20, 15, 30) // 2026-07-20T15:30Z
    expect(adaptTrendPoint({ bucketStart, count: 2 })).toEqual({ day: '2026-07-20', count: 2 })
  })
})

describe('adaptOccurrence', () => {
  it('defaults agentId/heuristicClass/salientKey to empty strings rather than inventing data', () => {
    const occ = adaptOccurrence({ runId: 'run1', occurredAt: 123 })
    expect(occ.runId).toBe('run1')
    expect(occ.occurredAt).toBe(123)
    expect(occ.agentId).toBe('')
    expect(occ.heuristicClass).toBe('')
  })
})

describe('adaptFailurePatternDetail', () => {
  it('returns null for a null/undefined detail (fingerprint not found)', () => {
    expect(adaptFailurePatternDetail(null)).toBeNull()
    expect(adaptFailurePatternDetail(undefined)).toBeNull()
  })

  it('adapts pattern + recentOccurrences + trend together', () => {
    const detail = adaptFailurePatternDetail({
      pattern: { id: 'p1', title: 'X', failureClass: 'tool_error', occurrenceCount: 2, firstSeenAt: 1, lastSeenAt: 2 },
      recentOccurrences: [{ runId: 'r1', occurredAt: 10 }],
      trend: [{ bucketStart: Date.UTC(2026, 0, 1), count: 1 }],
    })
    expect(detail?.pattern.label).toBe('X')
    expect(detail?.recentOccurrences).toHaveLength(1)
    expect(detail?.trend).toEqual([{ day: '2026-01-01', count: 1 }])
  })
})

describe('buildSparklineGeometry', () => {
  it('returns an empty, inactive geometry for no trend data', () => {
    const geo = buildSparklineGeometry([], 72, 20)
    expect(geo.points).toBe('')
    expect(geo.hasActivity).toBe(false)
  })

  it('reports hasActivity=false for an all-zero trend (renders as a flat baseline)', () => {
    const geo = buildSparklineGeometry(
      [
        { day: '2026-07-19', count: 0 },
        { day: '2026-07-20', count: 0 },
      ],
      72,
      20,
    )
    expect(geo.hasActivity).toBe(false)
    expect(geo.points).not.toBe('')
  })

  it('places the highest-count point nearest the top (smallest y) within the viewbox', () => {
    const geo = buildSparklineGeometry(
      [
        { day: '2026-07-18', count: 1 },
        { day: '2026-07-19', count: 10 },
        { day: '2026-07-20', count: 2 },
      ],
      72,
      20,
    )
    expect(geo.hasActivity).toBe(true)
    const ys = geo.points.split(' ').map((p) => Number(p.split(',')[1]))
    expect(Math.min(...ys)).toBe(ys[1]) // the count:10 point has the smallest y
    ys.forEach((y) => {
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(20)
    })
  })

  it('never divides by zero for a single-point trend', () => {
    const geo = buildSparklineGeometry([{ day: '2026-07-20', count: 5 }], 72, 20)
    expect(geo.hasActivity).toBe(true)
    expect(geo.points).toMatch(/^36\.0,/) // single point centers horizontally at width/2
  })
})
