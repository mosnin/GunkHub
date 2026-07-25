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
 * TOKEN ESTIMATE — STATED ASSUMPTION
 * ----------------------------------
 * `estimateTokens(x) = ceil(utf8ByteLength(JSON.stringify(x)) / 4)`.
 *
 * Bytes/4 is the standard rough BPE approximation, used CONSISTENTLY
 * throughout this file. It matches what the server actually emits: tools/
 * shared.ts serializes with `JSON.stringify(value)` and no indentation, so the
 * bytes measured here are the bytes an agent pays for. It is an estimate, not a
 * tokenizer — the budgets carry enough headroom that ±20% estimator error does
 * not flip a verdict, and the property that matters is that it is MONOTONIC in
 * payload size, which is what a ratchet needs.
 */
import { describe, expect, it } from 'vitest'

import type {
  Event,
  ExternalizedPayload,
  FailurePattern,
  PatternResolutionEvidence,
  Run,
  RunExplanation,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Module seam
// ---------------------------------------------------------------------------

/**
 * `packages/mcp` is not (yet) a workspace dependency of
 * `@agent-flight-recorder/tests` and has no alias in tests/vitest.config.ts, so
 * a bare-specifier import is unresolvable from here. A NON-LITERAL relative
 * specifier is opaque to both TypeScript's resolver and vite's static analysis,
 * which lets this suite bind to the real module without editing files this team
 * does not own.
 *
 * FOLLOW-UP for whoever owns tests/ config: add
 * `"@agent-flight-recorder/mcp": "workspace:*"` to tests/package.json and the
 * matching `resolve.alias` entry to tests/vitest.config.ts, then collapse this
 * into a normal `import`. The local `Projections` interface below exists only
 * because that plumbing is missing.
 */
const PROJECTIONS_SPEC = '../../packages/mcp/src/projections.ts'

interface PatternRow {
  fingerprintHash: string
  class: string
  label: string
  count: number
  lastSeenAt: number
  status: string
  confidenceState?: string
  confidenceStale?: true
}

/**
 * Columnar, per orchestrator ruling 3: the field names are declared ONCE in
 * `fields` and each row is positional. That is what took tier 1 from 467 to
 * 284 tokens for 10 patterns — repeated JSON keys were ~50% of the bytes, and
 * that cost scales with row count in a way the field VALUES do not.
 *
 * PatternRow below is retained deliberately: it is the per-pattern field set
 * this projection is allowed to expose, and TIER1_ALLOWED_KEYS is checked
 * against `fields`. Losing it would lose the shape guard.
 */
interface ListPatternsResult {
  /**
   * Typed as `keyof PatternRow` rather than `string[]` on purpose: a column
   * added to the projection that is not a declared tier-1 field now fails at
   * COMPILE time, not merely in the runtime shape guard below. The guard stays
   * because it also catches a field renamed on both sides at once.
   */
  fields: (keyof PatternRow)[]
  rows: unknown[][]
  nextCursor?: string
  unevaluated?: { count: number; sample: string[] }
}

interface EventRow {
  sequenceNumber: number
  type: string
  timestamp: number
  payload?: unknown
  artifact?: Record<string, unknown>
  originalType?: string
  errorSummary?: string
}

interface Projections {
  toListPatternsResult(
    patterns: FailurePattern[],
    envelope: unknown,
    nextCursor: string | undefined
  ): ListPatternsResult
  toPatternEvidenceResult(evidence: PatternResolutionEvidence): Record<string, unknown>
  toExplainRunResult(
    runId: string,
    status: 'not_eligible' | 'pending' | 'ready',
    explanation: RunExplanation | null,
    runStatus: string | undefined
  ): Record<string, unknown>
  toEventRow(event: Event): EventRow
  toRunRow(run: Run): Record<string, unknown>
  TRANSITIONS_CAP: number
}

const projections = (await import(/* @vite-ignore */ PROJECTIONS_SPEC)) as Projections

/**
 * Tier 4's hard cap, read from the tool module rather than duplicated. If Team A
 * raises `MAX_LIMIT`, the window budget below re-measures at the NEW cap and
 * fails — which is exactly the regression that should not pass silently.
 */
const GET_RUN_EVENTS_SPEC = '../../packages/mcp/src/tools/get-run-events.ts'
const { MAX_LIMIT: TIER4_MAX_LIMIT } = (await import(/* @vite-ignore */ GET_RUN_EVENTS_SPEC)) as {
  MAX_LIMIT: number
}

// ---------------------------------------------------------------------------
// Token estimation + attribution
// ---------------------------------------------------------------------------

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** See "TOKEN ESTIMATE" in the file header. bytes/4, consistently. */
function estimateTokens(value: unknown): number {
  return Math.ceil(byteLength(JSON.stringify(value) ?? '') / 4)
}

/**
 * Per-field byte attribution across uniform rows, biggest first.
 *
 * This exists so a blown budget produces "label: 385 B (97 tok)" and not just
 * "expected 465 to be <= 250". A budget test whose failure nobody can act on
 * gets deleted the first time it goes red, which makes it worse than no test.
 */
function attributeRowBytes(rows: Array<Record<string, unknown>>): string {
  const totals = new Map<string, number>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const cost = byteLength(JSON.stringify(key)) + 1 + byteLength(JSON.stringify(value) ?? 'null') + 1
      totals.set(key, (totals.get(key) ?? 0) + cost)
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, b]) => `    ${k.padEnd(20)} ${String(b).padStart(7)} B  (~${Math.ceil(b / 4)} tok)`)
    .join('\n')
}

