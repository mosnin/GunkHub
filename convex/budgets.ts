// ---------------------------------------------------------------------------
// BUDGET CIRCUIT BREAKERS — the Convex surface (Clerk-authenticated).
//
// The vocabulary is `packages/contracts/src/budgets.ts` and the rulings are in
// convex/helpers/budget.ts. READ PART 2 OF THAT FILE FIRST — it is the whole
// argument for what this backend will and will not put a limit on:
//
//   NEVER READS `usage_counters` (~1000x spread; a breaker on it trips at random)
//   REFUSES the cost meter outright (the pricing matcher over-prices in the
//     halt direction, and gets more wrong as the table grows)
//   REFUSES the events_ingested meter (sampled counter is its only source)
//   TOKEN/RUN COUNTS from `runs.*` are exact-over-recorded and cannot overstate,
//     so they PROVE a breach and can never establish headroom
//   RUN-SCOPED budgets are RECONCILED from the append-only event log and can do
//     both — the narrow exact path this accounting can actually support
//
// STATE IS COMPUTED AT QUERY TIME, NEVER STORED. The contract's BreakerSnapshot
// is a derived projection (CLAUDE.md Event Log Rule 2) and an earlier draft of
// this file cached `state`/`evaluatedAt`/`lastObservation` on the row, which was
// a stored projection that could disagree with the runs it came from. Only TRIP
// FACTS persist, because a trip is a recorded decision with an audit row behind
// it rather than a recomputable summary.
//
// THE API-KEY GATE IS IN convex/budget_gate.ts, separate for the same reason
// convex/sdk_ingest.ts is: that file must never call getAuthContext.
//
// Every function calls getAuthContext / requireOrgMembership before touching a
// table, and every privileged mutation is audited (Event Log Rule 6).
// ---------------------------------------------------------------------------

import {
  BREAKER_EVALUATION_CADENCE_MS,
  BUDGET_METERS,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
} from "@agent-flight-recorder/contracts";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { recordAuditEvent, SYSTEM_ACTOR } from "./audit.js";
import { getAuthContext, requireOrgMembership } from "./auth.js";
import {
  BUDGET_MAX_EVENTS_RECONCILED,
  BUDGET_MAX_RUNS_SCANNED,
  BUDGET_MIN_LIMIT_AMOUNT,
  MAX_BREAKERS_PER_ORG,
  MAX_BUDGET_NAME_LENGTH,
  MAX_BUDGET_NOTE_LENGTH,
  approximateFigureFromCounter,
  assertNoExecutionClaim,
  buildSnapshot,
  foldBreakerState,
  isSpendSumComplete,
  meterAmount,
  meterRefusalReason,
  reconciledFigureFromLog,
  resolveBudgetWindow,
  undeterminedState,
  type BreakerSnapshotEnvelope,
  type BreakerState,
  type BudgetLimit,
  type SpendObservation,
} from "./helpers/budget.js";
import { afrError } from "./helpers/errors.js";
import { MAX_PAGE_SIZE } from "./helpers/pagination.js";
import { extractTokenUsage } from "./helpers/run_fields.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

/** Budgets whose trip state is re-checked per sweep tick, across all orgs. */
const BUDGET_SWEEP_BATCH = 200;

const _listSweepBudgets = makeFunctionReference<"query">("budgets:listSweepBudgets");
const _recordTripIfBreached = makeFunctionReference<"mutation">("budgets:recordTripIfBreached");

// ---------------------------------------------------------------------------
// VOCABULARY AGREEMENT, ASSERTED AT MODULE LOAD.
//
// `schema.ts` spells the scope/meter/period vocabularies as v.literal unions
// because Convex's validator DSL cannot be built from a runtime array. That is
// a second place the vocabulary is written down, which is exactly the drift
// this codebase keeps paying for — so the agreement is CHECKED rather than
// trusted. A contract that gains a scope and a schema that does not now fails
// on import instead of silently rejecting writes at runtime.
// ---------------------------------------------------------------------------
const SCHEMA_SCOPES = ["org", "project", "agent", "agent_version", "run"] as const;
const SCHEMA_METERS = [
  "cost_minor_units",
  "tokens_in",
  "tokens_out",
  "runs_started",
  "events_ingested",
] as const;
const SCHEMA_PERIODS = ["run", "hour", "day", "month", "lifetime"] as const;

function assertVocabulary(name: string, schema: readonly string[], contract: readonly string[]): void {
  const a = [...schema].sort().join(",");
  const b = [...contract].sort().join(",");
  if (a !== b) {
    throw new Error(
      `budget ${name} vocabulary drift: convex/schema.ts has [${a}] but ` +
        `@agent-flight-recorder/contracts has [${b}]. The contract is canonical; update schema.ts.`,
    );
  }
}
assertVocabulary("scope", SCHEMA_SCOPES, BUDGET_SCOPES);
assertVocabulary("meter", SCHEMA_METERS, BUDGET_METERS);
assertVocabulary("period", SCHEMA_PERIODS, BUDGET_PERIODS);

// ===========================================================================
// VALIDATION
// ===========================================================================

function validateBudgetConfig(args: {
  name?: string;
  limitAmount?: number;
  meter?: string;
  scope?: string;
  period?: string;
}): void {
  if (args.name !== undefined) {
    if (args.name.trim().length === 0 || args.name.length > MAX_BUDGET_NAME_LENGTH) {
      throw afrError("INVALID_ARGUMENT", `name must be 1-${MAX_BUDGET_NAME_LENGTH} characters`);
    }
  }
  if (args.limitAmount !== undefined) {
    if (!Number.isInteger(args.limitAmount)) {
      // The contract's BudgetMeter header: floating-point money is how a limit
      // of 100.00 is compared against 100.00000000000001.
      throw afrError("INVALID_ARGUMENT", "limitAmount must be an integer in the meter's own unit");
    }
    if (args.limitAmount < BUDGET_MIN_LIMIT_AMOUNT) {
      throw afrError(
        "INVALID_ARGUMENT",
        `limitAmount must be at least ${BUDGET_MIN_LIMIT_AMOUNT}. A limit of 0 is breached by an empty window — see convex/helpers/budget.ts PART 5.`,
      );
    }
  }
  // A run-scoped budget is bounded by the run; any other period is meaningless
  // for it, and a period-scoped budget cannot use the "run" period.
  if (args.scope !== undefined && args.period !== undefined) {
    if ((args.scope === "run") !== (args.period === "run")) {
      throw afrError(
        "INVALID_ARGUMENT",
        'scope "run" requires period "run", and period "run" requires scope "run": a run-scoped budget is bounded by the run itself.',
      );
    }
  }
}


