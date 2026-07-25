#!/usr/bin/env tsx
/**
 * check-token-budgets.ts
 *
 * Standing token-budget gate for `packages/mcp` — the `afr_*` MCP tool surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * Token cost IS the product claim. An agent spends ~331 tokens on `afr_triage`
 * learning what is broken instead of ~3,838 on `afr_get_run_events` fetching one
 * run it cannot yet choose. Nothing in the type system protects that: adding
 * `representativeRunIds` to a tier-1 row is a one-line change that type-checks,
 * passes every existing test, and silently destroys the reason the package
 * exists.
 *
 * Budgets WERE enforced — by assertions scattered across
 * tests/unit/mcp_progressive_disclosure.test.ts, mcp_triage_measure.test.ts,
 * mcp_triage.test.ts and others. Those caught real regressions and are not
 * replaced by this file. What they could not do:
 *
 *   1. NO SINGLE PLACE REPORTED EVERY BUDGET. The numbers published in
 *      docs/mcp.md ("Where the token figures come from") were re-derived by
 *      hand from several suites' stdout. Nobody could see the whole picture in
 *      one place, so nobody could see the picture drift.
 *   2. NOTHING FORCED A NEW TOOL TO DECLARE A BUDGET. A seventh `afr_*` tool
 *      registered tomorrow simply has no budget — not a failing one, none — and
 *      every existing assertion stays green. A guard that only checks the tools
 *      somebody remembered to list is the guard we already had.
 *   3. TIER 4's BUDGET WAS A RATIO. `TIER4_WINDOW_TOKEN_BUDGET =
 *      RAW_DUMP_TOKENS / 10` moves with its own numerator: raise the assumed
 *      raw-dump size and the ceiling rises with it, so a change that moves both
 *      stays green while the absolute an agent actually pays drifts upward.
 *
 * WHAT THIS FILE DOES INSTEAD
 * ---------------------------
 * EXHAUSTIVE BY CONSTRUCTION. The tool list is read from the SERVER'S OWN
 * REGISTRATION — `createServer()` is called and its registry is enumerated —
 * never from a hand-written list here. A registered tool with no declared
 * budget is a FAILURE (`NO_BUDGET`), and a declared budget for a tool that is
 * no longer registered is a failure too (`STALE_BUDGET`). Adding a tool
 * therefore cannot be done quietly.
 *
 * MEASURED END TO END. Each scenario invokes the REGISTERED TOOL HANDLER
 * against a stub reader, and measures the exact `text` the MCP client receives
 * (tools/shared.ts `jsonResult` → `JSON.stringify`, no indentation). Not the
 * projection in isolation: a tool that wraps a lean projection in a fat
 * envelope is over budget, and only the handler's own output can show that.
 *
 * ONE ESTIMATOR, NOT TWO. {@link estimateTokens} is
 * `ceil(utf8Bytes(JSON.stringify(x)) / 4)` — the expression
 * `tests/unit/mcp_budgets.ts` declares for every MCP suite, and the one
 * docs/mcp.md publishes. Two ways of counting that can disagree is precisely
 * the drift this project keeps paying for. It is not imported from there at
 * runtime — that module reaches `@agent-flight-recorder/mcp` by package name,
 * which resolves cleanly under vitest and awkwardly across the CJS seam from
 * `scripts/` — so `tests/unit/token_budget_guard.test.ts` proves the two agree
 * payload-for-payload instead, and any divergence fails there.
 *
 * ABSOLUTES ONLY, RATIOS AS COMMENTARY. Every budget below is an integer token
 * count with its derivation written next to it. Ratios (against the
 * un-projected input, against the 100k raw dump) are computed and printed
 * because they are the durable, fixture-independent part of the argument — but
 * nothing here PASSES on a ratio. Tier 4's `10_000` is written as `10_000`.
 *
 * THE RATCHET. scripts/token-budget-baseline.json records every measured value.
 *   - measured  >  budget    FAIL. The published ceiling was breached.
 *   - measured  >  baseline  FAIL, separately and with a different message: the
 *                            budget is a ceiling, the baseline is where we
 *                            actually are, and silent upward drift inside the
 *                            headroom is exactly how a ceiling gets reached.
 *                            An intended increase is recorded with
 *                            `--write-baseline` and lands as a visible number
 *                            change in the same commit.
 *   - measured  <  baseline  PASS, and prints the delta with an instruction to
 *                            lower the baseline in the same commit. Failing on
 *                            an improvement is how ratchets get deleted; a
 *                            stale-high baseline cannot hide, because the delta
 *                            prints on every single run.
 * `--write-baseline` refuses outright to record a value above its budget.
 *
 * FIXTURES ARE PROVED MAXIMAL, NOT CLAIMED MAXIMAL. A budget measured against a
 * fixture that is missing half the contract's optional fields is a budget
 * measured against a payload the system cannot actually produce. So the
 * contracts source is PARSED (TypeScript AST) and every declared property of
 * `FailurePattern`, `Run`, `Event`, `RunExplanation` and the evidence envelope
 * must be populated by the fixture. A field added to a contract without being
 * added to the fixture fails as `FIXTURE_NOT_MAXIMAL` — the guard notices that
 * its own inputs went stale.
 *
 * FAILURES NAME THE FIELD, NOT THE NUMBER. A blown budget prints per-field byte
 * attribution (per-column for the columnar list tools, where a name is paid
 * once and values per row; per-key, recursing one level into uniform arrays,
 * for everything else). "expected 465 to be <= 300" is a failure nobody can
 * act on, and a failure nobody can act on gets deleted the first time it goes
 * red.
 *
 * BUILD REQUIRED
 * --------------
 * This script imports `packages/mcp/src/**` as SOURCE (so it measures the tree,
 * not a stale bundle), but that source imports `@agent-flight-recorder/sdk` and
 * `@agent-flight-recorder/contracts` by package name, which resolve to their
 * `dist/`. So `pnpm build` (or at least `--filter ...sdk --filter ...contracts`)
 * MUST have run. Missing dist is a hard, explained failure rather than an
 * inscrutable resolution error; a dist OLDER than its own src prints a loud
 * staleness warning, because a failed tsup leaves the previous output in place
 * and a measurement taken against yesterday's SDK is not a measurement.
 *
 * KNOWN LIMITS (stated so nobody mistakes a pass for proof)
 * ------------
 *   - THE ESTIMATOR IS NOT A TOKENIZER. bytes/4 is the standard rough BPE
 *     approximation. It is monotonic in payload size, which is the only
 *     property a ratchet needs, and the budgets carry enough headroom that
 *     ±20% estimator error does not flip a verdict. It is NOT a promise about
 *     what any particular model's tokenizer will charge.
 *   - THESE ARE FIXTURE MEASUREMENTS, NOT DEPLOYMENT MEASUREMENTS. Tier 4's
 *     real cost depends on the caller's own event payloads. The scenarios
 *     measure the worst case the system can LEGALLY produce, which is a
 *     ceiling, not a typical value.
 *   - ERROR PATHS ARE NOT BUDGETED. Every scenario is a success response. A
 *     tool that returns a 12 KB error message is invisible here.
 *   - THE CLOCK IS FROZEN. `afr_triage` emits a recency-decayed `score`, so a
 *     live `Date.now()` makes the byte count drift with wall-clock time and the
 *     ratchet unusable. `Date.now` is pinned to the shared fixtures' FROZEN_NOW
 *     for the duration of a measurement and restored after, so every fixture
 *     timestamp is a fixed offset from a fixed clock.
 *
 * Run: pnpm tsx scripts/check-token-budgets.ts
 *      pnpm tsx scripts/check-token-budgets.ts --attribution   # per-field breakdown for every row
 *      pnpm tsx scripts/check-token-budgets.ts --json          # machine-readable measurements
 *      pnpm tsx scripts/check-token-budgets.ts --write-baseline
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from 'typescript'

const __filename_ = fileURLToPath(import.meta.url)
const REPO_ROOT = path.join(path.dirname(__filename_), '..')

const MCP_SRC = path.join(REPO_ROOT, 'packages/mcp/src')
const CONTRACTS_SRC = path.join(REPO_ROOT, 'packages/contracts/src')
const BASELINE_FILE = path.join(REPO_ROOT, 'scripts/token-budget-baseline.json')

const rel = (p: string): string => path.relative(REPO_ROOT, p)

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const RED = '[0;31m'
const GREEN = '[0;32m'
const YELLOW = '[1;33m'
const CYAN = '[0;36m'
const DIM = '[2m'
const BOLD = '[1m'
const RESET = '[0m'

// ─── The estimator. ONE definition, deliberately. ─────────────────────────────

/**
 * `estimateTokens(x) = ceil(utf8ByteLength(JSON.stringify(x)) / 4)`.
 *
 * IDENTICAL, character for character in effect, to the estimator in
 * tests/unit/mcp_progressive_disclosure.test.ts and
 * tests/unit/mcp_triage_measure.test.ts, and to the formula docs/mcp.md
 * publishes. It is not re-derived, re-tuned or "improved" here: a second way of
 * counting that can disagree with the first is the drift this whole gate exists
 * to remove, relocated one layer up.
 *
 * tests/unit/token_budget_guard.test.ts asserts that agreement mechanically, by
 * reading the formula out of those test files rather than trusting this comment.
 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 4)
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

// ─── Per-field byte attribution ───────────────────────────────────────────────

/**
 * Per-column attribution for a columnar (`{fields, rows}`) result.
 *
 * The field NAME is paid once in the header; each row pays only its value.
 * Reporting them apart is the point — it is what shows which column to cut, and
 * why going columnar moved the cost from names to values in the first place.
 */
