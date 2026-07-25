/**
 * CoveragePanel — what the analysis actually looked at.
 *
 * ===========================================================================
 * A ZERO-FINDING REPORT WITHOUT ITS COVERAGE FIGURE *IS* THE FALSE CLEAN
 * ===========================================================================
 *
 * "Zero findings" is not an answer. "Zero findings across all six dimensions
 * and the full event history" and "zero findings across one dimension and the
 * first 200 events" are completely different answers, and they are
 * indistinguishable unless coverage is rendered. The contract makes
 * `DivergenceCoverage` a REQUIRED field on `DivergenceReport` for exactly this
 * reason; rendering it is what makes that requirement worth having.
 *
 * So this panel is NOT conditional on there being gaps. It renders on every
 * analysis, including — especially — the clean ones, because a clean report is
 * where an unrendered coverage figure does its damage.
 *
 * ---------------------------------------------------------------------------
 * EVERY UNASSESSED DIMENSION SHOWS ITS REASON
 * ---------------------------------------------------------------------------
 *
 * `DivergenceUnassessedReason` distinguishes cases that call for completely
 * different operator actions:
 *
 *   target_config_missing     -> record a snapshot on the version
 *   target_dimension_absent   -> the snapshot exists but says nothing here
 *   baseline_config_missing   -> the RUN's version has no snapshot
 *   unsupported_config_shape  -> the snapshot is malformed; fix the shape
 *   engine_limit              -> re-run; it is a scale problem, not a data one
 *
 * Collapsing these to "not checked" would leave an operator knowing they have a
 * problem and not which problem, so each renders its own sentence and its own
 * remedy.
 *
 * Uses dashed geometry throughout, matching the "provisional" language
 * established by `CertaintyMarker` — dashed means unproven everywhere on this
 * surface, and that consistency is a non-colour channel of its own.
 */

import { isDivergenceCoverageComplete } from '@agent-flight-recorder/contracts'

import type { DivergenceCoverage } from '@agent-flight-recorder/contracts'

import {
  DIMENSION_LABEL,
  UNASSESSED_REASON_LABEL,
  UNASSESSED_REMEDY,
} from '@/lib/divergence/labels'

interface CoveragePanelProps {
  coverage: DivergenceCoverage
}

export function CoveragePanel({ coverage }: CoveragePanelProps) {
  const complete = isDivergenceCoverageComplete(coverage)
  const total = coverage.assessed.length + coverage.unassessed.length

  return (
    <div
      data-testid="divergence-coverage"
      data-coverage-complete={complete ? 'true' : 'false'}
      className={`rounded-[4px] border bg-graphite-deep ${
        complete ? 'border-graphite-light' : 'border-dashed border-graphite-light'
      }`}
    >
      <div className="px-4 py-3 border-b border-graphite flex items-baseline justify-between gap-4 flex-wrap">
        <h3 className="text-xs font-mono uppercase text-pewter tracking-tight">
          What was examined
        </h3>
        <span className="font-mono text-xs text-pewter tabular-nums">
          <span className="text-whiteout">{coverage.assessed.length}</span> of{' '}
          <span className="text-whiteout">{total}</span> dimensions ·{' '}
          <span className="text-whiteout">{coverage.eventsExamined.toLocaleString()}</span> events
          {coverage.eventHistoryComplete ? '' : ' (history incomplete)'}
        </span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-2">
        {coverage.assessed.length > 0 && (
          <p className="text-sm text-cloud leading-relaxed">
            <span className="text-pewter">Checked:</span>{' '}
            {coverage.assessed.map((d) => DIMENSION_LABEL[d]).join(', ')}.
          </p>
        )}

        {coverage.unassessed.length === 0 ? (
          <p className="text-sm text-pewter leading-relaxed">
            {coverage.eventHistoryComplete
              ? 'Every dimension was examined and the full event history was read. A finding of "nothing" here means nothing was found, not that nothing was looked for.'
              : 'Every dimension was examined, but the event history was not read to the end — findings are a lower bound.'}
          </p>
        ) : (
          <>
            <p className="text-sm text-cloud leading-relaxed">
              <span className="text-pewter">Not checked:</span>{' '}
              {coverage.unassessed.length}{' '}
              {coverage.unassessed.length === 1 ? 'dimension' : 'dimensions'}. An empty result for
              an unchecked dimension is not evidence that it is safe.
            </p>
            <ul className="flex flex-col gap-2 mt-1">
              {coverage.unassessed.map((u) => (
                <li
                  key={`${u.dimension}:${u.reason}`}
                  className="border-l border-dashed border-graphite-light pl-3"
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm text-whiteout">{DIMENSION_LABEL[u.dimension]}</span>
                    <span className="font-mono text-xs text-pewter">
                      {UNASSESSED_REASON_LABEL[u.reason]}
                    </span>
                  </div>
                  <p className="text-xs text-pewter leading-relaxed mt-0.5 max-w-3xl">
                    {UNASSESSED_REMEDY[u.reason]}
                    {u.detail !== undefined && ` (${u.detail})`}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
