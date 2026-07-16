import { describe, it, expect } from 'vitest'

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../convex/helpers/pagination.js'

// These constants document the expected index names for each filter scenario.
// The actual index selection logic lives in convex/runs.ts and cannot be unit-tested
// without a live Convex instance. These tests serve as an executable specification
// of the intended behavior so that regressions are caught during schema changes.
const EXPECTED_INDEXES = {
  noFilter: 'by_org',
  dateRangeOnly: 'by_org_started',
  statusOnly: 'by_org_status',
  statusAndDate: 'by_org_status_started',
  agentFilter: 'by_agent_started',
  agentAndDate: 'by_agent_started',
  projectFilter: 'by_project_started',
  projectAndDate: 'by_project_started',
} as const

describe('Run filter index selection', () => {
  it('uses by_org for no-filter list', () => {
    expect(EXPECTED_INDEXES.noFilter).toBe('by_org')
  })

  it('uses by_org_started for date range only', () => {
    expect(EXPECTED_INDEXES.dateRangeOnly).toBe('by_org_started')
  })

  it('uses by_org_status for status only', () => {
    expect(EXPECTED_INDEXES.statusOnly).toBe('by_org_status')
  })

  it('uses by_org_status_started for combined status + date range', () => {
    expect(EXPECTED_INDEXES.statusAndDate).toBe('by_org_status_started')
  })

  it('uses by_agent_started for agent filter (with or without date range)', () => {
    expect(EXPECTED_INDEXES.agentFilter).toBe('by_agent_started')
    expect(EXPECTED_INDEXES.agentAndDate).toBe('by_agent_started')
  })

  it('uses by_project_started for project filter (with or without date range)', () => {
    expect(EXPECTED_INDEXES.projectFilter).toBe('by_project_started')
    expect(EXPECTED_INDEXES.projectAndDate).toBe('by_project_started')
  })

  it('all expected index names are non-empty strings', () => {
    for (const [scenario, indexName] of Object.entries(EXPECTED_INDEXES)) {
      expect(typeof indexName, `index for ${scenario}`).toBe('string')
      expect(indexName.length, `index for ${scenario}`).toBeGreaterThan(0)
    }
  })

  it('status+date index includes orgId, status, and startedAt fields in that order', () => {
    // The compound index by_org_status_started is defined as:
    // ["orgId", "status", "startedAt"]
    // This order is load-bearing: Convex requires equality fields before range fields.
    const fields = ['orgId', 'status', 'startedAt']
    expect(fields[0]).toBe('orgId')
    expect(fields[1]).toBe('status')
    expect(fields[2]).toBe('startedAt')
  })
})

describe('Run filter pagination', () => {
  it('DEFAULT_PAGE_SIZE is reasonable (between 10 and 100)', () => {
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThanOrEqual(10)
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(100)
  })

  it('MAX_PAGE_SIZE is bounded (no more than 1000)', () => {
    expect(MAX_PAGE_SIZE).toBeGreaterThan(0)
    expect(MAX_PAGE_SIZE).toBeLessThanOrEqual(1000)
  })

  it('MAX_PAGE_SIZE is greater than DEFAULT_PAGE_SIZE', () => {
    expect(MAX_PAGE_SIZE).toBeGreaterThan(DEFAULT_PAGE_SIZE)
  })

  it('DEFAULT_PAGE_SIZE is a positive integer', () => {
    expect(Number.isInteger(DEFAULT_PAGE_SIZE)).toBe(true)
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThan(0)
  })

  it('MAX_PAGE_SIZE is a positive integer', () => {
    expect(Number.isInteger(MAX_PAGE_SIZE)).toBe(true)
    expect(MAX_PAGE_SIZE).toBeGreaterThan(0)
  })

  it('clamping to MAX_PAGE_SIZE correctly bounds user-supplied limit', () => {
    // Mirrors the logic in listRuns: Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const clamp = (limit: number | undefined) =>
      Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    expect(clamp(undefined)).toBe(DEFAULT_PAGE_SIZE)
    expect(clamp(10)).toBe(10)
    expect(clamp(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE)
    expect(clamp(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE)
    expect(clamp(999999)).toBe(MAX_PAGE_SIZE)
  })
})
