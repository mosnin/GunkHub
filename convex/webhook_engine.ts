// Cycle 2 (docs/design/action_layer.md) — webhook delivery FAN-OUT. Drains
// `webhook_deliveries` rows in status "pending" whose `nextAttemptAt` is due,
// in bounded batches, via an `internalAction` (actions, unlike mutations, can
// call `fetch`). Scheduled every minute by convex/crons.ts.
//
// Never throws out of the batch: every delivery attempt is wrapped in its
// own try/catch, so one bad target/target-list entry cannot stop the rest of
// the batch from being drained.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { computeBackoff, deliverWebhook } from "./helpers/delivery.js";
import { WEBHOOK_DELIVERY_BATCH_SIZE, WEBHOOK_MAX_ATTEMPTS } from "./helpers/pagination.js";

import type { Doc } from "./_generated/dataModel.js";

const _getPendingDeliveries = makeFunctionReference<"query">("webhook_engine:getPendingDeliveries");
const _getWebhookTarget = makeFunctionReference<"query">("webhook_engine:getWebhookTargetForDelivery");
const _getRunForEnvelope = makeFunctionReference<"query">("webhook_engine:getRunForEnvelope");
const _getAlertEventForEnvelope = makeFunctionReference<"query">("webhook_engine:getAlertEventForEnvelope");
const _markDelivered = makeFunctionReference<"mutation">("webhook_engine:markDelivered");
const _markFailed = makeFunctionReference<"mutation">("webhook_engine:markFailed");
const _markRetry = makeFunctionReference<"mutation">("webhook_engine:markRetry");
const _rollupAlertEventStatus = makeFunctionReference<"mutation">("webhook_engine:rollupAlertEventStatus");

/** Versioned envelope shape — see docs/design/action_layer.md "Webhook payload envelope". */
export const WEBHOOK_ENVELOPE_API_VERSION = "2026-01";

interface EnvelopeRun {
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

function toEnvelopeRun(run: Doc<"runs">): EnvelopeRun {
  return {
    id: String(run._id),
    projectId: String(run.projectId),
    agentId: String(run.agentId),
    agentVersionId: run.agentVersionId !== undefined ? String(run.agentVersionId) : undefined,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    tags: run.tags,
    triggeredBy: run.triggeredBy,
    sdkVersion: run.sdkVersion,
    // Deliberately excludes `metadata` — may contain customer-supplied
    // free-form data of unbounded size/sensitivity, per action_layer.md.
  };
}

/**
 * Cycle 3 (docs/adr/005-failure-patterns.md "Cycle 3"): the pattern context
 * carried by a pattern_spike-driven webhook delivery — see
 * packages/contracts/src/webhooks.ts's `WebhookEnvelopePattern`. Mirrors that
 * contract type exactly (kept in sync manually, same convention as
 * `EnvelopeRun`/`WebhookEnvelopeRun` above).
 */
interface EnvelopePattern {
  fingerprintHash: string;
  class: string;
  label: string;
  recentCount: number;
  deepLink: string;
}

/**
 * Reattach pattern context (fingerprint/class/label/recentCount/deepLink) to
 * a delivery whose firing `alert_events` row is a `pattern_spike` fire (see
 * convex/alerts.ts's `firePatternSpikeAlert`, which stamps
 * `patternFingerprintHash` + a `metadata` object of exactly this shape onto
 * the row it inserts). Returns `undefined` for every other alert kind/event
 * type — a plain `webhook_deliveries` row has no pattern context of its own,
 * only its (optional) `alertEventId` back-reference to look this up from.
 *
 * `alertEvent.metadata` is `v.any()` (the one justified exception documented
 * in schema.ts, mirroring audit_log.metadata) — every field read here is
 * defensively type-checked rather than cast, so a malformed/legacy metadata
 * shape degrades to a safe fallback instead of corrupting the envelope or
 * throwing mid-batch.
 */
function toEnvelopePattern(alertEvent: Doc<"alert_events"> | null): EnvelopePattern | undefined {
  if (!alertEvent?.patternFingerprintHash) return undefined;
  const fingerprintHash = alertEvent.patternFingerprintHash;
  const meta = (alertEvent.metadata ?? {}) as Record<string, unknown>;
  return {
    fingerprintHash,
    class: typeof meta["class"] === "string" ? meta["class"] : "unknown",
    label: typeof meta["label"] === "string" ? meta["label"] : fingerprintHash,
    recentCount: typeof meta["recentCount"] === "number" ? meta["recentCount"] : 0,
    // Same absolute-if-configured/relative-fallback seam as
    // convex/alerts.ts's buildPatternDeepLink (AFR_WEB_BASE_URL) — the value
    // stored in metadata.deepLink at fire time already reflects that, so
    // this only needs a safe fallback for a malformed/legacy row.
    deepLink: typeof meta["deepLink"] === "string" ? meta["deepLink"] : `/patterns/${fingerprintHash}`,
  };
}

/**
 * Bounded batch of due deliveries: status "pending" AND (nextAttemptAt unset
 * OR <= now).
 *
 * AUDIT FIX (cycle 5, perf M1): this used to scan the whole `by_status_created`
 * index (every "pending" row across every org, oldest-created first) and
 * post-filter in memory for the due condition — under a large pending
 * backlog with staggered backoff retry times, most of that scan reads rows
 * that turn out not to be due yet. `by_status_nextAttempt` (status,
 * nextAttemptAt) lets this read due rows directly off the index. Two
 * indexed queries (rather than one open-ended range) because Convex's
 * comparable-value ordering for an optional field is not something this
 * code should depend on for correctness: querying `eq(undefined)` and
 * `lte(now)` separately is unambiguous regardless of how undefined sorts,
 * and the de-dup guards against double-counting if a row happens to satisfy
 * both.
 *
 * `now` is optional and injectable (default Date.now()) so callers/tests can
 * pin a single timestamp for an entire drain instead of taking a fresh
 * wall-clock reading — see deliverPendingWebhooks below.
 */
export const getPendingDeliveries = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();

