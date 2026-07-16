import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for bulk reverify action and selection UX (Prompt 24).
//
// These tests cover:
//   1. BulkReverifyResult shape and computation
//   2. Eligibility rules — terminal statuses only
//   3. MAX_BULK_REVERIFY cap enforcement
//   4. Result feedback text generation
//   5. Selection state transitions
//   6. Edge cases — empty input, all success, all failure, mixed
//
// All logic is inlined — no server actions, no React, no Convex, no network.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline: BulkReverifyResult interface and MAX_BULK_REVERIFY
// (mirrors apps/web/src/lib/actions/verification.ts)
// ---------------------------------------------------------------------------

interface BulkReverifyResult {
  succeeded: string[]
  failed: string[]
  errors: Record<string, string>
}

const MAX_BULK_REVERIFY = 20

// ---------------------------------------------------------------------------
// Inline: simulate bulkReverifyAction result computation
// (mirrors the aggregation logic in bulkReverifyAction)
// ---------------------------------------------------------------------------

interface MockReverifyOutcome {
  runId: string
  error: string | null
}

function computeBulkResult(outcomes: MockReverifyOutcome[]): BulkReverifyResult {
  const succeeded: string[] = []
  const failed: string[] = []
  const errors: Record<string, string> = {}

  for (const o of outcomes) {
    if (o.error === null) {
      succeeded.push(o.runId)
    } else {
      failed.push(o.runId)
      errors[o.runId] = o.error
    }
  }

  return { succeeded, failed, errors }
}

// ---------------------------------------------------------------------------
// Inline: eligibility check
// (mirrors TERMINAL_STATUSES in SelectableRunList.tsx)
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

