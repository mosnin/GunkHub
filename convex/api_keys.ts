// API key management — Clerk-authenticated only.
// Raw key material never enters Convex; callers hash with SHA-256 before calling.

import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { getAuthContext, requireOrgMembership } from "./auth.js";

/**
 * Create a new API key record for an organization.
 * The raw key is never stored — only the SHA-256 hex hash provided by the caller.
 */
export const createApiKey = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    keyHash: v.string(),
    // Optional enterprise controls. expiresAt: epoch ms after which the key is
    // rejected. scopes: allowed operations (e.g. ["ingest:write"]); omit for full.
    // rateLimitPerMin: max events/min accepted for this key (omit = unlimited).
    expiresAt: v.optional(v.number()),
    scopes: v.optional(v.array(v.string())),
    rateLimitPerMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });

    if (args.expiresAt !== undefined && args.expiresAt <= Date.now()) {
      throw new Error("expiresAt must be in the future");
    }
    if (args.rateLimitPerMin !== undefined && args.rateLimitPerMin <= 0) {
      throw new Error("rateLimitPerMin must be a positive number");
    }

    const now = Date.now();
    const keyId = await ctx.db.insert("api_keys", {
      orgId: args.orgId,
      keyHash: args.keyHash,
      name: args.name,
      createdBy: userId,
      createdAt: now,
      lastUsedAt: undefined,
      revokedAt: undefined,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      rateLimitPerMin: args.rateLimitPerMin,
      rateWindowStart: undefined,
      rateWindowCount: undefined,
    });

    const key = await ctx.db.get(keyId);
    if (!key) throw new Error("Failed to create API key");
    return key;
  },
});

/**
 * List all non-revoked API keys for an organization.
 */
export const listApiKeys = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    const keys = await ctx.db
      .query("api_keys")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    // Filter out revoked keys — revokedAt is set when a key is revoked.
    // SECURITY: never return keyHash. sdk_ingest authenticates on possession of
    // keyHash, so exposing it here would let any org member (including a viewer)
    // impersonate the SDK and write to the immutable event log. Return only the
    // non-secret metadata the settings UI needs.
    return keys
      .filter((k) => k.revokedAt === undefined)
      .map((k) => ({
        _id: k._id,
        _creationTime: k._creationTime,
        orgId: k.orgId,
        name: k.name,
        createdBy: k.createdBy,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        expiresAt: k.expiresAt,
        scopes: k.scopes,
        rateLimitPerMin: k.rateLimitPerMin,
      }));
  },
});

/**
 * Revoke an API key by setting its revokedAt timestamp.
 * Revoked keys are rejected by sdk_ingest mutations immediately.
 */
export const revokeApiKey = mutation({
  args: {
    keyId: v.id("api_keys"),
  },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    if (!key) {
      throw new Error("API key not found");
    }

    await requireOrgMembership(ctx, key.orgId, { minimumRole: "admin" });

    if (key.revokedAt !== undefined) {
      throw new Error("API key is already revoked");
    }

    await ctx.db.patch(args.keyId, { revokedAt: Date.now() });

    return await ctx.db.get(args.keyId);
  },
});
