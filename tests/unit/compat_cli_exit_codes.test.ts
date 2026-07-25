/**
 * `afr compat` — the exit codes.
 *
 * This command will be put in CI by exactly the kind of team that is our ICP,
 * which makes the exit code the most load-bearing thing it produces. Nobody
 * reads the output on a green build; everybody acts on the number. So the
 * number gets the tests.
 *
 * Three properties are pinned here, and each one is a way a gate silently
 * stops gating:
 *
 *   1. A PROVEN divergence is a non-zero exit. Always, including when the rest
 *      of the analysis was incomplete — a proof does not weaken because
 *      something else went unchecked.
 *   2. EXIT 0 IS UNREACHABLE ON AN INCOMPLETE ANALYSIS (under a real
 *      threshold). "Nothing found" from an analysis that could not read the
 *      tool list is not evidence of safety, and this is the exact false clean
 *      the whole feature exists to refuse.
 *   3. THE THRESHOLD IS EXPLICIT. `--fail-on` is validated against a closed
 *      set and a typo is a usage error, never a silent fall back to the
 *      default — because the day someone typos `--fail-on any` is the day they
 *      believe they are gating on something they are not.
 *
 * Mocked fetch throughout — no network.
 */
import {
  COMPAT_EXIT_DIVERGENCE,
  COMPAT_EXIT_INDETERMINATE,
  DEFAULT_FAIL_ON,
  exitCodeForCompat,
  parseCompatArgs,
  runCompat,
} from '@agent-flight-recorder/cli'
import { describe, expect, it, vi } from 'vitest'

import type { CompatFleetResult, CompatRunResult } from '@agent-flight-recorder/cli'
import type {
  DivergenceReport,
  FleetDivergenceReport,
  IndeterminateDivergence,
  ProvenDivergence,
  SpeculativeDivergence,
} from '@agent-flight-recorder/contracts'
import type { V1FetchLike } from '@agent-flight-recorder/sdk'

const env = { apiKey: 'k', baseUrl: 'http://localhost:3000' }

function serve(data: unknown): V1FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { apiVersion: 'v1', data }
    },
    async text() {
      return ''
    },
    headers: { get: () => null },
  }))
}

const proven: ProvenDivergence = {
  certainty: 'proven',
  kind: 'tool_removed',
  dimension: 'tools',
  reasonKey: 'tool_removed:search_web',
  provenClaim: 'called tool `search_web` at sequence 42; target declares no such tool',
  provenBy: [
    {
      citedEvent: { sequenceNumber: 42, eventType: 'tool.call' },
      targetConfigPath: 'tools[].name',
      recordedValue: 'search_web',
      targetValue: null,
    },
  ],
}

const speculative: SpeculativeDivergence = {
  certainty: 'speculative',
  kind: 'system_prompt_changed',
  dimension: 'system_prompt',
  reasonKey: 'system_prompt_changed',
  speculativeConcern: 'system prompt changed; tool selection may differ',
  speculativeBecause: 'a prompt effect is not derivable from a recorded history',
  changedConfigPath: 'systemPrompt',
}

const unanswered: IndeterminateDivergence = {
  certainty: 'indeterminate',
  kind: 'target_config_unreadable',
  reasonKey: 'target_config_unreadable:tools',
  undecidedQuestion: 'whether the recorded tool calls target tools this version still declares',
  unknownBecause: "the target's `tools` key is a string, not an array",
  dimension: 'tools',
}

function report(overrides: Partial<DivergenceReport> = {}): DivergenceReport {
  return {
    runId: 'run_1',
    baselineVersionId: 'ver_old',
    targetVersionId: 'ver_new',
    analyzedAt: 1_700_000_000_000,
    verdict: 'compatible',
    proven: [],
    speculative: [],
    indeterminate: [],
    coverage: {
      assessed: ['tools', 'model', 'system_prompt', 'budgets', 'decoding_params', 'capabilities'],
      unassessed: [],
      eventsExamined: 120,
      eventHistoryComplete: true,
    },
    ...overrides,
  }
}

function fleetReport(overrides: Partial<FleetDivergenceReport> = {}): FleetDivergenceReport {
  return {
    agentId: 'ag_1',
    targetVersionId: 'ver_new',
    analyzedAt: 1_700_000_000_000,
    verdict: 'compatible',
    provenReasons: [],
    speculativeReasons: [],
    indeterminateReasons: [],
    runsWithProvenDivergence: 0,
    window: { runsScanned: 512, runsAnalyzed: 512, runsUnassessable: 0, runsSkippedForBudget: 0, scanTruncated: false },
    ...overrides,
  }
}

