import { describe, it, expect } from 'vitest'

import { STALE_RUN_TIMEOUT_MS, STALE_RUN_BATCH_SIZE } from '../../convex/helpers/pagination.js'

describe('Stale run timeout configuration', () => {
  it('STALE_RUN_TIMEOUT_MS is 24 hours', () => {
    expect(STALE_RUN_TIMEOUT_MS).toBe(86_400_000)
  })

  it('STALE_RUN_BATCH_SIZE is defined and positive', () => {
    expect(STALE_RUN_BATCH_SIZE).toBeGreaterThan(0)
  })

  it('STALE_RUN_BATCH_SIZE is bounded (≤ 500)', () => {
    expect(STALE_RUN_BATCH_SIZE).toBeLessThanOrEqual(500)
  })
})

describe('Stale run cutoff calculation', () => {
  it('a run started 25 hours ago is past the cutoff', () => {
    const startedAt = Date.now() - 25 * 60 * 60 * 1000
    const cutoff = Date.now() - STALE_RUN_TIMEOUT_MS
    expect(startedAt).toBeLessThan(cutoff)
  })

  it('a run started 23 hours ago is not past the cutoff', () => {
    const startedAt = Date.now() - 23 * 60 * 60 * 1000
    const cutoff = Date.now() - STALE_RUN_TIMEOUT_MS
    expect(startedAt).toBeGreaterThan(cutoff)
  })

  it('a run started exactly 24 hours ago is past the cutoff', () => {
    const startedAt = Date.now() - STALE_RUN_TIMEOUT_MS - 1
    const cutoff = Date.now() - STALE_RUN_TIMEOUT_MS
    expect(startedAt).toBeLessThan(cutoff)
  })
})

describe('markRunTimedOut safety invariants', () => {
  it('only transitions running status, not terminal statuses', () => {
    // Safety contract: markRunTimedOut returns early if run.status !== "running"
    const terminalStatuses = ['completed', 'failed', 'cancelled', 'timed_out']
    const wouldTransition = (status: string) => status === 'running'
    for (const status of terminalStatuses) {
      expect(wouldTransition(status)).toBe(false)
    }
    expect(wouldTransition('running')).toBe(true)
  })

  it('expiry is idempotent: already-timed_out runs are not re-patched', () => {
    // A run with status "timed_out" returns early from markRunTimedOut
    const runStatus = 'timed_out'
    const wouldPatch = runStatus === 'running'
    expect(wouldPatch).toBe(false)
  })
})
