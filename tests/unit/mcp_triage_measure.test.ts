/**
 * PUBLISHED COST OF `afr_triage`, measured and printed.
 *
 * The README quotes a number for every tier. A quoted number nobody re-derives
 * drifts, so this prints the measurement the README cites, on the same
 * estimator (`bytes/4`) and the same contract-maximal inputs as
 * `mcp_progressive_disclosure.test.ts`. Read the stdout, not just the pass.
 */
import { describe, expect, it } from 'vitest'

import type { FailurePattern } from '@agent-flight-recorder/contracts'

const TRIAGE_SPEC = '../../packages/mcp/src/triage.ts'
const triage = (await import(/* @vite-ignore */ TRIAGE_SPEC)) as {
  toTriageResult(p: FailurePattern[], e: unknown, c: string | undefined, now: number, s?: { scanTruncated?: boolean }): unknown
  SCAN_LIMIT: number
  MAX_ITEMS: number
}

const NOW = 1_753_500_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const tok = (v: unknown): number => Math.ceil(Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8') / 4)

type PatternOverrides = { [K in keyof FailurePattern]?: FailurePattern[K] | undefined }

function pattern(i: number, o: PatternOverrides = {}): FailurePattern {
  return {
    id: `fp_${String(i)}`,
    orgId: 'org_caller',
    fingerprintHash: String(i + 1).padStart(2, '0') + 'f3a9c1d4e7b2',
    class: ['tool_error', 'timeout', 'http_error', 'retrieval_error', 'llm_error'][i % 5]!,
    label: ['Tool call failed', 'LLM request timed out', 'HTTP 429 from provider', 'Retrieval returned no documents', 'Model refused: content policy'][i % 5]!,
    salientKey: 'search',
    count: [128, 41, 7, 220, 3, 19, 66, 12, 5, 88][i % 10]!,
    firstSeenAt: NOW - 30 * DAY,
    lastSeenAt: NOW - (i % 7) * HOUR,
    representativeRunIds: Array.from({ length: 5 }, (_, r) => `run_${String(i)}${String(r)}`),
    affectedAgentVersionIds: Array.from({ length: 20 }, (_, v) => `ver_${String(i)}_${String(v)}`),
    affectedAgentIds: ['agent_a1', 'agent_b2'],
    lastSpikeAssessment: { assessedAt: NOW - HOUR, isSpiking: i % 2 === 0, recentCount: 44, baselineMean: 6.25, z: 4.81 },
    lastPatternSpikeAlertFiredAt: NOW - 2 * HOUR,
    muted: false,
    mutedAt: NOW - 10 * DAY,
    status: (['open', 'acknowledged', 'resolved'] as const)[i % 3]!,
    acknowledgedAt: NOW - 5 * DAY,
    acknowledgedByUserId: 'user_2f9',
    resolvedAt: NOW - 4 * DAY,
    resolvedByUserId: 'user_2f9',
    resolutionNote: 'Added retry with jitter on 429 from the provider, plus a circuit breaker after five consecutive failures.',
    resolutionRef: 'https://github.com/acme/agent/pull/812',
    regressedAt: NOW - 3 * DAY,
    resolvedInVersionId: 'ver_7c1',
    resolvedAtRunCount: 1204,
    resolvedAtOccurrenceCount: 41,
    ...o,
  } as FailurePattern
}

function envelope(ps: readonly FailurePattern[], unevaluated: string[] = []): unknown {
  return {
    stalenessBoundMs: 6 * HOUR,
    entries: ps.map((p, i) => ({
      fingerprintHash: p.fingerprintHash,
      state: (['unproven', 'proving', 'confirmed', 'regressed'] as const)[i % 4]!,
      score: 0.42, computedAt: NOW - 2 * HOUR, ageMs: 2 * HOUR, stale: i % 3 === 0, basis: 'snapshot' as const,
    })),
    staleCount: 0,
    unevaluated,
  }
}

describe('afr_triage measured cost', () => {
  it('prints the published numbers', () => {
    const full = Array.from({ length: triage.SCAN_LIMIT }, (_, i) => pattern(i))
    const cases: [string, unknown][] = [
      ['typical (50 scanned, complete, nothing degraded)', triage.toTriageResult(full, envelope(full), undefined, NOW)],
      ['truncated scan (+caveat, +top-level next)', triage.toTriageResult(full, envelope(full), 'cursor_abc123', NOW)],
      ['no fix confidence served (+caveat)', triage.toTriageResult(full, undefined, undefined, NOW)],
      [
        'WORST CASE (truncated + unevaluated + all muted)',
        triage.toTriageResult(
          full.map((p) => ({ ...p, muted: true })),
          envelope(full, full.slice(0, 6).map((p) => p.fingerprintHash)),
          'cursor_abc123',
          NOW,
          { scanTruncated: true },
        ),
      ],
      ['nothing broken (verdict: clear)', triage.toTriageResult([], envelope([]), undefined, NOW)],
    ]
    // eslint-disable-next-line no-console
    console.log('\n  afr_triage measured token cost (bytes/4):')
    for (const [name, value] of cases) {
      const bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
      // eslint-disable-next-line no-console
      console.log(`    ${String(tok(value)).padStart(4)} tok  (${String(bytes).padStart(5)} B)  ${name}`)
      expect(tok(value)).toBeLessThanOrEqual(450)
    }
  })
})
