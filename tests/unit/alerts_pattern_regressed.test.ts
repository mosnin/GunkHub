/**
 * ADR-006 (docs/adr/006-failure-resolution.md, Team C's API/services
 * surface) tests for the `pattern_regressed` alert-rule kind — fired by
 * convex/alerts.ts's `firePatternRegressionAlert` when a RESOLVED failure
 * pattern auto-reopens because a new occurrence lands after its
 * `resolvedAt`. Mirrors alerts_pattern_spike.test.ts's coverage exactly,
 * confirming `pattern_regressed` is treated as its own rule kind (never a
 * reuse of `pattern_spike`) and that its regression-specific metadata shape
 * (`resolvedAt`/`regressedAt`, no `recentCount`) survives `mapAlertEvent`
 * unchanged via the same generic passthrough.
 */
import { describe, expect, it } from 'vitest'

import {
  ALERT_RULE_KINDS,
  isValidAlertRuleKind,
  mapAlertEvent,
  mapAlertRule,
} from '../../apps/web/src/lib/services/alertRules.js'

describe('alert-rule kind validation — pattern_regressed', () => {
  it('isValidAlertRuleKind accepts pattern_regressed', () => {
    expect(isValidAlertRuleKind('pattern_regressed')).toBe(true)
  })

  it('ALERT_RULE_KINDS contains pattern_regressed as a distinct kind from pattern_spike', () => {
    expect(ALERT_RULE_KINDS.has('pattern_regressed')).toBe(true)
    expect(ALERT_RULE_KINDS.has('pattern_spike')).toBe(true)
    expect('pattern_regressed').not.toBe('pattern_spike')
  })

  it('isValidAlertRuleKind rejects near-miss strings', () => {
    expect(isValidAlertRuleKind('pattern_regress')).toBe(false)
    expect(isValidAlertRuleKind('pattern_regressedd')).toBe(false)
    expect(isValidAlertRuleKind('PATTERN_REGRESSED')).toBe(false)
  })

  it("mapAlertRule round-trips a pattern_regressed doc's kind through to the API response shape", () => {
    const rule = mapAlertRule({
      _id: 'rule_2',
      orgId: 'org_1',
      name: 'Regression watch',
      kind: 'pattern_regressed',
      channels: [{ type: 'email', target: 'oncall@example.com' }],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(rule.kind).toBe('pattern_regressed')
  })
})

describe('alert-events mapping — pattern_regressed regression payload', () => {
  it('surfaces patternFingerprintHash + the regression-specific metadata shape (resolvedAt/regressedAt, no recentCount)', () => {
    const event = mapAlertEvent({
      _id: 'evt_3',
      orgId: 'org_1',
      ruleId: 'rule_2',
      firedAt: 5000,
      summary: 'Failure pattern "Tool Error: search_web" regressed after being marked resolved — /patterns/a1b2c3d4e5f6',
      deliveryStatus: 'pending',
      patternFingerprintHash: 'a1b2c3d4e5f6',
      metadata: {
        fingerprintHash: 'a1b2c3d4e5f6',
        class: 'tool_error',
        label: 'Tool Error: search_web',
        resolvedAt: 1000,
        regressedAt: 4000,
        deepLink: '/patterns/a1b2c3d4e5f6',
      },
    })
    expect(event.patternFingerprintHash).toBe('a1b2c3d4e5f6')
    expect(event.metadata).toEqual({
      fingerprintHash: 'a1b2c3d4e5f6',
      class: 'tool_error',
      label: 'Tool Error: search_web',
      resolvedAt: 1000,
      regressedAt: 4000,
      deepLink: '/patterns/a1b2c3d4e5f6',
    })
    // The regression payload has no recentCount (that's pattern_spike-only) —
    // confirm mapAlertEvent's generic passthrough doesn't invent one.
    expect(event.metadata).not.toHaveProperty('recentCount')
  })

  it('a pattern_regressed alert_event still has no dedicated cross-kind discriminator beyond metadata shape itself', () => {
    // There is no separate "kind" field on AlertEvent (only on AlertRule) —
    // callers distinguish pattern_spike vs pattern_regressed firings solely
    // by which fields are present in `metadata` (recentCount vs
    // resolvedAt/regressedAt). Pin that both shapes pass through mapAlertEvent
    // without the mapper injecting a synthetic discriminator field.
    const event = mapAlertEvent({
      _id: 'evt_4',
      orgId: 'org_1',
      ruleId: 'rule_2',
      firedAt: 6000,
      summary: 'regressed',
      deliveryStatus: 'pending',
      metadata: { resolvedAt: 1, regressedAt: 2 },
    })
    expect(event).not.toHaveProperty('kind')
  })
})
