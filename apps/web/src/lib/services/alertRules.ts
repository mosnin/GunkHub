/**
 * alertRules.ts — pure, dependency-free validation + doc-mapping helpers for
 * the alert-rule management surface (`services/alerts.ts`, `/api/alerts/**`).
 * Split out for the same reason `fingerprintValidation.ts` / `apiAuthGuard.ts`
 * / `apiKeyScopes.ts` are split out: zero `next/server` / `@clerk/nextjs/
 * server` / Convex imports, so this is unit-testable without any of those
 * runtimes (see tests/unit/alerts_pattern_spike.test.ts).
 *
 * Failure Patterns cycle 2 (docs/adr/005-failure-patterns.md): `pattern_spike`
 * is now a real `AlertRuleKind` literal (`packages/contracts/src/alerts.ts`),
 * `convex/alerts.ts`'s `ALERT_RULE_KIND` validator accepts it, and
 * `firePatternSpikeAlert` fires real `alert_events` rows carrying
 * `patternFingerprintHash` + a `metadata.deepLink` (`/patterns/[fingerprint]`)
 * for a spiking pattern. This module's job is just to keep the web
 * management-route validation set and the doc->contract mapping in sync with
 * that closed set of kinds/fields — see `mapAlertRule`/`mapAlertEvent` below.
 */
import type { AlertChannel, AlertEvent, AlertRule, AlertRuleKind } from '@agent-flight-recorder/contracts'

/** Mirrors contracts' `AlertRuleKind` union exactly — kept as an explicit runtime set so `/api/alerts` can validate a request body's `kind` before it ever reaches Convex. */
export const ALERT_RULE_KINDS: ReadonlySet<string> = new Set<string>([
  'run_failed',
  'failure_rate',
  'eval_failed',
  'pattern_spike',
])

export function isValidAlertRuleKind(value: unknown): value is AlertRuleKind {
  return typeof value === 'string' && ALERT_RULE_KINDS.has(value)
}

export const ALERT_CHANNEL_TYPES: ReadonlySet<string> = new Set<string>(['webhook', 'email'])

export function isValidChannelType(value: unknown): value is AlertChannel['type'] {
  return typeof value === 'string' && ALERT_CHANNEL_TYPES.has(value)
}

export function mapAlertRule(doc: Record<string, unknown>): AlertRule {
  return {
    id: doc['_id'] as string,
    orgId: doc['orgId'] as string,
    name: doc['name'] as string,
    kind: doc['kind'] as AlertRuleKind,
    channels: (doc['channels'] ?? []) as AlertChannel[],
    enabled: doc['enabled'] as boolean,
    createdAt: doc['createdAt'] as number,
    updatedAt: doc['updatedAt'] as number,
    ...(doc['projectId'] !== undefined && { projectId: doc['projectId'] as string }),
    ...(doc['thresholdPct'] !== undefined && { thresholdPct: doc['thresholdPct'] as number }),
    ...(doc['windowMinutes'] !== undefined && { windowMinutes: doc['windowMinutes'] as number }),
  }
}

/**
 * Maps a raw `alert_events` Convex doc onto the real contracts `AlertEvent`
 * shape, including the `pattern_spike`-only fields (`patternFingerprintHash`,
 * `metadata`) `firePatternSpikeAlert` (convex/alerts.ts) now writes. Both
 * fields are optional/additive on the contract, so this is a no-op for
 * ordinary `run_failed` / `failure_rate` / `eval_failed` events — they simply
 * come back without those two keys, unchanged from before this cycle.
 */
export function mapAlertEvent(doc: Record<string, unknown>): AlertEvent {
  return {
    id: doc['_id'] as string,
    orgId: doc['orgId'] as string,
    ruleId: doc['ruleId'] as string,
    firedAt: doc['firedAt'] as number,
    summary: doc['summary'] as string,
    deliveryStatus: doc['deliveryStatus'] as AlertEvent['deliveryStatus'],
    ...(doc['runId'] !== undefined && { runId: doc['runId'] as string }),
    ...(doc['deliveredAt'] !== undefined && { deliveredAt: doc['deliveredAt'] as number }),
    ...(typeof doc['patternFingerprintHash'] === 'string' && {
      patternFingerprintHash: doc['patternFingerprintHash'],
    }),
    ...(doc['metadata'] !== undefined &&
      doc['metadata'] !== null &&
      typeof doc['metadata'] === 'object' && { metadata: doc['metadata'] as Record<string, unknown> }),
  }
}
