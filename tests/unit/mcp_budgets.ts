/**
 * THE SINGLE DECLARATION OF EVERY `packages/mcp` TOKEN BUDGET, AND OF THE
 * ESTIMATOR THEY ARE MEASURED WITH.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before it, the same budgets were declared in four places with four private
 * copies of the estimator:
 *
 *   - `mcp_progressive_disclosure.test.ts` — TIER1/2/3 budgets + its own
 *     `estimateTokens`
 *   - `mcp_triage.test.ts`                 — `TRIAGE_TOKEN_BUDGET = 450` +
 *     its own `estimateTokens`, plus TIER1_MEASURED/TIER2_MEASURED, two FROZEN
 *     measurements of numbers that move
 *   - `mcp_triage_measure.test.ts`         — a bare literal `450` + its own `tok`
 *   - `mcp_triage_next_hops.test.ts`       — a bare literal `300` + its own `tok`
 *
 * `450` appeared in three files and `300` in two, only one of each carrying the
 * derivation. That is the drift this repo keeps paying for: the copies do not
 * go wrong at the same time, they go wrong one at a time and nobody notices
 * because the other copy is still green.
 *
 * ONE declaration each, here. A budget change is a one-line change in one file,
 * and every assertion that depends on it moves together.
 *
 * THE ESTIMATOR IS PART OF THE CONTRACT. Two suites asserting "450" with two
 * different estimators are not asserting the same thing. There is one
 * `estimateTokens` and everything uses it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THESE BUDGETS SHOULD EVENTUALLY LIVE
 * ---------------------------------------------------------------------------
 * Not here, and not in `scripts/check-token-budgets.ts` either. They belong
 * next to the code they constrain, in `packages/mcp/src/`, exactly like
 * `WINDOW_PAYLOAD_BYTE_BUDGET`, `PAYLOAD_PREVIEW_BYTE_CAP`, `SUMMARY_BYTE_CAP`,
 * `TRANSITIONS_CAP` and `MAX_LIMIT` already do — all of which this file
 * re-exports rather than restates, and none of which has ever drifted, because
 * there has only ever been one of each.
 *
 * A budget declared in `tests/` or in `scripts/` is a budget the author of a
 * projection never sees while widening it. A budget declared beside the
 * projection is one they cannot miss. `packages/mcp/**` is the mcp boundary, so
 * that move needs its owner; until then this file is the single test-side
 * declaration and the standing budget script should IMPORT FROM HERE rather
 * than restate, so the script and the suites cannot disagree.
 */
import {
  PAYLOAD_PREVIEW_BYTE_CAP,
  ROOT_CAUSE_BYTE_CAP,
  SUGGESTED_FIX_BYTE_CAP,
  SUMMARY_BYTE_CAP,
  TRANSITIONS_CAP,
  TRUNCATION_NOTE,
  WINDOW_PAYLOAD_BYTE_BUDGET,
} from '@agent-flight-recorder/mcp'

import type {
  DivergenceCoverage,
  DivergenceProof,
  DivergenceReport,
  DivergenceScanWindow,
  Event,
  FailurePattern,
  FleetDivergenceReport,
  IndeterminateDivergence,
  IndeterminateDivergenceKind,
  OtelEventProvenance,
  PatternResolutionEvidence,
  ProvenDivergence,
  ProvenDivergenceKind,
  Run,
  RunExplanation,
  SpeculativeDivergence,
  SpeculativeDivergenceKind,
  TemporalOrderKey,
} from '@agent-flight-recorder/contracts'
import type { V1ListFixConfidenceEnvelope } from '@agent-flight-recorder/sdk'

/**
 * Re-exported so a suite reads a cap from ONE place whether the cap is declared
 * in the package or here. A test that hard-codes `400` for
 * `PAYLOAD_PREVIEW_BYTE_CAP` has forked it.
 */
export {
  PAYLOAD_PREVIEW_BYTE_CAP,
  ROOT_CAUSE_BYTE_CAP,
  SUGGESTED_FIX_BYTE_CAP,
  SUMMARY_BYTE_CAP,
  TRANSITIONS_CAP,
  TRUNCATION_NOTE,
  WINDOW_PAYLOAD_BYTE_BUDGET,
}

// ---------------------------------------------------------------------------
// The estimator
// ---------------------------------------------------------------------------

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * TOKEN ESTIMATE — THE STATED ASSUMPTION, STATED ONCE.
 *
 * `estimateTokens(x) = ceil(utf8ByteLength(JSON.stringify(x)) / 4)`.
 *
 * Bytes/4 is the standard rough BPE approximation. It matches what the server
 * actually emits: `packages/mcp/src/tools/shared.ts` serializes with
 * `JSON.stringify(value)` and no indentation, so the bytes measured here are
 * the bytes an agent pays for. It is an estimate, not a tokenizer — the budgets
 * carry enough headroom that ±20% estimator error does not flip a verdict, and
 * the property that matters is that it is MONOTONIC in payload size, which is
 * what a ratchet needs.
 *
 * `docs/mcp.md` § "Where the token figures come from" quotes this formula. If
 * it changes, that section is wrong until it is re-measured.
 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(byteLength(JSON.stringify(value) ?? '') / 4)
}

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

/** How many patterns tier 1's budget is measured over. Part of the budget: a per-call ceiling is meaningless without a row count. */
export const TIER1_PATTERN_COUNT = 10

/**
 * Tier 1 — `afr_list_failure_patterns`, {@link TIER1_PATTERN_COUNT} patterns.
 *
 * MEASURED, not aspirational. 250 was unreachable as an array of per-pattern
 * OBJECTS — repeated JSON key names were ~50% of the bytes, and that cost
 * scales with row count. The projection was already correct; the ENCODING was
 * the problem, so tier 1 and afr_list_runs went columnar (`{fields, rows}`).
 * Measured 284 for 10 maximal patterns (~28/row) against ~215 for the values
 * alone. 300 is the real ceiling with headroom; going lower means dropping a
 * mandated column.
 */
