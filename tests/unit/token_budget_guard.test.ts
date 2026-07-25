/**
 * Guard-the-guard tests for scripts/check-token-budgets.ts.
 *
 * A checker nobody has watched catch anything is not a guard, so every failure
 * class this one claims to detect is planted here and asserted to be reported:
 * a tier-1 row that grew, a truncation cap that was raised, a tool registered
 * with no budget, a fixture that stopped saturating its contract, a baseline
 * that drifted in either direction, and a frozen breach that outlived the
 * breach.
 *
 * THE FIRST BLOCK IS THE MOST IMPORTANT ONE. The whole gate rests on there
 * being exactly ONE way to count tokens in this repository. If
 * `check-token-budgets.ts` could disagree with `tests/unit/mcp_budgets.ts` —
 * the single test-side declaration of the estimator and the tier ceilings —
 * about what a response costs, the gate would BE the second source of truth it
 * exists to remove. So the agreement is asserted mechanically, on payloads of
 * every shape, rather than asserted in a comment.
 *
 * The final block runs the real checker against the real repository. That is
 * the standing regression test: every registered `afr_*` tool must have a
 * budget, and every measurement must sit at or under both its ceiling and its
 * committed baseline.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  analyze,
  attribute,
  buildScenarios,
  checkExhaustive,
  checkMaximality,
  duplicateFixtureDeclarations,
  estimateTokens,
  evaluate,
  interfaceMembers,
  keyOf,
  loadBaseline,
  loadFixtures,
  maximalityClaims,
  RAW_DUMP_TOKENS,
  staticallyRegisteredTools,
  tierOf,
  verdict,
  type Baseline,
  type Measurement,
  type McpFixtures,
  type Scenario,
  type Violation,
  type ViolationCode,
} from '../../scripts/check-token-budgets.js'

import * as fixtures from './mcp_budgets.js'
import {
  estimateTokens as sharedEstimateTokens,
  TIER1_TOKEN_BUDGET,
  TIER2_TOKEN_BUDGET,
  TIER3_TOKEN_BUDGET,
  TIER4_WINDOW_TOKEN_BUDGET as SHARED_TIER4_BUDGET,
  TRUNCATION_NOTE,
  TRIAGE_TOKEN_BUDGET,
  WINDOW_PAYLOAD_BYTE_BUDGET,
} from './mcp_budgets.js'

/**
 * The scenario table, built against the SAME fixture module the script loads at
 * run time. Importing the fixtures here directly — rather than through the
 * script's CJS-interop loader — is deliberate: if the two ever resolved to
 * different modules, every assertion below would be measuring something the
 * gate does not.
 */
const SCENARIOS = buildScenarios(fixtures as unknown as McpFixtures)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

/** An empty directory, to prove a detector reports nothing when there is nothing. */
function tmpDirOnly(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afr-budget-empty-'))
  tmpDirs.push(dir)
  return dir
}

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afr-budget-'))
  tmpDirs.push(dir)
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

const codes = (violations: readonly Violation[]): ViolationCode[] => violations.map((v) => v.code)

function measurement(over: Partial<Measurement> = {}): Measurement {
  // Assembled then asserted, rather than spread into a typed literal: under
  // `exactOptionalPropertyTypes` a `Partial<Measurement>` spread widens every
  // required field to possibly-undefined. The base below supplies them all.
  const base: Measurement = {
    tool: 'afr_list_failure_patterns',
    scenario: '10 maximal patterns',
    tokens: 294,
    bytes: 1176,
    budget: 300,
    savingRatio: 12.8,
    attribution: [],
    response: {},
  }
  return { ...base, ...over } as Measurement
}

const baselineOf = (entries: Record<string, number>): Baseline => ({ measured: entries })

// ---------------------------------------------------------------------------
// ONE estimator, not two
// ---------------------------------------------------------------------------

