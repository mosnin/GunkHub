// ADR-002 — alert rules (ordinary admin-gated config, audited) and alert
// events (APPEND-ONLY record of a rule firing; deliveryStatus/deliveredAt are
// the one sanctioned patch — see schema.ts and ADR-002 for why that is not a
// violation of append-only semantics). Alert *delivery execution* (actually
// notifying webhook/email channels) is out of scope for this change — see
// recordAlertFired/updateAlertDeliveryStatus below, which are internal-only
// entry points for a future delivery worker.

import { v } from "convex/values";

import { internalMutation, query, mutation } from "./_generated/server.js";
import { recordAuditEvent } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import { DEFAULT_PAGE_SIZE, MAX_ALERT_CHANNELS, MAX_PAGE_SIZE } from "./helpers/pagination.js";

const ALERT_RULE_KIND = v.union(
  v.literal("run_failed"),
  v.literal("failure_rate"),
  v.literal("eval_failed"),
);

const ALERT_CHANNEL = v.object({
  type: v.union(v.literal("webhook"), v.literal("email")),
  target: v.string(),
});

function validateChannels(channels: Array<{ type: "webhook" | "email"; target: string }>): void {
  if (channels.length === 0 || channels.length > MAX_ALERT_CHANNELS) {
    throw afrError(
      "INVALID_ARGUMENT",
      `alert_rules.channels must have 1-${MAX_ALERT_CHANNELS} entries`,
    );
  }
  for (const c of channels) {
    if (c.type === "webhook" && !c.target.startsWith("https://")) {
      throw afrError("INVALID_ARGUMENT", "A webhook channel's target must be an https:// URL");
    }
    if (c.type === "email" && !c.target.includes("@")) {
      throw afrError("INVALID_ARGUMENT", "An email channel's target must look like an email address");
    }
  }
}

function validateRuleThresholds(args: { thresholdPct?: number; windowMinutes?: number }): void {
  if (args.thresholdPct !== undefined && (args.thresholdPct < 0 || args.thresholdPct > 100)) {
    throw afrError("INVALID_ARGUMENT", "thresholdPct must be between 0 and 100");
  }
  if (args.windowMinutes !== undefined && args.windowMinutes <= 0) {
    throw afrError("INVALID_ARGUMENT", "windowMinutes must be a positive number");
  }
}

/** Admin-gated: alerting configuration controls who gets notified about org data. */
export const listAlertRules = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });
    return await ctx.db
      .query("alert_rules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_PAGE_SIZE);
  },
});

export const createAlertRule = mutation({
  args: {
    orgId: v.id("organizations"),
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    kind: ALERT_RULE_KIND,
    thresholdPct: v.optional(v.number()),
    windowMinutes: v.optional(v.number()),
    channels: v.array(ALERT_CHANNEL),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });

    if (args.projectId !== undefined) {
      const project = await ctx.db.get(args.projectId);
      if (!project || project.orgId !== args.orgId) {
        throw new Error("Project not found in this organization");
      }
    }
    validateChannels(args.channels);
    validateRuleThresholds(args);

    const now = Date.now();
    const ruleId = await ctx.db.insert("alert_rules", {
      orgId: args.orgId,
      projectId: args.projectId,
      name: args.name,
      kind: args.kind,
      thresholdPct: args.thresholdPct,
      windowMinutes: args.windowMinutes,
      channels: args.channels,
      enabled: args.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "alert_rule.created",
      targetType: "alert_rule",
      targetId: String(ruleId),
      metadata: { name: args.name, kind: args.kind },
    });

    const created = await ctx.db.get(ruleId);
    if (!created) throw new Error("Failed to create alert rule");
    return created;
  },
});

export const updateAlertRule = mutation({
  args: {
    ruleId: v.id("alert_rules"),
    name: v.optional(v.string()),
    thresholdPct: v.optional(v.number()),
    windowMinutes: v.optional(v.number()),
    channels: v.optional(v.array(ALERT_CHANNEL)),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) throw new Error("Alert rule not found");

    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, rule.orgId, { minimumRole: "admin" });

    if (args.channels !== undefined) validateChannels(args.channels);
    validateRuleThresholds(args);

    const patch: {
      updatedAt: number;
      name?: string;
      thresholdPct?: number;
      windowMinutes?: number;
      channels?: Array<{ type: "webhook" | "email"; target: string }>;
      enabled?: boolean;
    } = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.thresholdPct !== undefined) patch.thresholdPct = args.thresholdPct;
    if (args.windowMinutes !== undefined) patch.windowMinutes = args.windowMinutes;
    if (args.channels !== undefined) patch.channels = args.channels;
    if (args.enabled !== undefined) patch.enabled = args.enabled;

    await ctx.db.patch(args.ruleId, patch);

    await recordAuditEvent(ctx, {
      orgId: rule.orgId,
      actorClerkUserId: userId,
      action: "alert_rule.updated",
      targetType: "alert_rule",
      targetId: String(args.ruleId),
      metadata: patch,
    });

    return await ctx.db.get(args.ruleId);
  },
});

export const deleteAlertRule = mutation({
  args: { ruleId: v.id("alert_rules") },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) throw new Error("Alert rule not found");

    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, rule.orgId, { minimumRole: "admin" });

    await ctx.db.delete(args.ruleId);

    await recordAuditEvent(ctx, {
      orgId: rule.orgId,
      actorClerkUserId: userId,
      action: "alert_rule.deleted",
      targetType: "alert_rule",
      targetId: String(args.ruleId),
      metadata: { name: rule.name },
    });

    return { deleted: true as const };
  },
});

/** Org-scoped, newest-first read of fired alerts. Any member may view (not admin-only). */
export const listAlertEvents = query({
  args: { orgId: v.id("organizations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return await ctx.db
      .query("alert_events")
      .withIndex("by_org_fired", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(limit);
  },
});

export const listAlertEventsForRule = query({
  args: { ruleId: v.id("alert_rules"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) throw new Error("Alert rule not found");
    await requireOrgMembership(ctx, rule.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return await ctx.db
      .query("alert_events")
      .withIndex("by_rule", (q) => q.eq("ruleId", args.ruleId))
      .order("desc")
      .take(limit);
  },
});

// ---------------------------------------------------------------------------
// Internal-only entry points for a future alert-evaluation/delivery worker.
// Not wired to any cron or event trigger in this change — see ADR-002.
// ---------------------------------------------------------------------------

/** Append-only: records the fact that a rule fired. Never patched after insert. */
export const recordAlertFired = internalMutation({
  args: {
    orgId: v.id("organizations"),
    ruleId: v.id("alert_rules"),
    runId: v.optional(v.id("runs")),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("alert_events", {
      orgId: args.orgId,
      ruleId: args.ruleId,
      runId: args.runId,
      firedAt: Date.now(),
      summary: args.summary,
      deliveryStatus: "pending",
    });
  },
});

/**
 * The ONE sanctioned patch on alert_events: delivery bookkeeping about an
 * already-immutable fired-alert record. Never touches ruleId/runId/firedAt/summary.
 */
export const updateAlertDeliveryStatus = internalMutation({
  args: {
    alertEventId: v.id("alert_events"),
    deliveryStatus: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed")),
    deliveredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.alertEventId);
    if (!row) throw new Error("Alert event not found");
    await ctx.db.patch(args.alertEventId, {
      deliveryStatus: args.deliveryStatus,
      deliveredAt: args.deliveredAt,
    });
  },
});