export const TIER1_TOKEN_BUDGET = 300

/**
 * Tier 2 — `afr_get_pattern_evidence`, one pattern with the contract's maximum
 * of 100 inbound lifecycle transitions.
 *
 * 300 required cutting real lifecycle history to hit a number nobody had
 * measured. The cut genuinely available — the unbounded per-transition
 * `metadata` bag, ~10k tokens — is taken. {@link TRANSITIONS_CAP} stays at 10
 * because resolution history is the answer this tier exists to give.
 * Measured 423.
 */
export const TIER2_TOKEN_BUDGET = 450

/** Tier 3 — `afr_explain_run`, one run. Measured 121 realistic / 192 contract-maximal. */
export const TIER3_TOKEN_BUDGET = 200

/**
 * What an honesty MARKER (`scanTruncated`, `truncationNote`, …) may cost.
 *
 * Markers are the one thing added to a response for the caller's benefit rather
 * than the caller's question, so "it's only a boolean" is the argument that
 * adds them. This bounds the marginal cost so a marker cannot quietly grow into
 * a prose field. Measured: tier 1's `scanTruncated` costs +5.
 */
export const MARKER_TOKEN_ALLOWANCE = 8

/**
 * What tier 4's `orderingBasis` alarm costs when it fires. EXACT, not a budget.
 *
 * `,"orderingBasis":"ingest-unverified"` is 36 bytes, so 9 tokens, and unlike
 * every other number in this file that is not an estimate with headroom — both
 * the key and the value are fixed strings, the value being a member of the
 * contract's closed `OrderingBasis` union. The cost cannot vary with the data,
 * so there is nothing to leave room for.
 *
 * DELIBERATELY NOT {@link MARKER_TOKEN_ALLOWANCE}. That one is 8 and its
 * assertion says "it is a boolean flag"; this is a string naming a contract
 * vocabulary member and can never be 8. Stretching the boolean allowance to
 * cover it would have been the cheap move and would have destroyed what the
 * boolean allowance means. Two different things, two constants.
 *
 * An exact figure means the test goes red on a change nobody intended — the key
 * renamed, the union member renamed, a second value added. Each of those is a
 * contract change that should be seen, not absorbed.
 */
export const ORDERING_BASIS_TOKEN_COST = 9

/**
 * The premise this package exists for: a 50-step run dumped raw is ~100k
 * tokens. It DOCUMENTS the tier-4 derivation below; it is deliberately not an
 * operand in it. See {@link TIER4_WINDOW_TOKEN_BUDGET}.
 */
export const RAW_DUMP_TOKENS = 100_000

/**
 * Tier 4 — `afr_get_run_events`, ONE saturated window.
 *
 * Tier 4 is a WINDOW, so its budget is per-window and must not scale with run
 * length. The contract states only "bounded and hard-capped", so this is
 * DERIVED, and the derivation is written down because an undocumented ceiling
 * gets raised the first time it goes red: a fully-saturated window must stay at
 * least an ORDER OF MAGNITUDE under the ~{@link RAW_DUMP_TOKENS}-token raw
 * dump, or the tier has no reason to exist — an agent may as well ask for
 * everything.
 *
 * FROZEN AS A LITERAL, NOT WRITTEN `RAW_DUMP_TOKENS / 10`. A ceiling expressed
 * as a fraction of another constant moves when that constant moves: revising
 * the raw-dump assumption upward would have raised this ceiling silently, in
 * the same commit, with every test still green — while the absolute number of
 * tokens an agent actually pays went up. `scripts/check-token-budgets.ts` makes
 * the same argument and asserts it (see "every declared budget is an absolute
 * token count" in `token_budget_guard.test.ts`). A budget is an absolute.
 */
export const TIER4_WINDOW_TOKEN_BUDGET = 10_000

/**
 * Tier 0 — `afr_triage`.
 *
 * DERIVED, and the derivation is the argument for the tool's existence: an
 * agent can already get "what is broken" plus "did the fix hold" by calling
 * tier 1 and tier 2 itself. A shortcut that costs more than the thing it
 * shortcuts is not a shortcut. This is deliberately the STRICTER of the two
 * available lines — at or under the single most expensive tier it replaces a
 * call to, rather than under their sum.
 *
 * It is {@link TIER2_TOKEN_BUDGET} BY DERIVATION, not by coincidence, so it is
 * defined in terms of it. Raising tier 2's budget must raise triage's, and a
 * second literal `450` would have hidden that.
 */
export const TRIAGE_TOKEN_BUDGET = TIER2_TOKEN_BUDGET

/**
 * What triage exists to be cheaper than: doing tiers 1 and 2 yourself.
 *
 * DELIBERATELY THE BUDGETS, NOT THE MEASUREMENTS. This used to be
 * `TIER1_MEASURED + TIER2_MEASURED` = `284 + 423`, two frozen copies of numbers
 * that move freely within their budgets — so the bar drifted away from the
 * truth silently and in the LENIENT direction every time tier 1 or tier 2 got
 * cheaper. Against the budgets the bar is stable and honest: it is the most
 * that calling tiers 1 and 2 yourself is ever allowed to cost.
 */
export const DIY_TOKEN_BUDGET = TIER1_TOKEN_BUDGET + TIER2_TOKEN_BUDGET

// ---------------------------------------------------------------------------
// Failure-message attribution
//
// A budget test whose failure message is "expected 512 to be <= 450" gets
// deleted the first time it goes red, which makes it worse than no test. These
// say WHICH FIELD to cut. They are shared for the same reason the estimator is:
// three private copies of the same 15 lines is three chances to compute the
// per-field cost differently and draw different conclusions from it.
// ---------------------------------------------------------------------------

