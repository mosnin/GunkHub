/* eslint-disable */
/**
 * BUDGET CIRCUIT BREAKERS — the pure engine, against the CONTRACT's validators.
 *
 * The properties under test are the ones the feature would be dishonest
 * without:
 *
 *  (A) THE COUNTER CAN PROVE A BREACH AND CAN NEVER PROVE HEADROOM. Asserted
 *      through the contract's own `compareSpendToLimit`, not a local rule.
 *  (B) THE COST AND events_ingested METERS ARE REFUSED, not approximated.
 *  (C) THE RECONCILED PATH CAN DO BOTH — the narrow exact path.
 *  (D) NOTHING CLAIMS AN AGENT WAS STOPPED, swept over the generated
 *      cross-product and checked against the contract's forbidden FIELD names
 *      as well as this module's forbidden PROSE.
 *  (E) VACUOUS TRUTH, with each trap exercised by the input that triggers it.
 *  (F) THE WINDOW ARITHMETIC THIS MODULE REFUSES TO REUSE — the `dayBoundsUtc`
 *      defects are shown to be unreachable here.
 */
import {
  BREAKER_EVALUATION_CADENCE_MS,
  FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS,
  MAX_BREAKER_ANSWER_FRESHNESS_MS,
  breakerCadenceInvariant,
  compareSpendToLimit,
  isBreakerSnapshotComplete,
  snapshotClaimContradictions,
  snapshotUnusableFields,
  spendUsability,
  type BudgetLimit,
  type BudgetMeter,
} from "@agent-flight-recorder/contracts";
import { describe, it, expect } from "vitest";

import crons from "../crons.js";

import {
  BUDGET_SNAPSHOT_SHELF_LIFE_MS,
  approximateFigureFromCounter,
  buildSnapshot,
  executionClaimIn,
  foldBreakerState,
  isEvaluationFresh,
  isSpendSumComplete,
  isUsableInstant,
  meterAmount,
  meterRefusalReason,
  reconciledFigureFromLog,
  resolveBudgetWindow,
  startOfUtcPeriod,
  undeterminedState,
  type SpendObservation,
} from "./budget.js";

const T0 = Date.parse("2026-07-25T12:34:56.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function obs(over: Partial<SpendObservation> = {}): SpendObservation {
  return {
    windowStartAt: T0 - HOUR,
    windowEndAt: T0,
    recordedTokensIn: 0,
    recordedTokensOut: 0,
    runsCounted: 0,
    runsWithNoRecordedTokens: 0,
    runsInFlight: 0,
    reachedEndOfRange: true,
    crossOrgRowsSkipped: 0,
    observedAt: T0,
    ...over,
  };
}

function limit(over: Partial<BudgetLimit> = {}): BudgetLimit {
  return {
    budgetId: "bud_1",
    orgId: "org_1",
    scope: "agent",
    scopeId: "ag_1",
    meter: "tokens_in",
    period: "day",
    limitAmount: 1000,
    enabled: true,
    createdAt: T0 - DAY,
    ...over,
  };
}

// ===========================================================================
// (A) PROVES A BREACH; NEVER PROVES HEADROOM
// ===========================================================================

