// ---------------------------------------------------------------------------
// DECLARATIVE POLICY — the Convex surface (Clerk-authenticated).
//
// The vocabulary is `packages/contracts/src/policy.ts` and the rulings are in
// convex/helpers/policy.ts. READ PARTS 2, 3 AND 4 OF THAT FILE FIRST; this module
// implements them rather than reinterpreting them:
//
//   NOTHING HERE REFUSES, MUTATES OR SUPPRESSES AN EVENT. No ingest hook, no
//     `enforce` mode, no write to `events` or `runs` anywhere in this file. And
//     no ingest module imports this one — the property that binds is the
//     dependency graph, not a promise about behaviour.
//   OUTCOMES ARE COMPUTED AT QUERY TIME AND NEVER STORED. Event Log Rule 2.
//   `not_evaluable` NEVER RENDERS AS `satisfied`. Enforced by the contract's
//     six-field coverage proof — whose `instrumentation` field will not accept an
//     undeclared claim — by branch order in `foldPolicyOutcome`, and by the
//     compliance-claim prose guard.
//   THERE IS NO DELETE. Contracts' `DisablePolicyRequest` is the operation: a
//     policy that governed recorded runs is part of how those runs were judged.
//
// THE API-KEY PRE-FLIGHT SURFACE IS IN convex/policy_gate.ts, separate for the
// same reason convex/budget_gate.ts and convex/sdk_ingest.ts are: that file must
// never call getAuthContext.
//
// Every function calls getAuthContext / requireOrgMembership before touching a
// table, and every mutation is admin-gated and audited (Event Log Rule 6).
// ---------------------------------------------------------------------------

import { v } from "convex/values";

import { query, mutation } from "./_generated/server.js";
import { recordAuditEvent } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import { afrError } from "./helpers/errors.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./helpers/pagination.js";
import {
  MAX_DENIED_ENTRIES,
  MAX_DENIED_ENTRY_LENGTH,
  MAX_POLICIES_PER_ORG,
  MAX_POLICY_NAME_LENGTH,
  MAX_POLICY_RATIONALE_LENGTH,
  POLICY_MAX_EVENTS_PER_RUN,
  POLICY_RULE_KINDS,
  POLICY_SCAN_MAX_EVENTS_PER_RUN,
  POLICY_SCAN_MAX_EVENTS_TOTAL,
  POLICY_SCAN_MAX_RUNS_PER_PAGE,
  POLICY_SUBJECT_KINDS,
  buildPolicyScanReport,
  foldPolicyOutcome,
  isInterpretableRule,
  noRunsInScopeOutcome,
  observeRunAgainstPolicy,
  policyGovernsRun,
  unopenedRunOutcome,
  type PolicyDefinition,
  type PolicyObservableEvent,
  type PolicyOutcome,
  type PolicyRule,
  type PolicyRunReadFacts,
  type PolicyScanReport,
  type PolicySubject,
} from "./helpers/policy.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

// ===========================================================================
// VOCABULARY AGREEMENT, ASSERTED AT MODULE LOAD
//
// The schema spells its unions as `v.literal(...)` because Convex's validator DSL
// cannot be built from a runtime array. That means the stored vocabulary and the
// contract's vocabulary are two lists that can drift, and a drifted vocabulary
// here means a stored policy the engine silently never matches — a rule that
// looks configured and grades nothing.
//
// budgets.ts makes the same assertion for the same reason. If a kind is added on
// one side and not the other, this throws at deploy rather than going quiet in
// production.
// ===========================================================================

const SCHEMA_RULE_KINDS = ["tool_denied", "egress_denied"] as const;
const SCHEMA_SUBJECT_KINDS = ["org", "project", "agent", "environment"] as const;

function assertVocabulary(contract: readonly string[], schema: readonly string[], what: string): void {
  const a = [...contract].sort().join(",");
  const b = [...schema].sort().join(",");
  if (a !== b) {
    throw new Error(
      `Policy ${what} vocabulary drift: contracts has [${a}] but convex/schema.ts accepts [${b}]. ` +
        `A stored policy of a kind the engine does not know is a rule that grades nothing.`,
    );
  }
}
assertVocabulary(POLICY_RULE_KINDS, SCHEMA_RULE_KINDS, "rule");
assertVocabulary(POLICY_SUBJECT_KINDS, SCHEMA_SUBJECT_KINDS, "subject");

