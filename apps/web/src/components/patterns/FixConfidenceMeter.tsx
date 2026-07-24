import type { AdaptedFixConfidence, FixConfidenceLimit, FixVersionAttribution } from '@/components/patterns/adapt'
import type { PatternResolutionExposure } from '@agent-flight-recorder/contracts'

import { FIX_CONFIDENCE_MAX } from '@/components/patterns/adapt'
import { FixConfidenceBadge } from '@/components/patterns/FixConfidenceBadge'
import { cn, formatCoarseDuration } from '@/lib/utils'

interface FixConfidenceMeterProps {
  confidence: AdaptedFixConfidence
  /** Live post-resolution exposure, when the evidence query supplied it — adds the before/since run comparison the score alone can't show. */
  exposure?: PatternResolutionExposure | null
  /** Human-readable version string for `resolvedInVersionId`, resolved by the caller. */
  resolvedInVersion?: string
  className?: string
}

/**
 * The confidence score, never as a bare number.
 *
 * Every input Team B returns is rendered alongside it — credited exposure,
 * raw observed runs, soak time, recurrence, and version attribution — so an
 * engineer can look at 0.42 and DISAGREE with it on the evidence rather than
 * trusting or dismissing a mystery figure. That is the entire reason
 * `fixConfidence()` returns its inputs.
 *
 * Two deliberate presentation decisions:
 *
 *  1. The score is shown as a decimal AGAINST ITS CEILING ("0.62 / 0.95"),
 *     never as a percentage. The ceiling is 0.95 and not 1.0 because no
 *     finite observation window proves the absence of a rare failure —
 *     rendering "62%" would quietly imply a 100% that this system will never
 *     award. The reserved 5% is stated, not hidden.
 *  2. The two credit bars only take the Neon Glow fill once there is real
 *     exposure behind them. An `unproven` fix gets greyscale bars: a glowing
 *     bar on zero evidence would be the exact false-confidence this feature
 *     was built to eliminate.
 */
const LIMIT_COPY: Record<FixConfidenceLimit, string> = {
  recurrence: 'The pattern recurred after it was resolved. This fix is disproved, not merely unproven — prior clean exposure does not survive a counter-example.',
  'no-resolution': 'No resolution is recorded for this pattern, so there is nothing to prove yet.',
  'version-mismatch':
    'Runs since the resolution were observed on a different agent version than the fix shipped in, so none of them count as exposure.',
  'no-exposure': 'Nothing has exercised this fix yet. Untested is not the same as fixed.',
  accumulating: 'Evidence is still accumulating — more clean runs and more soak time raise this score.',
  none: 'Nothing is limiting this score except the 0.95 ceiling, which is permanent.',
}

const ATTRIBUTION_COPY: Record<FixVersionAttribution, string> = {
  matched: 'runs observed on the version the fix shipped in',
  mismatched: 'runs observed on a DIFFERENT version — not credited',
  unknown: 'version the runs executed on is not recorded',
}

interface CreditBarProps {
  label: string
  /** 0..1 */
  credit: number
  /** The raw driver value this bar summarizes, rendered as the readable fact next to it. */
  value: string
  /** Greyscale fill when there is no real evidence behind the bar. */
  earned: boolean
}