/** The contract-shaped limit for a stored row. */
function limitOf(b: Doc<"budget_breakers">): BudgetLimit {
  return {
    budgetId: b._id,
    orgId: b.orgId,
    scope: b.scope,
    scopeId: b.scopeId,
    meter: b.meter,
    period: b.period,
    limitAmount: b.limitAmount,
    ...(b.currency !== undefined ? { currency: b.currency } : {}),
    enabled: b.enabled,
    createdAt: b.createdAt,
  };
}

// ===========================================================================
// OBSERVATION — the ONLY place this feature reads spend
// ===========================================================================

/**
 * Sum recorded spend over a period-scoped budget's window.
 *
 * READS `runs.tokensIn` / `runs.tokensOut` AND NOTHING ELSE. Not
 * `usage_counters` (Morris-sampled, ~1000x spread — helpers/budget.ts PART 2a),
 * not `daily_rollups` (cron-written for YESTERDAY only, so it cannot see today's
 * overspend, which is the whole question a daily budget asks), not
 * `helpers/pricing.ts` (PART 2b).
 *
 * TWO INDEX PATHS, and the second needs a guard the first does not:
 *
 *   org scope       `by_org_started` is org-PREFIXED, so a foreign run is not
 *                   filtered out after being read — it is never in the range.
 *
 *   narrower scope  `by_agent_started` / `by_project_started` are NOT
 *                   org-prefixed. The scopeId is validated same-org at creation,
 *                   but a scan must not depend on every historical write having
 *                   been correct (the argument schema.ts already makes for
 *                   `by_org_parent`). Every row's `orgId` is re-checked and a
 *                   mismatch is SKIPPED AND COUNTED; a non-zero
 *                   `crossOrgRowsSkipped` makes the sum incomplete, which
 *                   reports `undetermined` rather than quietly under-counting.
 *
 * TRUNCATION IS OBSERVED POSITIVELY: the scan over-fetches by one row and sets
 * `reachedEndOfRange` only when it comes back short.
 */
async function observePeriodSpend(
  ctx: QueryCtx | MutationCtx,
  budget: Doc<"budget_breakers">,
  now: number,
): Promise<SpendObservation> {
  const period = budget.period === "run" ? "lifetime" : budget.period;
  const window = resolveBudgetWindow(
    {
      period,
      createdAt: budget.createdAt,
      ...(budget.resetAt !== undefined ? { resetAt: budget.resetAt } : {}),
    },
    now,
  );

  const cap = BUDGET_MAX_RUNS_SCANNED;
  let rows: Array<Doc<"runs">>;
  if (budget.scope === "agent") {
    rows = await ctx.db
      .query("runs")
      .withIndex("by_agent_started", (q) =>
        q
          .eq("agentId", budget.scopeId as Id<"agents">)
          .gte("startedAt", window.startAt)
          .lt("startedAt", window.endAt),
      )
      .take(cap + 1);
  } else if (budget.scope === "project") {
    rows = await ctx.db
      .query("runs")
      .withIndex("by_project_started", (q) =>
        q
          .eq("projectId", budget.scopeId as Id<"projects">)
          .gte("startedAt", window.startAt)
          .lt("startedAt", window.endAt),
      )
      .take(cap + 1);
  } else if (budget.scope === "agent_version") {
    rows = await ctx.db
      .query("runs")
      .withIndex("by_agent_version_started", (q) =>
        q
          .eq("agentVersionId", budget.scopeId as Id<"agent_versions">)
          .gte("startedAt", window.startAt)
          .lt("startedAt", window.endAt),
      )
      .take(cap + 1);
  } else {
    rows = await ctx.db
      .query("runs")
      .withIndex("by_org_started", (q) =>
        q.eq("orgId", budget.orgId).gte("startedAt", window.startAt).lt("startedAt", window.endAt),
      )
      .take(cap + 1);
  }

  const reachedEndOfRange = rows.length <= cap;
  const counted = reachedEndOfRange ? rows : rows.slice(0, cap);

  let recordedTokensIn = 0;
  let recordedTokensOut = 0;
  let runsCounted = 0;
  let runsWithNoRecordedTokens = 0;
  let runsInFlight = 0;
  let crossOrgRowsSkipped = 0;

  for (const run of counted) {
    if (run.orgId !== budget.orgId) {
      crossOrgRowsSkipped += 1;
      continue;
    }
    runsCounted += 1;
    if (run.tokensIn === undefined && run.tokensOut === undefined) {
      // NOT zero spend — spend that was never recorded. Counted separately so
      // nobody reads a thin sum as a small bill.
      runsWithNoRecordedTokens += 1;
    }
    recordedTokensIn += run.tokensIn ?? 0;
    recordedTokensOut += run.tokensOut ?? 0;
    if (run.status === "running" || run.status === "pending") runsInFlight += 1;
  }

  return {
    windowStartAt: window.startAt,
    windowEndAt: window.endAt,
    recordedTokensIn,
    recordedTokensOut,
    runsCounted,
    runsWithNoRecordedTokens,
    runsInFlight,
    reachedEndOfRange,
    crossOrgRowsSkipped,
    observedAt: now,
  };
}

