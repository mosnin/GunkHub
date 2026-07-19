// ADR-002 — alert rules (ordinary config) and alert events (append-only
// record of a rule firing; deliveryStatus/deliveredAt are the one sanctioned
// patch — see convex/schema.ts and docs/adr/002-data-model-expansion.md).

export type AlertRuleKind = "run_failed" | "failure_rate" | "eval_failed";
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
}