/**
 * Per-column byte attribution for a columnar ({fields, rows}) result.
 *
 * Same purpose as attributeRowBytes, different encoding: the field NAME is
 * paid once in the header, while each row pays only its value. Reporting them
 * separately is the point — it is what shows that going columnar moved the
 * cost from names to values, and which column to cut if the budget is blown.
 */
function attributeColumnBytes(fields: readonly string[], rows: readonly unknown[][]): string {
  const header = fields.map((f) => byteLength(JSON.stringify(f)) + 1)
  const totals = fields.map((_, i) =>
    rows.reduce((sum, row) => sum + byteLength(JSON.stringify(row[i]) ?? 'null') + 1, 0),
  )
  return fields
    .map((f, i) => ({ f, name: header[i] ?? 0, values: totals[i] ?? 0 }))
    .sort((a, b) => b.values - a.values)
    .map(
      ({ f, name, values }) =>
        `    ${f.padEnd(20)} ${String(values).padStart(7)} B values  (~${Math.ceil(values / 4)} tok)` +
        `  + ${name} B name (paid once)`,
    )
    .join('\n')
}

/** Paths at which a forbidden key appears, for an actionable failure message. */
function findForbiddenPaths(value: unknown, forbidden: readonly string[], path = '$'): string[] {
  const hits: string[] = []
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findForbiddenPaths(item, forbidden, `${path}[${i}]`)))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`
      if (forbidden.includes(key)) hits.push(childPath)
      hits.push(...findForbiddenPaths(child, forbidden, childPath))
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

const TIER1_PATTERN_COUNT = 10
// MEASURED, not aspirational. Both were set before anything existed to
// measure, and both were wrong in different directions.
//
// Tier 1: 250 was unreachable as an array of per-pattern OBJECTS — repeated
// JSON key names were ~50% of the bytes, and that cost scales with row count.
// The projection was already correct; the ENCODING was the problem, so tier 1
// and afr_list_runs went columnar ({fields, rows}). Measured 284 for 10
// patterns (~28/row), against ~215 for the values alone. 300 is the real
// ceiling with headroom; going lower means dropping a mandated column.
//
// Tier 2: 300 required cutting real lifecycle history to hit a number nobody
// had measured. The cut genuinely available — the unbounded per-transition
// `metadata` bag, ~10k tokens — is taken. TRANSITIONS_CAP stays at 10 because
// resolution history is the answer this tier exists to give. Measured 423.
const TIER1_TOKEN_BUDGET = 300
const TIER2_TOKEN_BUDGET = 450
const TIER3_TOKEN_BUDGET = 200
/**
 * Tier 4 is a WINDOW, so its budget is per-window and must not scale with run
 * length. The contract states only "bounded and hard-capped", so this is
 * DERIVED, and the derivation is written down because an undocumented ceiling
 * gets raised the first time it goes red:
 *
 * The premise this package exists for is that a 50-step run dumped raw is
 * 100k+ tokens. A fully-saturated tier-4 window must stay at least an ORDER OF
 * MAGNITUDE under that, or the tier has no reason to exist — an agent may as
 * well ask for everything. 10k tokens at the 50-event cap is that line.
 */
const RAW_DUMP_TOKENS = 100_000
const TIER4_WINDOW_TOKEN_BUDGET = RAW_DUMP_TOKENS / 10

// ---------------------------------------------------------------------------
// FAT inputs — every field the contract permits, so the projection is proven
// ---------------------------------------------------------------------------

const LABELS = [
  'Tool call failed',
  'LLM request timed out',
  'HTTP 429 from provider',
  'Retrieval returned no documents',
  'Tool "search" returned malformed JSON',
  'Model refused: content policy',
  'Context length exceeded',
  'Rate limited by upstream API',
  'Unhandled exception in agent loop',
  'Timed out waiting for tool result',
]
const CLASSES = [
  'tool_error',
  'timeout',
  'http_error',
  'retrieval_error',
  'tool_error',
  'llm_error',
  'llm_error',
  'http_error',
  'unknown',
  'timeout',
]

/**
 * A MAXIMAL `FailurePattern` — every optional field populated, including the
 * bounded-but-large arrays (`representativeRunIds` <= 5,
 * `affectedAgentVersionIds` <= 20) and the nested spike assessment and
 * confidence snapshot. Serialized whole, one of these is ~700 bytes; the
 * tier-1 row must be ~25 tokens. That gap is what is under test.
 */
function fatPattern(i: number): FailurePattern {
  return {
    id: `fp_${String(i)}`,
    orgId: 'org_caller',
    fingerprintHash: String(i + 1).padStart(2, '0') + 'f3a9c1d4e7b2',
    class: CLASSES[i % CLASSES.length]!,
    label: LABELS[i % LABELS.length]!,
    salientKey: 'search',
    count: [128, 41, 7, 220, 3, 19, 66, 12, 5, 88][i % 10]!,
    firstSeenAt: 1_750_000_000_000,
    lastSeenAt: 1_753_400_000_000 + i * 97_000,
    representativeRunIds: [`run_${String(i)}a`, `run_${String(i)}b`, `run_${String(i)}c`, `run_${String(i)}d`, `run_${String(i)}e`],
    affectedAgentVersionIds: Array.from({ length: 20 }, (_, v) => `ver_${String(i)}_${String(v)}`),
    affectedAgentIds: ['agent_a1', 'agent_b2'],
    lastSpikeAssessment: {
      assessedAt: 1_753_390_000_000,
      isSpiking: true,
      recentCount: 44,
      baselineMean: 6.25,
      z: 4.81,
    },
    lastPatternSpikeAlertFiredAt: 1_753_391_000_000,
    muted: false,
    mutedAt: 1_752_000_000_000,
    status: (['open', 'acknowledged', 'resolved'] as const)[i % 3]!,
    acknowledgedAt: 1_753_000_000_000,
    acknowledgedByUserId: 'user_2f9',
    resolvedAt: 1_753_100_000_000,
    resolvedByUserId: 'user_2f9',
    resolutionNote:
      'Added retry with jitter on 429 from the provider, plus a circuit breaker after five consecutive failures.',
    resolutionRef: 'https://github.com/acme/agent/pull/812',
    regressedAt: 1_753_300_000_000,
    resolvedInVersionId: 'ver_7c1',
    resolvedAtRunCount: 1204,
    resolvedAtOccurrenceCount: 41,
    lastFixConfidence: {
      computedAt: 1_753_395_000_000,
      basisResolvedAt: 1_753_100_000_000,
      state: 'proving',
      score: 0.71,
      exposureRuns: 1802,
      observedRuns: 1900,
      exposureTruncated: false,
      versionAttribution: 'matched',
      recurred: false,
      limitingFactor: 'accumulating',
    },
    fixConfidenceRefreshAt: 1_753_500_000_000,
  }
}

const FAT_PATTERNS = Array.from({ length: TIER1_PATTERN_COUNT }, (_, i) => fatPattern(i))

const CONFIDENCE_ENVELOPE = {
  entries: FAT_PATTERNS.map((p, i) => ({
    fingerprintHash: p.fingerprintHash,
    state: (['unproven', 'proving', 'confirmed', 'regressed'] as const)[i % 4]!,
    stale: false,
  })),
  unevaluated: [],
}

// ---------------------------------------------------------------------------
// Tier 1 — afr_list_failure_patterns
// ---------------------------------------------------------------------------

describe('tier 1 (afr_list_failure_patterns) — token budget', () => {
  const result = projections.toListPatternsResult(FAT_PATTERNS, CONFIDENCE_ENVELOPE, 'cursor_9f2a')

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
  const result = projections.toListPatternsResult(FAT_PATTERNS, CONFIDENCE_ENVELOPE, 'cursor_9f2a')

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
  const result = projections.toPatternEvidenceResult(FAT_EVIDENCE)

  it(`fits within ~${TIER2_TOKEN_BUDGET} tokens with 100 inbound transitions`, () => {
    const tokens = estimateTokens(result)
    const breakdown = Object.entries(result)
      .map(([k, v]) => [k, byteLength(JSON.stringify(v) ?? 'null')] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([k, b]) => `    ${k.padEnd(20)} ${String(b).padStart(6)} B  (~${Math.ceil(b / 4)} tok)`)
      .join('\n')

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
    expect(transitions.length).toBeLessThanOrEqual(projections.TRANSITIONS_CAP)
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

/** The largest explanation the contract permits: 2 KB + 1 KB + 1 KB of prose. */
const CONTRACT_MAX_EXPLANATION: RunExplanation = {
  id: 'expl_1',
  orgId: 'org_caller',
  runId: 'run_8f2c1a',
  kind: 'llm',
  summary: 'S'.repeat(2048),
  rootCause: 'R'.repeat(1024),
  suggestedFix: 'F'.repeat(1024),
  citedSequenceNumbers: [1, 14, 22, 23, 24],
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
    const result = projections.toExplainRunResult('run_8f2c1a', 'ready', REALISTIC_EXPLANATION, 'failed')
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
     * each (packages/contracts/src/run_explanations.ts). 4 KB of prose is ~1000
     * tokens — five times this tier's budget. `toExplainRunResult` currently
     * passes all three through verbatim, so the tier-3 budget holds only
     * because real explanations happen to be short. That is a property of the
     * generator, not a guarantee of this layer.
     *
     * This asserts the layer enforces its own bound rather than trusting an
     * upstream one it does not control.
     */
    const result = projections.toExplainRunResult('run_8f2c1a', 'ready', CONTRACT_MAX_EXPLANATION, 'failed')
    const tokens = estimateTokens(result)
    expect(
      tokens,
      `A contract-maximal RunExplanation projects to ~${tokens} tokens, over the ` +
        `${TIER3_TOKEN_BUDGET}-token tier-3 budget. toExplainRunResult forwards summary/` +
        `rootCause/suggestedFix verbatim, so tier 3 is only cheap by luck: an LLM-kind ` +
        `explanation that uses its full 2 KB summary allowance blows the tier. Truncate ` +
        `in the projection (with an explicit marker), do not rely on the contract's caps.`
    ).toBeLessThanOrEqual(TIER3_TOKEN_BUDGET)
  })

  it('returns representative SEQUENCE NUMBERS, never the events themselves', () => {
    // The entire economic argument for tier 3 is that it hands back POINTERS
    // into the event log so the agent can decide whether tier 4 is worth it.
    // Inlining the cited events would collapse tiers 3 and 4 into one call.
    const result = projections.toExplainRunResult('run_8f2c1a', 'ready', REALISTIC_EXPLANATION, 'failed')
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
    const notEligible = projections.toExplainRunResult('run_x', 'not_eligible', null, 'completed')
    const pending = projections.toExplainRunResult('run_y', 'pending', null, 'failed')
    expect(notEligible.status).toBe('not_eligible')
    expect(pending.status).toBe('pending')
    expect(notEligible.status).not.toBe(pending.status)
  })
})

