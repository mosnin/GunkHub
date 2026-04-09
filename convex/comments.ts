import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth } from "./helpers";

/**
 * List comments for a run, optionally filtered to a specific event.
 */
export const listComments = query({
  args: {
    runId: v.id("runs"),
    eventId: v.optional(v.id("events")),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) return [];

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    if (args.eventId) {
      return await ctx.db
        .query("comments")
        .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
        .collect();
    }

    return await ctx.db
      .query("comments")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
  },
});

/**
 * Create a comment on a run or specific event.
 * Resolves the authorId from the authenticated user record.
 */
export const createComment = mutation({
  args: {
    runId: v.id("runs"),
    eventId: v.optional(v.id("events")),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const org = await ctx.db.get(run.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    // Resolve the user record from Clerk user ID
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", auth.clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User record not found. Ensure the user is synced.");
    }

    const now = Date.now();
    return await ctx.db.insert("comments", {
      orgId: run.orgId,
      runId: args.runId,
      eventId: args.eventId,
      authorId: user._id,
      content: args.content,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Update a comment's content. Only the original author may update their comment.
 */
export const updateComment = mutation({
  args: {
    commentId: v.id("comments"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const comment = await ctx.db.get(args.commentId);
    if (!comment) throw new Error("Comment not found");

    const org = await ctx.db.get(comment.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    // Verify the authenticated user is the author
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", auth.clerkUserId))
      .unique();

    if (!user || user._id !== comment.authorId) {
      throw new Error("Access denied: only the comment author can update this comment");
    }

    await ctx.db.patch(args.commentId, {
      content: args.content,
      updatedAt: Date.now(),
    });

    return args.commentId;
  },
});

/**
 * Delete a comment. Only the author or an org admin may delete a comment.
 */
export const deleteComment = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, args) => {
    const auth = await requireAuth(ctx);

    const comment = await ctx.db.get(args.commentId);
    if (!comment) throw new Error("Comment not found");

    const org = await ctx.db.get(comment.orgId);
    if (!org || org.clerkOrgId !== auth.orgId) {
      throw new Error("Access denied: resource belongs to a different organization");
    }

    // Resolve user and check role
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", auth.clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User record not found");
    }

    const isAuthor = user._id === comment.authorId;
    const isAdmin = user.role === "admin" || user.role === "owner";

    if (!isAuthor && !isAdmin) {
      throw new Error("Access denied: only the comment author or an org admin can delete this comment");
    }

    await ctx.db.delete(args.commentId);
  },
});
