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
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from "./helpers/delivery.js";
import { afrError } from "./helpers/errors.js";
import { DEFAULT_PAGE_SIZE, MAX_ALERT_CHANNELS, MAX_PAGE_SIZE } from "./helpers/pagination.js";
import { randomHex } from "./helpers/random.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

const ALERT_RULE_KIND = v.union(
  v.literal("run_failed"),
  v.literal("failure_rate"),
  v.literal("eval_failed"),
  // Failure Patterns cycle 2 (docs/adr/005-failure-patterns.md) — see
  // firePatternSpikeAlert below.
  v.literal("pattern_spike"),
  // ADR-006 (docs/adr/006-failure-resolution.md) — see
  // firePatternRegressionAlert below.
  v.literal("pattern_regressed"),
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
    if (c.type === "webhook") {
      // AUDIT FIX (cycle 4): the old `startsWith("https://")` check let an
      // otherwise-https URL through even when it points at a private/
      // reserved IP or a blocked internal hostname (e.g.
      // "https://169.254.169.254/") — a target that would then throw at
      // DELIVERY time from assertSafeWebhookUrl inside deliverWebhook,
      // wedging that delivery forever if the catch site didn't handle it
      // (see the fix in convex/webhook_engine.ts). Run the real SSRF guard
      // HERE too, as defense in depth, so an unsafe target is rejected at
      // rule-creation time with a clear error instead of silently queuing
      // deliveries that can never succeed.
      try {
        assertSafeWebhookUrl(c.target);
      } catch (err) {
        const reason = err instanceof UnsafeWebhookUrlError ? err.message : "invalid webhook URL";
        throw afrError("INVALID_ARGUMENT", `A webhook channel's target is unsafe: ${reason}`);
      }
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
    // TENANCY (CLAUDE.md Tenancy Rule 3). Resolve and authorize the CALLER
    // before observing args.ruleId — this is an admin-gated WRITE path.
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "admin" });

    // Cross-org rule and nonexistent rule collapse to one outcome.
    const rule = await ctx.db.get(args.ruleId);
    if (!rule || rule.orgId !== orgId) throw new Error("Alert rule not found");

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
    // TENANCY (CLAUDE.md Tenancy Rule 3). Resolve and authorize the CALLER
    // before observing args.ruleId — this is a destructive WRITE path, so the
    // collapse must precede the delete, not follow it.
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "admin" });

    // Cross-org rule and nonexistent rule collapse to one outcome.
    const rule = await ctx.db.get(args.ruleId);
    if (!rule || rule.orgId !== orgId) throw new Error("Alert rule not found");

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
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the rule is observed only afterwards.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    // Cross-org rule and nonexistent rule collapse to one outcome.
    const rule = await ctx.db.get(args.ruleId);
    if (!rule || rule.orgId !== orgId) throw new Error("Alert rule not found");

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const rows = await ctx.db
      .query("alert_events")
      .withIndex("by_rule", (q) => q.eq("ruleId", args.ruleId))
      .order("desc")
      .take(limit);

    // Defence in depth: an alert event stamped with a different org than its
    // rule is a data defect, not something to hand back across the boundary.
    return rows.filter((e) => e.orgId === orgId);
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

// ---------------------------------------------------------------------------
// Failure Patterns cycle 2 (docs/adr/005-failure-patterns.md) — pattern-spike
// alert firing. Called ONLY from convex/failure_patterns.ts's
// assessPatternSpikesCron, exactly once per pattern that its own
// spike-transition check (assessPatternSpikeTransition, or the local
// fallback — see that file) decides is a fresh spike entry. This mutation
// itself performs NO idempotency/cooldown check of its own — that
// responsibility lives entirely in the caller (the stored
// `lastSpikeAssessment` + `lastPatternSpikeAlertFiredAt` cooldown state on
// the `failure_patterns` rollup), exactly as documented there. This mirrors
// convex/alert_engine.ts's evaluateAlertsForRun firing semantics for every
// OTHER rule kind: only ENABLED rules fire, one alert_events row + one set of
// channel deliveries per matching rule (a rule of this kind is org-wide —
// `projectId` is not meaningful for a failure-pattern rollup, which is not
// project-scoped — so, unlike run_failed/failure_rate/eval_failed, a rule's
// `projectId` is never consulted here).
// ---------------------------------------------------------------------------