/**
 * THE EXACT PATH. Reconcile ONE run's spend by summing `llm.response` events
 * from the append-only log — the source of truth, per CLAUDE.md Event Log Rule 1.
 *
 * Returns `null` when the run's log exceeds BUDGET_MAX_EVENTS_RECONCILED, and
 * the caller reports `undetermined` rather than falling back to the run counter
 * and still calling the figure exact. That refusal is enforced by the type
 * system, not by discipline: the contract's `SpendReconciliation.logReadComplete`
 * is the literal `true`, so a truncated read CANNOT construct a reconciled
 * figure at all.
 *
 * WHAT RECONCILIATION DOES AND DOES NOT BUY, stated so it is not oversold: it
 * makes the count EXACT OVER THE LOG, so this figure can establish headroom as
 * well as breach. It does not make it exact over the world — spend that was
 * never recorded is not recoverable from stored data by any means.
 */
async function reconcileRunSpend(
  ctx: QueryCtx | MutationCtx,
  runId: Id<"runs">,
  meter: "tokens_in" | "tokens_out" | "runs_started",
  now: number,
): Promise<{ amount: number; eventsSummed: number; reconciledThrough: number } | null> {
  const cap = BUDGET_MAX_EVENTS_RECONCILED;
  const events = await ctx.db
    .query("events")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .take(cap + 1);
  if (events.length > cap) return null; // Cannot prove a complete read.

  if (meter === "runs_started") {
    return { amount: 1, eventsSummed: events.length, reconciledThrough: now };
  }

  let tokensIn = 0;
  let tokensOut = 0;
  for (const event of events) {
    if (event.type !== "llm.response") continue;
    const usage = extractTokenUsage(event.payload);
    tokensIn += usage.tokensIn;
    tokensOut += usage.tokensOut;
  }
  return {
    amount: meter === "tokens_in" ? tokensIn : tokensOut,
    eventsSummed: events.length,
    reconciledThrough: now,
  };
}

// ===========================================================================
// EVALUATION — figure + limit -> BreakerState, computed fresh every time
// ===========================================================================

/**
 * Compute one budget's current breaker state.
 *
 * NOT CACHED. The contract calls a snapshot a derived projection and says to
 * recompute rather than store it back; doing so also removes staleness as a
 * failure mode entirely — there is no stored answer that can outlive the runs it
 * was computed from.
 */
export async function evaluateBudget(
  ctx: QueryCtx | MutationCtx,
  budget: Doc<"budget_breakers">,
  now: number,
): Promise<{ state: BreakerState; transitionedToTripped: boolean; transitionedOutOfTrip: boolean }> {
  const limit = limitOf(budget);
  const existingTrip =
    budget.trippedAt !== undefined && budget.trippedBy !== undefined
      ? {
          trippedAt: budget.trippedAt,
          trippedBy: budget.trippedBy,
          because: budget.trippedBecause ?? "This breaker was recorded as tripped by an earlier evaluation.",
        }
      : undefined;

  // A meter this backend will not sign a figure for. Reported as undetermined,
  // naming the defect — never substituted with a nearby number.
  if (budget.meter === "cost_minor_units" || budget.meter === "events_ingested") {
    const refusal = meterRefusalReason(budget.meter);
    return {
      state: undeterminedState({
        limit,
        kind: "budget_unreadable",
        because: refusal.because,
        wouldBeDeterminedBy: refusal.wouldBeDeterminedBy,
      }),
      transitionedToTripped: false,
      transitionedOutOfTrip: false,
    };
  }

  // -- RUN SCOPE: the reconciled, exact path. ------------------------------
  if (budget.scope === "run") {
    const run = await ctx.db.get(budget.scopeId as Id<"runs">);
    if (!run || run.orgId !== budget.orgId) {
      return {
        state: undeterminedState({
          limit,
          kind: "spend_unavailable",
          because: "The run this budget governs is not readable in this organization, so its spend could not be summed.",
          wouldBeDeterminedBy: "Point the budget at a run in this organization, or delete it.",
        }),
        transitionedToTripped: false,
        transitionedOutOfTrip: false,
      };
    }
    const reconciled = await reconcileRunSpend(ctx, run._id, budget.meter, now);
    if (reconciled === null) {
      return {
        state: undeterminedState({
          limit,
          kind: "evaluation_truncated",
          because: `This run's event log exceeds the ${BUDGET_MAX_EVENTS_RECONCILED}-event reconciliation ceiling, so its spend could not be summed to completion. A partial sum cannot be presented as an exact one.`,
          wouldBeDeterminedBy:
            "Use an agent- or project-scoped budget for this workload, whose spend is counted from run records rather than reconciled event by event.",
        }),
        transitionedToTripped: false,
        transitionedOutOfTrip: false,
      };
    }
    const figure = reconciledFigureFromLog({
      amount: reconciled.amount,
      budgetId: budget._id,
      runsSummed: 1,
      eventsSummed: reconciled.eventsSummed,
      reconciledThrough: reconciled.reconciledThrough,
      reconciledAt: now,
    });
    return foldBreakerState({
      limit,
      figure,
      ...(existingTrip !== undefined ? { existingTrip } : {}),
      rearmOnPeriodRoll: budget.rearmOnPeriodRoll,
      windowStartAt: run.startedAt,
      now,
    });
  }

  // -- PERIOD SCOPES: the counter path. Trips provably; never arms. --------
  const observation = await observePeriodSpend(ctx, budget, now);
  if (!isSpendSumComplete(observation)) {
    return {
      state: undeterminedState({
        limit,
        kind: observation.reachedEndOfRange ? "spend_not_decidable" : "evaluation_truncated",
        because: observation.reachedEndOfRange
          ? `The accounting window for this budget could not be summed: ${observation.crossOrgRowsSkipped} row(s) read did not belong to this organization, or the window resolved to zero width. An incomplete sum can only hide spend, never invent it, so no conclusion is drawn from it.`
          : `The run scan hit its ${BUDGET_MAX_RUNS_SCANNED}-row ceiling before reaching the end of the accounting window, so runs are missing from the total. An incomplete sum can only hide spend, never invent it.`,
        wouldBeDeterminedBy:
          "Narrow the budget's scope, or shorten its period, so the window fits inside the scan ceiling.",
      }),
      transitionedToTripped: false,
      transitionedOutOfTrip: false,
    };
  }

  const amount = meterAmount(observation, budget.meter);
  if (amount === null) {
    const refusal = meterRefusalReason(budget.meter);
    return {
      state: undeterminedState({
        limit,
        kind: "budget_unreadable",
        because: refusal.because,
        wouldBeDeterminedBy: refusal.wouldBeDeterminedBy,
      }),
      transitionedToTripped: false,
      transitionedOutOfTrip: false,
    };
  }

  return foldBreakerState({
    limit,
    figure: approximateFigureFromCounter(observation, amount, budget._id),
    ...(existingTrip !== undefined ? { existingTrip } : {}),
    rearmOnPeriodRoll: budget.rearmOnPeriodRoll,
    windowStartAt: observation.windowStartAt,
    now,
  });
}

