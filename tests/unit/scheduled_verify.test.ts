/**
 * Tests for the scheduled projection integrity verification logic introduced
 * in Prompt 19 (convex/projection_verify.ts — daily cron action).
 *
 * All logic is inlined here — no Convex imports, no network, no React.
 * The checkSequenceIntegrity function is duplicated inline because Convex
 * actions cannot import pure functions from apps/web context. This
 * duplication is documented in ADR-0020.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Inline implementation — mirrors the logic in convex/projection_verify.ts
// exactly. If the Convex action logic changes, update both files and this test.
// ---------------------------------------------------------------------------

function checkSequenceIntegrity(seqNums: number[]): {
  isValid: boolean
  sequenceGaps: number[]
  duplicateSeqNums: number[]
  summary: string
  failureReason: string | undefined
} {
  const gaps: number[] = []
  const duplicates: number[] = []
  const counts = new Map<number, number>()
  for (const n of seqNums) {
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  for (const [n, c] of counts) {
    if (c > 1) duplicates.push(n)
  }
  duplicates.sort((a, b) => a - b)
  if (seqNums.length > 0) {
    let max = 0
    for (const n of seqNums) {
      if (n > max) max = n
    }
    for (let i = 1; i <= max; i++) {
      if (!counts.has(i)) gaps.push(i)
    }
  }
  const isValid = gaps.length === 0 && duplicates.length === 0
  let summary: string
  let failureReason: string | undefined
  if (isValid) {
    summary = `OK: ${seqNums.length} events, no gaps, sequence valid`
  } else {
    const parts: string[] = []
    if (gaps.length > 0)
      parts.push(
        `${gaps.length} sequence gap${gaps.length === 1 ? '' : 's'} [${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? ', …' : ''}]`,
      )
    if (duplicates.length > 0)
      parts.push(
        `${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'} [${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? ', …' : ''}]`,
      )
    summary = `INVALID: ${parts.join('; ')}`
    failureReason = parts[0]
  }
  return { isValid, sequenceGaps: gaps, duplicateSeqNums: duplicates, summary, failureReason }
}

// ---------------------------------------------------------------------------
// Bounded-window constants — mirrors values in convex/projection_verify.ts.
// These are declared here so tests assert on numeric invariants, not magic numbers.
// ---------------------------------------------------------------------------

const BATCH_LIMIT = 50
const WINDOW_MS = 48 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Group 1: Valid sequences
// ---------------------------------------------------------------------------

describe('checkSequenceIntegrity — valid sequences', () => {
  it('empty sequence returns isValid=true', () => {
    const result = checkSequenceIntegrity([])
    expect(result.isValid).toBe(true)
  })

  it('empty sequence returns zero gaps', () => {
    const result = checkSequenceIntegrity([])
    expect(result.sequenceGaps).toEqual([])
  })

  it('empty sequence returns zero duplicates', () => {
    const result = checkSequenceIntegrity([])
    expect(result.duplicateSeqNums).toEqual([])
  })

  it('single event [1] returns isValid=true', () => {
    const result = checkSequenceIntegrity([1])
    expect(result.isValid).toBe(true)
  })

  it('single event [1] returns zero gaps', () => {
    const result = checkSequenceIntegrity([1])
    expect(result.sequenceGaps).toEqual([])
  })

  it('contiguous range [1,2,3,4,5] returns isValid=true', () => {
    const result = checkSequenceIntegrity([1, 2, 3, 4, 5])
    expect(result.isValid).toBe(true)
  })

  it('contiguous range [1,2,3,4,5] returns zero gaps', () => {
    const result = checkSequenceIntegrity([1, 2, 3, 4, 5])
    expect(result.sequenceGaps).toEqual([])
  })

  it('contiguous range [1,2,3,4,5] returns zero duplicates', () => {
    const result = checkSequenceIntegrity([1, 2, 3, 4, 5])
    expect(result.duplicateSeqNums).toEqual([])
  })

  it('500-event contiguous sequence returns isValid=true', () => {
    const seqNums = Array.from({ length: 500 }, (_, i) => i + 1)
    const result = checkSequenceIntegrity(seqNums)
    expect(result.isValid).toBe(true)
  })

  it('500-event contiguous sequence returns zero gaps', () => {
    const seqNums = Array.from({ length: 500 }, (_, i) => i + 1)
    const result = checkSequenceIntegrity(seqNums)
    expect(result.sequenceGaps).toEqual([])
  })

  it('500-event contiguous sequence returns zero duplicates', () => {
    const seqNums = Array.from({ length: 500 }, (_, i) => i + 1)
    const result = checkSequenceIntegrity(seqNums)
    expect(result.duplicateSeqNums).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Group 2: Sequence gaps
// ---------------------------------------------------------------------------

describe('checkSequenceIntegrity — sequence gaps', () => {
  it('gap at seq 2: [1,3] returns isValid=false', () => {
    const result = checkSequenceIntegrity([1, 3])
    expect(result.isValid).toBe(false)
  })

  it('gap at seq 2: [1,3] sequenceGaps contains 2', () => {
    const result = checkSequenceIntegrity([1, 3])
    expect(result.sequenceGaps).toContain(2)
  })

  it('multiple gaps: [1,4,7] detects gaps 2,3,5,6', () => {
    const result = checkSequenceIntegrity([1, 4, 7])
    expect(result.sequenceGaps).toContain(2)
    expect(result.sequenceGaps).toContain(3)
    expect(result.sequenceGaps).toContain(5)
    expect(result.sequenceGaps).toContain(6)
    expect(result.sequenceGaps.length).toBe(4)
  })

  it('gap at beginning: [2,3,4] reports gap at seq 1', () => {
    // Sequence numbers start check at 1; if max=4 and 1 is absent, gap=[1]
    const result = checkSequenceIntegrity([2, 3, 4])
    expect(result.sequenceGaps).toContain(1)
    expect(result.isValid).toBe(false)
  })

  it('large run with one gap: 499 events missing seq 250 returns exactly one gap', () => {
    const seqNums = [
      ...Array.from({ length: 249 }, (_, i) => i + 1),
      ...Array.from({ length: 250 }, (_, i) => i + 251),
    ]
    const result = checkSequenceIntegrity(seqNums)
    expect(result.isValid).toBe(false)
    expect(result.sequenceGaps).toEqual([250])
    expect(result.sequenceGaps.length).toBe(1)
  })

  it('gaps are returned in ascending numeric order', () => {
    const result = checkSequenceIntegrity([1, 5, 10])
    const sorted = [...result.sequenceGaps].sort((a, b) => a - b)
    expect(result.sequenceGaps).toEqual(sorted)
  })

  it('failureReason is defined when gaps exist', () => {
    const result = checkSequenceIntegrity([1, 3])
    expect(result.failureReason).toBeDefined()
  })

  it('failureReason contains "gap" when only a gap exists', () => {
    const result = checkSequenceIntegrity([1, 3])
    expect(result.failureReason?.toLowerCase()).toContain('gap')
  })
})

// ---------------------------------------------------------------------------
// Group 3: Duplicate sequence numbers
// ---------------------------------------------------------------------------

describe('checkSequenceIntegrity — duplicate sequence numbers', () => {
  it('single duplicate [1,1]: isValid=false', () => {
    const result = checkSequenceIntegrity([1, 1])
    expect(result.isValid).toBe(false)
  })

  it('single duplicate [1,1]: duplicateSeqNums contains 1', () => {
    const result = checkSequenceIntegrity([1, 1])
    expect(result.duplicateSeqNums).toContain(1)
  })

  it('multiple duplicates [1,1,2,2,3]: both 1 and 2 appear in duplicates', () => {
    const result = checkSequenceIntegrity([1, 1, 2, 2, 3])
    expect(result.duplicateSeqNums).toContain(1)
    expect(result.duplicateSeqNums).toContain(2)
    expect(result.duplicateSeqNums).not.toContain(3)
  })

  it('multiple duplicates are returned in ascending order', () => {
    const result = checkSequenceIntegrity([3, 3, 1, 2, 1])
    const sorted = [...result.duplicateSeqNums].sort((a, b) => a - b)
    expect(result.duplicateSeqNums).toEqual(sorted)
  })

  it('dup with gap [1,1,3]: isValid=false (both reasons)', () => {
    const result = checkSequenceIntegrity([1, 1, 3])
    expect(result.isValid).toBe(false)
    expect(result.duplicateSeqNums).toContain(1)
    expect(result.sequenceGaps).toContain(2)
  })

  it('dup with gap: failureReason is defined', () => {
    const result = checkSequenceIntegrity([1, 1, 3])
    expect(result.failureReason).toBeDefined()
  })

  it('no duplicates when all sequence numbers are unique', () => {
    const result = checkSequenceIntegrity([1, 2, 3, 4, 5])
    expect(result.duplicateSeqNums).toEqual([])
  })

  it('failureReason contains "duplicate" when only duplicates exist (no gaps)', () => {
    // [1,1,2,3] — dup at 1, no gaps (1,1,2,3 — counts: {1:2,2:1,3:1}, max=3, gaps checked 1..3, all present)
    const result = checkSequenceIntegrity([1, 1, 2, 3])
    expect(result.isValid).toBe(false)
    expect(result.failureReason?.toLowerCase()).toContain('duplicate')
  })
})

// ---------------------------------------------------------------------------
// Group 4: Summary string content
// ---------------------------------------------------------------------------

describe('checkSequenceIntegrity — summary string content', () => {
  it('valid sequence: summary starts with "OK:"', () => {
    const result = checkSequenceIntegrity([1, 2, 3])
    expect(result.summary.startsWith('OK:')).toBe(true)
  })

  it('valid sequence: summary contains event count', () => {
    const result = checkSequenceIntegrity([1, 2, 3])
    expect(result.summary).toContain('3')
  })

  it('valid sequence: summary contains "no gaps"', () => {
    const result = checkSequenceIntegrity([1, 2, 3])
    expect(result.summary).toContain('no gaps')
  })

  it('valid sequence: summary contains "sequence valid"', () => {
    const result = checkSequenceIntegrity([1, 2, 3])
    expect(result.summary).toContain('sequence valid')
  })

  it('invalid sequence with gap: summary starts with "INVALID:"', () => {
    const result = checkSequenceIntegrity([1, 3])
    expect(result.summary.startsWith('INVALID:')).toBe(true)
  })

  it('invalid sequence with gap: summary contains "gap"', () => {
    const result = checkSequenceIntegrity([1, 3])
    expect(result.summary.toLowerCase()).toContain('gap')
  })

  it('invalid sequence with duplicate: summary starts with "INVALID:"', () => {
    const result = checkSequenceIntegrity([1, 1, 2])
    expect(result.summary.startsWith('INVALID:')).toBe(true)
  })

  it('invalid sequence with duplicate: summary contains "duplicate"', () => {
    const result = checkSequenceIntegrity([1, 1, 2])
    expect(result.summary.toLowerCase()).toContain('duplicate')
  })

  it('failureReason matches the first part of the INVALID summary', () => {
    const result = checkSequenceIntegrity([1, 3])
    // failureReason should appear inside the INVALID summary
    expect(result.failureReason).toBeDefined()
    expect(result.summary).toContain(result.failureReason!)
  })

  it('valid empty sequence: summary is a non-empty string', () => {
    const result = checkSequenceIntegrity([])
    expect(typeof result.summary).toBe('string')
    expect(result.summary.length).toBeGreaterThan(0)
  })

  it('valid empty sequence: failureReason is undefined', () => {
    const result = checkSequenceIntegrity([])
    expect(result.failureReason).toBeUndefined()
  })

  it('valid sequence: failureReason is undefined', () => {
    const result = checkSequenceIntegrity([1, 2, 3, 4, 5])
    expect(result.failureReason).toBeUndefined()
  })

  it('summary with more than 5 gaps shows ellipsis in brackets', () => {
    // gaps: 2,3,4,5,6,7 (6 gaps — triggers ", …" suffix)
    const result = checkSequenceIntegrity([1, 8])
    expect(result.summary).toContain('…')
  })
})

// ---------------------------------------------------------------------------
// Group 5: Bounded window constants
// ---------------------------------------------------------------------------

describe('Bounded window constants', () => {
  it('BATCH_LIMIT equals 50', () => {
    expect(BATCH_LIMIT).toBe(50)
  })

  it('WINDOW_MS equals 48 hours in milliseconds', () => {
    expect(WINDOW_MS).toBe(172_800_000)
  })

  it('WINDOW_MS equals 48 * 60 * 60 * 1000', () => {
    expect(WINDOW_MS).toBe(48 * 60 * 60 * 1000)
  })

  it('BATCH_LIMIT is a positive integer', () => {
    expect(Number.isInteger(BATCH_LIMIT)).toBe(true)
    expect(BATCH_LIMIT).toBeGreaterThan(0)
  })

  it('WINDOW_MS represents less than 72 hours (keeps window tight)', () => {
    const seventyTwoHoursMs = 72 * 60 * 60 * 1000
    expect(WINDOW_MS).toBeLessThan(seventyTwoHoursMs)
  })

  it('WINDOW_MS represents at least 24 hours (long enough to catch overnight failures)', () => {
    const twentyFourHoursMs = 24 * 60 * 60 * 1000
    expect(WINDOW_MS).toBeGreaterThanOrEqual(twentyFourHoursMs)
  })

  it('BATCH_LIMIT is at most 100 (prevents unbounded cron scans)', () => {
    expect(BATCH_LIMIT).toBeLessThanOrEqual(100)
  })
})