/** Run the single-run mode end-to-end against a served report, and return its exit code. */
async function exitCodeFor(served: DivergenceReport, argv: string[] = []): Promise<number> {
  const args = parseCompatArgs(['run_1', '--target', 'ver_new', ...argv])
  const result = await runCompat(args, env, serve({ report: served }))
  expect(result.ok).toBe(true)
  return exitCodeForCompat(result as CompatRunResult)
}

async function fleetExitCodeFor(served: FleetDivergenceReport, argv: string[] = []): Promise<number> {
  const args = parseCompatArgs(['--agent', 'ag_1', '--target', 'ver_new', ...argv])
  const result = await runCompat(args, env, serve({ report: served }))
  expect(result.ok).toBe(true)
  return exitCodeForCompat(result as CompatFleetResult)
}

// ---------------------------------------------------------------------------
// 1. Proven divergence blocks
// ---------------------------------------------------------------------------

describe('a PROVEN divergence is always a non-zero exit', () => {
  it('exits 10 on a proven divergence under the default threshold', async () => {
    expect(await exitCodeFor(report({ verdict: 'incompatible', proven: [proven] }))).toBe(COMPAT_EXIT_DIVERGENCE)
  })

  it('still exits 10 when the analysis was ALSO incomplete — 10 wins over 11', async () => {
    // A proof does not become less true because a different dimension went
    // unchecked. Downgrading this to "cannot tell" would let an incomplete
    // analysis hide a certainty, which is precisely backwards.
    const partialAndBroken = report({
      verdict: 'incompatible',
      proven: [proven],
      indeterminate: [unanswered],
      coverage: {
        assessed: ['model'],
        unassessed: [{ dimension: 'tools', reason: 'unsupported_config_shape' }],
        eventsExamined: 12,
        eventHistoryComplete: false,
      },
    })
    expect(await exitCodeFor(partialAndBroken)).toBe(COMPAT_EXIT_DIVERGENCE)
  })

  it('exits 10 on a fleet scan with any distinct proven reason', async () => {
    const broken = fleetReport({
      verdict: 'incompatible',
      provenReasons: [
        {
          reasonKey: 'tool_removed:search_web',
          kind: 'tool_removed',
          certainty: 'proven',
          affectedRunCount: 340,
          representativeRunIds: ['run_a', 'run_b'],
          exemplar: proven,
        },
      ],
      runsWithProvenDivergence: 340,
    })
    expect(await fleetExitCodeFor(broken)).toBe(COMPAT_EXIT_DIVERGENCE)
  })
})

// ---------------------------------------------------------------------------
// 2. Exit 0 is unreachable on an incomplete analysis
// ---------------------------------------------------------------------------

