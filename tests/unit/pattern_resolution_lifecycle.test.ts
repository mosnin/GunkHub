/**
 * Unit coverage for the pure, non-React pieces of the Failure Resolution UI
 * (docs/adr/006-failure-resolution.md, cycle 1, Team E/web):
 *   - `parseSafeHttpUrl` (apps/web/src/lib/utils.ts) — the ONLY gate between
 *     an untrusted, human-entered `resolutionRef` string and rendering it as
 *     an `<a href>` in PatternDetail. Must fail closed on anything that
 *     isn't a clean http(s) URL (bare version ids, `javascript:`/`data:`
 *     URIs, prose) so PatternDetail never turns free text into a link that
 *     could execute script or navigate somewhere unexpected.
 *   - `adaptFailurePattern` / `isRegressedPattern` (apps/web/src/components/
 *     patterns/adapt.ts) — the reconciliation adapter that defaults a
 *     pattern's lifecycle `status` to "open" when the service doesn't (yet)
 *     supply one, and the "was this resolved-then-failed-again" predicate
 *     that drives the REGRESSED banner/badge.
 *
 * The rest of this cycle's UI (PatternStatusBadge, PatternLifecycleControl)
 * is React and this repo has no component-testing harness set up yet
 * (no @testing-library/react, no jsdom `environment` in tests/vitest.config.ts)
 * — see the PR/report for that gap. This file covers everything in the
 * change that IS a plain function, using the same node-environment vitest
 * setup every other apps/web unit test in this directory already uses.
 */
import { describe, expect, it } from 'vitest'

import { adaptFailurePattern, isRegressedPattern } from '../../apps/web/src/components/patterns/adapt.js'
import { parseSafeHttpUrl } from '../../apps/web/src/lib/utils.js'

describe('parseSafeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(parseSafeHttpUrl('https://github.com/acme/repo/pull/42')?.toString()).toBe(
      'https://github.com/acme/repo/pull/42',
    )
    expect(parseSafeHttpUrl('http://internal.example.com/note')?.toString()).toBe(
      'http://internal.example.com/note',
    )
  })

  it('rejects javascript:, data:, and file: URIs', () => {
    expect(parseSafeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(parseSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(parseSafeHttpUrl('file:///etc/passwd')).toBeNull()
  })

  it('rejects plain text and bare identifiers (not a URL at all)', () => {
    expect(parseSafeHttpUrl('agent-version-abc123')).toBeNull()
    expect(parseSafeHttpUrl('fixed in the retry-limit patch')).toBeNull()
    expect(parseSafeHttpUrl('')).toBeNull()
  })
})

describe('adaptFailurePattern — resolution lifecycle fields', () => {
  it('defaults status to "open" and omits lifecycle fields when the raw object has none', () => {
    const adapted = adaptFailurePattern({ id: 'p1', fingerprintHash: 'abc' })
    expect(adapted.status).toBe('open')
    expect(adapted.resolvedAt).toBeUndefined()
    expect(adapted.resolutionNote).toBeUndefined()
    expect(adapted.resolutionRef).toBeUndefined()
    expect(adapted.regressedAt).toBeUndefined()
    expect(isRegressedPattern(adapted)).toBe(false)
  })

  it('passes through a resolved pattern with its note, ref, and resolver', () => {
    const adapted = adaptFailurePattern({
      id: 'p2',
      status: 'resolved',
      resolvedAt: 1_700_000_000_000,
      resolvedByUserId: 'user_abc',
      resolutionNote: 'Bumped the tool timeout.',
      resolutionRef: 'https://github.com/acme/repo/pull/9',
    })
    expect(adapted.status).toBe('resolved')
    expect(adapted.resolvedByUserId).toBe('user_abc')
    expect(adapted.resolutionNote).toBe('Bumped the tool timeout.')
    expect(adapted.resolutionRef).toBe('https://github.com/acme/repo/pull/9')
    expect(isRegressedPattern(adapted)).toBe(false)
  })

  it('falls back to "open" for an unrecognized status value instead of trusting it verbatim', () => {
    const adapted = adaptFailurePattern({ id: 'p3', status: 'not-a-real-status' })
    expect(adapted.status).toBe('open')
  })

  it('is regressed only when status is back to "open" AND regressedAt is set', () => {
    const regressed = adaptFailurePattern({ id: 'p4', status: 'open', regressedAt: 1_700_000_500_000 })
    expect(isRegressedPattern(regressed)).toBe(true)

    // Still resolved (regression guard hasn't reopened it) — not regressed.
    const stillResolved = adaptFailurePattern({
      id: 'p5',
      status: 'resolved',
      resolvedAt: 1_700_000_000_000,
    })
    expect(isRegressedPattern(stillResolved)).toBe(false)

    // Manually reopened (per the contract, reopenPattern clears regressedAt) — not regressed.
    const manuallyReopened = adaptFailurePattern({ id: 'p6', status: 'open' })
    expect(isRegressedPattern(manuallyReopened)).toBe(false)
  })
})
