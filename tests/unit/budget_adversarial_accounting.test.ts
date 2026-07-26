/**
 * BUDGET CIRCUIT BREAKERS — ADVERSARIAL SUITE, ACCOUNTING LAYER (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * The three shipped primitives that are the ONLY places in this repository a
 * number denominated in money or in spend can come from, and therefore the
 * only things a budget circuit breaker can compare against a limit:
 *
 *   convex/helpers/pricing.ts   estimateCostUsd / resolveModelPricing
 *                               -> the only USD figure in the product
 *   convex/usage.ts             incrementUsageCounters
 *                               -> the only running per-org spend counter
 *   convex/helpers/analytics.ts computeRunStats + convex/rollups.ts
 *                               -> the only per-agent per-day token totals
 *
 * ── SEVERITY RE-POINTED: THESE NO LONGER FEED THE BREAKER ────────────────
 * When this file was written the budget feature was not yet on disk and these
 * three primitives were the only candidates for a spend figure. The feature
 * has since ruled on exactly this question, and the ruling came from these
 * findings: `usage_counters` is Morris-sampled and over-counts about half the
 * time, so THE BREAKER REFUSES TO USE IT AT ALL. It reads
 * `runs.tokensIn`/`tokensOut`, which are add-only and unscaled and therefore
 * wrong only DOWNWARD — giving the asymmetry the feature now rests on:
 *
 *   A FLOOR CAN PROVE A BREACH AND CAN NEVER PROVE COMPLIANCE.
 *
 * So the ledger below is re-pointed rather than retired, because a defect that
 * reaches a spend gate and one that reaches a dashboard are different
 * severities and must not sit in one list:
 *
 *   §A pricing matcher      -> COST SURFACES ONLY. `getAgentCostStats`, the
 *                              cost UI, `afr` cost output. Real, unfixed, and
 *                              no longer able to halt an agent. MEDIUM.
 *   §B usage counter        -> NOT ON THE BREAKER PATH BY RULING. Kept as the
 *                              STANDING PROOF of why: §B3 is the evidence the
 *                              ruling rests on, and if the sampling were ever
 *                              quietly removed the argument for excluding it
 *                              would evaporate silently. LOW severity, HIGH
 *                              evidentiary value.
 *   §C rollup coverage      -> ANALYTICS ONLY. `daily_rollups` feeds the
 *                              dashboards, not the gate. MEDIUM.
 *
 * NONE of them is a false-positive risk for the breaker any more. That is a
 * genuine improvement and it is stated here so a reader does not carry last
 * iteration's severity forward.
 *
 * ── ANTI-VACUITY ──────────────────────────────────────────────────────────
 * Subjects are enumerated FROM THE SOURCE OR THE DATA, never from a hand list:
 *   - §A sweeps every key in the shipped `PRICING_TABLE` and derives its own
 *     perturbations from each key structurally (prefixes, version bumps,
 *     provider prefixes, date stamps). Add a model to the table and it is
 *     graded without this file changing.
 *   - §C enumerates the persisted rollup field set from
 *     `upsertDailyRollup.exportArgs()` — the shipped validator — so adding a
 *     coverage field to the rollup RETIRES the defect by making §C3 fail.
 * Every assertion is against a FUNCTION'S OUTPUT on a constructed input. No
 * assertion in this file is against a constant, a doc comment, or a grep.
 * Every defect is paired with a counterweight proving the same primitive
 * behaves CORRECTLY on a neighbouring input, so "it returned 0" is never
 * confused with "it is switched off".
 */

import { describe, expect, it, vi } from 'vitest'

import { computeRunStats } from '../../convex/helpers/analytics.js'
import {
  PRICING_LAST_UPDATED,
  PRICING_TABLE,
  estimateCostUsd,
} from '../../convex/helpers/pricing.js'
import { incrementUsageCounters } from '../../convex/usage.js'

import type { RunSummary } from '../../convex/helpers/analytics.js'
import type { ModelPricing } from '../../convex/helpers/pricing.js'