function CreditBar({ label, credit, value, earned }: CreditBarProps) {
  const pct = Math.round(Math.max(0, Math.min(1, credit)) * 100)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-mono uppercase tracking-wider text-pewter">{label}</span>
        <span className="font-mono text-xs text-neutral-300">
          {value}
          {/* The bar below is aria-hidden, so the FRACTION it encodes has to
              live in text or it does not exist for a screen reader — and
              whether the credit was actually earned is otherwise conveyed
              only by the fill color, which is exactly the color-alone
              encoding this palette makes tempting. Both are stated here. */}
          <span className="text-pewter">
            {' '}
            · {pct}%<span className="sr-only"> of this driver&apos;s available credit, {earned ? 'earned' : 'not yet earned'}</span>
          </span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-[4px] bg-graphite overflow-hidden" aria-hidden="true">
        <div
          className={cn('h-full rounded-[4px]', earned ? 'bg-neon-glow' : 'bg-neutral-600')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function FixConfidenceMeter({ confidence, exposure, resolvedInVersion, className }: FixConfidenceMeterProps) {
  const { state, score, exposureRuns, observedRuns, elapsedMs, versionAttribution, limitingFactor } = confidence

  // Bars glow only on real, credited exposure. `regressed` scores 0 by
  // construction, so its bars stay grey too — the recurrence line below is
  // what carries that story, not a half-full bar.
  const earned = state === 'proving' || state === 'confirmed'

  const runCountLabel = exposure?.runCountTruncated === true ? `${exposure.runCount.toLocaleString()}+` : null

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Score + state. The number never appears without the state word next
          to it, and never without the ceiling. */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-pewter">Fix confidence</p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-2xl text-whiteout tabular-nums">{score.toFixed(2)}</span>
            <span className="font-mono text-sm text-pewter">/ {FIX_CONFIDENCE_MAX.toFixed(2)} max</span>
          </p>
        </div>
        <FixConfidenceBadge state={state} />
      </div>

      <p className="text-xs text-pewter leading-relaxed">
        Confidence is capped at {FIX_CONFIDENCE_MAX.toFixed(2)}, never 1.00 — no finite observation window can prove the
        absence of a rare failure. The reserved margin is the standing reminder that this is evidence, not proof.
      </p>

      {/* The drivers. These are what the score is made of. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-graphite">
        <CreditBar
          label="Exposure"
          credit={confidence.exposureCredit}
          earned={earned && exposureRuns > 0}
          value={`${exposureRuns.toLocaleString()} ${exposureRuns === 1 ? 'run' : 'runs'} credited`}
        />
        <CreditBar
          label="Soak"
          credit={confidence.soakCredit}
          earned={earned && elapsedMs > 0}
          value={formatCoarseDuration(elapsedMs)}
        />
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div className="flex items-baseline justify-between gap-3 border-b border-graphite pb-1.5">
          <dt className="text-xs text-pewter uppercase tracking-wider">Runs observed</dt>
          <dd className="font-mono text-xs text-neutral-300">
            {observedRuns.toLocaleString()}
            {observedRuns !== exposureRuns && (
              <span className="text-pewter"> → {exposureRuns.toLocaleString()} credited</span>
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-b border-graphite pb-1.5">
          <dt className="text-xs text-pewter uppercase tracking-wider">Recurrence</dt>
          <dd className={cn('font-mono text-xs', confidence.recurred ? 'text-neon-glow' : 'text-neutral-300')}>
            {confidence.recurred ? 'failed again' : 'none since fix'}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-b border-graphite pb-1.5">
          <dt className="text-xs text-pewter uppercase tracking-wider">Version</dt>
          <dd className="font-mono text-xs text-neutral-300 text-right">
            {resolvedInVersion ?? ATTRIBUTION_COPY[versionAttribution]}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-b border-graphite pb-1.5">
          <dt className="text-xs text-pewter uppercase tracking-wider">Attribution</dt>
          <dd className="font-mono text-xs text-neutral-300">{versionAttribution}</dd>
        </div>
      </dl>

      {/* Before/since — never a subtraction. `baselineRunCount` is a 14-day
          TRAILING BASELINE captured before the fix, not a cumulative total,
          so the two numbers are labelled and set side by side rather than
          differenced into a meaningless delta. */}
      {exposure && (
        <div className="pt-3 border-t border-graphite">
          <p className="text-xs font-mono uppercase tracking-wider text-pewter mb-2">Runs before vs. since the fix</p>
          <div className="flex items-baseline gap-6 flex-wrap">
            <div>
              <p className="font-mono text-sm text-neutral-300">
                {typeof exposure.baselineRunCount === 'number'
                  ? exposure.baselineRunCount.toLocaleString()
                  : 'not captured'}
              </p>
              <p className="text-xs text-pewter">before (14-day baseline)</p>
            </div>
            <div>
              <p className="font-mono text-sm text-whiteout">{runCountLabel ?? exposure.runCount.toLocaleString()}</p>
              <p className="text-xs text-pewter">
                since{exposure.runCountTruncated && <span> (floor — scan capped)</span>}
              </p>
            </div>
            <div>
              <p className="font-mono text-sm text-neutral-300">{exposure.recurrenceCount.toLocaleString()}</p>
              <p className="text-xs text-pewter">recurrences since</p>
            </div>
          </div>
        </div>
      )}

      {/* Why the score is not higher — Team B returns this specifically so the
          UI never has to editorialize. */}
      <div className="pt-3 border-t border-graphite">
        <p className="text-xs font-mono uppercase tracking-wider text-pewter mb-1">
          Limiting factor: <span className="text-cloud">{limitingFactor}</span>
        </p>
        <p className="text-sm text-neutral-300 leading-relaxed">{LIMIT_COPY[limitingFactor]}</p>
      </div>
    </div>
  )
}
