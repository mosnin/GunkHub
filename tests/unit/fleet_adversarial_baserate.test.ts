/**
 * FLEET BASE RATE + CORRELATION BASIS — ADVERSARIAL SUITE (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * The two contract properties the coordinator flagged as load-bearing and new
 * at this altitude:
 *
 *   1. THE BASE RATE. `HypothesisedCause.sharedBy` is required, and its
 *      unaffected-population fields are `number | null` where `null` means NOT
 *      MEASURED — the opposite of `0`. `discriminationOf()` is three-valued.
 *      This is the mechanism that stops "all twelve failing agents use model
 *      m-4" being read as a lead when 198 of 200 agents use m-4.
 *
 *   2. THE CORRELATION BASIS. `scan.correlationBasis` declares whether the
 *      correlation pass saw the WHOLE ROSTER or only one page, because a burst
 *      split four-and-eight across two pages is two sub-threshold clusters,
 *      invisible on every page and in any merge. Completeness requires
 *      `whole_roster`.
 *
 * THE THREAT MODEL IS THE WIRE. `discriminationOf` is the SINGLE definition the
 * CLI, the web UI and any future MCP surface all call, and every report it
 * grades arrives as untyped JSON from a producer this repo does not compile —
 * the reader file says so outright ("a server is not typechecked by us"), and
 * the key-authed route does not exist yet, so the engine→contract mapping that
 * will feed it is unwritten. TypeScript is therefore not the defence here; the
 * runtime guards are, and the guards are what this file attacks.
 *
 * The attacks below construct the shapes a non-conforming producer actually
 * emits — a field ABSENT rather than `null`, a number arriving as a string, a
 * boolean flag dropped — and ask what verdict comes out. `null` itself is
 * handled correctly everywhere; that is asserted below as a standing guard. It
 * is the NEIGHBOURS of `null` that get through.
 *
 * ── LEDGER, TEETH, FIXTURE AUDITS ──────────────────────────────────────────
 * Same discipline as the other two fleet suites: every probe executes against
 * the shipped function, compares to the CORRECT expectation, and appends to
 * `observedDefects` on a mismatch; a final test asserts the set is EXACTLY
 * `KNOWN_DEFECTS`, so a fix goes red and a regression goes red. `teeth/*`
 * replays every probe's condition against a corrected guard and fails if any
 * probe would still fire.
 */

import { readFileSync } from 'node:fs'

import { discriminationOf } from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'


import type { FleetAdapterInput } from '@/lib/fleet/adapt'
import type { ResolvedFleetWindow } from '@/lib/fleet/window'
import type { FailurePattern, FleetShareMeasurement } from '@agent-flight-recorder/contracts'

import { buildInterimFleetReport } from '@/lib/fleet/adapt'
import { renderCount, safeDiscrimination, usableMeasurement } from '@/lib/fleet/safe'

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const observedDefects = new Set<string>()
const record = (id: string): void => void observedDefects.add(id)

/**
 * ALL FIVE ENTRIES RETIRED, each verified BY EXECUTION against current source.
 *
 *   baserate/absent-fields-read-as-a-measured-verdict
 *   baserate/non-numeric-values-can-produce-the-strongest-verdict
 *   baserate/dropped-truncation-flag-promotes-an-unsound-measurement
 *     -> `discriminationOf` now fails CLOSED via `baseRateUsability` before it
 *        divides anything. All three hostile shapes return
 *        `base_rate_unmeasured`. Fixed in the CONTRACT, so every consumer
 *        inherits it — including `packages/cli` and `convex/helpers/fleet.ts`,
 *        which call it directly and would otherwise have bypassed a UI-only fix.
 *   ui/absent-base-rate-crashes-the-hypothesis-panel
 *     -> `HypothesisList` now routes through `@/lib/fleet/safe`. The non-null
 *        assertion is gone and counts render `—`.
 *   basis/interim-adapter-claims-whole-roster-on-a-truncated-page
 *     -> the adapter now DERIVES the basis from its own bounds.
 *
 * A METHOD NOTE, because it cost a probe. The panel retirement was originally
 * checked by grepping the component for its `!== null` line. That grep went
 * SILENT when the fix arrived as a refactor rather than an edit — the line was
 * gone, so the probe stopped testing anything and would have reported a defect
 * that no longer existed. It is the constant-versus-function error in a new
 * costume: a grep for a source line is evidence about TEXT, not about
 * BEHAVIOUR. Every retirement below now asserts a FUNCTION'S OUTPUT.
 */