/**
 * Every budget governing a subject, plus its computed state, as a contract
 * `BreakerSnapshot`.
 *
 * EXPORTED BUT PERFORMS NO AUTHORIZATION. Every caller must already have
 * resolved and authorized `orgId` — by Clerk membership or by API key. It takes
 * `orgId` as a parameter rather than deriving it, so there is no path by which
 * it could widen a caller's scope. Shared with convex/budget_gate.ts so the two
 * auth surfaces cannot drift about which budgets apply.
 */
export async function snapshotForSubject(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  subject: {
    projectId?: Id<"projects">;
    agentId?: Id<"agents">;
    agentVersionId?: Id<"agent_versions">;
    runId?: Id<"runs">;
  },
  now: number,
): Promise<BreakerSnapshotEnvelope> {
  const scoped: Array<[string, string | undefined]> = [
    ["org", orgId as string],
    ["project", subject.projectId],
    ["agent", subject.agentId],
    ["agent_version", subject.agentVersionId],
    ["run", subject.runId],
  ];

  const budgets: Array<Doc<"budget_breakers">> = [];
  for (const [scope, scopeId] of scoped) {
    if (scopeId === undefined) continue;
    const rows = await ctx.db
      .query("budget_breakers")
      .withIndex("by_org_scope", (q) =>
        q
          .eq("orgId", orgId)
          .eq("scope", scope as Doc<"budget_breakers">["scope"])
          .eq("scopeId", scopeId),
      )
      .take(MAX_BREAKERS_PER_ORG + 1);
    budgets.push(...rows);
  }

  // A DISABLED BUDGET GOVERNS NOTHING and is excluded from `budgetsInScope`, so
  // it can never be counted as an evaluated breaker. The contract is explicit
  // that this is NOT the same as a budget with a high limit.
  const governing = budgets.filter((b) => b.enabled);
  const evaluable = governing.slice(0, MAX_BREAKERS_PER_ORG);
  const states: BreakerState[] = [];
  for (const budget of evaluable) {
    const { state } = await evaluateBudget(ctx, budget, now);
    states.push(state);
  }

  return buildSnapshot({
    states,
    subject: {
      orgId: orgId as string,
      ...(subject.projectId !== undefined ? { projectId: subject.projectId as string } : {}),
      ...(subject.agentId !== undefined ? { agentId: subject.agentId as string } : {}),
      ...(subject.agentVersionId !== undefined
        ? { agentVersionId: subject.agentVersionId as string }
        : {}),
      ...(subject.runId !== undefined ? { runId: subject.runId as string } : {}),
    },
    budgetsInScope: governing.length,
    budgetsEvaluated: states.length,
    evaluationTruncated: governing.length > evaluable.length,
    now,
  });
}

// ===========================================================================
// THE TRIP SWEEP — persists and audits a breach even when nobody asks
// ===========================================================================

/**
 * Record a trip if this budget is currently breached.
 *
 * WRITES EXACTLY TWO TABLES: `budget_breakers` (patch) and `audit_log` (insert).
 * It appends no event, patches no run, and never touches `runs.status`. That is
 * what makes a period roll — or a trip landing mid-run — incapable of corrupting
 * the append-only log: this code path holds no reference to it.
 *
 * INTERNAL. Evaluation is a bounded scan of up to BUDGET_MAX_RUNS_SCANNED runs,
 * so a public "evaluate now" mutation would be an amplification lever. The cheap
 * public surface is `checkBudget` / `sdkCheckBudget`.
 */
export const recordTripIfBreached = internalMutation({
  args: { budgetId: v.id("budget_breakers"), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const budget = await ctx.db.get(args.budgetId);
    if (!budget) return { evaluated: false as const };

    const now = args.now ?? Date.now();
    const result = await evaluateBudget(ctx, budget, now);

    if (result.transitionedToTripped && result.state.state === "tripped") {
      await ctx.db.patch(args.budgetId, {
        trippedAt: result.state.trippedAt,
        trippedBy: "limit_reached",
        trippedBecause: result.state.trippedBecause,
        // SYSTEM_ACTOR, not a user: "the numbers crossed" is a different fact
        // from "a person decided", and the audit log must tell them apart.
        trippedByUser: SYSTEM_ACTOR,
      });
      const figure = result.state.determinedFrom[0];
      await recordAuditEvent(ctx, {
        orgId: budget.orgId,
        actorClerkUserId: SYSTEM_ACTOR,
        action: "budget.auto_tripped",
        targetType: "budget_breaker",
        targetId: args.budgetId,
        metadata: {
          scope: budget.scope,
          scopeId: budget.scopeId,
          meter: budget.meter,
          period: budget.period,
          limitAmount: budget.limitAmount,
          // The audit row carries its own epistemics, so a reader six months
          // later does not have to know which kind of figure this was.
          spendBasis: figure.basis,
          spendAmount:
            figure.basis === "reconciled" ? figure.reconciledAmount : figure.estimatedAmount,
          couldOverstateBy: figure.basis === "approximate" ? figure.couldOverstateBy : 0,
          couldUnderstateBy: figure.basis === "approximate" ? figure.couldUnderstateBy : 0,
          trippedBecause: result.state.trippedBecause,
        },
      });
    }

    if (result.transitionedOutOfTrip) {
      await ctx.db.patch(args.budgetId, {
        trippedAt: undefined,
        trippedBy: undefined,
        trippedBecause: undefined,
        trippedByUser: undefined,
      });
      await recordAuditEvent(ctx, {
        orgId: budget.orgId,
        actorClerkUserId: SYSTEM_ACTOR,
        action: "budget.reset",
        targetType: "budget_breaker",
        targetId: args.budgetId,
        metadata: { via: "period_roll", previousTrippedAt: budget.trippedAt },
      });
    }

    return { evaluated: true as const, state: result.state };
  },
});

