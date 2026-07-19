// ADR-002 — evals. APPEND-ONLY, like events/audit_log: there is no
// updateEval or deleteEval. An eval is a recorded observation about a run
// (a rule check, an LLM-judge verdict, a manual reviewer call) and must not
// be quietly edited after the fact.

import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { validateEvalFields } from "./helpers/eval_fields.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./helpers/pagination.js";

const EVAL_KIND = v.union(v.literal("rule"), v.literal("llm_judge"), v.literal("manual"));

/**
 * Record an eval against a run. Member-gated (Clerk auth). For automated eval
 * pipelines authenticating via API key, see sdkRecordEval in sdk_ingest.ts.
 */
export const recordEval = mutation({
  args: {
    runId: v.id("runs"),
    agentVersionId: v.optional(v.id("agent_versions")),
    name: v.string(),
    kind: EVAL_KIND,
    passed: v.boolean(),
    score: v.optional(v.number()),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, run.orgId, { minimumRole: "member" });

    validateEvalFields(args);

    if (args.agentVersionId !== undefined) {
      const version = await ctx.db.get(args.agentVersionId);
      if (!version || version.orgId !== run.orgId) {
        throw new Error("Agent version not found in this organization");
      }
    }

    const evalId = await ctx.db.insert("evals", {
      orgId: run.orgId,
      runId: args.runId,
      agentVersionId: args.agentVersionId,
      name: args.name,
      kind: args.kind,
      passed: args.passed,
      score: args.score,
      details: args.details,
      createdAt: Date.now(),
      createdBy: userId,
    });

    const created = await ctx.db.get(evalId);
    if (!created) throw new Error("Failed to record eval");
    return created;
  },
});

/** All evals recorded against a run, newest first, bounded. */
export const listEvalsForRun = query({
  args: { runId: v.id("runs"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    await requireOrgMembership(ctx, run.orgId);

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return await ctx.db
      .query("evals")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(limit);
  },
});

/** Evals across an org filtered by name (e.g. a specific eval suite), newest first. */
export const listEvalsByName = query({
  args: { orgId: v.id("organizations"), name: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return await ctx.db
      .query("evals")
      .withIndex("by_org_name", (q) => q.eq("orgId", args.orgId).eq("name", args.name))
      .order("desc")
      .take(limit);
  },
});

/** Evals across an org for a specific agent version, newest first. */
export const listEvalsByAgentVersion = query({
  args: { orgId: v.id("organizations"), agentVersionId: v.id("agent_versions"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return await ctx.db
      .query("evals")
      .withIndex("by_org_version", (q) => q.eq("orgId", args.orgId).eq("agentVersionId", args.agentVersionId))
      .order("desc")
      .take(limit);
  },
});
