/**
 * TOKEN BUDGETS + SHAPE GUARDS for `packages/mcp` — the `afr_*` MCP tool tier.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The MCP server's entire design premise is PROGRESSIVE DISCLOSURE: a 50-step
 * agent run dumped raw is 100k+ tokens and useless, so the tools are tiered
 * such that an agent spends ~250 tokens learning WHAT is broken and only pays
 * for a full trace if it genuinely needs one.
 *
 * Nothing in the type system protects that. `FailurePattern` (packages/
 * contracts/src/failure_patterns.ts) has ~25 fields; `toPatternRow` projects 7
 * of them. A future well-meaning "just also return representativeRunIds, it's
 * only an array of ids" is a one-line change that type-checks, passes every
 * existing test, and silently destroys the product's core claim. Response SIZE
 * is the value proposition, so response SIZE is what gets asserted here.
 *
 * These tests drive the REAL exported projections in
 * `packages/mcp/src/projections.ts` — `toListPatternsResult`,
 * `toPatternEvidenceResult`, `toExplainRunResult`, `toEventRow`, `toRunRow` —
 * against deliberately FAT inputs. Fat inputs are the point: a projection is
 * only proven lean if the thing it projected from was not.
 *
 * BUDGETS AND ESTIMATOR ARE NOT DECLARED HERE
 * -------------------------------------------
 * Both come from `./mcp_budgets.ts`, which is the ONE place every mcp suite
 * reads them from. They used to be declared here AND in `mcp_triage.test.ts`
 * AND in `mcp_triage_measure.test.ts` AND in `mcp_triage_next_hops.test.ts` —
 * four estimators and the literal `450` in three files — which is exactly the
 * arrangement in which two suites assert "the same" budget and slowly stop
 * agreeing. See that file's header for the estimator's stated assumption and
 * for each budget's derivation.
 */
import {
  ORDERING_UNVERIFIED_BASIS,
  TRANSITIONS_CAP,
  budgetEventRows,
  toEventRow,
  toExplainRunResult,
  toListPatternsResult,
  toPatternEvidenceResult,
  toRunRow,
} from '@agent-flight-recorder/mcp'
import { describe, expect, it } from 'vitest'

import {
  ORDERING_BASIS_TOKEN_COST,
  PAYLOAD_EXTERNALIZATION_THRESHOLD,
  RAW_DUMP_TOKENS,
  TIER1_PATTERN_COUNT,
  TIER1_TOKEN_BUDGET,
  TIER2_TOKEN_BUDGET,
  TIER3_TOKEN_BUDGET,
  ROOT_CAUSE_BYTE_CAP,
  SUGGESTED_FIX_BYTE_CAP,
  SUMMARY_BYTE_CAP,
  TIER4_WINDOW_TOKEN_BUDGET,
  TRUNCATION_NOTE,
  WINDOW_PAYLOAD_BYTE_BUDGET,
  attributeColumnBytes,
  attributeRowBytes,
  attributeTopLevelBytes,
  byteLength,
  estimateTokens,
  externalizedEvent,
  fatPattern,
  fatRun,
  findForbiddenPaths,
  nearThresholdEvent,
  unkeyedDerivedEvent,
} from './mcp_budgets.js'

import type {
  Event,
  PatternResolutionEvidence,
  RunExplanation,
} from '@agent-flight-recorder/contracts'
import type { V1ListFixConfidenceEnvelope } from '@agent-flight-recorder/sdk'

// ---------------------------------------------------------------------------
// Module seam
// ---------------------------------------------------------------------------

/**
 * A REAL, TYPE-CHECKED IMPORT of the module under test.
 *
 * This file used to reach `packages/mcp` through a NON-LITERAL relative
 * specifier (`await import(/* @vite-ignore *\/ '../../packages/mcp/src/…')`)
 * plus a hand-written `interface Projections` shadowing the module's exports,
 * on the stated grounds that "`packages/mcp` is not a workspace dependency of
 * `@agent-flight-recorder/tests` and has no alias in tests/vitest.config.ts".
 *
 * BOTH HALVES OF THAT ARE NOW FALSE — `"@agent-flight-recorder/mcp":
 * "workspace:*"` is in tests/package.json and the `resolve.alias` entry is in
 * tests/vitest.config.ts. The follow-up the comment asked for was done and
 * nobody came back to collapse the seam.
 *
 * Collapsing it is not tidying, it is coverage. The shadow interfaces were a
 * silent drift surface of exactly the kind this suite exists to catch: this
 * file declared `toListPatternsResult(patterns, envelope, nextCursor)` with
 * THREE parameters while `mcp_triage_next_hops.test.ts` declared the same
 * function with FOUR — and the real one takes four. The `scanTruncated`
 * argument was simply unreachable from here. A shadow type also weakened
 * `envelope` to `unknown`, which is why the fixture below silently omitted
 * half of `V1ListFixConfidenceEnvelope`.
 */

/**
 * Tier 4's hard cap. `packages/mcp/src/tools/**` is not re-exported from the
 * package root, and CLAUDE.md § Imports forbids a relative specifier that
 * escapes a package root, so this one stays a non-literal dynamic import.
 *
 * READ FROM THE TOOL MODULE, NEVER DUPLICATED: if `MAX_LIMIT` is raised there,
 * the window budgets below re-measure at the NEW cap and fail — which is
 * exactly the regression that should not pass silently.
 */
const GET_RUN_EVENTS_SPEC = '../../packages/mcp/src/tools/get-run-events.ts'
const { MAX_LIMIT: TIER4_MAX_LIMIT } = (await import(/* @vite-ignore */ GET_RUN_EVENTS_SPEC)) as {
  MAX_LIMIT: number
}

