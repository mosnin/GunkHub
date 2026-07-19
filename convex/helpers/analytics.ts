/**
 * Pure aggregation engine over run summaries. No Convex `ctx`, no schema
 * imports — this module only knows about the minimal shape it needs
 * (`RunSummary`), so it can be wired to whatever the real `runs` table
 * looks like once Team A lands their schema changes (tokensIn/tokensOut,
 * daily_rollups) next cycle. See docs/design/insight_engine.md.
 *
 * All functions here are deterministic and side-effect-free: same input,
 * same output, every time. That makes them safe to call from a query, from
 * a cron-driven rollup job, or from a unit test with no fixtures beyond a
 * plain array.
 */

export type RunSummaryStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface RunSummary {
  status: RunSummaryStatus;
  startedAt: number;
  endedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
}

const TERMINAL_FAILURE_STATUSES: ReadonlySet<RunSummaryStatus> = new Set([
  "failed",
  "timed_out",
]);
const TERMINAL_STATUSES: ReadonlySet<RunSummaryStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export interface DurationPercentiles {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  /** Number of runs that had both startedAt and endedAt and contributed a duration sample. */
  sampleSize: number;
}

export interface RunStats {
  totalRuns: number;
  countsByStatus: Record<RunSummaryStatus, number>;
  /** failed + timed_out, divided by all TERMINAL runs (pending/running excluded from the denominator). */
  failureRate: number | null;
  terminalRunCount: number;
  durationMs: DurationPercentiles;
  tokensInSum: number;
  tokensOutSum: number;
  /** Count of runs that reported at least one of tokensIn/tokensOut. */
  runsWithTokenData: number;
}

/**
 * Exact percentile via sorted selection (nearest-rank method). This is exact
 * (not interpolated/estimated) for any n, but is documented here as a
 * BOUNDED-SAMPLE CONTRACT: callers should not pass more than ~5000 runs in a
 * single call. Sorting is O(n log n) in memory; the query layer is expected
 * to pre-aggregate (e.g. via daily_rollups, cycle 2) rather than pass an
 * unbounded run history through this function. n <= 5000 comfortably fits in
 * a single Convex query's read/compute budget; beyond that, pre-bucket first.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  // Nearest-rank: index = ceil(p/100 * n) - 1, clamped into range.
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[index]!;
}

function computeDurationPercentiles(runs: RunSummary[]): DurationPercentiles {
  const durations: number[] = [];
  for (const run of runs) {
    if (run.endedAt !== undefined && run.endedAt >= run.startedAt) {
      durations.push(run.endedAt - run.startedAt);
    }
  }
  if (durations.length === 0) {
    return { p50: null, p90: null, p95: null, p99: null, sampleSize: 0 };
  }
  durations.sort((a, b) => a - b);
  return {
    p50: percentile(durations, 50),
    p90: percentile(durations, 90),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    sampleSize: durations.length,
  };
}

/**
 * Compute aggregate stats over a bounded set of run summaries. See the
 * BOUNDED-SAMPLE CONTRACT note on `percentile` above — pass at most ~5000
 * runs per call.
 */
export function computeRunStats(runs: RunSummary[]): RunStats {
  const countsByStatus: Record<RunSummaryStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timed_out: 0,
  };

  let tokensInSum = 0;
  let tokensOutSum = 0;
  let runsWithTokenData = 0;
  let terminalRunCount = 0;
  let failureCount = 0;

  for (const run of runs) {
    countsByStatus[run.status] = (countsByStatus[run.status] ?? 0) + 1;

    if (run.tokensIn !== undefined || run.tokensOut !== undefined) {
      runsWithTokenData += 1;
      tokensInSum += run.tokensIn ?? 0;
      tokensOutSum += run.tokensOut ?? 0;
    }

    if (TERMINAL_STATUSES.has(run.status)) {
      terminalRunCount += 1;
      if (TERMINAL_FAILURE_STATUSES.has(run.status)) failureCount += 1;
    }
  }

  return {
    totalRuns: runs.length,
    countsByStatus,
    failureRate: terminalRunCount > 0 ? failureCount / terminalRunCount : null,
    terminalRunCount,
    durationMs: computeDurationPercentiles(runs),
    tokensInSum,
    tokensOutSum,
    runsWithTokenData,
  };
}

