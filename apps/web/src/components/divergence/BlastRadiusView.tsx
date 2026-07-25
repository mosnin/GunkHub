/**
 * BlastRadiusView — "can I ship this version, and what breaks if I do?"
 *
 * ===========================================================================
 * THE HEADLINE LEADS WITH REASONS, NOT RUNS
 * ===========================================================================
 *
 * "340 of 10,000 runs would break" is a number an operator cannot act on. "340
 * runs, for 12 distinct reasons" is twelve things to read and usually two or
 * three to fix. So the largest, first-read figure in each tile is the DISTINCT
 * REASON COUNT, and the run count sits beneath it as scope.
 *
 * ---------------------------------------------------------------------------
 * THREE COUNTS, NEVER ONE
 * ---------------------------------------------------------------------------
 *
 * The three bands get three figures that are never added together. A combined
 * "412 affected" would launder 300 "the system prompt changed" findings into
 * the same number as 112 proven breaks, and an operator reading one number
 * reads it as proof. `FleetDivergenceReport` exposes no summed field, so there
 * is nothing here to render even if someone wanted to.
 *
 * The tiles are physically separated and each carries its own
 * `CertaintyMarker`, so the distinction survives someone screenshotting only
 * the summary strip.
 *
 * ---------------------------------------------------------------------------
 * SCAN COMPLETENESS IS STATED BEFORE ANY NUMBER
 * ---------------------------------------------------------------------------
 *
 * `window.scanTruncated` or `runsUnassessable > 0` means the counts below are a
 * LOWER BOUND. That is stated in the scope line, above the tiles, because a
 * caveat placed after a conclusion is a caveat nobody reads — and it is ALSO
 * an indeterminate reason in its own right, so it appears again as an open
 * question the verdict is bound by.
 */

import { isFleetScanComplete } from '@agent-flight-recorder/contracts'
import Link from 'next/link'

import type { FleetDivergenceReport } from '@agent-flight-recorder/contracts'

import {
  CertaintyCaption,
  CertaintyMarker,
  CertaintySectionHeading,
} from '@/components/divergence/CertaintyMarker'
import { VerdictBanner } from '@/components/divergence/DivergenceStates'
import {
  IndeterminateReasonTable,
  ProvenReasonTable,
  SpeculativeReasonTable,
} from '@/components/divergence/ReasonTables'
import { Card } from '@/components/ui/Card'

interface BlastRadiusViewProps {
  report: FleetDivergenceReport
  baselineVersionLabel: string
  targetVersionLabel: string
  /** Continuation cursor for the next batch, or null when the walk is finished. */
  nextCursor: string | null
  /** Base path + version params, for building the continue link. */
  continueHrefBase: string
}

/**
 * One stat tile.
 *
 * The value uses design.md's `metric-xs` tier (20px mono), which REQUIRES
 * `tabular-nums` — without it the digits do not column-align between tiles and
 * the step buys nothing over Inter.
 */
function Stat({
  value,
  label,
  certainty,
}: {
  value: number
  label: string
  certainty: 'proven' | 'speculative' | 'indeterminate'
}) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <CertaintyMarker certainty={certainty} compact />
      <span className="font-mono text-[20px] leading-none tracking-tight tabular-nums text-whiteout">
        {value.toLocaleString()}
      </span>
      <span className="text-xs text-pewter leading-relaxed">{label}</span>
    </div>
  )
}

