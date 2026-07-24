import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { recordAuditEvent } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { validateEvalRules } from "./helpers/agent_version_fields.js";
import { MAX_PAGE_SIZE } from "./helpers/pagination.js";

/**
 * Create a new version for an agent. Requires admin role.
 * Version strings must be unique per agent.
 */
export const createAgentVersion = mutation({
  args: {
    agentId: v.id("agents"),
    version: v.string(),
    changelog: v.optional(v.string()),
    configSnapshot: v.optional(v.any()),
    // Cycle 2 (docs/design/action_layer.md): optional eval auto-run rule set,
    // evaluated by Team B's insights.runEvalsForRun against every terminal
    // run created against this version. Bounded to
    // MAX_EVAL_RULES_PER_VERSION and shape-validated by validateEvalRules —
    // see convex/schema.ts for why this is stored as v.array(v.any()).
    evalRules: v.optional(v.array(v.any())),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Resolve and authorize the CALLER
    // before observing args.agentId. This is a WRITE path, so the collapse must
    // also precede the uniqueness scan below — otherwise a cross-org caller
    // could learn which version strings exist on another org's agent.
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "admin" });

    // Cross-org agent and nonexistent agent collapse to one outcome.
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.orgId !== orgId) throw new Error("Agent not found");

    const trimmedVersion = args.version.trim();
    if (!trimmedVersion) throw new Error("version is required");
    if (trimmedVersion.length > 64) {
      throw new Error("version must be 64 characters or fewer");
    }
    validateEvalRules(args.evalRules);

    // Uniqueness check within the agent
    const existing = await ctx.db
      .query("agent_versions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .collect();

    const duplicate = existing.find((v) => v.version === trimmedVersion);
    if (duplicate) {
      throw new Error(`Version "${trimmedVersion}" already exists for this agent`);
    }

    const id = await ctx.db.insert("agent_versions", {
      agentId: args.agentId,
      orgId: agent.orgId,
      version: trimmedVersion,
      createdAt: Date.now(),
      ...(args.changelog !== undefined && { changelog: args.changelog }),
      ...(args.configSnapshot !== undefined && {
        configSnapshot: args.configSnapshot,
      }),
      ...(args.evalRules !== undefined && { evalRules: args.evalRules }),
    });

    const doc = await ctx.db.get(id);
    if (!doc) throw new Error("Failed to create agent version");

    await recordAuditEvent(ctx, {
      orgId: agent.orgId,
      actorClerkUserId: userId,
      action: "agent_version.created",
      targetType: "agent_version",
      targetId: String(id),
      metadata: { agentId: String(args.agentId), version: trimmedVersion },
    });

    return doc;
  },
});

/**
 * List all versions for an agent, newest first.
 */
export const listAgentVersions = query({
  args: {
    agentId: v.id("agents"),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the agent is observed only afterwards.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    // Cross-org agent and nonexistent agent collapse to one outcome.
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.orgId !== orgId) throw new Error("Agent not found");

    // Bounded: at most MAX_PAGE_SIZE versions returned (no unbounded .collect()).
    const versions = await ctx.db
      .query("agent_versions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .take(MAX_PAGE_SIZE);

    // Defence in depth: a version stamped with a different org than its agent is
    // a data defect, not something to hand back across the boundary.
    return versions.filter((v) => v.orgId === orgId);
  },
});

/**
 * List agent versions with cursor-based pagination, newest first.
 * Default page size is 20 — agents rarely have more.
 */
export const paginateAgentVersions = query({
  args: {
    agentId: v.id("agents"),
    numItems: v.optional(v.number()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). Caller resolved and authorized first;
    // the agent is observed only afterwards.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    // Cross-org agent and nonexistent agent collapse to one outcome.
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.orgId !== orgId) throw new Error("Agent not found");

    const numItems = Math.min(args.numItems ?? 20, 100);
    const page = await ctx.db
      .query("agent_versions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .paginate({ numItems, cursor: args.cursor });

    return {
      // Defence in depth, as in listAgentVersions.
      versions: page.page.filter((v) => v.orgId === orgId),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Get a single agent version by ID. Verifies org membership.
 */
export const getAgentVersion = query({
  args: {
    versionId: v.id("agent_versions"),
  },
  handler: async (ctx, args) => {
    // TENANCY (CLAUDE.md Tenancy Rule 3). This previously returned null for a
    // missing version but THREW for a version owned by another org, which made
    // it an existence oracle. The caller is resolved from auth alone, before
    // args.versionId is observed; both cases now collapse to the same null.
    //
    // NOT swallowed: unauthenticated callers, callers with no org context, and
    // callers who are not members of their own active org still throw.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const version = await ctx.db.get(args.versionId);
    if (!version || version.orgId !== orgId) return null;

    return version;
  },
});