// ---------------------------------------------------------------------------
// FAT inputs — SHARED, not re-declared here
// ---------------------------------------------------------------------------
//
// `fatPattern`, `fatRun`, `externalizedEvent` and `nearThresholdEvent` are
// imported from `./mcp_budgets.js`, which is the single declaration of the
// contract-maximal fixture family and the only copy `checkMaximality` proves
// saturated. This file used to carry its own, and the copies did not stay
// equal — for the SAME tool on the SAME scenario the budget script measured 294
// where this suite measured 284. Ten tokens of tier-1 headroom that never
// existed, invisible because each family was correct on its own terms.
//
// The OTel iteration made that worse rather than better: the local copies
// predated `Run.otelTraceId`/`otelRoot`/`otelRootStartNano`/`otelLastAppendAt`
// and `Event.temporalOrder`, so they under-stated the contract by five fields
// and nothing here could say so — `checkMaximality` only ever inspected the
// shared family.

const FAT_PATTERNS = Array.from({ length: TIER1_PATTERN_COUNT }, (_, i) => fatPattern(i))

/**
 * A CONTRACT-COMPLETE `V1ListFixConfidenceEnvelope`.
 *
 * It was not complete before: `stalenessBoundMs`, `staleCount` and each entry's
 * `score`/`computedAt`/`ageMs`/`basis` were all missing, and the seam's
 * `envelope: unknown` shadow type meant nothing said so. A fat-input suite
 * whose input is not actually fat is measuring the easy case — the tier-1
 * budget is only evidence about a projection if the projection had something to
 * throw away.
 */
const CONFIDENCE_ENVELOPE: V1ListFixConfidenceEnvelope = {
  stalenessBoundMs: 6 * 60 * 60 * 1000,
  entries: FAT_PATTERNS.map((p, i) => ({
    fingerprintHash: p.fingerprintHash,
    state: (['unproven', 'proving', 'confirmed', 'regressed'] as const)[i % 4]!,
    score: 0.71,
    computedAt: 1_753_395_000_000,
    ageMs: 2 * 60 * 60 * 1000,
    stale: false,
    basis: 'snapshot',
  })),
  staleCount: 0,
  unevaluated: [],
}

// ---------------------------------------------------------------------------
// Tier 1 — afr_list_failure_patterns
// ---------------------------------------------------------------------------

describe('tier 1 (afr_list_failure_patterns) — token budget', () => {
  const result = toListPatternsResult(FAT_PATTERNS, CONFIDENCE_ENVELOPE, 'cursor_9f2a')

  it(`returns ${TIER1_PATTERN_COUNT} patterns within ~${TIER1_TOKEN_BUDGET} tokens`, () => {
    const tokens = estimateTokens(result)
    const inputTokens = estimateTokens(FAT_PATTERNS)

    expect(
      tokens,
      `TIER 1 OVER BUDGET: ~${tokens} tokens for ${TIER1_PATTERN_COUNT} patterns ` +
        `(budget ${TIER1_TOKEN_BUDGET}, ~${Math.ceil(tokens / TIER1_PATTERN_COUNT)} tok/row).\n` +
        `The un-projected rollups were ~${inputTokens} tokens, so the projection is ` +
        `saving ${(100 - (tokens / inputTokens) * 100).toFixed(0)}%.\n\n` +
        `Cost per column, biggest first (names paid once, values per row):\n\n${attributeColumnBytes(result.fields, result.rows)}\n\n` +
        `"~250 tokens to learn what is broken" is this product's core claim. A ` +
        `field added here is paid for on every row of every call.`
    ).toBeLessThanOrEqual(TIER1_TOKEN_BUDGET)
  })

  it(`stays within ~${TIER1_TOKEN_BUDGET} tokens WITH the scanTruncated marker set`, () => {
    /**
     * THE SAME BUDGET, ON THE MORE EXPENSIVE OF THE TWO SHAPES.
     *
     * `mcp_triage_next_hops.test.ts` used to assert `<= 300` here too, but on a
     * THIN hand-written pattern rather than the contract-maximal fixture: it
     * measured 217 where this fixture measures 284, so it carried ~67 tokens of
     * headroom that does not exist and would have stayed green through a
     * widening this assertion catches. Two places asserting one budget with two
     * fixtures, disagreeing exactly as predicted.
     *
     * The absolute now lives here, once, on the fat fixture. That file keeps
     * the part it is actually about: the marker's DELTA.
     *
     * This case was unreachable from this file before — the hand-written seam
     * shadow declared `toListPatternsResult` with three parameters and the
     * `scan` argument is the fourth.
     */
    const truncated = toListPatternsResult(FAT_PATTERNS, CONFIDENCE_ENVELOPE, 'cursor_9f2a', {
      scanTruncated: true,
    })
    expect(truncated.scanTruncated, 'the marker under measurement was not even emitted').toBe(true)
    const tokens = estimateTokens(truncated)
    expect(
      tokens,
      `TIER 1 OVER BUDGET with the truncation marker: ~${tokens} tokens ` +
        `(budget ${TIER1_TOKEN_BUDGET}).\n` +
        `Cost per column, biggest first:\n\n${attributeColumnBytes(truncated.fields, truncated.rows)}`,
    ).toBeLessThanOrEqual(TIER1_TOKEN_BUDGET)
  })

  it('costs far less than returning the rollups unprojected', () => {
    // Guards the projection's REASON for existing, independently of the
    // absolute budget above. If someone widens the row until it approaches the
    // raw rollup, tier 1 has stopped being a tier. Deliberately a loose bar —
    // the absolute budget is the sharp assertion; this one only has to catch a
    // projection that has stopped projecting.
    const ratio = estimateTokens(FAT_PATTERNS) / estimateTokens(result)
    expect(
      ratio,
      `tier 1 only saves ${ratio.toFixed(1)}x over returning the raw rollups — the ` +
        `projection is barely projecting.`
    ).toBeGreaterThanOrEqual(5)
  })
})

