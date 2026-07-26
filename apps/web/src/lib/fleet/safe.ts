/**
 * fleet/safe.ts — checking for USABILITY, not for `null`.
 *
 * ===========================================================================
 * THE BUG FAMILY THIS EXISTS TO CLOSE
 * ===========================================================================
 *
 * `FleetShareMeasurement.unaffectedSharing` is typed `number | null`, and
 * `null` is handled perfectly everywhere in this codebase — because `null` is
 * the case that was DESIGNED for. Everything else falls through to whichever
 * branch a comparison happens to land on:
 *
 *   ABSENT        `undefined !== null` is TRUE, so an absent field passes a
 *                 null guard and reaches `.toLocaleString()`. Executed, it
 *                 throws — and it throws on the one screen whose entire
 *                 purpose is to be readable during an outage.
 *   WRONG-TYPED   `'0'` and `'188'` arrive from the wire as strings. They pass
 *                 every `!== null` check, divide as numbers under `/`, and can
 *                 promote a hypothesis to `discriminating` — i.e. to the top of
 *                 what an operator reads first — from unvalidated data.
 *   NaN           every comparison with NaN is false, so a NaN base rate slides
 *                 past a `>= MARGIN` test into `not_discriminating`, which is a
 *                 CLAIM about the healthy population that nothing supports.
 *   DROPPED FLAG  a missing `measurementTruncated` is falsy, so the "these
 *                 numbers are floors" branch never runs and floors are compared
 *                 as if they were totals.
 *
 * All four are the same defect: a check for `null` where what is needed is a
 * check for whether the value can be USED. The type says `number | null`; the
 * wire says anything at all. A UI that trusts the type on a boundary it does
 * not own is asserting something it cannot know.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND ITS DIRECTION
 * ---------------------------------------------------------------------------
 *
 * Every helper here answers "is this usable?" and, when the answer is no,
 * degrades toward the WEAKER claim — never toward the stronger one, and never
 * toward a crash:
 *
 *   an unusable count           renders as `—`, never as `0`
 *   an unusable timestamp       renders as `unknown`, never as an epoch date
 *   an unusable measurement     reports `base_rate_unmeasured`, never
 *                               `discriminating` and never `not_discriminating`
 *   an unusable array           is empty, and callers that require non-empty
 *                               drop the row rather than render half of it
 *
 * That direction is the whole point. `0` is a strong claim ("we checked the
 * healthy agents and none share this"); `—` is no claim. `not_discriminating`
 * is a claim about the healthy population. Degrading toward the weaker reading
 * means malformed data can only ever make the screen say LESS, never more.
 */

import { discriminationOf, FLEET_DISCRIMINATION_MARGIN } from '@agent-flight-recorder/contracts'

import type { FleetShareMeasurement, ShareDiscrimination } from '@agent-flight-recorder/contracts'


/**
 * A count that can actually be rendered and compared: a real number, finite,
 * non-negative, and an integer.
 *
 * String digits are REJECTED rather than coerced. Coercion is what turns a
 * wire-shape bug into a confidently-wrong ratio: `'188' / '200'` divides fine
 * in JavaScript and produces a number an operator will act on.
 */
export function usableCount(v: unknown): number | null {
  if (typeof v !== 'number') return null
  if (!Number.isFinite(v)) return null
  if (!Number.isInteger(v)) return null
  if (v < 0) return null
  return v
}

/** A count for display. `—` means "not a usable value", never zero. */
export function renderCount(v: unknown): string {
  const n = usableCount(v)
  return n === null ? '—' : n.toLocaleString()
}

/**
 * A timestamp that can be placed on a time axis. Rejects NaN, Infinity, and
 * non-positive epochs — a `0` timestamp renders as 1970 and silently drags
 * every span on the page to the far left.
 */
export function usableTimestamp(v: unknown): number | null {
  if (typeof v !== 'number') return null
  if (!Number.isFinite(v)) return null
  if (v <= 0) return null
  return v
}