/**
 * Enabled budgets, for the sweep. Ranging on `enabled` keeps disabled ones off it.
 *
 * OVER-FETCHES BY ONE so truncation is a POSITIVE OBSERVATION rather than an
 * inference — the same construction as every other bounded read in this feature.
 */
export const listSweepBudgets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("budget_breakers")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(BUDGET_SWEEP_BATCH + 1);
    const sweepTruncated = rows.length > BUDGET_SWEEP_BATCH;
    return {
      budgetIds: rows.slice(0, BUDGET_SWEEP_BATCH).map((r) => r._id),
      sweepTruncated,
    };
  },
});

/**
 * How close this org is to the sweep's global ceiling.
 *
 * EXISTS SO THE CEILING IS OBSERVABLE BEFORE IT BITES rather than inferable
 * afterwards. The honest caveat is in the return shape: `sweepBatchSize` is
 * GLOBAL across every org, so `enabledInOrg` alone cannot tell an operator
 * whether the sweep is keeping up — only that this org is or is not a large
 * contributor to the pressure. A single org at or near the batch size is
 * definitely a problem; being well under it is not proof of safety.
 *
 * WHAT A LAGGING SWEEP DOES AND DOES NOT COST, since this changed with the
 * refit and the earlier design's answer is no longer right: breaker state is now
 * computed FRESH on every `checkBudget` / `sdkCheckBudget`, which never read the
 * sweep's output. So a lagging sweep CANNOT make an answer stale and CANNOT
 * cause a wave of withholds — that coupling existed only while state was cached
 * on the row. What it costs now is narrower and still real: a breach that nobody
 * happens to query goes UNAUDITED for longer, so `budget.auto_tripped` records
 * when someone next looked rather than when the limit was crossed.
 */
export const getBudgetSweepPressure = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });
    const rows = await ctx.db
      .query("budget_breakers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_BREAKERS_PER_ORG + 1);
    const enabledInOrg = rows.filter((r) => r.enabled).length;
    return {
      enabledInOrg,
      /** GLOBAL across all orgs — see this query's header before reading this as a per-org headroom figure. */
      sweepBatchSize: BUDGET_SWEEP_BATCH,
      sweepCadenceMs: BREAKER_EVALUATION_CADENCE_MS,
      /**
       * What falling behind costs: delayed AUDIT of an unqueried breach. It does
       * not delay or degrade any answer, because answers are computed fresh.
       */
      lagAffects: "audit_latency_only" as const,
    };
  },
});

/**
 * Cron entry point, at the contract's `BREAKER_EVALUATION_CADENCE_MS`.
 *
 * IT DOES NOT GATE ANY ANSWER. `checkBudget` computes state fresh on every call,
 * so a lagging sweep cannot make a check stale or permissive. Its job is to
 * PERSIST AND AUDIT a breach that nobody happened to ask about, so the audit log
 * records when a limit was crossed rather than when someone next looked.
 */
export const sweepBudgetBreakers = internalAction({
  args: {},
  handler: async (ctx) => {
    const { budgetIds, sweepTruncated } = (await ctx.runQuery(_listSweepBudgets, {})) as {
      budgetIds: Array<Id<"budget_breakers">>;
      sweepTruncated: boolean;
    };
    for (const budgetId of budgetIds) {
      await ctx.runMutation(_recordTripIfBreached, { budgetId });
    }
    if (sweepTruncated) {
      // OBSERVABLE, not inferable. Without this the only symptom of outgrowing
      // the batch is that some breaches are audited late, which is invisible.
      // Matches the logging posture of convex/artifact_gc.ts.
      console.warn(
        `Budget sweep: more than ${BUDGET_SWEEP_BATCH} enabled budgets exist across all orgs; ` +
          `only ${budgetIds.length} were checked this tick. Breaches on the remainder will be ` +
          `AUDITED LATE (answers are unaffected — checkBudget computes fresh). Raise ` +
          `BUDGET_SWEEP_BATCH or shorten the sweep interval. See getBudgetSweepPressure.`,
      );
    }
    return { evaluated: budgetIds.length, sweepTruncated };
  },
});

// ===========================================================================
// READ SURFACE
// ===========================================================================

/**
 * Load a budget belonging to the CALLER'S OWN org, or fail exactly as if it did
 * not exist.
 *
 * THE ORDER HERE IS THE TENANCY PROPERTY. The obvious spelling —
 *
 *     const doc = await ctx.db.get(id);
 *     if (!doc) throw NOT_FOUND;
 *     await requireOrgMembership(ctx, doc.orgId);
 *
 * — is a CROSS-ORG EXISTENCE ORACLE: a missing id throws NOT_FOUND while another
 * org's id throws "not a member of this organization", so any caller can probe
 * whether an id exists in someone else's org by reading which error came back.
 * An earlier draft of this file shipped exactly that, and convex/budgets.test.ts
 * caught it by comparing the two OUTCOMES with toEqual rather than merely
 * asserting both threw. AUTHENTICATE FIRST, then scope the lookup to the org the
 * caller is already known to be in — the order convex/failure_patterns.ts uses.
 */
