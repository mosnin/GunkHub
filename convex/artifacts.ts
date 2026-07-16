// Artifacts are immutable once created — payloads live in blob storage

import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { requireOrgMembership } from "./auth.js";

/**
 * List all artifacts associated with a run.
 */
export const listArtifacts = query({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      throw new Error("Run not found");
    }
    await requireOrgMembership(ctx, run.orgId);

    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();

    return artifacts;
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
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) return null;
    await requireOrgMembership(ctx, artifact.orgId);
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
    const run = await ctx.db.get(args.runId);
    if (!run) {
      throw new Error("Run not found");
    }
    await requireOrgMembership(ctx, run.orgId);

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

    const artifact = await ctx.db.get(artifactId);
    if (!artifact) throw new Error("Failed to create artifact");
    return artifact;
  },
});
