// ---------------------------------------------------------------------------
// BUDGET CIRCUIT BREAKERS — the API-key-authenticated gate.
//
// Authentication here is via pre-hashed API key ONLY. Do NOT call
// getAuthContext or requireOrgMembership in this file — those require a Clerk
// JWT. Same rule, and the same reason for a separate module, as
// convex/sdk_ingest.ts: mixing the two auth models in one file is how a future
// edit reaches for the wrong one.
//
// It returns the contract's `BreakerSnapshot` and NOTHING ELSE — no decision, no
// allow/deny. THE DECISION IS THE SDK'S, and deliberately so: the contract's
// `decideBudget` runs client-side because only the caller knows its own
// `BudgetUnavailablePolicy` (deny / grace / allow, each with a required
// `acceptedRisk`). A backend that returned "proceed" would be making a risk
// decision on behalf of a customer whose risk it does not know, and would also
// give a compromised deployment a single field to flip.
//
// Three properties this surface owes the caller:
//
//   IT IS A QUERY, cheap enough to ask once per shelf life. The contract's
//   design is one round trip per `freshUntil`, not one per model call — the SDK
//   holds the snapshot and `BudgetGuard.check()` is synchronous and does no I/O.
//   Breaker state is computed fresh on every call, so there is no cached answer
//   that can outlive the runs it came from.
//
//   IT REQUIRES `ingest:write`, NOT `read`. This is a PRE-WRITE check and is
//   semantically part of the write path the key already holds. Requiring `read`
//   would deny every existing key scoped exactly `["ingest:write"]` — the
//   overwhelmingly common SDK key — turning a new advisory surface into a
//   breaking change for every deployed recorder.
//
//   IT DOES NOT CONSUME THE KEY'S INGEST RATE BUDGET and does not stamp
//   `lastUsedAt`. A caller must never be discouraged from asking, and must never
//   be able to exhaust its own ingest allowance by checking whether it may
//   ingest.
// ---------------------------------------------------------------------------

import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";
import { applyReset, applyTrip, snapshotForSubject, type BudgetMutationOutcome } from "./budgets.js";
import { MAX_BUDGET_NOTE_LENGTH } from "./helpers/budget.js";
import { afrError } from "./helpers/errors.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

/**
 * Scope required. See the header: a pre-write check belongs to the write path.
 * Mirrors sdk_ingest.ts's constant of the same value rather than importing it,
 * because importing that module here would pull its whole mutation surface into
 * this module's dependency graph for one string.
 */
const INGEST_WRITE = "ingest:write";

/**
 * Read-only API key resolution.
 *
 * The same credential checks as `sdk_ingest.ts`'s `resolveApiKey` — existence,
 * revocation, expiry, scope — MINUS the `lastUsedAt` patch, because this is a
 * query and a query cannot write. Deliberately duplicated rather than shared:
 * `resolveApiKey` takes a `MutationCtx` precisely so its throttled write is
 * type-checked, and loosening that signature to `QueryCtx` to reuse it here
 * would remove the guarantee on the ingest path, which matters more.
 * `checkIngestAuth` in sdk_ingest.ts already makes the same trade for the same
 * reason.
 */
async function resolveApiKeyForRead(
  ctx: QueryCtx,
  apiKeyHash: string,
  requiredScope: string,
): Promise<Doc<"api_keys">> {
  const apiKey = await ctx.db
    .query("api_keys")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", apiKeyHash))
    .unique();

  if (!apiKey || apiKey.revokedAt !== undefined) {
    throw new Error("Unauthorized");
  }
  if (apiKey.expiresAt !== undefined && apiKey.expiresAt <= Date.now()) {
    throw new Error("Unauthorized: API key has expired");
  }
  if (
    apiKey.scopes !== undefined &&
    apiKey.scopes.length > 0 &&
    !apiKey.scopes.includes(requiredScope)
  ) {
    throw new Error(`Forbidden: API key lacks required scope "${requiredScope}"`);
  }
  return apiKey;
}

/**
 * The breaker snapshot governing an SDK caller.
 *
 * ORG SCOPE COMES FROM THE KEY AND FROM NOWHERE ELSE. There is no `orgId`
 * argument: the caller cannot name an organization, so it cannot name someone
 * else's. `runId` / `agentId` / `projectId` only NARROW the governing set within
 * the key's own org, and each is re-checked to belong to it — a foreign or
 * missing id yields the identical NOT_FOUND, so this surface is not an existence
 * oracle for another org's records.
 */