/**
 * Find an existing webhook_targets row for (orgId, url), or create one.
 * Duplicated (not imported) from convex/alert_engine.ts's
 * findOrCreateAlertWebhookTarget on purpose — alert_engine.ts's version is
 * written against a `Doc<"runs">`-centric firing flow it owns, and importing
 * across that boundary during this cycle risks a break if that file's shape
 * changes; this is the same "duplicate a small, stable helper rather than
 * import across an active team boundary" convention convex/insights.ts's own
 * header note documents for its date-math helpers.
 */
async function findOrCreateAlertWebhookTarget(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  url: string,
): Promise<Id<"webhook_targets">> {
  const existing = await ctx.db
    .query("webhook_targets")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) => q.eq(q.field("url"), url))
    .first();
  if (existing) return existing._id;

  // Web Crypto, not node:crypto. The Convex isolate has no Node builtins, and a
  // dynamic import with a static specifier is resolved by esbuild at build time —
  // so this failed the deploy exactly as a static import would, while being
  // invisible to a grep for `from "node:`.
  const secret = randomHex(32);
  return await ctx.db.insert("webhook_targets", {
    orgId,
    url,
    secret,
    events: ["alert.fired"],
    enabled: true,
    createdAt: Date.now(),
  });
}

/**
 * Cycle 3 (docs/adr/005-failure-patterns.md "Cycle 3" / ADR-003 constraint
 * that an EXTERNAL webhook's deep link must be absolute, not a bare relative
 * path): builds the pattern detail deep link, prefixed with `AFR_WEB_BASE_URL`
 * when that Convex env var is configured — the SAME optional env var
 * `convex/alert_engine.ts`'s `buildRunUrl` already uses for the "View run"
 * link in alert emails (see .env.example's `AFR_WEB_BASE_URL` doc comment).
 * No separate app-base-URL env var is introduced; this reuses the one seam
 * that already exists for exactly this purpose.
 *
 * DOCUMENTED FALLBACK: most deployments this cycle have no operator-facing
 * setup step for `AFR_WEB_BASE_URL` yet, so it is commonly unset. When unset,
 * this returns the bare relative path `/patterns/[fingerprintHash]` — still
 * usable inside the app (relative links resolve fine in the web UI's own
 * fetch/render context) but NOT a valid absolute URL for an external webhook
 * consumer or a plain-text email client. `fingerprintHash` is always present
 * in the metadata/summary alongside `deepLink` specifically so an external
 * consumer that needs an absolute URL can construct one from its own known
 * app origin even when this fallback path is what shipped.
 */
function buildPatternDeepLink(fingerprintHash: string): string {
  const base = process.env["AFR_WEB_BASE_URL"];
  const path = `/patterns/${fingerprintHash}`;
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

/** Plain-text email body for a fired pattern_spike alert. Deliberately simple (no HTML) — mirrors renderAlertEmailText's plain-text convention. */
function renderPatternSpikeEmailText(args: {
  orgName: string;
  label: string;
  recentCount: number;
  deepLink: string;
}): string {
  return [
    `Agent Flight Recorder detected a failure-pattern spike in ${args.orgName}.`,
    "",
    `Pattern: ${args.label}`,
    `Recent occurrences: ${String(args.recentCount)}`,
    `Details: ${args.deepLink}`,
  ].join("\n");
}

async function enqueuePatternSpikeDeliveries(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    rule: Doc<"alert_rules">;
    alertEventId: Id<"alert_events">;
    orgName: string;
    label: string;
    recentCount: number;
    deepLink: string;
    representativeRunId: Id<"runs"> | undefined;
  },
): Promise<void> {
  for (const channel of args.rule.channels) {
    if (channel.type === "webhook") {
      const webhookId = await findOrCreateAlertWebhookTarget(ctx, args.orgId, channel.target);
      await ctx.db.insert("webhook_deliveries", {
        orgId: args.orgId,
        webhookId,
        event: "alert.fired",
        runId: args.representativeRunId,
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
        alertEventId: args.alertEventId,
        nextAttemptAt: Date.now(),
      });
      continue;
    }

    // channel.type === "email"
    const now = Date.now();
    await ctx.db.insert("email_deliveries", {
      orgId: args.orgId,
      alertEventId: args.alertEventId,
      to: channel.target,
      subject: `Agent Flight Recorder alert: ${args.rule.name}`,
      body: renderPatternSpikeEmailText({
        orgName: args.orgName,
        label: args.label,
        recentCount: args.recentCount,
        deepLink: args.deepLink,
      }),
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
    });
  }
}

