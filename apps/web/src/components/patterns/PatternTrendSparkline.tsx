import type { FailurePatternTrendPoint } from '@agent-flight-recorder/contracts'

import { buildSparklineGeometry } from '@/components/patterns/sparkline'

interface PatternTrendSparklineProps {
  trend: FailurePatternTrendPoint[]
  /** Compact (list row) vs a larger standalone chart (detail page). */
  size?: 'inline' | 'large'
}

const SIZES = {
  inline: { width: 72, height: 20 },
  large: { width: 320, height: 72 },
} as const

/**
 * Tiny inline trend chart — daily failure counts for the last 14 days.
 * Plain inline SVG, no chart library (forbidden per the design brief). Uses
 * only palette tokens: Neon Glow stroke on a near-black surface. Static —
 * no animation, so `prefers-reduced-motion` is a non-issue by construction.
 * `forced-colors` mode swaps the stroke for the system `CanvasText` color so
 * the shape survives a high-contrast theme instead of vanishing.
 */
export function PatternTrendSparkline({ trend, size = 'inline' }: PatternTrendSparklineProps) {
  const { width, height } = SIZES[size]
  const geometry = buildSparklineGeometry(trend, width, height)

  if (trend.length === 0) {
    return (
      <div
        className="text-xs font-mono text-pewter"
        style={{ width, height }}
        aria-label="No trend data"
      >
        —
      </div>
    )
  }

  const totalCount = trend.reduce((sum, t) => sum + t.count, 0)

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Daily occurrence trend over the last ${trend.length} days, ${totalCount} total`}
      className="shrink-0 overflow-visible"
    >
      {/* Baseline — a faint reference line so a flat/zero trend still reads as a chart, not a stray dot. */}
      <line
        x1={0}
        y1={height - 2}
        x2={width}
        y2={height - 2}
        className="stroke-graphite-light"
        strokeWidth={1}
      />
      {geometry.hasActivity && (
        <polyline
          points={geometry.points}
          fill="none"
          className="stroke-neon-glow forced-colors:stroke-[CanvasText]"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {geometry.hasActivity && (
        <circle
          cx={geometry.lastX}
          cy={geometry.lastY}
          r={1.75}
          className="fill-neon-glow forced-colors:fill-[CanvasText]"
        />
      )}
    </svg>
  )
}
