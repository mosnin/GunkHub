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
 * Nothing in the type system connects the two declarations.
 *
 * WHY THIS MATTERS: these literals are not decoration, they are the values CI
 * gates on. If the engine renames a state (or adds a fifth) and contracts
 * lags, TypeScript stays happy on both sides — each declaration is a
 * self-consistent union — while a build gate written as
 * `state !== 'regressed'` silently stops matching the thing it was written to
 * catch. That failure is invisible in exactly the way the param-forwarding bug
 * was, so it gets the same treatment.
 *
 * HOW THE SEAM IS CHECKED
 * This file type-imports convex/insights.ts directly and asserts MUTUAL
 * ASSIGNABILITY between each engine union and its contracts twin. A rename, an
 * added member, or a removed member on either side is a TYPE ERROR here — no
 * regex over source text, no possibility of the guard silently matching
 * nothing. It previously scraped the union literals out of the source with a
 * `RegExp` because a `convex/` type-import failed typecheck under
 * `tests/tsconfig.json`'s inherited `exactOptionalPropertyTypes: true`; that is
 * now resolved by compiling THIS FILE ONLY under the backend's own config —
 * see tests/tsconfig.convex-seam.json for the full reasoning.
 *
 * The behavioural pins below (the sub-1.0 ceiling, the zero-exposure ruling)
 * call the real exported functions instead of asserting against source text,
 * so they test what the engine DOES rather than how it is spelled.
 */
import { describe, expect, it } from 'vitest'

import {
  FIX_CONFIDENCE_CONFIRMED_THRESHOLD,
  FIX_CONFIDENCE_MAX,
  deriveFixConfidenceState,
  fixConfidence,
  type FixConfidenceLimit as EngineFixConfidenceLimit,
  type FixConfidenceState as EngineFixConfidenceState,
  type FixVersionAttribution as EngineFixVersionAttribution,
} from '../../convex/insights.js'

import type {
  FixConfidenceLimit,
  FixConfidenceState,
  FixVersionAttribution,
} from '@agent-flight-recorder/contracts'

/**
 * `true` only when `A` and `B` are mutually assignable. Wrapped in tuples so a
 * union distributes as a whole rather than member-by-member — without that,
 * `'a' extends 'a' | 'b'` would pass and a DROPPED member would go unnoticed.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/* -------------------------------------------------------------------------
 * THE SEAM ITSELF — compile-time. Each assignment below is `true = true` while
 * the two declarations agree and `false = true` (a type error) the moment they
 * do not. `pnpm typecheck` is the gate; nothing has to run.
 * ---------------------------------------------------------------------- */

const _statesAgree: MutuallyAssignable<EngineFixConfidenceState, FixConfidenceState> = true
const _attributionsAgree: MutuallyAssignable<
  EngineFixVersionAttribution,
  FixVersionAttribution
> = true
const _limitsAgree: MutuallyAssignable<EngineFixConfidenceLimit, FixConfidenceLimit> = true

/**
 * The exact spellings, pinned as literals. The seam assertions above prove the
 * two unions are the SAME union; these prove that union is still the one every
 * downstream gate was written against. A CI gate spelled
 * `state !== 'regressed'` breaks here — next to this comment — rather than
 * silently disarming.
 */
const ALL_STATES = ['unproven', 'proving', 'confirmed', 'regressed'] as const
const ALL_ATTRIBUTIONS = ['matched', 'mismatched', 'unknown'] as const
const ALL_LIMITS = [
  'recurrence',
  'no-resolution',
  'version-mismatch',
  'no-exposure',
  'accumulating',
  'none',
] as const

const _statesExhaustive: MutuallyAssignable<
  (typeof ALL_STATES)[number],
  FixConfidenceState
> = true
const _attributionsExhaustive: MutuallyAssignable<
  (typeof ALL_ATTRIBUTIONS)[number],
  FixVersionAttribution
> = true
const _limitsExhaustive: MutuallyAssignable<(typeof ALL_LIMITS)[number], FixConfidenceLimit> = true

/* -------------------------------------------------------------------------
 * BEHAVIOUR — runtime. These call the engine rather than reading it.
 * ---------------------------------------------------------------------- */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const RESOLVED_AT = 1_700_000_000_000