describe('tier 1 (afr_list_failure_patterns) — shape guard', () => {
  const result = toListPatternsResult(FAT_PATTERNS, CONFIDENCE_ENVELOPE, 'cursor_9f2a')

  /**
   * ABSENCE IS THE INVARIANT. A presence test ("it has a fingerprintHash")
   * stays green forever while someone bolts `representativeRunIds` onto the
   * row. Only an exact-key-set assertion plus an explicit forbidden-key sweep
   * catches that, so both are here.
   */
  const TIER1_ALLOWED_KEYS = [
    'fingerprintHash',
    'class',
    'label',
    'count',
    'lastSeenAt',
    'status',
    'confidenceState',
    'confidenceStale',
  ]

  /**
   * Every one of these is a real field on the FAT input above — so this sweep
   * genuinely could fire. A forbidden-key list naming fields the input never
   * had would be theatre.
   */
  const TIER1_FORBIDDEN_KEYS = [
    'representativeRunIds',
    'recentOccurrences',
    'occurrences',
    'trend',
    'lastSpikeAssessment',
    'baselineMean',
    'z',
    'recentCount',
    'isSpiking',
    'resolution',
    'exposure',
    'confidence',
    'transitions',
    'resolutionNote',
    'resolutionRef',
    'affectedAgentVersionIds',
    'affectedAgentIds',
    'salientKey',
    'lastFixConfidence',
    'events',
    'payload',
    'summary',
    'rootCause',
    'orgId',
  ] as const

  it('exposes only the contract fields per pattern — no more', () => {
    // Columnar: the field list is declared ONCE in `fields`, so this guard
    // reads the header rather than every row's keys. That is also why the
    // encoding is cheaper — the names are not repeated per row.
    const extra = result.fields.filter((k) => !TIER1_ALLOWED_KEYS.includes(k as string))
    expect(
      extra,
      `a tier-1 column grew ${JSON.stringify(extra)}. Every added column is paid for ` +
        `${TIER1_PATTERN_COUNT}x per call and staying near ~284 tokens is the entire ` +
        `premise of this tool.`
    ).toEqual([])
    // Rows must stay positional and aligned with the header, or a reader
    // silently misattributes values to the wrong field.
    for (const row of result.rows) {
      expect(row.length).toBe(result.fields.length)
    }
  })

  it('contains no representative runs, no event payloads, and no spike detail', () => {
    const hits = findForbiddenPaths(result, TIER1_FORBIDDEN_KEYS)
    expect(
      hits,
      `tier 1 leaked tier-2/3/4 detail at:\n${hits.map((h) => '    ' + h).join('\n')}\n\n` +
        `Spike detail, representative runs, and resolution evidence belong to\n` +
        `afr_get_pattern_evidence. An agent must be able to learn WHAT is broken\n` +
        `without paying for WHY.`
    ).toEqual([])
  })

  it('leaks no run id from representativeRunIds anywhere in the serialized response', () => {
    // Belt-and-braces on the same invariant, by VALUE rather than by key —
    // catches a rename (`representativeRunIds` -> `runs`) that a key-name sweep
    // would miss entirely.
    const serialized = JSON.stringify(result)
    for (const runId of FAT_PATTERNS[0]!.representativeRunIds) {
      expect(serialized, `representative run "${runId}" reached the tier-1 response`).not.toContain(runId)
    }
  })

  it('does not leak the org id of the caller into every row', () => {
    expect(JSON.stringify(result)).not.toContain('org_caller')
  })
})

// ---------------------------------------------------------------------------
// Tier 2 — afr_get_pattern_evidence
// ---------------------------------------------------------------------------

/** 100 transitions — the maximum `PatternResolutionEvidence` permits. */
const FAT_EVIDENCE: PatternResolutionEvidence = {
  pattern: fatPattern(0),
  resolution: {
    resolvedAt: 1_753_100_000_000,
    resolvedByUserId: 'user_2f9',
    resolutionNote: 'Added retry with jitter on 429 from the provider.',
    resolutionRef: 'https://github.com/acme/agent/pull/812',
    resolvedInVersionId: 'ver_7c1',
    resolvedInVersion: '2026.7.3',
    resolvedAtOccurrenceCount: 41,
    resolvedAtRunCount: 1204,
  },
  exposure: {
    since: 1_753_100_000_000,
    runCount: 1802,
    runCountTruncated: false,
    recurrenceCount: 0,
    baselineRunCount: 1204,
    agentIds: ['agent_a1', 'agent_b2'],
    heldSoFar: true,
  },
  confidence: {
    score: 0.71,
    state: 'proving',
    exposureRuns: 1802,
    observedRuns: 1900,
    versionAttribution: 'matched',
    elapsedMs: 302_400_000,
    recurred: false,
    hasResolution: true,
    exposureMeasured: true,
    exposureCredit: 0.9,
    soakCredit: 0.5,
    limitingFactor: 'accumulating',
  },
  transitions: Array.from({ length: 100 }, (_, i) => ({
    action: i % 2 === 0 ? 'failure_pattern.acknowledged' : 'failure_pattern.resolved',
    actorClerkUserId: 'user_2f9',
    timestamp: 1_753_000_000_000 + i * 60_000,
    // Unbounded by contract — the single most dangerous field in this payload.
    metadata: { note: 'x'.repeat(400), previousStatus: 'open', requestId: 'req_' + String(i) },
  })),
}