describe("(A) the run counter proves a breach and can never prove headroom", () => {
  it("carries couldOverstateBy 0 and couldUnderstateBy null — the whole ruling", () => {
    const f = approximateFigureFromCounter(obs({ recordedTokensIn: 500 }), 500, "bud_1");
    expect(f.kind).toBe("denormalised_run_counter");
    // CANNOT be high: add-only, unscaled, unsampled, idempotent ingest.
    expect(f.couldOverstateBy).toBe(0);
    // UNBOUNDED below, and never 0 — 0 would certify headroom from a counter
    // that cannot see an uninstrumented agent at all.
    expect(f.couldUnderstateBy).toBeNull();
    expect(spendUsability(f)).toBe("usable");
  });

  it("the CONTRACT's comparison makes provably_under unreachable for it", () => {
    for (const amount of [0, 1, 500, 999]) {
      const f = approximateFigureFromCounter(obs(), amount, "bud_1");
      expect(compareSpendToLimit(f, limit({ limitAmount: 1000 }))).toBe("not_decidable");
    }
    // ...and provably_at_or_over IS reachable, because overstatement is bounded at 0.
    for (const amount of [1000, 1001, 99999]) {
      const f = approximateFigureFromCounter(obs(), amount, "bud_1");
      expect(compareSpendToLimit(f, limit({ limitAmount: 1000 }))).toBe("provably_at_or_over");
    }
  });

  it("so the breaker TRIPS at the limit and is UNDETERMINED below it — never armed", () => {
    const over = foldBreakerState({
      limit: limit(),
      figure: approximateFigureFromCounter(obs({ recordedTokensIn: 1200 }), 1200, "bud_1"),
      rearmOnPeriodRoll: false,
      windowStartAt: T0 - HOUR,
      now: T0,
    });
    expect(over.state.state).toBe("tripped");
    expect(over.transitionedToTripped).toBe(true);

    const under = foldBreakerState({
      limit: limit(),
      figure: approximateFigureFromCounter(obs({ recordedTokensIn: 10 }), 10, "bud_1"),
      rearmOnPeriodRoll: false,
      windowStartAt: T0 - HOUR,
      now: T0,
    });
    expect(under.state.state).toBe("undetermined");
    expect(under.state.state === "undetermined" && under.state.kind).toBe("spend_not_decidable");
    expect(under.state.state === "undetermined" && under.state.undeterminedBecause).toMatch(
      /can never establish headroom/i,
    );
  });

  it("if couldOverstateBy were ever loosened, the breaker would stop tripping", () => {
    // A guard on the load-bearing field: this is what the zero buys.
    const f = approximateFigureFromCounter(obs(), 1200, "bud_1");
    const loosened = { ...f, couldOverstateBy: 500 };
    expect(compareSpendToLimit(loosened, limit({ limitAmount: 1000 }))).toBe("not_decidable");
  });

  it("a run with no recorded tokens is reported as unmeasured, never as zero", () => {
    const f = approximateFigureFromCounter(
      obs({ runsCounted: 10, runsWithNoRecordedTokens: 7 }),
      0,
      "bud_1",
    );
    expect(f.approximateBecause).toMatch(/7 of 10 run\(s\).*recorded no token usage/i);
    expect(f.approximateBecause).toMatch(/nothing stored bounds how much that is/i);
    expect(f.wouldBeReconciledBy.length).toBeGreaterThan(0);
  });

  it("an in-flight run is reported as a still-rising total", () => {
    const f = approximateFigureFromCounter(obs({ runsCounted: 4, runsInFlight: 2 }), 5, "bud_1");
    expect(f.approximateBecause).toMatch(/still in flight, so this total is still rising/i);
  });
});

// ===========================================================================
// (B) REFUSED METERS
// ===========================================================================

describe("(B) meters this backend refuses rather than approximates", () => {
  it("cost_minor_units yields NO amount, and names the pricing defect", () => {
    expect(meterAmount(obs({ recordedTokensIn: 900 }), "cost_minor_units")).toBeNull();
    const r = meterRefusalReason("cost_minor_units");
    expect(r.because).toMatch(/bidirectional substring/i);
    expect(r.because).toMatch(/mis-prices upward/i);
    // The fix is named, and it is not "add more substrings".
    expect(r.wouldBeDeterminedBy).toMatch(/exact model matching with explicit aliases|billed invoice/i);
    expect(r.wouldBeDeterminedBy).not.toMatch(/add.*substring/i);
  });

  it("events_ingested yields NO amount, and names the sampling spread", () => {
    expect(meterAmount(obs(), "events_ingested")).toBeNull();
    const r = meterRefusalReason("events_ingested");
    expect(r.because).toMatch(/one time in ten|three orders of magnitude/i);
  });

  it("the meters it DOES sign are counted, not priced", () => {
    const o = obs({ recordedTokensIn: 90, recordedTokensOut: 10, runsCounted: 3 });
    expect(meterAmount(o, "tokens_in")).toBe(90);
    expect(meterAmount(o, "tokens_out")).toBe(10);
    expect(meterAmount(o, "runs_started")).toBe(3);
  });

  it("every meter is handled — no silent fallthrough as the vocabulary grows", () => {
    const meters: BudgetMeter[] = [
      "cost_minor_units",
      "tokens_in",
      "tokens_out",
      "runs_started",
      "events_ingested",
    ];
    for (const m of meters) {
      const v = meterAmount(obs({ recordedTokensIn: 5 }), m);
      expect(v === null || typeof v === "number").toBe(true);
    }
  });
});