/** Per-field byte attribution across uniform rows of objects, biggest first. */
export function attributeRowBytes(rows: readonly Record<string, unknown>[]): string {
  const totals = new Map<string, number>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const cost = byteLength(JSON.stringify(key)) + 1 + byteLength(JSON.stringify(value) ?? 'null') + 1
      totals.set(key, (totals.get(key) ?? 0) + cost)
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, b]) => `    ${k.padEnd(20)} ${String(b).padStart(7)} B  (~${String(Math.ceil(b / 4))} tok)`)
    .join('\n')
}

/**
 * Per-column byte attribution for a columnar (`{fields, rows}`) result.
 *
 * Same purpose as {@link attributeRowBytes}, different encoding: the field NAME
 * is paid once in the header, while each row pays only its value. Reporting
 * them separately is the point — it is what shows that going columnar moved the
 * cost from names to values, and which column to cut if the budget is blown.
 */
export function attributeColumnBytes(fields: readonly string[], rows: readonly unknown[][]): string {
  const header = fields.map((f) => byteLength(JSON.stringify(f)) + 1)
  const totals = fields.map((_, i) =>
    rows.reduce((sum, row) => sum + byteLength(JSON.stringify(row[i]) ?? 'null') + 1, 0),
  )
  return fields
    .map((f, i) => ({ f, name: header[i] ?? 0, values: totals[i] ?? 0 }))
    .sort((a, b) => b.values - a.values)
    .map(
      ({ f, name, values }) =>
        `    ${f.padEnd(20)} ${String(values).padStart(7)} B values  (~${String(Math.ceil(values / 4))} tok)` +
        `  + ${String(name)} B name (paid once)`,
    )
    .join('\n')
}

/** Cost by top-level field of a single object result, biggest first. */
export function attributeTopLevelBytes(result: Record<string, unknown>): string {
  return Object.entries(result)
    .map(([k, v]) => [k, byteLength(JSON.stringify(v) ?? 'null')] as const)
    .sort((a, b) => b[1] - a[1])
    .map(([k, b]) => `    ${k.padEnd(20)} ${String(b).padStart(6)} B  (~${String(Math.ceil(b / 4))} tok)`)
    .join('\n')
}

/**
 * Paths at which a forbidden key appears, for an actionable failure message.
 *
 * Shared because the SHAPE guards in every mcp suite depend on it agreeing with
 * itself: a copy that stopped recursing into arrays would silently pass every
 * forbidden-key sweep in the file that owned it.
 */
export function findForbiddenPaths(value: unknown, forbidden: readonly string[], path = '$'): string[] {
  const hits: string[] = []
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findForbiddenPaths(item, forbidden, `${path}[${String(i)}]`)))
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
// CONTRACT-MAXIMAL FIXTURES — the single declaration
// ---------------------------------------------------------------------------
//
// WHY THEY LIVE HERE AND NOT IN THE SUITES THAT USE THEM
// -----------------------------------------------------
// They were declared four times: `fatPattern` in
// `mcp_progressive_disclosure.test.ts`, a second `fatPattern` in
// `mcp_triage.test.ts`, a `pattern` in `mcp_triage_measure.test.ts`, and a
// fourth family inside `scripts/check-token-budgets.ts`. The four did not
// agree, and the disagreement was invisible because each was correct on its own
// terms: for the SAME tool on the SAME scenario the script measured 294 where
// the suite measured 284, and 332 where it measured 331. Ten tokens of tier-1
// headroom that does not exist, and no test anywhere could see it — the
// estimator and the budgets had already been unified into this file, so the
// fixtures were the last surface on which two numbers for one quantity could
// coexist forever without either being wrong.
//
// WHY THEY ARE TYPED
// ------------------
// Against `@agent-flight-recorder/contracts`, deliberately. `tests/tsconfig.json`
// keeps `exactOptionalPropertyTypes` and `strict` on precisely so that a fixture
// which stops matching its contract fails TYPECHECK. That is the cheap half of
// fixture-drift detection and it only works if the fixtures are typed, which is
// why they did not move into `scripts/` (a tsx-run CI tool that must not depend
// on built `.d.ts`). `scripts/check-token-budgets.ts` imports them from here
// instead, and its `checkMaximality` supplies the expensive half: it parses the
// contracts source and fails if any declared field is left unpopulated.
//
// MAXIMAL MEANS MAXIMAL. Every optional field set, every bounded array filled to
// its documented bound, every unbounded field (`metadata`, `searchText`, the
// per-transition metadata bag) carrying a realistically hostile payload. A
// projection is only proven lean if the thing it projected from was not.

/** Every field optional, so a scenario can override one without restating 30. */
export type PatternOverrides = { [K in keyof FailurePattern]?: FailurePattern[K] | undefined }

/**
 * The pinned clock.
 *
 * `afr_triage` emits a recency-decayed `score` per item, so with a live
 * `Date.now()` the response's byte count changes as the fixture ages and the
 * ratchet becomes noise. Fixture timestamps are expressed as offsets from this
 * constant and `Date.now` is pinned to it while a handler runs.
 */
export const FROZEN_NOW = 1_753_500_000_000
export const HOUR = 3_600_000
export const DAY = 24 * HOUR

/**
 * Epoch MILLISECONDS to the epoch-NANOSECOND decimal string the OTel contracts
 * carry (`Run.otelRoot.endUnixNano`, `TemporalOrderKey.instantUnixNano`, …).
 *
 * A string, and never a `number`: float64 ULP at a 2026 epoch-nanosecond value
 * (~1.75e18) is 256 ns, so `Number()` collapses distinct instants. See the
 * argument on `TemporalOrderKey` in `packages/contracts/src/temporal.ts`.
 */
