/**
 * BUDGET CIRCUIT BREAKERS — ADVERSARIAL SUITE, WINDOW & CLOCK LAYER (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * "Per day" — against which clock, keyed on which instant, and what happens at
 * the seam. The shipped window primitives a budget breaker must use are:
 *
 *   convex/usage.ts    currentUsageDay(now)   -> the usage_counters partition key
 *   convex/rollups.ts  yesterdayUtc(now)      -> the rollup cron's target day
 *   convex/rollups.ts  dayBoundsUtc(date)     -> the [start, end) the day means
 *
 * Its companion is `budget_adversarial_accounting.test.ts`, which grades the
 * NUMBER. This file grades the INTERVAL that number is summed over. A breaker
 * is a comparison of the two, and either half can halt a business on its own.
 *
 * ── THE FINDING ───────────────────────────────────────────────────────────
 * A MALFORMED DAY IS INDISTINGUISHABLE FROM AN EMPTY DAY, AND EMPTY READS AS
 * "NOTHING SPENT".
 *
 * `dayBoundsUtc` returns a well-typed `{ start: number, end: number }` for any
 * input. Given anything Date.parse cannot read -- including the single most
 * likely caller mistake, passing a full ISO timestamp to a parameter documented
 * as "YYYY-MM-DD" -- it returns `{ NaN, NaN }`. Every `start <= x < end`
 * comparison against NaN bounds is false, so the window contains NOTHING, the
 * spend sums to zero, and the breaker does not trip. No throw, no log, no
 * signal. This is the negative-clause trap that has now produced defects in
 * nine layers, arriving through arithmetic instead of through `.every()`.
 *
 * The counterpart is worse in the other direction: `currentUsageDay` and
 * `yesterdayUtc` DO throw -- a bare `RangeError: Invalid time value` -- on a
 * non-finite clock. Two sibling functions in the same feature, one silently
 * empty and one throwing, and a breaker's behaviour on each depends entirely on
 * whether it fails open or closed.
 *
 * ── ANTI-VACUITY ──────────────────────────────────────────────────────────
 * Every assertion is against a shipped function's OUTPUT on a constructed
 * input. The day sweeps enumerate their subjects from generated calendar data
 * (a full year, and the month/year seams) rather than from a hand list, so a
 * change to the boundary arithmetic is graded without this file changing. Each
 * defect is paired with a counterweight on a neighbouring input proving the
 * same primitive is correct there.
 */

import { describe, expect, it } from 'vitest'

import { currentUsageDay } from '../../convex/usage.js'

/**
 * `convex/rollups.ts` is loaded through a non-literal specifier ON PURPOSE --
 * see the identical note in `budget_adversarial_accounting.test.ts`. Briefly:
 * a static import drags a backend file written under
 * `exactOptionalPropertyTypes: false` into the stricter `tests/` project and
 * fails typecheck on code this suite does not own, and the seam tsconfig that
 * exists for that case is outside Team D's edit boundary. The functions called
 * below are the shipped ones either way.
 */
