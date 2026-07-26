// ---------------------------------------------------------------------------
// DECLARATIVE POLICY — the API-key-authenticated PRE-FLIGHT surface.
//
// Authentication here is via pre-hashed API key ONLY. Do NOT call
// getAuthContext or requireOrgMembership in this file — those require a Clerk
// JWT. Same rule, and the same reason for a separate module, as
// convex/budget_gate.ts and convex/sdk_ingest.ts: mixing the two auth models in
// one file is how a future edit reaches for the wrong one.
//
// ===========================================================================
// IT RETURNS DEFINITIONS. IT NEVER RETURNS A VERDICT.
// ===========================================================================
//
// There is no `allowed` boolean in the response and there is not going to be
// one. Three reasons, and the third is the one specific to this feature:
//
//   THE DECISION IS THE CALLER'S. Exactly as convex/budget_gate.ts returns a
//     `BreakerSnapshot` and never an allow/deny: only the caller knows its own
//     risk posture, and a backend that returned "proceed" would be making a risk
//     decision on behalf of a customer whose risk it does not know — while
//     giving a compromised deployment a single field to flip.
//
//   WE CANNOT STOP AN AGENT WE DO NOT CONTROL. This product records agent
//     executions; it does not run them. An answer here is advisory, and the
//     response says so in a field that is REQUIRED rather than optional
//     (`advisoryBecause`), so a caller cannot receive the answer without
//     receiving its limit.
//
//   AND — THE RULING THAT INVERTS THE OBVIOUS DESIGN — A CALLER THAT IGNORES
//     THIS ANSWER PRODUCES A RUN THIS SYSTEM WILL RECORD IN FULL. That is not a
//     gap in the gate; it is the product working. Refusing to record a violation
//     destroys the evidence of the violation, so this surface is deliberately
//     built so that no amount of it can ever become an ingest refusal. See
//     convex/helpers/policy.ts PART 1.
//
// PROPERTIES INHERITED DELIBERATELY FROM convex/budget_gate.ts:
//
//   IT IS A QUERY, cheap enough to ask often, computed fresh every call so there
//   is no cached answer that can outlive the definitions it came from.
//
//   IT REQUIRES `ingest:write`, NOT `read`. This is a pre-write check and is
//   semantically part of the write path the key already holds. Requiring `read`
//   would deny every existing key scoped exactly `["ingest:write"]` — the
//   overwhelmingly common SDK key — turning a new advisory surface into a
//   breaking change for every deployed recorder.
//
//   IT DOES NOT CONSUME THE KEY'S INGEST RATE BUDGET and does not stamp
//   `lastUsedAt`. A caller must never be discouraged from asking, and must never
//   be able to exhaust its own ingest allowance by asking what the rules are.
// ---------------------------------------------------------------------------

import { v } from "convex/values";

import { query } from "./_generated/server.js";
import { afrError } from "./helpers/errors.js";
import {
  buildPolicySnapshot,
  policyGovernsRun,
  type PolicyDefinition,
  type PolicySnapshot,
  type PolicySubject,
} from "./helpers/policy.js";
import { loadEnabledPolicies } from "./policies.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

/** Scope required. See the header: a pre-write check belongs to the write path. */
const INGEST_WRITE = "ingest:write";

/**
 * Read-only API key resolution.
 *
 * The same credential checks as convex/budget_gate.ts's `resolveApiKeyForRead`,
 * for the same reason it is duplicated there rather than shared with
 * sdk_ingest.ts's `resolveApiKey`: that one takes a `MutationCtx` precisely so its
 * throttled `lastUsedAt` write is type-checked, and loosening its signature to
 * `QueryCtx` would remove the guarantee on the ingest path, which matters more
 * than removing eight lines here.
 */
async function resolveApiKeyForRead(ctx: QueryCtx, apiKeyHash: string): Promise<Doc<"api_keys">> {
  const apiKey = await ctx.db
    .query("api_keys")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", apiKeyHash))
    .unique();

  if (!apiKey || apiKey.revokedAt !== undefined) throw new Error("Unauthorized");
  if (apiKey.expiresAt !== undefined && apiKey.expiresAt <= Date.now()) {
    throw new Error("Unauthorized: API key has expired");
  }
  if (
    apiKey.scopes !== undefined &&
    apiKey.scopes.length > 0 &&
    !apiKey.scopes.includes(INGEST_WRITE)
  ) {
    throw new Error(`Forbidden: API key lacks required scope "${INGEST_WRITE}"`);
  }
  return apiKey;
}