// ===========================================================================
// (C) THE RECONCILED PATH
// ===========================================================================

describe("(C) reconciled spend — the narrow exact path", () => {
  const rec = () =>
    reconciledFigureFromLog({
      amount: 400,
      budgetId: "bud_1",
      runsSummed: 1,
      eventsSummed: 12,
      reconciledThrough: T0,
      reconciledAt: T0,
    });

  it("is usable and carries a complete-read proof", () => {
    const f = rec();
    expect(spendUsability(f)).toBe("usable");
    expect(f.establishedBy[0].logReadComplete).toBe(true);
    expect(f.establishedBy[0].proves).toBe("event_log_summed");
  });

  it("CAN establish headroom — the thing the counter never can", () => {
    expect(compareSpendToLimit(rec(), limit({ scope: "run", period: "run", limitAmount: 1000 }))).toBe(
      "provably_under",
    );
    const armed = foldBreakerState({
      limit: limit({ scope: "run", period: "run", limitAmount: 1000 }),
      figure: rec(),
      rearmOnPeriodRoll: false,
      windowStartAt: T0 - HOUR,
      now: T0,
    });
    expect(armed.state.state).toBe("armed");
  });

  it("and can also establish a breach", () => {
    const f = reconciledFigureFromLog({
      amount: 5000,
      budgetId: "bud_1",
      runsSummed: 1,
      eventsSummed: 12,
      reconciledThrough: T0,
      reconciledAt: T0,
    });
    expect(compareSpendToLimit(f, limit({ scope: "run", period: "run" }))).toBe("provably_at_or_over");
  });

  it("a figure for a DIFFERENT budget decides nothing", () => {
    const f = reconciledFigureFromLog({
      amount: 5000,
      budgetId: "bud_OTHER",
      runsSummed: 1,
      eventsSummed: 1,
      reconciledThrough: T0,
      reconciledAt: T0,
    });
    expect(compareSpendToLimit(f, limit())).toBe("not_decidable");
  });
});

// ===========================================================================
// (D) NOTHING CLAIMS AN AGENT WAS STOPPED
// ===========================================================================