/**
 * Fire every ENABLED `pattern_spike` alert_rule in `orgId` for one detected
 * spike-transition. Inserts one append-only `alert_events` row per matching
 * rule (never patched except via updateAlertDeliveryStatus/the delivery-drain
 * rollup, same as every other kind) plus one channel delivery per rule
 * channel, exactly mirroring convex/alert_engine.ts's per-rule firing shape.
 *
 * `representativeRunId` (typically `failure_patterns.representativeRunIds[0]`
 * — the most recent run that produced this fingerprint) is attached to the
 * alert_events row and threaded through to any webhook delivery so
 * convex/webhook_engine.ts's existing envelope builder (which already
 * tolerates `delivery.runId` being unset, rendering `run: null`) can surface
 * a real, clickable run for context — no change to that file was needed.
 */
export const firePatternSpikeAlert = internalMutation({
  args: {
    orgId: v.id("organizations"),
    fingerprintHash: v.string(),
    class: v.string(),
    label: v.string(),
    recentCount: v.number(),
    representativeRunId: v.optional(v.id("runs")),
  },
  handler: async (ctx, args): Promise<{ fired: number }> => {
    const rules = await ctx.db
      .query("alert_rules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_PAGE_SIZE);

    const matching = rules.filter((r) => r.enabled && r.kind === "pattern_spike");
    if (matching.length === 0) return { fired: 0 };

    const org = await ctx.db.get(args.orgId);
    const orgName = org?.name ?? "unknown organization";
    const deepLink = buildPatternDeepLink(args.fingerprintHash);
    const summary =
      `Failure pattern "${args.label}" is spiking (${String(args.recentCount)} recent occurrences) — ${deepLink}`;

    let fired = 0;
    for (const rule of matching) {
      const alertEventId = await ctx.db.insert("alert_events", {
        orgId: args.orgId,
        ruleId: rule._id,
        runId: args.representativeRunId,
        firedAt: Date.now(),
        summary,
        deliveryStatus: "pending",
        patternFingerprintHash: args.fingerprintHash,
        metadata: {
          fingerprintHash: args.fingerprintHash,
          class: args.class,
          label: args.label,
          recentCount: args.recentCount,
          deepLink,
        },
      });

      await enqueuePatternSpikeDeliveries(ctx, {
        orgId: args.orgId,
        rule,
        alertEventId,
        orgName,
        label: args.label,
        recentCount: args.recentCount,
        deepLink,
        representativeRunId: args.representativeRunId,
      });

      fired++;
    }

    return { fired };
  },
});

// ---------------------------------------------------------------------------
// ADR-006 (docs/adr/006-failure-resolution.md) — regression guard alert
// firing. Called ONLY from convex/failure_patterns.ts's
// recordFailurePatternOccurrence, exactly once per occurrence that lands for
// a pattern whose stored `status` was "resolved" at occurrence time AND
// whose `occurredAt` postdates the stored `resolvedAt` ("your fix didn't
// hold"). Idempotency is structural, not cooldown-based (unlike
// pattern_spike): once the caller flips the rollup's status away from
// "resolved" (to "open"), the very condition that triggers this alert no
// longer holds for any further occurrence on the same run of failures, until
// a human resolves it again. This mutation itself performs no additional
// idempotency check — see recordFailurePatternOccurrence's doc comment for
// why the caller-side status transition is sufficient.
// ---------------------------------------------------------------------------

/** Plain-text email body for a fired pattern_regressed alert. */
function renderPatternRegressionEmailText(args: {
  orgName: string;
  label: string;
  resolvedAt: number;
  regressedAt: number;
  deepLink: string;
}): string {
  return [
    `Agent Flight Recorder: a RESOLVED failure pattern regressed in ${args.orgName}.`,
    "",
    `Pattern: ${args.label}`,
    `Resolved at: ${new Date(args.resolvedAt).toISOString()}`,
    `Regressed at: ${new Date(args.regressedAt).toISOString()}`,
    `Details: ${args.deepLink}`,
  ].join("\n");
}

async function enqueuePatternRegressionDeliveries(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    rule: Doc<"alert_rules">;
    alertEventId: Id<"alert_events">;
    orgName: string;
    label: string;
    resolvedAt: number;
    regressedAt: number;
    deepLink: string;
    representativeRunId: Id<"runs"> | undefined;
  },
): Promise<void> {
  for (const channel of args.rule.channels) {
    if (channel.type === "webhook") {
      const webhookId = await findOrCreateAlertWebhookTarget(ctx, args.orgId, channel.target);
      await ctx.db.insert("webhook_deliveries", {
        orgId: args.orgId,
        webhookId,
        event: "alert.fired",
        runId: args.representativeRunId,
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
        alertEventId: args.alertEventId,
        nextAttemptAt: Date.now(),
      });
      continue;
    }

    // channel.type === "email"
    const now = Date.now();
    await ctx.db.insert("email_deliveries", {
      orgId: args.orgId,
      alertEventId: args.alertEventId,
      to: channel.target,
      subject: `Agent Flight Recorder alert: ${args.rule.name}`,
      body: renderPatternRegressionEmailText({
        orgName: args.orgName,
        label: args.label,
        resolvedAt: args.resolvedAt,
        regressedAt: args.regressedAt,
        deepLink: args.deepLink,
      }),
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
    });
  }
}