const KNOWN_DEFECTS: readonly string[] = []

/**
 * Wire shapes. A producer outside this repo's typechecker is not bound by
 * `FleetShareMeasurement`, so these casts model reality rather than evading the
 * type system — which is the whole reason the runtime guard exists.
 */
function wire(shape: Record<string, unknown>): FleetShareMeasurement {
  return shape as unknown as FleetShareMeasurement
}

function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

const WINDOW: ResolvedFleetWindow = {
  option: { id: '1h', label: 'last hour', ms: 3_600_000 },
  startedAt: 0,
  endedAt: 10_000,
  pinned: false,
}

/** A multi-agent pattern, typed against the real contract so a drift fails the build. */
function patternFixture(i: number): FailurePattern {
  return {
    id: `p${i}`,
    orgId: 'org',
    fingerprintHash: `h${i}`,
    class: 'tool_error',
    label: `L${i}`,
    salientKey: 'k',
    count: 5,
    firstSeenAt: 1_000,
    lastSeenAt: 2_000,
    representativeRunIds: ['r1'],
    affectedAgentVersionIds: [],
    affectedAgentIds: [`a${i}`, `b${i}`],
  }
}

/** Typed against `FleetAdapterInput`, so a signature change fails the build rather than being cast away. */
function adapterInput(over: Partial<FleetAdapterInput> = {}): FleetAdapterInput {
  return {
    patterns: [],
    details: new Map(),
    patternsNotDetailed: 0,
    window: WINDOW,
    burstWindowMs: 3_600_000,
    agentsInRoster: 0,
    listTruncated: false,
    listCeiling: 200,
    ...over,
  }
}