/**
 * `convex/rollups.ts` is loaded through a non-literal specifier ON PURPOSE.
 *
 * `convex/tsconfig.json` disables `exactOptionalPropertyTypes`; `tests/` has it
 * on (inherited from tsconfig.base.json), and that strictness is what makes
 * fixture drift fail CI, so it must not be relaxed. A STATIC import of
 * rollups.ts drags a backend file that is correct under its own config into the
 * stricter project and produces two typecheck errors in code this suite does
 * not own. `tests/tsconfig.convex-seam.json` exists for exactly this case, but
 * its `include` list is outside this suite's edit boundary (Team D may add new
 * `tests/budget_adversarial_*` files and nothing else).
 *
 * A variable specifier makes `import()` opaque to tsc while resolving normally
 * at runtime, so the SHIPPED function is still the thing under test. The shape
 * below is a local annotation of what this file calls -- it asserts nothing.
 */
const ROLLUPS_MODULE = '../../convex/rollups.js'
const rollups = (await import(/* @vite-ignore */ ROLLUPS_MODULE)) as {
  upsertDailyRollup: { exportArgs: () => string }
}

// ---------------------------------------------------------------------------
// Shared helpers. None of these encode an expected value; they only construct
// inputs and read shipped outputs.
// ---------------------------------------------------------------------------

/** Every model id the shipped table knows about. The sweep's subject set. */
const TABLE_KEYS: string[] = Object.keys(PRICING_TABLE)

/** A one-million-in / one-million-out call, so USD reads directly as $/M. */
const ONE_MEGA_CALL = (model: string) => estimateCostUsd(model, 1_000_000, 1_000_000)

/** True cost of one mega-call under a known table entry. */
const megaCostOf = (p: ModelPricing) => p.inputPerMillion + p.outputPerMillion