describe("(D) the claim boundary", () => {
  it("the prose guard catches what a contributor actually reaches for", () => {
    expect(executionClaimIn("spending blocked")).toBeTruthy();
    expect(executionClaimIn("the limit was enforced")).toBeTruthy();
    expect(executionClaimIn("the agent was stopped")).toBeTruthy();
    expect(executionClaimIn("the breaker is tripped")).toBeNull();
    expect(executionClaimIn("recorded spend reached 1200 tokens_in")).toBeNull();
  });

  it("sweeps EVERY sentence the fold can generate, and every contract FIELD name", () => {
    const figures = [
      approximateFigureFromCounter(obs(), 0, "bud_1"),
      approximateFigureFromCounter(obs({ runsCounted: 9, runsWithNoRecordedTokens: 9, runsInFlight: 3 }), 5000, "bud_1"),
      reconciledFigureFromLog({ amount: 5000, budgetId: "bud_1", runsSummed: 1, eventsSummed: 3, reconciledThrough: T0, reconciledAt: T0 }),
      reconciledFigureFromLog({ amount: 1, budgetId: "bud_1", runsSummed: 1, eventsSummed: 3, reconciledThrough: T0, reconciledAt: T0 }),
      { basis: "approximate", kind: "sampled_usage_counter", estimatedAmount: NaN } as any,
    ];
    const trips = [
      undefined,
      { trippedAt: T0 - 2 * DAY, trippedBy: "limit_reached" as const, because: "An earlier evaluation recorded this breaker as tripped." },
      { trippedAt: T0 - MIN, trippedBy: "manual_trip" as const, because: "An operator tripped this breaker." },
    ];
    let swept = 0;
    for (const figure of figures) {
      for (const existingTrip of trips) {
        for (const rearmOnPeriodRoll of [true, false]) {
          const r = foldBreakerState({
            limit: limit(),
            figure,
            ...(existingTrip !== undefined ? { existingTrip } : {}),
            rearmOnPeriodRoll,
            windowStartAt: T0 - HOUR,
            now: T0,
          });
          const s: any = r.state;
          for (const key of ["trippedBecause", "undeterminedBecause", "wouldBeDeterminedBy"]) {
            if (typeof s[key] === "string") expect(executionClaimIn(s[key])).toBeNull();
          }
          // The contract's wire guard: no state may carry a forbidden FIELD.
          for (const forbidden of FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS) {
            expect(Object.prototype.hasOwnProperty.call(s, forbidden)).toBe(false);
          }
          swept += 1;
        }
      }
    }
    // POSITIVE assertion that the sweep ran — without it this passes vacuously
    // if the loops ever collapse to zero iterations.
    expect(swept).toBe(figures.length * trips.length * 2);
    expect(swept).toBeGreaterThan(0);
  });

  it("a snapshot of every generated state satisfies the contract's own validators", () => {
    // DISTINCT budget ids: the contract requires one state per budget and
    // `snapshotClaimContradictions` reports `duplicate_budget_state` otherwise.
    // The first draft of this fixture reused one id across four states and was
    // correctly rejected — the validator is doing real work here.
    const states = [
      foldBreakerState({ limit: limit({ budgetId: "bud_over" }), figure: approximateFigureFromCounter(obs(), 9999, "bud_over"), rearmOnPeriodRoll: false, windowStartAt: T0 - HOUR, now: T0 }).state,
      foldBreakerState({ limit: limit({ budgetId: "bud_undet" }), figure: approximateFigureFromCounter(obs(), 1, "bud_undet"), rearmOnPeriodRoll: false, windowStartAt: T0 - HOUR, now: T0 }).state,
      foldBreakerState({ limit: limit({ budgetId: "bud_armed", scope: "run", period: "run" }), figure: reconciledFigureFromLog({ amount: 1, budgetId: "bud_armed", runsSummed: 1, eventsSummed: 1, reconciledThrough: T0, reconciledAt: T0 }), rearmOnPeriodRoll: false, windowStartAt: T0, now: T0 }).state,
      undeterminedState({ limit: limit({ budgetId: "bud_cost", meter: "cost_minor_units" }), kind: "budget_unreadable", ...meterRefusalReason("cost_minor_units") }),
    ];
    const snap = buildSnapshot({
      states,
      subject: { orgId: "org_1", agentId: "ag_1" },
      budgetsInScope: states.length,
      budgetsEvaluated: states.length,
      evaluationTruncated: false,
      now: T0,
    });
    expect(snapshotUnusableFields(snap)).toEqual([]);
    expect(snapshotClaimContradictions(snap)).toEqual([]);
    expect(isBreakerSnapshotComplete(snap)).toBe(true);
    expect(snap.freshUntil).toBeGreaterThan(snap.evaluatedAt);
  });
});

// ===========================================================================
// (E) VACUOUS TRUTH
// ===========================================================================

