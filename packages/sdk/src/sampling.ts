// ---------------------------------------------------------------------------
// Head sampling with tail-bias for failures.
//
// The sampling decision is made once, at `startRun()`. An unsampled run's
// `recorder.recordEvent()`/`endRun()`/`failRun()` calls are the SAME method
// calls on the SAME `Recorder` instance as a sampled run — there is no
// separate "handle" object with a reduced API. What differs is purely
// internal: an unsampled run's events are discarded (or shadow-buffered, see
// `alwaysKeepFailures` below) instead of transmitted. Every public method
// remains callable with identical signatures and return types either way.
// ---------------------------------------------------------------------------

export interface SamplingContext {
  agentId: string
  tags: string[]
}

export interface SamplingConfig {
  /**
   * Fraction of runs to sample in, `0..1`. Decided once at `startRun()`
   * ("head sampling"). `1` (or omitted) samples every run; `0` samples none.
   * An unsampled run records NOTHING by default — see `alwaysKeepFailures` to
   * retroactively keep a run's events if it turns out to fail.
   */
  rate?: number
  /**
   * Tail bias: if `true`, an unsampled run that ends via `failRun()`
   * retroactively ships its events instead of discarding them. This requires
   * buffering the run's events even while unsampled ("shadow buffering"),
   * capped at the same `maxBufferSize` as normal buffering. A run that ends
   * via `endRun()` (success) still discards its shadow-buffered events.
   */
  alwaysKeepFailures?: boolean
  /**
   * Override the rate-based decision entirely. Return `true` to sample the
   * run in, `false` to sample it out. If it throws, the recorder fails open
   * (samples the run IN) rather than silently losing telemetry.
   */
  decider?: (ctx: SamplingContext) => boolean
  /**
   * When `true`, derive the sampling decision from a deterministic hash of
   * the run's name (`runConfig.name`, if the caller provided one) instead of
   * `Math.random()` — the same run name always produces the same decision,
   * which is useful for reproducing an investigation. Falls back to
   * `Math.random()` when no run name is available. Ignored when `decider` is set.
   */
  seedFromRunName?: boolean
}

/**
 * FNV-1a 32-bit hash. Deterministic across processes and Node versions
 * (unlike relying on `Math.random()`'s seed), which is what makes
 * `seedFromRunName` reproducible.
 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Decide whether a run should be sampled in.
 *
 * Precedence: `decider` (if provided) wins outright; otherwise `rate` is
 * used, seeded from `runName` when `seedFromRunName` is set and a name is
 * available, otherwise via `Math.random()`.
 *
 * @param config - sampling config (undefined ⇒ always sample in)
 * @param ctx - decision context passed to `decider`
 * @param runName - run name for `seedFromRunName`; undefined falls back to `Math.random()`
 */
export function decideSampling(config: SamplingConfig | undefined, ctx: SamplingContext, runName: string | undefined): boolean {
  if (!config) return true

  if (config.decider) {
    try {
      return config.decider(ctx)
    } catch {
      // A throwing decider must not crash startRun(), and silently dropping
      // telemetry because of a buggy decider is worse than over-recording —
      // fail open.
      return true
    }
  }

  const rate = config.rate ?? 1
  if (rate >= 1) return true
  if (rate <= 0) return false

  if (config.seedFromRunName && runName !== undefined && runName.length > 0) {
    const h = hashString(runName)
    return h / 0xffffffff < rate
  }
  return Math.random() < rate
}
