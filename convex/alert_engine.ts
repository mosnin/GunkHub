// Cycle 2 (docs/design/action_layer.md) — alert EVALUATION. Triggered by the
// terminal-event path in convex/events.ts (createEvent) and
// convex/sdk_ingest.ts (sdkCreateEvents) via
// `ctx.scheduler.runAfter(0, internal.alert_engine.evaluateAlertsForRun, { runId })`,
// scheduled (not inline) so alert evaluation never adds latency or failure
// risk to the ingest path itself.
//
// Reads the org's enabled alert_rules and the immutable event log / run
// record; on a match, inserts an alert_events row (see convex/alerts.ts /
// ADR-002 for why deliveryStatus/deliveredAt are the one sanctioned patch on
// that table) and enqueues a webhook_deliveries row per webhook channel.
// Idempotent: never fires the SAME (ruleId, runId) pair twice, so a retried
// scheduler call (or a defensive re-run) is safe. Never mutates a run or
// event — only ever inserts new alert_events/webhook_deliveries rows.

import { v } from "convex/values";

import { internalMutation } from "./_generated/server.js";
import { renderAlertEmailText } from "./helpers/notifier.js";
import { ALERT_FAILURE_RATE_SAMPLE_SIZE, MAX_PAGE_SIZE } from "./helpers/pagination.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

/** Terminal statuses that count as a "failure" for run_failed / failure_rate. */
const FAILURE_STATUSES = new Set(["failed", "timed_out"]);

/** All terminal statuses — an alert only ever evaluates once a run has ended. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

/**
 * Has this rule already fired for this run? Scans the (typically tiny)
 * per-rule alert_events partition via the by_rule index — bounded by
 * MAX_PAGE_SIZE, which is far beyond how many times one rule could
 * plausibly fire for the same run (at most once, if this function is
 * correct) but keeps the check from ever being an unbounded scan.
 */
async function alreadyFired(
  ctx: MutationCtx,
  ruleId: Id<"alert_rules">,
  runId: Id<"runs">,
): Promise<boolean> {
  const existing = await ctx.db
    .query("alert_events")
    .withIndex("by_rule", (q) => q.eq("ruleId", ruleId))
    .filter((q) => q.eq(q.field("runId"), runId))
    .take(MAX_PAGE_SIZE);
  return existing.length > 0;
}

/** run_failed: fires whenever the run ended in a failure status. */
function evaluateRunFailed(run: Doc<"runs">): { fired: boolean; summary: string } {
  const fired = FAILURE_STATUSES.has(run.status);
  return {
    fired,
    summary: `Run ${String(run._id)} ended with status "${run.status}"`,
  };
}

/**
 * failure_rate: fires when the failure percentage over the trailing
 * `windowMinutes` (scoped to the rule's project, if set, else the whole org)
 * meets or exceeds `thresholdPct`. Requires both fields to be set on the
 * rule; a rule missing either can never fire this condition (defensive —
 * createAlertRule/updateAlertRule validate them, but a rule created before
 * that validation existed should fail safe, not throw).
 */
async function evaluateFailureRate(
  ctx: MutationCtx,
  rule: Doc<"alert_rules">,
  run: Doc<"runs">,
): Promise<{ fired: boolean; summary: string }> {
  if (rule.windowMinutes === undefined || rule.thresholdPct === undefined) {
    return { fired: false, summary: "failure_rate rule missing windowMinutes/thresholdPct" };
  }
  const windowStart = Date.now() - rule.windowMinutes * 60_000;

  const sample = rule.projectId !== undefined
    ? await ctx.db
        .query("runs")
        .withIndex("by_project_started", (q) =>
          q.eq("projectId", rule.projectId!).gte("startedAt", windowStart),
        )
        .take(ALERT_FAILURE_RATE_SAMPLE_SIZE)
    : await ctx.db
        .query("runs")
        .withIndex("by_org_started", (q) => q.eq("orgId", run.orgId).gte("startedAt", windowStart))
        .take(ALERT_FAILURE_RATE_SAMPLE_SIZE);

  // Only terminal runs count toward the rate — an in-flight run is neither a
  // pass nor a failure yet.
  const terminal = sample.filter((r) => TERMINAL_STATUSES.has(r.status));
  const total = terminal.length;
  if (total === 0) {
    return { fired: false, summary: "failure_rate rule: no terminal runs in window" };
  }
  const failedCount = terminal.filter((r) => FAILURE_STATUSES.has(r.status)).length;
  const pct = (failedCount / total) * 100;
  const fired = pct >= rule.thresholdPct;
  return {
    fired,
    summary:
      `Failure rate ${pct.toFixed(1)}% over the last ${rule.windowMinutes} min ` +
      `(${failedCount}/${total} runs) ${fired ? ">=" : "<"} threshold ${rule.thresholdPct}%`,
  };
}

/** eval_failed: fires if ANY eval recorded against this run failed. */
async function evaluateEvalFailed(
  ctx: MutationCtx,
  runId: Id<"runs">,
): Promise<{ fired: boolean; summary: string }> {
  const evals = await ctx.db
    .query("evals")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .take(MAX_PAGE_SIZE);
  const failedEval = evals.find((e) => !e.passed);
  return {
    fired: failedEval !== undefined,
    summary: failedEval
      ? `Eval "${failedEval.name}" failed for run ${String(runId)}`
      : `No failed evals for run ${String(runId)}`,
  };
}