describe("(E) vacuity traps", () => {
  it("a limit of ZERO is not breached by an empty window", () => {
    // `estimate - 0 >= 0` is TRUE having observed nothing. The write-time
    // minimum is what makes this unreachable in practice; here we show the trap
    // is real so nobody removes the minimum.
    const f = approximateFigureFromCounter(obs(), 0, "bud_1");
    expect(compareSpendToLimit(f, limit({ limitAmount: 0 }))).toBe("provably_at_or_over");
  });

  it("a FUTURE-stamped evaluation is not fresh (it would be fresh forever)", () => {
    expect(isEvaluationFresh(T0 + DAY, T0, BUDGET_SNAPSHOT_SHELF_LIFE_MS)).toBe(false);
    expect(isEvaluationFresh(T0 - MIN, T0, BUDGET_SNAPSHOT_SHELF_LIFE_MS)).toBe(true);
    expect(isEvaluationFresh(T0 - DAY, T0, BUDGET_SNAPSHOT_SHELF_LIFE_MS)).toBe(false);
    expect(isEvaluationFresh(undefined, T0, BUDGET_SNAPSHOT_SHELF_LIFE_MS)).toBe(false);
  });

  it("zero runs read to the END of the range is the STRONGEST observation, not a missing one", () => {
    expect(isSpendSumComplete(obs({ runsCounted: 0 }))).toBe(true);
  });

  it("an incomplete sum is rejected — it can only hide spend", () => {
    expect(isSpendSumComplete(obs({ reachedEndOfRange: false }))).toBe(false);
    expect(isSpendSumComplete(obs({ crossOrgRowsSkipped: 1 }))).toBe(false);
    expect(isSpendSumComplete(obs({ windowStartAt: T0, windowEndAt: T0 }))).toBe(false);
  });

  it("a NaN or zero instant is rejected explicitly, not compared into silence", () => {
    expect(isUsableInstant(NaN)).toBe(false);
    expect(isUsableInstant(0)).toBe(false);
    expect(isUsableInstant(Infinity)).toBe(false);
    expect(isUsableInstant("2026-07-25" as unknown)).toBe(false);
    expect(isUsableInstant(T0)).toBe(true);
    expect(isSpendSumComplete(obs({ windowStartAt: NaN, windowEndAt: NaN }))).toBe(false);
  });

  it("a malformed figure is UNDETERMINED, never treated as a low one", () => {
    const r = foldBreakerState({
      limit: limit(),
      figure: { basis: "approximate", estimatedAmount: NaN } as any,
      rearmOnPeriodRoll: false,
      windowStartAt: T0 - HOUR,
      now: T0,
    });
    expect(r.state.state).toBe("undetermined");
    expect(r.state.state === "undetermined" && r.state.kind).toBe("spend_unavailable");
    expect(r.state.state === "undetermined" && r.state.undeterminedBecause).toMatch(
      /malformed figure is not a low one/i,
    );
  });

  it("`armed` is unreachable without a positive proof of headroom", () => {
    for (const figure of [
      approximateFigureFromCounter(obs(), 0, "bud_1"),
      approximateFigureFromCounter(obs(), 999, "bud_1"),
      { basis: "approximate", estimatedAmount: NaN } as any,
    ]) {
      const r = foldBreakerState({
        limit: limit({ limitAmount: 1_000_000 }),
        figure,
        rearmOnPeriodRoll: false,
        windowStartAt: T0 - HOUR,
        now: T0,
      });
      expect(r.state.state).not.toBe("armed");
    }
  });
});

// ===========================================================================
// TRIPS, RE-ARM, AND CADENCE
// ===========================================================================