export function attributeColumns(fields: readonly string[], rows: readonly (readonly unknown[])[]): string[] {
  return fields
    .map((f, i) => ({
      field: f,
      name: byteLength(JSON.stringify(f)) + 1,
      values: rows.reduce((sum, row) => sum + byteLength(JSON.stringify(row[i]) ?? 'null') + 1, 0),
    }))
    .sort((a, b) => b.values - a.values)
    .map(
      (c) =>
        `${c.field.padEnd(22)} ${String(c.values).padStart(7)} B values (~${Math.ceil(c.values / 4)} tok)` +
        `  + ${String(c.name)} B name, paid once`,
    )
}

/** Per-key attribution across uniform records, biggest first. */
export function attributeRecords(rows: readonly Record<string, unknown>[]): string[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const cost = byteLength(JSON.stringify(key)) + 1 + byteLength(JSON.stringify(value) ?? 'null') + 1
      totals.set(key, (totals.get(key) ?? 0) + cost)
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, b]) => `${k.padEnd(22)} ${String(b).padStart(7)} B (~${Math.ceil(b / 4)} tok)`)
}

function isUniformRecordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  )
}

/**
 * Attribution for one tool response, whatever encoding it uses.
 *
 * Columnar results are attributed by column; everything else by top-level key,
 * recursing ONE level into a uniform array of objects (a triage `items` list, a
 * tier-4 `events` window) — which is where a widened row actually hides. Deeper
 * recursion would bury the headline under a tree; one level names the field.
 */
export function attribute(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  if (Array.isArray(record['fields']) && Array.isArray(record['rows'])) {
    return attributeColumns(record['fields'] as string[], record['rows'] as unknown[][])
  }
  const lines: string[] = []
  const entries = Object.entries(record)
    .map(([k, v]) => [k, v, byteLength(JSON.stringify(v) ?? 'null')] as const)
    .sort((a, b) => b[2] - a[2])
  for (const [key, child, bytes] of entries) {
    lines.push(`${key.padEnd(22)} ${String(bytes).padStart(7)} B (~${Math.ceil(bytes / 4)} tok)`)
    if (isUniformRecordArray(child)) {
      for (const nested of attributeRecords(child)) lines.push(`  └ ${nested}`)
    }
  }
  return lines
}

// ─── Contract-maximality: parse the contracts, do not transcribe them ─────────

/**
 * Property names declared on an exported interface in the contracts source.
 *
 * Parsed rather than listed, for the same reason check-design-tokens.ts parses
 * design.md: a transcribed list is a second source of truth that goes stale
 * silently, and a fixture measured against a stale contract understates the
 * payload the system can legally produce.
 */
export function interfaceMembers(file: string, interfaceName: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue
        const name = member.name
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) found.push(name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (found.length === 0) {
    throw new Error(
      `${rel(file)}: interface \`${interfaceName}\` has no parsed members. The contract was renamed or ` +
        `restructured — fix the parse in ${rel(__filename_)} rather than shipping a maximality check that ` +
        `sanctions an empty fixture.`,
    )
  }
  return found
}