export function BlastRadiusView({
  report,
  baselineVersionLabel,
  targetVersionLabel,
  nextCursor,
  continueHrefBase,
}: BlastRadiusViewProps) {
  const provenReasons = report.provenReasons.length
  const speculativeReasons = report.speculativeReasons.length
  const indeterminateReasons = report.indeterminateReasons.length
  const scanComplete = isFleetScanComplete(report.window)

  return (
    <div className="flex flex-col gap-4">
      <VerdictBanner
        verdict={report.verdict}
        scope={`Version ${targetVersionLabel}, checked against runs recorded on ${baselineVersionLabel}.`}
      />

      {/* Scope, before any count. Every number below is relative to it, and a
          sampled figure presented as a population figure is a false negative
          waiting to happen. */}
      <p className="text-sm text-pewter leading-relaxed">
        Scanned{' '}
        <span className="font-mono text-whiteout tabular-nums">
          {report.window.runsScanned.toLocaleString()}
        </span>{' '}
        {report.window.runsScanned === 1 ? 'run' : 'runs'}, analysed{' '}
        <span className="font-mono text-whiteout tabular-nums">
          {report.window.runsAnalyzed.toLocaleString()}
        </span>
        {scanComplete
          ? '. The scan covered the whole population.'
          : '. The scan did not cover the whole population, so every count below is a LOWER BOUND — a reason absent here may still exist beyond the window.'}
      </p>

      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-graphite">
          <Stat
            certainty="proven"
            value={provenReasons}
            label={`distinct reasons proven to break, across ${report.runsWithProvenDivergence.toLocaleString()} ${
              report.runsWithProvenDivergence === 1 ? 'run' : 'runs'
            }`}
          />
          <Stat
            certainty="speculative"
            value={speculativeReasons}
            label="distinct configuration changes that may alter behaviour — none of them evidence of a break"
          />
          <Stat
            certainty="indeterminate"
            value={indeterminateReasons}
            label="distinct questions this scan could not answer — while any remain, nothing here is a clean bill of health"
          />
        </div>
      </Card>

      {/* Three landmarks. A reason cannot appear in the wrong one because the
          three tables' prop types do not unify. */}
      {provenReasons > 0 && (
        <section aria-labelledby="fleet-proven-heading">
          <Card>
            <CertaintySectionHeading
              id="fleet-proven-heading"
              certainty="proven"
              reasonCount={provenReasons}
              runCount={report.runsWithProvenDivergence}
            />
            <CertaintyCaption certainty="proven" />
            <ProvenReasonTable
              reasons={report.provenReasons}
              targetVersionId={report.targetVersionId}
            />
          </Card>
        </section>
      )}

      {speculativeReasons > 0 && (
        <section aria-labelledby="fleet-speculative-heading">
          <Card>
            <CertaintySectionHeading
              id="fleet-speculative-heading"
              certainty="speculative"
              reasonCount={speculativeReasons}
            />
            <CertaintyCaption certainty="speculative" />
            <SpeculativeReasonTable
              reasons={report.speculativeReasons}
              targetVersionId={report.targetVersionId}
            />
          </Card>
        </section>
      )}

      {/* The scan is a BOUNDED BATCH, not an answer. Offering the next page is
          honest; presenting a first page as the fleet verdict is not. Grouping
          holds across pages because `reasonKey` is run-independent, so a reason
          seen on page 1 and page 40 collides exactly rather than approximately. */}
      {nextCursor !== null && (
        <Card>
          <div
            data-testid="divergence-continue-scan"
            className="px-4 py-3 flex items-center justify-between gap-4 flex-wrap"
          >
            <p className="text-sm text-pewter leading-relaxed max-w-2xl">
              More runs remain beyond this batch. Every count above is a lower bound until the walk
              finishes, which is why the verdict cannot read as compatible yet.
            </p>
            <Link
              href={`${continueHrefBase}&cursor=${encodeURIComponent(nextCursor)}`}
              className="shrink-0 rounded-full bg-whiteout hover:bg-cloud text-graphite-deep text-sm font-medium px-[18px] py-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow"
            >
              Scan the next batch
            </Link>
          </div>
        </Card>
      )}

      {indeterminateReasons > 0 && (
        <section aria-labelledby="fleet-indeterminate-heading">
          <Card>
            <CertaintySectionHeading
              id="fleet-indeterminate-heading"
              certainty="indeterminate"
              reasonCount={indeterminateReasons}
            />
            <CertaintyCaption certainty="indeterminate" />
            <IndeterminateReasonTable
              reasons={report.indeterminateReasons}
              targetVersionId={report.targetVersionId}
            />
          </Card>
        </section>
      )}
    </div>
  )
}
