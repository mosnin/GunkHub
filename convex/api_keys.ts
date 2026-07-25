// API key management — Clerk-authenticated only.
// Raw key material never enters Convex; callers hash with SHA-256 before calling.

import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { recordAuditEvent } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import {
  DEFAULT_RATE_LIMIT_PER_MIN,
  MAX_ENVIRONMENT_LENGTH,
  MAX_PAGE_SIZE,
} from "./helpers/pagination.js";

/**
 * Closed set of recognized API-key scopes (ADR-002). Additive/backward
 * compatible: a key created with `scopes` omitted (or empty) still has full
 * ingest access, per resolveApiKey in sdk_ingest.ts. "ingest:read" matches the
 * value already validated by the web layer's own ALLOWED_SCOPES
 * (apps/web/app/api/api-keys/route.ts); "read" is new — see ADR-002 — for a
 * future read-only, API-key-authenticated surface (no such surface is wired
 * up yet).
 */
export const API_KEY_SCOPES = [
  "ingest:write",
  "ingest:read",
  "read",
  // PRIVILEGED BUDGET SCOPES. Unlike every scope above, these are NEVER granted
  // by the `scopes: undefined` back-compat path — see requirePrivilegedScope in
  // convex/budget_gate.ts. They must be listed explicitly on a key, and they are
  // only half of the check: the key's CREATOR must also still hold the matching
  // org role. See that file's header for why both are required.
  //
  // Two scopes rather than one, because collapsing them would undo the
  // permission asymmetry: tripping WITHHOLDS and costs delay, resetting RESUMES
  // unbounded spend. A single "budget:write" scope would let anything that can
  // pull the cord also clear a proven breach.
  "budget:trip",
  "budget:reset",
] as const;

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
    // ADR-002: stamped onto every run this key creates (unless the caller
    // supplies its own `environment` on the ingest call).
    environment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });

    if (args.expiresAt !== undefined && args.expiresAt <= Date.now()) {
      throw new Error("expiresAt must be in the future");
    }
    if (args.rateLimitPerMin !== undefined && args.rateLimitPerMin <= 0) {
      throw afrError(
        "INVALID_ARGUMENT",
        "rateLimitPerMin must be a positive number",
      );
    }
    if (args.scopes !== undefined) {
      // AUDIT FIX (cycle 5, LOW): an empty `scopes` array is explicitly
      // rejected, not treated as "no scopes" or silently coerced into
      // unrestricted access. `scopes: undefined` means "full/back-compat
      // access" (see resolveApiKey in sdk_ingest.ts) and `scopes: [...]`
      // means "restricted to exactly these" — `scopes: []` is neither of
      // those and is ambiguous at best, a scopeless-but-still-usable key at
      // worst. The web layer's resolveRequestedScopes (apps/web/src/lib/
      // apiKeyScopes.ts) already rejects `[]` for the same reason; this
      // mirrors that behavior at the actual enforcement point so a caller
      // that mutates Convex directly (bypassing the Next.js route) cannot
      // mint a scopeless key by omitting the web layer's check.
      if (args.scopes.length === 0) {
        throw afrError(
          "INVALID_ARGUMENT",
          "scopes must not be empty (omit the field entirely for the default, full-access behavior)",
        );
      }
      const invalid = args.scopes.filter(
        (s) => !(API_KEY_SCOPES as readonly string[]).includes(s),
      );
      if (invalid.length > 0) {
        throw afrError(
          "INVALID_ARGUMENT",
          `Unknown API key scope(s): ${invalid.join(", ")}`,
        );
      }
    }
    if (
      args.environment !== undefined &&
      (args.environment.length === 0 || args.environment.length > MAX_ENVIRONMENT_LENGTH)
    ) {
      throw afrError(
        "INVALID_ARGUMENT",
        `environment must be 1-${MAX_ENVIRONMENT_LENGTH} characters`,
      );
    }

    // Default write ceiling: a key created without an explicit rate limit gets a
    // sane default instead of unlimited ingest. Explicit values still override.
    const rateLimitPerMin = args.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;

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
      rateLimitPerMin,
      rateWindowStart: undefined,
      rateWindowCount: undefined,
      environment: args.environment,
    });

    const key = await ctx.db.get(keyId);
    if (!key) throw new Error("Failed to create API key");

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "api_key.created",
      targetType: "api_key",
      targetId: String(keyId),
      metadata: {
        name: args.name,
        scopes: args.scopes,
        expiresAt: args.expiresAt,
        rateLimitPerMin,
      },
    });

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

    // Bounded: at most MAX_PAGE_SIZE keys returned (no unbounded .collect()).
    const keys = await ctx.db
      .query("api_keys")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_PAGE_SIZE);

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
        environment: k.environment,
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
    // TENANCY (CLAUDE.md Tenancy Rule 3). Resolve and authorize the CALLER
    // before observing args.keyId — this is a privileged WRITE path. The admin
    // gate is applied to the caller's OWN org, so its "Forbidden" is
    // keyId-independent and cannot be used to probe for other orgs' key IDs.
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "admin" });

    // Cross-org key and nonexistent key collapse to one outcome. The
    // "already revoked" check below is reachable only for a key the caller can
    // see, so it cannot leak another org's key state either.
    const key = await ctx.db.get(args.keyId);
    if (!key || key.orgId !== orgId) {
      throw new Error("API key not found");
    }

    if (key.revokedAt !== undefined) {
      throw new Error("API key is already revoked");
    }

    await ctx.db.patch(args.keyId, { revokedAt: Date.now() });

    await recordAuditEvent(ctx, {
      orgId: key.orgId,
      actorClerkUserId: userId,
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: String(args.keyId),
      metadata: { name: key.name },
    });

    return await ctx.db.get(args.keyId);
  },
});
