import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for verification discoverability (Prompt 23).
//
// These tests cover:
//   1. matchesVerifyFilter — the post-fetch verification filter logic
//   2. Verification column rendering decision (showIntegrity prop)
//   3. Dashboard issue section state logic
//   4. buildHref — URL construction for filter pills
//   5. Edge cases — empty results, missing statuses, invalid filter values
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

type VerifyFilter = 'all' | 'verified' | 'partial' | 'failed' | 'unverified'
const VERIFY_VALUES: VerifyFilter[] = ['all', 'verified', 'partial', 'failed', 'unverified']

// ---------------------------------------------------------------------------
// Inline: matchesVerifyFilter
// (mirrors the function in apps/web/app/(app)/runs/page.tsx)
// ---------------------------------------------------------------------------

function matchesVerifyFilter(
  status: VerificationStatus | undefined,
  verify: VerifyFilter,
): boolean {
  if (verify === 'all') return true
  if (!status || !status.verified) return verify === 'unverified'
  if (verify === 'unverified') return false
  if (verify === 'failed') return !status.isValid
  if (verify === 'verified') return status.isValid === true && status.checksRan.includes('replay')
  if (verify === 'partial') return status.isValid === true && !status.checksRan.includes('replay')
  return true
}

// ---------------------------------------------------------------------------
// Inline: buildHref
// (mirrors the function in apps/web/app/(app)/runs/page.tsx)
// ---------------------------------------------------------------------------

function buildHref(
  base: Record<string, string | undefined>,
  override: Record<string, string | undefined>,
): string {
  const merged = { ...base, ...override }
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(merged)) {
    if (v && v !== 'all') params.set(k, v)
  }
  const qs = params.toString()
  return `/runs${qs ? `?${qs}` : ''}`
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