    const due = await ctx.db
      .query("webhook_deliveries")
      .withIndex("by_status_nextAttempt", (q) =>
        q.eq("status", "pending").lte("nextAttemptAt", now),
      )
      .take(WEBHOOK_DELIVERY_BATCH_SIZE);

    const remaining = WEBHOOK_DELIVERY_BATCH_SIZE - due.length;
    if (remaining <= 0) {
      return due;
    }

    const seen = new Set(due.map((d) => d._id));
    const unset = (
      await ctx.db
        .query("webhook_deliveries")
        .withIndex("by_status_nextAttempt", (q) =>
          q.eq("status", "pending").eq("nextAttemptAt", undefined),
        )
        .take(remaining)
    ).filter((d) => !seen.has(d._id));

    return [...due, ...unset];
  },
});

export const getWebhookTargetForDelivery = internalQuery({
  args: { webhookId: v.id("webhook_targets") },
  handler: async (ctx, args) => await ctx.db.get(args.webhookId),
});

export const getRunForEnvelope = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => await ctx.db.get(args.runId),
});

/**
 * Cycle 3 (docs/adr/005-failure-patterns.md "Cycle 3" gap): a pattern_spike
 * delivery's `alert_events` row carries `patternFingerprintHash`/`metadata`
 * that a `webhook_deliveries` row alone does not — see `toEnvelopePattern`
 * below, which reads this row to reattach that context to the envelope.
 */
export const getAlertEventForEnvelope = internalQuery({
  args: { alertEventId: v.id("alert_events") },
  handler: async (ctx, args) => await ctx.db.get(args.alertEventId),
});

/** The ONE sanctioned patch on a terminally-resolved delivery: bookkeeping fields only. */
export const markDelivered = internalMutation({
  args: {
    deliveryId: v.id("webhook_deliveries"),
    attempts: v.number(),
    responseCode: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: "delivered",
      attempts: args.attempts,
      lastAttemptAt: Date.now(),
      responseCode: args.responseCode,
    });
  },
});

export const markFailed = internalMutation({
  args: {
    deliveryId: v.id("webhook_deliveries"),
    attempts: v.number(),
    responseCode: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: "failed",
      attempts: args.attempts,
      lastAttemptAt: Date.now(),
      responseCode: args.responseCode,
      error: args.error,
    });
  },
});

export const markRetry = internalMutation({
  args: {
    deliveryId: v.id("webhook_deliveries"),
    attempts: v.number(),
    responseCode: v.optional(v.number()),
    error: v.optional(v.string()),
    nextAttemptAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: "pending",
      attempts: args.attempts,
      lastAttemptAt: Date.now(),
      responseCode: args.responseCode,
      error: args.error,
      nextAttemptAt: args.nextAttemptAt,
    });
  },
});

