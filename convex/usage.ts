// ADR-002 — approximate per-org usage metering. Incremented from every
// ingest path (both the API-key path in sdk_ingest.ts and the Clerk-path
// equivalents in runs.ts/events.ts/artifacts.ts). This module intentionally
// has NO dependency on auth.ts beyond the two public read queries below, so
// sdk_ingest.ts (which must not import auth.ts) can import incrementUsageCounters
// freely — same pattern as helpers/run_fields.ts.

import { v } from "convex/values";

import { query } from "./_generated/server.js";
import { requireOrgMembership } from "./auth.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, USAGE_FLUSH_STRIDE } from "./helpers/pagination.js";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

/** "YYYY-MM-DD" in UTC — the usage_counters partition key. */
export function currentUsageDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface UsageDelta {
  runsStarted?: number;
  eventsIngested?: number;
  bytesIngested?: number;
  artifactBytes?: number;
}

/**
 * Increment today's usage_counters row for an org, creating it if absent.
 *
 * Contention mitigation mirrors sdk_ingest.ts's enforceRateLimit: a BATCH
 * call (runsStarted + eventsIngested > 1, e.g. a multi-event sdkCreateEvents
 * call) always flushes exactly — the patch is already amortized over the
 * batch. A SINGLE-UNIT call (one run, one event) flushes only ~1-in-STRIDE
 * times, scaled up by STRIDE when it does, so a busy org's ingest calls don't
 * all serialize on one usage-counter document. This makes the counter
 * approximate by design (see ADR-002) — it is observability/billing
 * groundwork, not an exact audit trail.
 */
export async function incrementUsageCounters(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  delta: UsageDelta,
): Promise<void> {
  const units = (delta.runsStarted ?? 0) + (delta.eventsIngested ?? 0);
  const isBatch = units > 1;
  const day = currentUsageDay();

  const existing = await ctx.db
    .query("usage_counters")
    .withIndex("by_org_day", (q) => q.eq("orgId", orgId).eq("day", day))
    .unique();

  if (!existing) {
    await ctx.db.insert("usage_counters", {
      orgId,
      day,
      runsStarted: delta.runsStarted ?? 0,
      eventsIngested: delta.eventsIngested ?? 0,
      bytesIngested: delta.bytesIngested ?? 0,
      artifactBytes: delta.artifactBytes ?? 0,
    });
    return;
  }

  if (isBatch || Math.random() < 1 / USAGE_FLUSH_STRIDE) {
    const stride = isBatch ? 1 : USAGE_FLUSH_STRIDE;
    await ctx.db.patch(existing._id, {
      runsStarted: existing.runsStarted + (delta.runsStarted ?? 0) * stride,
      eventsIngested: existing.eventsIngested + (delta.eventsIngested ?? 0) * stride,
      bytesIngested: existing.bytesIngested + (delta.bytesIngested ?? 0) * stride,
      artifactBytes: existing.artifactBytes + (delta.artifactBytes ?? 0) * stride,
    });
  }
}

/** Org-scoped read of a single day's usage counters (or null if none recorded). */
export const getUsageForDay = query({
  args: { orgId: v.id("organizations"), day: v.string() },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    const row = await ctx.db
      .query("usage_counters")
      .withIndex("by_org_day", (q) => q.eq("orgId", args.orgId).eq("day", args.day))
      .unique();
    return row ?? null;
  },
});

/** Most recent usage_counters rows for an org, newest first, bounded. */
export const listRecentUsage = query({
  args: { orgId: v.id("organizations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return await ctx.db
      .query("usage_counters")
      .withIndex("by_org_day", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(limit);
  },
});
