/**
 * Drift guard for the fix-confidence vocabulary (ADR-006 cycle 2).
 *
 * The scoring ENGINE is convex/insights.ts §12 (Team B). The canonical TYPES
 * are in `@agent-flight-recorder/contracts` (>= 0.9.0), which every consumer
 * — packages/sdk, packages/cli, and apps/web's v1 forwarder — now imports
 * rather than mirroring locally, per CLAUDE.md.
 *
 * ONE hand-maintained seam remains, and this file is its guard: a published
 * npm package cannot import a Convex module, so contracts' literals are
 * transcribed from convex/insights.ts by hand rather than derived from it.
 * Nothing in the type system connects the two.
 *
 * WHY THIS MATTERS: these literals are not decoration, they are the values CI
 * gates on. If the engine renames a state (or adds a fifth) and contracts
 * lags, TypeScript stays happy on both sides — each declaration is a
 * self-consistent union — while a build gate written as
 * `state !== 'regressed'` silently stops matching the thing it was written to
 * catch. That failure is invisible in exactly the way the param-forwarding bug
 * was, so it gets the same treatment.
 *
 * WHY THIS READS THE SOURCE TEXT INSTEAD OF IMPORTING THE MODULE:
 * convex/tsconfig.json deliberately sets `exactOptionalPropertyTypes: false`
 * (Convex validators require explicitly-`undefined` optional fields), while
 * tests/tsconfig.json inherits `true` from tsconfig.base.json. Type-importing
 * convex/insights.ts here therefore drags a legitimately-written module into a
 * stricter project and fails typecheck on code that is correct under its own
 * config. Reading the union literals out of the source is not a workaround for
 * that — it is a stronger assertion for this particular purpose, because it
 * pins the mirrors against what Team B's file ACTUALLY DECLARES rather than
 * against a type alias that could itself have drifted.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type {
  FixConfidenceLimit,
  FixConfidenceState,
  FixVersionAttribution,
} from '@agent-flight-recorder/contracts'

const INSIGHTS_SOURCE = readFileSync(
  fileURLToPath(new URL('../../convex/insights.ts', import.meta.url)),
  'utf8',
)

/**
 * Extract the string literals of an exported union type alias from source.
 * Fails loudly (rather than returning an empty list that would make every
 * assertion below vacuously pass) if the alias cannot be found at all.
 */
function unionLiteralsOf(typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} =([^;]+);`).exec(INSIGHTS_SOURCE)
  if (!match) throw new Error(`Could not find "export type ${typeName}" in convex/insights.ts`)
  const literals = match[1]!.match(/"([^"]+)"/g)
  if (!literals) throw new Error(`Found "export type ${typeName}" but no string literals in it`)
  return literals.map((literal) => literal.slice(1, -1)).sort()
}

/**
 * The contracts vocabulary, written out as runtime values. Each array is TYPED
 * as the contracts union, so it does not COMPILE if contracts disagrees with
 * the literals listed here — and it does not PASS if contracts disagrees with
 * convex/insights.ts. Both halves of the seam are covered.
 */
const CONTRACT_STATES: readonly FixConfidenceState[] = ['unproven', 'proving', 'confirmed', 'regressed']
const CONTRACT_ATTRIBUTIONS: readonly FixVersionAttribution[] = ['matched', 'mismatched', 'unknown']
const CONTRACT_LIMITS: readonly FixConfidenceLimit[] = [
  'recurrence',
  'no-resolution',
  'version-mismatch',
  'no-exposure',
  'accumulating',
  'none',
]

describe('fix-confidence vocabulary — contracts matches convex/insights.ts', () => {
  it.each([
    { name: 'FixConfidenceState', declared: CONTRACT_STATES },
    { name: 'FixVersionAttribution', declared: CONTRACT_ATTRIBUTIONS },
    { name: 'FixConfidenceLimit', declared: CONTRACT_LIMITS },
  ])('$name — contracts matches the engine declaration exactly', ({ name, declared }) => {
    expect(unionLiteralsOf(name)).toEqual([...declared].sort())
  })

  /**
   * The CI gate this cycle exists to enable. Pinned as a literal so that
   * renaming the state in the engine fails HERE, next to the comment
   * explaining what depends on it, rather than silently disarming build gates
   * written as `state !== 'regressed'`.
   */
  it("'regressed' is a member of the vocabulary — CI build gates depend on this exact spelling", () => {
    expect(unionLiteralsOf('FixConfidenceState')).toContain('regressed')
  })

  /**
   * The score is a 0..0.95 FRACTION, not a 0..100 percentage. Pinned because
   * every consumer that renders or thresholds it (the CLI's percentage
   * formatting, any CI `jq` gate) is silently wrong by 100x if the scale
   * changes, and no type would catch it — both are `number`.
   */
  it('the confidence ceiling is a sub-1.0 fraction, never a percentage', () => {
    const match = /export const FIX_CONFIDENCE_MAX = ([\d.]+);/.exec(INSIGHTS_SOURCE)
    expect(match).not.toBeNull()
    const max = Number(match![1])
    expect(max).toBeGreaterThan(0)
    expect(max).toBeLessThan(1)
  })

  /**
   * The ruling this whole cycle rests on: zero exposure is never a success.
   * Asserted against the engine's own guard so a future re-tuning of the
   * weights cannot quietly turn "nothing ran" into "proving".
   */
  it('zero attributed exposure is explicitly unproven in the engine', () => {
    expect(INSIGHTS_SOURCE).toMatch(/if \(runs < FIX_CONFIDENCE_MIN_EXPOSURE_RUNS\) return "unproven";/)
  })
})