function nanosOfMs(ms: number): string {
  return String(ms) + '000000'
}

/**
 * The span id shared by an event's provenance and its temporal-order key — one
 * span, one id.
 *
 * EXACTLY 16 LOWERCASE HEX CHARACTERS, which is a W3C span id and therefore the
 * maximum by definition. It was 17 for a while, which errs in the safe
 * direction (a maximality fixture that over-states cannot under-state a budget)
 * and is still wrong: this family's whole claim is "contract-maximal and
 * provably so", and a field that reaches its maximum by being INVALID weakens
 * that claim for every reader who spot-checks it. Correcting it lowers a
 * measurement; the baseline moves in the same commit, which is the point.
 */
function spanIdOf(seq: number): string {
  return String(seq).padStart(4, '0') + 'b7ad6b716920'
}

const LABELS: readonly string[] = [
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
const CLASSES: readonly string[] = [
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
const COUNTS: readonly number[] = [128, 41, 7, 220, 3, 19, 66, 12, 5, 88]

/** Every field `FailurePattern` declares, optional ones included. */
export function fatPattern(i: number, overrides: PatternOverrides = {}): FailurePattern {
  return {
    id: `fp_${String(i)}`,
    orgId: 'org_caller',
    fingerprintHash: String(i + 1).padStart(2, '0') + 'f3a9c1d4e7b2',
    class: CLASSES[i % CLASSES.length],
    label: LABELS[i % LABELS.length],
    salientKey: 'search',
    count: COUNTS[i % COUNTS.length],
    firstSeenAt: FROZEN_NOW - 30 * DAY,
    lastSeenAt: FROZEN_NOW - (i % 7) * HOUR,
    representativeRunIds: Array.from({ length: 5 }, (_, r) => `run_${String(i)}${String(r)}`),
    affectedAgentVersionIds: Array.from({ length: 20 }, (_, v) => `ver_${String(i)}_${String(v)}`),
    // Filled to the documented bound (MAX_AFFECTED_AGENT_IDS = 20) and flagged
    // truncated, because a fixture below its contract's bound measures a
    // payload smaller than the contract permits and understates the ceiling.
    affectedAgentIds: Array.from({ length: 20 }, (_, a) => `agent_${String(i)}_${String(a)}`),
    affectedAgentIdsTruncated: true,
    lastSpikeAssessment: {
      assessedAt: FROZEN_NOW - HOUR,
      isSpiking: i % 2 === 0,
      recentCount: 44,
      baselineMean: 6.25,
      z: 4.81,
    },
    lastPatternSpikeAlertFiredAt: FROZEN_NOW - 2 * HOUR,
    muted: false,
    mutedAt: FROZEN_NOW - 10 * DAY,
    status: (['open', 'acknowledged', 'resolved'] as const)[i % 3],
    acknowledgedAt: FROZEN_NOW - 5 * DAY,
    acknowledgedByUserId: 'user_2f9',
    resolvedAt: FROZEN_NOW - 4 * DAY,
    resolvedByUserId: 'user_2f9',
    resolutionNote:
      'Added retry with jitter on 429 from the provider, plus a circuit breaker after five consecutive failures.',
    resolutionRef: 'https://github.com/acme/agent/pull/812',
    regressedAt: FROZEN_NOW - 3 * DAY,
    resolvedInVersionId: 'ver_7c1',
    resolvedAtRunCount: 1204,
    resolvedAtOccurrenceCount: 41,
    lastFixConfidence: {
      computedAt: FROZEN_NOW - 5 * HOUR,
      basisResolvedAt: FROZEN_NOW - 4 * DAY,
      state: 'proving',
      score: 0.71,
      exposureRuns: 1802,
      observedRuns: 1900,
      exposureTruncated: false,
      versionAttribution: 'matched',
      recurred: false,
      limitingFactor: 'accumulating',
    },
    fixConfidenceRefreshAt: FROZEN_NOW + DAY,
    ...overrides,
  } as FailurePattern
}

/** The `fixConfidence` envelope the v1 list responses carry. */
export function fatEnvelope(
  patterns: readonly FailurePattern[],
  unevaluated: string[] = [],
): V1ListFixConfidenceEnvelope {
  return {
    stalenessBoundMs: 6 * HOUR,
    entries: patterns.map((p, i) => ({
      fingerprintHash: p.fingerprintHash,
      state: (['unproven', 'proving', 'confirmed', 'regressed'] as const)[i % 4],
      score: 0.42,
      computedAt: FROZEN_NOW - 2 * HOUR,
      ageMs: 2 * HOUR,
      stale: i % 3 === 0,
      basis: 'snapshot' as const,
    })),
    staleCount: 0,
    unevaluated,
  }
}

/**
 * Every field `Run` declares, with the unbounded bags filled hostilely.
 *
 * IT IS A MAXIMAL PAYLOAD, NOT A PRODUCIBLE ONE, and that is deliberate. This
 * fixture carries `sdkVersion` AND the ADR-007 `otel*` block at the same time,
 * which no ingest path emits — `otelTraceId` is set only by `otelIngestSpans`
 * and never by the SDK path. `checkMaximality` demands every declared field be
 * populated, and it is right to: a budget is a ceiling, and the ceiling is the
 * largest document the SCHEMA permits, not the largest one today's two writers
 * happen to produce. A projection that is lean against this is lean against
 * either real shape.
 */
export function fatRun(i: number): Run {
  return {
    id: 'run_' + String(i + 1).padStart(6, '0'),
    orgId: 'org_caller',
    projectId: 'proj_1',
    agentId: 'agent_a1',
    agentVersionId: 'ver_7c1',
    status: (['failed', 'completed', 'running', 'timed_out'] as const)[i % 4],
    startedAt: FROZEN_NOW - DAY + i * 60_000,
    endedAt: FROZEN_NOW - DAY + 30_000 + i * 60_000,
    metadata: { prompt: 'y'.repeat(2000), ticket: 'ACME-4412', region: 'us-east-1' },
    tags: ['nightly', 'regression-suite', 'high-priority'],
    triggeredBy: 'user_2f9',
    sdkVersion: '0.17.0',
    parentRunId: 'run_000000',
    sessionId: 'sess_31b',
    environment: 'production',
    labels: ['triage', 'flaky'],
    triageState: 'investigating',
    tokensIn: 120_400,
    tokensOut: 8_120,
    searchText: 'z'.repeat(3000),
    modelsSeen: ['claude-opus-5', 'claude-haiku-4'],
    // ADR-007 — the OTel-derived run block. Widths, not shapes, are what cost
    // bytes here, and each is at its true maximum:
    //   - a W3C trace id is EXACTLY 32 lowercase hex characters. Fixed width,
    //     so this is the maximum by definition. Varied per run because one
    //     trace is exactly one run — a hundred identical trace ids on one page
    //     is a payload the key constraint forbids.
    //   - a W3C span id is EXACTLY 16 lowercase hex characters.
    //   - `status` is the closed union `unset | ok | error`; `error` and
    //     `unset` tie at 5 characters, the widest available.
    //   - the nano fields are epoch NANOSECONDS as decimal strings, which at a
    //     2026 epoch are 19 digits — the widest they get this century.
    //   - `spanName` is unbounded in the contract and uncapped by the mapper,
    //     so it carries a realistically hostile fully-qualified span name, the
    //     same convention `fatProvenance` established.
    otelTraceId: String(i).padStart(4, '0') + '2f3577b34da6a3ce929d0e0e4736',
    otelRoot: {
      spanId: String(i).padStart(4, '0') + '67aa0ba902b7',
      spanName: 'openinference.agent.workflow.execute',
      status: 'error',
      endUnixNano: nanosOfMs(FROZEN_NOW - DAY + 30_000 + i * 60_000),
    },
    otelRootStartNano: nanosOfMs(FROZEN_NOW - DAY + i * 60_000),
    // Monotonic max over every event's temporal instant, so it is at or after
    // the root's end — same 19-digit width as the other nano fields.
    otelMaxInstantNano: nanosOfMs(FROZEN_NOW - DAY + 30_000 + i * 60_000),
    otelLastAppendAt: FROZEN_NOW - DAY + 45_000 + i * 60_000,
    // ADR-007 ordering counters. Both COUNT EVENTS IN ONE RUN, so their maximum
    // is not arbitrary and is not a taste question: a run is full at
    // `MAX_EVENTS_PER_RUN` (50,000 — `convex/helpers/pagination.ts`, which makes
    // `sequenceNumber > MAX_EVENTS_PER_RUN` the O(1) "run is full" check), so no
    // count of its events can exceed 50,000. Five digits, which is the width
    // that costs the bytes — same derivation as `depth: 999` from
    // `MAX_OTEL_SPANS_PER_BATCH` on the temporal key.
    //
    // BOTH AT THE CEILING, WHICH IS THE ONLY ASSIGNMENT THAT MAXIMISES BOTH AND
    // STAYS COHERENT. `otelUnkeyedDerivedCount <= derivedEventCount` is an
    // invariant, not a coincidence — the unkeyed events are a subset of the
    // derived ones — so a fixture that maxed the second past the first would be
    // INCOHERENT rather than maximal, the same failure `spanIdOf` exists to
    // prevent by making one span carry one id. Equality at the ceiling is
    // meaningful in its own right: every event derived and not one of them
    // keyed is exactly the `ingest-unverified` verdict, the worst case for the
    // ordering alarm this tier now raises.
    derivedEventCount: 50_000,
    otelUnkeyedDerivedCount: 50_000,
  } as unknown as Run
}

export const PAYLOAD_EXTERNALIZATION_THRESHOLD = 10 * 1024

/**
 * A MAXIMAL `OtelEventProvenance` — every optional field set, `lossReasons`
 * filled to the full closed union.
 *
 * WHY EVERY EVENT FIXTURE CARRIES ONE. `Event.provenance` is optional on the
 * stored entity but REQUIRED on the only contract that describes a derived
 * write (`OtelDerivedEventWrite`), so a window of derived events with full
 * provenance is not a hypothetical worst case — it is the ordinary shape of a
 * run ingested from OpenTelemetry. A tier-4 budget measured against events that
 * omit it is a budget measured against a payload the system does not produce,
 * which is the same class of fiction as the CONTRACT_MAX_EXPLANATION that cited
 * 5 sequence numbers where the contract permitted 20.
 *
 * `lossy: true` with all eight `lossReasons` is the largest record
 * `isProvenanceConsistent` will accept: `lossReasons` must be non-empty when
 * `lossy` is true, and must be absent or empty when it is false, so the maximum
 * is only reachable on the lossy branch.
 */
export function fatProvenance(seq: number): OtelEventProvenance {
  return {
    source: 'otel',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: spanIdOf(seq),
    parentSpanId: '00f067aa0ba902b7',
    spanName: 'openinference.chain.llm.invoke',
    scopeName: 'openinference.instrumentation.langchain',
    semconvVersion: '1.29.0',
    mapperVersion: '2026.7.1',
    lossy: true,
    lossReasons: [
      'attributes-dropped',
      'span-events-dropped',
      'span-links-dropped',
      'timing-approximated',
      'usage-partial',
      'payload-truncated',
      'status-approximated',
      'identity-synthesized',
    ],
    receivedAt: FROZEN_NOW + seq * 1200 + 40,
  }
}

/**
 * A MAXIMAL `TemporalOrderKey` — the ADR-007 sibling field that carries an
 * OTel-derived event's TEMPORAL truth, separately from `sequenceNumber`.
 *
 * WHY EVERY EVENT FIXTURE CARRIES ONE, for the same reason they all carry
 * {@link fatProvenance}: a derived event's `sequenceNumber` is only the order we
 * LEARNED about it, so a multi-batch trace — the ordinary shape of anything an
 * OTLP collector flushes — produces this key on every derived event. A tier-4
 * budget measured against events that omit it is a budget measured against a
 * payload the system does not produce.
 *
 * Every field at its true maximum, and each maximum is a WIDTH:
 *   - both nano fields are 19-digit decimal strings (epoch ns at a 2026 epoch).
 *   - they DIFFER, which is the expensive branch: equal values would be the
 *     unclamped case, and `readEventTiming` only emits a skew when a clamp was
 *     actually applied. The skew is sub-second so both stay 19 digits.
 *   - `phase` is the closed union `open | close`; `close` is the wider.
 *   - `depth` is unbounded in the contract, but its BYTE cost is its width. One
 *     OTLP batch is capped at `MAX_OTEL_SPANS_PER_BATCH` (1,000 — see
 *     `convex/helpers/pagination.ts`), and the deepest tree 1,000 spans can form
 *     is a linear chain, so 999 is the widest depth a single batch can reach.
 *   - `spanId` is {@link spanIdOf}, the SAME id the event's provenance carries.
 *     Two ids for one span would be an incoherent fixture, not a fatter one.
 */
export function fatTemporalOrder(seq: number): TemporalOrderKey {
  const effective = BigInt(nanosOfMs(FROZEN_NOW + seq * 1200))
  // ~412 ms of forward clamp: a child pushed to its parent's start instant.
  const skewNano = BigInt(412_837_009)
  return {
    instantUnixNano: effective.toString(),
    rawInstantUnixNano: (effective - skewNano).toString(),
    phase: 'close',
    depth: 999,
    spanId: spanIdOf(seq),
  }
}

/** An event whose payload was externalized: the row must carry the pointer only. */
export function externalizedEvent(seq: number): Event {
  return {
    id: 'ev_' + String(seq),
    runId: 'run_8f2c1a',
    orgId: 'org_caller',
    sequenceNumber: seq,
    type: 'llm.request',
    timestamp: FROZEN_NOW + seq * 1200,
    parentEventId: 'ev_' + String(Math.max(1, seq - 1)),
    payload: {
      type: '_externalized',
      originalType: 'llm.request',
      _artifact: {
        artifactId: 'art_' + String(seq),
        storageKey: `org_1/run_8f2c1a/ev_${String(seq)}.json`,
        storageBucket: 'afr-artifacts',
        checksum: 'sha256:9c1f2b7d4e8a3c6f1b9d2e5a8c4f7b1d3e6a9c2f5b8d1e4a7c3f6b9d2e5a8c4f',
        size: 41_203,
      },
    },
    provenance: fatProvenance(seq),
    temporalOrder: fatTemporalOrder(seq),
  } as unknown as Event
}

/**
 * An event whose payload is JUST UNDER the 10 KB externalization threshold, so
 * it is never externalized and reaches `toEventRow` for inlining verbatim. This
 * is the worst case the system can legally produce, and it is entirely
 * reachable — the SDK externalizes only ABOVE the threshold.
 */
export function nearThresholdEvent(seq: number): Event {
  return {
    id: 'ev_' + String(seq),
    runId: 'run_8f2c1a',
    orgId: 'org_caller',
    sequenceNumber: seq,
    type: 'llm.response',
    timestamp: FROZEN_NOW + seq * 1200,
    parentEventId: 'ev_' + String(Math.max(1, seq - 1)),
    payload: {
      type: 'llm.response',
      model: 'claude-opus-5',
      content: 'x'.repeat(PAYLOAD_EXTERNALIZATION_THRESHOLD - 200),
      finish_reason: 'stop',
    },
    provenance: fatProvenance(seq),
    temporalOrder: fatTemporalOrder(seq),
  } as unknown as Event
}

/**
 * A derived event with provenance but NO `temporalOrder` — the case that makes
 * a run's ordering unverifiable.
 *
 * DELIBERATELY NOT CONTRACT-MAXIMAL, in exactly one field, and it is not the
 * sample `checkMaximality` inspects (`nearThresholdEvent` is). `temporalOrder`
 * is OPTIONAL on `Event` and its absence on a DERIVED event is a meaningful
 * state, not a gap: the contract says it means "the ordering is unverifiable"
 * (`OrderingBasis`'s `ingest-unverified`). A fixture family that could only
 * express the populated case could not measure the alarm at all.
 *
 * Identical to {@link externalizedEvent} in every other respect, so a scenario
 * pair over the two differs ONLY by the response's `orderingBasis` field. That
 * is what makes the field's cost a measured delta rather than an estimate.
 */
export function unkeyedDerivedEvent(seq: number): Event {
  const event = externalizedEvent(seq) as Event & { temporalOrder?: unknown }
  delete event.temporalOrder
  return event
}

/** 100 transitions — the maximum `PatternResolutionEvidence` permits — each with an unbounded metadata bag. */
export function fatEvidence(): PatternResolutionEvidence {
  return {
    pattern: fatPattern(0),
    resolution: {
      resolvedAt: FROZEN_NOW - 4 * DAY,
      resolvedByUserId: 'user_2f9',
      resolutionNote: 'Added retry with jitter on 429 from the provider.',
      resolutionRef: 'https://github.com/acme/agent/pull/812',
      resolvedInVersionId: 'ver_7c1',
      resolvedInVersion: '2026.7.3',
      resolvedAtOccurrenceCount: 41,
      resolvedAtRunCount: 1204,
    },
    exposure: {
      since: FROZEN_NOW - 4 * DAY,
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
      timestamp: FROZEN_NOW - 4 * DAY + i * 60_000,
      metadata: { note: 'x'.repeat(400), previousStatus: 'open', requestId: 'req_' + String(i) },
    })),
  } as PatternResolutionEvidence
}

