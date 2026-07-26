// ADR-002 — alert rules (ordinary config) and alert events (append-only
// record of a rule firing; deliveryStatus/deliveredAt are the one sanctioned
// patch — see convex/schema.ts and docs/adr/002-data-model-expansion.md).
//
// Failure Patterns cycle 2 (docs/adr/005-failure-patterns.md) adds the
// "pattern_spike" rule kind plus two additive/optional AlertEvent fields
// (`patternFingerprintHash`, `metadata`) so a fired pattern-spike alert can
// carry a deep link back to /patterns/[fingerprint] — see
// convex/failure_patterns.ts's assessPatternSpikesCron and
// convex/alerts.ts's firePatternSpikeAlert.
//
// ADR-006 (failure pattern resolution) adds "pattern_regressed", mirroring
// "pattern_spike"'s plumbing exactly: fires when a RESOLVED pattern
// auto-reopens because a new occurrence landed after its resolvedAt. The
// same `metadata` field carries the regression-specific payload — see
// convex/alerts.ts's firePatternRegressionAlert.

export type AlertRuleKind = "run_failed" | "failure_rate" | "eval_failed" | "pattern_spike" | "pattern_regressed";
export type AlertChannelType = "webhook" | "email";

export interface AlertChannel {
  type: AlertChannelType;
  target: string;
}

export interface AlertRule {
  id: string;
  orgId: string;
  projectId?: string;
  name: string;
  kind: AlertRuleKind;
  thresholdPct?: number;
  windowMinutes?: number;
  channels: AlertChannel[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AlertDeliveryStatus = "pending" | "delivered" | "failed";

export interface AlertEvent {
  id: string;
  orgId: string;
  ruleId: string;
  runId?: string;
  firedAt: number;
  summary: string;
  deliveryStatus: AlertDeliveryStatus;
  deliveredAt?: number;
  /** Present only for a "pattern_spike"-kind firing — see convex/alerts.ts's firePatternSpikeAlert. */
  patternFingerprintHash?: string;
  /**
   * Freeform, kind-specific structured payload (display-only). For
   * "pattern_spike": `{ fingerprintHash, class, label, recentCount, deepLink }`.
   * For "pattern_regressed" (ADR-006): `{ fingerprintHash, class, label,
   * resolvedAt, regressedAt, deepLink }`. In both cases `deepLink` is the
   * app-relative (or, when `AFR_WEB_BASE_URL` is configured, absolute) path
   * to this pattern's detail page (`/patterns/[fingerprint]`).
   */
  metadata?: Record<string, unknown>;
}