describe('tier 2 (afr_get_pattern_evidence) — token budget', () => {
  const result = toPatternEvidenceResult(FAT_EVIDENCE)

  it(`fits within ~${TIER2_TOKEN_BUDGET} tokens with 100 inbound transitions`, () => {
    const tokens = estimateTokens(result)
    const breakdown = attributeTopLevelBytes(result as unknown as Record<string, unknown>)

    expect(
      tokens,
      `TIER 2 OVER BUDGET: ~${tokens} tokens (budget ${TIER2_TOKEN_BUDGET}).\n` +
        `Cost by top-level field, biggest first:\n\n${breakdown}\n\n` +
        `\`transitions\` is the usual culprit: PatternResolutionEvidence bounds it ` +
        `at 100, which is a UI bound, not an MCP bound.`
    ).toBeLessThanOrEqual(TIER2_TOKEN_BUDGET)
  })

  it('caps transitions and says so, rather than silently truncating', () => {
    const transitions = result.transitions as unknown[]
    expect(transitions.length).toBeLessThanOrEqual(TRANSITIONS_CAP)
    expect(
      result.transitionsTruncated,
      'history was truncated without telling the caller — a partial history read as ' +
        'complete is how "this pattern was never acknowledged" gets concluded from a ' +
        'window that simply did not reach back that far.'
    ).toBe(true)
  })

  it('drops the unbounded transition metadata bag', () => {
    // `metadata: unknown` on PatternLifecycleTransition is caller-influenced
    // and has no size bound at all. 100 x 400 bytes of it would be ~10k tokens
    // on its own.
    const hits = findForbiddenPaths(result, ['metadata'])
    expect(hits, `unbounded transition metadata reached tier 2 at:\n${hits.join('\n')}`).toEqual([])
    expect(JSON.stringify(result)).not.toContain('x'.repeat(50))
  })

  it('carries every confidence driver, not a bare score', () => {
    /**
     * The one PRESENCE assertion in this file that earns its place. The whole
     * point of shipping `confidence` is that an engineer can read "0.71 because
     * 1802 runs, no recurrence, matching version" instead of trusting a number.
     * Dropping the drivers to save tokens would be a false economy — and the
     * budget test above would happily go GREENER for it, which is precisely why
     * a budget test needs this counterweight.
     */
    const confidence = result.confidence as Record<string, unknown>
    for (const driver of [
      'score',
      'state',
      'exposureRuns',
      'observedRuns',
      'elapsedMs',
      'recurred',
      'exposureCredit',
      'soakCredit',
      'limitingFactor',
      'versionAttribution',
    ]) {
      expect(confidence, `confidence driver "${driver}" was dropped`).toHaveProperty(driver)
    }
  })

  it('does not inline the pattern detail that belongs a tier down', () => {
    const hits = findForbiddenPaths(result, [
      'trend',
      'recentOccurrences',
      'events',
      'payload',
      'representativeRunIds',
      'affectedAgentVersionIds',
      'lastSpikeAssessment',
    ])
    expect(hits, `tier 2 inlined tier-1/tier-4 detail at:\n${hits.join('\n')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tier 3 — afr_explain_run
// ---------------------------------------------------------------------------

/**
 * The largest explanation the contract permits: 2 KB + 1 KB + 1 KB of prose,
 * AND the maximum 20 cited sequence numbers.
 *
 * IT USED TO CITE FIVE, and that was not a detail. `RunExplanation` bounds
 * `citedSequenceNumbers` at 20 (packages/contracts/src/run_explanations.ts) and
 * `toExplainRunResult` forwards the array VERBATIM — it caps the three prose
 * fields and nothing else. At 5 citations this fixture measures 192 and the
 * old absolute assertion below passed; at the contract's real maximum of 20 it
 * measures 203, over the 200 ceiling.
 *
 * So a test whose whole stated purpose was "assert the layer enforces its own
 * bound rather than trusting an upstream one it does not control" was itself
 * trusting an upstream bound it did not control, and had been green over a real
 * breach. `scripts/check-token-budgets.ts` found it, which is the argument for
 * that script existing: its `checkMaximality` proves a fixture saturates its
 * contract instead of asserting in a comment that it does.
 */
const CONTRACT_MAX_EXPLANATION: RunExplanation = {
  id: 'expl_1',
  orgId: 'org_caller',
  runId: 'run_8f2c1a',
  kind: 'llm',
  summary: 'S'.repeat(2048),
  rootCause: 'R'.repeat(1024),
  suggestedFix: 'F'.repeat(1024),
  citedSequenceNumbers: Array.from({ length: 20 }, (_, i) => i * 3 + 1),
  failureClass: 'tool_error',
  generatedAt: 1_753_400_000_000,
  model: 'claude-opus-5',
  generationMs: 1840,
  version: 1,
}

const REALISTIC_EXPLANATION: RunExplanation = {
  ...CONTRACT_MAX_EXPLANATION,
  summary:
    'The agent called the "search" tool three times; the third call returned HTTP 429 and the agent did not retry, so the run failed without producing an answer.',
  rootCause: 'Upstream search provider rate-limited the agent and no backoff was configured.',
  suggestedFix: 'Add exponential backoff with jitter to the search tool client.',
}

describe('tier 3 (afr_explain_run) — token budget', () => {
  it(`fits within ~${TIER3_TOKEN_BUDGET} tokens for a realistic explanation`, () => {
    const result = toExplainRunResult('run_8f2c1a', 'ready', REALISTIC_EXPLANATION, 'failed')
    const tokens = estimateTokens(result)
    expect(
      tokens,
      `TIER 3 OVER BUDGET: ~${tokens} tokens (budget ${TIER3_TOKEN_BUDGET}).\n` +
        `  summary:      ${byteLength(REALISTIC_EXPLANATION.summary)} B\n` +
        `  rootCause:    ${byteLength(REALISTIC_EXPLANATION.rootCause)} B\n` +
        `  suggestedFix: ${byteLength(REALISTIC_EXPLANATION.suggestedFix ?? '')} B`
    ).toBeLessThanOrEqual(TIER3_TOKEN_BUDGET)
  })

  it('BOUNDS the prose a contract-maximal explanation can carry', () => {
    /**
     * `RunExplanation` caps summary at 2 KB and rootCause/suggestedFix at 1 KB
     * each. 4 KB of prose is ~1000 tokens — five times this tier's budget. This
     * asserts the layer enforces its own bound on the PROSE rather than
     * trusting an upstream one it does not control.
     *
     * WHY THIS IS NOW A PROSE ASSERTION AND NOT AN ABSOLUTE.
     *
     * It used to assert `estimateTokens(result) <= 200` on this fixture, and it
     * passed at 192 — but only because the fixture cited 5 sequence numbers
     * where the contract permits 20. Truly maximal, the same projection costs
     * 203. The absolute was green over a live breach.
     *
     * The absolute now lives in `scripts/check-token-budgets.ts`, which measures
     * this exact scenario ("contract-maximal explanation") on a fixture it
     * PROVES maximal, reports the 203/200 breach, freezes it so it may only
     * fall, and blocks on one token more. Restating a weaker copy of that
     * ceiling here would put the repo straight back into two-places-one-budget —
     * with the test being the one that lies, which is how it got here.
     *
     * What stays here is what a CI script cannot express: that the projection's
     * own prose caps do the cutting.
     */
    const result = toExplainRunResult('run_8f2c1a', 'ready', CONTRACT_MAX_EXPLANATION, 'failed')
    for (const [field, cap] of [
      ['summary', SUMMARY_BYTE_CAP],
      ['rootCause', ROOT_CAUSE_BYTE_CAP],
      ['suggestedFix', SUGGESTED_FIX_BYTE_CAP],
    ] as const) {
      const kept = String(result[field]).split('…[truncated,')[0] ?? ''
      expect(
        byteLength(kept),
        `tier 3 forwarded ${field} beyond its ${String(cap)} B cap. toExplainRunResult must not ` +
          `rely on real explanations happening to be short — that is a property of the ` +
          `generator, not a guarantee of this layer.`,
      ).toBeLessThanOrEqual(cap)
    }
    // And the whole projection stays the same order of magnitude as its budget,
    // rather than the ~1000 tokens the raw contract maximum would cost.
    expect(estimateTokens(result)).toBeLessThan(TIER3_TOKEN_BUDGET * 2)
  })

  it('SAYS it truncated the prose, rather than silently returning a cut-off summary', () => {
    /**
     * THE COUNTERWEIGHT TO THE BUDGET TEST ABOVE.
     *
     * The contract-maximal test only asserts a NUMBER. The cheapest way to make
     * that number go green is to chop the prose at `SUMMARY_BYTE_CAP` and say
     * nothing — which reads to an agent as a complete root-cause analysis that
     * happens to stop mid-sentence, and is a worse failure than being over
     * budget. `truncateProse` emits an in-band `…[truncated, N more chars]`
     * marker; nothing in this file asserted that it survives the projection.
     *
     * `mcp_triage.test.ts` asserts the same marker on triage's label cap. This
     * is the tier-3 half of the same invariant, and the marker text is read
     * from ONE implementation (`truncateProse`, in the SDK) by both.
     */
    const result = toExplainRunResult('run_8f2c1a', 'ready', CONTRACT_MAX_EXPLANATION, 'failed')
    for (const field of ['summary', 'rootCause', 'suggestedFix'] as const) {
      const value = result[field]
      expect(typeof value, `${field} was dropped entirely`).toBe('string')
      expect(
        String(value),
        `tier 3 cut ${field} to fit its budget without telling the caller. A summary ` +
          `that stops mid-sentence with no marker is read as a complete answer.`,
      ).toContain('…[truncated,')
    }
  })

  it('leaves a realistic explanation completely untouched', () => {
    // The other half: a cap set below realistic output would silently degrade
    // every ordinary answer to buy headroom on a case that never happens.
    const result = toExplainRunResult('run_8f2c1a', 'ready', REALISTIC_EXPLANATION, 'failed')
    expect(result.summary).toBe(REALISTIC_EXPLANATION.summary)
    expect(result.rootCause).toBe(REALISTIC_EXPLANATION.rootCause)
    expect(result.suggestedFix).toBe(REALISTIC_EXPLANATION.suggestedFix)
  })

  it('returns representative SEQUENCE NUMBERS, never the events themselves', () => {
    // The entire economic argument for tier 3 is that it hands back POINTERS
    // into the event log so the agent can decide whether tier 4 is worth it.
    // Inlining the cited events would collapse tiers 3 and 4 into one call.
    const result = toExplainRunResult('run_8f2c1a', 'ready', REALISTIC_EXPLANATION, 'failed')
    const cited = result.citedSequenceNumbers as unknown[]
    expect(Array.isArray(cited)).toBe(true)
    for (const seq of cited) {
      expect(typeof seq, 'cited entries must be bare sequence numbers, not event objects').toBe('number')
    }
    expect(findForbiddenPaths(result, ['events', 'payload', 'citedEvents', 'eventPayloads'])).toEqual([])
  })

  it('keeps the not_eligible / pending discriminant instead of a coarse null', () => {
    // Not a size assertion, but the reason tier 3 is CHEAP to call: a caller
    // that can tell "will never have an explanation" from "not generated yet"
    // stops instead of retrying, and a retry loop is the most expensive thing
    // an agent can do on this surface.
    const notEligible = toExplainRunResult('run_x', 'not_eligible', null, 'completed')
    const pending = toExplainRunResult('run_y', 'pending', null, 'failed')
    expect(notEligible.status).toBe('not_eligible')
    expect(pending.status).toBe('pending')
    expect(notEligible.status).not.toBe(pending.status)
  })
})

// ---------------------------------------------------------------------------
// Tier 4 — afr_get_run_events
// ---------------------------------------------------------------------------

describe('tier 4 (afr_get_run_events) — externalized payloads', () => {
  it('NEVER inlines an externalized payload — pointer and checksum only', () => {
    /**
     * CLAUDE.md Event Log Rule 3: payloads over 10 KB are externalized and the
     * event stores an ArtifactPointer. Re-inlining one here would put a 10 KB+
     * blob into a context window to answer a question the pointer already
     * answers.
     */
    const row = toEventRow(externalizedEvent(24))
    expect(row.payload, 'an externalized payload was inlined').toBeUndefined()
    expect(row.artifact).toBeDefined()
    expect(Object.keys(row.artifact ?? {}).sort()).toEqual(
      ['artifactId', 'checksum', 'size', 'storageBucket', 'storageKey'].sort()
    )
    // A checksum that is not verifiable is decoration.
    expect(String(row.artifact?.checksum)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(estimateTokens(row)).toBeLessThan(100)
  })
})

describe('tier 4 (afr_get_run_events) — window is bounded and hard-capped', () => {
  it('caps the window at MAX_LIMIT events, whatever the run length', () => {
    // Cost must be O(window), not O(run). MAX_LIMIT is read from the tool
    // module, so raising it there re-measures the budget below at the new cap.
    expect(TIER4_MAX_LIMIT).toBeGreaterThan(0)
    expect(
      TIER4_MAX_LIMIT,
      `MAX_LIMIT is ${TIER4_MAX_LIMIT}. A window that large stops being a window — ` +
        `tier 4 exists so a caller who arrived via afr_explain_run fetches the handful ` +
        `of events that matter, not a page of the log.`
    ).toBeLessThanOrEqual(50)
  })

  it(`a saturated window of externalized events stays under ${TIER4_WINDOW_TOKEN_BUDGET} tokens`, () => {
    const rows = Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => toEventRow(externalizedEvent(18 + i)))
    const window = { runId: 'run_8f2c1a', fromSequence: 18, events: rows, nextFromSequence: 18 + TIER4_MAX_LIMIT }
    const tokens = estimateTokens(window)
    expect(
      tokens,
      `TIER 4 OVER BUDGET at the ${TIER4_MAX_LIMIT}-event cap: ~${tokens} tokens ` +
        `(budget ${TIER4_WINDOW_TOKEN_BUDGET}, ~${Math.ceil(tokens / TIER4_MAX_LIMIT)} tok/event).\n` +
        `Cost per event field, biggest first:\n\n${attributeRowBytes(rows as unknown as Array<Record<string, unknown>>)}`
    ).toBeLessThanOrEqual(TIER4_WINDOW_TOKEN_BUDGET)
  })

  it('a saturated window of NON-externalized payloads is also bounded', () => {
    /**
     * THE HOLE THIS TEST EXISTS FOR.
     *
     * `toEventRow` enforces "never inline an artifact payload" only for
     * payloads that were EXTERNALIZED — i.e. those over 10 KB. A payload of
     * 10 239 bytes is under the threshold, is never externalized, and would be
     * assigned straight through.
     *
     * At the 50-event cap that is 50 x ~10 KB = ~500 KB in a single tool
     * result: roughly 125 000 tokens, MORE than the 100k raw dump this entire
     * package exists to prevent. The cap on the number of EVENTS is not a cap
     * on the number of BYTES, and only the second one is what an agent pays for.
     *
     * IT IS `budgetEventRows` THAT CLOSES THIS, NOT `toEventRow`, AND THAT IS
     * WHY THIS TEST CALLS IT. See the test below for what this file used to be
     * measuring instead.
     */
    const { rows } = budgetEventRows(Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => nearThresholdEvent(18 + i)))
    const window = { runId: 'run_8f2c1a', fromSequence: 18, events: rows }
    const tokens = estimateTokens(window)

    expect(
      tokens,
      `TIER 4 IS UNBOUNDED IN BYTES: ~${tokens} tokens for ${TIER4_MAX_LIMIT} events ` +
        `(budget ${TIER4_WINDOW_TOKEN_BUDGET}), ~${Math.ceil(tokens / TIER4_MAX_LIMIT)} tok/event.\n\n` +
        `Every payload here is ${PAYLOAD_EXTERNALIZATION_THRESHOLD - 200} B — just UNDER the 10 KB\n` +
        `externalization threshold, so none of them is an artifact.\n\n` +
        `MAX_LIMIT caps EVENTS, not BYTES, and bytes are what the agent pays for.\n` +
        `A single saturated window can cost more than the ~${RAW_DUMP_TOKENS}-token raw dump\n` +
        `this package exists to prevent.\n\n` +
        `Fix: budget payload bytes — truncate with an explicit marker, or return a\n` +
        `pointer for anything over a few hundred bytes.`
    ).toBeLessThanOrEqual(TIER4_WINDOW_TOKEN_BUDGET)
  })

  /**
   * THE ASSERTION THIS FILE WAS MISSING, AND THE ONE IT THOUGHT IT HAD.
   *
   * Every tier-4 budget test above used to call `toEventRow` directly and build
   * the window itself. `afr_get_run_events` does not: it calls
   * `budgetEventRows(window.events)` and emits `truncationNote` when that
   * reports a cut (packages/mcp/src/tools/get-run-events.ts). NOTHING IN
   * `tests/` REFERENCED `budgetEventRows`, `WINDOW_PAYLOAD_BYTE_BUDGET` OR
   * `TRUNCATION_NOTE` AT ALL.
   *
   * So the whole-window byte budget — the only thing that stops 50 x 400 B of
   * previews compounding to 20 KB — was asserted nowhere, and the suite looked
   * like it covered tier 4 because it measured the per-event-capped path and
   * passed comfortably under a 10 000-token ceiling. Deleting `budgetEventRows`
   * from the tool would have left every test in this file green.
   *
   * That is the exact bug class this project keeps paying for: a budget that
   * stops being asserted anywhere because each side assumed the other had it.
   */
  it('spends the WHOLE-WINDOW byte budget, not just the per-event cap', () => {
    const events = Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => nearThresholdEvent(18 + i))
    const { rows } = budgetEventRows(events)

    /**
     * The budget is spent on the payloads that are KEPT. Once it is exhausted
     * the remaining rows carry a bare `{truncated, bytes, preview: ''}` marker,
     * and those markers are emitted OUTSIDE the accounting — measured, they add
     * ~1.2 KB across a saturated 50-event window on top of the 8 KB budget.
     *
     * That is bounded by MAX_LIMIT and small, so it is not a defect; it is
     * written down here because the obvious assertion ("total payload bytes <=
     * WINDOW_PAYLOAD_BYTE_BUDGET") is FALSE and the next person to write it will
     * otherwise conclude the budget is broken. The invariant that does hold is
     * on the kept bytes.
     */
    const isDropMarker = (p: unknown): boolean =>
      typeof p === 'object' && p !== null && 'preview' in p && (p as { preview: unknown }).preview === ''
    const keptBytes = rows.reduce(
      (sum, row) =>
        sum + (row.payload === undefined || isDropMarker(row.payload) ? 0 : byteLength(JSON.stringify(row.payload) ?? '')),
      0,
    )
    expect(
      keptBytes,
      `kept inline payload bytes across one window: ${keptBytes} B, over the ` +
        `${WINDOW_PAYLOAD_BYTE_BUDGET} B whole-window budget. The per-event cap alone ` +
        `still multiplies — ${TIER4_MAX_LIMIT} events x the per-event cap is what this ` +
        `second budget exists to stop.`,
    ).toBeLessThanOrEqual(WINDOW_PAYLOAD_BYTE_BUDGET)

    /**
     * Unbudgeted — per-event cap only, no whole-window budget — the same window
     * carries far more payload. Asserting the gap is what proves the second
     * budget is doing work rather than being trivially satisfied.
     *
     * MEASURED ON PAYLOAD BYTES, NOT ON THE WHOLE SERIALIZED WINDOW, and the
     * distinction is not pedantry. Whole-window budgeting can only ever remove
     * PAYLOAD; the rest of a row (`sequenceNumber`, `type`, `timestamp`, and the
     * unconditional `derived`/`derivedLossy` badge) is incompressible
     * scaffolding that both sides pay identically. A ratio taken over the whole
     * serialized window therefore drifts toward 1 every time a row grows a
     * NON-payload field, and says nothing about whether budgeting still works:
     * it fell from ~2.03x to ~1.90x — through the `< /2` line — the moment the
     * shared fixtures started carrying provenance, purely because every row
     * gained a ~38 B derived badge on both sides of the comparison.
     */
    const payloadBytes = (rs: readonly { payload?: unknown }[]): number =>
      rs.reduce((sum, row) => sum + (row.payload === undefined ? 0 : byteLength(JSON.stringify(row.payload) ?? '')), 0)
    const unbudgeted = payloadBytes(events.map((e) => toEventRow(e)))
    const budgeted = payloadBytes(rows)
    expect(
      budgeted,
      `budgeting saved nothing: ${unbudgeted} B of inline payload with the per-event cap alone, ` +
        `${budgeted} B with the whole-window budget as well.`,
    ).toBeLessThan(unbudgeted / 2)
  })

  it('SAYS it truncated, rather than handing back a short window as a whole one', () => {
    // A caller that is not told its result was trimmed reads a partial payload
    // as a complete one — the same reassuring-empty-state failure `scanTruncated`
    // exists to prevent on tier 1, one tier down.
    const { truncated } = budgetEventRows(Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => nearThresholdEvent(18 + i)))
    expect(truncated, 'the window was cut and did not say so').toBe(true)
    expect(TRUNCATION_NOTE).toMatch(/truncated or dropped/)
  })

  it('does not claim truncation on a window that fitted', () => {
    // The counterweight: a marker that is always on carries no information, and
    // a caller that learns to ignore it has lost the case above too.
    const small = Array.from({ length: 3 }, (_, i) => ({
      id: 'ev_' + String(i),
      runId: 'run_8f2c1a',
      sequenceNumber: i,
      type: 'llm.response',
      timestamp: 1_753_400_000_000,
      payload: { type: 'llm.response', ok: true },
    })) as unknown as Event[]
    expect(budgetEventRows(small).truncated).toBe(false)
  })

  /**
   * THE ORDERING ALARM — tier 4's one honest ordering claim.
   *
   * The tier used to WARN that "on a derived run sequenceNumber is ingest
   * order, not necessarily temporal order" and then hand the caller nothing to
   * act on it with. A warning with no resolution mechanism is worse than
   * silence: it makes the uncertainty unresolvable instead of merely unflagged,
   * and MCP is the surface where a caller cannot go and look at the UI instead.
   *
   * The claim is ONE-DIRECTIONAL and these three tests are what keep it that
   * way. `analyzeRunOrdering` returns `ingest-unverified` for the whole run iff
   * ANY derived event lacks a key, so seeing one in a WINDOW proves the run's
   * verdict. Nothing about a window can prove `temporal` or `sequence-native`,
   * so the field must never appear in those cases — an alarm that fires on
   * healthy runs is one a caller learns to ignore, which loses the real case.
   */
  it('PROVES ingest-unverified from a window when a derived event has no ordering key', () => {
    const events = Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => unkeyedDerivedEvent(18 + i))
    expect(budgetEventRows(events).orderUnverified).toBe(true)
    expect(ORDERING_UNVERIFIED_BASIS).toBe('ingest-unverified')
  })

  it('never claims an ordering verdict it cannot prove from a window', () => {
    // Every derived event keyed: the run MIGHT be `temporal`, but an unkeyed
    // event could sit one sequence number outside this window and force
    // `ingest-unverified`. Silence is the only honest answer, and a `temporal`
    // label here is precisely the confident-looking timeline that is wrong in
    // an unmarked place.
    const keyed = Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => externalizedEvent(18 + i))
    expect(budgetEventRows(keyed).orderUnverified).toBe(false)
    // A native window must not pay for the question at all.
    const native = keyed.map((e) => {
      const copy = { ...e } as Event & { provenance?: unknown; temporalOrder?: unknown }
      delete copy.provenance
      delete copy.temporalOrder
      return copy as Event
    })
    expect(budgetEventRows(native).orderUnverified).toBe(false)
  })

  it(`costs exactly ${String(ORDERING_BASIS_TOKEN_COST)} tokens when it fires, and nothing when it does not`, () => {
    /**
     * MEASURED AS A DELTA OVER AN OTHERWISE IDENTICAL WINDOW.
     * `unkeyedDerivedEvent` differs from `externalizedEvent` in exactly one
     * field, and that field is never projected — so the whole difference
     * between these two responses IS the alarm. `scripts/check-token-budgets.ts`
     * carries the same pair end to end through the registered handler
     * (4,445 vs 4,454); this is the projection-level half.
     */
    const envelope = (unverified: boolean): unknown => ({
      runId: 'run_8f2c1a',
      fromSequence: 18,
      events: [],
      ...(unverified && { orderingBasis: ORDERING_UNVERIFIED_BASIS }),
    })
    const delta = estimateTokens(envelope(true)) - estimateTokens(envelope(false))
    expect(
      delta,
      `the orderingBasis alarm costs ${String(delta)} tokens, not ${String(ORDERING_BASIS_TOKEN_COST)}. Both the ` +
        'key and the value are fixed strings, so this figure cannot move with the data — if it moved, the key ' +
        'was renamed or the contract’s OrderingBasis vocabulary changed. Either is worth seeing.',
    ).toBe(ORDERING_BASIS_TOKEN_COST)
  })

  it('spends the budget on the events nearest the window start — the ones the caller aimed at', () => {
    /**
     * BUDGET ORDER IS PART OF THE CONTRACT. A caller who centred the window on
     * one of `afr_explain_run`'s cited sequence numbers must get THAT payload,
     * not whichever ones happened to fit. Spending the budget back-to-front
     * would still satisfy every byte assertion above and would hand the caller
     * the events it did not ask about.
     *
     * At 10 KB each, EVERY payload in this fixture is over
     * PAYLOAD_PREVIEW_BYTE_CAP, so none survives whole. The distinction the
     * order produces is between a real preview and an empty drop marker.
     */
    const { rows } = budgetEventRows(Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => nearThresholdEvent(18 + i)))
    const previewOf = (p: unknown): string => String((p as { preview?: unknown } | undefined)?.preview ?? '')
    expect(
      previewOf(rows[0]?.payload).length,
      'the first event in the window was dropped to a bare marker while later ones were previewed',
    ).toBeGreaterThan(0)
    expect(
      previewOf(rows[rows.length - 1]?.payload),
      'the budget was not actually exhausted by the end of the window, so this fixture no longer saturates it',
    ).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Tier 5 — afr_list_runs
// ---------------------------------------------------------------------------

describe('tier 5 (afr_list_runs) — compact rows', () => {
  const rows = Array.from({ length: 20 }, (_, i) => toRunRow(fatRun(i)))

  it('projects 20 fat runs into a response an order of magnitude smaller', () => {
    /**
     * The contract says "compact rows" and gives no number, so this asserts the
     * RATIO rather than inventing an absolute ceiling: whatever a `Run` grows
     * next, the row must stay far cheaper than the document. The absolute cost
     * (~41 tok/row) is dominated by repeated JSON key names, the same overhead
     * measured on tier 1 — see the tier-1 budget test, which is where that
     * finding is asserted.
     */
    const tokens = estimateTokens({ runs: rows, nextCursor: 'cursor_31b' })
    const inputTokens = estimateTokens(Array.from({ length: 20 }, (_, i) => fatRun(i)))
    const ratio = inputTokens / tokens
    expect(
      ratio,
      `TIER 5 IS NOT COMPACT: ~${tokens} tokens for 20 runs against ~${inputTokens} ` +
        `unprojected — only ${ratio.toFixed(1)}x.\n` +
        `Cost per field, biggest first:\n\n${attributeRowBytes(rows as unknown as Record<string, unknown>[])}`
    ).toBeGreaterThanOrEqual(10)
  })

  it('does not inline run metadata, tags, labels, or searchText', () => {
    /**
     * `Run` carries `metadata: Record<string, unknown>` — unbounded and
     * caller-controlled — plus `searchText` (3 KB here), `tags` and `labels`.
     * Returning the whole document is the easiest possible implementation and
     * would make a 20-row list arbitrarily large, which is exactly why it is
     * asserted absent rather than trusted.
     */
    const hits = findForbiddenPaths(rows, [
      'metadata',
      'searchText',
      'tags',
      'labels',
      'modelsSeen',
      'triageState',
      'tokensIn',
      'tokensOut',
      'orgId',
      'explanation',
      'events',
      'payload',
    ])
    expect(hits, `tier 5 leaked unbounded run detail at:\n${hits.join('\n')}`).toEqual([])

    const serialized = JSON.stringify(rows)
    expect(serialized, 'the run metadata bag reached tier 5').not.toContain('y'.repeat(50))
    expect(serialized, 'searchText reached tier 5').not.toContain('z'.repeat(50))
  })
})