// ---------------------------------------------------------------------------
// Tier 4 — afr_get_run_events
// ---------------------------------------------------------------------------

const PAYLOAD_EXTERNALIZATION_THRESHOLD = 10 * 1024

function externalizedEvent(seq: number): Event {
  const payload: ExternalizedPayload = {
    type: '_externalized',
    originalType: 'llm.request',
    _artifact: {
      artifactId: 'art_' + String(seq),
      storageKey: `org_1/run_8f2c1a/ev_${String(seq)}.json`,
      storageBucket: 'afr-artifacts',
      checksum: 'sha256:9c1f2b7d4e8a3c6f1b9d2e5a8c4f7b1d3e6a9c2f5b8d1e4a7c3f6b9d2e5a8c4f',
      size: 41_203,
    },
  }
  return {
    id: 'ev_' + String(seq),
    runId: 'run_8f2c1a',
    sequenceNumber: seq,
    type: 'llm.request',
    timestamp: 1_753_400_000_000 + seq * 1200,
    payload,
  } as unknown as Event
}

/**
 * An event whose payload is JUST UNDER the externalization threshold, so it is
 * NOT externalized and is therefore inlined verbatim. This is the worst case
 * the system can legally produce, and it is entirely reachable: the SDK
 * externalizes only ABOVE 10 KB.
 */