export const sdkCheckBudget = query({
  args: {
    apiKeyHash: v.string(),
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    agentVersionId: v.optional(v.id("agent_versions")),
    /** Convenience: also contributes the run's project / agent / version. */
    runId: v.optional(v.id("runs")),
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveApiKeyForRead(ctx, args.apiKeyHash, INGEST_WRITE);
    const orgId = apiKey.orgId;

    let projectId: Id<"projects"> | undefined = args.projectId;
    let agentId: Id<"agents"> | undefined = args.agentId;
    let agentVersionId: Id<"agent_versions"> | undefined = args.agentVersionId;

    if (args.runId !== undefined) {
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== orgId) throw afrError("NOT_FOUND", "Subject not found");
      projectId = projectId ?? run.projectId;
      agentId = agentId ?? run.agentId;
      agentVersionId = agentVersionId ?? run.agentVersionId;
    }
    for (const id of [args.projectId, args.agentId, args.agentVersionId]) {
      if (id === undefined) continue;
      const doc = await ctx.db.get(id);
      if (!doc || (doc as { orgId?: Id<"organizations"> }).orgId !== orgId) {
        throw afrError("NOT_FOUND", "Subject not found");
      }
    }

    return await snapshotForSubject(
      ctx,
      orgId,
      {
        ...(projectId !== undefined ? { projectId } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(agentVersionId !== undefined ? { agentVersionId } : {}),
        ...(args.runId !== undefined ? { runId: args.runId } : {}),
      },
      Date.now(),
    );
  },
});

// ===========================================================================
// PRIVILEGED, KEY-AUTHENTICATED MUTATIONS
//
// THE PROBLEM TEAM C CORRECTLY REFUSED TO SOLVE IN THE WEB TIER: an API key
// carries no role. The scope vocabulary (`ingest:write` / `ingest:read` /
// `read`) says what a key may DO, never who stands behind it, so an admin check
// written in `apps/web` would be evaluated where the facts are absent. The
// resolution has to live here, next to `user_memberships`.
//
// TWO CONDITIONS, ANDed. Neither alone is sound:
//
//   AN EXPLICIT PRIVILEGED SCOPE (`budget:trip` / `budget:reset`) is the
//     OPT-IN. Without it, resolving the creator's role alone would silently
//     escalate EVERY KEY EVER CREATED BY AN ADMIN into a key that can clear a
//     proven breach — a privilege nobody granted, appearing the moment this
//     code shipped, on credentials already deployed in production.
//
//   THE CREATOR'S LIVE ORG ROLE is the AUTHORITY. Without it, a scope is a
//     static grant that never revokes: demote someone, or remove them from the
//     org, and their keys keep their standing forever. Resolving the role at
//     use time means removing a person's admin removes their keys' reset power,
//     with no key rotation and nothing to remember.
//
// So: the scope says this key was meant for this, and the membership says the
// person behind it still has the standing. Both, every time.
//
// THE BACK-COMPAT HOLE, CLOSED DELIBERATELY. `resolveApiKey` treats
// `scopes: undefined` as full access, which is correct for ingest and would be
// catastrophic here — every legacy key would hold `budget:reset` implicitly.
// {@link requirePrivilegedScope} therefore requires an EXPLICIT, non-empty
// `scopes` array containing the scope, and never consults the back-compat path.
//
// THE PERMISSION ASYMMETRY IS PRESERVED. Trip needs `budget:trip` + member;
// reset needs `budget:reset` + admin. Tripping withholds and costs delay;
// resetting resumes unbounded spend. A single collapsed scope would undo that
// reasoning, which is why there are two.
// ===========================================================================

const ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2 };

/**
 * Require an EXPLICITLY-GRANTED scope.
 *
 * Deliberately NOT `resolveApiKeyForRead`'s check: that one honours the
 * `scopes: undefined` back-compat grant. A privileged scope is never implicit.
 */
function requirePrivilegedScope(apiKey: Doc<"api_keys">, scope: string): void {
  const scopes = apiKey.scopes;
  if (scopes === undefined || scopes.length === 0 || !scopes.includes(scope)) {
    throw afrError(
      "FORBIDDEN",
      `API key lacks the explicitly-granted "${scope}" scope. Privileged budget scopes are never implied by an unscoped key.`,
    );
  }
}

/**
 * Resolve the key's creator to a LIVE org membership meeting `minimumRole`.
 *
 * The key acts AS ITS CREATOR and can never exceed them. A key whose creator has
 * left the org, or been demoted below the minimum, stops being able to do this —
 * which is the property a static scope cannot provide.
 *
 * The failure is deliberately NOT distinguishable between "creator is not a
 * member" and "creator's role is too low": both mean this key may not do this,
 * and splitting them would let a key holder probe another person's role.
 */