export interface DailyBucket {
  /** YYYY-MM-DD in the requested timezone offset. */
  date: string;
  stats: RunStats;
}

/**
 * Bucket runs by calendar day (of `startedAt`) and compute per-day stats.
 *
 * `tz` accepts either `'UTC'` (default) or a fixed offset string like
 * `'+05:30'` / `'-08:00'`. This is a FIXED offset, not an IANA timezone —
 * there is no timezone database available to a pure/portable helper module.
 * Real IANA-aware bucketing (accounting for DST) is a cycle-2+ concern once
 * this is wired behind a query that can use `Intl` in the Convex runtime;
 * documented here so cycle 2 doesn't assume more precision than this
 * provides today.
 */
export function bucketByDay(runs: RunSummary[], tz: string = "UTC"): DailyBucket[] {
  const offsetMs = parseFixedOffsetMs(tz);

  const byDate = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const shifted = run.startedAt + offsetMs;
    const date = new Date(shifted).toISOString().slice(0, 10);
    const bucket = byDate.get(date);
    if (bucket) {
      bucket.push(run);
    } else {
      byDate.set(date, [run]);
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, dayRuns]) => ({ date, stats: computeRunStats(dayRuns) }));
}

function parseFixedOffsetMs(tz: string): number {
  if (tz === "UTC" || tz === "") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!match) return 0; // unrecognized -> treat as UTC rather than throwing
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 60 + minutes) * 60_000;
}

export type SignificanceHint =
  | "likely_regression"
  | "likely_improvement"
  | "inconclusive"
  | "insufficient_data";

export interface MetricDelta {
  a: number | null;
  b: number | null;
  /** b - a. Null if either side is null. */
  absoluteChange: number | null;
  /** (b - a) / a. Null if a is null, zero, or either side is null. */
  relativeChange: number | null;
}

export interface CohortComparison {
  cohortASize: number;
  cohortBSize: number;
  failureRate: MetricDelta;
  /** Two-proportion z-test on failure rate; see explanation for the exact interpretation. */
  failureRateSignificance: SignificanceHint;
  /** Plain-language sentence explaining the significance hint, safe to render directly in UI. */
  failureRateSignificanceExplanation: string;
  durationP50: MetricDelta;
  durationP90: MetricDelta;
  tokensInSum: MetricDelta;
  tokensOutSum: MetricDelta;
}

const SMALL_N_GUARD = 30;
/** Two-sided z critical value for p < 0.05. */
const Z_CRITICAL_95 = 1.959964;

function metricDelta(a: number | null, b: number | null): MetricDelta {
  if (a === null || b === null) {
    return { a, b, absoluteChange: null, relativeChange: null };
  }
  const absoluteChange = b - a;
  const relativeChange = a !== 0 ? absoluteChange / a : null;
  return { a, b, absoluteChange, relativeChange };
}

/**
 * Two-proportion z-test for a difference in failure rate between two
 * independent cohorts. Returns z (signed: positive means B's failure rate is
 * higher than A's) and the two-sided p-value approximation via the normal
 * CDF. This is a standard large-sample approximation — NOT exact (e.g. not
 * Fisher's exact test) and is documented as such so nobody mistakes it for a
 * rigorous statistical guarantee. It is a heuristic hint for engineers
 * skimming a version comparison, not a research-grade significance test.
 */
function twoProportionZTest(
  failuresA: number,
  nA: number,
  failuresB: number,
  nB: number,
): { z: number; pApprox: number } {
  const pA = failuresA / nA;
  const pB = failuresB / nB;
  const pPooled = (failuresA + failuresB) / (nA + nB);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / nA + 1 / nB));
  if (se === 0) {
    return { z: 0, pApprox: 1 };
  }
  const z = (pB - pA) / se;
  // Two-sided p-value from the standard normal CDF via erf approximation.
  const pApprox = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { z, pApprox };
}

