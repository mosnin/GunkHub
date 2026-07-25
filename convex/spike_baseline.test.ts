/* eslint-disable */
/**
 * SPIKE DETECTION — regression pins for two defects that INVERTED the product's
 * promise, plus an explicit pin on the limit that remains.
 *
 * Both defects had one root cause: the baseline window is drawn from the SAME
 * trend series as the recent window, and mean/standard-deviation have a
 * BREAKDOWN POINT OF ZERO. An ongoing incident therefore contaminated its own
 * baseline, and a smooth ramp inflated nothing but the mean.
 *
 * These are pinned in their own file rather than folded into insights.test.ts
 * because they are ADVERSARIAL cases, not coverage: each one is a specific
 * trend series that produced a specific wrong answer, and the numbers below are
 * the evidence that it no longer does.
 */
import { describe, it, expect } from 'vitest'

import { assessPatternSpike } from './insights'
import { TREND_WINDOW_DAYS } from './failure_patterns'

/** Build the exact 14-point series `readAccurateTrend` produces, oldest first. */
const trend = (counts: number[]) =>
  counts.map((count, i) => ({ day: `2026-07-${String(i + 1).padStart(2, '0')}`, count }))

describe('sustained outage must not read as calm', () => {
  it('THE DEFECT: a 7-day outage was reported NOT SPIKING while it was still running', () => {
    // Identical outage, seen on day 3 and on day 7 of the same 14-day window.
    // With a mean baseline the day-7 view returned z = 1.32, isSpiking FALSE —
    // the detector grew MORE confident the fleet was calm the longer the outage
    // ran. Both must now report the incident.
    const day3 = assessPatternSpike(trend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 20, 20]))
    const day7 = assessPatternSpike(trend([0, 0, 0, 0, 0, 0, 0, 20, 20, 20, 20, 20, 20, 20]))

    expect(day3.isSpiking).toBe(true)
    expect(day7.isSpiking).toBe(true)
    // The SAME outage produces the SAME verdict regardless of how long it has
    // run — which is the property that was missing.
    expect(day7.z).toBe(day3.z)
    expect(day7.recentCount).toBe(day3.recentCount)
  })

  it('detection survives an outage occupying up to half the trend window', () => {
    // 6 of 14 days elevated: the median baseline is still drawn from quiet days.
    const day6 = assessPatternSpike(trend([0, 0, 0, 0, 0, 0, 0, 0, 20, 20, 20, 20, 20, 20]))
    expect(day6.isSpiking).toBe(true)
  })

  it('THE LIMIT THAT REMAINS, PINNED HONESTLY: an outage past half the window normalises', () => {
    // 10 of 14 days elevated. The baseline's median is now itself 20, so the
    // recent window is not elevated RELATIVE TO IT and z is 0.
    //
    // This is NOT a bug in the estimator — it is the median's breakdown point,
    // and it is a property of measuring a 10-day outage against a 14-day
    // window. No estimator that sees only this window can distinguish "still
    // broken" from "this is the new normal"; that needs a longer reference
    // series than `TREND_WINDOW_DAYS` provides.
    //
    // Pinned as a TEST rather than left as a comment so the gap is visible to
    // whoever reads this suite, and so that a future longer-baseline change has
    // an explicit expectation to update.
    const day10 = assessPatternSpike(trend([0, 0, 0, 0, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20]))
    expect(day10.isSpiking).toBe(false)
    expect(day10.z).toBe(0)
    // The COUNT is still reported, and is still large — so a reader looking at
    // volume rather than at the boolean is not misled.
    expect(day10.recentCount).toBe(60)
    expect(TREND_WINDOW_DAYS).toBe(14)
  })
})

describe('growth must not read as breakage', () => {
  it('THE DEFECT: a smooth linear ramp was reported as a spike', () => {
    // `[1..10]` has no discontinuity anywhere. With mean/std it returned
    // z = 2.5, isSpiking TRUE — a fleet that is GROWING looked like a fleet
    // that is BREAKING, and there is no exposure denominator in the signature
    // to normalise it away.
    const ramp = assessPatternSpike(trend([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    expect(ramp.isSpiking).toBe(false)
    expect(ramp.z).toBeLessThan(2)
  })

  it('a genuine step change is still detected', () => {
    // The fix must not simply desensitise the detector.
    const step = assessPatternSpike(trend([1, 1, 2, 1, 1, 2, 1, 1, 1, 1, 1, 40, 45, 50]))
    expect(step.isSpiking).toBe(true)
    expect(step.z).toBeGreaterThanOrEqual(2)
  })

  it('a noisy but flat series is not a spike', () => {
    const flat = assessPatternSpike(trend([5, 8, 3, 9, 4, 7, 5, 6, 8, 4, 5, 7, 6, 5]))
    expect(flat.isSpiking).toBe(false)
  })
})

describe('the reported numbers stay well-defined', () => {
  it('never NaN, never Infinity, on degenerate input', () => {
    for (const counts of [[], [0], [0, 0], [5, 5, 5, 5, 5, 5, 5], [0, 0, 0, 0, 1]]) {
      const r = assessPatternSpike(trend(counts))
      expect(Number.isFinite(r.z)).toBe(true)
      expect(Number.isFinite(r.baselineMean)).toBe(true)
      expect(Number.isNaN(r.z)).toBe(false)
    }
  })

  it('baselineMean remains the ARITHMETIC mean — its stored meaning is unchanged', () => {
    // Only `z` became robust. `baselineMean` is descriptive and is what the
    // stored snapshot and the CLI have always shown; changing its meaning
    // underneath existing rows would be its own silent defect.
    const r = assessPatternSpike(trend([0, 0, 0, 0, 0, 0, 0, 20, 20, 20, 20, 20, 20, 20]))
    expect(r.baselineMean).toBeCloseTo(80 / 11, 6)
  })

  it('recentCount is a SUM over the recent window, in one unit', () => {
    // The unit collision this field carried is documented in the report: the
    // shipped implementation sums the recent window (default 3 days) while a
    // second, unused implementation reported a single day's value into the same
    // field. This pins the shipped meaning.
    expect(assessPatternSpike(trend([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).recentCount).toBe(27)
  })
})