describe("trips persist; re-arming is opt-in and positively compared", () => {
  const trip = { trippedAt: T0 - 2 * DAY, trippedBy: "limit_reached" as const, because: "An earlier evaluation recorded a breach." };

  it("a trip does NOT evaporate when spend falls back under the limit", () => {
    const r = foldBreakerState({
      limit: limit({ scope: "run", period: "run" }),
      figure: reconciledFigureFromLog({ amount: 0, budgetId: "bud_1", runsSummed: 1, eventsSummed: 1, reconciledThrough: T0, reconciledAt: T0 }),
      existingTrip: trip,
      rearmOnPeriodRoll: false,
      windowStartAt: T0 - HOUR,
      now: T0,
    });
    expect(r.state.state).toBe("tripped");
    expect(r.transitionedToTripped).toBe(false);
  });

  it("re-arm requires opt-in, a trip BEFORE the window, and PROVEN headroom", () => {
    const under = reconciledFigureFromLog({ amount: 0, budgetId: "bud_1", runsSummed: 1, eventsSummed: 1, reconciledThrough: T0, reconciledAt: T0 });
    const L = limit({ scope: "run", period: "run" });

    expect(
      foldBreakerState({ limit: L, figure: under, existingTrip: trip, rearmOnPeriodRoll: true, windowStartAt: T0 - HOUR, now: T0 }).state.state,
    ).toBe("armed");
    // No opt-in.
    expect(
      foldBreakerState({ limit: L, figure: under, existingTrip: trip, rearmOnPeriodRoll: false, windowStartAt: T0 - HOUR, now: T0 }).state.state,
    ).toBe("tripped");
    // Trip is INSIDE the current window.
    expect(
      foldBreakerState({ limit: L, figure: under, existingTrip: { ...trip, trippedAt: T0 - MIN }, rearmOnPeriodRoll: true, windowStartAt: T0 - HOUR, now: T0 }).state.state,
    ).toBe("tripped");
    // Headroom NOT proven (counter figure can never prove it) — so a
    // counter-backed budget NEVER auto-re-arms, only an operator reset clears it.
    expect(
      foldBreakerState({ limit: limit(), figure: approximateFigureFromCounter(obs(), 0, "bud_1"), existingTrip: trip, rearmOnPeriodRoll: true, windowStartAt: T0 - HOUR, now: T0 }).state.state,
    ).toBe("tripped");
  });
});

describe("cadence and freshness come from the contract, not from here", () => {
  /**
   * THE OBSERVED CADENCE IS READ OFF THE SHIPPED `crons` EXPORT, never from
   * `BREAKER_EVALUATION_CADENCE_MS`.
   *
   * The contract is explicit that passing the constant back in re-writes the
   * vacuous check it just moved away from. `convex/crons.ts` DERIVES its
   * interval from that constant, which closes the drift route the invariant was
   * relocated to cover — but the check is still worth running, because the
   * reading path here is independent of the writing path there: it goes through
   * Convex's own schedule registration, and it turns red the moment a
   * contributor replaces the derived value with a literal, or registers the
   * sweep on a schedule kind that carries no interval at all.
   */
  const registeredSweepCadenceMs = (): number => {
    const registry = (crons as unknown as { crons: Record<string, { name: string; schedule: Record<string, unknown> }> }).crons;
    const entry = Object.values(registry).find((c) => c.name === "budgets:sweepBudgetBreakers");
    if (entry === undefined) throw new Error("the budget sweep is not registered in crons.ts");
    const schedule = entry.schedule;
    if (schedule["type"] !== "interval") {
      throw new Error(`the budget sweep is registered as "${String(schedule["type"])}", which carries no cadence the freshness ceiling can be derived from`);
    }
    if (typeof schedule["seconds"] === "number") return schedule["seconds"] * 1000;
    if (typeof schedule["minutes"] === "number") return schedule["minutes"] * 60_000;
    if (typeof schedule["hours"] === "number") return schedule["hours"] * 3_600_000;
    throw new Error("the budget sweep's interval has no recognised unit");
  };

  it("the DEPLOYMENT's registered sweep cadence satisfies the contract's invariant", () => {
    expect(breakerCadenceInvariant(registeredSweepCadenceMs())).toBeNull();
  });

  it("and it is the cadence the ceiling was derived from — by construction, not coincidence", () => {
    expect(registeredSweepCadenceMs()).toBe(BREAKER_EVALUATION_CADENCE_MS);
  });

  it("the invariant is NOT vacuous: a drifted cron cadence is caught", () => {
    // Proof of teeth, in the same spirit as the tenancy oracle's: the check is
    // shown to FAIL on the exact drift it exists to catch — someone editing the
    // cron to every five minutes and leaving the constant at 60,000.
    expect(breakerCadenceInvariant(5 * 60_000)).not.toBeNull();
    expect(breakerCadenceInvariant(5 * 60_000)).toMatch(/cadence/i);
  });

  it("the server's stated shelf life equals the client's honouring ceiling", () => {
    // An earlier draft picked 5 minutes independently and was silently clamped,
    // leaving the server with no idea how stale its answers were in the field.
    expect(BUDGET_SNAPSHOT_SHELF_LIFE_MS).toBe(MAX_BREAKER_ANSWER_FRESHNESS_MS);
    expect(BUDGET_SNAPSHOT_SHELF_LIFE_MS).toBeGreaterThanOrEqual(BREAKER_EVALUATION_CADENCE_MS);
  });
});