/** One `(contract type, fixture)` pair the fixtures claim to saturate. */
interface MaximalityClaim {
  readonly label: string
  readonly file: string
  readonly interfaceName: string
  readonly sample: () => Record<string, unknown>
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// CONTRACT-MAXIMAL, and mechanically checked to be (see MaximalityClaim above).
// The approach is the one tests/unit/mcp_progressive_disclosure.test.ts
// established: every optional field populated, every bounded array filled to its
// documented bound (representativeRunIds <= 5, affectedAgentVersionIds <= 20,
// transitions <= 100), every unbounded field (`metadata`, `searchText`) carrying
// a realistically hostile amount of data. A projection is only proven lean if
// the thing it projected from was not.

/**
 * THE FIXTURES ARE NOT DECLARED HERE. They live in `tests/unit/mcp_budgets.ts`,
 * which is already the single declaration of the estimator and the tier
 * budgets, and they are imported from there.
 *
 * WHY THAT DIRECTION, given this file is the one with the maximality proof.
 * Four fixture families existed — one per mcp suite, plus one here — and they
 * disagreed: for the SAME tool and scenario this script measured 294 where the
 * suite measured 284, and 332 where it measured 331. Neither was wrong on its
 * own terms, which is exactly why it could persist. The question was only which
 * home is correct, and the deciding argument is TYPES: `tests/tsconfig.json`
 * keeps `strict` + `exactOptionalPropertyTypes` on so that a fixture which
 * drifts from its contract fails typecheck, and that only works where the
 * fixtures can be typed against `@agent-flight-recorder/contracts`. This script
 * runs under tsx against built `dist/` and deliberately holds no compile-time
 * dependency on those types, so hosting them here would have traded the cheap
 * half of drift detection for the expensive half. Now both apply to one family:
 * typecheck catches a shape that stopped matching, and {@link checkMaximality}
 * catches a contract field the fixture stopped populating.
 *
 * THE INTEROP UNWRAP BELOW IS LOAD-BEARING, not defensive noise. `tests/` has no
 * `"type": "module"`, so tsx loads that file as CJS and its named exports arrive
 * on `default` rather than on the namespace — under vitest, which loads it as
 * ESM, they arrive on the namespace. Both shapes are handled, and a module that
 * satisfies neither fails loudly instead of yielding `undefined` fixtures that
 * would silently measure `{}` and report a triumphantly small number.
 */
export interface McpFixtures {
  readonly FROZEN_NOW: number
  fatPattern(i: number, overrides?: Record<string, unknown>): Record<string, unknown>
  fatEnvelope(patterns: readonly Record<string, unknown>[], unevaluated?: string[]): unknown
  fatRun(i: number): Record<string, unknown>
  externalizedEvent(seq: number): Record<string, unknown>
  nearThresholdEvent(seq: number): Record<string, unknown>
  fatEvidence(): Record<string, unknown>
  contractMaxExplanation(): Record<string, unknown>
  realisticExplanation(): Record<string, unknown>
  readonly WIDE_CITATIONS: readonly number[]
}

const FIXTURES_MODULE = path.join(REPO_ROOT, 'tests/unit/mcp_budgets.ts')

const REQUIRED_FIXTURE_EXPORTS: readonly (keyof McpFixtures)[] = [
  'FROZEN_NOW', 'fatPattern', 'fatEnvelope', 'fatRun', 'externalizedEvent',
  'nearThresholdEvent', 'fatEvidence', 'contractMaxExplanation', 'realisticExplanation', 'WIDE_CITATIONS',
]

export async function loadFixtures(file: string = FIXTURES_MODULE): Promise<McpFixtures> {
  if (!fs.existsSync(file)) {
    throw new Error(
      `${rel(file)} is missing. It is the single declaration of the contract-maximal fixtures every budget here ` +
        'is measured against. If it moved, point FIXTURES_MODULE at its new home — do NOT re-declare the ' +
        'fixtures in this file, which is the duplication this seam exists to remove.',
    )
  }
  const raw: unknown = await import(pathToFileURL(file).href)
  const ns = raw as Record<string, unknown>
  // CJS under tsx puts the named exports on `default`; ESM under vitest puts
  // them on the namespace. Prefer whichever actually carries them.
  const candidate = (typeof ns['fatPattern'] === 'function' ? ns : ns['default']) as Record<string, unknown> | undefined
  const missing = REQUIRED_FIXTURE_EXPORTS.filter((k) => candidate?.[k] === undefined)
  if (candidate === undefined || missing.length > 0) {
    throw new Error(
      `${rel(file)} does not export ${missing.join(', ')}. The shared fixture family changed shape. Fix the ` +
        'seam rather than letting this check fall back to fixtures of its own — a budget measured against an ' +
        'empty object is a triumphantly small number that means nothing.',
    )
  }
  return candidate as unknown as McpFixtures
}

/**
 * The `(contract, fixture)` pairs whose saturation is asserted, not assumed.
 *
 * This is the half of fixture-drift detection that typecheck cannot do: a
 * fixture missing an OPTIONAL contract field still typechecks perfectly, and
 * still under-states the payload the system can legally produce. Ten tokens of
 * imaginary tier-1 headroom is exactly what that looks like.
 */
export const maximalityClaims = (f: McpFixtures): readonly MaximalityClaim[] => [
  {
    label: 'FailurePattern',
    file: path.join(CONTRACTS_SRC, 'failure_patterns.ts'),
    interfaceName: 'FailurePattern',
    sample: () => f.fatPattern(0),
  },
  {
    label: 'Run',
    file: path.join(CONTRACTS_SRC, 'entities.ts'),
    interfaceName: 'Run',
    sample: () => f.fatRun(0),
  },
  {
    label: 'Event',
    file: path.join(CONTRACTS_SRC, 'entities.ts'),
    interfaceName: 'Event',
    sample: () => f.nearThresholdEvent(1),
  },
  {
    label: 'RunExplanation',
    file: path.join(CONTRACTS_SRC, 'run_explanations.ts'),
    interfaceName: 'RunExplanation',
    sample: () => f.contractMaxExplanation(),
  },
  {
    label: 'PatternResolutionEvidence',
    file: path.join(CONTRACTS_SRC, 'failure_patterns.ts'),
    interfaceName: 'PatternResolutionEvidence',
    sample: () => f.fatEvidence(),
  },
  {
    label: 'PatternResolutionMetadata',
    file: path.join(CONTRACTS_SRC, 'failure_patterns.ts'),
    interfaceName: 'PatternResolutionMetadata',
    sample: () => f.fatEvidence()['resolution'] as Record<string, unknown>,
  },
  {
    label: 'PatternResolutionExposure',
    file: path.join(CONTRACTS_SRC, 'failure_patterns.ts'),
    interfaceName: 'PatternResolutionExposure',
    sample: () => f.fatEvidence()['exposure'] as Record<string, unknown>,
  },
  {
    label: 'FixConfidenceResult',
    file: path.join(CONTRACTS_SRC, 'failure_patterns.ts'),
    interfaceName: 'FixConfidenceResult',
    sample: () => f.fatEvidence()['confidence'] as Record<string, unknown>,
  },
  {
    label: 'FixConfidenceSnapshot',
    file: path.join(CONTRACTS_SRC, 'failure_patterns.ts'),
    interfaceName: 'FixConfidenceSnapshot',
    sample: () => f.fatPattern(0)['lastFixConfidence'] as Record<string, unknown>,
  },
]

// ─── Scenarios and their budgets ──────────────────────────────────────────────

/** The stub reader slice a scenario supplies. Only what its tool actually calls. */
export interface StubReader {
  listRuns?: (filters?: unknown) => Promise<unknown>
  getFailurePatterns?: (filters?: unknown) => Promise<unknown>
  getFailurePatternEvidence?: (fingerprintHash: string) => Promise<unknown>
  getExplanation?: (runId: string) => Promise<unknown>
  getRunEventWindow?: (runId: string, options: { limit?: number }) => Promise<unknown>
  iterateEvents?: (runId: string, options?: unknown) => AsyncIterable<unknown>
}

export interface Scenario {
  readonly tool: string
  readonly name: string
  /**
   * ABSOLUTE token ceiling. Never a ratio, never derived from another budget at
   * runtime — a ceiling that moves with its own inputs is not a ceiling.
   */
  readonly budget: number
  /** Why this number. An undocumented ceiling gets raised the first time it goes red. */
  readonly why: string
  readonly args: Record<string, unknown>
  readonly reader: StubReader
  /**
   * The un-projected input, for the INFORMATIONAL saving ratio. Never asserted
   * on: a projection can keep a 40x ratio while doubling in absolute cost.
   */
  readonly rawInput?: () => unknown
  /**
   * PRE-EXISTING, DOCUMENTED DEBT: this scenario is already over its budget when
   * the guard lands, by an amount that is recorded here and may only ever fall.
   *
   * This is NOT a waiver, and it is deliberately not spelled like one. The
   * budget above is untouched — the published claim does not move — and the
   * breach is reported on every single run. What it buys is the same thing
   * check-design-tokens.ts's frozen tier bought: a check that can be turned ON
   * against a tree that already has debt, instead of one that is switched off
   * on day one because it lands red.
   *
   * It is self-cleaning in both directions:
   *   - measured ABOVE `tokens`  → OVER_BUDGET, blocking. The debt may not grow.
   *   - measured AT OR UNDER the budget → STALE_BREACH, blocking, demanding this
   *     entry be deleted. A breach note that no longer describes anything is how
   *     an exemption rots into a blanket mute.
   */
  readonly knownBreach?: {
    /** The measured value when the breach was recorded. A ceiling, not a target. */
    readonly tokens: number
    /** Who owns the fix and what the fix is. A breach nobody can action is a permanent excuse. */
    readonly why: string
  }
}

/**
 * The premise the whole package rests on: a 50-step run dumped raw is ~100k
 * tokens. Used ONLY to print the tier-4 ratio as commentary. Tier 4's budget
 * below is the literal integer `10_000`, NOT `RAW_DUMP_TOKENS / 10` — that
 * division was the defect: raising the assumed dump size silently raised the
 * ceiling, so the absolute an agent pays could drift while the check stayed
 * green.
 */
export const RAW_DUMP_TOKENS = 100_000

/**
 * Every measured scenario, built against the shared fixture family.
 *
 * A FUNCTION of the fixtures rather than a module-level constant, so there is no
 * way to reach for a locally-declared fixture by accident: everything a scenario
 * measures arrives through `f`.
 */
export function buildScenarios(f: McpFixtures): readonly Scenario[] {
  const patternsPage = (n: number, extra: Record<string, unknown> = {}): unknown => {
    const patterns = Array.from({ length: n }, (_, i) => f.fatPattern(i))
    return { patterns, fixConfidence: f.fatEnvelope(patterns), ...extra }
  }

  const runsPage = (n: number): unknown => ({
    runs: Array.from({ length: n }, (_, i) => f.fatRun(i)),
    nextCursor: 'cursor_31b',
  })

  /** `fetchEventWindow` asks for limit+1 so `nextFromSequence` is a fact; give it one. */
  const eventWindow = (make: (seq: number) => Record<string, unknown>) => ({
  getRunEventWindow: (_runId: string, options: { limit?: number }): Promise<unknown> =>
    Promise.resolve({
      events: Array.from({ length: options.limit ?? 21 }, (_, i) => make(18 + i)),
      fromSequence: 18,
    }),
  // eslint-disable-next-line @typescript-eslint/require-await -- an async generator with no awaits is the point: it is never reached on this path.
  iterateEvents: async function* (): AsyncIterable<unknown> {
    /* unreachable: getRunEventWindow above is honored */
  },
})

  // The tools are NOT enumerated here — they are read from the server's own
  // registry, and a registered tool missing from this table is a `NO_BUDGET`
  // failure. This table declares the FIXTURES AND CEILINGS for the tools that
  // exist; it can never be the list of tools that get checked.
  return [
  // ── afr_triage — tier 0, the entry point ──────────────────────────────────
  {
    tool: 'afr_triage',
    name: 'typical — full 50-pattern scan, nothing degraded',
    budget: 450,
    why:
      'Tier 2 is 450, and the argument for triage existing at all is that it must cost LESS than calling ' +
      'tiers 1 and 2 yourself (~707). Above 450 it is a fifth tier pretending to be a shortcut.',
    args: {},
    reader: { getFailurePatterns: () => Promise.resolve(patternsPage(50)) },
    rawInput: () => Array.from({ length: 50 }, (_, i) => f.fatPattern(i)),
  },
  {
    tool: 'afr_triage',
    name: 'worst case — truncated scan + unevaluated + every item muted',
    budget: 450,
    why: 'Same ceiling, measured against every caveat firing at once. This is the case the published number must survive.',
    args: {},
    reader: {
      getFailurePatterns: () => {
        const patterns = Array.from({ length: 50 }, (_, i) => f.fatPattern(i, { muted: true }))
        return Promise.resolve({
          patterns,
          fixConfidence: f.fatEnvelope(
            patterns,
            patterns.slice(0, 6).map((p) => String(p['fingerprintHash'])),
          ),
          nextCursor: 'cursor_abc123',
          scanTruncated: true,
        })
      },
    },
  },
  {
    tool: 'afr_triage',
    name: 'nothing broken — verdict: clear',
    budget: 450,
    why: 'The healthy-org case. Cheap by construction; budgeted anyway so an "everything is fine" response cannot quietly grow an envelope.',
    args: {},
    reader: { getFailurePatterns: () => Promise.resolve({ patterns: [], fixConfidence: f.fatEnvelope([]) }) },
  },

  // ── afr_list_failure_patterns — tier 1 ────────────────────────────────────
  {
    tool: 'afr_list_failure_patterns',
    name: '10 maximal patterns (the published tier-1 figure)',
    budget: 300,
    why:
      'The number docs/mcp.md publishes and tests/unit/mcp_progressive_disclosure.test.ts asserts. ~28 tok/row ' +
      'against ~215 for the values alone; going lower means dropping a mandated column.',
    args: { limit: 10 },
    reader: { getFailurePatterns: () => Promise.resolve(patternsPage(10)) },
    rawInput: () => Array.from({ length: 10 }, (_, i) => f.fatPattern(i)),
  },
  {
    tool: 'afr_list_failure_patterns',
    name: 'default page — 20 maximal patterns',
    budget: 600,
    why:
      'DEFAULT_LIMIT is 20, so this — not the 10-row figure — is what an agent that passes no limit actually ' +
      'pays. Twice the 10-row budget, because the columnar header is paid once and the rows are uniform.',
    args: {},
    reader: { getFailurePatterns: () => Promise.resolve(patternsPage(20)) },
    rawInput: () => Array.from({ length: 20 }, (_, i) => f.fatPattern(i)),
  },
  {
    tool: 'afr_list_failure_patterns',
    name: 'saturated page — 100 maximal patterns at MAX_LIMIT',
    budget: 2_800,
    why:
      'The largest response this tool can be made to emit. It must stay well under tier 4 (10,000) or the ' +
      '"cheapest question in the product" stops being cheap at the only limit a caller can actually ask for.',
    args: { limit: 100 },
    reader: { getFailurePatterns: () => Promise.resolve(patternsPage(100)) },
    rawInput: () => Array.from({ length: 100 }, (_, i) => f.fatPattern(i)),
  },

  // ── afr_get_pattern_evidence — tier 2 ─────────────────────────────────────
  {
    tool: 'afr_get_pattern_evidence',
    name: 'one pattern, 100 inbound lifecycle transitions',
    budget: 450,
    why:
      'The contract bounds transitions at 100 — a UI bound, not an MCP bound. 450 is what the tier costs with ' +
      'TRANSITIONS_CAP at 10 and the unbounded per-transition metadata bag dropped.',
    args: { fingerprintHash: '01f3a9c1d4e7b2' },
    reader: { getFailurePatternEvidence: () => Promise.resolve(f.fatEvidence()) },
    rawInput: () => f.fatEvidence(),
  },

  // ── afr_explain_run — tier 3 ──────────────────────────────────────────────
  {
    tool: 'afr_explain_run',
    name: 'realistic explanation',
    budget: 200,
    why: 'The tier exists to be ~1/30th of tier 4. 200 is the published ceiling; the realistic case measures far under it.',
    args: { runId: 'run_8f2c1a' },
    reader: {
      getExplanation: () =>
        Promise.resolve({ explanation: f.realisticExplanation(), status: 'ready', runStatus: 'failed' }),
    },
    rawInput: () => f.realisticExplanation(),
  },
  {
    tool: 'afr_explain_run',
    name: 'contract-maximal explanation — 2 KB summary + 1 KB cause + 1 KB fix',
    budget: 200,
    why:
      'Same ceiling against the largest explanation RunExplanation permits (~1,000 tokens of prose unprojected). ' +
      'This is what proves the projection enforces its OWN byte caps rather than relying on the generator ' +
      'happening to write short prose.',
    args: { runId: 'run_8f2c1a' },
    reader: {
      getExplanation: () =>
        Promise.resolve({ explanation: f.contractMaxExplanation(), status: 'ready', runStatus: 'failed' }),
    },
    rawInput: () => f.contractMaxExplanation(),
  },
  {
    tool: 'afr_explain_run',
    name: 'contract-maximal explanation on a 100k-event run — 20 SIX-DIGIT citations',
    budget: 200,
    why:
      'CITED_SEQUENCE_BYTE_CAP is a BYTE cap precisely because a sequence number’s WIDTH grows with run length ' +
      '(Event Log Rule 4: per-run integers from 1), so "10 citations" would be the same cheap-by-luck bound one ' +
      'level down. Its docstring claims the tier holds "for any citation count and any sequence-number width" — ' +
      'this is the scenario that makes that claim falsifiable rather than asserted.',
    args: { runId: 'run_8f2c1a' },
    reader: {
      getExplanation: () =>
        Promise.resolve({
          explanation: { ...f.contractMaxExplanation(), citedSequenceNumbers: f.WIDE_CITATIONS },
          status: 'ready',
          runStatus: 'failed',
        }),
    },
  },
  {
    tool: 'afr_explain_run',
    name: 'no explanation yet — pending',
    budget: 200,
    why: 'The retry-discriminant path. Budgeted so the honest three-way answer cannot grow into a paragraph.',
    args: { runId: 'run_8f2c1a' },
    reader: {
      getExplanation: () => Promise.resolve({ explanation: null, status: 'not_eligible', runStatus: 'running' }),
    },
  },

  // ── afr_get_run_events — tier 4, the expensive one ────────────────────────
  {
    tool: 'afr_get_run_events',
    name: 'saturated 50-event window — every payload externalized',
    budget: 10_000,
    why:
      'AN ABSOLUTE, deliberately not `RAW_DUMP_TOKENS / 10`. The derivation is the same — a fully saturated ' +
      'window must stay an order of magnitude under the ~100k raw dump this package exists to prevent, or the ' +
      'tier has no reason to exist — but it is FROZEN as an integer, so moving the assumed dump size can no ' +
      'longer move the ceiling with it. The ratio is printed as commentary, never asserted.',
    args: { runId: 'run_8f2c1a', fromSequence: 18, limit: 50 },
    reader: eventWindow(f.externalizedEvent),
    rawInput: () => Array.from({ length: 50 }, (_, i) => f.externalizedEvent(18 + i)),
  },
  {
    tool: 'afr_get_run_events',
    name: 'saturated 50-event window — 10,040-byte INLINE payloads, just under the externalization threshold',
    budget: 10_000,
    why:
      'The hole an event-count cap does not close: MAX_LIMIT caps EVENTS, an agent pays for BYTES. Fifty ' +
      'payloads of 10,040 B is ~125,000 tokens unbudgeted — MORE than the raw dump. This scenario is the ' +
      'standing proof that PAYLOAD_PREVIEW_BYTE_CAP and WINDOW_PAYLOAD_BYTE_BUDGET are still doing their job.',
    args: { runId: 'run_8f2c1a', fromSequence: 18, limit: 50 },
    reader: eventWindow(f.nearThresholdEvent),
    rawInput: () => Array.from({ length: 50 }, (_, i) => f.nearThresholdEvent(18 + i)),
  },
  {
    tool: 'afr_get_run_events',
    name: 'includeProvenance — 40 fully-derived events at MAX_LIMIT_WITH_PROVENANCE',
    budget: 10_000,
    why:
      'THE OPT-IN PATH SHIPPED WITH NO DECLARED BUDGET, which is precisely the `NO_BUDGET` hole this file ' +
      'exists to close — the guard measures declared scenarios, and a scenario nobody wrote is a ceiling ' +
      'nobody holds. `includeProvenance: true` swaps the ~38 B compact marker for the full ~500 B ' +
      'OtelEventProvenance record, a >13x per-event increase on the single most expensive tier. The reduced ' +
      'limit (MAX_LIMIT_WITH_PROVENANCE = 40, REJECTED not clamped) is the only thing keeping it under the ' +
      'same 10,000 ceiling the compact path holds; this scenario is what makes that dependency falsifiable. ' +
      'Fifty of these events measured 10,857 — the ceiling was held and the limit was lowered, not the ' +
      'reverse.',
    args: { runId: 'run_8f2c1a', fromSequence: 18, limit: 40, includeProvenance: true },
    reader: eventWindow(f.externalizedEvent),
    rawInput: () => Array.from({ length: 40 }, (_, i) => f.externalizedEvent(18 + i)),
  },

  // ── afr_list_runs — orientation ───────────────────────────────────────────
  {
    tool: 'afr_list_runs',
    name: 'default page — 20 maximal runs',
    budget: 600,
    why:
      'AN ABSOLUTE, where the existing suite asserts only a >=10x ratio. A ratio alone cannot fail: `Run` grew ' +
      'four fields this year and the ratio improved every time while the row got no cheaper. 600 is the ' +
      'published ~475 with headroom for one more scalar column.',
    args: {},
    reader: { listRuns: () => Promise.resolve(runsPage(20)) },
    rawInput: () => Array.from({ length: 20 }, (_, i) => f.fatRun(i)),
  },
  {
    tool: 'afr_list_runs',
    name: 'saturated page — 100 maximal runs at MAX_LIMIT',
    budget: 2_800,
    why: 'The largest response this tool can emit, held under tier 4 for the same reason tier 1 is.',
    args: { limit: 100 },
      reader: { listRuns: () => Promise.resolve(runsPage(100)) },
      rawInput: () => Array.from({ length: 100 }, (_, i) => f.fatRun(i)),
    },
  ]
}

// ─── Violations, tiers, verdict ───────────────────────────────────────────────

export type ViolationCode =
  /** A registered tool with no scenario declaring a budget. THE POINT OF THIS FILE. */
  | 'NO_BUDGET'
  /** A budget declared for a tool the server no longer registers. */
  | 'STALE_BUDGET'
  /** Measured above the declared ceiling. */
  | 'OVER_BUDGET'
  /** Under the ceiling, but above the committed baseline. Silent drift inside the headroom. */
  | 'ABOVE_BASELINE'
  /** A scenario the baseline has never recorded. */
  | 'NO_BASELINE'
  /** A baseline entry for a scenario that no longer exists. */
  | 'STALE_BASELINE'
  /** A contract field the fixture does not populate — the budget was measured against a payload that is too small. */
  | 'FIXTURE_NOT_MAXIMAL'
  /** A tool registered in source but not wired into `createServer` — dead, and unbudgetable. */
  | 'UNWIRED_TOOL'
  /** An mcp suite still declares its own copy of a fixture the shared module now owns. */
  | 'FIXTURE_DUPLICATION'
  /** Documented pre-existing debt: over budget, frozen at a recorded number, may only fall. */
  | 'FROZEN_BREACH'
  /** A recorded breach that no longer describes anything — delete it. */
  | 'STALE_BREACH'
  /** Measured BELOW the baseline. Progress; lower the baseline in the same commit. */
  | 'BELOW_BASELINE'

export interface Violation {
  readonly code: ViolationCode
  readonly subject: string
  readonly detail: string
  readonly fix: string
  /** Per-field attribution, printed under a budget failure so the reader knows WHICH field grew. */
  readonly attribution?: readonly string[]
}

/**
 * How each code is enforced. ANY CODE NOT LISTED DEFAULTS TO 'block' — a newly
 * added check must fail loudly rather than slip in unenforced.
 */
export const TIERS: Partial<Record<ViolationCode, 'block' | 'report'>> = {
  // Progress is never a build failure. Failing CI on the commit that IMPROVES
  // things is how a ratchet gets deleted; the delta prints on every run instead,
  // so a stale-high baseline cannot hide.
  BELOW_BASELINE: 'report',
  // A tool file that exists but is not wired into createServer is dead code, not
  // a budget breach. Worth naming — it is how a tool ships unmeasured the moment
  // somebody wires it — but it does not fail a build on its own.
  UNWIRED_TOOL: 'report',
  // A suite that still declares its own `fatPattern` is measuring a DIFFERENT
  // payload from the one budgeted here, and the two can disagree forever without
  // either being wrong on its own terms — 284 against 294 for the same tool on
  // the same scenario is what that looked like. Named on every run, with the
  // one-line fix, and self-clearing: it disappears when the last local
  // declaration goes and reappears the moment a new suite adds one.
  //
  // REPORT, not block, for one reason only: the remaining declarations live in
  // suites owned by another boundary (tests/unit/mcp_*.test.ts), and failing
  // this team's gate on another team's un-landed edit is how a gate gets turned
  // off. It blocks nothing; it also cannot be forgotten.
  FIXTURE_DUPLICATION: 'report',
  // Debt that already existed when the guard landed, frozen at a number that may
  // only fall. Reported on every run, never silent, and blocking the moment it
  // grows by a single token — see Scenario.knownBreach for why this is not a
  // waiver. A check that fails on day one against pre-existing debt gets deleted
  // on day two; one that names the debt and pins it survives to catch the next
  // regression.
  FROZEN_BREACH: 'report',
}

export const tierOf = (code: ViolationCode): 'block' | 'report' => TIERS[code] ?? 'block'

export const ESTIMATOR_NOTICE =
  '  estimator: ceil(utf8Bytes(JSON.stringify(x)) / 4) — the SAME expression tests/unit/mcp_budgets.ts declares for every\n' +
  '             MCP suite, and the one docs/mcp.md publishes. tests/unit/token_budget_guard.test.ts asserts the two agree\n' +
  '             payload-for-payload. It is a rough BPE approximation, not a tokenizer: monotonic in payload size (all a\n' +
  '             ratchet needs), never a promise about what a given model will actually bill.'

export const FIXTURE_NOTICE =
  '  caveat:    these are FIXTURE measurements against the worst case the contracts permit, not measurements against\n' +
  '             a deployment. Tier 4’s real cost depends on your own event payloads. A pass means the ceiling holds\n' +
  '             for the largest payload the system can LEGALLY produce — not that a given call will cost this.'

export function verdict(violations: readonly Violation[]): { readonly failed: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = []
  const byCode = new Map<ViolationCode, number>()
  for (const v of violations) {
    if (tierOf(v.code) !== 'block') continue
    byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1)
  }
  for (const [code, n] of byCode) reasons.push(`${String(n)} ${code}`)
  return { failed: reasons.length > 0, reasons }
}