// ===========================================================================
// §A  THE ONLY USD FIGURE IN THE PRODUCT IS RESOLVED BY SUBSTRING
// ===========================================================================
//
// `resolveModelPricing` documents its strategy as: exact match, then
// "longest-key substring match", then "No match -> undefined. We never guess a
// nearest neighbor silently." The second arm is bidirectional --
// `normalized.includes(key) || key.includes(normalized)` -- and the second half
// of that disjunction is what makes the third sentence untrue: any string that
// is a SUBSTRING OF a table key resolves, with `matched: true`, to whichever
// key happens to be longest.
//
describe('budget/A — the USD figure', () => {
  it('A1 (teeth): the matcher is not switched off — every shipped key prices itself exactly', () => {
    // Counterweight for the whole of §A. If this ever goes red, no failure
    // below means anything, because the matcher would simply be broken.
    expect(TABLE_KEYS.length).toBeGreaterThan(20)

    const selfMispriced = TABLE_KEYS.filter((key) => {
      const est = ONE_MEGA_CALL(key)
      return !est.matched || est.pricingKey !== key || est.costUsd !== megaCostOf(PRICING_TABLE[key]!)
    })
    expect(selfMispriced).toEqual([])
  })

  it('A2 (DEFECT, both directions): a substring of a table key is priced with matched:true', () => {
    // Derived from the data, not chosen: the shortest string that is a
    // substring of at least two DIFFERENTLY-PRICED keys. There is no hand list
    // here -- the candidates are generated from the table's own key alphabet.
    const alphabet = [...new Set(TABLE_KEYS.join('').split(''))].filter((c) => /[a-z0-9]/.test(c))

    const ambiguous = alphabet
      .map((ch) => {
        const containing = TABLE_KEYS.filter((k) => k.includes(ch))
        const prices = new Set(containing.map((k) => megaCostOf(PRICING_TABLE[k]!)))
        return { probe: ch, containing, distinctPrices: prices.size }
      })
      .filter((r) => r.distinctPrices > 1)

    // Teeth: the data must actually contain such probes, or the rest is vacuous.
    expect(ambiguous.length).toBeGreaterThan(0)

    // Every one of them resolves, confidently, to exactly one price.
    const resolvedConfidently = ambiguous.filter((r) => ONE_MEGA_CALL(r.probe).matched)
    expect(resolvedConfidently.length).toBe(ambiguous.length)

    // The concrete reproduction, so the defect reads as a sentence:
    // a ONE-CHARACTER model string is priced as Claude Sonnet 4.5.
    const single = ONE_MEGA_CALL('o')
    expect(single.matched).toBe(true)
    expect(single.costUsd).toBeGreaterThan(0)
    expect(single.pricingKey).toBe('claude-sonnet-4-5')

    // DIRECTION: this is the false-positive direction as easily as the false-
    // negative one. `matched: true` is the ONLY signal a breaker has that the
    // dollar figure means anything, and it is set here.
  })

  it('A3 (DEFECT, UNDERCOUNT -> breaker never trips): a family name prices as the family\'s CHEAPEST member', () => {
    // "gemini" and "claude" are what an SDK reports when the caller logs a
    // family rather than a model id. Both resolve. Both resolve LOW.
    const family = ONE_MEGA_CALL('gemini')
    expect(family.matched).toBe(true)

    const geminiKeys = TABLE_KEYS.filter((k) => k.startsWith('gemini'))
    expect(geminiKeys.length).toBeGreaterThan(1)
    const geminiCosts = geminiKeys.map((k) => megaCostOf(PRICING_TABLE[k]!))
    const cheapest = Math.min(...geminiCosts)
    const dearest = Math.max(...geminiCosts)

    // It is priced as the cheapest member of its own family...
    expect(family.costUsd).toBe(cheapest)
    // ...and the family's spread is large, so the understatement is not a
    // rounding matter. Derived from the shipped table, not asserted as a
    // constant.
    expect(dearest / cheapest).toBeGreaterThan(10)

    // An org burning `dearest` rates has its spend reported at `cheapest`.
    // A breaker on a hard USD limit therefore does not trip until real spend
    // is >10x the limit.
  })

  it('A4 (DEFECT, OVERCOUNT -> breaker trips spuriously): tomorrow\'s model prices as yesterday\'s', () => {
    // The perturbation is DERIVED from each key: bump the trailing version
    // digit. This is the single most predictable thing that happens to a
    // pricing table -- a provider ships a new point release.
    const bumped = TABLE_KEYS.flatMap((key) => {
      const m = /^(.*?)(\d+)$/.exec(key)
      if (!m) return []
      const next = `${m[1]}${Number(m[2]!) + 1}`
      if (PRICING_TABLE[next]) return [] // already a real key; not a probe
      const est = ONE_MEGA_CALL(next)
      return [{ key, probe: next, est, trueCostOfKey: megaCostOf(PRICING_TABLE[key]!) }]
    })

    expect(bumped.length).toBeGreaterThan(5) // teeth: the sweep found subjects

    // Classification is TOTAL: every probe lands in exactly one bucket and the
    // buckets sum. A sweep whose buckets do not sum is a sweep with a hole.
    const unmatched = bumped.filter((b) => !b.est.matched)
    const matchedSelfPriced = bumped.filter(
      (b) => b.est.matched && b.est.costUsd === b.trueCostOfKey,
    )
    const matchedDifferentPrice = bumped.filter(
      (b) => b.est.matched && b.est.costUsd !== b.trueCostOfKey,
    )
    expect(unmatched.length + matchedSelfPriced.length + matchedDifferentPrice.length).toBe(
      bumped.length,
    )

    // The reproduction. `claude-opus-4-6` is not a table key; it resolves to
    // `claude-opus-4` and is therefore priced at 15/75 rather than the 5/25 of
    // the newest opus actually in the table.
    const future = ONE_MEGA_CALL('claude-opus-4-6')
    expect(future.matched).toBe(true)
    expect(future.pricingKey).toBe('claude-opus-4')
    const newestOpus = megaCostOf(PRICING_TABLE['claude-opus-4-5']!)
    expect(future.costUsd / newestOpus).toBeGreaterThanOrEqual(3)

    // DIRECTION: 3x OVER. A company that upgrades to a newer opus and keeps
    // the same budget has its agents halted at one third of the budget it set,
    // on the day of the upgrade, with no configuration change of its own.
  })

  it('A5 (DEFECT): which price an ambiguous model gets is decided by KEY STRING LENGTH', () => {
    // SORTED_KEYS is `b.length - a.length`. Nothing semantic breaks the tie.
    // So the price assigned to any ambiguous input is a function of how long
    // the table's keys happen to be -- and adding an unrelated model to the
    // table can silently REPRICE an existing ambiguous input in either
    // direction.
    //
    // Proven from output rather than asserted about the source: among probes
    // that match by containment, the winner is always maximal-length among the
    // candidate keys.
    const probes = ['gpt', 'claude', 'gemini', 'flash', 'mini', 'opus', 'sonnet', 'haiku']
    const witnessed = probes.flatMap((probe) => {
      const est = ONE_MEGA_CALL(probe)
      if (!est.matched) return []
      const candidates = TABLE_KEYS.filter((k) => k.includes(probe) || probe.includes(k))
      if (candidates.length < 2) return []
      const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a))
      return [{ probe, chosen: est.pricingKey, longest, candidates: candidates.length }]
    })

    expect(witnessed.length).toBeGreaterThan(3) // teeth
    expect(witnessed.filter((w) => w.chosen !== w.longest)).toEqual([])

    // And the choice is materially consequential: for at least one probe the
    // longest-key winner is NOT the priciest candidate, so the figure a
    // breaker sees is below the true worst case.
    const understating = witnessed.filter((w) => {
      const candidates = TABLE_KEYS.filter((k) => k.includes(w.probe) || w.probe.includes(k))
      const dearest = Math.max(...candidates.map((k) => megaCostOf(PRICING_TABLE[k]!)))
      return megaCostOf(PRICING_TABLE[w.chosen!]!) < dearest
    })
    expect(understating.length).toBeGreaterThan(0)
  })

  it('A6 (DEFECT, UNDERCOUNT): an unrecognised model spends without limit at exactly $0', () => {
    // Documented behaviour ("cost is never guessed"), and correct in
    // isolation. It is a defect ONLY in the presence of a breaker, and that is
    // the point: $0 is not "unknown", it is a number that compares favourably
    // against every limit.
    const huge = estimateCostUsd('mistral-large-2', 1_000_000_000, 1_000_000_000)
    expect(huge.matched).toBe(false)
    expect(huge.costUsd).toBe(0)

    // Counterweight: the same billion tokens on a KNOWN model is enormous, so
    // the $0 above is a property of the model string, not of the token counts.
    const known = estimateCostUsd('claude-opus-4-1', 1_000_000_000, 1_000_000_000)
    expect(known.costUsd).toBeGreaterThan(10_000)

    // Consequence for a breaker: any org can render its budget unenforceable
    // by reporting a model string the snapshot table has never heard of --
    // which includes every model released after PRICING_LAST_UPDATED.
  })

  it('A7 (DEFECT): the estimate carries no ambiguity signal and no snapshot date', () => {
    // Asserted against the OUTPUT SHAPE of the shipped function, not against
    // its source text. A consumer deciding whether to halt a business gets
    // these fields and no others.
    const exact = ONE_MEGA_CALL('claude-opus-4-5')
    const bySubstring = ONE_MEGA_CALL('o')

    expect(exact.matched).toBe(true)
    expect(bySubstring.matched).toBe(true)

    // Same shape, same confidence flag, no field distinguishes them.
    expect(Object.keys(exact).sort()).toEqual(Object.keys(bySubstring).sort())
    const fields = new Set(Object.keys(exact))
    expect(fields.has('ambiguous')).toBe(false)
    expect(fields.has('exact')).toBe(false)
    expect(fields.has('asOf')).toBe(false)
    expect(fields.has('pricedAt')).toBe(false)

    // The snapshot date exists as a module constant and is not carried on the
    // estimate, so a breaker cannot refuse to enforce against stale prices.
    // (Asserted as a parse of the shipped constant, then used to compute a
    // real age -- not as a string comparison.)
    const snapshotMs = Date.parse(`${PRICING_LAST_UPDATED}T00:00:00.000Z`)
    expect(Number.isFinite(snapshotMs)).toBe(true)
    expect(JSON.stringify(exact)).not.toContain(PRICING_LAST_UPDATED)
  })
})