const ruleValidator = v.union(
  v.object({ kind: v.literal("tool_denied"), deniedTools: v.optional(v.array(v.string())) }),
  v.object({ kind: v.literal("egress_denied"), deniedHosts: v.optional(v.array(v.string())) }),
);
const subjectValidator = v.union(
  v.object({ appliesTo: v.literal("org") }),
  v.object({ appliesTo: v.literal("project"), projectId: v.id("projects") }),
  v.object({ appliesTo: v.literal("agent"), agentId: v.id("agents") }),
  v.object({ appliesTo: v.literal("environment"), environment: v.string() }),
);

/**
 * STORED shapes, taken from the schema rather than from the contract.
 *
 * The contract's `PolicyRule` / `PolicySubject` use `readonly string[]` and plain
 * `string` ids on purpose — the engine is pure and id-agnostic, exactly as
 * helpers/causal_graph.ts is. The STORED shapes carry `v.id()` brands and mutable
 * arrays. Validation and writes work in the stored shapes and widen to the
 * contract's on the way in, which is assignment-compatible in that direction and
 * not the other, so neither definition has to be loosened for the other.
 */
type StoredRule = Doc<"policies">["rule"];
type StoredSubject = Doc<"policies">["subject"];

// ===========================================================================
// VALIDATION
// ===========================================================================

function trimmedWithin(value: string, max: number, field: string): string {
  const t = value.trim();
  if (t.length === 0 || t.length > max) {
    throw afrError("INVALID_ARGUMENT", `${field} must be 1-${max} characters`);
  }
  return t;
}

/**
 * Normalise and bound a rule's target list.
 *
 * AN EXPLICIT EMPTY ARRAY IS REFUSED, and this is the validation rule worth
 * arguing for. `deniedTools: []` forbids nothing, so every run trivially
 * "satisfies" it — a policy that manufactures clear findings forever while
 * appearing in the org's rule list as a control in force. It is the policy
 * analogue of helpers/budget.ts refusing a limit of 0, which trips on an empty
 * window for the mirror-image reason.
 *
 * ABSENT is a different thing entirely and is permitted: it means the operation
 * itself is denied (helpers/policy.ts PART 5), and it is the one form under which
 * an externalized payload still proves a violation. `undefined` and `[]` are
 * OPPOSITE MEANINGS ONE SERIALIZATION STEP APART, which is exactly why the empty
 * array must not be quietly coerced to absent.
 *
 * REFUSING IT HERE IS NOT SUFFICIENT AND IS NOT RELIED ON. `isInterpretableRule`
 * re-checks at EVALUATION time, so a row written before this guard existed,
 * restored from a backup, or inserted by any other path is reported
 * `policy_unreadable` rather than silently matching nothing.
 */
