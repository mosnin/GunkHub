// ADR-002 — outbound webhooks. Admin-gated CRUD + audited, matching the
// api_keys pattern: the signing secret is generated server-side and returned
// EXACTLY ONCE, in createWebhook's response — every other read strips it.
// webhook_deliveries is APPEND-ONLY, status-patchable exactly like
// alert_events (see schema.ts / ADR-002 for why that's not a violation of
// append-only semantics). Delivery *execution* is out of scope for this
// change — recordWebhookDelivery/updateWebhookDeliveryStatus are
// internal-only entry points for a future delivery worker.

import { randomBytes } from "node:crypto";

import { v } from "convex/values";

import { internalMutation, query, mutation } from "./_generated/server.js";
import { recordAuditEvent } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_WEBHOOK_EVENTS } from "./helpers/pagination.js";

import type { Doc } from "./_generated/dataModel.js";

/** Closed set — must stay in sync with packages/contracts/src/webhooks.ts WebhookEventType. */
const WEBHOOK_EVENT_TYPES = new Set<string>([
  "run.completed",
  "run.failed",
  "eval.failed",
  "alert.fired",
]);

function validateWebhookArgs(args: { url: string; events: string[] }): void {
  if (!args.url.startsWith("https://")) {
    throw afrError("INVALID_ARGUMENT", "Webhook url must be an https:// URL");
  }
  if (args.events.length === 0 || args.events.length > MAX_WEBHOOK_EVENTS) {
    throw afrError(
      "INVALID_ARGUMENT",
      `events must have 1-${MAX_WEBHOOK_EVENTS} entries`,
    );
  }
  const invalid = args.events.filter((e) => !WEBHOOK_EVENT_TYPES.has(e));
  if (invalid.length > 0) {
    throw afrError("INVALID_ARGUMENT", `Unknown webhook event type(s): ${invalid.join(", ")}`);
  }
}

/** Strip the plaintext secret before returning — see module-level comment. */
function toSafeWebhook(hook: Doc<"webhook_targets">): Omit<Doc<"webhook_targets">, "secret"> {
  const { secret: _secret, ...safe } = hook;
  return safe;
}

export const listWebhooks = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });
    const hooks = await ctx.db
      .query("webhook_targets")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_PAGE_SIZE);
    return hooks.map(toSafeWebhook);
  },
});

/**
 * Create a webhook. The response is the ONLY place the plaintext secret is
 * ever returned — persist it now, it cannot be retrieved again (matches the
 * createApiKey raw-key-returned-once pattern).
 */
export const createWebhook = mutation({
  args: {
    orgId: v.id("organizations"),
    url: v.string(),
    events: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });

    validateWebhookArgs(args);

    const secret = randomBytes(32).toString("hex");
    const now = Date.now();
    const webhookId = await ctx.db.insert("webhook_targets", {
      orgId: args.orgId,
      url: args.url,
      secret,
      events: args.events,
      enabled: true,
      createdAt: now,
    });

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "webhook.created",
      targetType: "outbound_webhook",
      targetId: String(webhookId),
      metadata: { url: args.url, events: args.events },
    });

    return {
      _id: webhookId,
      orgId: args.orgId,
      url: args.url,
      events: args.events,
      enabled: true,
      createdAt: now,
      secret,
    };
  },
});

export const deleteWebhook = mutation({
  args: { webhookId: v.id("webhook_targets") },
  handler: async (ctx, args) => {
    const hook = await ctx.db.get(args.webhookId);
    if (!hook) throw new Error("Webhook not found");

    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, hook.orgId, { minimumRole: "admin" });

    await ctx.db.delete(args.webhookId);

    await recordAuditEvent(ctx, {
      orgId: hook.orgId,
      actorClerkUserId: userId,
      action: "webhook.deleted",
      targetType: "outbound_webhook",
      targetId: String(args.webhookId),
      metadata: { url: hook.url },
    });

    return { deleted: true as const };
  },
});

export const listWebhookDeliveries = query({
  args: { webhookId: v.id("webhook_targets"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const hook = await ctx.db.get(args.webhookId);
    if (!hook) throw new Error("Webhook not found");
    await requireOrgMembership(ctx, hook.orgId, { minimumRole: "admin" });

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return await ctx.db
      .query("webhook_deliveries")
      .withIndex("by_webhook", (q) => q.eq("webhookId", args.webhookId))
      .order("desc")
      .take(limit);
  },
});

// ---------------------------------------------------------------------------
// Internal-only entry points for a future delivery worker. Not wired to any
// cron or event trigger in this change — see ADR-002.
// ---------------------------------------------------------------------------

/** Append-only: records a delivery attempt was queued. */
export const recordWebhookDelivery = internalMutation({
  args: {
    orgId: v.id("organizations"),
    webhookId: v.id("webhook_targets"),
    event: v.string(),
    runId: v.optional(v.id("runs")),
    // ADR-003 constraint 3: a hash of the payload this delivery will send,
    // recorded at enqueue time (the log row that "fired" is immutable from here).
    payloadHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("webhook_deliveries", {
      orgId: args.orgId,
      webhookId: args.webhookId,
      event: args.event,
      runId: args.runId,
      status: "pending",
      attempts: 0,
      payloadHash: args.payloadHash,
      createdAt: Date.now(),
    });
  },
});

/** The ONE sanctioned patch on webhook_deliveries: delivery-attempt bookkeeping. */
export const updateWebhookDeliveryStatus = internalMutation({
  args: {
    deliveryId: v.id("webhook_deliveries"),
    status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed")),
    attempts: v.number(),
    responseCode: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deliveryId);
    if (!row) throw new Error("Webhook delivery not found");
    await ctx.db.patch(args.deliveryId, {
      status: args.status,
      attempts: args.attempts,
      lastAttemptAt: Date.now(),
      responseCode: args.responseCode,
      error: args.error,
    });
  },
});
