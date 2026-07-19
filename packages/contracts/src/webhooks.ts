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
