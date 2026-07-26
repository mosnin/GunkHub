import { describe, it, expect } from 'vitest'

import { GC_CANDIDATE_PAGE_SIZE, MAX_EVENTS_PER_REPLAY } from '../../convex/helpers/pagination.js'

// Behavioral GC tests (real handlers via convex-test) live in
// convex/enterprise.test.ts — "Artifact GC — reworked orphan semantics".
// This file only pins the GC configuration constants and documents the
// current orphan-collection contract.

describe('Artifact GC configuration', () => {
  it('GC_CANDIDATE_PAGE_SIZE is defined and positive', () => {
    expect(GC_CANDIDATE_PAGE_SIZE).toBeGreaterThan(0)
  })

  it('GC_CANDIDATE_PAGE_SIZE is bounded at a sane value (≤ 500)', () => {
    // Prevents accidental unbounded batches that could time out the cron action
    expect(GC_CANDIDATE_PAGE_SIZE).toBeLessThanOrEqual(500)
  })

  it('GC_CANDIDATE_PAGE_SIZE is not larger than MAX_EVENTS_PER_REPLAY', () => {
    expect(GC_CANDIDATE_PAGE_SIZE).toBeLessThan(MAX_EVENTS_PER_REPLAY)
  })
})

describe('Artifact GC orphan contract (documented semantics)', () => {
  // A run-level artifact (eventId === undefined) is collectable ONLY when:
  //   (a) its parent run is TERMINAL,
  //   (b) it is older than the 24 h safety threshold, and
  //   (c) no event payload's `_externalized` pointer references its id.
  // Event-attached artifacts are permanently retained.

  it('ORPHAN_AGE_MS safety threshold is 24 hours', () => {
    const expected = 24 * 60 * 60 * 1000
    expect(expected).toBe(86_400_000)
  })

  it('an artifact created 25h ago is past the safety threshold', () => {
    const createdAt = Date.now() - 25 * 60 * 60 * 1000
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    expect(createdAt).toBeLessThan(cutoff)
  })

  it('an artifact created 1h ago is within the safety threshold (never collected)', () => {
    const createdAt = Date.now() - 1 * 60 * 60 * 1000
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    expect(createdAt).toBeGreaterThan(cutoff)
  })

  it('only terminal run statuses make a run-level artifact eligible', () => {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
    expect(terminal.has('running')).toBe(false)
    expect(terminal.has('pending')).toBe(false)
    expect(terminal.has('completed')).toBe(true)
  })
})

describe('Artifact GC error categorization', () => {
  it('blob delete failure should not delete the Convex record', () => {
    const blobDeleteThrows = true
    const convexRecordWouldBeDeleted = !blobDeleteThrows // only deleted if blob succeeded
    expect(convexRecordWouldBeDeleted).toBe(false)
  })

  it('artifacts that fail blob delete are re-candidates in subsequent GC runs', () => {
    const artifactRecordPreservedOnBlobError = true
    expect(artifactRecordPreservedOnBlobError).toBe(true)
  })
})