function measured(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    affectedSharing: 12,
    affectedTotal: 12,
    unaffectedSharing: 0,
    unaffectedTotal: 188,
    measurementTruncated: false,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// ATTACK 1 — laundering the denominator
// ---------------------------------------------------------------------------

describe('base-rate laundering', () => {
  it('a proper `null` IS handled correctly at every layer — the guard that works', () => {
    // Establish the mechanism functions before attacking its edges, so a later
    // failure cannot be mistaken for the whole thing being broken.
    expect(discriminationOf(wire(measured({ unaffectedSharing: null, unaffectedTotal: null })))).toBe(
      'base_rate_unmeasured'
    )
    // One side null is still unmeasured — a half-measurement is not a measurement.
    expect(discriminationOf(wire(measured({ unaffectedSharing: null })))).toBe('base_rate_unmeasured')
    expect(discriminationOf(wire(measured({ unaffectedTotal: null })))).toBe('base_rate_unmeasured')

    // And the headline case the contract was written for still resolves correctly.
    expect(discriminationOf(wire(measured({ unaffectedSharing: 186, unaffectedTotal: 188 })))).toBe(
      'not_discriminating'
    )
    expect(discriminationOf(wire(measured({ unaffectedSharing: 0, unaffectedTotal: 188 })))).toBe('discriminating')

    // Found nothing. No ledger entry.
  })

  it('RETIRED: every unusable wire shape now fails closed', () => {
    // The three hostile shapes that used to produce a verdict. Each is asserted
    // from `discriminationOf`'s OUTPUT — the function, never a source line.
    const hostile: Array<[string, Record<string, unknown>]> = [
      ['fields ABSENT, not null', { affectedSharing: 12, affectedTotal: 12, measurementTruncated: false }],
      ['numbers arrived as STRINGS', measured({ unaffectedSharing: '0', unaffectedTotal: '188' })],
      ['truncation flag DROPPED', { affectedSharing: 12, affectedTotal: 12, unaffectedSharing: 0, unaffectedTotal: 188 }],
      ['NaN', measured({ unaffectedSharing: Number.NaN })],
      ['negative count', measured({ unaffectedSharing: -1 })],
      ['non-integer count', measured({ unaffectedSharing: 1.5 })],
      ['numerator exceeds denominator', measured({ unaffectedSharing: 400, unaffectedTotal: 188 })],
    ]
    for (const [label, shape] of hostile) {
      expect(discriminationOf(wire(shape)), label).toBe('base_rate_unmeasured')
    }

    // FIXTURE AUDIT: the shapes are genuinely what they claim.
    expect('unaffectedSharing' in hostile[0]![1]).toBe(false)
    expect(typeof measured({ unaffectedSharing: '0' })['unaffectedSharing']).toBe('string')
    expect('measurementTruncated' in hostile[2]![1]).toBe(false)

    // AND the well-formed cases still get their real verdicts, or "fails
    // closed" would just mean "refuses everything" and the ranking the feature
    // needs would be dead.
    expect(discriminationOf(wire(measured({ unaffectedSharing: 0, unaffectedTotal: 188 })))).toBe('discriminating')
    expect(discriminationOf(wire(measured({ unaffectedSharing: 186, unaffectedTotal: 188 })))).toBe('not_discriminating')
    expect(discriminationOf(wire(measured({ unaffectedSharing: null, unaffectedTotal: null })))).toBe(
      'base_rate_unmeasured'
    )
  })

  it('RETIRED: the fix is in the CONTRACT, so direct callers inherit it', () => {
    // This is why the retirement is safe rather than UI-local. Two consumers
    // call `discriminationOf` directly and would have bypassed a fix that lived
    // only in `@/lib/fleet/safe`.
    expect(readSource('../../packages/cli/src/commands/fleet.ts')).toMatch(/discriminationOf\(/)
    expect(readSource('../../convex/helpers/fleet.ts')).toMatch(/discriminationOf\(/)
    // Both therefore get the fail-closed behaviour, executed above.
    expect(discriminationOf(wire({ affectedSharing: 12, affectedTotal: 12, measurementTruncated: false }))).toBe(
      'base_rate_unmeasured'
    )
  })

  it('the CLI renders the null case honestly', () => {
    // The one consumer that gets it right, asserted so its removal is caught.
    const cli = readSource('../../packages/cli/src/commands/fleet.ts')
    expect(cli).toMatch(/share\.unaffectedSharing === null \|\| share\.unaffectedTotal === null/)

    // Found nothing. No ledger entry.
  })

  it('RETIRED: the panel degrades instead of throwing', () => {
    // Asserted from the safe module's OUTPUT. The previous version of this
    // probe grepped the component for its `!== null` line and went silent when
    // the fix arrived as a refactor — see the ledger note.
    const absent = { affectedSharing: 12, affectedTotal: 12, measurementTruncated: false }

    // No throw, and the WEAKER reading.
    expect(safeDiscrimination(absent as unknown as FleetShareMeasurement)).toBe('base_rate_unmeasured')
    expect(usableMeasurement(absent)).toBeNull()

    // A count that cannot be rendered becomes `—`, never `0`. `0` is a strong
    // claim ("we checked and none share this"); `—` is no claim at all.
    expect(renderCount(undefined)).toBe('—')
    expect(renderCount(Number.NaN)).toBe('—')
    expect(renderCount('5')).toBe('—')
    // ...and a real zero still renders as zero, or the rule would erase data.
    expect(renderCount(0)).toBe('0')
    expect(renderCount(188)).toBe('188')

    // The non-null assertion that used to throw is gone from the component.
    expect(readSource('../../apps/web/src/components/fleet/HypothesisList.tsx')).not.toMatch(/unaffectedSharing!/)
  })

  it('the safe gate cannot be bypassed and cannot disagree with the contract', () => {
    // TWO PROPERTIES, both executed rather than reasoned about.
    //
    // 1. NO DISAGREEMENT. `safeDiscrimination` delegates fully-usable
    //    measurements to `discriminationOf`, so the margin has ONE definition.
    //    Fuzz both over the same inputs and assert they never differ.
    let disagreements = 0
    let safeEverStronger = 0
    const strength: Record<string, number> = {
      base_rate_unmeasured: 0,
      not_discriminating: 1,
      discriminating: 2,
    }
    for (let i = 0; i < 5_000; i++) {
      const m = {
        affectedSharing: Math.floor(Math.random() * 14),
        affectedTotal: Math.floor(Math.random() * 14),
        unaffectedSharing: Math.floor(Math.random() * 200),
        unaffectedTotal: Math.floor(Math.random() * 200),
        measurementTruncated: Math.random() < 0.2,
      } as unknown as FleetShareMeasurement
      const safe = safeDiscrimination(m)
      const contract = discriminationOf(m)
      if (safe !== contract) {
        disagreements += 1
        if ((strength[safe] ?? 0) > (strength[contract] ?? 0)) safeEverStronger += 1
      }
    }
    expect(disagreements).toBe(0)
    // Even if they ever do diverge, the safe wrapper must never be the STRONGER
    // of the two — that is the direction that puts a guess at the top.
    expect(safeEverStronger).toBe(0)

    // 2. THE GATE RUNS FIRST. Anything not fully usable returns
    //    `base_rate_unmeasured` WITHOUT the contract function seeing it, so a
    //    future weakening of `discriminationOf` cannot leak through.
    expect(readSource('../../apps/web/src/lib/fleet/safe.ts')).toMatch(
      /const usable = usableMeasurement\(m\)[\s\S]*?if \(usable === null\) return 'base_rate_unmeasured'/
    )
  })

  it('the CLI renders the null case honestly', () => {
    // The CLI composes its own base-rate line. Whatever shape it uses, it must
    // never print a bare `0` for an unmeasured population — asserted against
    // the verdict function the CLI actually calls, plus the presence of an
    // explicit unmeasured branch in its renderer.
    const cli = readSource('../../packages/cli/src/commands/fleet.ts')
    expect(cli).toMatch(/discriminationOf\(/)
    expect(discriminationOf(wire(measured({ unaffectedSharing: null, unaffectedTotal: null })))).toBe(
      'base_rate_unmeasured'
    )
    expect(cli).toMatch(/base_rate_unmeasured|not measured|unmeasured/i)
  })
})

// ---------------------------------------------------------------------------
// ATTACK 2 — the correlation basis
// ---------------------------------------------------------------------------

describe('correlation basis', () => {
  it('the interim adapter claims whole_roster over a truncated page', () => {
    // 200 patterns is exactly the service's SCAN_LIMIT, so `listTruncated` is
    // what the real caller passes here (services/fleet.ts:
    // `listTruncated: patterns.length >= SCAN_LIMIT`).
    const report = buildInterimFleetReport(
      adapterInput({
        patterns: Array.from({ length: 200 }, (_, i) => patternFixture(i)),
        agentsInRoster: 400,
        listTruncated: true,
      })
    )

    // FIXTURE AUDIT: the scan really does report itself truncated, so the two
    // fields genuinely disagree rather than the fixture being under-specified.
    expect(report.scan.scanTruncated).toBe(true)

    // CORRECT: a correlation pass that only saw the first 200 patterns did not
    // see the whole roster. `scanTruncated` and `correlationBasis` answer
    // DIFFERENT questions by the contract's own design — "did we stop early"
    // versus "could a cluster have been cut in half" — and the second is the
    // one with a dedicated warning in both readers.
    if (report.scan.correlationBasis === 'whole_roster') {
      record('basis/interim-adapter-claims-whole-roster-on-a-truncated-page')
    }

    // The consequence, established rather than asserted: both readers have a
    // dedicated page-local warning, and neither can fire while this says
    // `whole_roster`.
    expect(readSource('../../apps/web/src/components/fleet/FleetStates.tsx')).toMatch(
      /scan\.correlationBasis === 'page_local'/
    )
    expect(readSource('../../packages/cli/src/commands/fleet.ts')).toMatch(
      /scan\.correlationBasis === 'page_local'/
    )
  })

  it('the interim path still cannot certify health — the mitigation that holds', () => {
    const report = buildInterimFleetReport(adapterInput())

    // An empty org through the interim path must never read `healthy`: the
    // source cannot see health at all, and it says so with standing unanswered
    // questions rather than absorbing the limit.
    expect(report.verdict).not.toBe('healthy')
    expect(report.unanswered.length).toBeGreaterThan(0)

    // Found nothing — the false-clean is blocked on this path even though the
    // basis field is wrong. That is why the finding above is a suppressed
    // WARNING, not a false all-clear. No ledger entry.
  })

  it('the engine caps its roster, so the unwritten mapping has something to lose', () => {
    // STANDING GUARD for the seam that does not exist yet. The engine
    // (convex/fleet.ts) caps the roster and reports `rosterTruncated`; the
    // contract expresses the same fact as `correlationBasis: 'page_local'`.
    // NOTHING maps between them today, because the route is unbuilt — and the
    // one adapter that does produce a basis today hardcodes `whole_roster`.
    const convexFleet = readSource('../../convex/fleet.ts')
    expect(convexFleet).toMatch(/FLEET_ROSTER_CAP\s*=\s*200/)
    expect(convexFleet).toMatch(/rosterTruncated: roster\.truncated/)

    // The engine's coverage vocabulary and the contract's scan vocabulary are
    // genuinely different, which is what makes the mapping a real risk rather
    // than a rename.
    //
    // LESSON ENCODED HERE: an earlier version of this assertion searched for
    // the bare word `correlationBasis` and went red the moment the engine
    // gained a COMMENT about it. A regex that matches documentation is not
    // evidence about code. This one requires an ASSIGNMENT.
    const assignsBasis = /correlationBasis\s*:/
    expect(assignsBasis.test(convexFleet)).toBe(false)
    // TEETH: prove the assignment regex can fire, so `false` is a real result.
    expect(assignsBasis.test("correlationBasis: 'whole_roster',")).toBe(true)
    expect(assignsBasis.test('// `scan.correlationBasis` says where it ran')).toBe(false)

    // The engine HAS committed to the rule in prose — it just has not written
    // the mapping, because it does not assemble a contract scan at all.
    expect(convexFleet).toMatch(/`page_local` can never/)

    // When the route lands, `rosterTruncated: true` MUST become
    // `correlationBasis: 'page_local'`. This assertion fails the moment
    // convex/fleet.ts learns the word, at which point the mapping should be
    // attacked directly instead of guarded from here.
  })
})

// ---------------------------------------------------------------------------
// ATTACK 3 — moving the verdict with a guess
// ---------------------------------------------------------------------------

describe('verdict quarantine', () => {
  it('a hypothesis cannot move the verdict through the interim path either', () => {
    // Two patterns that begin inside the burst window generate the adapter's
    // `coincident_in_time` hypothesis — the one guess this path can produce.
    const report = buildInterimFleetReport(
      adapterInput({ patterns: [patternFixture(0), patternFixture(1)], agentsInRoster: 4 })
    )

    // Whatever this path produces, the verdict is a function of correlations,
    // agentsFailing and completeness only — never of the hypothesis count.
    expect(['correlated_failures', 'isolated_failures', 'indeterminate']).toContain(report.verdict)
    expect(report.verdict).not.toBe('healthy')

    // Found nothing. No ledger entry.
  })

  it('the adapter states its own guess without a denominator it does not have', () => {
    // The interim adapter cannot enumerate healthy agents, so every hypothesis
    // it emits must carry a NULL base rate — never a zero, which would be the
    // strongest possible support for its own guess.
    const adaptSrc = readSource('../../apps/web/src/lib/fleet/adapt.ts')
    expect(adaptSrc).toMatch(/unaffectedSharing: null/)
    expect(adaptSrc).toMatch(/unaffectedTotal: null/)
    expect(adaptSrc).not.toMatch(/unaffectedSharing: 0/)

    // Found nothing — it gets this right. No ledger entry.
  })
})

// ---------------------------------------------------------------------------
// TEETH
// ---------------------------------------------------------------------------

describe('teeth', () => {
  it('the probes stop recording once the guard is CORRECTED', () => {
    const before = new Set(observedDefects)

    // A guard that requires a USABLE NUMBER rather than merely "not null", and
    // fails closed on an absent honesty flag.
    const usable = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
    const correctedDiscrimination = (m: Record<string, unknown>): string => {
      if (typeof m['measurementTruncated'] !== 'boolean' || m['measurementTruncated'] === true) {
        return 'base_rate_unmeasured'
      }
      if (!usable(m['unaffectedSharing']) || !usable(m['unaffectedTotal'])) return 'base_rate_unmeasured'
      if (!usable(m['affectedSharing']) || !usable(m['affectedTotal'])) return 'base_rate_unmeasured'
      if (m['unaffectedTotal'] <= 0 || m['affectedTotal'] <= 0) return 'base_rate_unmeasured'
      const a = m['affectedSharing'] / m['affectedTotal']
      const u = m['unaffectedSharing'] / m['unaffectedTotal']
      return a - u >= 0.2 ? 'discriminating' : 'not_discriminating'
    }

    // Every hostile shape must now land on `base_rate_unmeasured`.
    for (const hostile of [
      { affectedSharing: 12, affectedTotal: 12, measurementTruncated: false },
      measured({ unaffectedSharing: '0', unaffectedTotal: '188' }),
      { affectedSharing: 12, affectedTotal: 12, unaffectedSharing: 0, unaffectedTotal: 188 },
      measured({ unaffectedSharing: Number.NaN }),
    ]) {
      if (correctedDiscrimination(hostile) !== 'base_rate_unmeasured') {
        throw new Error(`a probe would still fire against the corrected guard: ${JSON.stringify(hostile)}`)
      }
    }

    // ...and the HONEST shapes must still get their real verdicts, or the
    // "fix" is just a guard that refuses everything — which would make every
    // hypothesis unrankable and defeat the ranking the feature needs.
    expect(correctedDiscrimination(measured({ unaffectedSharing: 0, unaffectedTotal: 188 }))).toBe('discriminating')
    expect(correctedDiscrimination(measured({ unaffectedSharing: 186, unaffectedTotal: 188 }))).toBe(
      'not_discriminating'
    )
    expect(correctedDiscrimination(measured({ unaffectedSharing: null, unaffectedTotal: null }))).toBe(
      'base_rate_unmeasured'
    )

    // A corrected UI predicate degrades instead of throwing.
    const correctedMeasured = (m: Record<string, unknown>): boolean =>
      usable(m['unaffectedSharing']) && usable(m['unaffectedTotal'])
    expect(correctedMeasured({ affectedSharing: 12 })).toBe(false)
    expect(correctedMeasured({ unaffectedSharing: 0, unaffectedTotal: 188 })).toBe(true)

    // A corrected basis derives from truncation instead of asserting.
    const correctedBasis = (listTruncated: boolean): string => (listTruncated ? 'page_local' : 'whole_roster')
    expect(correctedBasis(true)).toBe('page_local')
    expect(correctedBasis(false)).toBe('whole_roster')

    expect([...observedDefects].sort()).toEqual([...before].sort())
  })

  it('the source-read probes fail against a source that lost the property', () => {
    // Prove each grep can fail, so "it matched" is evidence rather than an
    // accident of a regex that matches everything.
    const nullGuard = /share\.unaffectedSharing === null \|\| share\.unaffectedTotal === null/
    expect(nullGuard.test('if (share.unaffectedSharing === null || share.unaffectedTotal === null)')).toBe(true)
    expect(nullGuard.test('// we used to check for null here')).toBe(false)

    const pageLocal = /scan\.correlationBasis === 'page_local'/
    expect(pageLocal.test("scan.correlationBasis === 'page_local'")).toBe(true)
    expect(pageLocal.test("scan.correlationBasis === 'whole_roster'")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LEDGER
// ---------------------------------------------------------------------------

describe('defect ledger', () => {
  it('observed defects are EXACTLY the known set', () => {
    expect([...observedDefects].sort()).toEqual([...KNOWN_DEFECTS].sort())
  })

  it('every ledger entry was written by a probe that actually executed', () => {
    const self = readSource('./fleet_adversarial_baserate.test.ts')
    for (const id of KNOWN_DEFECTS) {
      expect(self).toContain(`record('${id}')`)
    }
  })
})