function nearThresholdEvent(seq: number): Event {
  const filler = 'x'.repeat(PAYLOAD_EXTERNALIZATION_THRESHOLD - 200)
  return {
    id: 'ev_' + String(seq),
    runId: 'run_8f2c1a',
    sequenceNumber: seq,
    type: 'llm.response',
    timestamp: 1_753_400_000_000 + seq * 1200,
    payload: { type: 'llm.response', model: 'claude-opus-5', content: filler, finish_reason: 'stop' },
  } as unknown as Event
}

describe('tier 4 (afr_get_run_events) — externalized payloads', () => {
  it('NEVER inlines an externalized payload — pointer and checksum only', () => {
    /**
     * CLAUDE.md Event Log Rule 3: payloads over 10 KB are externalized and the
     * event stores an ArtifactPointer. Re-inlining one here would put a 10 KB+
     * blob into a context window to answer a question the pointer already
     * answers.
     */
    const row = projections.toEventRow(externalizedEvent(24))
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
    const rows = Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => projections.toEventRow(externalizedEvent(18 + i)))
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
     * 10 239 bytes is under the threshold, is never externalized, and is
     * assigned straight through as `row.payload = payload`.
     *
     * At the 50-event cap that is 50 x ~10 KB = ~500 KB in a single tool
     * result: roughly 125 000 tokens, MORE than the 100k raw dump this entire
     * package exists to prevent. The tool's own docstring says "a 50-step run
     * is 100k+ tokens raw; the entire point of tiers 1-3 is that a caller
     * arrives here already knowing which three sequence numbers matter" — and
     * then the window can cost more than the dump.
     *
     * The cap on the number of EVENTS is not a cap on the number of BYTES, and
     * only the second one is what an agent pays for. Tier 4 needs a payload
     * size budget (truncate-with-marker, or externalize-on-read), not just an
     * event count limit.
     */
    const rows = Array.from({ length: TIER4_MAX_LIMIT }, (_, i) => projections.toEventRow(nearThresholdEvent(18 + i)))
    const window = { runId: 'run_8f2c1a', fromSequence: 18, events: rows }
    const tokens = estimateTokens(window)

    expect(
      tokens,
      `TIER 4 IS UNBOUNDED IN BYTES: ~${tokens} tokens for ${TIER4_MAX_LIMIT} events ` +
        `(budget ${TIER4_WINDOW_TOKEN_BUDGET}), ~${Math.ceil(tokens / TIER4_MAX_LIMIT)} tok/event.\n\n` +
        `Every payload here is ${PAYLOAD_EXTERNALIZATION_THRESHOLD - 200} B — just UNDER the 10 KB\n` +
        `externalization threshold, so none of them is an artifact and toEventRow\n` +
        `inlines all of them verbatim (\`row.payload = payload\`).\n\n` +
        `MAX_LIMIT caps EVENTS, not BYTES, and bytes are what the agent pays for.\n` +
        `A single saturated window can cost more than the ~${RAW_DUMP_TOKENS}-token raw dump\n` +
        `this package exists to prevent.\n\n` +
        `Fix: budget payload bytes in toEventRow — truncate with an explicit marker,\n` +
        `or return a pointer for anything over a few hundred bytes.`
    ).toBeLessThanOrEqual(TIER4_WINDOW_TOKEN_BUDGET)
  })
})