// ─── Baseline ─────────────────────────────────────────────────────────────────

export interface Baseline {
  readonly measured: Readonly<Record<string, number>>
}

/** Stable key for a scenario. Tool first so the file reads as a per-tool inventory. */
export const keyOf = (tool: string, name: string): string => `${tool} :: ${name}`

export function loadBaseline(file: string = BASELINE_FILE): Baseline {
  if (!fs.existsSync(file)) {
    // A missing baseline must not silently disable the ratchet — with no recorded
    // numbers every measurement would read as "no increase" forever.
    throw new Error(
      `${rel(file)} is missing. The ratchet cannot run without it. Regenerate with: ` +
        `pnpm tsx scripts/check-token-budgets.ts --write-baseline`,
    )
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  const measured = (parsed as { measured?: Record<string, number> }).measured
  if (measured === undefined) throw new Error(`${rel(file)}: missing top-level "measured" object.`)
  return { measured }
}

export interface Measurement {
  readonly tool: string
  readonly scenario: string
  readonly tokens: number
  readonly bytes: number
  readonly budget: number
  /** Informational only — never asserted on. */
  readonly savingRatio: number | null
  readonly attribution: readonly string[]
  /** Documented pre-existing debt, carried through from the scenario. */
  readonly knownBreach?: { readonly tokens: number; readonly why: string }
  /**
   * The EXACT parsed payload the tool handler emitted.
   *
   * Kept so a test can assert WHICH CODE PATH produced it rather than trusting
   * that it did. Tier 4 is the reason: every tier-4 assertion in the repo used
   * to call `toEventRow` directly, while the shipped tool calls
   * `budgetEventRows` — so the byte budgeting that took the window from ~127,563
   * tokens to ~3,838 was referenced NOWHERE, and deleting it outright would have
   * left every test green. Measuring the wrong quantity is not a smaller
   * mistake than measuring nothing.
   */
  readonly response: unknown
}

/**
 * Compare measurements against budgets and the committed baseline.
 *
 * Pure, and exported, so the exit-code semantics are testable rather than
 * implied by the shape of `main()`.
 */
export function evaluate(
  measurements: readonly Measurement[],
  baseline: Baseline,
): Violation[] {
  const out: Violation[] = []
  const seen = new Set<string>()

  for (const m of measurements) {
    const key = keyOf(m.tool, m.scenario)
    seen.add(key)
    const recorded = baseline.measured[key]
    const breach = m.knownBreach

    if (m.tokens > m.budget) {
      if (breach === undefined || m.tokens > breach.tokens) {
        out.push({
          code: 'OVER_BUDGET',
          subject: key,
          detail:
            `~${String(m.tokens)} tokens against a budget of ${String(m.budget)} (+${String(m.tokens - m.budget)})` +
            (breach === undefined
              ? '.'
              : `, and above the frozen breach of ${String(breach.tokens)} (+${String(m.tokens - breach.tokens)}). ` +
                'Recorded debt may only ever fall.'),
          fix:
            'Cut the field named at the top of the attribution below. Do NOT raise the budget in ' +
            `${rel(__filename_)} — the ceiling is the product claim, and raising it is never the fix.`,
          attribution: m.attribution,
        })
        continue
      }
      out.push({
        code: 'FROZEN_BREACH',
        subject: key,
        detail:
          `~${String(m.tokens)} tokens against a budget of ${String(m.budget)} (+${String(m.tokens - m.budget)}), ` +
          `frozen at ${String(breach.tokens)}. ${breach.why}`,
        fix:
          'Fix it in the owning package and DELETE the knownBreach entry — the guard fails if the entry outlives ' +
          'the breach. Until then this number may only fall; one token more and it blocks.',
        attribution: m.attribution,
      })
    } else if (breach !== undefined) {
      out.push({
        code: 'STALE_BREACH',
        subject: key,
        detail:
          `measured ~${String(m.tokens)} tokens, at or under its ${String(m.budget)} budget — the recorded breach ` +
          'no longer describes anything.',
        fix:
          `delete the \`knownBreach\` block from this scenario in ${rel(__filename_)}. A breach note that ` +
          'suppresses nothing is how an exemption rots into a blanket mute.',
      })
    }

    if (recorded === undefined) {
      out.push({
        code: 'NO_BASELINE',
        subject: key,
        detail: `measured ~${String(m.tokens)} tokens, but ${rel(BASELINE_FILE)} has never recorded this scenario.`,
        fix: `record it: pnpm tsx ${rel(__filename_)} --write-baseline`,
      })
      continue
    }
    if (m.tokens > recorded) {
      out.push({
        code: 'ABOVE_BASELINE',
        subject: key,
        detail:
          `~${String(m.tokens)} tokens, up from the recorded ${String(recorded)} (+${String(m.tokens - recorded)}). ` +
          `Still under the ${String(m.budget)} budget.`,
        fix:
          'The budget is a CEILING; the baseline is where we actually are. Drift inside the headroom is how a ' +
          'ceiling gets reached, so it is never silent. Either remove the growth, or — if the increase is ' +
          `deliberate — run \`pnpm tsx ${rel(__filename_)} --write-baseline\` and let the new number land as a ` +
          'reviewable diff in the same commit.',
        attribution: m.attribution,
      })
      continue
    }
    if (m.tokens < recorded) {
      out.push({
        code: 'BELOW_BASELINE',
        subject: key,
        detail: `~${String(m.tokens)} tokens, down from the recorded ${String(recorded)} (${String(m.tokens - recorded)}).`,
        fix: `lock the gain in: pnpm tsx ${rel(__filename_)} --write-baseline, in this same commit.`,
      })
    }
  }

  for (const key of Object.keys(baseline.measured)) {
    if (seen.has(key)) continue
    out.push({
      code: 'STALE_BASELINE',
      subject: key,
      detail: 'recorded in the baseline, but no scenario produces it any more.',
      fix: `remove the entry: pnpm tsx ${rel(__filename_)} --write-baseline`,
    })
  }
  return out
}

/**
 * The exhaustiveness check — the reason this file exists rather than another
 * assertion in a test.
 *
 * `registered` comes from the SERVER'S OWN REGISTRY, never from a list here, so
 * a tool cannot be added without either declaring a budget or failing the build.
 */
export function checkExhaustive(
  registered: readonly string[],
  scenarios: readonly Scenario[],
): Violation[] {
  const out: Violation[] = []
  const budgeted = new Set(scenarios.map((s) => s.tool))
  for (const tool of registered) {
    if (budgeted.has(tool)) continue
    out.push({
      code: 'NO_BUDGET',
      subject: tool,
      detail:
        'is registered on the MCP server and has NO declared token budget. It is shipping to agents entirely ' +
        'unmeasured.',
      fix:
        `add at least one Scenario for it to SCENARIOS in ${rel(__filename_)}: a contract-maximal fixture, an ` +
        'ABSOLUTE ceiling, and the derivation of that ceiling written next to it.',
    })
  }
  for (const tool of budgeted) {
    if (registered.includes(tool)) continue
    out.push({
      code: 'STALE_BUDGET',
      subject: tool,
      detail: 'has declared budgets here but is not registered by createServer().',
      fix: `remove its scenarios from ${rel(__filename_)}, or wire the tool back into packages/mcp/src/server.ts.`,
    })
  }
  return out
}

export function checkMaximality(claims: readonly MaximalityClaim[]): Violation[] {
  const out: Violation[] = []
  for (const claim of claims) {
    const declared = interfaceMembers(claim.file, claim.interfaceName)
    const sample = claim.sample()
    const missing = declared.filter((f) => sample[f] === undefined)
    if (missing.length === 0) continue
    out.push({
      code: 'FIXTURE_NOT_MAXIMAL',
      subject: `${claim.label} fixture`,
      detail:
        `${rel(claim.file)} declares ${missing.length === 1 ? 'a field' : 'fields'} the fixture never populates: ` +
        `${missing.join(', ')}. Every budget measured through this fixture was measured against a payload ` +
        'SMALLER than the contract permits, so it under-states the real ceiling.',
      fix: `populate ${missing.join(', ')} in the fixture in ${rel(__filename_)}, then re-measure and re-baseline.`,
    })
  }
  return out
}

// ─── Loading the MCP server and enumerating its tools ─────────────────────────

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text?: string }[] }>
  enabled: boolean
}