describe('fix-confidence vocabulary — contracts matches convex/insights.ts', () => {
  /**
   * The score is a 0..0.95 FRACTION, not a 0..100 percentage. Pinned because
   * every consumer that renders or thresholds it (the CLI's percentage
   * formatting, any CI `jq` gate) is silently wrong by 100x if the scale
   * changes, and no type would catch it — both are `number`.
   */
  it('the confidence ceiling is a sub-1.0 fraction, never a percentage', () => {
    expect(FIX_CONFIDENCE_MAX).toBeGreaterThan(0)
    expect(FIX_CONFIDENCE_MAX).toBeLessThan(1)
    expect(FIX_CONFIDENCE_CONFIRMED_THRESHOLD).toBeGreaterThan(0)
    expect(FIX_CONFIDENCE_CONFIRMED_THRESHOLD).toBeLessThan(1)
  })

  /**
   * No input may produce a score outside the documented band. Asserted over the
   * same scenario table that drives the vocabulary coverage below.
   */
  it('never scores outside [0, FIX_CONFIDENCE_MAX]', () => {
    for (const { input, nowMs } of SCENARIOS) {
      const result = fixConfidence(input, nowMs)
      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThanOrEqual(FIX_CONFIDENCE_MAX)
    }
  })

  /**
   * The ruling this whole cycle rests on: zero exposure is never a success.
   * Called directly, so a future re-tuning of the weights that quietly turned
   * "nothing ran" into "proving" fails here — including the case where a high
   * score is passed in alongside zero runs.
   */
  it('zero attributed exposure is unproven, whatever the score says', () => {
    expect(
      deriveFixConfidenceState({
        score: FIX_CONFIDENCE_MAX,
        exposureRuns: 0,
        recurred: false,
        hasResolution: true,
      }),
    ).toBe('unproven' satisfies FixConfidenceState)

    // And end-to-end: a long-soaked resolution with no runs still scores zero.
    const stale = fixConfidence({ resolvedAt: RESOLVED_AT }, RESOLVED_AT + 90 * DAY)
    expect(stale.score).toBe(0)
    expect(stale.state).toBe('unproven' satisfies FixConfidenceState)
    expect(stale.limitingFactor).toBe('no-exposure' satisfies FixConfidenceLimit)
  })

  /**
   * Direct disproof outranks everything. `regressed` is the state CI gates on,
   * so it is pinned to a real engine output rather than to a spelling.
   */
  it('a recurrence collapses to the floor and reports regressed', () => {
    const result = fixConfidence(
      {
        resolvedAt: RESOLVED_AT,
        postResolutionRuns: 500,
        recurredAt: RESOLVED_AT + HOUR,
      },
      RESOLVED_AT + 30 * DAY,
    )
    expect(result.recurred).toBe(true)
    expect(result.score).toBe(0)
    expect(result.state).toBe('regressed' satisfies FixConfidenceState)
    expect(result.limitingFactor).toBe('recurrence' satisfies FixConfidenceLimit)
  })

  /**
   * Coverage: every member of every union is reachable from the engine. This is
   * the runtime half of the seam — the compile-time assertions above prove the
   * two DECLARATIONS agree; this proves the declared members are the ones the
   * engine actually emits, so a member that exists only on paper is caught too.
   */
  it('every declared member is produced by the engine for some input', () => {
    const states = new Set<FixConfidenceState>()
    const attributions = new Set<FixVersionAttribution>()
    const limits = new Set<FixConfidenceLimit>()

    for (const { input, nowMs } of SCENARIOS) {
      const result = fixConfidence(input, nowMs)
      // Assigning engine output into contracts-typed sets is itself part of the
      // seam: it does not compile if the engine can return something contracts
      // does not declare.
      states.add(result.state)
      attributions.add(result.versionAttribution)
      limits.add(result.limitingFactor)
    }

    expect([...states].sort()).toEqual([...ALL_STATES].sort())
    expect([...attributions].sort()).toEqual([...ALL_ATTRIBUTIONS].sort())
    expect([...limits].sort()).toEqual([...ALL_LIMITS].sort())
  })
})

/**
 * One scenario per reachable outcome. Kept below the suite it feeds because it
 * is a fixture, not the point of the file.
 */
const SCENARIOS: ReadonlyArray<{
  readonly input: Parameters<typeof fixConfidence>[0]
  readonly nowMs: number
}> = [
  // no-resolution / unproven / unknown attribution
  { input: {}, nowMs: RESOLVED_AT },
  // no-exposure / unproven
  { input: { resolvedAt: RESOLVED_AT }, nowMs: RESOLVED_AT + 90 * DAY },
  // accumulating / proving / unknown attribution
  { input: { resolvedAt: RESOLVED_AT, postResolutionRuns: 3 }, nowMs: RESOLVED_AT + HOUR },
  // none / confirmed / matched attribution
  {
    input: {
      resolvedAt: RESOLVED_AT,
      postResolutionRuns: 500,
      resolvedInVersionId: 'v-fix',
      exposureVersionId: 'v-fix',
    },
    nowMs: RESOLVED_AT + 90 * DAY,
  },
  // version-mismatch / unproven / mismatched attribution
  {
    input: {
      resolvedAt: RESOLVED_AT,
      postResolutionRuns: 500,
      resolvedInVersionId: 'v-fix',
      exposureVersionId: 'v-other',
    },
    nowMs: RESOLVED_AT + 90 * DAY,
  },
  // recurrence / regressed
  {
    input: { resolvedAt: RESOLVED_AT, postResolutionRuns: 500, recurredAt: RESOLVED_AT + HOUR },
    nowMs: RESOLVED_AT + 30 * DAY,
  },
]