describe('exit 0 is unreachable on an incomplete analysis', () => {
  it('exits 11 when a dimension could not be assessed, even with zero findings', async () => {
    const partial = report({
      verdict: 'indeterminate',
      coverage: {
        assessed: ['model'],
        unassessed: [{ dimension: 'tools', reason: 'unsupported_config_shape' }],
        eventsExamined: 120,
        eventHistoryComplete: true,
      },
    })
    expect(await exitCodeFor(partial)).toBe(COMPAT_EXIT_INDETERMINATE)
  })

  it('exits 11 when the event history was truncated', async () => {
    const truncated = report({
      verdict: 'indeterminate',
      coverage: { ...report().coverage, eventHistoryComplete: false },
    })
    expect(await exitCodeFor(truncated)).toBe(COMPAT_EXIT_INDETERMINATE)
  })

  it('exits 11 on an UNANSWERED QUESTION under otherwise full coverage', async () => {
    // The reason the third band exists. Under a two-bucket contract this
    // finding would have been filed as speculative, and a full-coverage report
    // with only speculative findings exits 0 by default — a green build
    // produced by an engine that could not read the tool list.
    expect(await exitCodeFor(report({ verdict: 'indeterminate', indeterminate: [unanswered] }))).toBe(
      COMPAT_EXIT_INDETERMINATE
    )
  })

  it('exits 11 on a TRUNCATED fleet scan with no reasons found', async () => {
    const truncated = fleetReport({
      verdict: 'indeterminate',
      window: { runsScanned: 2000, runsAnalyzed: 2000, runsUnassessable: 0, runsSkippedForBudget: 0, scanTruncated: true, scanRowCeiling: 2000 },
    })
    expect(await fleetExitCodeFor(truncated)).toBe(COMPAT_EXIT_INDETERMINATE)
  })

  it('exits 11 when some runs could not be analysed — those runs are not runs that passed', async () => {
    const skipped = fleetReport({
      verdict: 'indeterminate',
      window: { runsScanned: 512, runsAnalyzed: 500, runsUnassessable: 12, runsSkippedForBudget: 0, scanTruncated: false },
    })
    expect(await fleetExitCodeFor(skipped)).toBe(COMPAT_EXIT_INDETERMINATE)
  })

  it('exits 0 only on a clean, COMPLETE analysis', async () => {
    expect(await exitCodeFor(report())).toBe(0)
    expect(await fleetExitCodeFor(fleetReport())).toBe(0)
  })

  it('exits 0 on speculative-only findings under the default threshold', async () => {
    // Deliberate. A gate that is red on every prompt edit is a gate that gets
    // switched off within a fortnight, taking the proven findings with it.
    expect(await exitCodeFor(report({ verdict: 'compatible_with_caveats', speculative: [speculative] }))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The threshold is explicit
// ---------------------------------------------------------------------------

describe('--fail-on is explicit, validated, and never guessed', () => {
  it('defaults to proven, and says so on the result', async () => {
    const args = parseCompatArgs(['run_1', '--target', 'ver_new'])
    const result = await runCompat(args, env, serve({ report: report() }))
    expect(result.ok).toBe(true)
    expect((result as CompatRunResult).failOn).toBe(DEFAULT_FAIL_ON)
    expect(DEFAULT_FAIL_ON).toBe('proven')
  })

  it('--fail-on any promotes speculative findings to a blocking exit', async () => {
    expect(
      await exitCodeFor(report({ verdict: 'compatible_with_caveats', speculative: [speculative] }), [
        '--fail-on',
        'any',
      ])
    ).toBe(COMPAT_EXIT_DIVERGENCE)
  })

  it('--fail-on none never blocks — including on an incomplete analysis, because it is not a gate', async () => {
    expect(await exitCodeFor(report({ verdict: 'incompatible', proven: [proven] }), ['--fail-on', 'none'])).toBe(0)
    expect(await exitCodeFor(report({ verdict: 'indeterminate', indeterminate: [unanswered] }), ['--fail-on', 'none'])).toBe(0)
  })

  it('rejects a typo instead of silently falling back to the default', async () => {
    // `--fail-on nay` must not quietly become `--fail-on proven`. The failure
    // is harmless today and catastrophic the day it happens to `any`.
    const args = parseCompatArgs(['run_1', '--target', 'ver_new', '--fail-on', 'nay'])
    const result = await runCompat(args, env, serve({ report: report() }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('--fail-on must be one of')
    }
  })
})

// ---------------------------------------------------------------------------
// Usage errors — never resolved silently one way
// ---------------------------------------------------------------------------

describe('mode and subject are never inferred', () => {
  it('refuses a missing --target rather than defaulting to "latest"', async () => {
    const result = await runCompat(parseCompatArgs(['run_1']), env, serve({ report: report() }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('--target')
    }
  })

  it('refuses both a runId and --agent', async () => {
    const result = await runCompat(
      parseCompatArgs(['run_1', '--agent', 'ag_1', '--target', 'ver_new']),
      env,
      serve({ report: report() })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(1)
  })

  it('refuses neither', async () => {
    const result = await runCompat(parseCompatArgs(['--target', 'ver_new']), env, serve({ report: report() }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(1)
  })

  it('refuses a fleet window flag in single-run mode instead of ignoring it', async () => {
    // Accepting and dropping `--since-days` would silently narrow nothing and
    // report a whole-run analysis as though a window had been applied.
    const result = await runCompat(
      parseCompatArgs(['run_1', '--target', 'ver_new', '--since-days', '7']),
      env,
      serve({ report: report() })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(1)
  })

  it('converts --since-days against an injected clock', async () => {
    const fetchImpl = serve({
      report: fleetReport({
        window: { since: 1_700_000_000_000 - 7 * 86_400_000, runsScanned: 5, runsAnalyzed: 5, runsUnassessable: 0, runsSkippedForBudget: 0, scanTruncated: false },
      }),
    })
    const args = parseCompatArgs(['--agent', 'ag_1', '--target', 'ver_new', '--since-days', '7'])
    const result = await runCompat(args, env, fetchImpl, 1_700_000_000_000)
    expect(result.ok).toBe(true)
    const url = new URL((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0])
    expect(url.searchParams.get('since')).toBe(String(1_700_000_000_000 - 7 * 86_400_000))
  })
})

// ---------------------------------------------------------------------------
// The refusals from the SDK arrive as a non-zero exit, never as a pass
// ---------------------------------------------------------------------------

describe('an unverifiable report never exits 0', () => {
  it('a server that ignored targetVersionId surfaces as exit 4, not a clean pass', async () => {
    // End-to-end: the reader refuses, the apiClient maps it to
    // `invalid_response` -> exit 4, and the command reports a failure. The
    // point is only that it is NOT 0 — a false clean must not be able to
    // reach a green build through any layer.
    const args = parseCompatArgs(['run_1', '--target', 'ver_new'])
    const result = await runCompat(args, env, serve({ report: report({ targetVersionId: 'ver_old' }) }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(4)
      expect(result.exitCode).not.toBe(0)
      expect(result.message).toContain('ignored the parameter')
    }
  })
})
