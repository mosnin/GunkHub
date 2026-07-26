import { describe, it, expect } from "vitest";

import {
  computeRunStats,
  bucketByDay,
  compareCohorts,
  type RunSummary,
} from "./analytics";

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
    status: "completed",
    startedAt: BASE,
    endedAt: BASE + 1000,
    ...overrides,
  };
}

describe("computeRunStats", () => {
  it("handles an empty run list", () => {
    const stats = computeRunStats([]);
    expect(stats.totalRuns).toBe(0);
    expect(stats.failureRate).toBeNull();
    expect(stats.terminalRunCount).toBe(0);
    expect(stats.durationMs.sampleSize).toBe(0);
    expect(stats.durationMs.p50).toBeNull();
    expect(stats.tokensInSum).toBe(0);
    expect(stats.tokensOutSum).toBe(0);
  });

  it("handles a single run", () => {
    const stats = computeRunStats([run({ status: "completed", startedAt: 0, endedAt: 100 })]);
    expect(stats.totalRuns).toBe(1);
    expect(stats.failureRate).toBe(0);
    expect(stats.durationMs.p50).toBe(100);
    expect(stats.durationMs.p99).toBe(100);
    expect(stats.durationMs.sampleSize).toBe(1);
  });

  it("computes failure rate over ALL-FAILED runs", () => {
    const stats = computeRunStats([
      run({ status: "failed" }),
      run({ status: "failed" }),
      run({ status: "timed_out" }),
    ]);
    expect(stats.failureRate).toBe(1);
    expect(stats.terminalRunCount).toBe(3);
  });

  it("excludes pending/running runs from the failure-rate denominator", () => {
    const stats = computeRunStats([
      run({ status: "pending", endedAt: undefined }),
      run({ status: "running", endedAt: undefined }),
      run({ status: "completed" }),
    ]);
    expect(stats.terminalRunCount).toBe(1);
    expect(stats.failureRate).toBe(0);
  });

  it("returns null failureRate when there are no terminal runs at all", () => {
    const stats = computeRunStats([
      run({ status: "pending", endedAt: undefined }),
      run({ status: "running", endedAt: undefined }),
    ]);
    expect(stats.failureRate).toBeNull();
  });

  it("handles missing durations (no endedAt) by excluding them from percentiles", () => {
    const stats = computeRunStats([
      run({ status: "running", endedAt: undefined }),
      run({ status: "completed", startedAt: 0, endedAt: 50 }),
    ]);
    expect(stats.durationMs.sampleSize).toBe(1);
    expect(stats.durationMs.p50).toBe(50);
  });

  it("computes exact percentiles with tie handling", () => {
    // 10 identical durations -> every percentile should equal that duration.
    const runs = Array.from({ length: 10 }, () => run({ startedAt: 0, endedAt: 200 }));
    const stats = computeRunStats(runs);
    expect(stats.durationMs.p50).toBe(200);
    expect(stats.durationMs.p90).toBe(200);
    expect(stats.durationMs.p99).toBe(200);
  });

  it("computes percentiles correctly for a known distribution (nearest-rank)", () => {
    // durations 10..100 step 10 (n=10)
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const runs = durations.map((d) => run({ startedAt: 0, endedAt: d }));
    const stats = computeRunStats(runs);
    // nearest-rank: ceil(0.5*10)=5 -> index 4 -> value 50
    expect(stats.durationMs.p50).toBe(50);
    // ceil(0.9*10)=9 -> index 8 -> value 90
    expect(stats.durationMs.p90).toBe(90);
    // ceil(0.99*10)=10 -> index 9 -> value 100
    expect(stats.durationMs.p99).toBe(100);
  });

  it("sums tokens and counts runs with token data", () => {
    const stats = computeRunStats([
      run({ tokensIn: 100, tokensOut: 50 }),
      run({ tokensIn: 200 }),
      run({}), // no token data
    ]);
    expect(stats.tokensInSum).toBe(300);
    expect(stats.tokensOutSum).toBe(50);
    expect(stats.runsWithTokenData).toBe(2);
  });

  it("counts by status across all statuses", () => {
    const stats = computeRunStats([
      run({ status: "completed" }),
      run({ status: "failed" }),
      run({ status: "cancelled" }),
      run({ status: "pending", endedAt: undefined }),
    ]);
    expect(stats.countsByStatus.completed).toBe(1);
    expect(stats.countsByStatus.failed).toBe(1);
    expect(stats.countsByStatus.cancelled).toBe(1);
    expect(stats.countsByStatus.pending).toBe(1);
    expect(stats.countsByStatus.running).toBe(0);
  });
});