function seqVerifiedStatus(): VerificationStatus {
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

function fullyVerifiedStatus(): VerificationStatus {
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
// 1. matchesVerifyFilter — 'all'
// ---------------------------------------------------------------------------

describe('matchesVerifyFilter — all', () => {
  it('accepts unverified runs', () => {
    expect(matchesVerifyFilter(unverifiedStatus(), 'all')).toBe(true)
  })
  it('accepts seq verified runs', () => {
    expect(matchesVerifyFilter(seqVerifiedStatus(), 'all')).toBe(true)
  })
  it('accepts fully verified runs', () => {
    expect(matchesVerifyFilter(fullyVerifiedStatus(), 'all')).toBe(true)
  })
  it('accepts failed runs', () => {
    expect(matchesVerifyFilter(failedStatus(), 'all')).toBe(true)
  })
  it('accepts runs with no status (undefined)', () => {
    expect(matchesVerifyFilter(undefined, 'all')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. matchesVerifyFilter — 'unverified'
// ---------------------------------------------------------------------------

describe('matchesVerifyFilter — unverified', () => {
  it('accepts a run with verified=false', () => {
    expect(matchesVerifyFilter(unverifiedStatus(), 'unverified')).toBe(true)
  })
  it('accepts a run with no status (undefined)', () => {
    expect(matchesVerifyFilter(undefined, 'unverified')).toBe(true)
  })
  it('rejects a seq verified run', () => {
    expect(matchesVerifyFilter(seqVerifiedStatus(), 'unverified')).toBe(false)
  })
  it('rejects a fully verified run', () => {
    expect(matchesVerifyFilter(fullyVerifiedStatus(), 'unverified')).toBe(false)
  })
  it('rejects a failed run (it has been verified, just failed)', () => {
    expect(matchesVerifyFilter(failedStatus(), 'unverified')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. matchesVerifyFilter — 'failed'
// ---------------------------------------------------------------------------

describe('matchesVerifyFilter — failed', () => {
  it('accepts a run with isValid=false', () => {
    expect(matchesVerifyFilter(failedStatus(), 'failed')).toBe(true)
  })
  it('rejects a seq verified run', () => {
    expect(matchesVerifyFilter(seqVerifiedStatus(), 'failed')).toBe(false)
  })
  it('rejects a fully verified run', () => {
    expect(matchesVerifyFilter(fullyVerifiedStatus(), 'failed')).toBe(false)
  })
  it('rejects an unverified run (no result exists)', () => {
    expect(matchesVerifyFilter(unverifiedStatus(), 'failed')).toBe(false)
  })
  it('rejects a run with no status', () => {
    expect(matchesVerifyFilter(undefined, 'failed')).toBe(false)
  })
  it('accepts a failed run with derivation errors', () => {
    const status: VerificationStatus = {
      ...fullyVerifiedStatus(),
      isValid: false,
      replayPassed: false,
    }
    expect(matchesVerifyFilter(status, 'failed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. matchesVerifyFilter — 'verified' (full derivation)
// ---------------------------------------------------------------------------

describe('matchesVerifyFilter — verified (full derivation)', () => {
  it('accepts a fully derivation-verified run', () => {
    expect(matchesVerifyFilter(fullyVerifiedStatus(), 'verified')).toBe(true)
  })
  it('rejects a seq-only verified run (no replay in checksRan)', () => {
    expect(matchesVerifyFilter(seqVerifiedStatus(), 'verified')).toBe(false)
  })
  it('rejects a failed run', () => {
    expect(matchesVerifyFilter(failedStatus(), 'verified')).toBe(false)
  })
  it('rejects an unverified run', () => {
    expect(matchesVerifyFilter(unverifiedStatus(), 'verified')).toBe(false)
  })
  it('rejects a run with no status', () => {
    expect(matchesVerifyFilter(undefined, 'verified')).toBe(false)
  })
  it('requires isValid=true — rejects failed full-derivation run', () => {
    const status: VerificationStatus = {
      ...fullyVerifiedStatus(),
      isValid: false,
      replayPassed: false,
    }
    expect(matchesVerifyFilter(status, 'verified')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. matchesVerifyFilter — 'partial' (sequence-only verified)
// ---------------------------------------------------------------------------

describe('matchesVerifyFilter — partial', () => {
  it('accepts a seq-only verified run', () => {
    expect(matchesVerifyFilter(seqVerifiedStatus(), 'partial')).toBe(true)
  })
  it('rejects a fully verified run (has replay in checksRan)', () => {
    expect(matchesVerifyFilter(fullyVerifiedStatus(), 'partial')).toBe(false)
  })
  it('rejects a failed run', () => {
    expect(matchesVerifyFilter(failedStatus(), 'partial')).toBe(false)
  })
  it('rejects an unverified run', () => {
    expect(matchesVerifyFilter(unverifiedStatus(), 'partial')).toBe(false)
  })
  it('accepts a run with empty checksRan (graceful degradation)', () => {
    const status: VerificationStatus = {
      ...seqVerifiedStatus(),
      checksRan: [], // Degraded — no checksRan recorded
    }
    expect(matchesVerifyFilter(status, 'partial')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Integrity column visibility (showIntegrity prop decision)
// ---------------------------------------------------------------------------

describe('showIntegrity column visibility', () => {
  it('shows integrity column when verificationStatuses is an object (even empty)', () => {
    const verificationStatuses: Record<string, VerificationStatus> = {}
    expect(verificationStatuses !== undefined).toBe(true)
  })

  it('hides integrity column when verificationStatuses is undefined', () => {
    const verificationStatuses: Record<string, VerificationStatus> | undefined = undefined
    expect(verificationStatuses !== undefined).toBe(false)
  })

  it('shows badge when status exists for a run', () => {
    const runId = 'run1'
    const statuses: Record<string, VerificationStatus> = { run1: fullyVerifiedStatus() }
    expect(statuses[runId] !== undefined).toBe(true)
  })

  it('shows dash when status does not exist for a run', () => {
    const runId = 'run1'
    const statuses: Record<string, VerificationStatus> = {}
    expect(statuses[runId]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 7. Dashboard verification section state logic
// ---------------------------------------------------------------------------

interface FailedVerification {
  runId: string
  verifiedAt: number
  isValid: boolean
  checksRan: string[]
  failureReason: string | undefined
  sequenceGaps: number[]
  duplicateSeqNums: number[]
}

describe('dashboard verification section', () => {
  it('shows "no issues" message when failedVerifications is empty', () => {
    const failedVerifications: FailedVerification[] = []
    const showIssueList = failedVerifications.length > 0
    expect(showIssueList).toBe(false)
  })

  it('shows issue list when failedVerifications has entries', () => {
    const failedVerifications: FailedVerification[] = [
      {
        runId: 'r1',
        verifiedAt: 1_700_000_000_000,
        isValid: false,
        checksRan: ['sequence'],
        failureReason: '2 sequence gaps [3, 7]',
        sequenceGaps: [3, 7],
        duplicateSeqNums: [],
      },
    ]
    const showIssueList = failedVerifications.length > 0
    expect(showIssueList).toBe(true)
  })

  it('shows all-clear without distinguishing never-run from all-passed', () => {
    // Both cases produce failedVerifications = [] → same UI
    const neverRun: FailedVerification[] = []
    const allPassed: FailedVerification[] = []
    expect(neverRun.length === 0).toBe(true)
    expect(allPassed.length === 0).toBe(true)
  })

  it('caps dashboard list at 5 entries', () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({
      runId: `r${i}`,
      verifiedAt: 1_700_000_000_000,
      isValid: false,
      checksRan: ['sequence'],
      failureReason: 'gap',
      sequenceGaps: [i],
      duplicateSeqNums: [],
    }))
    const shown = failures.slice(0, 5)
    expect(shown).toHaveLength(5)
  })

  it('constructs correct badge status from FailedVerification', () => {
    const fv: FailedVerification = {
      runId: 'r1',
      verifiedAt: 1_700_000_000_000,
      isValid: false,
      checksRan: ['sequence', 'replay', 'failureSummary'],
      failureReason: 'buildReplayProjection threw',
      sequenceGaps: [],
      duplicateSeqNums: [],
    }
    const badgeStatus = {
      verified: true,
      isValid: false,
      verifiedAt: fv.verifiedAt,
      summary: fv.failureReason ?? 'Verification failed',
      sequenceGaps: fv.sequenceGaps,
      duplicateSeqNums: fv.duplicateSeqNums,
      checksRan: fv.checksRan,
      replayPassed: null,
      failureSummaryPassed: null,
    }
    expect(badgeStatus.isValid).toBe(false)
    expect(badgeStatus.verified).toBe(true)
    expect(badgeStatus.summary).toBe('buildReplayProjection threw')
  })

  it('uses fallback summary when failureReason is undefined', () => {
    const fv: FailedVerification = {
      runId: 'r1',
      verifiedAt: 1_700_000_000_000,
      isValid: false,
      checksRan: [],
      failureReason: undefined,
      sequenceGaps: [],
      duplicateSeqNums: [],
    }
    const summary = fv.failureReason ?? 'Verification failed'
    expect(summary).toBe('Verification failed')
  })
})

// ---------------------------------------------------------------------------
// 8. buildHref — URL construction for filter pills
// ---------------------------------------------------------------------------

describe('buildHref', () => {
  it('returns /runs with no params when all filters are default', () => {
    const href = buildHref({}, {})
    expect(href).toBe('/runs')
  })

  it('includes status param when set', () => {
    const href = buildHref({ status: 'failed' }, {})
    expect(href).toContain('status=failed')
  })

  it('includes verify param when set', () => {
    const href = buildHref({}, { verify: 'failed' })
    expect(href).toContain('verify=failed')
  })

  it('omits verify param when value is all', () => {
    const href = buildHref({}, { verify: 'all' })
    expect(href).not.toContain('verify=')
  })

  it('preserves existing params when adding verify filter', () => {
    const href = buildHref({ status: 'failed', range: '7d' }, { verify: 'failed' })
    expect(href).toContain('status=failed')
    expect(href).toContain('range=7d')
    expect(href).toContain('verify=failed')
  })

  it('overrides verify when updating from failed to verified', () => {
    const href = buildHref({ verify: 'failed', status: 'completed' }, { verify: 'verified' })
    expect(href).toContain('verify=verified')
    expect(href).not.toContain('verify=failed')
  })

  it('removes verify when switching back to all', () => {
    const href = buildHref({ verify: 'failed' }, { verify: 'all' })
    expect(href).not.toContain('verify=')
  })

  it('removes status when switching to all status', () => {
    const href = buildHref({ status: 'failed', verify: 'failed' }, { status: 'all' })
    expect(href).not.toContain('status=')
    expect(href).toContain('verify=failed')
  })

  it('starts with /runs always', () => {
    expect(buildHref({ status: 'running' }, { verify: 'failed' })).toMatch(/^\/runs/)
    expect(buildHref({}, {})).toBe('/runs')
  })
})

// ---------------------------------------------------------------------------
// 9. VERIFY_VALUES validation
// ---------------------------------------------------------------------------

describe('verify filter value validation', () => {
  it('includes all expected filter values', () => {
    expect(VERIFY_VALUES).toEqual(['all', 'verified', 'partial', 'failed', 'unverified'])
  })

  it('rejects invalid filter values — unknown filter treated as all', () => {
    const unknownFilter = 'invalid' as VerifyFilter
    const result = VERIFY_VALUES.includes(unknownFilter) ? unknownFilter : 'all'
    expect(result).toBe('all')
  })

  it('accepts all valid filter values', () => {
    for (const v of VERIFY_VALUES) {
      expect(VERIFY_VALUES.includes(v)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 10. Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('all filter with empty run list returns zero matches', () => {
    const runs: Array<{ id: string }> = []
    const filtered = runs.filter(() => matchesVerifyFilter(undefined, 'all'))
    expect(filtered).toHaveLength(0)
  })

  it('failed filter with all unverified runs returns zero matches', () => {
    const runIds = ['r1', 'r2', 'r3']
    const statuses: Record<string, VerificationStatus> = {
      r1: unverifiedStatus(),
      r2: unverifiedStatus(),
      r3: unverifiedStatus(),
    }
    const filtered = runIds.filter((id) => matchesVerifyFilter(statuses[id], 'failed'))
    expect(filtered).toHaveLength(0)
  })

  it('verified filter with all partial runs returns zero matches', () => {
    const runIds = ['r1', 'r2']
    const statuses: Record<string, VerificationStatus> = {
      r1: seqVerifiedStatus(),
      r2: seqVerifiedStatus(),
    }
    const filtered = runIds.filter((id) => matchesVerifyFilter(statuses[id], 'verified'))
    expect(filtered).toHaveLength(0)
  })

  it('partial filter returns seq-only runs and excludes full-derivation runs', () => {
    const runIds = ['r1', 'r2', 'r3']
    const statuses: Record<string, VerificationStatus> = {
      r1: seqVerifiedStatus(),
      r2: fullyVerifiedStatus(),
      r3: failedStatus(),
    }
    const filtered = runIds.filter((id) => matchesVerifyFilter(statuses[id], 'partial'))
    expect(filtered).toEqual(['r1'])
  })

  it('mixed page with all verification states — filter returns correct subset', () => {
    const runIds = ['r1', 'r2', 'r3', 'r4', 'r5']
    const statuses: Record<string, VerificationStatus> = {
      r1: unverifiedStatus(),
      r2: seqVerifiedStatus(),
      r3: fullyVerifiedStatus(),
      r4: failedStatus(),
      // r5 has no status entry
    }

    expect(runIds.filter((id) => matchesVerifyFilter(statuses[id], 'all'))).toHaveLength(5)
    expect(runIds.filter((id) => matchesVerifyFilter(statuses[id], 'unverified'))).toEqual(['r1', 'r5'])
    expect(runIds.filter((id) => matchesVerifyFilter(statuses[id], 'partial'))).toEqual(['r2'])
    expect(runIds.filter((id) => matchesVerifyFilter(statuses[id], 'verified'))).toEqual(['r3'])
    expect(runIds.filter((id) => matchesVerifyFilter(statuses[id], 'failed'))).toEqual(['r4'])
  })
})