/**
 * Find an existing webhook_targets row for (orgId, url), or create one.
 * Alert-rule webhook channels store a bare https:// URL (validated in
 * convex/alerts.ts), not a webhook_targets id — this is deliberately
 * DIFFERENT from the standalone outbound-webhooks feature's admin-managed
 * targets (ADR-003), but reuses the same table/signing/delivery machinery
 * rather than inventing a parallel one. Idempotent per (orgId, url) so
 * repeated firings of the same rule do not create duplicate targets.
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

  const { randomBytes } = await import("node:crypto");
  const secret = randomBytes(32).toString("hex");
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
 * Best-effort link back to the run in the web UI. AFR_WEB_BASE_URL is
 * optional/unset in most deployments this cycle (no operator-facing setup
 * step exists yet) — falls back to a relative path, which still renders
 * usefully in a plain-text email even without a configured origin.
 */
function buildRunUrl(orgId: Id<"organizations">, runId: Id<"runs">): string {
  const base = process.env["AFR_WEB_BASE_URL"];
  const path = `/org/${String(orgId)}/runs/${String(runId)}`;
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

/**
 * Enqueue delivery for every channel on a fired rule. Webhook channels get a
 * webhook_deliveries row (drained by convex/webhook_engine.ts). Cycle 3:
 * email channels now get an email_deliveries row (drained by
 * convex/email_engine.ts through the configured EmailNotifier —
 * helpers/notifier.ts), completing the path ADR-003 /
 * docs/design/action_layer.md previously deferred. `agentName`/`orgName`
 * are passed in (rather than re-fetched per channel) since the caller
 * already has them from the run's org/agent for the whole rule loop.
 */
async function enqueueDeliveries(
  ctx: MutationCtx,
  run: Doc<"runs">,
  rule: Doc<"alert_rules">,
  alertEventId: Id<"alert_events">,
  agentName: string,
  orgName: string,
): Promise<void> {
  for (const channel of rule.channels) {
    if (channel.type === "webhook") {
      const webhookId = await findOrCreateAlertWebhookTarget(ctx, run.orgId, channel.target);
      await ctx.db.insert("webhook_deliveries", {
        orgId: run.orgId,
        webhookId,
        event: "alert.fired",
        runId: run._id,
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
        alertEventId,
        nextAttemptAt: Date.now(),
      });
      continue;
    }

    // channel.type === "email"
    const now = Date.now();
    const body = renderAlertEmailText({
      alertName: rule.name,
      orgName,
      runId: String(run._id),
      runStatus: run.status,
      agentName,
      firedAt: now,
      condition: rule.kind,
      runUrl: buildRunUrl(run.orgId, run._id),
    });
    await ctx.db.insert("email_deliveries", {
      orgId: run.orgId,
      alertEventId,
      to: channel.target,
      subject: `Agent Flight Recorder alert: ${rule.name}`,
      body,
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
    });
  }
}

/**
 * Evaluate every enabled alert_rule for a run's org against the run that
 * just reached a terminal state. Called via the scheduler from the
 * terminal-event ingest paths — never inline, never blocking ingest.
 */
export const evaluateAlertsForRun = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return { evaluated: 0, fired: 0 };
    // Defensive: alert conditions only make sense once a run has ended. A
    // stray/early scheduler call against a still-running run is a no-op, not
    // an error (idempotent — the terminal event path will re-schedule this
    // once the run actually terminates).
    if (!TERMINAL_STATUSES.has(run.status)) {
      return { evaluated: 0, fired: 0 };
    }

    const rules = await ctx.db
      .query("alert_rules")
      .withIndex("by_org", (q) => q.eq("orgId", run.orgId))
      .take(MAX_PAGE_SIZE);

    // Fetched once per run (not per rule/channel) for email rendering —
    // best-effort, never blocks alert firing if either lookup comes back
    // empty (a deleted agent/org between run creation and alert firing is
    // an edge case, not a reason to fail the whole evaluation).
    const agent = await ctx.db.get(run.agentId);
    const org = await ctx.db.get(run.orgId);
    const agentName = agent?.name ?? "unknown agent";
    const orgName = org?.name ?? "unknown organization";

    let fired = 0;
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.projectId !== undefined && rule.projectId !== run.projectId) continue;

      let verdict: { fired: boolean; summary: string };
      if (rule.kind === "run_failed") {
        verdict = evaluateRunFailed(run);
      } else if (rule.kind === "failure_rate") {
        verdict = await evaluateFailureRate(ctx, rule, run);
      } else {
        verdict = await evaluateEvalFailed(ctx, args.runId);
      }

      if (!verdict.fired) continue;
      if (await alreadyFired(ctx, rule._id, args.runId)) continue; // idempotent

      const alertEventId = await ctx.db.insert("alert_events", {
        orgId: run.orgId,
        ruleId: rule._id,
        runId: args.runId,
        firedAt: Date.now(),
        summary: verdict.summary,
        deliveryStatus: "pending",
      });
      await enqueueDeliveries(ctx, run, rule, alertEventId, agentName, orgName);
      fired++;
    }

    return { evaluated: rules.length, fired };
  },
});
