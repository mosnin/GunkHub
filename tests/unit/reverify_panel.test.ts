import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for the per-run reverify panel introduced in Prompt 22.
//
// These tests cover:
//   1. reverifyRunAction response mapping — raw action result → VerificationStatus
//   2. Panel state transitions — unverified → verified, error handling
//   3. VerificationFailureDetail issue generation — per failure category
//   4. CheckPill logic — ran/skipped + passed/failed state matrix
//   5. Auth/forbidden error handling — surface correct messages
//   6. Partial verification detection — seq-only vs full derivation
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
// Helper: build a VerificationStatus from a raw reverifyRun action result
// (mirrors reverifyRunAction mapping logic in apps/web/src/lib/actions/verification.ts)
// ---------------------------------------------------------------------------

function mapReverifyResult(r: Record<string, unknown>): VerificationStatus {
  return {
    verified: true,
    isValid: r.isValid as boolean,
    verifiedAt: r.verifiedAt as number,
    summary: r.summary as string,
    sequenceGaps: (r.sequenceGaps as number[]) ?? [],
    duplicateSeqNums: (r.duplicateSeqNums as number[]) ?? [],
    checksRan: (r.checksRan as string[] | undefined) ?? [],
    replayPassed: r.replayPassed != null ? (r.replayPassed as boolean) : null,
    failureSummaryPassed:
      r.failureSummaryPassed != null ? (r.failureSummaryPassed as boolean) : null,
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
// Helper: simulate panel state transition after a reverify call
// ---------------------------------------------------------------------------

interface ReverifyResult {
  status: VerificationStatus | null
  error: string | null
}

function applyReverifyResult(
  current: VerificationStatus,
  result: ReverifyResult,
): { status: VerificationStatus; error: string | null } {
  if (result.error) return { status: current, error: result.error }
  if (result.status) return { status: result.status, error: null }
  return { status: current, error: null }
}

// ---------------------------------------------------------------------------
// Helper: build failure issues (mirrors VerificationFailureDetail logic)
// ---------------------------------------------------------------------------

interface FailureIssue {
  title: string
  detail: string
  hint: string
}

function buildIssues(status: VerificationStatus): FailureIssue[] {
  const issues: FailureIssue[] = []

  if (status.sequenceGaps.length > 0) {
    const shown = status.sequenceGaps.slice(0, 5).join(', ')
    const suffix = status.sequenceGaps.length > 5 ? ', …' : ''
    issues.push({
      title: `${status.sequenceGaps.length} sequence gap${status.sequenceGaps.length === 1 ? '' : 's'}`,
      detail: `Missing sequence numbers: ${shown}${suffix}`,
      hint: 'Check SDK ingest logs for dropped or failed event submissions.',
    })
  }

  if (status.duplicateSeqNums.length > 0) {
    const shown = status.duplicateSeqNums.slice(0, 5).join(', ')
    const suffix = status.duplicateSeqNums.length > 5 ? ', …' : ''
    issues.push({
      title: `${status.duplicateSeqNums.length} duplicate sequence number${status.duplicateSeqNums.length === 1 ? '' : 's'}`,
      detail: `Duplicated at: ${shown}${suffix}`,
      hint: 'Check SDK retry logic and idempotency handling in sendEvents().',
    })
  }

  if (status.replayPassed === false) {
    issues.push({
      title: 'Replay projection failed',
      detail: 'buildReplayProjection threw or produced an inconsistent result for this run.',
      hint: 'Run scripts/rebuild-projection.ts against this run ID to inspect the error.',
    })
  }

  if (status.failureSummaryPassed === false) {
    issues.push({
      title: 'Failure summary derivation failed',
      detail: 'buildFailureSummary threw or returned an unexpected result.',
      hint: 'Inspect the RUN_FAILED event payload for this run — the error field may be malformed.',
    })
  }

  return issues
}

// ---------------------------------------------------------------------------
// Helper: determine check pill state (ran, passed)
// ---------------------------------------------------------------------------

interface CheckState {
  sequence: { ran: boolean; passed: boolean | null }
  replay: { ran: boolean; passed: boolean | null }
  failureSummary: { ran: boolean; passed: boolean | null }
}

function deriveCheckState(status: VerificationStatus): CheckState {
  const seqPassed = status.verified
    ? status.sequenceGaps.length === 0 && status.duplicateSeqNums.length === 0
    : null

  return {
    sequence: { ran: status.verified, passed: seqPassed },
    replay: {
      ran: status.checksRan.includes('replay'),
      passed: status.replayPassed,
    },
    failureSummary: {
      ran: status.checksRan.includes('failureSummary'),
      passed: status.failureSummaryPassed,
    },
  }
}

// ---------------------------------------------------------------------------
// 1. reverifyRunAction result mapping
// ---------------------------------------------------------------------------

describe('reverify result mapping — full derivation', () => {
  it('maps a successful full derivation result to verified status', () => {
    const raw: Record<string, unknown> = {
      isValid: true,
      verifiedAt: 1_700_000_000_000,
      summary: 'OK: 42 events, no gaps, sequence valid',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true,
      failureSummaryPassed: true,
    }
    const status = mapReverifyResult(raw)
    expect(status.verified).toBe(true)
    expect(status.isValid).toBe(true)
    expect(status.checksRan).toEqual(['sequence', 'replay', 'failureSummary'])
    expect(status.replayPassed).toBe(true)
    expect(status.failureSummaryPassed).toBe(true)
  })

  it('maps a failed full derivation result', () => {
    const raw: Record<string, unknown> = {
      isValid: false,
      verifiedAt: 1_700_000_000_000,
      summary: 'INVALID: replay projection failed',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false,
      failureSummaryPassed: true,
    }
    const status = mapReverifyResult(raw)
    expect(status.isValid).toBe(false)
    expect(status.replayPassed).toBe(false)
    expect(status.failureSummaryPassed).toBe(true)
  })

  it('maps a sequence-only result (no checksRan field)', () => {
    const raw: Record<string, unknown> = {
      isValid: true,
      verifiedAt: 1_700_000_000_000,
      summary: 'OK: 10 events, no gaps, sequence valid',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: undefined,
      replayPassed: undefined,
      failureSummaryPassed: undefined,
    }
    const status = mapReverifyResult(raw)
    expect(status.checksRan).toEqual([])
    expect(status.replayPassed).toBeNull()
    expect(status.failureSummaryPassed).toBeNull()
  })

  it('maps sequenceGaps and duplicateSeqNums arrays', () => {
    const raw: Record<string, unknown> = {
      isValid: false,
      verifiedAt: 1_700_000_000_000,
      summary: 'INVALID: 2 sequence gaps; 1 duplicate',
      sequenceGaps: [3, 7],
      duplicateSeqNums: [5],
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const status = mapReverifyResult(raw)
    expect(status.sequenceGaps).toEqual([3, 7])
    expect(status.duplicateSeqNums).toEqual([5])
  })

  it('defaults missing arrays to empty', () => {
    const raw: Record<string, unknown> = {
      isValid: true,
      verifiedAt: 1_700_000_000_000,
      summary: 'OK',
    }
    const status = mapReverifyResult(raw)
    expect(status.sequenceGaps).toEqual([])
    expect(status.duplicateSeqNums).toEqual([])
    expect(status.checksRan).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Panel state transitions
// ---------------------------------------------------------------------------

describe('panel state transitions', () => {
  it('starts with initialStatus when provided', () => {
    const init: VerificationStatus = {
      verified: true,
      isValid: true,
      verifiedAt: 1_700_000_000_000,
      summary: 'OK',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true,
      failureSummaryPassed: true,
    }
    // Panel state is simply initialStatus — no transformation on mount
    expect(init.verified).toBe(true)
  })

  it('starts with unverified default when initialStatus is null', () => {
    const status = unverifiedStatus()
    expect(status.verified).toBe(false)
    expect(status.isValid).toBeNull()
    expect(status.checksRan).toEqual([])
  })

  it('updates status on successful reverify', () => {
    const current = unverifiedStatus()
    const newStatus: VerificationStatus = {
      verified: true,
      isValid: true,
      verifiedAt: Date.now(),
      summary: 'OK: 5 events',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence'],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const result = applyReverifyResult(current, { status: newStatus, error: null })
    expect(result.status.verified).toBe(true)
    expect(result.error).toBeNull()
  })

  it('keeps current status and sets error on reverify failure', () => {
    const current: VerificationStatus = {
      verified: true,
      isValid: true,
      verifiedAt: 1_700_000_000_000,
      summary: 'OK',
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence'],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const result = applyReverifyResult(current, { status: null, error: 'Forbidden: member or admin role required' })
    expect(result.status).toBe(current)
    expect(result.error).toBe('Forbidden: member or admin role required')
  })

  it('keeps current status when result has neither status nor error', () => {
    const current = unverifiedStatus()
    const result = applyReverifyResult(current, { status: null, error: null })
    expect(result.status).toBe(current)
    expect(result.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. VerificationFailureDetail issue generation
// ---------------------------------------------------------------------------

describe('buildIssues — sequence gaps', () => {
  it('produces a gap issue for one gap', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [3],
      duplicateSeqNums: [],
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const issues = buildIssues(status)
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('1 sequence gap')
    expect(issues[0].detail).toContain('3')
    expect(issues[0].hint).toContain('ingest logs')
  })

  it('pluralizes gap title for multiple gaps', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [3, 7, 11],
      duplicateSeqNums: [],
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const issues = buildIssues(status)
    expect(issues[0].title).toBe('3 sequence gaps')
  })

  it('truncates long gap list to 5 entries with ellipsis', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [1, 2, 3, 4, 5, 6, 7],
      duplicateSeqNums: [],
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const issues = buildIssues(status)
    expect(issues[0].detail).toContain('…')
    expect(issues[0].detail).not.toContain('6')
  })

  it('does not truncate exactly 5 gaps', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [1, 2, 3, 4, 5],
      duplicateSeqNums: [],
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const issues = buildIssues(status)
    expect(issues[0].detail).not.toContain('…')
    expect(issues[0].detail).toContain('5')
  })
})

describe('buildIssues — duplicates', () => {
  it('produces a duplicate issue', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [],
      duplicateSeqNums: [4],
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const issues = buildIssues(status)
    expect(issues[0].title).toBe('1 duplicate sequence number')
    expect(issues[0].hint).toContain('sendEvents()')
  })

  it('pluralizes duplicate title', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [],
      duplicateSeqNums: [4, 9],
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const issues = buildIssues(status)
    expect(issues[0].title).toBe('2 duplicate sequence numbers')
  })
})

describe('buildIssues — replay failure', () => {
  it('produces replay failure issue when replayPassed is false', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false,
      failureSummaryPassed: true,
    }
    const issues = buildIssues(status)
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('Replay projection failed')
    expect(issues[0].hint).toContain('rebuild-projection.ts')
  })

  it('does not add replay issue when replayPassed is null (not ran)', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence'],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const issues = buildIssues(status)
    expect(issues).toHaveLength(0)
  })
})

describe('buildIssues — failureSummary failure', () => {
  it('produces failureSummary issue when failureSummaryPassed is false', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true,
      failureSummaryPassed: false,
    }
    const issues = buildIssues(status)
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('Failure summary derivation failed')
    expect(issues[0].hint).toContain('RUN_FAILED')
  })

  it('produces multiple issues when all four failure types are present', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [2],
      duplicateSeqNums: [5],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false,
      failureSummaryPassed: false,
    }
    const issues = buildIssues(status)
    expect(issues).toHaveLength(4)
    expect(issues.map((i) => i.title)).toEqual([
      '1 sequence gap',
      '1 duplicate sequence number',
      'Replay projection failed',
      'Failure summary derivation failed',
    ])
  })

  it('returns empty issues for a valid fully-verified run', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true,
      failureSummaryPassed: true,
    }
    const issues = buildIssues(status)
    expect(issues).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. CheckPill logic — ran/passed state matrix
// ---------------------------------------------------------------------------

describe('deriveCheckState', () => {
  it('returns ran=false for all checks when unverified', () => {
    const state = deriveCheckState(unverifiedStatus())
    expect(state.sequence.ran).toBe(false)
    expect(state.replay.ran).toBe(false)
    expect(state.failureSummary.ran).toBe(false)
  })

  it('sequence always ran after any verification', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence'],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const state = deriveCheckState(status)
    expect(state.sequence.ran).toBe(true)
    expect(state.sequence.passed).toBe(true)
  })

  it('sequence passed=false when there are gaps', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [3],
      duplicateSeqNums: [],
      checksRan: ['sequence'],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const state = deriveCheckState(status)
    expect(state.sequence.passed).toBe(false)
  })

  it('sequence passed=false when there are duplicates', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [],
      duplicateSeqNums: [4],
      checksRan: ['sequence'],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const state = deriveCheckState(status)
    expect(state.sequence.passed).toBe(false)
  })

  it('replay and failureSummary show skipped for seq-only record', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence'],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const state = deriveCheckState(status)
    expect(state.replay.ran).toBe(false)
    expect(state.failureSummary.ran).toBe(false)
  })

  it('full derivation check shows all three as ran', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true,
      failureSummaryPassed: true,
    }
    const state = deriveCheckState(status)
    expect(state.sequence.ran).toBe(true)
    expect(state.replay.ran).toBe(true)
    expect(state.failureSummary.ran).toBe(true)
    expect(state.replay.passed).toBe(true)
    expect(state.failureSummary.passed).toBe(true)
  })

  it('shows failed state when replay failed but failureSummary passed', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: false,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: false,
      failureSummaryPassed: true,
    }
    const state = deriveCheckState(status)
    expect(state.replay.passed).toBe(false)
    expect(state.failureSummary.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Auth / forbidden error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('surfaces Unauthorized message when user is not authenticated', () => {
    const current = unverifiedStatus()
    const result = applyReverifyResult(current, { status: null, error: 'Not authenticated' })
    expect(result.error).toBe('Not authenticated')
    expect(result.status).toBe(current)
  })

  it('surfaces Forbidden message when user lacks member role', () => {
    const current = unverifiedStatus()
    const result = applyReverifyResult(current, {
      status: null,
      error: 'Forbidden: member or admin role required to re-run verification',
    })
    expect(result.error).toContain('Forbidden')
    expect(result.status).toBe(current)
  })

  it('surfaces Run not found message', () => {
    const current = unverifiedStatus()
    const result = applyReverifyResult(current, { status: null, error: 'Run not found' })
    expect(result.error).toBe('Run not found')
  })

  it('a subsequent successful reverify clears the prior error', () => {
    const current = unverifiedStatus()
    const errState = applyReverifyResult(current, { status: null, error: 'Network error' })

    const newStatus: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      verifiedAt: Date.now(),
      summary: 'OK',
      checksRan: ['sequence'],
    }
    const okState = applyReverifyResult(errState.status, { status: newStatus, error: null })
    expect(okState.error).toBeNull()
    expect(okState.status.verified).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Partial verification detection
// ---------------------------------------------------------------------------

describe('partial verification (seq-only) detection', () => {
  it('detects seq-only record (no replay in checksRan)', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      checksRan: ['sequence'],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const isSeqOnly = status.verified && !status.checksRan.includes('replay')
    expect(isSeqOnly).toBe(true)
  })

  it('detects full derivation record (replay in checksRan)', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      checksRan: ['sequence', 'replay', 'failureSummary'],
      replayPassed: true,
      failureSummaryPassed: true,
    }
    const isSeqOnly = status.verified && !status.checksRan.includes('replay')
    expect(isSeqOnly).toBe(false)
  })

  it('unverified is not seq-only (panel not shown for unverified non-terminal)', () => {
    const status = unverifiedStatus()
    const isSeqOnly = status.verified && !status.checksRan.includes('replay')
    expect(isSeqOnly).toBe(false)
  })

  it('empty checksRan after graceful degradation is treated as seq-only', () => {
    const status: VerificationStatus = {
      ...unverifiedStatus(),
      verified: true,
      isValid: true,
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
    const isSeqOnly = status.verified && !status.checksRan.includes('replay')
    expect(isSeqOnly).toBe(true)
  })
})