interface LoadedServer {
  readonly tools: ReadonlyMap<string, RegisteredTool>
}

/**
 * A reader that throws on every call. Used for the ENUMERATION pass, where no
 * tool should touch it: registration must not perform a read, and if one ever
 * does, it fails loudly here instead of silently measuring a request nobody
 * asked for.
 */
function inertReader(): unknown {
  return new Proxy(
    {},
    {
      get:
        () =>
        (): never => {
          throw new Error('the inert reader was called — tool registration must not perform a read')
        },
    },
  )
}

/**
 * Dist that `packages/mcp/src` imports by package name. Checked explicitly so a
 * cold tree produces an instruction rather than a resolution stack trace, and so
 * a dist older than its own source produces a loud warning — a failed tsup
 * leaves the previous output in place, and a measurement against yesterday's
 * bundle is not a measurement.
 */
function checkBuiltDeps(): string[] {
  const warnings: string[] = []
  for (const pkg of ['contracts', 'sdk']) {
    const dist = path.join(REPO_ROOT, 'packages', pkg, 'dist/index.mjs')
    if (!fs.existsSync(dist)) {
      throw new Error(
        `${rel(dist)} is missing. packages/mcp/src imports @agent-flight-recorder/${pkg} by package name, which ` +
          `resolves to its dist/. Run \`pnpm build\` (CI must run build BEFORE this check) and try again.`,
      )
    }
    const distMtime = fs.statSync(dist).mtimeMs
    let newestSrc = 0
    const srcDir = path.join(REPO_ROOT, 'packages', pkg, 'src')
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else newestSrc = Math.max(newestSrc, fs.statSync(p).mtimeMs)
      }
    }
    if (fs.existsSync(srcDir)) walk(srcDir)
    if (newestSrc > distMtime) {
      warnings.push(
        `packages/${pkg}/dist is OLDER than packages/${pkg}/src. A FAILED tsup leaves the previous output in ` +
          'place, so this run may be measuring a stale build. Re-run `pnpm build` and confirm it SUCCEEDED ' +
          'before trusting any number below.',
      )
    }
  }
  return warnings
}