/**
 * Twenty citations on a 100,000-event run. `RunExplanation` bounds the array at
 * 20 entries but says nothing about the magnitude of a sequence number, and
 * `CITED_SEQUENCE_BYTE_CAP` is a BYTE budget for exactly that reason — six-digit
 * citations cost more than twice what two-digit ones do.
 */
export const WIDE_CITATIONS: readonly number[] = Array.from({ length: 20 }, (_, i) => 100_001 + i)

/** The largest explanation the contract permits: 2 KB summary + 1 KB + 1 KB. */
export function contractMaxExplanation(): RunExplanation {
  return {
    id: 'expl_1',
    orgId: 'org_caller',
    runId: 'run_8f2c1a',
    kind: 'llm',
    summary: 'S'.repeat(2048),
    rootCause: 'R'.repeat(1024),
    suggestedFix: 'F'.repeat(1024),
    citedSequenceNumbers: [1, 14, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39],
    failureClass: 'tool_error',
    generatedAt: FROZEN_NOW - HOUR,
    model: 'claude-opus-5',
    generationMs: 1840,
    version: 1,
  }
}

/** What the generator actually writes today — the typical, not the legal maximum. */
export function realisticExplanation(): RunExplanation {
  return {
    ...contractMaxExplanation(),
    summary:
      'The agent called the "search" tool three times; the third call returned HTTP 429 and the agent did not ' +
      'retry, so the run failed without producing an answer.',
    rootCause: 'Upstream search provider rate-limited the agent and no backoff was configured.',
    suggestedFix: 'Add exponential backoff with jitter to the search tool client.',
    citedSequenceNumbers: [1, 14, 22, 23, 24],
  }
}