/** Abramowitz-Stegun approximation of the standard normal CDF. Adequate for a UI-facing hint. */
function standardNormalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - d * poly;
}

/**
 * Compare two cohorts of runs (e.g. two agent versions' recent runs, or two
 * time windows). Pure — takes two arrays, returns per-metric deltas plus a
 * plain-language significance hint on failure rate.
 *
 * SMALL-N GUARD: if either cohort has fewer than 30 TERMINAL runs, the
 * failure-rate significance hint is 'insufficient_data' regardless of the
 * z-test result — with n < 30 per cohort the normal approximation underlying
 * the two-proportion z-test is unreliable, and we would rather say "not
 * enough data" than report a false-confidence verdict.
 */
export function compareCohorts(a: RunSummary[], b: RunSummary[]): CohortComparison {
  const statsA = computeRunStats(a);
  const statsB = computeRunStats(b);

  const failureRate = metricDelta(statsA.failureRate, statsB.failureRate);
  const durationP50 = metricDelta(statsA.durationMs.p50, statsB.durationMs.p50);
  const durationP90 = metricDelta(statsA.durationMs.p90, statsB.durationMs.p90);
  const tokensInSum = metricDelta(statsA.tokensInSum, statsB.tokensInSum);
  const tokensOutSum = metricDelta(statsA.tokensOutSum, statsB.tokensOutSum);

  let failureRateSignificance: SignificanceHint;
  let failureRateSignificanceExplanation: string;

  if (statsA.terminalRunCount < SMALL_N_GUARD || statsB.terminalRunCount < SMALL_N_GUARD) {
    failureRateSignificance = "insufficient_data";
    failureRateSignificanceExplanation =
      `Each cohort needs at least ${SMALL_N_GUARD} terminal runs for a reliable comparison ` +
      `(cohort A has ${statsA.terminalRunCount}, cohort B has ${statsB.terminalRunCount}).`;
  } else {
    const failuresA = Math.round((statsA.failureRate ?? 0) * statsA.terminalRunCount);
    const failuresB = Math.round((statsB.failureRate ?? 0) * statsB.terminalRunCount);
    const { pApprox } = twoProportionZTest(
      failuresA,
      statsA.terminalRunCount,
      failuresB,
      statsB.terminalRunCount,
    );

    if (pApprox >= 0.05) {
      failureRateSignificance = "inconclusive";
      failureRateSignificanceExplanation =
        `The failure rate difference (${formatPct(statsA.failureRate)} to ${formatPct(statsB.failureRate)}) ` +
        `is not statistically significant at p<0.05 (p≈${pApprox.toFixed(3)}). Could be noise.`;
    } else if ((statsB.failureRate ?? 0) > (statsA.failureRate ?? 0)) {
      failureRateSignificance = "likely_regression";
      failureRateSignificanceExplanation =
        `Cohort B's failure rate (${formatPct(statsB.failureRate)}) is significantly higher than ` +
        `cohort A's (${formatPct(statsA.failureRate)}), p≈${pApprox.toFixed(3)} < 0.05. Likely a real regression.`;
    } else {
      failureRateSignificance = "likely_improvement";
      failureRateSignificanceExplanation =
        `Cohort B's failure rate (${formatPct(statsB.failureRate)}) is significantly lower than ` +
        `cohort A's (${formatPct(statsA.failureRate)}), p≈${pApprox.toFixed(3)} < 0.05. Likely a real improvement.`;
    }
  }

  return {
    cohortASize: a.length,
    cohortBSize: b.length,
    failureRate,
    failureRateSignificance,
    failureRateSignificanceExplanation,
    durationP50,
    durationP90,
    tokensInSum,
    tokensOutSum,
  };
}

function formatPct(rate: number | null): string {
  if (rate === null) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

// Referenced only to keep Z_CRITICAL_95 documented/available for future callers
// that want a raw critical-value comparison instead of a p-value threshold.
export { Z_CRITICAL_95 };