/**
 * Build the real server against a given reader and enumerate the tools IT
 * registered.
 *
 * A SERVER PER SCENARIO, deliberately. Each tool handler closes over the reader
 * it was registered with, so there is no way to swap the data source after the
 * fact — and no way to accidentally measure a tool against another scenario's
 * fixture.
 *
 * `_registeredTools` is the McpServer's own registry — the same object
 * `tools/list` answers from. It is private to the SDK, so its absence or
 * emptiness is treated as a hard failure rather than as "no tools": a guard that
 * degrades to checking nothing is worse than no guard, and this is exactly the
 * degradation that would happen silently on an SDK upgrade.
 */
async function loadServer(reader: unknown = inertReader()): Promise<LoadedServer> {
  const serverModule = (await import(pathToFileURL(path.join(MCP_SRC, 'server.ts')).href)) as {
    createServer: (reader: unknown, version: string) => unknown
  }
  const server = serverModule.createServer(reader, '0.0.0-budget-check')
  const registry = (server as { _registeredTools?: Record<string, RegisteredTool> })._registeredTools
  if (registry === undefined || Object.keys(registry).length === 0) {
    throw new Error(
      'McpServer._registeredTools is missing or empty. The MCP SDK changed the shape of its tool registry, so ' +
        `this check can no longer enumerate the tool surface — fix the enumeration in ${rel(__filename_)}. Do NOT ` +
        'let it degrade to a silent pass: with an empty registry every tool trivially "has a budget".',
    )
  }
  return { tools: new Map(Object.entries(registry)) }
}