async function requireCreatorRole(
  ctx: MutationCtx,
  apiKey: Doc<"api_keys">,
  minimumRole: "member" | "admin",
): Promise<string> {
  const membership = await ctx.db
    .query("user_memberships")
    .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", apiKey.createdBy))
    .filter((q) => q.eq(q.field("orgId"), apiKey.orgId))
    .unique();

  const rank = membership === null ? -1 : (ROLE_RANK[membership.role] ?? -1);
  if (rank < (ROLE_RANK[minimumRole] ?? 0)) {
    throw afrError(
      "FORBIDDEN",
      `This action requires the "${minimumRole}" role or higher. An API key acts as the user who created it, and that user does not currently hold it in this organization.`,
    );
  }
  return apiKey.createdBy;
}

/** Mutation-context key resolution. Mirrors resolveApiKeyForRead minus nothing but the ctx type. */
async function resolveApiKeyForWrite(
  ctx: MutationCtx,
  apiKeyHash: string,
): Promise<Doc<"api_keys">> {
  const apiKey = await ctx.db
    .query("api_keys")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", apiKeyHash))
    .unique();
  if (!apiKey || apiKey.revokedAt !== undefined) throw new Error("Unauthorized");
  if (apiKey.expiresAt !== undefined && apiKey.expiresAt <= Date.now()) {
    throw new Error("Unauthorized: API key has expired");
  }
  return apiKey;
}

/** REQUIRED, non-empty. Matches the contract's ManualTripRequest/ManualResetRequest. */
function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw afrError("INVALID_ARGUMENT", "reason is required and must not be empty");
  }
  if (trimmed.length > MAX_BUDGET_NOTE_LENGTH) {
    throw afrError("INVALID_ARGUMENT", `reason must be at most ${MAX_BUDGET_NOTE_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * Load a budget in the KEY'S OWN org, or fail exactly as if it did not exist.
 *
 * Same tenancy posture as the Clerk path's `loadOwnBudget`: the org comes from
 * the credential, never from the caller, so "another org's budget" and "no such
 * budget" are one indistinguishable outcome.
 */
async function loadKeyBudget(
  ctx: MutationCtx,
  apiKey: Doc<"api_keys">,
  budgetId: Id<"budget_breakers">,
): Promise<Doc<"budget_breakers">> {
  const budget = await ctx.db.get(budgetId);
  if (!budget || budget.orgId !== apiKey.orgId) {
    throw afrError("NOT_FOUND", "Budget not found");
  }
  return budget;
}

/**
 * Trip a budget from an SDK/CLI caller. Requires `budget:trip` + creator role
 * member-or-higher.
 *
 * Returns the contract's `BudgetMutationResult`, including the `auditLogId`
 * receipt — the id an operator cites in the incident ticket.
 */
export const sdkTripBudget = mutation({
  args: {
    apiKeyHash: v.string(),
    budgetId: v.id("budget_breakers"),
    /** REQUIRED, non-empty. Written verbatim to the admin audit log. */
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<BudgetMutationOutcome> => {
    const apiKey = await resolveApiKeyForWrite(ctx, args.apiKeyHash);
    requirePrivilegedScope(apiKey, "budget:trip");
    const actorId = await requireCreatorRole(ctx, apiKey, "member");
    const budget = await loadKeyBudget(ctx, apiKey, args.budgetId);
    return await applyTrip(ctx, budget, actorId, requireReason(args.reason), "api_key");
  },
});

/**
 * Reset a tripped budget from an SDK/CLI caller. Requires `budget:reset` +
 * creator role ADMIN.
 *
 * The stricter of the pair, deliberately: this is the direction that resumes
 * unbounded spend.
 */
export const sdkResetBudget = mutation({
  args: {
    apiKeyHash: v.string(),
    budgetId: v.id("budget_breakers"),
    /** REQUIRED, non-empty. Written verbatim to the admin audit log. */
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<BudgetMutationOutcome> => {
    const apiKey = await resolveApiKeyForWrite(ctx, args.apiKeyHash);
    requirePrivilegedScope(apiKey, "budget:reset");
    const actorId = await requireCreatorRole(ctx, apiKey, "admin");
    const budget = await loadKeyBudget(ctx, apiKey, args.budgetId);
    return await applyReset(ctx, budget, actorId, requireReason(args.reason), "api_key");
  },
});
