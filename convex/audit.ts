// Admin audit trail (append-only, per ADR 001 note in schema.ts).
//
// Every privileged mutation calls recordAuditEvent so an org admin can answer
// "who did what, when" for configuration and lifecycle changes. Like the events
// table, audit_log has NO update or delete mutations — the only sanctioned
// removal is the whole-org cascade purge (ADR 001, convex/retention.ts).

import { v } from "convex/values";

import { query } from "./_generated/server.js";
import { requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./helpers/pagination.js";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

/**
 * Closed set of audited action names. Add here (and call recordAuditEvent at
 * the mutation site) when introducing a new privileged mutation.
 */
export const AUDIT_ACTIONS = [
  "api_key.created",
  "api_key.revoked",
  "run.status_updated",
  "run.tags_updated",
  "project.created",
  "project.updated",
  "agent.created",
  "agent_version.created",
  "membership.upserted",
  "membership.removed",
  "org.deletion_requested",
  "org.retention_updated",
  // ADR-002 — data model expansion.
  "run.triage_updated",
  "run.labels_updated",
  "alert_rule.created",
  "alert_rule.updated",
  "alert_rule.deleted",
  "webhook.created",
  "webhook.deleted",
  // ADR-004 — run explanations.
  "run_explanation.regenerated",
  // ADR-005 Cycle 3 — failure pattern muting.
  "failure_pattern.muted",
  "failure_pattern.unmuted",
  // ADR-006 — failure pattern resolution lifecycle.
  "failure_pattern.acknowledged",
  "failure_pattern.resolved",
  "failure_pattern.reopened",
  // ADR-006 Cycle 2 — the regression guard's AUTOMATIC reopen. Distinct from
  // "failure_pattern.reopened" (a human deliberately reopening): this one is
  // written by recordFailurePatternOccurrence with SYSTEM_ACTOR, and is what
  // makes the lifecycle transition history reconstructible end-to-end from
  // the append-only audit log alone — no mutable per-pattern history table.
  "failure_pattern.regressed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const AUDIT_ACTION_SET = new Set<string>(AUDIT_ACTIONS);

/** Actor recorded for changes applied by the Clerk webhook (no human session). */
export const WEBHOOK_ACTOR = "clerk-webhook";

/**
 * Actor recorded for transitions the backend applies on its own — no human
 * and no external webhook, e.g. ADR-006's regression guard auto-reopening a
 * resolved failure pattern. Reads as a distinct actor so an admin scanning
 * the audit log can tell "the system did this" apart from "a person did this"
 * without parsing the action name.
 */
export const SYSTEM_ACTOR = "system";

/**
 * Append one audit row. Called from privileged mutations AFTER their own auth
 * checks have passed — this helper performs no authorization of its own.
 * Insert-only by construction: there is no corresponding update/delete.
 */
export async function recordAuditEvent(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    actorClerkUserId: string;
    action: AuditAction;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  // Defense in depth: the closed set is enforced at runtime too, so a future
  // call site cannot invent an unvocabularied action string via a cast.
  if (!AUDIT_ACTION_SET.has(entry.action)) {
    throw afrError("INVALID_ARGUMENT", `Unknown audit action "${entry.action}"`);
  }
  await ctx.db.insert("audit_log", {
    orgId: entry.orgId,
    actorClerkUserId: entry.actorClerkUserId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    timestamp: Date.now(),
    ...(entry.metadata !== undefined && { metadata: entry.metadata }),
  });
}

/**
 * List the org's audit log, newest first, paginated and bounded. Admin-only:
 * the audit trail exposes who-did-what across the org and is not for viewers
 * or members.
 */
export const listAuditLog = query({
  args: {
    orgId: v.id("organizations"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const page = await ctx.db
      .query("audit_log")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });

    return {
      entries: page.page,
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
  },
});