/**
 * Tool names registered anywhere in `packages/mcp/src`, read statically.
 *
 * A CROSS-CHECK, not a source of truth. The runtime registry above is
 * authoritative; this catches the one thing it cannot see — a tool module that
 * calls `registerTool` but is never wired into `createServer`, which is dead
 * today and unmeasured on the day somebody wires it.
 */
export function staticallyRegisteredTools(dir: string = MCP_SRC): string[] {
  const names = new Set<string>()
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (p.endsWith('.ts')) {
        const text = fs.readFileSync(p, 'utf8')
        for (const m of text.matchAll(/\.registerTool\(\s*['"]([^'"]+)['"]/g)) names.add(m[1] ?? '')
      }
    }
  }
  walk(dir)
  return [...names].sort()
}

/**
 * mcp suites that still declare a fixture the shared module now owns.
 *
 * Scanned textually rather than by import graph, because the failure is a
 * DECLARATION, not an import: a suite that both imports the shared family and
 * keeps a local `fatPattern` shadowing it is the worst case, and an
 * import-graph check would call it unified.
 */
export function duplicateFixtureDeclarations(dir: string = path.join(REPO_ROOT, 'tests/unit')): Violation[] {
  const owned = ['fatPattern', 'fatRun', 'fatEvidence', 'fatEnvelope', 'externalizedEvent', 'nearThresholdEvent']
  const out: Violation[] = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.startsWith('mcp_') || !entry.endsWith('.test.ts')) continue
    const text = fs.readFileSync(path.join(dir, entry), 'utf8')
    const local = owned.filter((name) => new RegExp(`^\\s*(?:export )?(?:function|const) ${name}\\b`, 'm').test(text))
    if (local.length === 0) continue
    out.push({
      code: 'FIXTURE_DUPLICATION',
      subject: `tests/unit/${entry}`,
      detail:
        `declares its own ${local.join(', ')} instead of importing the shared family from ` +
        `${rel(FIXTURES_MODULE)}. Two fixture families for one tool disagree quietly: the local ones ` +
        'under-state the contract, which reads as token headroom that does not exist.',
      fix:
        `delete the local declaration${local.length === 1 ? '' : 's'} and add ` +
        `\`import { ${local.join(', ')} } from './mcp_budgets.js'\`. The shared family is contract-maximal and ` +
        'proved so — every declared field of every contract type it covers is populated, which the local copies ' +
        'are not.',
    })
  }
  return out
}

// ─── Measuring ────────────────────────────────────────────────────────────────

/** Run one scenario through its tool's registered handler and measure what came back. */
async function measure(scenario: Scenario, frozenNow: number): Promise<Measurement> {
  const { tools } = await loadServer(scenario.reader)
  const tool = tools.get(scenario.tool)
  if (tool === undefined) {
    throw new Error(`scenario "${scenario.name}" targets ${scenario.tool}, which createServer() does not register`)
  }
  const realNow = Date.now
  Date.now = () => frozenNow
  let result: { content: { type: string; text?: string }[] }
  try {
    result = await tool.handler(scenario.args, {})
  } finally {
    Date.now = realNow
  }

  const text = result.content.map((c) => c.text ?? '').join('')
  const parsed: unknown = JSON.parse(text)
  const raw = scenario.rawInput?.()
  const rawTokens = raw === undefined ? 0 : estimateTokens(raw)
  const tokens = estimateTokens(parsed)

  return {
    tool: scenario.tool,
    scenario: scenario.name,
    // MEASURED ON THE WIRE FORM. `jsonResult` serializes with
    // `JSON.stringify(value)` and no indentation, so re-estimating the parsed
    // value reproduces exactly the bytes the client receives.
    tokens,
    bytes: byteLength(text),
    budget: scenario.budget,
    savingRatio: raw === undefined || tokens === 0 ? null : rawTokens / tokens,
    attribution: attribute(parsed),
    response: parsed,
    ...(scenario.knownBreach !== undefined && { knownBreach: scenario.knownBreach }),
  }
}

export interface AnalysisResult {
  readonly registered: readonly string[]
  /** How many contract types the shared fixtures were proved to saturate. */
  readonly claimCount: number
  readonly measurements: readonly Measurement[]
  readonly violations: readonly Violation[]
  readonly warnings: readonly string[]
}

export async function analyze(baseline: Baseline): Promise<AnalysisResult> {
  const warnings = checkBuiltDeps()
  const fixtures = await loadFixtures()
  const scenarios = buildScenarios(fixtures)
  const { tools } = await loadServer()
  const registered = [...tools.keys()].sort()

  const violations: Violation[] = [
    ...checkExhaustive(registered, scenarios),
    ...checkMaximality(maximalityClaims(fixtures)),
  ]

  violations.push(...duplicateFixtureDeclarations())

  for (const name of staticallyRegisteredTools()) {
    if (registered.includes(name)) continue
    violations.push({
      code: 'UNWIRED_TOOL',
      subject: name,
      detail: 'calls registerTool in packages/mcp/src but is not registered by createServer().',
      fix: 'wire it into packages/mcp/src/server.ts, or delete it. Until then it is dead code with no budget.',
    })
  }

  const measurements: Measurement[] = []
  for (const scenario of scenarios) {
    if (!tools.has(scenario.tool)) continue // already reported as STALE_BUDGET
    measurements.push(await measure(scenario, fixtures.FROZEN_NOW))
  }

  violations.push(...evaluate(measurements, baseline))
  return { registered, claimCount: maximalityClaims(fixtures).length, measurements, violations, warnings }
}

// ─── Reporting ────────────────────────────────────────────────────────────────

const HEADLINE: Record<ViolationCode, string> = {
  NO_BUDGET: 'Registered tool with NO declared token budget',
  STALE_BUDGET: 'Budget declared for a tool that is no longer registered',
  OVER_BUDGET: 'Response exceeds its declared ceiling',
  ABOVE_BASELINE: 'Response grew above its recorded baseline (still under budget)',
  NO_BASELINE: 'Scenario has never been recorded in the baseline',
  STALE_BASELINE: 'Baseline entry for a scenario that no longer exists',
  FIXTURE_NOT_MAXIMAL: 'Fixture no longer saturates its contract',
  UNWIRED_TOOL: 'Tool registered in source but not wired into createServer',
  FIXTURE_DUPLICATION: 'An mcp suite declares its own copy of a shared fixture',
  FROZEN_BREACH: 'Over budget, frozen at a recorded number — documented pre-existing debt',
  STALE_BREACH: 'Recorded breach that no longer describes anything',
  BELOW_BASELINE: 'Response shrank below its baseline — lower the baseline',
}

