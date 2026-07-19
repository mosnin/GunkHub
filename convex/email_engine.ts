// Cycle 3 — the email counterpart to convex/webhook_engine.ts. Drains
// `email_deliveries` rows in status "pending" whose `nextAttemptAt` is due,
// in bounded batches, via an `internalAction` (actions, unlike mutations,
// can call `fetch` — required by ResendEmailNotifier). Completes the
// deferred alert-email path noted in docs/design/action_layer.md and
// ADR-002/ADR-003.
//
// Never throws out of the batch: every delivery attempt is wrapped in its
// own try/catch, so one bad row cannot stop the rest of the batch from
// being drained. Scheduled every minute by convex/crons.ts, alongside
// deliverPendingWebhooks.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { computeBackoff } from "./helpers/delivery.js";
import { getConfiguredEmailNotifier } from "./helpers/notifier.js";
import { EMAIL_DELIVERY_BATCH_SIZE, EMAIL_MAX_ATTEMPTS } from "./helpers/pagination.js";

import type { Doc } from "./_generated/dataModel.js";

const _getPendingEmailDeliveries = makeFunctionReference<"query">(
  "email_engine:getPendingEmailDeliveries",
);
const _markEmailDelivered = makeFunctionReference<"mutation">("email_engine:markEmailDelivered");
const _markEmailFailed = makeFunctionReference<"mutation">("email_engine:markEmailFailed");
const _markEmailRetry = makeFunctionReference<"mutation">("email_engine:markEmailRetry");
// Shared with convex/webhook_engine.ts — a fired alert can have both webhook
// and email channels, so the rollup must consider siblings across both
// tables. Addressed by name (see that file's rollupAlertEventStatus doc
// comment for the cross-file makeFunctionReference rationale already
// established by alert_engine.ts).
const _rollupAlertEventStatus = makeFunctionReference<"mutation">(
  "webhook_engine:rollupAlertEventStatus",
);

/** Bounded batch of due deliveries: status "pending" AND (nextAttemptAt unset OR <= now). */
export const getPendingEmailDeliveries = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    return await ctx.db
      .query("email_deliveries")
      .withIndex("by_status_created", (q) => q.eq("status", "pending"))
      .filter((q) =>
        q.or(
          q.eq(q.field("nextAttemptAt"), undefined),
          q.lte(q.field("nextAttemptAt"), now),
        ),
      )
      .take(EMAIL_DELIVERY_BATCH_SIZE);
  },
});

/** The ONE sanctioned patch on a terminally-resolved delivery: bookkeeping fields only. */
export const markEmailDelivered = internalMutation({
  args: { deliveryId: v.id("email_deliveries"), attempts: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: "delivered",
      attempts: args.attempts,
      lastAttemptAt: Date.now(),
    });
  },
});

export const markEmailFailed = internalMutation({
  args: {
    deliveryId: v.id("email_deliveries"),
    attempts: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: "failed",
      attempts: args.attempts,
      lastAttemptAt: Date.now(),
      error: args.error,
    });
  },
});

export const markEmailRetry = internalMutation({
  args: {
    deliveryId: v.id("email_deliveries"),
    attempts: v.number(),
    error: v.optional(v.string()),
    nextAttemptAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: "pending",
      attempts: args.attempts,
      lastAttemptAt: Date.now(),
      error: args.error,
      nextAttemptAt: args.nextAttemptAt,
    });
  },
});

/**
 * Drain up to EMAIL_DELIVERY_BATCH_SIZE due "pending" deliveries through
 * whichever EmailNotifier `getConfiguredEmailNotifier()` resolves to
 * (ConsoleEmailNotifier by default — always `ok`, so unconfigured
 * deployments drain cleanly to "delivered" with a console log line, never
 * stuck "pending" and never a hard failure). A misbehaving/unreachable real
 * provider (e.g. Resend) reports `{ ok: false }`, which is treated as
 * retryable up to EMAIL_MAX_ATTEMPTS, same backoff formula as webhook
 * delivery, before terminally failing.
 */
export const deliverPendingEmails = internalAction({
  args: {},
  handler: async (ctx) => {
    const pending: Doc<"email_deliveries">[] = await ctx.runQuery(
      _getPendingEmailDeliveries,
      {},
    );

    const notifier = getConfiguredEmailNotifier();

    let delivered = 0;
    let failed = 0;
    let retried = 0;
    let skipped = 0;

    for (const delivery of pending) {
      try {
        const attemptNumber = delivery.attempts + 1;
        const result = await notifier.send(delivery.to, delivery.subject, delivery.body);

        if (result.ok) {
          await ctx.runMutation(_markEmailDelivered, {
            deliveryId: delivery._id,
            attempts: attemptNumber,
          });
          delivered++;
        } else if (attemptNumber < EMAIL_MAX_ATTEMPTS) {
          const delayMs = computeBackoff(attemptNumber - 1);
          await ctx.runMutation(_markEmailRetry, {
            deliveryId: delivery._id,
            attempts: attemptNumber,
            error: result.error,
            nextAttemptAt: Date.now() + delayMs,
          });
          retried++;
        } else {
          await ctx.runMutation(_markEmailFailed, {
            deliveryId: delivery._id,
            attempts: attemptNumber,
            error: result.error,
          });
          failed++;
        }
      } catch (err) {
        console.error(
          `Email delivery: unexpected error delivering ${String(delivery._id)}: ${String(err)}`,
        );
        skipped++;
        continue;
      }

      try {
        await ctx.runMutation(_rollupAlertEventStatus, { alertEventId: delivery.alertEventId });
      } catch (err) {
        console.error(
          `Email delivery: alert_events rollup failed for ${String(delivery.alertEventId)}: ${String(err)}`,
        );
      }
    }

    console.log(
      `Email delivery: batch=${pending.length} delivered=${delivered} failed=${failed} retried=${retried} skipped=${skipped}`,
    );
    return { batch: pending.length, delivered, failed, retried, skipped };
  },
});