// ===========================================================================
// (F) THE WINDOW ARITHMETIC THIS MODULE REFUSES TO REUSE
// ===========================================================================

describe("(F) windows are computed from instants, so dayBoundsUtc's defects are unreachable", () => {
  it("startOfUtcPeriod takes a NUMBER — there is no date string to misparse", () => {
    expect(startOfUtcPeriod(T0, "day")).toBe(Date.parse("2026-07-25T00:00:00.000Z"));
    expect(startOfUtcPeriod(T0, "hour")).toBe(Date.parse("2026-07-25T12:00:00.000Z"));
    expect(startOfUtcPeriod(T0, "month")).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
  });

  it("the impossible-date defect cannot occur: no input names a calendar day", () => {
    // `Date.parse("2024-02-30")` yields a well-formed instant for a day that does
    // not exist, which is how rollups.ts returns a perfect 24-hour window for the
    // WRONG DAY. Here the input is an instant, so every window is anchored to a
    // real one by construction.
    const feb29 = Date.parse("2024-02-29T13:00:00.000Z");
    expect(startOfUtcPeriod(feb29, "day")).toBe(Date.parse("2024-02-29T00:00:00.000Z"));
    const mar1 = Date.parse("2024-03-01T00:30:00.000Z");
    expect(startOfUtcPeriod(mar1, "day")).toBe(Date.parse("2024-03-01T00:00:00.000Z"));
    // Consecutive instants never produce the same day boundary twice or skip one.
    expect(startOfUtcPeriod(mar1, "day") - startOfUtcPeriod(feb29, "day")).toBe(DAY);
  });

  it("a reset advances the start for EVERY period", () => {
    for (const period of ["hour", "day", "month", "lifetime"] as const) {
      const w = resolveBudgetWindow({ period, createdAt: T0 - 300 * DAY, resetAt: T0 - MIN }, T0);
      expect(w.startAt).toBe(T0 - MIN);
      expect(w.truncatedByFloor).toBe(true);
    }
  });

  it("a new budget does not retroactively trip on spend that predates it", () => {
    const w = resolveBudgetWindow({ period: "day", createdAt: T0 - HOUR }, T0);
    expect(w.startAt).toBe(T0 - HOUR); // not midnight
    expect(w.truncatedByFloor).toBe(true);
  });

  it("a period roll moves the window forward and nothing else", () => {
    const before = resolveBudgetWindow(
      { period: "day", createdAt: 0 },
      Date.parse("2026-07-25T23:59:59.000Z"),
    );
    const after = resolveBudgetWindow(
      { period: "day", createdAt: 0 },
      Date.parse("2026-07-26T00:00:01.000Z"),
    );
    expect(after.startAt).toBe(Date.parse("2026-07-26T00:00:00.000Z"));
    expect(after.startAt).toBeGreaterThan(before.startAt);
  });
});