const ORDER: readonly ViolationCode[] = [
  'NO_BUDGET',
  'OVER_BUDGET',
  'ABOVE_BASELINE',
  'FIXTURE_NOT_MAXIMAL',
  'NO_BASELINE',
  'STALE_BUDGET',
  'STALE_BASELINE',
  'STALE_BREACH',
  'FIXTURE_DUPLICATION',
  'FROZEN_BREACH',
  'UNWIRED_TOOL',
  'BELOW_BASELINE',
]

function printTable(measurements: readonly Measurement[], showAttribution: boolean): void {
  const nameWidth = Math.max(...measurements.map((m) => m.scenario.length), 8)
  let currentTool = ''
  for (const m of measurements) {
    if (m.tool !== currentTool) {
      currentTool = m.tool
      console.log(`\n  ${BOLD}${currentTool}${RESET}`)
    }
    const over = m.tokens > m.budget
    const frozen = over && m.knownBreach !== undefined && m.tokens <= m.knownBreach.tokens
    const pct = Math.round((m.tokens / m.budget) * 100)
    const mark = frozen ? `${YELLOW}⊘${RESET}` : over ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`
    const ratio = m.savingRatio === null ? '' : `${DIM}  ${m.savingRatio.toFixed(1)}x vs unprojected${RESET}`
    console.log(
      `    ${mark} ${String(m.tokens).padStart(6)} tok ${DIM}(${String(m.bytes).padStart(6)} B)${RESET}` +
        `  budget ${String(m.budget).padStart(6)}  ${String(pct).padStart(3)}%  ${m.scenario.padEnd(nameWidth)}${ratio}`,
    )
    if (showAttribution) {
      for (const line of m.attribution) console.log(`        ${DIM}${line}${RESET}`)
    }
  }
}

function printViolations(violations: readonly Violation[], codes: readonly ViolationCode[], color: string): void {
  for (const code of codes) {
    const items = violations.filter((v) => v.code === code)
    if (items.length === 0) continue
    console.log(`${BOLD}${CYAN}━━ ${code} — ${HEADLINE[code]} (${String(items.length)})${RESET}`)
    for (const v of items) {
      console.log(`\n  ${color}✗ ${BOLD}${v.subject}${RESET}`)
      console.log(`    problem: ${v.detail}`)
      console.log(`    fix:     ${v.fix}`)
      if (v.attribution !== undefined && v.attribution.length > 0) {
        console.log(`    ${DIM}cost by field, biggest first — this names WHAT grew:${RESET}`)
        for (const line of v.attribution) console.log(`      ${DIM}${line}${RESET}`)
      }
    }
    console.log('')
  }
}

function baselineDoc(): Record<string, unknown> {
  if (!fs.existsSync(BASELINE_FILE)) return {}
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as Record<string, unknown>
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'measured'))
}

async function main(): Promise<number> {
  const showAttribution = process.argv.includes('--attribution')

  if (process.argv.includes('--write-baseline')) {
    const previous: Baseline = fs.existsSync(BASELINE_FILE) ? loadBaseline() : { measured: {} }
    const result = await analyze(previous)
    // Recording a value ABOVE its own budget is the one write that is never
    // correct: it would convert a breached ceiling into a rubber stamp.
    const overBudget = result.measurements.filter(
      (m) => m.tokens > m.budget && m.tokens > (m.knownBreach?.tokens ?? m.budget),
    )
    if (overBudget.length > 0) {
      console.error(
        `${RED}Refusing to record a measurement that is OVER BUDGET:${RESET}\n` +
          overBudget.map((m) => `  ${keyOf(m.tool, m.scenario)}: ${String(m.tokens)} > ${String(m.budget)}`).join('\n') +
          `\n${YELLOW}Cut the response instead. A baseline may record where we are; it may never bless a breached ceiling.${RESET}`,
      )
      return 1
    }
    const measured: Record<string, number> = {}
    for (const m of [...result.measurements].sort((a, b) => keyOf(a.tool, a.scenario).localeCompare(keyOf(b.tool, b.scenario)))) {
      measured[keyOf(m.tool, m.scenario)] = m.tokens
    }
    const raised = Object.entries(measured).filter(([k, v]) => previous.measured[k] !== undefined && v > (previous.measured[k] ?? 0))
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...baselineDoc(), measured }, null, 2)}\n`)
    console.log(`${GREEN}Wrote ${rel(BASELINE_FILE)}${RESET}`)
    for (const [k, v] of Object.entries(measured)) {
      const before = previous.measured[k]
      const delta = before === undefined ? 'NEW' : v === before ? '±0' : `${v > before ? '+' : ''}${String(v - before)}`
      console.log(`  ${String(v).padStart(6)}  ${delta.padStart(5)}  ${k}`)
    }
    if (raised.length > 0) {
      console.log(
        `\n${YELLOW}${String(raised.length)} measurement(s) went UP. That is legal — they are still under budget — but it is\n` +
          `not free: the diff to ${rel(BASELINE_FILE)} is the record, and a reviewer should be told why.${RESET}`,
      )
    }
    return 0
  }

  const baseline = loadBaseline()
  const result = await analyze(baseline)

  console.log(`${BOLD}MCP tool token budgets (packages/mcp → what an agent actually pays)${RESET}`)
  console.log(
    `${DIM}  surface:   ${String(result.registered.length)} tools enumerated from the SERVER'S OWN registry, not from a list in this file` +
      `\n             (${result.registered.join(', ')})` +
      `\n  measured:  ${String(result.measurements.length)} scenarios, each invoked through its REGISTERED HANDLER against a stub reader` +
      `\n  fixtures:  ${rel(FIXTURES_MODULE)} — ONE family, shared with the mcp suites. Every declared field of` +
      `\n             ${String(result.claimCount)} contract types must be populated, or the ceilings were measured too low.` +
      `\n  ceilings:  ABSOLUTE token counts. Ratios below are commentary; nothing passes on one.${RESET}`,
  )
  console.log(`${YELLOW}${ESTIMATOR_NOTICE}${RESET}`)
  console.log(`${YELLOW}${FIXTURE_NOTICE}${RESET}`)

  for (const w of result.warnings) {
    console.log(`\n${RED}${BOLD}! ${w}${RESET}`)
  }

  printTable(result.measurements, showAttribution)
  console.log('')

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result.measurements, null, 2))
  }

  const blocking = result.violations.filter((v) => tierOf(v.code) === 'block')
  const reported = result.violations.filter((v) => tierOf(v.code) === 'report')

  if (blocking.length > 0) {
    console.log(`${RED}${BOLD}✗ ${String(blocking.length)} blocking finding${blocking.length === 1 ? '' : 's'}${RESET}\n`)
    printViolations(blocking, ORDER, RED)
  }
  if (reported.length > 0) {
    console.log(`${BOLD}${YELLOW}⊘ REPORT ONLY — does not fail the build${RESET}`)
    console.log(
      `${DIM}  A measurement that FELL is progress, and failing CI on the commit that improves things is how a` +
        `\n  ratchet gets deleted. It prints every run instead, so a stale-high baseline cannot hide.${RESET}\n`,
    )
    printViolations(reported, ORDER, YELLOW)
  }

  const { failed, reasons } = verdict(result.violations)
  if (!failed) {
    console.log(`${GREEN}✓ Every registered tool has a budget, and every measurement is at or under both its budget and its baseline.${RESET}`)
    return 0
  }
  console.log(`${RED}${BOLD}✗ FAILED:${RESET} ${reasons.join('; ')}`)
  console.log(
    `${YELLOW}Token cost is the product claim (CLAUDE.md § packages/mcp: "tool responses are token-budgeted by design").` +
      `\nNothing above is fixed by editing a number in ${rel(__filename_)} — either the response gets smaller, or the` +
      `\nincrease is deliberate and gets recorded as a reviewable diff to ${rel(BASELINE_FILE)}.${RESET}`,
  )
  return 1
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename_)
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exit(code)
    })
    .catch((err: unknown) => {
      console.error(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`)
      process.exit(2)
    })
}