async function loadOwnBudget(
  ctx: QueryCtx | MutationCtx,
  budgetId: Id<"budget_breakers">,
  minimumRole?: "admin" | "member" | "viewer",
): Promise<{ budget: Doc<"budget_breakers">; userId: string }> {
  const { userId, orgId } = await getAuthContext(ctx);
  const budget = await ctx.db.get(budgetId);
  if (!budget || budget.orgId !== orgId) {
    throw afrError("NOT_FOUND", "Budget not found");
  }
  await requireOrgMembership(ctx, orgId, minimumRole !== undefined ? { minimumRole } : undefined);
  return { budget, userId };
}

export const listBudgets = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);
    return await ctx.db
      .query("budget_breakers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_PAGE_SIZE);
  },
});

export const getBudget = query({
  args: { budgetId: v.id("budget_breakers") },
  handler: async (ctx, args) => {
    const { budget } = await loadOwnBudget(ctx, args.budgetId);
    return budget;
  },
});

/**
 * A snapshot for ONE named budget.
 *
 * Exists because per-budget state was otherwise only reachable by requesting the
 * org-subject snapshot and picking the matching state out of it — which forces a
 * caller rendering a single budget's row to fetch and evaluate every budget in
 * the org, and to re-implement the match. The states are field-disjoint by
 * design (`trippedBudgetId` / `armedBudgetId` / `undeterminedBudgetId`), so that
 * matching is exactly the narrowing the contract makes deliberately awkward.
 *
 * STILL A FULL, CONTRACT-VALID SNAPSHOT rather than a bare state: `scan` and
 * `freshUntil` are what let a consumer tell "armed" from "we could not tell",
 * and a bare state would strip precisely the fields `snapshotUnusableFields`
 * needs — the same reason Team C refuses `?fields=` projection on the snapshot
 * route. `budgetsInScope` is 1 for an enabled budget and 0 for a disabled one,
 * because a disabled budget governs nothing.
 */
export async function snapshotForBudget(
  ctx: QueryCtx,
  budget: Doc<"budget_breakers">,
  now: number,
): Promise<BreakerSnapshotEnvelope> {
  const states: BreakerState[] = [];
  if (budget.enabled) {
    const { state } = await evaluateBudget(ctx, budget, now);
    states.push(state);
  }
  return buildSnapshot({
    states,
    subject: {
      orgId: budget.orgId as string,
      ...(budget.scope === "project" ? { projectId: budget.scopeId } : {}),
      ...(budget.scope === "agent" ? { agentId: budget.scopeId } : {}),
      ...(budget.scope === "agent_version" ? { agentVersionId: budget.scopeId } : {}),
      ...(budget.scope === "run" ? { runId: budget.scopeId } : {}),
    },
    budgetsInScope: budget.enabled ? 1 : 0,
    budgetsEvaluated: states.length,
    evaluationTruncated: false,
    now,
  });
}

/**
 * "What do the breakers say?" — the Clerk-authenticated form, for the web UI.
 *
 * Returns a contract `BreakerSnapshot`, computed fresh. The SDK-facing twin is
 * `sdkCheckBudget` in convex/budget_gate.ts and both call `snapshotForSubject`,
 * so they cannot disagree about which budgets govern a subject.
 */
export const checkBudget = query({
  args: {
    orgId: v.id("organizations"),
    /**
     * Narrow to ONE budget. Mutually exclusive with the subject fields below:
     * a budget already knows its own scope, and accepting both would let a
     * caller ask about budget X "as if" it governed subject Y — a question with
     * no meaningful answer that would nonetheless return a confident snapshot.
     */
    budgetId: v.optional(v.id("budget_breakers")),
    projectId: v.optional(v.id("projects")),
    agentId: v.optional(v.id("agents")),
    agentVersionId: v.optional(v.id("agent_versions")),
    runId: v.optional(v.id("runs")),
  },
  handler: async (ctx, args) => {
    await requireOrgMembership(ctx, args.orgId);

    if (args.budgetId !== undefined) {
      if (
        args.projectId !== undefined ||
        args.agentId !== undefined ||
        args.agentVersionId !== undefined ||
        args.runId !== undefined
      ) {
        throw afrError(
          "INVALID_ARGUMENT",
          "budgetId narrows to one budget and cannot be combined with a subject; a budget already carries its own scope.",
        );
      }
      const budget = await ctx.db.get(args.budgetId);
      // Foreign and missing are one indistinguishable outcome, as everywhere else.
      if (!budget || budget.orgId !== args.orgId) {
        throw afrError("NOT_FOUND", "Budget not found");
      }
      return await snapshotForBudget(ctx, budget, Date.now());
    }

    // Every narrowing id is re-checked to belong to the caller's org, and a
    // foreign one yields the identical NOT_FOUND as a missing one — so this
    // surface is not an existence oracle for another org's runs or agents.
    for (const id of [args.projectId, args.agentId, args.agentVersionId, args.runId]) {
      if (id === undefined) continue;
      const doc = await ctx.db.get(id);
      if (!doc || (doc as { orgId?: Id<"organizations"> }).orgId !== args.orgId) {
        throw afrError("NOT_FOUND", "Subject not found");
      }
    }
    return await snapshotForSubject(
      ctx,
      args.orgId,
      {
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
        ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
        ...(args.agentVersionId !== undefined ? { agentVersionId: args.agentVersionId } : {}),
        ...(args.runId !== undefined ? { runId: args.runId } : {}),
      },
      Date.now(),
    );
  },
});

// ===========================================================================
// PRIVILEGED MUTATIONS — admin-only, audited (Event Log Rule 6)
// ===========================================================================

