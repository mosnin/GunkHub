// Data retention and erasure — ADR 001 (docs/adr/001-data-retention-and-erasure.md).
//
// This module is the ONLY sanctioned deletion path for recorded data. It deletes
// whole-org partitions (purgeOrganization, for offboarding/GDPR erasure) or whole
// terminal runs older than an org's opt-in retention window (enforceRetention).
// It never deletes individual events — within-org immutability is preserved: a
// run either exists in full or not at all.
//
// Every function here is INTERNAL (not publicly callable). purgeOrganization is
// invoked only from the Convex dashboard/CLI by an operator acting on a verified
// erasure request; enforceRetention runs from the daily cron.
//
// Batching: each internal mutation call deletes at most PURGE_BATCH_SIZE docs to
// stay inside Convex transaction limits. The orchestrating actions loop and, if
// a purge is still not drained after MAX_BATCHES_PER_INVOCATION, re-schedule
// themselves via ctx.scheduler until done.

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { PURGE_BATCH_SIZE } from "./helpers/pagination.js";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

const _purgeOrganizationBatch = makeFunctionReference<"mutation">(
  "retention:purgeOrganizationBatch",
);
const _purgeOrganization = makeFunctionReference<"action">(
  "retention:purgeOrganization",
);
const _listRetentionTargets = makeFunctionReference<"query">(
  "retention:listRetentionTargets",
);
const _purgeRunBatch = makeFunctionReference<"mutation">("retention:purgeRunBatch");

// Terminal statuses — only closed runs are ever eligible for retention deletion.
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;

// Safety bound on batches per action invocation; a still-undrained purge
// re-schedules itself rather than risking the action time budget.
const MAX_BATCHES_PER_INVOCATION = 200;

// Cap on organizations examined per retention sweep (orgs table is small).
const MAX_ORGS_PER_SWEEP = 1_000;

// Cap on runs deleted per org per nightly retention sweep. Remaining backlog is
// drained on subsequent nights.
const MAX_RUNS_PER_ORG_PER_SWEEP = 100;

interface BatchResult {
  deleted: number;
  /** Storage keys of deleted artifact records, for best-effort blob deletion. */
  storageKeys: string[];
  done: boolean;
}

/**
 * Delete up to `budget` documents belonging to one RUN, in dependency order:
 * run-targeted comments → verification_results → evals → artifacts → events
 * (plus any event-targeted comments) → finally the run document itself.
 * Returns done=true once the run document has been deleted.
 */