/** An array that is really an array. Anything else is empty, never a crash. */
export function usableArray<T>(v: unknown): readonly T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** A boolean that is really a boolean. `undefined` is NOT `false`. */
export function isExactlyFalse(v: unknown): boolean {
  return v === false
}

/**
 * A fully validated share measurement, or `null` when any part of it is
 * unusable.
 *
 * NOTE `measurementTruncated`: this requires it to be EXACTLY `false`. A
 * missing flag is not a promise that nothing was truncated — it is the absence
 * of a promise, and the contract's own `discriminationOf` reads it as falsy and
 * proceeds. Requiring `false` is the difference between "we were told the
 * measurement was complete" and "nobody said otherwise".
 *
 * `affectedTotal` must be > 0: a ratio over a zero denominator is not a weak
 * measurement, it is not a measurement.
 */
export interface UsableShareMeasurement {
  affectedSharing: number
  affectedTotal: number
  unaffectedSharing: number
  unaffectedTotal: number
}

export function usableMeasurement(m: unknown): UsableShareMeasurement | null {
  if (m === null || typeof m !== 'object') return null
  const raw = m as Record<string, unknown>

  if (!isExactlyFalse(raw['measurementTruncated'])) return null

  const affectedSharing = usableCount(raw['affectedSharing'])
  const affectedTotal = usableCount(raw['affectedTotal'])
  const unaffectedSharing = usableCount(raw['unaffectedSharing'])
  const unaffectedTotal = usableCount(raw['unaffectedTotal'])

  if (affectedSharing === null || affectedTotal === null) return null
  if (unaffectedSharing === null || unaffectedTotal === null) return null
  if (affectedTotal <= 0 || unaffectedTotal <= 0) return null
  // A numerator larger than its denominator is not a rate; it is a shape bug,
  // and it inflates in the discriminating direction.
  if (affectedSharing > affectedTotal || unaffectedSharing > unaffectedTotal) return null

  return { affectedSharing, affectedTotal, unaffectedSharing, unaffectedTotal }
}

/**
 * `discriminationOf`, but it cannot be reached with data it would misread.
 *
 * The contract's function is correct for well-formed input and this does not
 * replace it — a fully usable measurement is delegated straight to it, so there
 * is exactly one definition of the margin rule and this module cannot drift
 * from it. What this adds is a gate: anything not fully usable returns
 * `base_rate_unmeasured` WITHOUT the contract function ever seeing it.
 *
 * That ordering matters. `discriminationOf` divides before it compares, so a
 * string or a NaN reaching it produces a verdict rather than a rejection, and
 * two of those verdicts rank a hypothesis to the top of the screen.
 */
export function safeDiscrimination(m: FleetShareMeasurement): ShareDiscrimination {
  const usable = usableMeasurement(m)
  if (usable === null) return 'base_rate_unmeasured'

  const verdict = discriminationOf({ ...usable, measurementTruncated: false })

  // Belt and braces: if the contract's margin rule is ever changed in a way
  // that can return a verdict the recomputation here disagrees with, prefer the
  // weaker reading. This is not distrust of the contract — it is the same
  // "degrade toward the weaker claim" rule applied to our own dependency.
  const affectedRate = usable.affectedSharing / usable.affectedTotal
  const unaffectedRate = usable.unaffectedSharing / usable.unaffectedTotal
  const discriminating = affectedRate - unaffectedRate >= FLEET_DISCRIMINATION_MARGIN
  if (verdict === 'discriminating' && !discriminating) return 'not_discriminating'
  return verdict
}

/**
 * Whether the truncation flag is a real `true` — used to decide whether to show
 * the "these numbers are floors" caveat.
 *
 * Deliberately NOT the inverse of `isExactlyFalse`: an ABSENT flag shows no
 * truncation caveat (there is no evidence of truncation to report) but also
 * fails `usableMeasurement`, so the measurement is reported as unmeasured
 * instead. Absent lands in the honest middle rather than in either claim.
 */
export function isExactlyTrue(v: unknown): boolean {
  return v === true
}