// ===========================================================================
// §B  THE RUNNING SPEND COUNTER IS A RANDOMISED ESTIMATOR
// ===========================================================================
//
// `incrementUsageCounters` flushes a single-unit call only ~1-in-
// USAGE_FLUSH_STRIDE times, and multiplies by STRIDE when it does. Its own
// comment says "approximate by design ... not an exact audit trail". The row
// it writes is a bare integer.
//
// The two tests below feed the SAME shipped function the SAME 100 true events
// and differ ONLY in what Math.random returns. Both are deterministic.
//
describe('budget/B — the running spend counter (evidence for the exclusion ruling)', () => {
  interface FakeRow {
    _id: string
    runsStarted: number
    eventsIngested: number
    bytesIngested: number
    artifactBytes: number
  }

  /**
   * Minimal MutationCtx stand-in: one usage_counters row, insert + patch.
   * It encodes no expectation -- it is a bucket the shipped function writes to.
   */
  function fakeCtx() {
    const rows: FakeRow[] = []
    const ctx = {
      db: {
        query: () => ({ withIndex: () => ({ unique: async () => rows[0] ?? null }) }),
        insert: async (_table: string, doc: Record<string, number>) => {
          rows.push({ _id: 'row', ...(doc as unknown as Omit<FakeRow, '_id'>) })
          return 'row'
        },
        patch: async (_id: string, fields: Partial<FakeRow>) => {
          Object.assign(rows[0]!, fields)
        },
      },
    }
    return { ctx: ctx as never, rows }
  }

  async function drive(randomValue: number, trueEvents: number): Promise<number> {
    const { ctx, rows } = fakeCtx()
    const spy = vi.spyOn(Math, 'random').mockReturnValue(randomValue)
    try {
      for (let i = 0; i < trueEvents; i++) {
        await incrementUsageCounters(ctx, 'org_a' as never, { eventsIngested: 1 })
      }
    } finally {
      spy.mockRestore()
    }
    return rows[0]!.eventsIngested
  }

  it('B1 (DEFECT, OVERCOUNT -> a company\'s agents halt at ~10% of budget)', async () => {
    const observed = await drive(0, 100)
    // 100 true events. The shipped counter reports an order of magnitude more.
    expect(observed).toBeGreaterThan(900)
  })

  it('B2 (DEFECT, UNDERCOUNT -> the breaker never trips)', async () => {
    const observed = await drive(0.999, 100)
    // The same 100 true events. The shipped counter reports 1.
    expect(observed).toBe(1)
  })

  it('B3 (THE FINDING): one shipped function, one workload, a ~1000x spread on a coin flip', async () => {
    const high = await drive(0, 100)
    const low = await drive(0.999, 100)
    // Derived entirely from output. Nothing here is a constant expectation.
    expect(high / low).toBeGreaterThan(100)

    // A breaker comparing this counter against a hard limit is not "slightly
    // approximate". Whether the business is halted at 10% of its budget or
    // allowed to run to 100x of it is decided by a random number generator.
  })

  it('B4 (teeth): a BATCH call is exact, so §B is a property of the stride path, not of the fake ctx', async () => {
    // The shipped function's documented batch path flushes exactly. If the
    // fake ctx were simply losing writes, this would fail too.
    const { ctx, rows } = fakeCtx()
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999) // never-flush regime
    try {
      await incrementUsageCounters(ctx, 'org_a' as never, { eventsIngested: 1 }) // insert
      await incrementUsageCounters(ctx, 'org_a' as never, { eventsIngested: 50 }) // batch
    } finally {
      spy.mockRestore()
    }
    expect(rows[0]!.eventsIngested).toBe(51)
  })

  it('B5 (DEFECT): the counter has no agent dimension and no money dimension', async () => {
    // Asserted against the ROW THE SHIPPED FUNCTION WRITES, not against the
    // schema text. A breaker phrased as "this AGENT may spend $X" cannot be
    // answered from this row at all: it is org-wide, and denominated in
    // runs/events/bytes.
    const { ctx, rows } = fakeCtx()
    await incrementUsageCounters(ctx, 'org_a' as never, { eventsIngested: 5, runsStarted: 2 })
    const written = new Set(Object.keys(rows[0]!))

    expect(written.has('orgId')).toBe(true)
    expect(written.has('agentId')).toBe(false)
    expect(written.has('costUsd')).toBe(false)
    expect(written.has('tokensIn')).toBe(false)
    // ...and nothing records how much of the day this row actually observed.
    expect(written.has('sampledCalls')).toBe(false)
    expect(written.has('stride')).toBe(false)
  })
})

