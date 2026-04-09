import { query, mutation } from "convex/server";
import { v } from "convex/values";
import { getAuthContext, requireOrgMembership } from "./auth.js";

/**
 * List all comments on a given target (run or event).
 */
export const listComments = query({
  args: {
    targetId: v.string(),
    targetType: v.union(v.literal("run"), v.literal("event")),
  },
  handler: async (ctx, args) => {
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_target", (q) =>
        q.eq("targetId", args.targetId).eq("targetType", args.targetType),
      )
      .collect();

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
    await requireOrgMembership(ctx, args.orgId);

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
    await requireOrgMembership(ctx, comment.orgId);

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