// ---------------------------------------------------------------------------
// Version divergence — `afr_assess_version` / `afr_get_run_divergence`
// ---------------------------------------------------------------------------
//
// Maximal in the two directions that matter for these tools, which are not the
// same direction:
//
//   PROSE — the engine's own `provenClaim` / `speculativeConcern` /
//   `speculativeBecause` sentences are "one line by construction", which is a
//   property of the engine and not a guarantee of the contract. The contract
//   states no length bound at all, so the fixture writes long ones and the
//   projection's byte caps have to do the work. A fixture that wrote realistic
//   one-liners would measure a budget that holds only while the engine stays
//   terse.
//
//   LIST LENGTH — both reports carry unbounded finding and reason arrays
//   (`MAX_DIVERGENCE_REPRESENTATIVE_RUNS` bounds only the run-id samples). The
//   fixtures overflow every cap so the drop counters are exercised, and the
//   fleet fixture uses twelve reasons because "340 runs, 12 distinct reasons"
//   is the shape the tool exists to produce.

/** A long engine sentence. Deliberately past the projection's caps. */
function longClaim(subject: string, seq: number): string {
  return (
    `called tool \`${subject}\` at sequence ${String(seq)}; the target version declares no such tool, so this ` +
    'step could not have happened on it. The recorded arguments were accepted by the version that actually ran, ' +
    'and no equivalent tool is declared under a different name in the target snapshot either.'
  )
}