describe("bucketByDay", () => {
  it("returns an empty array for no runs", () => {
    expect(bucketByDay([])).toEqual([]);
  });

  it("buckets runs into UTC calendar days, sorted ascending", () => {
    const buckets = bucketByDay([
      run({ startedAt: BASE + DAY }), // day 2
      run({ startedAt: BASE }), // day 1
      run({ startedAt: BASE }), // day 1
    ]);
    expect(buckets.map((b) => b.date)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(buckets[0].stats.totalRuns).toBe(2);
    expect(buckets[1].stats.totalRuns).toBe(1);
  });

  it("shifts bucketing with a fixed positive offset", () => {
    // 23:30 UTC on Jan 1 shifted +01:00 lands in Jan 2.
    const lateNight = Date.UTC(2026, 0, 1, 23, 30, 0);
    const buckets = bucketByDay([run({ startedAt: lateNight })], "+01:00");
    expect(buckets[0].date).toBe("2026-01-02");
  });

  it("shifts bucketing with a fixed negative offset", () => {
    const earlyMorning = Date.UTC(2026, 0, 2, 0, 30, 0);
    const buckets = bucketByDay([run({ startedAt: earlyMorning })], "-08:00");
    expect(buckets[0].date).toBe("2026-01-01");
  });

  it("falls back to UTC for an unrecognized tz string", () => {
    const buckets = bucketByDay([run({ startedAt: BASE })], "not-a-real-tz");
    expect(buckets[0].date).toBe("2026-01-01");
  });
});

describe("compareCohorts", () => {
  function makeCohort(n: number, failures: number, durMs = 100): RunSummary[] {
    return Array.from({ length: n }, (_, i) =>
      run({
        status: i < failures ? "failed" : "completed",
        startedAt: 0,
        endedAt: durMs,
      }),
    );
  }

  it("guards small-n cohorts with insufficient_data", () => {
    const a = makeCohort(10, 1);
    const b = makeCohort(10, 5);
    const cmp = compareCohorts(a, b);
    expect(cmp.failureRateSignificance).toBe("insufficient_data");
    expect(cmp.failureRateSignificanceExplanation).toMatch(/at least 30/);
  });

  it("reports likely_regression for a large, clear increase in failure rate", () => {
    const a = makeCohort(200, 5); // 2.5%
    const b = makeCohort(200, 60); // 30%
    const cmp = compareCohorts(a, b);
    expect(cmp.failureRateSignificance).toBe("likely_regression");
    expect(cmp.failureRate.absoluteChange).toBeCloseTo(0.275, 3);
  });

  it("reports likely_improvement for a large, clear decrease in failure rate", () => {
    const a = makeCohort(200, 60);
    const b = makeCohort(200, 5);
    const cmp = compareCohorts(a, b);
    expect(cmp.failureRateSignificance).toBe("likely_improvement");
  });

  it("reports inconclusive when the difference is small relative to noise", () => {
    const a = makeCohort(100, 10); // 10%
    const b = makeCohort(100, 12); // 12%
    const cmp = compareCohorts(a, b);
    expect(cmp.failureRateSignificance).toBe("inconclusive");
  });

  it("computes duration and token deltas alongside failure rate", () => {
    const a = makeCohort(50, 5, 100);
    const b = makeCohort(50, 5, 200);
    const cmp = compareCohorts(a, b);
    expect(cmp.durationP50.a).toBe(100);
    expect(cmp.durationP50.b).toBe(200);
    expect(cmp.durationP50.relativeChange).toBeCloseTo(1, 6);
  });

  it("handles empty cohorts without throwing", () => {
    const cmp = compareCohorts([], []);
    expect(cmp.failureRateSignificance).toBe("insufficient_data");
    expect(cmp.failureRate.a).toBeNull();
    expect(cmp.failureRate.b).toBeNull();
    expect(cmp.durationP50.absoluteChange).toBeNull();
  });

  it("handles one empty cohort and one populated cohort", () => {
    const cmp = compareCohorts([], makeCohort(50, 5));
    expect(cmp.cohortASize).toBe(0);
    expect(cmp.cohortBSize).toBe(50);
    expect(cmp.failureRateSignificance).toBe("insufficient_data");
  });
});