describe('the estimator is the same one the existing suites and docs/mcp.md use', () => {
  /**
   * THE PIN.
   *
   * `tests/unit/mcp_budgets.ts` is now the single test-side declaration of the
   * estimator and the tier budgets, and its header asks the standing budget
   * script to agree with it rather than restate it. The script does NOT import
   * it at runtime — that module reaches `@agent-flight-recorder/mcp` by package
   * name, which resolves cleanly under vitest's alias and awkwardly across the
   * CJS seam from `scripts/` — so the agreement is proved HERE instead, where
   * both are importable, and any divergence fails this test rather than
   * producing two token counts that quietly disagree.
   */
  it('produces byte-identical counts to the shared estimator, on payloads of every shape', () => {
    const samples: unknown[] = [
      {},
      { a: 1 },
      { fields: ['a', 'b'], rows: [[1, 'x']] },
      'plain string',
      [1, 2, 3],
      // Multi-byte: bytes/4 is a BYTE count, not a character count. An
      // estimator that used `.length` would silently under-charge every label
      // carrying an em dash or a non-ASCII error message.
      { label: 'Modèle refusé — política de contenido 🚀' },
      { big: 'x'.repeat(10_000) },
      undefined,
    ]
    for (const s of samples) {
      expect(
        estimateTokens(s),
        'scripts/check-token-budgets.ts and tests/unit/mcp_budgets.ts disagree about what a payload costs. ' +
          'Two ways of counting that can disagree is the drift this gate exists to remove — make them one.',
      ).toBe(sharedEstimateTokens(s))
    }
  })

  it('is the literal bytes/4 formula docs/mcp.md publishes', () => {
    const reference = (v: unknown): number => Math.ceil(Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8') / 4)
    for (const s of [{ a: 1 }, 'x', { big: 'y'.repeat(999) }]) expect(estimateTokens(s)).toBe(reference(s))
  })

  it('is monotonic in payload size — the only property a ratchet needs', () => {
    let previous = 0
    for (const n of [0, 10, 100, 1000, 10_000]) {
      const tokens = estimateTokens({ payload: 'x'.repeat(n) })
      expect(tokens).toBeGreaterThanOrEqual(previous)
      previous = tokens
    }
  })

  it('declares the same tier ceilings as the shared module — the numbers cannot fork either', () => {
    const budgetOf = (tool: string, match: string): number | undefined =>
      SCENARIOS.find((s) => s.tool === tool && s.name.includes(match))?.budget
    expect(budgetOf('afr_list_failure_patterns', '10 maximal patterns')).toBe(TIER1_TOKEN_BUDGET)
    expect(budgetOf('afr_get_pattern_evidence', '100 inbound')).toBe(TIER2_TOKEN_BUDGET)
    expect(budgetOf('afr_explain_run', 'realistic')).toBe(TIER3_TOKEN_BUDGET)
    expect(budgetOf('afr_triage', 'typical')).toBe(TRIAGE_TOKEN_BUDGET)
    // Tier 4 is the one number this script deliberately does NOT take from the
    // shared module. There it is `RAW_DUMP_TOKENS / 10` — a ceiling that moves
    // with its own numerator, so a change raising both stays green while the
    // absolute an agent pays drifts. Here it is frozen as a literal. They agree
    // TODAY, and this asserts that; if they ever stop agreeing, the absolute is
    // the one that holds.
    expect(budgetOf('afr_get_run_events', 'externalized')).toBe(10_000)
    expect(budgetOf('afr_get_run_events', 'externalized')).toBe(SHARED_TIER4_BUDGET)
  })
})

// ---------------------------------------------------------------------------
// Planted regression 1: a field added to a tier-1 row
// ---------------------------------------------------------------------------

describe('a widened row is caught, and the report names the FIELD', () => {
  it('fails when a measurement exceeds its budget', () => {
    const found = evaluate([measurement({ tokens: 465 })], baselineOf({ [keyOf('afr_list_failure_patterns', '10 maximal patterns')]: 294 }))
    expect(codes(found)).toContain('OVER_BUDGET')
    const v = found.find((x) => x.code === 'OVER_BUDGET')
    expect(v?.detail).toContain('465')
    expect(v?.detail).toContain('300')
    expect(v?.fix, 'the fix must forbid raising the ceiling, or the ceiling is advisory').toContain('never the fix')
  })

  it('names the column that grew, not merely that a number moved', () => {
    // The exact shape of a tier-1 response, with `representativeRunIds` bolted
    // on — the one-line change the whole package is defended against.
    const widened = {
      fields: ['fingerprintHash', 'class', 'label', 'representativeRunIds'],
      rows: Array.from({ length: 10 }, (_, i) => [
        `0${String(i)}f3a9c1d4e7b2`,
        'tool_error',
        'Tool call failed',
        JSON.stringify([`run_${String(i)}a`, `run_${String(i)}b`, `run_${String(i)}c`, `run_${String(i)}d`, `run_${String(i)}e`]),
      ]),
    }
    const lines = attribute(widened)
    expect(lines[0], `attribution must lead with the most expensive column, got:\n${lines.join('\n')}`).toContain(
      'representativeRunIds',
    )
    // And the attribution must reach the reader: a budget failure carries it.
    const found = evaluate(
      [measurement({ tokens: 999, attribution: lines })],
      baselineOf({ [keyOf('afr_list_failure_patterns', '10 maximal patterns')]: 294 }),
    )
    expect(found[0]?.attribution?.[0]).toContain('representativeRunIds')
  })

  it('attributes per top-level key, recursing one level into a uniform array', () => {
    const window = {
      runId: 'run_8f2c1a',
      fromSequence: 18,
      events: [
        { sequenceNumber: 18, type: 'llm.request', payload: 'x'.repeat(4000) },
        { sequenceNumber: 19, type: 'llm.request', payload: 'x'.repeat(4000) },
      ],
    }
    const lines = attribute(window)
    expect(lines[0]).toContain('events')
    expect(
      lines.some((l) => l.includes('└') && l.includes('payload')),
      `the nested per-event attribution must name \`payload\`, got:\n${lines.join('\n')}`,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Planted regression 2: a truncation cap raised
// ---------------------------------------------------------------------------

describe('a raised truncation cap is caught by the baseline ratchet before it reaches the ceiling', () => {
  const key = keyOf('afr_get_run_events', 'saturated window')

  it('fails on growth INSIDE the headroom, so drift is never silent', () => {
    // Raising PAYLOAD_PREVIEW_BYTE_CAP from 400 to 800 does not breach the
    // 10,000 ceiling — it moves 3,390 to ~7,000. The budget alone would stay
    // green; the ratchet is what makes it visible.
    const found = evaluate(
      [measurement({ tool: 'afr_get_run_events', scenario: 'saturated window', tokens: 7_000, budget: 10_000 })],
      baselineOf({ [key]: 3_390 }),
    )
    expect(codes(found)).toContain('ABOVE_BASELINE')
    const v = found.find((x) => x.code === 'ABOVE_BASELINE')
    expect(v?.detail).toContain('3390')
    expect(v?.detail).toContain('7000')
    expect(v?.fix, 'an intended increase must be recordable, or the ratchet is a wall and gets deleted').toContain(
      '--write-baseline',
    )
  })

  it('does NOT fail when a measurement falls, but demands the baseline be lowered', () => {
    const found = evaluate(
      [measurement({ tool: 'afr_get_run_events', scenario: 'saturated window', tokens: 2_000, budget: 10_000 })],
      baselineOf({ [key]: 3_390 }),
    )
    expect(codes(found)).toEqual(['BELOW_BASELINE'])
    expect(tierOf('BELOW_BASELINE')).toBe('report')
    expect(verdict(found).failed, 'failing CI on the commit that improves things is how a ratchet gets deleted').toBe(
      false,
    )
    expect(found[0]?.fix).toContain('same commit')
  })

  it('fails a scenario the baseline has never recorded', () => {
    expect(codes(evaluate([measurement()], baselineOf({})))).toContain('NO_BASELINE')
  })

  it('fails a baseline entry no scenario produces any more', () => {
    const found = evaluate([], baselineOf({ 'afr_gone :: some scenario': 100 }))
    expect(codes(found)).toEqual(['STALE_BASELINE'])
  })
})

// ---------------------------------------------------------------------------
// Planted regression 3: a new tool registered with no budget
// ---------------------------------------------------------------------------

describe('exhaustiveness — a new tool cannot ship unmeasured', () => {
  const scenarios: readonly Scenario[] = [
    { tool: 'afr_triage', name: 's', budget: 1, why: '', args: {}, reader: {} },
  ]

  it('fails when a registered tool has no declared budget', () => {
    const found = checkExhaustive(['afr_triage', 'afr_get_run_diff'], scenarios)
    expect(codes(found)).toEqual(['NO_BUDGET'])
    expect(found[0]?.subject).toBe('afr_get_run_diff')
    expect(found[0]?.detail).toContain('entirely unmeasured')
    expect(verdict(found).failed, 'an unbudgeted tool must BLOCK, not warn').toBe(true)
  })

  it('fails when a budget outlives the tool it was written for', () => {
    const found = checkExhaustive([], scenarios)
    expect(codes(found)).toEqual(['STALE_BUDGET'])
  })

  it('is silent when every registered tool is budgeted', () => {
    expect(checkExhaustive(['afr_triage'], scenarios)).toEqual([])
  })

  it('reads the tool list from the server, never from a list in the script', () => {
    // The scenario table is keyed BY TOOL, but it can never be the enumeration:
    // checkExhaustive takes `registered` as an argument, and analyze() supplies
    // it from McpServer's own registry. This asserts the two are separate inputs
    // by feeding a registry the scenario table knows nothing about.
    const registered = [...new Set(SCENARIOS.map((s) => s.tool)), 'afr_totally_new']
    const found = checkExhaustive(registered, SCENARIOS)
    expect(codes(found)).toEqual(['NO_BUDGET'])
    expect(found[0]?.subject).toBe('afr_totally_new')
  })
})

// ---------------------------------------------------------------------------
// Planted regression 4: a fixture that stopped saturating its contract
// ---------------------------------------------------------------------------

describe('fixtures are proved maximal, not claimed maximal', () => {
  const contract = (body: string): string => `export interface Thing {\n${body}\n}\n`

  it('parses the declared members out of a real interface', () => {
    expect(interfaceMembers(tmpFile('c.ts', contract('  a: string;\n  b?: number;')), 'Thing')).toEqual(['a', 'b'])
  })

  it('throws rather than sanctioning an empty fixture when the contract is renamed', () => {
    expect(() => interfaceMembers(tmpFile('c.ts', contract('  a: string;')), 'Renamed')).toThrow(/no parsed members/)
  })

  it('fails when the contract grows a field the fixture does not populate', () => {
    const file = tmpFile('c.ts', contract('  a: string;\n  b?: number;\n  freshlyAdded?: string[];'))
    const found = checkMaximality([
      { label: 'Thing', file, interfaceName: 'Thing', sample: () => ({ a: 'x', b: 1 }) },
    ])
    expect(codes(found)).toEqual(['FIXTURE_NOT_MAXIMAL'])
    expect(found[0]?.detail).toContain('freshlyAdded')
    expect(found[0]?.detail, 'the report must say WHY a small fixture matters').toContain('under-states')
  })

  it('passes when the fixture saturates the contract', () => {
    const file = tmpFile('c.ts', contract('  a: string;\n  b?: number;'))
    expect(checkMaximality([{ label: 'Thing', file, interfaceName: 'Thing', sample: () => ({ a: 'x', b: 1 }) }])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The frozen-breach mechanism cannot rot
// ---------------------------------------------------------------------------

describe('documented pre-existing debt may only ever fall, and cannot outlive itself', () => {
  const key = keyOf('afr_explain_run', 'contract-maximal')
  const breached = (tokens: number): Measurement =>
    measurement({
      tool: 'afr_explain_run',
      scenario: 'contract-maximal',
      tokens,
      budget: 200,
      knownBreach: { tokens: 203, why: 'pre-existing' },
    })

  it('reports, but does not fail, at the frozen number', () => {
    const found = evaluate([breached(203)], baselineOf({ [key]: 203 }))
    expect(codes(found)).toEqual(['FROZEN_BREACH'])
    expect(verdict(found).failed).toBe(false)
  })

  it('BLOCKS the moment the debt grows by one token', () => {
    const found = evaluate([breached(204)], baselineOf({ [key]: 203 }))
    expect(codes(found)).toContain('OVER_BUDGET')
    expect(verdict(found).failed).toBe(true)
    expect(found[0]?.detail).toContain('may only ever fall')
  })

  it('BLOCKS when the breach note outlives the breach', () => {
    const found = evaluate([breached(190)], baselineOf({ [key]: 190 }))
    expect(codes(found)).toContain('STALE_BREACH')
    expect(verdict(found).failed, 'an exemption that suppresses nothing is how a mute rots in').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tiering and exit-code semantics
// ---------------------------------------------------------------------------

describe('exit-code semantics', () => {
  it('defaults an unlisted code to blocking, so a new check cannot slip in unenforced', () => {
    expect(tierOf('NO_BUDGET')).toBe('block')
    expect(tierOf('OVER_BUDGET')).toBe('block')
    expect(tierOf('ABOVE_BASELINE')).toBe('block')
    expect(tierOf('FIXTURE_NOT_MAXIMAL')).toBe('block')
    expect(tierOf('STALE_BREACH')).toBe('block')
  })

  it('passes on an empty finding list and on report-only findings alone', () => {
    expect(verdict([]).failed).toBe(false)
    expect(verdict([{ code: 'UNWIRED_TOOL', subject: 'x', detail: '', fix: '' }]).failed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Budgets are ABSOLUTE
// ---------------------------------------------------------------------------

describe('every declared budget is an absolute token count', () => {
  it('never expresses a ceiling as a fraction of the raw-dump assumption', () => {
    // The defect this gate was built to close: TIER4_WINDOW_TOKEN_BUDGET =
    // RAW_DUMP_TOKENS / 10 moved with its own numerator, so a change that
    // raised both stayed green while the absolute drifted.
    for (const s of SCENARIOS) {
      expect(Number.isInteger(s.budget), `${s.tool} :: ${s.name} has a non-integer budget`).toBe(true)
      expect(s.budget).toBeGreaterThan(0)
      expect(
        s.budget,
        `${s.tool} :: ${s.name} has a budget equal to RAW_DUMP_TOKENS/10 by coincidence or by derivation — ` +
          'if it is derived, freeze it as a literal',
      ).toBe(Math.round(s.budget))
    }
    expect(RAW_DUMP_TOKENS, 'RAW_DUMP_TOKENS may inform a comment; it must never be a divisor in a budget').toBe(
      100_000,
    )
  })

  it('makes every tool state why its ceiling is that number', () => {
    for (const s of SCENARIOS) {
      expect(s.why.length, `${s.tool} :: ${s.name} has no derivation — an undocumented ceiling gets raised`).toBeGreaterThan(
        40,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// The standing regression test, against the real repository
// ---------------------------------------------------------------------------

describe('one fixture family, and it is the contract-maximal one', () => {
  it('the script declares no fixtures of its own — it loads the shared module', async () => {
    const loaded = await loadFixtures()
    // Same functions, not merely equivalent ones: identity is what makes
    // "one family" true rather than "two families that agree today".
    expect(loaded.fatPattern).toBe(fixtures.fatPattern)
    expect(loaded.fatRun).toBe(fixtures.fatRun)
    expect(loaded.nearThresholdEvent).toBe(fixtures.nearThresholdEvent)
    expect(loaded.FROZEN_NOW).toBe(fixtures.FROZEN_NOW)
  })

  it('fails loudly if the shared module stops exporting the family', async () => {
    await expect(loadFixtures('/nonexistent/mcp_budgets.ts')).rejects.toThrow(/single declaration/)
    // A module that exists but has the wrong shape must NOT degrade to empty
    // fixtures — a budget measured against `{}` is a triumphantly small number.
    const decoy = tmpFile('decoy.ts', 'export const nothing = 1\n')
    await expect(loadFixtures(decoy)).rejects.toThrow(/does not export/)
  })

  it('proves the shared fixtures saturate every contract it claims', async () => {
    expect(checkMaximality(maximalityClaims(await loadFixtures()))).toEqual([])
  })

  it('names any suite still holding a private copy, and clears itself when they stop', () => {
    const found = duplicateFixtureDeclarations()
    for (const v of found) {
      expect(v.code).toBe('FIXTURE_DUPLICATION')
      expect(v.fix, 'the finding must carry the exact import that closes it').toContain("from './mcp_budgets.js'")
    }
    // Report-tier by design: the remaining declarations are in another
    // boundary's suites, and failing this gate on their un-landed edit is how a
    // gate gets switched off.
    expect(verdict(found).failed).toBe(false)
    expect(duplicateFixtureDeclarations(tmpDirOnly())).toEqual([])
  })
})

describe('tier 4 measures the SHIPPED budgeting path, not the projection beneath it', () => {
  /**
   * THE QUANTITY THIS GATE EXISTS TO PROTECT, and the one most easily measured
   * wrong. Every tier-4 assertion in the repo used to call `toEventRow`
   * directly; the shipped tool calls `budgetEventRows` and emits
   * `TRUNCATION_NOTE`. Nothing referenced `budgetEventRows`,
   * `WINDOW_PAYLOAD_BYTE_BUDGET` or `TRUNCATION_NOTE`, so deleting the byte
   * budgeting from `get-run-events.ts` — the fix that took a saturated window
   * from ~127,563 tokens to ~3,838 — would have left every test green.
   *
   * These assert on the payload the HANDLER emitted, so they can only pass if
   * the shipped path ran.
   */
  it('emits TRUNCATION_NOTE, which only the tool handler can produce', async () => {
    const result = await analyze(loadBaseline())
    const inline = result.measurements.find(
      (m) => m.tool === 'afr_get_run_events' && m.scenario.includes('INLINE'),
    )
    const response = inline?.response as Record<string, unknown> | undefined
    expect(
      response?.['truncationNote'],
      'the tier-4 measurement did not go through budgetEventRows — it is measuring toEventRow, which is a ' +
        'different and much larger quantity',
    ).toBe(TRUNCATION_NOTE)
  }, 60_000)

  it('bounds total inline payload bytes by the window budget, not by the event count', async () => {
    const result = await analyze(loadBaseline())
    const inline = result.measurements.find(
      (m) => m.tool === 'afr_get_run_events' && m.scenario.includes('INLINE'),
    )
    const response = inline?.response as { events?: { payload?: unknown }[] } | undefined
    const events = response?.events ?? []
    expect(events.length, 'the window should be saturated at MAX_LIMIT').toBe(50)

    const inlineBytes = events.reduce((sum, e) => {
      const p = e.payload
      const isMarker = typeof p === 'object' && p !== null && 'truncated' in p
      return sum + (p === undefined || isMarker ? 0 : Buffer.byteLength(JSON.stringify(p) ?? '', 'utf8'))
    }, 0)
    expect(inlineBytes).toBeLessThanOrEqual(WINDOW_PAYLOAD_BYTE_BUDGET)

    // The 10 KB blobs must never arrive whole. MAX_LIMIT caps EVENTS; only the
    // byte budget caps BYTES, and bytes are what an agent pays for.
    expect(JSON.stringify(response)).not.toContain('x'.repeat(2_000))
  }, 60_000)
})

describe('the real MCP surface', () => {
  it('registers exactly the tools wired into createServer', () => {
    // Cross-check only: the runtime registry is authoritative. This catches a
    // tool module that registers a tool but is never wired in — dead today,
    // unmeasured the day somebody wires it.
    expect(staticallyRegisteredTools()).toEqual([
      'afr_explain_run',
      'afr_get_pattern_evidence',
      'afr_get_run_events',
      'afr_list_failure_patterns',
      'afr_list_runs',
      'afr_triage',
    ])
  })

  it('holds every budget and every baseline', async () => {
    const result = await analyze(loadBaseline())
    const blocking = result.violations.filter((v) => tierOf(v.code) === 'block')
    expect(
      blocking.map((v) => `${v.code}: ${v.subject} — ${v.detail}`),
      'run `pnpm build && pnpm tsx scripts/check-token-budgets.ts` for the full table and per-field attribution',
    ).toEqual([])
    // Exhaustiveness, asserted against the live registry rather than a list.
    for (const tool of result.registered) {
      expect(
        SCENARIOS.some((s) => s.tool === tool),
        `${tool} is registered on the MCP server with no declared token budget`,
      ).toBe(true)
    }
    expect(result.measurements.length).toBeGreaterThanOrEqual(result.registered.length)
  }, 60_000)
})