const ROLLUPS_MODULE = '../../convex/rollups.js'
const { dayBoundsUtc, yesterdayUtc } = (await import(/* @vite-ignore */ ROLLUPS_MODULE)) as {
  dayBoundsUtc: (date: string) => { start: number; end: number }
  yesterdayUtc: (now?: number) => string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Every "YYYY-MM-DD" in a full UTC year. The sweep's subject set. */
function daysOfYear(year: number): string[] {
  const out: string[] = []
  let t = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  while (t < end) {
    out.push(new Date(t).toISOString().slice(0, 10))
    t += DAY_MS
  }
  return out
}

// ===========================================================================
// §W  THE WINDOW
// ===========================================================================
describe('budget/W — the spend window', () => {
  it('W1 (teeth): the boundary arithmetic is correct for every day of a leap year', () => {
    // Counterweight for all of §W. If the primitives were simply broken,
    // nothing below would mean anything. 2024 is a leap year; the sweep is
    // generated, not listed.
    const days = daysOfYear(2024)
    expect(days.length).toBe(366)

    const wrong = days.filter((d) => {
      const { start, end } = dayBoundsUtc(d)
      return (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end - start !== DAY_MS ||
        new Date(start).toISOString().slice(0, 10) !== d
      )
    })
    expect(wrong).toEqual([])
  })

  it('W2 (teeth): consecutive days are exactly contiguous, with no gap and no overlap', () => {
    const days = daysOfYear(2024)
    const discontinuities = days.slice(0, -1).filter((d, i) => {
      return dayBoundsUtc(d).end !== dayBoundsUtc(days[i + 1]!).start
    })
    expect(discontinuities).toEqual([])
  })

  /**
   * A GENERATED classification of every "2024-MM-DD" spelling for MM in 1..13
   * and DD in 1..32, graded against what `dayBoundsUtc` actually returns.
   *
   * This sweep exists because the first draft of W3 was a HAND LIST of dates
   * the author believed were rejected, and it was wrong: `2024-02-30` is not
   * rejected, it silently becomes March 1. The list was replaced with data.
   */
  const dateSweep = (() => {
    const nonFinite: string[] = []
    const silentlyDifferentDay: Array<{ spelled: string; became: string }> = []
    const faithful: string[] = []
    for (let m = 1; m <= 13; m++) {
      for (let d = 1; d <= 32; d++) {
        const spelled = `2024-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        const { start } = dayBoundsUtc(spelled)
        if (!Number.isFinite(start)) nonFinite.push(spelled)
        else {
          const became = new Date(start).toISOString().slice(0, 10)
          if (became !== spelled) silentlyDifferentDay.push({ spelled, became })
          else faithful.push(spelled)
        }
      }
    }
    return { nonFinite, silentlyDifferentDay, faithful, total: 13 * 32 }
  })()

  it('W3 (teeth): the sweep classifies every generated spelling into exactly one bucket', () => {
    expect(
      dateSweep.nonFinite.length +
        dateSweep.silentlyDifferentDay.length +
        dateSweep.faithful.length,
    ).toBe(dateSweep.total)
    // And it found the real calendar inside the noise, so it is not blind.
    expect(dateSweep.faithful.length).toBe(366)
  })

  it('W3a (DEFECT, UNDERCOUNT -> the breaker never trips): a malformed day is a SILENTLY EMPTY window', () => {
    // The likeliest caller mistake of all is first: passing the ISO instant
    // you already have to a parameter documented as "YYYY-MM-DD".
    const malformed = [
      '2024-03-01T00:00:00Z', // a full ISO instant
      '2024-03-01 ', // a trailing space
      '01/03/2024', // a locale-formatted date
      '', // an unset config value
      'yesterday',
      ...dateSweep.nonFinite, // and every generated spelling that parses to NaN
    ]
    expect(dateSweep.nonFinite.length).toBeGreaterThan(0) // teeth

    const results = malformed.map((d) => ({ d, bounds: dayBoundsUtc(d) }))

    // Every one of them returns a well-typed object...
    const nonObject = results.filter(
      (r) => typeof r.bounds !== 'object' || typeof r.bounds.start !== 'number',
    )
    expect(nonObject).toEqual([])

    // ...and every one of them is non-finite, i.e. an empty window.
    expect(results.filter((r) => Number.isFinite(r.bounds.start))).toEqual([])

    // The consequence, proven rather than asserted: a real run that MUST fall
    // inside any honest window is excluded by all of them, using the same
    // half-open predicate the shipped rollup query applies to `startedAt`.
    const runStartedAt = Date.parse('2024-03-01T12:00:00.000Z')
    const inWindow = ({ start, end }: { start: number; end: number }) =>
      runStartedAt >= start && runStartedAt < end

    expect(results.filter((r) => inWindow(r.bounds))).toEqual([])
    // ...while the well-formed spelling of the same day DOES contain it.
    expect(inWindow(dayBoundsUtc('2024-03-01'))).toBe(true)

    // So: mistype the window and the day's spend is zero. Zero clears every
    // limit. The breaker stays closed and money keeps burning, with the
    // failure indistinguishable from a genuinely quiet day.
  })

  it('W3b (DEFECT, BOTH DIRECTIONS): an impossible date silently becomes a DIFFERENT day', () => {
    // Discovered by the sweep, not by belief. `Date.parse` is lenient here, so
    // day-31 of a 30-day month -- and Feb 30/31 -- roll forward into the next
    // month instead of being rejected.
    expect(dateSweep.silentlyDifferentDay.length).toBeGreaterThan(0)

    // Every one of them returns a perfectly well-formed 24h window...
    const malformedWindows = dateSweep.silentlyDifferentDay.filter(({ spelled }) => {
      const { start, end } = dayBoundsUtc(spelled)
      return !Number.isFinite(start) || end - start !== DAY_MS
    })
    expect(malformedWindows).toEqual([])

    // ...for the WRONG DAY. Reproduction, read off the sweep rather than typed:
    const feb30 = dateSweep.silentlyDifferentDay.find((r) => r.spelled === '2024-02-30')
    expect(feb30).toBeDefined()
    expect(feb30!.became).toBe('2024-03-01')
    expect(dayBoundsUtc('2024-02-30')).toEqual(dayBoundsUtc('2024-03-01'))

    // A breaker whose window is computed from an impossible date enforces
    // against a DIFFERENT day's spend with full confidence. That is both
    // failure directions at once: it will not trip on the day it was meant to
    // guard, and it may trip on a day it was never meant to touch. Nothing in
    // the return value distinguishes this from a correct window.
  })

  it('W4 (DEFECT): the two sibling clock primitives disagree on how to fail', () => {
    // `dayBoundsUtc` is silently empty on bad input (W3). Its siblings THROW.
    // A breaker that wraps its accounting in a try/catch and fails open is
    // therefore bypassable by anything that perturbs the clock; one that fails
    // closed halts the business on the same input. Both behaviours are
    // reachable from the same feature.
    expect(() => currentUsageDay(Number.NaN)).toThrow(RangeError)
    expect(() => yesterdayUtc(Number.NaN)).toThrow(RangeError)
    expect(() => currentUsageDay(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => currentUsageDay(8.64e15 + 1)).toThrow(RangeError) // past max Date

    // ...and no exception at all from the sibling, on input just as bad.
    expect(() => dayBoundsUtc('not-a-day')).not.toThrow()

    // Counterweight: both are correct on a good clock, so the throws above are
    // a property of the input and not of the functions being broken.
    expect(currentUsageDay(Date.parse('2024-03-01T12:00:00Z'))).toBe('2024-03-01')
    expect(yesterdayUtc(Date.parse('2024-03-01T12:00:00Z'))).toBe('2024-02-29')
  })

  it('W5 (DEFECT): the window is keyed on ONE instant, so a straddling run lands wholly on one side', () => {
    // The rollup selects runs by `startedAt` within [start, end). A run is an
    // interval; the window predicate is a point test. Both failure modes are
    // reachable, and neither is signalled.
    const d1 = dayBoundsUtc('2024-03-01')
    const d2 = dayBoundsUtc('2024-03-02')
    const byStart = (startedAt: number, w: { start: number; end: number }) =>
      startedAt >= w.start && startedAt < w.end

    // A run that starts one millisecond before midnight and then spends for
    // three hours is attributed ENTIRELY to March 1 -- including the spend
    // that happened on March 2.
    const straddler = d2.start - 1
    expect(byStart(straddler, d1)).toBe(true)
    expect(byStart(straddler, d2)).toBe(false)

    // DIRECTION, BOTH WAYS:
    //   - March 1's total includes three hours of March 2's money. A per-day
    //     breaker on March 1 can trip on spend that has not happened yet in
    //     the window it is guarding.
    //   - March 2's total excludes it. A long-running agent that starts once
    //     before midnight and spends all of the next day is invisible to
    //     March 2's breaker entirely.

    // And the seam is exact, so this is not an off-by-one in the test: the
    // instant one millisecond later is on the other side, and only the other
    // side.
    expect(byStart(d2.start, d1)).toBe(false)
    expect(byStart(d2.start, d2)).toBe(true)
  })

  it('W6 (DEFECT): "per day" is UTC-only, so no customer\'s budget day is their own', () => {
    // Not a bug in the arithmetic -- a claim-boundary defect. Every window in
    // the product is a UTC calendar day, derived here from shipped output.
    const boundaries = daysOfYear(2024).map((d) => dayBoundsUtc(d).start)
    const offsetsWithinUtcDay = new Set(boundaries.map((b) => b % DAY_MS))
    expect(offsetsWithinUtcDay).toEqual(new Set([0]))

    // So a US-Pacific org's "daily budget" resets at 16:00 or 17:00 local,
    // shifting by an hour twice a year while the reset instant itself never
    // moves. A budget described to an operator as "per day" is per UTC day,
    // and nothing in the shipped output carries a timezone for the operator to
    // notice the difference.
    const march = dayBoundsUtc('2024-03-01')
    const july = dayBoundsUtc('2024-07-01')
    expect(Object.keys(march).sort()).toEqual(['end', 'start'])
    expect(Object.keys(july).sort()).toEqual(['end', 'start'])
    // No `timezone`, no `offset`, no `label`. Two bare epochs.
  })

  it('W7 (DEFECT, STALENESS): the only per-agent day totals are computed for YESTERDAY, never today', () => {
    // `computeDailyRollups` defaults its target date to `yesterdayUtc()`.
    // Proven from output: for any instant, the rollup target is strictly
    // before the day that instant belongs to.
    const instants = daysOfYear(2024).map((d) => dayBoundsUtc(d).start + 12 * 3600_000)
    const notBehind = instants.filter((t) => {
      const today = currentUsageDay(t)
      const target = yesterdayUtc(t)
      return !(target < today)
    })
    expect(notBehind).toEqual([])

    // The gap is a full day at minimum and approaches two days at the end of
    // the cron's window. A breaker reading daily_rollups is therefore enforcing
    // a limit against spend from between 24 and 48 hours ago, and CANNOT see
    // today's burn at all -- which is precisely the burn a circuit breaker
    // exists to stop.
    const t = dayBoundsUtc('2024-03-02').start + 23 * 3600_000
    expect(yesterdayUtc(t)).toBe('2024-03-01')
    expect(currentUsageDay(t)).toBe('2024-03-02')
    const staleness = t - dayBoundsUtc(yesterdayUtc(t)).end
    expect(staleness).toBeGreaterThan(22 * 3600_000)
  })
})