function isEligibleForReverify(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

// ---------------------------------------------------------------------------
// Inline: result feedback text generation
// (mirrors the bulk action bar in SelectableRunList.tsx)
// ---------------------------------------------------------------------------

function buildFeedbackText(result: BulkReverifyResult): string {
  const parts: string[] = []
  if (result.succeeded.length > 0) {
    parts.push(`${result.succeeded.length} verified`)
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} failed`)
  }
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// 1. BulkReverifyResult shape and computation
// ---------------------------------------------------------------------------

describe('computeBulkResult — result shape', () => {
  it('returns empty arrays for empty outcomes', () => {
    const result = computeBulkResult([])
    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.errors).toEqual({})
  })

  it('places successful run IDs in succeeded', () => {
    const result = computeBulkResult([
      { runId: 'r1', error: null },
      { runId: 'r2', error: null },
    ])
    expect(result.succeeded).toEqual(['r1', 'r2'])
    expect(result.failed).toEqual([])
  })

  it('places failed run IDs in failed with error messages', () => {
    const result = computeBulkResult([
      { runId: 'r1', error: 'Forbidden' },
      { runId: 'r2', error: 'Verification failed' },
    ])
    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual(['r1', 'r2'])
    expect(result.errors['r1']).toBe('Forbidden')
    expect(result.errors['r2']).toBe('Verification failed')
  })

  it('separates mixed success and failure', () => {
    const result = computeBulkResult([
      { runId: 'r1', error: null },
      { runId: 'r2', error: 'Network error' },
      { runId: 'r3', error: null },
      { runId: 'r4', error: 'Forbidden' },
    ])
    expect(result.succeeded).toEqual(['r1', 'r3'])
    expect(result.failed).toEqual(['r2', 'r4'])
    expect(Object.keys(result.errors)).toEqual(['r2', 'r4'])
  })

  it('succeeded and failed are disjoint', () => {
    const outcomes = [
      { runId: 'r1', error: null },
      { runId: 'r2', error: 'err' },
      { runId: 'r3', error: null },
    ]
    const result = computeBulkResult(outcomes)
    const succeededSet = new Set(result.succeeded)
    for (const id of result.failed) {
      expect(succeededSet.has(id)).toBe(false)
    }
  })

  it('errors record only contains entries for failed runs', () => {
    const result = computeBulkResult([
      { runId: 'r1', error: null },
      { runId: 'r2', error: 'bad' },
    ])
    expect(Object.keys(result.errors)).toEqual(['r2'])
    expect(result.errors['r1']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Eligibility rules — terminal statuses only
// ---------------------------------------------------------------------------

describe('reverify eligibility — terminal statuses', () => {
  it('completed is eligible', () => {
    expect(isEligibleForReverify('completed')).toBe(true)
  })

  it('failed is eligible', () => {
    expect(isEligibleForReverify('failed')).toBe(true)
  })

  it('cancelled is eligible', () => {
    expect(isEligibleForReverify('cancelled')).toBe(true)
  })

  it('timed_out is eligible', () => {
    expect(isEligibleForReverify('timed_out')).toBe(true)
  })

  it('running is not eligible', () => {
    expect(isEligibleForReverify('running')).toBe(false)
  })

  it('pending is not eligible', () => {
    expect(isEligibleForReverify('pending')).toBe(false)
  })

  it('unknown status is not eligible', () => {
    expect(isEligibleForReverify('unknown_status')).toBe(false)
  })

  it('all 4 terminal statuses are eligible', () => {
    const terminal = ['completed', 'failed', 'cancelled', 'timed_out']
    for (const s of terminal) {
      expect(isEligibleForReverify(s)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. MAX_BULK_REVERIFY cap enforcement
// ---------------------------------------------------------------------------

describe('MAX_BULK_REVERIFY cap', () => {
  it('MAX_BULK_REVERIFY is 20', () => {
    expect(MAX_BULK_REVERIFY).toBe(20)
  })

  it('slice(0, MAX_BULK_REVERIFY) caps input to 20 run IDs', () => {
    const runIds = Array.from({ length: 25 }, (_, i) => `r${i}`)
    const bounded = runIds.slice(0, MAX_BULK_REVERIFY)
    expect(bounded).toHaveLength(20)
  })

  it('slice does not modify arrays shorter than the cap', () => {
    const runIds = ['r1', 'r2', 'r3']
    const bounded = runIds.slice(0, MAX_BULK_REVERIFY)
    expect(bounded).toEqual(['r1', 'r2', 'r3'])
  })

  it('slice preserves order of the first MAX_BULK_REVERIFY IDs', () => {
    const runIds = Array.from({ length: 30 }, (_, i) => `r${i}`)
    const bounded = runIds.slice(0, MAX_BULK_REVERIFY)
    expect(bounded[0]).toBe('r0')
    expect(bounded[19]).toBe('r19')
    expect(bounded[20]).toBeUndefined()
  })

  it('empty input returns empty bounded array', () => {
    const bounded = [].slice(0, MAX_BULK_REVERIFY)
    expect(bounded).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Result feedback text generation
// ---------------------------------------------------------------------------

describe('bulk reverify feedback text', () => {
  it('shows "N verified" for all-success result', () => {
    const result: BulkReverifyResult = { succeeded: ['r1', 'r2', 'r3'], failed: [], errors: {} }
    expect(buildFeedbackText(result)).toBe('3 verified')
  })

  it('shows "N failed" for all-failure result', () => {
    const result: BulkReverifyResult = {
      succeeded: [],
      failed: ['r1', 'r2'],
      errors: { r1: 'err', r2: 'err' },
    }
    expect(buildFeedbackText(result)).toBe('2 failed')
  })

  it('shows both counts for mixed result', () => {
    const result: BulkReverifyResult = {
      succeeded: ['r1', 'r3'],
      failed: ['r2'],
      errors: { r2: 'err' },
    }
    const text = buildFeedbackText(result)
    expect(text).toContain('2 verified')
    expect(text).toContain('1 failed')
  })

  it('returns empty string for empty result', () => {
    const result: BulkReverifyResult = { succeeded: [], failed: [], errors: {} }
    expect(buildFeedbackText(result)).toBe('')
  })

  it('singular "verified" for 1 succeeded run', () => {
    const result: BulkReverifyResult = { succeeded: ['r1'], failed: [], errors: {} }
    expect(buildFeedbackText(result)).toBe('1 verified')
  })

  it('singular "failed" for 1 failed run', () => {
    const result: BulkReverifyResult = { succeeded: [], failed: ['r1'], errors: { r1: 'err' } }
    expect(buildFeedbackText(result)).toBe('1 failed')
  })
})

// ---------------------------------------------------------------------------
// 5. Selection state transitions
// ---------------------------------------------------------------------------

describe('selection state transitions', () => {
  function makeSelection(initial: string[] = []): Set<string> {
    return new Set(initial)
  }

  function toggleId(selection: Set<string>, id: string): Set<string> {
    const next = new Set(selection)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    return next
  }

  it('adding to empty selection creates single-element set', () => {
    const s = makeSelection()
    const next = toggleId(s, 'r1')
    expect(next.size).toBe(1)
    expect(next.has('r1')).toBe(true)
  })

  it('toggling an existing ID removes it', () => {
    const s = makeSelection(['r1', 'r2'])
    const next = toggleId(s, 'r1')
    expect(next.has('r1')).toBe(false)
    expect(next.has('r2')).toBe(true)
  })

  it('toggle all adds all eligible IDs', () => {
    const eligible = ['r1', 'r2', 'r3']
    const s = new Set<string>(eligible)
    expect(s.size).toBe(3)
  })

  it('clear resets selection to empty', () => {
    const _s = makeSelection(['r1', 'r2', 'r3'])
    const cleared = new Set<string>()
    expect(cleared.size).toBe(0)
  })

  it('selection cleared after successful bulk reverify', () => {
    // Simulates the state flow: select → reverify → clear
    let selection = makeSelection(['r1', 'r2'])
    expect(selection.size).toBe(2)
    // After bulk action completes:
    selection = new Set()
    expect(selection.size).toBe(0)
  })

  it('selectedEligible is intersection of selectedIds and eligibleIds', () => {
    const selectedIds = new Set(['r1', 'r2', 'r3'])
    const eligibleIds = ['r2', 'r3', 'r4'] // r1 is not eligible
    const selectedEligible = [...selectedIds].filter((id) => eligibleIds.includes(id))
    expect(selectedEligible).toEqual(['r2', 'r3'])
  })

  it('non-terminal selection excluded from reverify even if selected', () => {
    const selectedIds = new Set(['r1', 'r2', 'r3'])
    const eligibleIds = ['r1', 'r3'] // r2 is running, not eligible
    const selectedEligible = [...selectedIds].filter((id) => eligibleIds.includes(id))
    expect(selectedEligible).toHaveLength(2)
    expect(selectedEligible).not.toContain('r2')
  })
})

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe('bulk reverify edge cases', () => {
  it('all runs non-terminal — eligible list is empty', () => {
    const runs = [
      { id: 'r1', status: 'running' },
      { id: 'r2', status: 'pending' },
    ]
    const eligibleIds = runs.filter((r) => isEligibleForReverify(r.status)).map((r) => r.id)
    expect(eligibleIds).toHaveLength(0)
  })

  it('all runs terminal — all eligible', () => {
    const runs = [
      { id: 'r1', status: 'completed' },
      { id: 'r2', status: 'failed' },
      { id: 'r3', status: 'cancelled' },
    ]
    const eligibleIds = runs.filter((r) => isEligibleForReverify(r.status)).map((r) => r.id)
    expect(eligibleIds).toHaveLength(3)
  })

  it('mixed run page — correct eligibility split', () => {
    const runs = [
      { id: 'r1', status: 'completed' },
      { id: 'r2', status: 'running' },
      { id: 'r3', status: 'failed' },
      { id: 'r4', status: 'pending' },
      { id: 'r5', status: 'cancelled' },
    ]
    const eligibleIds = runs.filter((r) => isEligibleForReverify(r.status)).map((r) => r.id)
    expect(eligibleIds).toEqual(['r1', 'r3', 'r5'])
  })

  it('auth failure produces error for all IDs', () => {
    const bounded = ['r1', 'r2', 'r3']
    // Simulates the auth-failure branch of bulkReverifyAction
    const result: BulkReverifyResult = {
      succeeded: [],
      failed: bounded,
      errors: Object.fromEntries(bounded.map((id) => [id, 'Not authenticated'])),
    }
    expect(result.succeeded).toHaveLength(0)
    expect(result.failed).toHaveLength(3)
    for (const id of bounded) {
      expect(result.errors[id]).toBe('Not authenticated')
    }
  })

  it('total processed equals succeeded + failed', () => {
    const outcomes: MockReverifyOutcome[] = [
      { runId: 'r1', error: null },
      { runId: 'r2', error: 'err' },
      { runId: 'r3', error: null },
      { runId: 'r4', error: 'err' },
      { runId: 'r5', error: null },
    ]
    const result = computeBulkResult(outcomes)
    expect(result.succeeded.length + result.failed.length).toBe(outcomes.length)
  })
})