export const createBudget = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    scope: v.union(
      v.literal("org"),
      v.literal("project"),
      v.literal("agent"),
      v.literal("agent_version"),
      v.literal("run"),
    ),
    scopeId: v.string(),
    meter: v.union(
      v.literal("cost_minor_units"),
      v.literal("tokens_in"),
      v.literal("tokens_out"),
      v.literal("runs_started"),
      v.literal("events_ingested"),
    ),
    period: v.union(
      v.literal("run"),
      v.literal("hour"),
      v.literal("day"),
      v.literal("month"),
      v.literal("lifetime"),
    ),
    limitAmount: v.number(),
    currency: v.optional(v.string()),
    rearmOnPeriodRoll: v.optional(v.boolean()),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId } = await getAuthContext(ctx);
    await requireOrgMembership(ctx, args.orgId, { minimumRole: "admin" });
    validateBudgetConfig(args);

    // The governed entity must exist IN THIS ORG. For scope "org" the scopeId is
    // the org's own id; anything else would let a budget name another tenant.
    if (args.scope === "org") {
      if (args.scopeId !== (args.orgId as string)) {
        throw afrError("INVALID_ARGUMENT", 'For scope "org", scopeId must be this organization\'s id');
      }
    } else {
      const doc = await ctx.db.get(args.scopeId as Id<"runs">);
      if (!doc || (doc as { orgId?: Id<"organizations"> }).orgId !== args.orgId) {
        throw afrError("NOT_FOUND", "Subject not found");
      }
    }

    const existing = await ctx.db
      .query("budget_breakers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_BREAKERS_PER_ORG + 1);
    if (existing.length > MAX_BREAKERS_PER_ORG) {
      throw afrError(
        "INVALID_ARGUMENT",
        `At most ${MAX_BREAKERS_PER_ORG} budgets per organization (the contract's snapshot listing bound)`,
      );
    }

    const budgetId = await ctx.db.insert("budget_breakers", {
      orgId: args.orgId,
      scope: args.scope,
      scopeId: args.scopeId,
      meter: args.meter,
      period: args.period,
      limitAmount: args.limitAmount,
      ...(args.currency !== undefined ? { currency: args.currency } : {}),
      name: args.name.trim(),
      enabled: args.enabled ?? true,
      rearmOnPeriodRoll: args.rearmOnPeriodRoll ?? false,
      createdAt: Date.now(),
      createdBy: userId,
    });

    await recordAuditEvent(ctx, {
      orgId: args.orgId,
      actorClerkUserId: userId,
      action: "budget.created",
      targetType: "budget_breaker",
      targetId: budgetId,
      metadata: {
        name: args.name.trim(),
        scope: args.scope,
        scopeId: args.scopeId,
        meter: args.meter,
        period: args.period,
        limitAmount: args.limitAmount,
      },
    });
    return budgetId;
  },
});

/**
 * Change a budget's configuration.
 *
 * A CONFIG CHANGE DOES NOT CLEAR A TRIP. Only `resetBudget` does. Raising a
 * limit is not a decision that the earlier, proven breach did not happen.
 *
 * There is no evaluation to invalidate here — state is computed fresh on every
 * read — which is one of the things storing it back cost the earlier draft.
 */
export const updateBudget = mutation({
  args: {
    budgetId: v.id("budget_breakers"),
    name: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    limitAmount: v.optional(v.number()),
    rearmOnPeriodRoll: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { budget, userId } = await loadOwnBudget(ctx, args.budgetId, "admin");
    validateBudgetConfig(args);

    const patch: Partial<Doc<"budget_breakers">> = {};
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.limitAmount !== undefined) patch.limitAmount = args.limitAmount;
    if (args.rearmOnPeriodRoll !== undefined) patch.rearmOnPeriodRoll = args.rearmOnPeriodRoll;
    await ctx.db.patch(args.budgetId, patch);

    await recordAuditEvent(ctx, {
      orgId: budget.orgId,
      actorClerkUserId: userId,
      action: "budget.updated",
      targetType: "budget_breaker",
      targetId: args.budgetId,
      metadata: {
        before: {
          name: budget.name,
          enabled: budget.enabled,
          limitAmount: budget.limitAmount,
          rearmOnPeriodRoll: budget.rearmOnPeriodRoll,
        },
        after: {
          name: patch.name ?? budget.name,
          enabled: patch.enabled ?? budget.enabled,
          limitAmount: patch.limitAmount ?? budget.limitAmount,
          rearmOnPeriodRoll: patch.rearmOnPeriodRoll ?? budget.rearmOnPeriodRoll,
        },
      },
    });
  },
});

export const deleteBudget = mutation({
  args: { budgetId: v.id("budget_breakers") },
  handler: async (ctx, args) => {
    const { budget, userId } = await loadOwnBudget(ctx, args.budgetId, "admin");
    // The row goes; THE AUDIT ROWS DO NOT. Deleting a tripped budget is the
    // obvious way to make a breaker stop withholding, so the trail that it
    // existed, tripped and was removed must outlive it. audit_log has no delete
    // path (ADR 001 / convex/audit.ts).
    await ctx.db.delete(args.budgetId);
    await recordAuditEvent(ctx, {
      orgId: budget.orgId,
      actorClerkUserId: userId,
      action: "budget.deleted",
      targetType: "budget_breaker",
      targetId: args.budgetId,
      metadata: {
        name: budget.name,
        limitAmount: budget.limitAmount,
        wasTrippedAt: budget.trippedAt,
      },
    });
  },
});

// ===========================================================================
// THE APPLY CORE — ONE implementation, TWO auth front doors
//
// `tripBudget`/`resetBudget` (Clerk) and `sdkTripBudget`/`sdkResetBudget`
// (API key, convex/budget_gate.ts) differ ONLY in how they establish the actor
// and their authority. The state change and the audit row are written HERE,
// once. Two copies of a privileged, audited write is the drift this repository
// has now paid for three times over in the budget vocabulary alone; there is no
// version of "keep them in sync" that survives a year.
//
// EVERY CALLER MUST HAVE ALREADY AUTHORIZED THE ACTOR. These functions perform
// no authorization: they take an `actorId` that a front door has established
// and a `budget` it has already scoped to the actor's org.
// ===========================================================================

/** The contract's `BudgetMutationResult`. `auditLogId` is the receipt an operator can cite. */
export interface BudgetMutationOutcome {
  budgetId: string;
  auditLogId: string;
  appliedAt: number;
}