const DIVERGENCE_TOOLS: readonly string[] = [
  'search_web', 'read_file', 'run_sql', 'send_email', 'vector_lookup',
  'browse_page', 'write_file', 'shell_exec', 'calendar_read', 'crm_lookup',
  'ticket_create', 'pager_notify',
]

const PROVEN_KINDS: readonly ProvenDivergenceKind[] = [
  'tool_removed', 'tool_call_rejected_by_schema', 'model_removed', 'budget_exceeded', 'capability_removed',
]

const SPECULATIVE_KINDS: readonly SpeculativeDivergenceKind[] = [
  'system_prompt_changed', 'model_substituted', 'decoding_params_changed', 'tool_added',
  'tool_description_changed', 'tool_schema_widened', 'config_changed',
]

/** One proven divergence, with several proofs so `furtherProofs` is exercised. */
export function fatProvenDivergence(i: number): ProvenDivergence {
  const subject = DIVERGENCE_TOOLS[i % DIVERGENCE_TOOLS.length] ?? 'search_web'
  const seq = 42 + i * 7
  const proof = (n: number): DivergenceProof => ({
    citedEvent: { sequenceNumber: n, eventId: 'evt_' + String(n).padStart(8, '0'), eventType: 'tool.call' },
    targetConfigPath: 'tools[].name',
    recordedValue: subject,
    targetValue: null,
  })
  return {
    certainty: 'proven',
    kind: PROVEN_KINDS[i % PROVEN_KINDS.length] ?? 'tool_removed',
    dimension: 'tools',
    reasonKey: `tool_removed:${subject}`,
    provenClaim: longClaim(subject, seq),
    provenBy: [proof(seq), proof(seq + 3), proof(seq + 11)],
  }
}

/** One speculative divergence, every optional field populated. */
export function fatSpeculativeDivergence(i: number): SpeculativeDivergence {
  const subject = DIVERGENCE_TOOLS[(i + 5) % DIVERGENCE_TOOLS.length] ?? 'read_file'
  return {
    certainty: 'speculative',
    kind: SPECULATIVE_KINDS[i % SPECULATIVE_KINDS.length] ?? 'system_prompt_changed',
    dimension: 'system_prompt',
    reasonKey: `system_prompt_changed:${subject}`,
    speculativeConcern:
      'the system prompt differs between the recorded version and the target; tool selection, phrasing and the ' +
      'number of reasoning steps may all differ, or may be identical. Nothing recorded distinguishes these.',
    speculativeBecause:
      'recorded history cannot show what a different prompt would have produced, because the run was never ' +
      'executed under it and this analysis executes nothing.',
    changedConfigPath: 'systemPrompt',
    possiblyAffectedSequenceNumbers: Array.from({ length: 24 }, (_, n) => 100_001 + n),
  }
}