/**
 * The policy definitions governing an SDK caller's next operation.
 *
 * ORG SCOPE COMES FROM THE KEY AND FROM NOWHERE ELSE. There is no `orgId`
 * argument: the caller cannot name an organization, so it cannot name someone
 * else's. `runId` / `agentId` / `projectId` / `environment` only NARROW the
 * governing set within the key's own org, and each id is re-checked to belong to
 * it — a foreign or missing id yields the identical NOT_FOUND, so this surface is
 * not an existence oracle for another org's records.
 *
 * NARROWING IS OPTIONAL AND WIDENS BY DEFAULT. A caller that names nothing
 * receives every org-scoped policy rather than an empty list: an under-specified
 * question must not read as "no rules apply to you".
 *
 * THE ANSWER CARRIES NO VERDICT. Contracts' `decidePreflight` runs CLIENT-SIDE,
 * because only the caller knows its own `PolicyUnavailablePolicy` — and because
 * whatever it decides, this system records what happens either way. That is the
 * whole reason the seam has teeth; see convex/helpers/policy.ts PART 2.
 */
export const sdkCheckPolicy = query({
  args: {
    apiKeyHash: v.string(),
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    environment: v.optional(v.string()),
    /** Convenience: also contributes the run's project, agent and environment. */
    runId: v.optional(v.id("runs")),
  },
  handler: async (ctx, args): Promise<PolicySnapshot> => {
    const apiKey = await resolveApiKeyForRead(ctx, args.apiKeyHash);
    const orgId = apiKey.orgId;

    let projectId: Id<"projects"> | undefined = args.projectId;
    let agentId: Id<"agents"> | undefined = args.agentId;
    let environment: string | undefined = args.environment ?? apiKey.environment;

    if (args.runId !== undefined) {
      const run = await ctx.db.get(args.runId);
      if (!run || run.orgId !== orgId) throw afrError("NOT_FOUND", "Subject not found");
      projectId = projectId ?? run.projectId;
      agentId = agentId ?? run.agentId;
      environment = environment ?? run.environment;
    }
    for (const id of [args.projectId, args.agentId]) {
      if (id === undefined) continue;
      const doc = await ctx.db.get(id);
      if (!doc || (doc as { orgId?: Id<"organizations"> }).orgId !== orgId) {
        throw afrError("NOT_FOUND", "Subject not found");
      }
    }

    const { policies, truncated } = await loadEnabledPolicies(ctx, orgId);

    // THE SAME PREDICATE THE EVALUATION SURFACE USES, not a second copy. If the
    // pre-flight listing and the after-the-fact report disagreed about which rules
    // govern a run, a caller could do exactly what it was told and still be
    // reported in violation — which would make the advisory surface actively
    // harmful rather than merely limited.
    //
    // A SUBJECT DIMENSION THE CALLER DID NOT NAME CANNOT MATCH A POLICY SCOPED TO
    // IT. Sentinel ids are used rather than casts so the behaviour is explicit:
    // these never equal a real project or agent id. Org-scoped policies always
    // match, so an under-specified question WIDENS rather than returning nothing.
    const governing: PolicyDefinition[] = policies.filter((p) =>
      policyGovernsRun(p.subject, {
        projectId: projectId ?? "",
        agentId: agentId ?? "",
        ...(environment !== undefined ? { environment } : {}),
      }),
    );

    // The echoed subject is the NARROWEST dimension the caller actually named, so
    // a client can tell which question the server answered.
    const subject: PolicySubject =
      agentId !== undefined
        ? { appliesTo: "agent", agentId }
        : projectId !== undefined
          ? { appliesTo: "project", projectId }
          : environment !== undefined
            ? { appliesTo: "environment", environment }
            : { appliesTo: "org" };

    return buildPolicySnapshot({
      policies: governing,
      listingTruncated: truncated,
      subject,
      answeredAt: Date.now(),
    });
  },
});
