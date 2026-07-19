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

export interface WebhookEnvelope {
  /** Date-versioned string, changed only on a breaking envelope shape change. */
  apiVersion: typeof WEBHOOK_ENVELOPE_API_VERSION;
  /** The triggering event type — currently always run.completed/run.failed/alert.fired. */
  event: string;
  orgId: string;
  run: WebhookEnvelopeRun | null;
  /** When the alert fired / delivery was enqueued — distinct from run.endedAt. */
  firedAt: number;
}