/**
 * REQUIRED, non-empty justification for a privileged budget mutation.
 *
 * The contract's `ManualTripRequest.reason` / `ManualResetRequest.reason` are
 * required and non-empty, and this backend now agrees. It previously typed this
 * as an optional `note`, so the two disagreed and only the web boundary was
 * holding the line — a gate one layer above the write, which is exactly the
 * arrangement that fails the first time anything else calls the mutation.
 *
 * Rejected rather than defaulted: a synthesised reason ("no reason given") is
 * indistinguishable in the audit log from one a human actually wrote, and the
 * whole point of the field is that somebody had to state why.
 */
function validateReason(reason: string): string {
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
 * Apply a manual trip. Writes `budget_breakers` and `audit_log`, nothing else.
 *
 * `reason` is OPERATOR TEXT: stored verbatim under `operatorNote`, and never
 * composed into the system's own `trippedBecause`. The execution-claim guard
 * applies to our voice, not to a human's account of what they did.
 */
export async function applyTrip(
  ctx: MutationCtx,
  budget: Doc<"budget_breakers">,
  actorId: string,
  reason: string,
  via: "clerk" | "api_key",
): Promise<BudgetMutationOutcome> {
  const appliedAt = Date.now();
  await ctx.db.patch(budget._id, {
    trippedAt: appliedAt,
    trippedBy: "manual_trip",
    trippedByUser: actorId,
    operatorNote: reason,
    trippedBecause: assertNoExecutionClaim(
      `This breaker was tripped manually by an operator at ${new Date(appliedAt).toISOString()}. No spend measurement was involved in the transition.`,
      "applyTrip",
    ),
  });
  const auditLogId = await recordAuditEvent(ctx, {
    orgId: budget.orgId,
    actorClerkUserId: actorId,
    action: "budget.tripped",
    targetType: "budget_breaker",
    targetId: budget._id,
    metadata: {
      manual: true,
      via,
      limitAmount: budget.limitAmount,
      meter: budget.meter,
      // Namespaced so a reader never mistakes an operator's words for a system finding.
      operatorNote: reason,
    },
  });
  return { budgetId: budget._id, auditLogId, appliedAt };
}

/**
 * Apply an operator reset: clear the trip and begin a new accounting period.
 *
 * `resetAt` advances the window start for EVERY period. Without it, resetting a
 * budget whose window still contains the breaching spend re-trips it on the very
 * next evaluation, and "reset" is a button that appears broken.
 */
export async function applyReset(
  ctx: MutationCtx,
  budget: Doc<"budget_breakers">,
  actorId: string,
  reason: string,
  via: "clerk" | "api_key",
): Promise<BudgetMutationOutcome> {
  const appliedAt = Date.now();
  await ctx.db.patch(budget._id, {
    trippedAt: undefined,
    trippedBy: undefined,
    trippedBecause: undefined,
    trippedByUser: undefined,
    resetAt: appliedAt,
    resetBy: actorId,
    operatorNote: reason,
  });
  const auditLogId = await recordAuditEvent(ctx, {
    orgId: budget.orgId,
    actorClerkUserId: actorId,
    action: "budget.reset",
    targetType: "budget_breaker",
    targetId: budget._id,
    metadata: {
      via: "operator",
      authenticatedBy: via,
      previousTrippedAt: budget.trippedAt,
      previousTrippedBy: budget.trippedBy,
      // A reset discards evidence from the accounting window; the audit log is
      // where the discarded fact has to survive.
      newWindowStartsAt: appliedAt,
      operatorNote: reason,
    },
  });
  return { budgetId: budget._id, auditLogId, appliedAt };
}

/**
 * Trip a budget by hand. MEMBER-PERMITTED, deliberately, and this is the one
 * asymmetry in this file's authorization.
 *
 * TRIPPING IS THE SAFE DIRECTION: it withholds, it stops nothing that was not
 * already going to be reported, and its cost is delay. RESETTING IS THE
 * DANGEROUS DIRECTION: it clears a proven breach and starts a fresh accounting
 * period, so a mistake there resumes unbounded spend. Requiring an admin to be
 * awake before anyone can pull the cord is the wrong constraint at 3am — the
 * risk is not symmetric and the roles should not be either.
 *
 * So: `tripBudget` is member+, and `resetBudget` / `createBudget` /
 * `updateBudget` / `deleteBudget` are admin-only. Both directions are audited
 * with the actor's own id either way, so a member tripping a fleet-wide budget
 * is a recorded, attributable act rather than an anonymous one.
 *
 * Audited as `budget.tripped` under the operator's Clerk id — distinct from the
 * sweep's `budget.auto_tripped` under SYSTEM_ACTOR — so the append-only audit log
 * can always answer whether a person decided or the numbers crossed.
 *
 * `note` is OPERATOR TEXT: stored verbatim, under a field named to say so, and
 * never composed into a system statement. The execution-claim guard applies to
 * our voice; censoring a human's account of what they did would be a worse
 * dishonesty than the one it prevents.
 */
export const tripBudget = mutation({
  args: { budgetId: v.id("budget_breakers"), reason: v.string() },
  handler: async (ctx, args): Promise<BudgetMutationOutcome> => {
    // MEMBER, not admin — see this mutation's header. Tripping withholds; only
    // resetting resumes spend.
    const { budget, userId } = await loadOwnBudget(ctx, args.budgetId, "member");
    return await applyTrip(ctx, budget, userId, validateReason(args.reason), "clerk");
  },
});

/**
 * Clear a trip and begin a new accounting period at this instant.
 *
 * `resetAt` advances the window start for EVERY period. Without that, resetting
 * a budget whose window still contains the breaching spend re-trips it on the
 * very next evaluation, and "reset" is a button that appears broken — from which
 * an operator would reasonably conclude the original trip was spurious.
 */
export const resetBudget = mutation({
  args: { budgetId: v.id("budget_breakers"), reason: v.string() },
  handler: async (ctx, args): Promise<BudgetMutationOutcome> => {
    const { budget, userId } = await loadOwnBudget(ctx, args.budgetId, "admin");
    return await applyReset(ctx, budget, userId, validateReason(args.reason), "clerk");
  },
});
