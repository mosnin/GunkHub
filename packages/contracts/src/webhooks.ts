// ADR-002 — outbound webhooks. The signing secret is generated server-side
// and returned EXACTLY ONCE (createWebhook's response) — every subsequent
// read strips it, hence `secret` is optional here rather than always present.

export type WebhookEventType =
  | "run.completed"
  | "run.failed"
  | "eval.failed"
  | "alert.fired";

export interface WebhookTarget {
  id: string;
  orgId: string;
  url: string;
  /**
   * Plaintext HMAC signing secret. Present ONLY in the createWebhook response;
   * every other read (listWebhooks) omits it. Stored in plaintext server-side
   * (not hashed) because signing outbound deliveries requires the original
   * value — see docs/adr/002-data-model-expansion.md for the tradeoff vs.
   * API-key hashing.
   */
  secret?: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: number;
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface WebhookDelivery {
  id: string;
  orgId: string;
  webhookId: string;
  event: string;
  runId?: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastAttemptAt?: number;
  responseCode?: number;
  /** Hash of the delivered payload, recorded at enqueue time (ADR-003). */
  payloadHash?: string;
  /** Human-readable failure reason when the attempt failed without an HTTP response. */
  error?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Cycle 2 (docs/design/action_layer.md) — the versioned envelope every
// webhook delivery POSTs as its JSON body. Mirrored in
// convex/webhook_engine.ts (WEBHOOK_ENVELOPE_API_VERSION) — keep both in
// sync. `run` intentionally excludes `metadata` (may contain
// customer-supplied free-form data of unbounded size/sensitivity).
// ---------------------------------------------------------------------------

export const WEBHOOK_ENVELOPE_API_VERSION = "2026-01";

export interface WebhookEnvelopeRun {
  id: string;
  projectId: string;
  agentId: string;
  agentVersionId?: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  tags: string[];
  triggeredBy?: string;
  sdkVersion?: string;
}

/**
 * Cycle 3 (docs/adr/005-failure-patterns.md "Cycle 3"): the pattern context
 * carried by a webhook delivery whose firing alert_events row is a
 * `pattern_spike` fire (`alert_events.patternFingerprintHash` set — see
 * convex/alerts.ts's firePatternSpikeAlert). Absent for every other event
 * type/alert kind.
 */
export interface WebhookEnvelopePattern {
  fingerprintHash: string;
  class: string;
  label: string;
  /** The recent-window occurrence count that triggered the spike assessment (see FailurePatternSpikeAssessment.recentCount). */
  recentCount: number;
  /**
   * Deep link to the pattern detail page. ABSOLUTE (`https://...`) whenever
   * the deployment has configured `AFR_WEB_BASE_URL` (see .env.example and
   * convex/alerts.ts's `buildPatternDeepLink`) — per ADR-003, an external
   * webhook consumer should get an absolute, directly-clickable URL, not a
   * bare path. When `AFR_WEB_BASE_URL` is unset (no operator-facing setup
   * step exists for every deployment yet), this documented seam falls back
   * to the RELATIVE path `/patterns/[fingerprintHash]`; a consumer that
   * needs an absolute URL in that case can construct one itself from
   * `fingerprintHash` plus its own known app origin.
   */
  deepLink: string;
}

export interface WebhookEnvelope {
  /** Date-versioned string, changed only on a breaking envelope shape change. */
  apiVersion: typeof WEBHOOK_ENVELOPE_API_VERSION;
  /** The triggering event type — currently always run.completed/run.failed/alert.fired. */
  event: string;
  orgId: string;
  run: WebhookEnvelopeRun | null;
  /** When the alert fired / delivery was enqueued — distinct from run.endedAt. */
  firedAt: number;
  /** Present only for a pattern_spike-driven delivery (Cycle 3). See WebhookEnvelopePattern. */
  pattern?: WebhookEnvelopePattern;
}