const INDETERMINATE_KINDS: readonly IndeterminateDivergenceKind[] = [
  'target_config_unreadable', 'recorded_history_incomplete', 'evidence_externalized', 'engine_limit',
]

/** One unanswerable question, every optional field populated. */
export function fatIndeterminateDivergence(i: number): IndeterminateDivergence {
  return {
    certainty: 'indeterminate',
    kind: INDETERMINATE_KINDS[i % INDETERMINATE_KINDS.length] ?? 'target_config_unreadable',
    reasonKey: `evidence_externalized:tool.call:${String(i)}`,
    undecidedQuestion:
      'whether the tool calls recorded at sequences 12, 19, 27, 44 and 61 target tools this version still ' +
      'declares. Their payloads were externalized past the 10 KB inline ceiling, so the event type survived and ' +
      'the tool name did not.',
    unknownBecause:
      'the deciding field was written to blob storage under Event Log Rule 3, and this analysis reads the event ' +
      'log only — it never fetches an artifact.',
    dimension: 'tools',
    remedy:
      're-publish this version with a structured `tools` declaration, or lower the payload size so `tool.call` ' +
      'arguments stay inline and the tool name survives in the event log.',
    possiblyAffectedSequenceNumbers: [12, 19, 27, 44, 61],
  }
}

/** Coverage with both halves populated: several dimensions assessed, several not, each with a detail. */
export function fatDivergenceCoverage(): DivergenceCoverage {
  return {
    assessed: ['tools', 'model', 'budgets', 'capabilities'],
    unassessed: [
      {
        dimension: 'system_prompt',
        reason: 'baseline_config_missing',
        detail: 'the run’s own agent version carries no configSnapshot, so "changed" cannot be established',
      },
      {
        dimension: 'decoding_params',
        reason: 'unsupported_config_shape',
        detail: 'target snapshot declares `sampling` as a string, not an object: sampling.temperature',
      },
    ],
    eventsExamined: 2_048,
    eventHistoryComplete: false,
  }
}

/** A single-run report that overflows every projection cap. */
export function fatDivergenceReport(): DivergenceReport {
  return {
    runId: 'run_8f2c1a',
    baselineVersionId: 'ver_3d91b7c2',
    targetVersionId: 'ver_9a04e6f1',
    analyzedAt: FROZEN_NOW - HOUR,
    // `incompatible` is what `computeDivergenceVerdict` yields for a report with
    // proven findings, whatever the coverage. Kept consistent with the contents
    // because `FlightReader` refuses a report whose verdict contradicts them —
    // an inconsistent fixture would measure a response the stack cannot deliver.
    verdict: 'incompatible',
    proven: Array.from({ length: 8 }, (_, i) => fatProvenDivergence(i)),
    speculative: Array.from({ length: 8 }, (_, i) => fatSpeculativeDivergence(i)),
    indeterminate: Array.from({ length: 8 }, (_, i) => fatIndeterminateDivergence(i)),
    coverage: fatDivergenceCoverage(),
  }
}

/** The scan window, every optional field populated and truncated. */
export function fatDivergenceScanWindow(): DivergenceScanWindow {
  return {
    since: FROZEN_NOW - 30 * DAY,
    until: FROZEN_NOW,
    runsScanned: 10_000,
    runsAnalyzed: 9_640,
    runsUnassessable: 360,
    runsSkippedForBudget: 1_240,
    scanTruncated: true,
    scanRowCeiling: 10_000,
    nextCursor: 'cursor_9f3a1c7e42b8',
  }
}

/** The fleet answer this pair exists to produce: many runs, twelve distinct reasons. */
export function fatFleetDivergenceReport(): FleetDivergenceReport {
  return {
    agentId: 'agent_5b7e',
    targetVersionId: 'ver_9a04e6f1',
    analyzedAt: FROZEN_NOW - HOUR,
    verdict: 'incompatible',
    provenReasons: Array.from({ length: 12 }, (_, i) => ({
      reasonKey: fatProvenDivergence(i).reasonKey,
      kind: fatProvenDivergence(i).kind,
      certainty: 'proven' as const,
      affectedRunCount: 340 - i * 21,
      representativeRunIds: Array.from({ length: 5 }, (_, n) => `run_${String(i)}${String(n)}c4f9a1b`),
      exemplar: fatProvenDivergence(i),
    })),
    speculativeReasons: Array.from({ length: 12 }, (_, i) => ({
      reasonKey: fatSpeculativeDivergence(i).reasonKey,
      kind: fatSpeculativeDivergence(i).kind,
      certainty: 'speculative' as const,
      affectedRunCount: 900 - i * 40,
      representativeRunIds: Array.from({ length: 5 }, (_, n) => `run_${String(i)}${String(n)}e7b2d3c`),
      exemplar: fatSpeculativeDivergence(i),
    })),
    indeterminateReasons: Array.from({ length: 12 }, (_, i) => ({
      reasonKey: fatIndeterminateDivergence(i).reasonKey,
      kind: fatIndeterminateDivergence(i).kind,
      certainty: 'indeterminate' as const,
      affectedRunCount: 300 - i * 17,
      representativeRunIds: Array.from({ length: 5 }, (_, n) => `run_${String(i)}${String(n)}a9f4e6d`),
      exemplar: fatIndeterminateDivergence(i),
    })),
    runsWithProvenDivergence: 340,
    window: fatDivergenceScanWindow(),
  }
}