/**
 * Roll a fired alert's overall deliveryStatus up from ALL of its sibling
 * deliveries — webhook_deliveries AND (Cycle 3) email_deliveries, since a
 * rule can mix both channel types: "delivered" once every sibling across
 * BOTH tables has delivered, "failed" once every sibling has resolved and
 * at least one failed, otherwise left "pending" (some siblings still
 * pending/retrying). A no-op if the alert_events row is already resolved
 * (delivered/failed) — the rollup only ever runs once, at the point every
 * sibling first resolves. Called from both convex/webhook_engine.ts and
 * convex/email_engine.ts's delivery drains (by name, via
 * makeFunctionReference — same cross-file pattern already used for
 * alert_engine.ts's own cross-file references, e.g. runEvalsThenEvaluateAlerts).
 */
export const rollupAlertEventStatus = internalMutation({
  args: { alertEventId: v.id("alert_events") },
  handler: async (ctx, args) => {
    const alertEvent = await ctx.db.get(args.alertEventId);
    if (!alertEvent || alertEvent.deliveryStatus !== "pending") return;

    const [webhookSiblings, emailSiblings] = await Promise.all([
      ctx.db
        .query("webhook_deliveries")
        .withIndex("by_alert_event", (q) => q.eq("alertEventId", args.alertEventId))
        .collect(),
      ctx.db
        .query("email_deliveries")
        .withIndex("by_alert_event", (q) => q.eq("alertEventId", args.alertEventId))
        .collect(),
    ]);
    const siblings: { status: "pending" | "delivered" | "failed" }[] = [
      ...webhookSiblings,
      ...emailSiblings,
    ];
    if (siblings.length === 0) return;

    const anyPending = siblings.some((d) => d.status === "pending");
    if (anyPending) return;

    const anyFailed = siblings.some((d) => d.status === "failed");
    await ctx.db.patch(args.alertEventId, {
      deliveryStatus: anyFailed ? "failed" : "delivered",
      deliveredAt: Date.now(),
    });
  },
});

/**
 * Drain up to WEBHOOK_DELIVERY_BATCH_SIZE due "pending" deliveries. For each:
 * build the versioned envelope, sign + POST via helpers/delivery.ts, and
 * patch the result. Retryable failures reschedule via computeBackoff up to
 * WEBHOOK_MAX_ATTEMPTS, after which the delivery is marked terminally
 * "failed". Never throws out of the batch — a bad row is logged and skipped.
 *
 * AUDIT FIX (cycle 5, de-flake): `now` is an optional injectable clock
 * (defaults to Date.now()), threaded through to getPendingDeliveries and
 * used for every timestamp computed in this invocation (envelope `firedAt`,
 * `nextAttemptAt = now + delayMs`). Previously every timestamp in this
 * handler was its own independent `Date.now()` call, and a test asserting
 * `nextAttemptAt > (a separately-read Date.now() - 1)` could flake: since
 * `computeBackoff` returns a RANDOM delay in `[0, cap)` (helpers/delivery.ts),
 * a draw near 0 combined with real wall-clock drift between the action's
 * internal Date.now() and the test's own Date.now() read (worse under
 * parallel-suite CPU contention) could make `nextAttemptAt` (fixed at an
 * earlier instant) fail to exceed a *later* wall-clock reading. Pinning one
 * `now` per invocation removes that drift entirely: nextAttemptAt = now +
 * delayMs >= now is always true relative to the SAME now a test compares
 * against, independent of scheduling jitter or how small the random delay
 * is. Coverage is unchanged — this still asserts convergence to "failed" at
 * WEBHOOK_MAX_ATTEMPTS; see convex/action_layer.test.ts.
 */