async function purgeRunSlice(
  ctx: MutationCtx,
  runId: Id<"runs">,
  budget: number,
): Promise<BatchResult> {
  let deleted = 0;
  const storageKeys: string[] = [];
  const remaining = (): number => budget - deleted;

  // 1. Comments targeting the run itself.
  if (remaining() > 0) {
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_target", (q) =>
        q.eq("targetId", runId as string).eq("targetType", "run"),
      )
      .take(remaining());
    for (const c of comments) {
      await ctx.db.delete(c._id);
      deleted++;
    }
  }

  // 2. Verification results for the run.
  if (remaining() > 0) {
    const results = await ctx.db
      .query("verification_results")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(remaining());
    for (const r of results) {
      await ctx.db.delete(r._id);
      deleted++;
    }
  }

  // 2b. AUDIT FIX (cycle 4): evals recorded against this run (ADR-002 —
  // append-only, same erasure obligation as comments/verification_results).
  // This was missing entirely: a retention-window run deletion, and every
  // per-run slice inside an org purge, left `evals` rows referencing a
  // deleted runId behind forever — a real erasure gap (an eval's `details`
  // field can carry arbitrary, possibly-sensitive text quoted from the run).
  if (remaining() > 0) {
    const evalRows = await ctx.db
      .query("evals")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(remaining());
    for (const ev of evalRows) {
      await ctx.db.delete(ev._id);
      deleted++;
    }
  }

  // 2c. AUDIT FIX (cycle 5, H4): alert_events fired for this run, and their
  // dependent email_deliveries/webhook_deliveries rows (ADR-002/003 tables).
  // The org purge (purgeOrganizationBatch) already sweeps these tables
  // org-wide; this per-run retention-window deletion did not touch them at
  // all, so a retention-deleted run could leave behind alert_events rows
  // (whose `summary` can quote run details) plus their webhook/email
  // delivery bookkeeping, forever — the same class of erasure gap the
  // cycle-4 fix closed for `evals` above. See docs/adr/001 for the
  // decision note recording this as part of ADR 001's scope.
  //
  // alert_events and webhook_deliveries both carry `runId` directly (the
  // latter is stamped on creation by both the alert-triggered path,
  // convex/alert_engine.ts, and the standalone webhook_targets CRUD path,
  // convex/webhooks.ts), so both are found via their own `by_run` index.
  // email_deliveries has no `runId` field — it is only reachable via its
  // `alertEventId` (by_alert_event index) — so alert_events must be looked
  // up (not yet deleted) before its email_deliveries can be found.
  let alertEventIds: Id<"alert_events">[] = [];
  if (remaining() > 0) {
    const alertEvents = await ctx.db
      .query("alert_events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(remaining());
    alertEventIds = alertEvents.map((ae) => ae._id);
  }

  for (const alertEventId of alertEventIds) {
    if (remaining() <= 0) break;
    const emails = await ctx.db
      .query("email_deliveries")
      .withIndex("by_alert_event", (q) => q.eq("alertEventId", alertEventId))
      .take(remaining());
    for (const e of emails) {
      await ctx.db.delete(e._id);
      deleted++;
    }
  }

  if (remaining() > 0) {
    const webhookDeliveries = await ctx.db
      .query("webhook_deliveries")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(remaining());
    for (const w of webhookDeliveries) {
      await ctx.db.delete(w._id);
      deleted++;
    }
  }

  // Delete the alert_events rows themselves last (after their dependent
  // email_deliveries have been removed above).
  for (const alertEventId of alertEventIds) {
    if (remaining() <= 0) break;
    const ae = await ctx.db.get(alertEventId);
    if (ae) {
      await ctx.db.delete(alertEventId);
      deleted++;
    }
  }

  // 3. Artifacts (collect storage keys for best-effort blob deletion upstream).
  if (remaining() > 0) {
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(remaining());
    for (const a of artifacts) {
      storageKeys.push(a.storageKey);
      await ctx.db.delete(a._id);
      deleted++;
    }
  }

  // 4. Events — the ONLY place recorded events are ever deleted (ADR 001).
  //    Event-targeted comments are removed alongside each event. Comment
  //    deletions COUNT AGAINST THE BATCH BUDGET: a comment-heavy event must not
  //    blow the transaction bound, so we bail mid-page when the budget runs out
  //    (the event is only deleted after ALL its comments are gone, so the next
  //    batch resumes on the same event with its remaining comments).
  if (remaining() > 0) {
    const want = remaining();
    const events = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(want);
    for (const e of events) {
      if (remaining() <= 0) {
        return { deleted, storageKeys, done: false };
      }
      const eventComments = await ctx.db
        .query("comments")
        .withIndex("by_target", (q) =>
          q.eq("targetId", e._id as string).eq("targetType", "event"),
        )
        .take(remaining());
      for (const c of eventComments) {
        await ctx.db.delete(c._id);
        deleted++;
      }
      // Budget exhausted mid-comment-page (or exactly at the boundary — there
      // may be more comments than we could take): keep the event for the next
      // batch rather than orphaning any of its remaining comments.
      if (remaining() <= 0) {
        return { deleted, storageKeys, done: false };
      }
      await ctx.db.delete(e._id);
      deleted++;
    }
    // A full page means more events may remain — not done yet.
    if (events.length === want) {
      return { deleted, storageKeys, done: false };
    }
  }

  if (remaining() <= 0) {
    return { deleted, storageKeys, done: false };
  }

  // 5. All dependents drained within budget — delete the run document itself.
  const run = await ctx.db.get(runId);
  if (run) {
    await ctx.db.delete(runId);
    deleted++;
  }
  return { deleted, storageKeys, done: true };
}

/**
 * Delete one batch (≤ PURGE_BATCH_SIZE docs) of an organization's data, in
 * dependency order. Called repeatedly by purgeOrganization until done=true.
 * Order: api_keys → memberships (FIRST — cutting credentials before data means
 * live SDK ingestion and user sessions cannot race the sweeper and write into a
 * partially-purged org) → org-level comments → org verification_results → runs
 * (each fully via purgeRunSlice) → agent_versions → agents → projects →
 * audit_log (LAST — see ADR 001) → the organization record.
 */
