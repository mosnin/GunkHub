import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for verification vocabulary normalization (Prompt 24).
//
// These tests cover:
//   1. IntegrityBadge state mapping — which label each VerificationStatus produces
//   2. Filter vocabulary — 'partial' replaces 'seq_verified' in filter logic
//   3. Vocabulary consistency — same state = same label across all surfaces
//
// All logic is inlined — no React, no DOM, no Convex, no network calls.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface VerificationStatus {
  verified: boolean
  isValid: boolean | null
  verifiedAt: number | null
  summary: string | null
  sequenceGaps: number[]
  duplicateSeqNums: number[]
  checksRan: string[]
  replayPassed: boolean | null
  failureSummaryPassed: boolean | null
}

// ---------------------------------------------------------------------------
// Inline: badge label derivation
// (mirrors IntegrityBadge.tsx state machine)
// ---------------------------------------------------------------------------

type BadgeLabel = 'unverified' | 'failed' | 'verified' | 'partial'

function getBadgeLabel(status: VerificationStatus): BadgeLabel {
  if (!status.verified) return 'unverified'
  if (!status.isValid) return 'failed'
  if (status.checksRan.includes('replay')) return 'verified'
  return 'partial'
}

// ---------------------------------------------------------------------------
// Inline: filter matching for 'partial'
// (mirrors matchesVerifyFilter in runs/page.tsx)
// ---------------------------------------------------------------------------

type VerifyFilter = 'all' | 'verified' | 'partial' | 'failed' | 'unverified'

function matchesFilter(status: VerificationStatus | undefined, verify: VerifyFilter): boolean {
  if (verify === 'all') return true
  if (!status || !status.verified) return verify === 'unverified'
  if (verify === 'unverified') return false
  if (verify === 'failed') return status.isValid === false
  if (verify === 'verified') return status.isValid === true && status.checksRan.includes('replay')
  if (verify === 'partial') return status.isValid === true && !status.checksRan.includes('replay')
  return true
}

// ---------------------------------------------------------------------------
// Status fixtures
// ---------------------------------------------------------------------------

function unverifiedStatus(): VerificationStatus {
  return {
    verified: false,
    isValid: null,
    verifiedAt: null,
    summary: null,
    sequenceGaps: [],
    duplicateSeqNums: [],
    checksRan: [],
    replayPassed: null,
    failureSummaryPassed: null,
  }
}

function partialStatus(): VerificationStatus {
  return {
    verified: true,
    isValid: true,
    verifiedAt: 1_700_000_000_000,
    summary: 'OK: 10 events',
    sequenceGaps: [],
    duplicateSeqNums: [],
    checksRan: ['sequence'],
    replayPassed: null,
    failureSummaryPassed: null,
  }
}

function verifiedStatus(): VerificationStatus {
  return {
    verified: true,
    isValid: true,
    verifiedAt: 1_700_000_000_000,
    summary: 'OK: 10 events',
    sequenceGaps: [],
    duplicateSeqNums: [],
    checksRan: ['sequence', 'replay', 'failureSummary'],
    replayPassed: true,
    failureSummaryPassed: true,
  }
}

function failedStatus(): VerificationStatus {
  return {
    verified: true,
    isValid: false,
    verifiedAt: 1_700_000_000_000,
    summary: 'INVALID: 2 sequence gaps',
    sequenceGaps: [3, 7],
    duplicateSeqNums: [],
    checksRan: ['sequence'],
    replayPassed: null,
    failureSummaryPassed: null,
  }
}

// ---------------------------------------------------------------------------
// 1. Badge label derivation — 4-state vocabulary
// ---------------------------------------------------------------------------

describe('IntegrityBadge label mapping', () => {
  it('maps unverified status to "unverified"', () => {
    expect(getBadgeLabel(unverifiedStatus())).toBe('unverified')
  })

  it('maps sequence-only valid status to "partial"', () => {
    expect(getBadgeLabel(partialStatus())).toBe('partial')
  })

  it('maps full derivation valid status to "verified"', () => {
    expect(getBadgeLabel(verifiedStatus())).toBe('verified')
  })

  it('maps invalid status to "failed"', () => {
    expect(getBadgeLabel(failedStatus())).toBe('failed')
  })

  it('maps invalid full-derivation status to "failed"', () => {
    const status = { ...verifiedStatus(), isValid: false, replayPassed: false }
    expect(getBadgeLabel(status)).toBe('failed')
  })

  it('maps status with empty checksRan (graceful degradation) to "partial"', () => {
    const status = { ...partialStatus(), checksRan: [] }
    expect(getBadgeLabel(status)).toBe('partial')
  })

  it('"partial" is distinct from both "verified" and "unverified"', () => {
    const p = getBadgeLabel(partialStatus())
    expect(p).not.toBe('verified')
    expect(p).not.toBe('unverified')
    expect(p).toBe('partial')
  })

  it('"failed" is distinct from "unverified" — failed has been checked', () => {
    expect(getBadgeLabel(failedStatus())).toBe('failed')
    expect(getBadgeLabel(unverifiedStatus())).toBe('unverified')
    expect(getBadgeLabel(failedStatus())).not.toBe(getBadgeLabel(unverifiedStatus()))
  })
})

