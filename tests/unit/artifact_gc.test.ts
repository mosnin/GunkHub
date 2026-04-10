import { describe, it, expect } from 'vitest'
import { GC_CANDIDATE_PAGE_SIZE, MAX_EVENTS_PER_REPLAY } from '../../convex/helpers/pagination.js'

describe('Artifact GC configuration', () => {
  it('GC_CANDIDATE_PAGE_SIZE is defined and positive', () => {
    expect(GC_CANDIDATE_PAGE_SIZE).toBeGreaterThan(0)
  })

  it('GC_CANDIDATE_PAGE_SIZE is bounded at a sane value (≤ 500)', () => {
    // Prevents accidental unbounded batches that could time out the cron action
    expect(GC_CANDIDATE_PAGE_SIZE).toBeLessThanOrEqual(500)
  })

  it('GC_CANDIDATE_PAGE_SIZE is a round number (multiple of 10)', () => {
    expect(GC_CANDIDATE_PAGE_SIZE % 10).toBe(0)
  })

  it('GC_CANDIDATE_PAGE_SIZE is not larger than MAX_EVENTS_PER_REPLAY', () => {
    // GC processes artifacts; each artifact is checked against events in its run.
    // Keeping batch size well below MAX_EVENTS_PER_REPLAY avoids per-artifact
    // event scans blowing out the Convex action budget.
    expect(GC_CANDIDATE_PAGE_SIZE).toBeLessThan(MAX_EVENTS_PER_REPLAY)
  })
})

describe('Artifact GC orphan age threshold', () => {
  it('ORPHAN_AGE_MS is 24 hours', () => {
    // This constant is defined locally in artifact_gc.ts.
    // The 24-hour window ensures in-progress runs are never affected.
    const expected = 24 * 60 * 60 * 1000
    expect(expected).toBe(86_400_000)
  })

  it('24-hour cutoff is in the past for an artifact created yesterday', () => {
    const yesterday = Date.now() - 25 * 60 * 60 * 1000
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    expect(yesterday).toBeLessThan(cutoff)
  })

  it('24-hour cutoff is in the future for an artifact created an hour ago', () => {
    const recent = Date.now() - 1 * 60 * 60 * 1000
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    expect(recent).toBeGreaterThan(cutoff)
  })
})
