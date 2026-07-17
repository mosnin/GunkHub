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
 * run-targeted comments → verification_results → artifacts → events (plus any
 * event-targeted comments) → finally the run document itself.
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
  //    Event-targeted comments are removed alongside each event.
  if (remaining() > 0) {
    const want = remaining();
    const events = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(want);
    for (const e of events) {
      const eventComments = await ctx.db
        .query("comments")
        .withIndex("by_target", (q) =>
          q.eq("targetId", e._id as string).eq("targetType", "event"),
        )
        .collect();
      for (const c of eventComments) {
        await ctx.db.delete(c._id);
        deleted++;
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
 * Order: org-level comments → org verification_results → runs (each fully via
 * purgeRunSlice) → agent_versions → agents → projects → api_keys →
 * memberships → audit_log (LAST — see ADR 001) → the organization record.
 */
export const purgeOrganizationBatch = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<BatchResult> => {
    const budget = PURGE_BATCH_SIZE;
    let deleted = 0;
    const storageKeys: string[] = [];
    const remaining = (): number => budget - deleted;

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

    // 6. API keys.
    const keys = await ctx.db
      .query("api_keys")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const k of keys) {
      await ctx.db.delete(k._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 7. Memberships.
    const memberships = await ctx.db
      .query("user_memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(remaining());
    for (const m of memberships) {
      await ctx.db.delete(m._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted, storageKeys, done: false };

    // 8. Audit log — deleted LAST so the trail survives as long as possible.
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

    // 9. The organization record itself.
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
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<{ deleted: number; done: boolean }> => {
    let totalDeleted = 0;
    let blobFailures = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_INVOCATION; batch++) {
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
      `Purge org=${String(args.orgId)}: not drained after ${MAX_BATCHES_PER_INVOCATION} batches (deleted=${totalDeleted}); re-scheduling`,
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
