/**
 * Cycle 2 (PREVENTION deepen, Team C's API/services surface) tests:
 *
 *   1. `pattern_spike` is accepted by the alert-rule management route's kind
 *      validation (apps/web/src/lib/services/alertRules.ts,
 *      used by both POST /api/alerts and the underlying service) — this is
 *      now a REAL contracts `AlertRuleKind` literal + a real Convex
 *      `ALERT_RULE_KIND` validator entry (docs/adr/005-failure-patterns.md),
 *      not a forward-compat shim.
 *   2. A pattern-spike alert-event's `patternFingerprintHash` + `metadata`
 *      (the fingerprint deep-link payload `convex/alerts.ts`'s
 *      `firePatternSpikeAlert` fires) survive `mapAlertEvent`
 *      (services/alertRules.ts) unchanged, and ordinary events are
 *      unaffected (no stray keys).
 *
 * Both exercise pure, dependency-free helpers (no Next.js/Clerk/Convex
 * runtime needed), same convention as failure_patterns_route.test.ts and
 * management_route_auth.test.ts.
 */
import { describe, expect, it } from 'vitest'

import {
  ALERT_RULE_KINDS,
  isValidAlertRuleKind,
  isValidChannelType,
  mapAlertEvent,
  mapAlertRule,
} from '../../apps/web/src/lib/services/alertRules.js'

describe('alert-rule kind validation — pattern_spike', () => {
  it('ALERT_RULE_KINDS includes the pre-existing kinds plus pattern_spike and pattern_regressed', () => {
    // ADR-006 (docs/adr/006-failure-resolution.md) adds pattern_regressed
    // alongside pattern_spike — same additive-kind convention, own rule kind,
    // never a reuse of pattern_spike. See alerts_pattern_regressed.test.ts for
    // the dedicated pattern_regressed coverage (isValidAlertRuleKind,
    // mapAlertRule round-trip, mapAlertEvent metadata passthrough).
    expect([...ALERT_RULE_KINDS].sort()).toEqual(
      ['eval_failed', 'failure_rate', 'pattern_regressed', 'pattern_spike', 'run_failed'].sort(),
    )
  })

  it('isValidAlertRuleKind accepts pattern_spike', () => {
    expect(isValidAlertRuleKind('pattern_spike')).toBe(true)
  })

  it('isValidAlertRuleKind still accepts the three original cycle-1 kinds', () => {
    expect(isValidAlertRuleKind('run_failed')).toBe(true)
    expect(isValidAlertRuleKind('failure_rate')).toBe(true)
    expect(isValidAlertRuleKind('eval_failed')).toBe(true)
  })

  it('isValidAlertRuleKind rejects anything else (typos, unrelated strings, non-strings)', () => {
    expect(isValidAlertRuleKind('pattern_spikee')).toBe(false)
    expect(isValidAlertRuleKind('run failed')).toBe(false)
    expect(isValidAlertRuleKind('')).toBe(false)
    expect(isValidAlertRuleKind(undefined)).toBe(false)
    expect(isValidAlertRuleKind(123)).toBe(false)
  })

  it("mapAlertRule round-trips a pattern_spike doc's kind through to the API response shape", () => {
    const rule = mapAlertRule({
      _id: 'rule_1',
      orgId: 'org_1',
      name: 'Spike watch',
      kind: 'pattern_spike',
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(rule.kind).toBe('pattern_spike')
  })

  it('isValidChannelType still validates webhook/email channel types unchanged', () => {
    expect(isValidChannelType('webhook')).toBe(true)
    expect(isValidChannelType('email')).toBe(true)
    expect(isValidChannelType('sms')).toBe(false)
  })
})

describe('alert-events mapping — pattern-spike fingerprint deep-link payload', () => {
  it('surfaces patternFingerprintHash + metadata.deepLink as fired by firePatternSpikeAlert', () => {
    const event = mapAlertEvent({
      _id: 'evt_1',
      orgId: 'org_1',
      ruleId: 'rule_1',
      firedAt: 1000,
      summary: 'Failure pattern "Tool Error: search_web" is spiking (12 recent occurrences) — /patterns/a1b2c3d4e5f6',
      deliveryStatus: 'pending',
      patternFingerprintHash: 'a1b2c3d4e5f6',
      metadata: {
        fingerprintHash: 'a1b2c3d4e5f6',
        class: 'tool_error',
        label: 'Tool Error: search_web',
        recentCount: 12,
        deepLink: '/patterns/a1b2c3d4e5f6',
      },
    })
    expect(event.patternFingerprintHash).toBe('a1b2c3d4e5f6')
    expect(event.metadata).toEqual({
      fingerprintHash: 'a1b2c3d4e5f6',
      class: 'tool_error',
      label: 'Tool Error: search_web',
      recentCount: 12,
      deepLink: '/patterns/a1b2c3d4e5f6',
    })
  })

  it('omits patternFingerprintHash/metadata entirely for ordinary (non-pattern_spike) events — never stray undefined keys', () => {
    const event = mapAlertEvent({
      _id: 'evt_2',
      orgId: 'org_1',
      ruleId: 'rule_2',
      firedAt: 1000,
      summary: 'Run failed',
      deliveryStatus: 'delivered',
      deliveredAt: 1500,
    })
    expect('patternFingerprintHash' in event).toBe(false)
    expect('metadata' in event).toBe(false)
    expect(event.deliveredAt).toBe(1500)
  })

  it('ignores a non-string patternFingerprintHash / non-object metadata rather than propagating a malformed value', () => {
    const event = mapAlertEvent({
      _id: 'evt_3',
      orgId: 'org_1',
      ruleId: 'rule_3',
      firedAt: 1000,
      summary: 'Odd doc',
      deliveryStatus: 'pending',
      patternFingerprintHash: 12345,
      metadata: 'not an object',
    })
    expect('patternFingerprintHash' in event).toBe(false)
    expect('metadata' in event).toBe(false)
  })
})
