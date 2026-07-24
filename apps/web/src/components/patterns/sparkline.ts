/**
 * Pure SVG-geometry builder for the trend sparkline — no React, no DOM, so it
 * typechecks and unit-tests the same way convex/insights.ts's
 * deriveFailureFingerprint/assessPatternSpike do (pure functions, exercised
 * directly by tests, with the rendering shell around them kept thin).
 */
import type { FailurePatternTrendPoint } from '@agent-flight-recorder/contracts'

export interface SparklineGeometry {
  /** SVG `points` attribute for a <polyline>, e.g. "0,20 10,18 20,4". */
  points: string
  /** Value of the last (most recent) point, for an optional end-dot. */
  lastX: number
  lastY: number
  /** True when there's at least one non-zero count — an all-zero trend renders as a flat baseline, not a misleadingly "empty" chart. */
  hasActivity: boolean
}

/**
 * Maps a 14-day trend (oldest first, per FailurePatternTrendPoint's contract)
 * onto a `width` x `height` viewbox. Single-point and empty trends are
 * handled explicitly (a one-point "polyline" would otherwise be invisible).
 */
export function buildSparklineGeometry(
  trend: readonly FailurePatternTrendPoint[],
  width: number,
  height: number,
): SparklineGeometry {
  if (trend.length === 0) {
    return { points: '', lastX: 0, lastY: height, hasActivity: false }
  }

  const maxCount = Math.max(1, ...trend.map((t) => t.count))
  const hasActivity = trend.some((t) => t.count > 0)
  const stepX = trend.length > 1 ? width / (trend.length - 1) : 0

  const coords = trend.map((t, i) => {
    const x = trend.length > 1 ? i * stepX : width / 2
    // Leave 2px of headroom so a max-count point's dot isn't clipped at y=0.
    const y = height - 2 - (t.count / maxCount) * (height - 4)
    return { x, y }
  })

  const last = coords[coords.length - 1] ?? { x: width, y: height }

  return {
    points: coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' '),
    lastX: last.x,
    lastY: last.y,
    hasActivity,
  }
}
