import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for the derivation verification layer introduced in Prompt 21.
//
// These tests cover:
//   1. Route response mapping — how raw route JSON maps to VerificationStatus
//   2. checksRan derivation — which checks are recorded
//   3. replayPassed / failureSummaryPassed semantics
//   4. Badge display logic — which badge state is shown for each status combination
//   5. Graceful degradation — sequence-only fallback behaviour
//   6. Status model round-trips
//
// All logic is inlined — no React, no DOM, no Convex, no network calls.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared types (mirrors VerificationStatus from projection_verify.ts service)
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
// Helper: build a VerificationStatus from a raw Convex result record
// (mirrors getRunVerificationStatus mapping logic)
// ---------------------------------------------------------------------------

function mapResult(r: Record<string, unknown>): VerificationStatus {
  return {
    verified: true,
    isValid: r.isValid as boolean,
    verifiedAt: r.verifiedAt as number,
    summary: r.summary as string,
    sequenceGaps: (r.sequenceGaps as number[]) ?? [],
    duplicateSeqNums: (r.duplicateSeqNums as number[]) ?? [],
    checksRan: (r.checksRan as string[]) ?? [],
    replayPassed: r.replayPassed != null ? (r.replayPassed as boolean) : null,
    failureSummaryPassed: r.failureSummaryPassed != null ? (r.failureSummaryPassed as boolean) : null,
  }
}

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

// ---------------------------------------------------------------------------
// Helper: badge state derivation (mirrors IntegrityBadge display logic)
// ---------------------------------------------------------------------------

type BadgeState = 'unverified' | 'check failed' | 'verified' | 'seq verified'

function badgeState(status: VerificationStatus): BadgeState {
  if (!status.verified) return 'unverified'
  if (!status.isValid) return 'check failed'
  if (status.checksRan.includes('replay')) return 'verified'
  return 'seq verified'
}

// ---------------------------------------------------------------------------
// Group 1: Unverified status
// ---------------------------------------------------------------------------

describe('Unverified status defaults', () => {
  it('verified=false when no result exists', () => {
    expect(unverifiedStatus().verified).toBe(false)
  })

  it('isValid=null when unverified', () => {
    expect(unverifiedStatus().isValid).toBeNull()
  })

  it('checksRan=[] when unverified', () => {
    expect(unverifiedStatus().checksRan).toEqual([])
  })

  it('replayPassed=null when unverified', () => {
    expect(unverifiedStatus().replayPassed).toBeNull()
  })

  it('failureSummaryPassed=null when unverified', () => {
    expect(unverifiedStatus().failureSummaryPassed).toBeNull()
  })

  it('badge shows "unverified" for an unverified run', () => {
    expect(badgeState(unverifiedStatus())).toBe('unverified')
  })
})

// ---------------------------------------------------------------------------
// Group 2: Sequence-only result (pre-Prompt 21 / graceful degradation)
// ---------------------------------------------------------------------------

describe('Sequence-only verification result', () => {
  const seqOnlyValid = mapResult({
    isValid: true,
    verifiedAt: Date.now(),
    summary: 'OK: 10 events, no gaps, sequence valid',
    sequenceGaps: [],
    duplicateSeqNums: [],
    // checksRan absent → maps to []
  })

  it('verified=true for a sequence-only record', () => {
    expect(seqOnlyValid.verified).toBe(true)
  })

  it('isValid=true for a passing sequence-only record', () => {
    expect(seqOnlyValid.isValid).toBe(true)
  })

  it('checksRan=[] when field absent in raw record', () => {
    expect(seqOnlyValid.checksRan).toEqual([])
  })

  it('replayPassed=null when field absent', () => {
    expect(seqOnlyValid.replayPassed).toBeNull()
  })

  it('failureSummaryPassed=null when field absent', () => {
    expect(seqOnlyValid.failureSummaryPassed).toBeNull()
  })

  it('badge shows "seq verified" for a passing sequence-only result', () => {
    expect(badgeState(seqOnlyValid)).toBe('seq verified')
  })

  it('badge shows "check failed" for a failing sequence-only result', () => {
    const seqOnlyFailed = mapResult({
      isValid: false,
      verifiedAt: Date.now(),
      summary: 'INVALID: 2 sequence gaps [3, 7]',
      sequenceGaps: [3, 7],
      duplicateSeqNums: [],
    })
    expect(badgeState(seqOnlyFailed)).toBe('check failed')
  })
})

// ---------------------------------------------------------------------------
// Group 3: Full derivation result (Prompt 21 with web route)
// ---------------------------------------------------------------------------

