import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth } from "./helpers";

// Blob storage: storageKey is an opaque string (e.g., Vercel Blob URL). The actual blob is stored externally. This record is just the pointer and metadata.

/**
 * Create an artifact record after a blob has been uploaded externally.
 * The storageKey is an opaque pointer to the blob location (e.g., Vercel Blob URL).
 */
export const createArtifact = mutation({
  args: {
    runId: v.id("runs"),
    eventId: v.optional(v.id("events")),
    storageKey: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    checksum: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return await ctx.db.insert("artifacts", {
      orgId: run.orgId,
      runId: args.runId,
      eventId: args.eventId,
      storageKey: args.storageKey,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      checksum: args.checksum,
      createdAt: Date.now(),
    });
  },
});

/**
 * Get an artifact by id. Verifies org ownership.
 */
export const getArtifact = query({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) return null;

    const org = await ctx.db.get(artifact.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return artifact;
  },
});

/**
 * List all artifacts for a run.
 */
export const listArtifactsForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) return [];

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    return await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
  },
});