function normaliseTargets(list: string[] | undefined, field: string): string[] | undefined {
  if (list === undefined) return undefined;
  if (list.length === 0) {
    throw afrError(
      "INVALID_ARGUMENT",
      `${field} must not be an empty array: a rule that forbids nothing is satisfied by every run, ` +
        `which reports an all-clear that was never earned. Omit ${field} entirely to forbid the ` +
        `operation itself, or list at least one value.`,
    );
  }
  if (list.length > MAX_DENIED_ENTRIES) {
    throw afrError("INVALID_ARGUMENT", `${field} may contain at most ${MAX_DENIED_ENTRIES} entries`);
  }
  const out: string[] = [];
  for (const raw of list) {
    const value = trimmedWithin(raw, MAX_DENIED_ENTRY_LENGTH, `each ${field} entry`);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function validateRule(rule: StoredRule): StoredRule {
  if (rule.kind === "tool_denied") {
    const deniedTools = normaliseTargets(rule.deniedTools, "deniedTools");
    return deniedTools === undefined ? { kind: "tool_denied" } : { kind: "tool_denied", deniedTools };
  }
  const deniedHosts = normaliseTargets(rule.deniedHosts, "deniedHosts");
  return deniedHosts === undefined ? { kind: "egress_denied" } : { kind: "egress_denied", deniedHosts };
}

/**
 * Resolve the subject IN THE CALLER'S OWN ORG.
 *
 * A project or agent belonging to another tenant produces the SAME NOT_FOUND as
 * one that does not exist, so this mutation is not an existence oracle for
 * another org's records — the tenancy posture every id-taking surface here uses.
 */
async function validateSubject(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  subject: StoredSubject,
): Promise<StoredSubject> {
  switch (subject.appliesTo) {
    case "org":
      return subject;
    case "project": {
      const doc = await ctx.db.get(subject.projectId);
      if (!doc || doc.orgId !== orgId) throw afrError("NOT_FOUND", "Subject not found");
      return subject;
    }
    case "agent": {
      const doc = await ctx.db.get(subject.agentId);
      if (!doc || doc.orgId !== orgId) throw afrError("NOT_FOUND", "Subject not found");
      return subject;
    }
    case "environment": {
      const environment = trimmedWithin(subject.environment, 32, "environment");
      return { appliesTo: "environment", environment };
    }
  }
}

/** Stored row -> the contract's definition shape. One conversion, used everywhere. */
export function toPolicyDefinition(row: Doc<"policies">): PolicyDefinition {
  return {
    policyId: row._id,
    orgId: row.orgId,
    name: row.name,
    revision: row.revision,
    rule: row.rule,
    subject: row.subject,
    rationale: row.rationale,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

/**
 * Enabled policies for an org, bounded. Shared by the evaluation surface and
 * (through convex/policy_gate.ts) by the pre-flight listing, so the two can never
 * disagree about which rules are in force.
 *
 * Over-fetches by one so `truncated` is a POSITIVE observation that more exist,
 * rather than an inference from a full page.
 */
export async function loadEnabledPolicies(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<{ policies: PolicyDefinition[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("policies")
    .withIndex("by_org_enabled", (q) => q.eq("orgId", orgId).eq("enabled", true))
    .take(MAX_POLICIES_PER_ORG + 1);
  return {
    // ENABLEMENT ONLY, and that is the INDEX RANGE rather than a predicate — this
    // loader never spells `enabled === true` itself, which is how the pre-flight
    // and the evaluator came to disagree about a disabled policy.
    //
    // DELIBERATELY *NOT* FILTERED BY `policyGoverns`. That predicate is
    // enablement AND rule-interpretability, and dropping a VACUOUS ENABLED policy
    // here would be the exact failure this feature exists to prevent: a rule an
    // operator believes is in force, silently absent from every report rather
    // than reported `policy_unreadable`. Disabled rows are already out of the
    // range; a vacuous one must reach the fold so it can be named.
    policies: rows.slice(0, MAX_POLICIES_PER_ORG).map(toPolicyDefinition),
    truncated: rows.length > MAX_POLICIES_PER_ORG,
  };
}

/**
 * The org's retention horizon, or `null` when no window is configured.
 *
 * A COVERAGE FACT, and it must be named in every report: ADR-001 permits an org's
 * opt-in window to purge runs — the sole sanctioned exception to "events are
 * never deleted" — so a report over a period whose runs have aged out finds
 * nothing, honestly and uselessly. A COMPLIANCE REPORT THAT GOES CLEAR BY ELAPSED
 * TIME is the failure that happens without anyone deciding it, and a horizon
 * nobody printed is how.
 *
 * `null` is NOT `0`: `null` means no window is configured, and `0` would mean
 * everything has aged out.
 */
async function retentionHorizonFor(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<number | null> {
  const org = await ctx.db.get(orgId);
  const days = org?.retentionDays;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return null;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

// ===========================================================================
// READS OF THE DEFINITIONS
// ===========================================================================

export const listPolicies = query({
  args: { orgId: v.id("organizations"), limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const page = await ctx.db
      .query("policies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    return {
      // `interpretable` is surfaced on the LISTING and not only inside an
      // outcome: a rule nothing can evaluate is a control an operator believes is
      // in force, and the policy list is where they look to believe it.
      policies: page.page.map((p) => ({ ...p, interpretable: isInterpretableRule(p.rule) })),
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
  },
});

export const getPolicy = query({
  args: { policyId: v.id("policies") },
  handler: async (ctx, args) => {
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);
    const policy = await ctx.db.get(args.policyId);
    if (!policy || policy.orgId !== orgId) throw afrError("NOT_FOUND", "Policy not found");
    return { ...policy, interpretable: isInterpretableRule(policy.rule) };
  },
});

// ===========================================================================
// PRIVILEGED WRITES. Admin-gated, audited (Event Log Rule 6).
// ===========================================================================

export const createPolicy = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    rule: ruleValidator,
    subject: subjectValidator,
    rationale: v.string(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });

    const name = trimmedWithin(args.name, MAX_POLICY_NAME_LENGTH, "name");
    const rationale = trimmedWithin(args.rationale, MAX_POLICY_RATIONALE_LENGTH, "rationale");
    const rule = validateRule(args.rule);
    const subject = await validateSubject(ctx, args.orgId, args.subject);

    const existing = await ctx.db
      .query("policies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_POLICIES_PER_ORG + 1);
    if (existing.length > MAX_POLICIES_PER_ORG) {
      throw afrError("INVALID_ARGUMENT", `At most ${MAX_POLICIES_PER_ORG} policies per organization`);
    }

    const policyId = await ctx.db.insert("policies", {
      orgId: args.orgId,
      name,
      rule,
      subject,
      rationale,
      enabled: args.enabled ?? true,
      revision: 1,
      createdAt: Date.now(),
      createdBy: userId,
    });

    // FULL TERMS IN THE AUDIT ROW, here and in every mutation below. The
    // definitions table is ordinary mutable config; the append-only audit log is
    // what makes "what did this rule say when that report was produced"
    // answerable after the definition has moved on.
    const auditLogId = await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "policy.created",
      targetType: "policy",
      targetId: policyId,
      metadata: { name, rule, subject, rationale, enabled: args.enabled ?? true, revision: 1 },
    });
    return { policyId, auditLogId, appliedAt: Date.now() };
  },
});

/**
 * Change a policy's terms.
 *
 * BUMPS `revision`, ALWAYS, and stamps the OLD terms into the audit row. An
 * outcome is a statement about a definition at a revision (helpers/policy.ts);
 * without the bump a report produced against the old terms and one produced
 * against the new terms are indistinguishable, which is how a compliance surface
 * quietly changes what it claimed.
 *
 * SEPARATE FROM {@link disablePolicy}, deliberately: changing what a policy
 * forbids and switching it off are different acts with different blast radii, and
 * an operator who wanted the second should not be able to do the first by
 * supplying one extra field.
 */
export const updatePolicy = mutation({
  args: {
    policyId: v.id("policies"),
    name: v.optional(v.string()),
    rule: v.optional(ruleValidator),
    subject: v.optional(subjectValidator),
    rationale: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "admin" });

    const policy = await ctx.db.get(args.policyId);
    if (!policy || policy.orgId !== orgId) throw afrError("NOT_FOUND", "Policy not found");

    const patch: Partial<Doc<"policies">> = {
      revision: policy.revision + 1,
      updatedAt: Date.now(),
      updatedBy: userId,
    };
    if (args.name !== undefined) patch.name = trimmedWithin(args.name, MAX_POLICY_NAME_LENGTH, "name");
    if (args.rationale !== undefined) {
      patch.rationale = trimmedWithin(args.rationale, MAX_POLICY_RATIONALE_LENGTH, "rationale");
    }
    if (args.rule !== undefined) patch.rule = validateRule(args.rule);
    if (args.subject !== undefined) patch.subject = await validateSubject(ctx, orgId, args.subject);

    await ctx.db.patch(args.policyId, patch);

    const auditLogId = await recordAuditEvent(ctx, {
      orgId,
      actorClerkUserId: userId,
      action: "policy.updated",
      targetType: "policy",
      targetId: args.policyId,
      metadata: {
        previousRevision: policy.revision,
        revision: policy.revision + 1,
        previousRule: policy.rule,
        previousSubject: policy.subject,
        previousName: policy.name,
        previousRationale: policy.rationale,
        ...(patch.rule !== undefined ? { rule: patch.rule } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
      },
    });
    return { policyId: args.policyId, auditLogId, appliedAt: Date.now() };
  },
});

/**
 * Disable (or re-enable) a policy. REQUIRES A REASON, written verbatim to the
 * append-only audit log.
 *
 * THIS IS WHAT REPLACES DELETE, and the substitution is the ruling. A policy that
 * governed recorded runs is part of how those runs were judged; removing the row
 * would make every past outcome that cites it uninterpretable. Contracts states
 * this as `DisablePolicyRequest` and offers no delete, and neither does this
 * module — there is no `deletePolicy` here and adding one would reopen it.
 *
 * Does NOT bump `revision`: the terms are unchanged, so a report produced before
 * and after describes the same rule. What changed is whether it is in force,
 * which is its own audited action.
 */
export const disablePolicy = mutation({
  args: { policyId: v.id("policies"), enabled: v.boolean(), reason: v.string() },
  handler: async (ctx, args) => {
    const { userId, orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId, { minimumRole: "admin" });

    const policy = await ctx.db.get(args.policyId);
    if (!policy || policy.orgId !== orgId) throw afrError("NOT_FOUND", "Policy not found");
    const reason = trimmedWithin(args.reason, MAX_POLICY_RATIONALE_LENGTH, "reason");

    await ctx.db.patch(args.policyId, {
      enabled: args.enabled,
      updatedAt: Date.now(),
      updatedBy: userId,
      // A historical marker, not the live flag: never cleared on re-enable.
      ...(args.enabled ? {} : { disabledAt: Date.now(), disabledBy: userId }),
    });

    const auditLogId = await recordAuditEvent(ctx, {
      orgId,
      actorClerkUserId: userId,
      action: "policy.enabled_changed",
      targetType: "policy",
      targetId: args.policyId,
      metadata: {
        previousEnabled: policy.enabled,
        enabled: args.enabled,
        reason,
        revision: policy.revision,
        // The full terms travel here too, so the audit log alone can reconstruct
        // what was switched off.
        rule: policy.rule,
        subject: policy.subject,
        name: policy.name,
      },
    });
    return { policyId: args.policyId, auditLogId, appliedAt: Date.now() };
  },
});

// ===========================================================================
// DETECTION OVER RECORDED DATA
// ===========================================================================

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

/**
 * Read one run's events, bounded, org-checked, UNFILTERED.
 *
 * THE READ IS DELIBERATELY UNFILTERED, and that is a correction rather than a
 * preference. A read filtered to the deciding event type cannot see
 * `otel.span.unmapped` events — spans the mapper could not interpret, which may
 * therefore have been ANY operation including the forbidden one. Filtering them
 * out is what let coverage read complete over a run whose every act was an
 * unreadable span. One unfiltered read also serves every policy governing the
 * run, so this is cheaper than the per-policy filtered reads it replaces.
 *
 * `logReadComplete` IS A POSITIVE OBSERVATION: the read over-fetches by one row
 * and checks whether the extra row came back. It is never a `!truncated` that is
 * true by default.
 */
async function readRunEvents(
  ctx: QueryCtx,
  run: Doc<"runs">,
  limit: number,
): Promise<{ events: PolicyObservableEvent[]; facts: PolicyRunReadFacts }> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    // OVER-FETCH BY ONE. The extra row is the observation.
    .take(limit + 1);

  const logReadComplete = rows.length <= limit;
  let crossOrgRowsSkipped = 0;
  let terminalEventObserved = false;
  const events: PolicyObservableEvent[] = [];

  for (const row of rows.slice(0, limit)) {
    // Defensive re-check. `by_run` is not org-prefixed, and a mis-stamped row
    // must reduce the evaluation to `not_evaluable` rather than be silently
    // dropped from a set we then call complete.
    if (row.orgId !== run.orgId) {
      crossOrgRowsSkipped += 1;
      continue;
    }
    if (TERMINAL_EVENT_TYPES.has(row.type)) terminalEventObserved = true;
    events.push({
      eventId: row._id,
      runId: row.runId,
      type: row.type,
      sequenceNumber: row.sequenceNumber,
      timestamp: row.timestamp,
      payload: row.payload,
      ...(row.provenance !== undefined
        ? {
            provenance: {
              source: row.provenance.source,
              ...(row.provenance.source === "otel" ? { lossy: row.provenance.lossy } : {}),
            },
          }
        : {}),
    });
  }

  return {
    events,
    facts: {
      runId: run._id,
      runObserved: true,
      // BOTH must hold. A run whose STATUS is terminal but whose log carries no
      // terminal EVENT was closed by the stale-run sweep or a status mutation
      // rather than by the agent, and Event Log Rule 5 is about the log.
      runIsTerminal: terminalEventObserved && TERMINAL_RUN_STATUSES.has(run.status),
      logReadComplete,
      crossOrgRowsSkipped,
      observedAt: Date.now(),
      // NO INSTRUMENTATION CLAIM IS SUPPLIED, because nothing in this product
      // produces one (helpers/policy.ts PART 4). It is left ABSENT rather than
      // defaulted, so contracts' `CompleteInstrumentationClaim` requirement keeps
      // `satisfied` unreachable until an agent version actually declares. This is
      // the seam an agent-version declaration plugs into; inventing a field for it
      // here would be speculative and would read as "covered" on every stored run.
    },
  };
}

/**
 * Evaluate every enabled policy that governs ONE run.
 *
 * The complete-coverage path: one unfiltered read of up to
 * POLICY_MAX_EVENTS_PER_RUN events, shared by every governing policy. This is the
 * surface on which a licensed `satisfied` could be reached at all — and today
 * cannot be, for any rule kind, because no agent version declares its
 * instrumentation.
 */
export const evaluateRunAgainstPolicies = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args): Promise<PolicyScanReport> => {
    // TENANCY: caller resolved and authorized BEFORE the run is observed, so a
    // run in another org and a run that does not exist are indistinguishable.
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== orgId) throw afrError("NOT_FOUND", "Run not found");

    const evaluatedAt = Date.now();
    const { policies, truncated } = await loadEnabledPolicies(ctx, orgId);
    const governing = policies.filter((p) => policyGovernsRun(p.subject, run));
    const { events, facts } = await readRunEvents(ctx, run, POLICY_MAX_EVENTS_PER_RUN);

    let orderingCaveat = false;
    const outcomes: PolicyOutcome[] = governing.map((policy) => {
      const observation = observeRunAgainstPolicy(policy, events, facts);
      if (observation.orderingCaveat) orderingCaveat = true;
      return foldPolicyOutcome({ policy, observation, evaluatedAt });
    });

    return buildPolicyScanReport({
      outcomes,
      scan: {
        // A single-run evaluation has no narrower subject in the contract's
        // vocabulary — there is no `run` variant, deliberately, since a policy
        // never applies to one run. The org subject is echoed and `runsInScope`
        // carries the actual scope.
        subject: { appliesTo: "org" },
        policiesInScope: governing.length,
        policiesEvaluated: outcomes.length,
        runsInScope: 1,
        runsRead: 1,
        evaluationTruncated: truncated || !facts.logReadComplete,
        retentionHorizon: await retentionHorizonFor(ctx, orgId),
        orderingCaveat,
      },
      evaluatedAt,
    });
  },
});