export const deliverPendingWebhooks = internalAction({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const pending: Doc<"webhook_deliveries">[] = await ctx.runQuery(_getPendingDeliveries, { now });

    let delivered = 0;
    let failed = 0;
    let retried = 0;
    let skipped = 0;

    for (const delivery of pending) {
      try {
        const target: Doc<"webhook_targets"> | null = await ctx.runQuery(_getWebhookTarget, {
          webhookId: delivery.webhookId,
        });
        const attemptNumber = delivery.attempts + 1;

        if (!target || !target.enabled) {
          await ctx.runMutation(_markFailed, {
            deliveryId: delivery._id,
            attempts: attemptNumber,
            error: target ? "webhook target disabled" : "webhook target not found",
          });
          failed++;
          continue;
        }

        const run: Doc<"runs"> | null = delivery.runId
          ? await ctx.runQuery(_getRunForEnvelope, { runId: delivery.runId })
          : null;

        // Cycle 3: reattach pattern context for a pattern_spike-driven
        // delivery (see toEnvelopePattern's doc comment). Every delivery
        // that came from alert-firing carries `alertEventId`; this is a
        // no-op extra read for every other alert kind (toEnvelopePattern
        // returns undefined when patternFingerprintHash is unset).
        const alertEvent: Doc<"alert_events"> | null = delivery.alertEventId
          ? await ctx.runQuery(_getAlertEventForEnvelope, { alertEventId: delivery.alertEventId })
          : null;
        const pattern = toEnvelopePattern(alertEvent);

        const envelope = {
          apiVersion: WEBHOOK_ENVELOPE_API_VERSION,
          event: delivery.event,
          orgId: String(delivery.orgId),
          run: run ? toEnvelopeRun(run) : null,
          firedAt: now,
          // Omitted entirely (not `pattern: undefined`) for every non-
          // pattern_spike delivery — JSON.stringify drops an undefined-
          // valued key, so a plain object literal here (rather than a
          // conditional spread) already produces the right wire shape.
          pattern,
        };

        const result = await deliverWebhook({
          url: target.url,
          secret: target.secret,
          event: delivery.event,
          payload: envelope,
          deliveryId: String(delivery._id),
        });

        if (result.ok) {
          await ctx.runMutation(_markDelivered, {
            deliveryId: delivery._id,
            attempts: attemptNumber,
            responseCode: result.status ?? undefined,
          });
          delivered++;
        } else if (result.retryable && attemptNumber < WEBHOOK_MAX_ATTEMPTS) {
          const delayMs = computeBackoff(attemptNumber - 1);
          await ctx.runMutation(_markRetry, {
            deliveryId: delivery._id,
            attempts: attemptNumber,
            responseCode: result.status ?? undefined,
            error: result.error,
            nextAttemptAt: now + delayMs,
          });
          retried++;
        } else {
          await ctx.runMutation(_markFailed, {
            deliveryId: delivery._id,
            attempts: attemptNumber,
            responseCode: result.status ?? undefined,
            error: result.error,
          });
          failed++;
        }
      } catch (err) {
        // AUDIT FIX (cycle 4): this used to log-and-continue WITHOUT ever
        // patching the delivery row. `deliverWebhook` (helpers/delivery.ts)
        // calls `assertSafeWebhookUrl` BEFORE its own try/catch, so a target
        // that passed the (weaker, pre-fix) creation-time check but fails
        // the SSRF guard at delivery time — or any other unexpected
        // exception from the query/mutation calls above — left the row
        // "pending" with `nextAttemptAt` already due, so the once-a-minute
        // cron re-picked it up and repeated the same failure FOREVER: an
        // infinite retry wedge, not a bounded one. Fix: treat an exception
        // here exactly like a retryable delivery failure, bounded by
        // WEBHOOK_MAX_ATTEMPTS, so it always converges to terminally
        // "failed". Wrapped in its OWN try/catch — even a failure to patch
        // the row must not crash the batch (matches this action's "never
        // throws out of the batch" contract).
        console.error(
          `Webhook delivery: unexpected error delivering ${String(delivery._id)}: ${String(err)}`,
        );
        try {
          const attemptNumber = delivery.attempts + 1;
          const message = err instanceof Error ? err.message : String(err);
          if (attemptNumber < WEBHOOK_MAX_ATTEMPTS) {
            const delayMs = computeBackoff(attemptNumber - 1);
            await ctx.runMutation(_markRetry, {
              deliveryId: delivery._id,
              attempts: attemptNumber,
              error: message,
              nextAttemptAt: now + delayMs,
            });
            retried++;
          } else {
            await ctx.runMutation(_markFailed, {
              deliveryId: delivery._id,
              attempts: attemptNumber,
              error: message,
            });
            failed++;
          }
        } catch (patchErr) {
          console.error(
            `Webhook delivery: failed to record the above error for ${String(delivery._id)}: ${String(patchErr)}`,
          );
          skipped++;
        }
        continue;
      }

      if (delivery.alertEventId !== undefined) {
        try {
          await ctx.runMutation(_rollupAlertEventStatus, { alertEventId: delivery.alertEventId });
        } catch (err) {
          console.error(
            `Webhook delivery: alert_events rollup failed for ${String(delivery.alertEventId)}: ${String(err)}`,
          );
        }
      }
    }

    console.log(
      `Webhook delivery: batch=${pending.length} delivered=${delivered} failed=${failed} retried=${retried} skipped=${skipped}`,
    );
    return { batch: pending.length, delivered, failed, retried, skipped };
  },
});