// ---------------------------------------------------------------------------
// 2. Filter vocabulary — 'partial' replaces 'seq_verified'
// ---------------------------------------------------------------------------

describe('partial filter — vocabulary alignment', () => {
  it('partial filter accepts sequence-only verified runs', () => {
    expect(matchesFilter(partialStatus(), 'partial')).toBe(true)
  })

  it('partial filter rejects fully verified runs', () => {
    expect(matchesFilter(verifiedStatus(), 'partial')).toBe(false)
  })

  it('partial filter rejects failed runs', () => {
    expect(matchesFilter(failedStatus(), 'partial')).toBe(false)
  })

  it('partial filter rejects unverified runs', () => {
    expect(matchesFilter(unverifiedStatus(), 'partial')).toBe(false)
  })

  it('partial filter accepts degraded runs with empty checksRan', () => {
    const status = { ...partialStatus(), checksRan: [] }
    expect(matchesFilter(status, 'partial')).toBe(true)
  })

  it('partial filter matches exactly what badge label "partial" covers', () => {
    // Every status with badge label "partial" should match the partial filter
    const statuses = [
      partialStatus(),
      { ...partialStatus(), checksRan: [] },
    ]
    for (const s of statuses) {
      expect(getBadgeLabel(s)).toBe('partial')
      expect(matchesFilter(s, 'partial')).toBe(true)
    }
  })

  it('verified filter matches exactly what badge label "verified" covers', () => {
    const statuses = [verifiedStatus()]
    for (const s of statuses) {
      expect(getBadgeLabel(s)).toBe('verified')
      expect(matchesFilter(s, 'verified')).toBe(true)
    }
  })

  it('failed filter matches exactly what badge label "failed" covers', () => {
    const statuses = [
      failedStatus(),
      { ...verifiedStatus(), isValid: false, replayPassed: false },
    ]
    for (const s of statuses) {
      expect(getBadgeLabel(s)).toBe('failed')
      expect(matchesFilter(s, 'failed')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Vocabulary consistency — filter and badge labels are aligned
// ---------------------------------------------------------------------------

describe('vocabulary consistency — filter ↔ badge alignment', () => {
  const allStatuses: Array<[string, VerificationStatus]> = [
    ['unverified', unverifiedStatus()],
    ['partial', partialStatus()],
    ['verified', verifiedStatus()],
    ['failed', failedStatus()],
  ]

  it('each badge label maps 1:1 to a corresponding filter value', () => {
    const labelToFilter: Record<BadgeLabel, VerifyFilter> = {
      unverified: 'unverified',
      partial: 'partial',
      verified: 'verified',
      failed: 'failed',
    }
    for (const [, status] of allStatuses) {
      const label = getBadgeLabel(status)
      const filter = labelToFilter[label]
      expect(matchesFilter(status, filter)).toBe(true)
    }
  })

  it('each filter value exclusively matches its own badge label', () => {
    for (const [name, status] of allStatuses) {
      const label = getBadgeLabel(status)
      expect(label).toBe(name as BadgeLabel)
      // Must match its own filter
      expect(matchesFilter(status, label as VerifyFilter)).toBe(true)
      // Must not match other filters (except 'all')
      const otherFilters = (['verified', 'partial', 'failed', 'unverified'] as VerifyFilter[])
        .filter((f) => f !== label)
      for (const f of otherFilters) {
        expect(matchesFilter(status, f)).toBe(false)
      }
    }
  })

  it('"all" filter matches every status regardless of label', () => {
    for (const [, status] of allStatuses) {
      expect(matchesFilter(status, 'all')).toBe(true)
    }
    expect(matchesFilter(undefined, 'all')).toBe(true)
  })

  it('the set of badge labels equals the set of non-all filter values', () => {
    const badgeLabels: BadgeLabel[] = ['unverified', 'partial', 'verified', 'failed']
    const filterValues: VerifyFilter[] = ['unverified', 'partial', 'verified', 'failed']
    expect(badgeLabels.sort()).toEqual(filterValues.sort())
  })
})
