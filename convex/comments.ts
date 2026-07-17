import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./helpers/pagination.js";

import type { Id } from "./_generated/dataModel.js";

/**
 * List comments on a given target (run or event), bounded by `limit` (default
 * DEFAULT_PAGE_SIZE, capped at MAX_PAGE_SIZE). Return shape is unchanged — a plain
 * array of comment docs — so existing consumers do not need to adapt; the only
 * behavioral change is that at most MAX_PAGE_SIZE rows are returned instead of an
 * unbounded `.collect()`.
 */
export const listComments = query({
  args: {
    orgId: v.id("organizations"),
    targetId: v.string(),
    targetType: v.union(v.literal("run"), v.literal("event")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_target", (q) =>
        q.eq("targetId", args.targetId).eq("targetType", args.targetType),
      )
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .take(limit);

    return comments;
  },
});

/**
 * Create a comment on a run or event. The author is derived from the
 * authenticated session — callers cannot spoof authorId.
 */
export const createComment = mutation({
  args: {
    orgId: v.id("organizations"),
    targetId: v.string(),
    targetType: v.union(v.literal("run"), v.literal("event")),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await getAuthContext(ctx);
    // Authoring a comment is a write; a read-only viewer must not be able to do it.
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "member" });

    // TENANCY: confirm the comment target (run/event) actually belongs to the
    // caller's org. Without this, a member could stamp a comment with their own
    // orgId that references another org's run/event id, weakening referential
    // tenancy integrity (mirrors the ownership checks in createRun/sdkCreateArtifact).
    if (args.targetType === "run") {
      const run = await ctx.db.get(args.targetId as Id<"runs">);
      if (!run || run.orgId !== args.orgId) {
        throw new Error("Comment target run not found in this organization");
      }
    } else {
      const event = await ctx.db.get(args.targetId as Id<"events">);
      if (!event || event.orgId !== args.orgId) {
        throw new Error("Comment target event not found in this organization");
      }
    }

    const now = Date.now();
    const commentId = await ctx.db.insert("comments", {
      orgId: args.orgId,
      targetId: args.targetId,
      targetType: args.targetType,
      authorId: userId,
      content: args.content,
      createdAt: now,
      updatedAt: undefined,
      resolvedAt: undefined,
      resolvedBy: undefined,
    });

    const comment = await ctx.db.get(commentId);
    if (!comment) throw new Error("Failed to create comment");
    return comment;
  },
});

/**
 * Mark a comment as resolved. Records the timestamp and the userId who
 * performed the resolution.
 */
export const resolveComment = mutation({
  args: {
    commentId: v.id("comments"),
  },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.commentId);
    if (!comment) {
      throw new Error("Comment not found");
    }

    const { userId } = await getAuthContext(ctx);
    // Resolving a comment mutates it; a read-only viewer must not be able to do it.
    await requireOrgMembership(ctx, comment.orgId, { minimumRole: "member" });

    if (comment.resolvedAt !== undefined) {
      throw new Error("Comment is already resolved");
    }

    const now = Date.now();
    await ctx.db.patch(args.commentId, {
      resolvedAt: now,
      resolvedBy: userId,
      updatedAt: now,
    });

    return await ctx.db.get(args.commentId);
  },
});