/**
 * Evaluate ONE policy across many runs.
 *
 * THE SCALE RULING IS helpers/policy.ts PART G, and this is it in code:
 *
 *   ONE `.paginate()` PER EXECUTION, over `runs`, on the index the policy's own
 *     subject selects. Per-run event reads are bounded `.take()`s, never a second
 *     paginate.
 *   NOTHING IS ANSWERED FROM A DENORMALIZED FIELD, because none exists that could
 *     answer a policy question, and adding one was refused — see PART G.
 *   EVERY RUN THE BUDGET DID NOT REACH IS EMITTED AS AN EXPLICIT `run_not_opened`
 *     OUTCOME NAMING THE RUN. Never omitted: a run missing from a compliance
 *     report reads as a run with nothing to report.
 *   ZERO RUNS IN SCOPE IS ITS OWN OUTCOME, not an absent one and never an
 *     all-clear — an empty set satisfies every prohibition trivially, and a scan
 *     pointed at the wrong project produces exactly that.
 */
export const scanRunsAgainstPolicy = query({
  args: {
    policyId: v.id("policies"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<PolicyScanReport & { nextCursor?: string }> => {
    const { orgId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, orgId);

    const row = await ctx.db.get(args.policyId);
    if (!row || row.orgId !== orgId) throw afrError("NOT_FOUND", "Policy not found");
    const policy = toPolicyDefinition(row);
    // A NON-GOVERNING POLICY IS EVALUATED AND REPORTED, NOT REFUSED.
    //
    // An earlier revision threw INVALID_ARGUMENT for a disabled policy. Reporting
    // is better and it is the same principle the outcome vocabulary rests on: the
    // scan returns `policy_disabled` (or `policy_unreadable`) per run, which is
    // `not_evaluable` — an outcome wrong in NEITHER direction. It cannot
    // manufacture the violation somebody rolls back on, and it cannot be counted
    // as an all-clear, so A FAILING SCAN CANNOT BE MADE TO PASS BY SWITCHING ITS
    // POLICY OFF. An error, by contrast, is a result the caller decides the
    // meaning of.
    const subject: PolicySubject = policy.subject;

    const evaluatedAt = Date.now();
    const numItems = Math.min(
      args.limit ?? POLICY_SCAN_MAX_RUNS_PER_PAGE,
      POLICY_SCAN_MAX_RUNS_PER_PAGE,
    );
    const cursor = args.cursor ?? null;

    // THE ONE `.paginate()`. The index is chosen by the policy's subject, and
    // every option is org-scoped or org-re-checked below.
    const page = await (async () => {
      if (subject.appliesTo === "agent") {
        return await ctx.db
          .query("runs")
          .withIndex("by_agent_started", (q) => q.eq("agentId", subject.agentId as Id<"agents">))
          .order("desc")
          .paginate({ numItems, cursor });
      }
      if (subject.appliesTo === "project") {
        return await ctx.db
          .query("runs")
          .withIndex("by_project_started", (q) =>
            q.eq("projectId", subject.projectId as Id<"projects">),
          )
          .order("desc")
          .paginate({ numItems, cursor });
      }
      if (subject.appliesTo === "environment") {
        return await ctx.db
          .query("runs")
          .withIndex("by_org_environment_started", (q) =>
            q.eq("orgId", orgId).eq("environment", subject.environment),
          )
          .order("desc")
          .paginate({ numItems, cursor });
      }
      return await ctx.db
        .query("runs")
        .withIndex("by_org_started", (q) => q.eq("orgId", orgId))
        .order("desc")
        .paginate({ numItems, cursor });
    })();

    const outcomes: PolicyOutcome[] = [];
    let runsInScope = 0;
    let runsRead = 0;
    let eventsRead = 0;
    let budgetExhausted = false;
    let foreignRowsSkipped = 0;
    let orderingCaveat = false;

    for (const run of page.page) {
      // `by_agent_started` / `by_project_started` are not org-prefixed. A run that
      // is not this org's is NOT part of the page and NOT reported: it is not ours
      // to describe. It is counted so a non-zero value forces the evaluation to be
      // reported as truncated rather than passing silently.
      if (run.orgId !== orgId) {
        foreignRowsSkipped += 1;
        continue;
      }
      if (!policyGovernsRun(subject, run)) continue;
      runsInScope += 1;

      if (eventsRead >= POLICY_SCAN_MAX_EVENTS_TOTAL) {
        budgetExhausted = true;
        outcomes.push(unopenedRunOutcome(policy, run._id, "event_budget_exhausted"));
        continue;
      }

      const perRun = Math.min(
        POLICY_SCAN_MAX_EVENTS_PER_RUN,
        POLICY_SCAN_MAX_EVENTS_TOTAL - eventsRead,
      );
      const { events, facts } = await readRunEvents(ctx, run, perRun);
      eventsRead += events.length + facts.crossOrgRowsSkipped;
      runsRead += 1;
      const observation = observeRunAgainstPolicy(policy, events, facts);
      if (observation.orderingCaveat) orderingCaveat = true;
      outcomes.push(foldPolicyOutcome({ policy, observation, evaluatedAt }));
    }

    // ZERO RUNS IN SCOPE. Its own outcome, never an absent one.
    if (runsInScope === 0 && page.isDone && cursor === null) {
      outcomes.push(noRunsInScopeOutcome(policy));
    }

    const report = buildPolicyScanReport({
      outcomes,
      scan: {
        subject,
        policiesInScope: 1,
        policiesEvaluated: 1,
        runsInScope,
        runsRead,
        evaluationTruncated: budgetExhausted || !page.isDone || foreignRowsSkipped > 0,
        retentionHorizon: await retentionHorizonFor(ctx, orgId),
        orderingCaveat,
      },
      evaluatedAt,
    });
    return { ...report, ...(page.isDone ? {} : { nextCursor: page.continueCursor }) };
  },
});

// Re-exported for convex/policy_gate.ts, which must not import the contract
// vocabulary a second time.
export type { PolicyDefinition, PolicyRule, PolicySubject };