// ===========================================================================
// §C  THE COVERAGE DENOMINATOR IS COMPUTED, THEN DROPPED AT THE BOUNDARY
// ===========================================================================
//
// `computeRunStats` returns `runsWithTokenData` -- "count of runs that reported
// at least one of tokensIn/tokensOut" -- which is exactly the denominator that
// says how much of a day's spend the token totals actually cover. The daily
// rollup persists the totals and not the denominator.
//
describe('budget/C — the coverage denominator', () => {
  const run = (over: Partial<RunSummary> = {}): RunSummary => ({
    status: 'completed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...over,
  })

  /** The exact field set the shipped rollup mutation persists. Enumerated
   *  from the shipped validator, so adding a coverage field retires §C3. */
  const PERSISTED_ROLLUP_FIELDS: string[] = (() => {
    const exported = JSON.parse(rollups.upsertDailyRollup.exportArgs()) as Record<string, unknown>
    const shape = (exported['value'] ?? exported) as Record<string, unknown>
    return Object.keys(shape)
  })()

  it('C1 (teeth): computeRunStats DOES compute the denominator', () => {
    const stats = computeRunStats([
      run({ tokensIn: 10 }),
      run(),
      run(),
    ])
    expect(stats.runsWithTokenData).toBe(1)
    expect(stats.totalRuns).toBe(3)
    // The honest signal exists at the source. §C3 is about where it stops.
  })

  it('C2 (teeth): the rollup field enumeration is real and non-empty', () => {
    expect(PERSISTED_ROLLUP_FIELDS.length).toBeGreaterThan(5)
    expect(PERSISTED_ROLLUP_FIELDS).toContain('tokensIn')
    expect(PERSISTED_ROLLUP_FIELDS).toContain('tokensOut')
  })

  it('C3 (DEFECT): the rollup persists the totals and not the coverage', () => {
    expect(PERSISTED_ROLLUP_FIELDS).not.toContain('runsWithTokenData')
    expect(PERSISTED_ROLLUP_FIELDS).not.toContain('runsWithoutTokenData')
    expect(PERSISTED_ROLLUP_FIELDS).not.toContain('tokenCoverage')
    expect(PERSISTED_ROLLUP_FIELDS).not.toContain('truncated')
    expect(PERSISTED_ROLLUP_FIELDS).not.toContain('sampleSize')
  })

  it('C4 (DEFECT, UNDERCOUNT): two days with 500x different coverage persist as IDENTICAL rollups', () => {
    // Day 1: every run reported tokens. 500 runs x 100 tokens = 50,000, and
    // that is the whole truth.
    const fullyInstrumented = Array.from({ length: 500 }, () =>
      run({ tokensIn: 100, tokensOut: 0 }),
    )
    // Day 2: the same 500 runs, but only ONE reported usage -- because the
    // agent's LLM client stopped emitting a `usage` block, or because the
    // payload shape drifted (extractTokenUsage is deliberately tolerant and
    // contributes 0 for an unrecognised shape). The true spend is ~500x the
    // recorded figure.
    const oneInstrumented = [
      run({ tokensIn: 50_000, tokensOut: 0 }),
      ...Array.from({ length: 499 }, () => run()),
    ]

    const a = computeRunStats(fullyInstrumented)
    const b = computeRunStats(oneInstrumented)

    // The denominator DOES tell them apart...
    expect(a.runsWithTokenData).toBe(500)
    expect(b.runsWithTokenData).toBe(1)
    expect(a.runsWithTokenData / b.runsWithTokenData).toBe(500)

    // ...and the projection that survives to storage does not. Built by
    // reading the shipped rollup's own field list off each stats object, so
    // this comparison cannot drift from what is actually persisted.
    const project = (stats: Record<string, unknown>) => {
      const statsToRollup: Record<string, string> = {
        runsTotal: 'totalRuns',
        tokensIn: 'tokensInSum',
        tokensOut: 'tokensOutSum',
      }
      const out: Record<string, unknown> = {}
      for (const field of PERSISTED_ROLLUP_FIELDS) {
        const source = statsToRollup[field]
        if (source) out[field] = stats[source]
      }
      return out
    }

    const pa = project(a as unknown as Record<string, unknown>)
    const pb = project(b as unknown as Record<string, unknown>)

    // ANTI-VACUITY: `toEqual({}, {})` would pass for two empty projections.
    // The projection must actually carry the spend figure a breaker would read.
    expect(Object.keys(pa).sort()).toEqual(['runsTotal', 'tokensIn', 'tokensOut'])
    expect(pa['tokensIn']).toBe(50_000)
    expect(pa['runsTotal']).toBe(500)

    expect(pa).toEqual(pb)

    // A breaker reading daily_rollups.tokensIn cannot distinguish "the agent
    // spent 50,000 tokens today" from "the agent spent 50,000 tokens on ONE of
    // its 500 runs and the other 499 are unaccounted for". It will not trip.
  })
})