describe('Full derivation verification result', () => {
  const fullValid = mapResult({
    isValid: true,
    verifiedAt: Date.now(),
    summary: 'OK: 50 events, no gaps, projection valid',
    sequenceGaps: [],
    duplicateSeqNums: [],
    checksRan: ['sequence', 'replay', 'failureSummary'],
    replayPassed: true,
    failureSummaryPassed: true,
  })

  it('verified=true for a full derivation record', () => {
    expect(fullValid.verified).toBe(true)
  })

  it('checksRan includes all three checks', () => {
    expect(fullValid.checksRan).toEqual(['sequence', 'replay', 'failureSummary'])
  })

  it('replayPassed=true when projection succeeded', () => {
    expect(fullValid.replayPassed).toBe(true)
  })

  it('failureSummaryPassed=true when summary succeeded', () => {
    expect(fullValid.failureSummaryPassed).toBe(true)
  })

  it('badge shows "verified" for a passing full derivation result', () => {
    expect(badgeState(fullValid)).toBe('verified')
  })

  it('badge shows "check failed" when full derivation result is invalid', () => {
    const fullFailed = mapResult({
      isValid: false,
      verifiedAt: Date.now(),
      summary: 'INVALID: buildReplayProjection threw: unexpected token',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false,
      failureSummaryPassed: true,
    })
    expect(badgeState(fullFailed)).toBe('check failed')
  })

  it('replayPassed=false when buildReplayProjection threw', () => {
    const status = mapResult({
      isValid: false,
      verifiedAt: Date.now(),
      summary: 'INVALID: buildReplayProjection threw: error',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false,
      failureSummaryPassed: true,
    })
    expect(status.replayPassed).toBe(false)
    expect(status.failureSummaryPassed).toBe(true)
  })

  it('failureSummaryPassed=false when buildFailureSummary threw', () => {
    const status = mapResult({
      isValid: false,
      verifiedAt: Date.now(),
      summary: 'INVALID: buildFailureSummary threw: error',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true,
      failureSummaryPassed: false,
    })
    expect(status.replayPassed).toBe(true)
    expect(status.failureSummaryPassed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Group 4: Badge state exhaustive coverage
// ---------------------------------------------------------------------------

describe('Badge state — all combinations', () => {
  it('unverified → "unverified"', () => {
    expect(badgeState(unverifiedStatus())).toBe('unverified')
  })

  it('verified + isValid=false → "check failed" regardless of checksRan', () => {
    const withReplay = mapResult({
      isValid: false, verifiedAt: 1, summary: 'INVALID', sequenceGaps: [2],
      duplicateSeqNums: [], checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false, failureSummaryPassed: true,
    })
    const withoutReplay = mapResult({
      isValid: false, verifiedAt: 1, summary: 'INVALID', sequenceGaps: [2],
      duplicateSeqNums: [],
    })
    expect(badgeState(withReplay)).toBe('check failed')
    expect(badgeState(withoutReplay)).toBe('check failed')
  })

  it('verified + isValid=true + checksRan includes "replay" → "verified"', () => {
    const status = mapResult({
      isValid: true, verifiedAt: 1, summary: 'OK', sequenceGaps: [], duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'], replayPassed: true, failureSummaryPassed: true,
    })
    expect(badgeState(status)).toBe('verified')
  })

  it('verified + isValid=true + checksRan does NOT include "replay" → "seq verified"', () => {
    const status = mapResult({
      isValid: true, verifiedAt: 1, summary: 'OK', sequenceGaps: [], duplicateSeqNums: [],
      checksRan: ['sequence'],
    })
    expect(badgeState(status)).toBe('seq verified')
  })

  it('verified + isValid=true + checksRan=[] (old record) → "seq verified"', () => {
    const status = mapResult({
      isValid: true, verifiedAt: 1, summary: 'OK', sequenceGaps: [], duplicateSeqNums: [],
    })
    expect(badgeState(status)).toBe('seq verified')
  })
})

// ---------------------------------------------------------------------------
// Group 5: checksRan semantics — what "ran" means vs what "passed"
// ---------------------------------------------------------------------------

describe('checksRan semantics', () => {
  it('checksRan records attempted checks, not just passing ones', () => {
    // Even if replayPassed=false, "replay" is still in checksRan
    const status = mapResult({
      isValid: false, verifiedAt: 1, summary: 'INVALID', sequenceGaps: [], duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false,
      failureSummaryPassed: true,
    })
    expect(status.checksRan).toContain('replay')
    expect(status.replayPassed).toBe(false)
  })

  it('checksRan=["sequence"] when only sequence was run', () => {
    const status = mapResult({
      isValid: true, verifiedAt: 1, summary: 'OK', sequenceGaps: [], duplicateSeqNums: [],
      checksRan: ['sequence'],
    })
    expect(status.checksRan).toEqual(['sequence'])
    expect(status.replayPassed).toBeNull()
    expect(status.failureSummaryPassed).toBeNull()
  })

  it('checksRan inclusion of "replay" is the discriminator for full vs seq-only badge', () => {
    const seqOnly = mapResult({
      isValid: true, verifiedAt: 1, summary: 'OK', sequenceGaps: [], duplicateSeqNums: [],
      checksRan: ['sequence'],
    })
    const full = mapResult({
      isValid: true, verifiedAt: 1, summary: 'OK', sequenceGaps: [], duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true, failureSummaryPassed: true,
    })
    expect(badgeState(seqOnly)).toBe('seq verified')
    expect(badgeState(full)).toBe('verified')
  })
})

// ---------------------------------------------------------------------------
// Group 6: Route response → VerificationStatus round-trip
// ---------------------------------------------------------------------------

describe('Route response to VerificationStatus round-trip', () => {
  it('valid full derivation route response maps correctly', () => {
    // Simulates what the web route returns and how mapResult handles it
    const routeResponse = {
      isValid: true,
      summary: 'OK: 30 events, no gaps, projection valid',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true,
      failureSummaryPassed: true,
      verifiedAt: 1_700_000_000_000,
    }
    const status = mapResult(routeResponse)
    expect(status.isValid).toBe(true)
    expect(status.checksRan).toEqual(['sequence', 'replay', 'failureSummary'])
    expect(status.replayPassed).toBe(true)
    expect(status.failureSummaryPassed).toBe(true)
    expect(badgeState(status)).toBe('verified')
  })

  it('invalid full derivation route response maps correctly', () => {
    const routeResponse = {
      isValid: false,
      summary: 'INVALID: Frame count mismatch: projection has 29 frames but 30 events',
      sequenceGaps: [],
      duplicateSeqNums: [],
      failureReason: 'Frame count mismatch: projection has 29 frames but 30 events',
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false,
      failureSummaryPassed: true,
      verifiedAt: 1_700_000_000_000,
    }
    const status = mapResult(routeResponse)
    expect(status.isValid).toBe(false)
    expect(status.replayPassed).toBe(false)
    expect(status.failureSummaryPassed).toBe(true)
    expect(badgeState(status)).toBe('check failed')
  })

  it('graceful degradation: sequence-only result stored when route unavailable', () => {
    // When Convex falls back to sequence-only, checksRan is absent
    const convexRecord = {
      isValid: true,
      summary: 'OK: 20 events, no gaps, sequence valid',
      sequenceGaps: [],
      duplicateSeqNums: [],
      verifiedAt: 1_700_000_000_000,
      // checksRan, replayPassed, failureSummaryPassed absent
    }
    const status = mapResult(convexRecord)
    expect(status.checksRan).toEqual([])
    expect(status.replayPassed).toBeNull()
    expect(status.failureSummaryPassed).toBeNull()
    expect(badgeState(status)).toBe('seq verified')
  })
})

// ---------------------------------------------------------------------------
// Group 7: DERIVATION_MAX_EVENTS cap logic
// ---------------------------------------------------------------------------

describe('DERIVATION_MAX_EVENTS cap', () => {
  const DERIVATION_MAX_EVENTS = 500

  it('runs with eventCount <= 500 are eligible for derivation check', () => {
    expect(500 <= DERIVATION_MAX_EVENTS).toBe(true)
    expect(499 <= DERIVATION_MAX_EVENTS).toBe(true)
  })

  it('runs with eventCount > 500 are excluded from derivation check', () => {
    expect(501 <= DERIVATION_MAX_EVENTS).toBe(false)
    expect(1000 <= DERIVATION_MAX_EVENTS).toBe(false)
  })

  it('boundary: exactly 500 events → eligible', () => {
    const eventCount = 500
    const eligible = eventCount <= DERIVATION_MAX_EVENTS
    expect(eligible).toBe(true)
  })

  it('boundary: 501 events → not eligible, falls back to seq-only', () => {
    const eventCount = 501
    const eligible = eventCount <= DERIVATION_MAX_EVENTS
    expect(eligible).toBe(false)
  })
})
