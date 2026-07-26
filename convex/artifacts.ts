// Artifacts are immutable once created — payloads live in blob storage

import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_ARTIFACTS_PER_RUN,
  MAX_PAGE_SIZE,
} from "./helpers/pagination.js";
import { incrementUsageCounters } from "./usage.js";

/**
 * List artifacts associated with a run, bounded by `limit` (default
 * DEFAULT_PAGE_SIZE, capped at MAX_PAGE_SIZE). Return shape is unchanged — a plain
 * array of artifact docs — so existing consumers do not need to adapt; the only
 * behavioral change is that at most MAX_PAGE_SIZE rows are returned instead of an
 * unbounded `.collect()`.
 */
export const listArtifacts = query({
  args: {
    runId: v.id("runs"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the run is observed only afterwards, so a run in another org and a run
    // that does not exist are indistinguishable.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) {
      throw new Error("Run not found");
    }

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(limit);

    // Defence in depth: an artifact stamped with a different org than its run is
    // a data defect, not something to hand back across the boundary.
    return artifacts.filter((a) => a.orgId === orgId);
  },
});

/**
 * Look up a single artifact by its Convex ID, verifying org membership.
 */
export const getArtifact = query({
  args: {
    artifactId: v.id("artifacts"),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). This previously returned null for a
    // missing artifact but THREW for an artifact owned by another org, which
    // made it an existence oracle. The caller is now resolved from auth alone,
    // before args.artifactId is observed; both cases collapse to the same null.
    //
    // NOT swallowed: unauthenticated callers, callers with no org context, and
    // callers who are not members of their own active org still throw. A null
    // here means "no such artifact you may see", never "something went wrong".
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.orgId !== orgId) return null;
    return artifact;
  },
});

/**
 * Record an artifact that has already been uploaded to blob storage.
 * The caller provides the ArtifactPointer (storage coordinates) along with
 * run/event association metadata.
 */
export const createArtifact = mutation({
  args: {
    runId: v.id("runs"),
    eventId: v.optional(v.id("events")),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    storageKey: v.string(),
    storageBucket: v.string(),
    checksum: v.string(),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Resolve and authorize the CALLER
    // before observing args.runId. Recording an artifact is a write; a read-only
    // viewer must not be able to do it (P0 authorization gate — mirrors
    // createEvent), and that role gate is applied to the caller's OWN org so the
    // "Forbidden" it raises is runId-independent.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "member" });

    // Cross-org run and nonexistent run collapse to one outcome on one path,
    // before any artifact count or event lookup is performed.
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) {
      throw new Error("Run not found");
    }

    // Write ceiling: bounded count on the by_run index (cheap at this cap size).
    const existingForRun = await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .take(MAX_ARTIFACTS_PER_RUN);
    if (existingForRun.length >= MAX_ARTIFACTS_PER_RUN) {
      throw afrError(
        "ARTIFACT_LIMIT_EXCEEDED",
        `Run has reached the maximum of ${MAX_ARTIFACTS_PER_RUN} artifacts`,
      );
    }

    // If an eventId is provided verify it belongs to the same run
    if (args.eventId !== undefined) {
      const event = await ctx.db.get(args.eventId);
      if (!event || event.runId !== args.runId) {
        throw new Error("Event not found or does not belong to the given run");
      }
    }

    const artifactId = await ctx.db.insert("artifacts", {
      runId: args.runId,
      orgId: run.orgId,
      eventId: args.eventId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      storageKey: args.storageKey,
      storageBucket: args.storageBucket,
      checksum: args.checksum,
      createdAt: Date.now(),
    });

    await incrementUsageCounters(ctx, run.orgId, { artifactBytes: args.size });

    const artifact = await ctx.db.get(artifactId);
    if (!artifact) throw new Error("Failed to create artifact");
    return artifact;
  },
});