// ---------------------------------------------------------------------------
// Tier 5 — afr_list_runs
// ---------------------------------------------------------------------------

/** A MAXIMAL `Run`: unbounded metadata bag, tags, labels, searchText, counters. */
function fatRun(i: number): Run {
  return {
    id: 'run_' + String(i + 1).padStart(6, '0'),
    orgId: 'org_caller',
    projectId: 'proj_1',
    agentId: 'agent_a1',
    agentVersionId: 'ver_7c1',
    status: (['failed', 'completed', 'running', 'timed_out'] as const)[i % 4]!,
    startedAt: 1_753_400_000_000 + i * 60_000,
    endedAt: 1_753_400_030_000 + i * 60_000,
    // Unbounded and caller-controlled — the whole reason this must not pass through.
    metadata: { prompt: 'y'.repeat(2000), ticket: 'ACME-4412', region: 'us-east-1' },
    tags: ['nightly', 'regression-suite', 'high-priority'],
    triggeredBy: 'user_2f9',
    sdkVersion: '0.7.5',
    sessionId: 'sess_31b',
    environment: 'production',
    labels: ['triage', 'flaky'],
    triageState: 'investigating',
    tokensIn: 120_400,
    tokensOut: 8_120,
    searchText: 'z'.repeat(3000),
    modelsSeen: ['claude-opus-5', 'claude-haiku-4'],
  } as unknown as Run
}

describe('tier 5 (afr_list_runs) — compact rows', () => {
  const rows = Array.from({ length: 20 }, (_, i) => projections.toRunRow(fatRun(i)))

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
        `Cost per field, biggest first:\n\n${attributeRowBytes(rows as Array<Record<string, unknown>>)}`
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