/**
 * Fire every ENABLED `pattern_regressed` alert_rule in `orgId` for one
 * detected resolved -> reopened regression. Mirrors firePatternSpikeAlert's
 * shape exactly (one append-only alert_events row + one delivery per rule
 * channel, per matching rule; a no-op with `{ fired: 0 }` when the org has no
 * matching enabled rule — same "no-op when no rule matches" behavior every
 * other alert kind has).
 *
 * Muting (docs/adr/005-failure-patterns.md Cycle 3's `failure_patterns.muted`)
 * suppresses this call entirely at the caller (recordFailurePatternOccurrence
 * never invokes this mutation for a muted pattern) — mute silences alerts, it
 * does not disable the lifecycle, so the rollup still reopens either way.
 */
export const firePatternRegressionAlert = internalMutation({
  args: {
    orgId: v.id("organizations"),
    fingerprintHash: v.string(),
    class: v.string(),
    label: v.string(),
    resolvedAt: v.number(),
    regressedAt: v.number(),
    representativeRunId: v.optional(v.id("runs")),
  },
  handler: async (ctx, args): Promise<{ fired: number }> => {
    const rules = await ctx.db
      .query("alert_rules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_PAGE_SIZE);

    const matching = rules.filter((r) => r.enabled && r.kind === "pattern_regressed");
    if (matching.length === 0) return { fired: 0 };

    const org = await ctx.db.get(args.orgId);
    const orgName = org?.name ?? "unknown organization";
    const deepLink = buildPatternDeepLink(args.fingerprintHash);
    const summary =
      `Failure pattern "${args.label}" regressed after being marked resolved — ${deepLink}`;

    let fired = 0;
    for (const rule of matching) {
      const alertEventId = await ctx.db.insert("alert_events", {
        orgId: args.orgId,
        ruleId: rule._id,
        runId: args.representativeRunId,
        firedAt: Date.now(),
        summary,
        deliveryStatus: "pending",
        patternFingerprintHash: args.fingerprintHash,
        metadata: {
          fingerprintHash: args.fingerprintHash,
          class: args.class,
          label: args.label,
          resolvedAt: args.resolvedAt,
          regressedAt: args.regressedAt,
          deepLink,
        },
      });

      await enqueuePatternRegressionDeliveries(ctx, {
        orgId: args.orgId,
        rule,
        alertEventId,
        orgName,
        label: args.label,
        resolvedAt: args.resolvedAt,
        regressedAt: args.regressedAt,
        deepLink,
        representativeRunId: args.representativeRunId,
      });

      fired++;
    }

    return { fired };
  },
});