export const purgeOrganizationBatch = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<BatchResult> => {
    const budget = PURGE_BATCH_SIZE;
    let deleted = 0;
    const storageKeys: string[] = [];
    const remaining = (): number => budget - deleted;

    // 0a. API keys FIRST: once these rows are gone, every sdk_ingest mutation
    //     fails its key lookup, so live ingestion cannot race the purge and
    //     insert runs/events/artifacts behind the sweeper.
    const keys = await ctx.db
      .query("api_keys")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const k of keys) {
      await ctx.db.delete(k._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 0b. Memberships next, for the same reason on the Clerk-JWT path: without
    //     a membership row, requireOrgMembership rejects every user write.
    const memberships = await ctx.db
      .query("user_memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const m of memberships) {
      await ctx.db.delete(m._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 0c. AUDIT FIX (cycle 4): webhook_targets — deleted alongside api_keys
    // above, before any other org data. Like an API key, a webhook target
    // carries a live credential (its plaintext signing secret, per ADR-002's
    // documented tradeoff) that must not outlive the org it authenticates
    // for. This entire ADR-002/ADR-003 table set (alert_rules, alert_events,
    // webhook_targets, webhook_deliveries, email_deliveries, usage_counters,
    // daily_rollups) landed AFTER ADR 001's purge was written and was never
    // wired into it — every one of these tables was previously left behind,
    // permanently, by an org purge, which is a genuine erasure-obligation gap
    // (ADR 001 requires "cascades deletion of ALL data belonging to a single
    // organization"). Order among these seven is not load-bearing (none of
    // them gate write authorization the way api_keys/memberships do), so they
    // are grouped here as one step, each org-indexed and bounded.
    const webhookTargets = await ctx.db
      .query("webhook_targets")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const w of webhookTargets) {
      await ctx.db.delete(w._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    const webhookDeliveries = await ctx.db
      .query("webhook_deliveries")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const w of webhookDeliveries) {
      await ctx.db.delete(w._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    const emailDeliveries = await ctx.db
      .query("email_deliveries")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const e of emailDeliveries) {
      await ctx.db.delete(e._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    const alertEvents = await ctx.db
      .query("alert_events")
      .withIndex("by_org_fired", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const ae of alertEvents) {
      await ctx.db.delete(ae._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    const alertRules = await ctx.db
      .query("alert_rules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const ar of alertRules) {
      await ctx.db.delete(ar._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    const usageCounters = await ctx.db
      .query("usage_counters")
      .withIndex("by_org_day", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const u of usageCounters) {
      await ctx.db.delete(u._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    const dailyRollups = await ctx.db
      .query("daily_rollups")
      .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const d of dailyRollups) {
      await ctx.db.delete(d._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 1. Comments (org-scoped index catches run- and event-targeted alike).
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const c of comments) {
      await ctx.db.delete(c._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 2. Verification results.
    const results = await ctx.db
      .query("verification_results")
      .withIndex("by_org_verified", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const r of results) {
      await ctx.db.delete(r._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 3. Runs — artifacts and events have no by_org index, so they are drained
    //    per-run via the by_run indexes.
    while (remaining() > 0) {
      const run = await ctx.db
        .query("runs")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .first();
      if (!run) break;
      const slice = await purgeRunSlice(ctx, run._id, remaining());
      deleted += slice.deleted;
      storageKeys.push(...slice.storageKeys);
      if (!slice.done) return { deleted, storageKeys, done: false };
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 4. Agents and their versions (agent_versions has no by_org index).
    while (remaining() > 0) {
      const agent = await ctx.db
        .query("agents")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .first();
      if (!agent) break;
      const versions = await ctx.db
        .query("agent_versions")
        .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
        .take(remaining());
      for (const av of versions) {
        await ctx.db.delete(av._id);
        deleted++;
      }
      if (remaining() <= 0) return { deleted, storageKeys, done: false };
      await ctx.db.delete(agent._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 5. Projects.
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const p of projects) {
      await ctx.db.delete(p._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 6. Audit log — deleted LAST so the trail survives as long as possible.
    //    The terminal purge record goes to the function log (ADR 001): a row in
    //    the org's own audit_log cannot survive the org's erasure.
    const auditRows = await ctx.db
      .query("audit_log")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const row of auditRows) {
      await ctx.db.delete(row._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 7. The organization record itself.
    const org = await ctx.db.get(args.orgId);
    if (org) {
      await ctx.db.delete(args.orgId);
      deleted++;
    }
    return { deleted, storageKeys, done: true };
  },
});

/** Best-effort blob deletion; failures are logged, never fatal (ADR 001). */
async function deleteBlobsBestEffort(storageKeys: string[]): Promise<number> {
  const blobToken = process.env["BLOB_STORE_TOKEN"];
  if (!blobToken) {
    if (storageKeys.length > 0) {
      console.warn(
        `Retention: BLOB_STORE_TOKEN not set; skipped blob deletion for ${storageKeys.length} artifact(s)`,
      );
    }
    return 0;
  }
  let failures = 0;
  for (const key of storageKeys) {
    try {
      const res = await fetch(`https://blob.vercel-storage.com/${key}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${blobToken}` },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Vercel Blob DELETE returned ${res.status}`);
      }
    } catch (err) {
      failures++;
      console.error(
        `Retention: blob DELETE failed for key=${key}: ${String(err)} (record already deleted; orphaned blob needs ops cleanup)`,
      );
    }
  }
  return failures;
}

/**
 * ADR 001 org purge — cascade-delete ALL data belonging to one organization.
 * INTERNAL ONLY: invoked from the Convex dashboard/CLI on a verified
 * offboarding/erasure request. Re-schedules itself until drained.
 */
export const purgeOrganization = internalAction({
  args: {
    orgId: v.id("organizations"),
    // Test/ops override for the per-invocation batch cap. Internal-only surface;
    // defaults to MAX_BATCHES_PER_INVOCATION.
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ deleted: number; done: boolean }> => {
    let totalDeleted = 0;
    let blobFailures = 0;
    const maxBatches = args.maxBatches ?? MAX_BATCHES_PER_INVOCATION;

    for (let batch = 0; batch < maxBatches; batch++) {
      const result: BatchResult = await ctx.runMutation(_purgeOrganizationBatch, {
        orgId: args.orgId,
      });
      totalDeleted += result.deleted;
      blobFailures += await deleteBlobsBestEffort(result.storageKeys);

      if (result.done) {
        // Terminal purge record (ADR 001): the org's audit_log is gone, so the
        // durable trace of the purge is this function-log line.
        console.log(
          `PURGE COMPLETE org=${String(args.orgId)} deletedThisInvocation=${totalDeleted} blobFailures=${blobFailures} at=${new Date().toISOString()}`,
        );
        return { deleted: totalDeleted, done: true };
      }
    }

    console.log(
      `Purge org=${String(args.orgId)}: not drained after ${maxBatches} batches (deleted=${totalDeleted}); re-scheduling`,
    );
    await ctx.scheduler.runAfter(0, _purgeOrganization, { orgId: args.orgId });
    return { deleted: totalDeleted, done: false };
  },
});

/**
 * Retention sweep targets: for each org with retentionDays set, the terminal
 * runs started before the org's cutoff (bounded per org per sweep).
 */
export const listRetentionTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const orgs = await ctx.db.query("organizations").take(MAX_ORGS_PER_SWEEP);
    const targets: Array<{ orgId: Id<"organizations">; runId: Id<"runs"> }> = [];

    for (const org of orgs) {
      if (org.retentionDays === undefined || org.retentionDays <= 0) continue;
      const cutoff = Date.now() - org.retentionDays * 24 * 60 * 60 * 1000;
      let budget = MAX_RUNS_PER_ORG_PER_SWEEP;
      for (const status of TERMINAL_RUN_STATUSES) {
        if (budget <= 0) break;
        const runs = await ctx.db
          .query("runs")
          .withIndex("by_org_status_started", (q) =>
            q.eq("orgId", org._id).eq("status", status).lt("startedAt", cutoff),
          )
          .take(budget);
        for (const run of runs) {
          targets.push({ orgId: org._id, runId: run._id });
        }
        budget -= runs.length;
      }
    }
    return { targets };
  },
});

/**
 * Delete one batch of a single run's data (dependents first, run last).
 * Only ever invoked for runs already validated as terminal + out-of-window.
 */
export const purgeRunBatch = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args): Promise<BatchResult> => {
    const run = await ctx.db.get(args.runId);
    if (!run) return { deleted: 0, storageKeys: [], done: true };
    return await purgeRunSlice(ctx, args.runId, PURGE_BATCH_SIZE);
  },
});

/**
 * Daily retention enforcement (ADR 001). Deletes terminal runs (and their
 * events, artifacts, comments, verification results) older than the org's
 * opt-in retentionDays window. Orgs without retentionDays are never touched.
 */
export const enforceRetention = internalAction({
  args: {},
  handler: async (ctx) => {
    const { targets }: { targets: Array<{ orgId: string; runId: Id<"runs"> }> } =
      await ctx.runQuery(_listRetentionTargets, {});

    let runsPurged = 0;
    let docsDeleted = 0;
    let blobFailures = 0;
    let batches = 0;

    for (const target of targets) {
      let done = false;
      while (!done && batches < MAX_BATCHES_PER_INVOCATION) {
        const result: BatchResult = await ctx.runMutation(_purgeRunBatch, {
          runId: target.runId,
        });
        batches++;
        docsDeleted += result.deleted;
        blobFailures += await deleteBlobsBestEffort(result.storageKeys);
        done = result.done;
      }
      if (done) {
        runsPurged++;
      } else {
        console.log(
          "Retention: batch budget exhausted; remaining backlog drains next sweep",
        );
        break;
      }
    }

    console.log(
      `Retention sweep: targets=${targets.length} runsPurged=${runsPurged} docsDeleted=${docsDeleted} blobFailures=${blobFailures}`,
    );
    return { targets: targets.length, runsPurged, docsDeleted, blobFailures };
  },
});
