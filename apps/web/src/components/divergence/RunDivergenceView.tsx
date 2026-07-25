/**
 * RunDivergenceView — one recorded run checked against one target version.
 *
 * ===========================================================================
 * THE FIRST PROVEN BREAK LEADS, AND EVERYTHING AFTER IT IS COUNTERFACTUAL
 * ===========================================================================
 *
 * Once a run does something the target version cannot do, the REST of the
 * recorded trajectory stops being evidence about the target. A run that calls a
 * removed tool at event 14 and then makes forty more calls did not "diverge
 * forty-one times" — it diverged once, at 14, and everything after is a
 * recording of a world that would not have existed.
 *
 * So the run view names the earliest cited event as the break point and says
 * plainly that later findings are listed for completeness rather than as
 * independent predictions. A flat list of forty findings would imply forty
 * independent facts and badly overstate what is known.
 *
 * ---------------------------------------------------------------------------
 * THREE BANDS, THREE COMPONENTS, THREE LANDMARKS
 * ---------------------------------------------------------------------------
 *
 * Proven, speculative and indeterminate findings render through different row
 * components into different `<section>` landmarks with different headings — the
 * same rule as the fleet view. A proven row cites the event that proves it; a
 * speculative row structurally cannot and states its own limit instead; an
 * indeterminate row is phrased as an open question.
 */

import Link from 'next/link'

import type {
  DivergenceReport,
  IndeterminateDivergence,
  ProvenDivergence,
  SpeculativeDivergence,
} from '@agent-flight-recorder/contracts'

import {
  CertaintyCaption,
  CertaintyMarker,
  CertaintySectionHeading,
} from '@/components/divergence/CertaintyMarker'
import { CoveragePanel } from '@/components/divergence/CoveragePanel'
import { VerdictBanner } from '@/components/divergence/DivergenceStates'
import { Card } from '@/components/ui/Card'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import {
  DIMENSION_LABEL,
  INDETERMINATE_KIND_LABEL,
  PROVEN_KIND_LABEL,
  SPECULATIVE_KIND_LABEL,
} from '@/lib/divergence/labels'

interface RunDivergenceViewProps {
  report: DivergenceReport
  targetVersionLabel: string
}

/** The earliest cited event across all proven findings — where the trajectory breaks. */
function firstProvenSequence(report: DivergenceReport): number | null {
  let earliest: number | null = null
  for (const f of report.proven) {
    for (const p of f.provenBy) {
      if (earliest === null || p.citedEvent.sequenceNumber < earliest) {
        earliest = p.citedEvent.sequenceNumber
      }
    }
  }
  return earliest
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A proven finding. Every cited event is a real link into the run's timeline —
 * CLAUDE.md asks for stable, shareable URLs, and "show me the event that proves
 * this" is the first thing an operator will want.
 */
function ProvenRow({ finding, runId }: { finding: ProvenDivergence; runId: string }) {
  return (
    <li className="px-4 py-3 border-b border-graphite last:border-b-0">
      <div className="flex items-start gap-3">
        <CertaintyMarker certainty="proven" compact className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-whiteout">
              {PROVEN_KIND_LABEL[finding.kind]}
            </span>
            <span className="font-mono text-xs text-pewter">{finding.reasonKey}</span>
            <CopyToClipboardButton value={finding.reasonKey} label="Copy reason key" />
          </div>
          {/* The engine's own claim, past tense, rendered verbatim. */}
          <p className="mt-1 text-sm text-cloud leading-relaxed max-w-3xl">
            {finding.provenClaim}
          </p>
          {/* The proof. `provenBy` is non-empty by type — a proven row always
              has at least one citation, and cannot be constructed without. */}
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {finding.provenBy.map((p) => (
              <li
                key={`${p.citedEvent.sequenceNumber}:${p.targetConfigPath}`}
                className="font-mono text-xs text-pewter tabular-nums"
              >
                <Link
                  href={`/runs/${encodeURIComponent(runId)}/events?seq=${p.citedEvent.sequenceNumber}`}
                  className="text-cloud hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
                >
                  event {p.citedEvent.sequenceNumber.toLocaleString()}
                </Link>{' '}
                · {p.citedEvent.eventType} · recorded{' '}
                <span className="text-cloud">{p.recordedValue}</span> · target{' '}
                <span className="text-cloud">{p.targetValue ?? 'not declared'}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </li>
  )
}

/** An unproven finding. No event citation exists, and none is fabricated. */
function SpeculativeRow({ finding }: { finding: SpeculativeDivergence }) {
  return (
    <li className="px-4 py-3 border-b border-graphite last:border-b-0">
      <div className="flex items-start gap-3">
        <CertaintyMarker certainty="speculative" compact className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm text-cloud">{SPECULATIVE_KIND_LABEL[finding.kind]}</span>
            <span className="font-mono text-xs text-pewter">{finding.changedConfigPath}</span>
          </div>
          <p className="mt-1 text-sm text-cloud leading-relaxed max-w-3xl">
            {finding.speculativeConcern}
          </p>
          <p className="mt-1.5 text-sm text-pewter leading-relaxed max-w-3xl">
            Cannot be proven from recorded history: {finding.speculativeBecause}
          </p>
          {/* Named a NAVIGATION AID in the contract, and labelled as one here so
              it cannot be read as the citation list a proven row carries. */}
          {finding.possiblyAffectedSequenceNumbers !== undefined &&
            finding.possiblyAffectedSequenceNumbers.length > 0 && (
              <p className="mt-1.5 font-mono text-xs text-pewter tabular-nums">
                Somewhere to start reading (not evidence): events{' '}
                {finding.possiblyAffectedSequenceNumbers.join(', ')}
              </p>
            )}
        </div>
      </div>
    </li>
  )
}

/** An unanswered question. Phrased as a question, never as a claim. */
function IndeterminateRow({ finding }: { finding: IndeterminateDivergence }) {
  return (
    <li className="px-4 py-3 border-b border-graphite last:border-b-0">
      <div className="flex items-start gap-3">
        <CertaintyMarker certainty="indeterminate" compact className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm text-cloud">{INDETERMINATE_KIND_LABEL[finding.kind]}</span>
            <span className="font-mono text-xs text-pewter">
              {DIMENSION_LABEL[finding.dimension]}
            </span>
          </div>
          <p className="mt-1 text-sm text-cloud leading-relaxed max-w-3xl">
            Undecided: {finding.undecidedQuestion}
          </p>
          <p className="mt-1.5 text-sm text-pewter leading-relaxed max-w-3xl">
            {finding.unknownBecause}
          </p>
          {finding.remedy !== undefined && (
            <p className="mt-1.5 text-sm text-cloud leading-relaxed max-w-3xl">
              To make this answerable: {finding.remedy}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function RunDivergenceView({ report, targetVersionLabel }: RunDivergenceViewProps) {
  const breakAt = firstProvenSequence(report)

  return (
    <div className="flex flex-col gap-4">
      <VerdictBanner
        verdict={report.verdict}
        scope={`This run, checked against version ${targetVersionLabel}.`}
      />

      {/* Coverage is rendered UNCONDITIONALLY, including on clean reports. A
          zero-finding report without its coverage figure is the false clean —
          "nothing found across six dimensions" and "nothing found across one"
          are different answers and are otherwise indistinguishable. */}
      <CoveragePanel coverage={report.coverage} />

      {breakAt !== null && (
        <Card>
          <div className="px-4 py-4 flex flex-col gap-2 items-start">
            <CertaintyMarker certainty="proven" />
            <h2 className="text-sm font-semibold text-whiteout">
              This run&rsquo;s trajectory breaks at event{' '}
              <span className="font-mono tabular-nums">{breakAt.toLocaleString()}</span>.
            </h2>
            <p className="text-sm text-pewter leading-relaxed max-w-3xl">
              Every event after this point is counterfactual: the recorded run continued, but on the
              target version it could not have reached that state. Later findings are listed for
              completeness, not as independent predictions.
            </p>
          </div>
        </Card>
      )}

      {report.proven.length > 0 && (
        <section aria-labelledby="run-proven-heading">
          <Card>
            <CertaintySectionHeading
              id="run-proven-heading"
              certainty="proven"
              reasonCount={report.proven.length}
            />
            <CertaintyCaption certainty="proven" />
            <ul>
              {report.proven.map((f) => (
                <ProvenRow key={f.reasonKey} finding={f} runId={report.runId} />
              ))}
            </ul>
          </Card>
        </section>
      )}

      {report.speculative.length > 0 && (
        <section aria-labelledby="run-speculative-heading">
          <Card>
            <CertaintySectionHeading
              id="run-speculative-heading"
              certainty="speculative"
              reasonCount={report.speculative.length}
            />
            <CertaintyCaption certainty="speculative" />
            <ul>
              {report.speculative.map((f) => (
                <SpeculativeRow key={f.reasonKey} finding={f} />
              ))}
            </ul>
          </Card>
        </section>
      )}

      {report.indeterminate.length > 0 && (
        <section aria-labelledby="run-indeterminate-heading">
          <Card>
            <CertaintySectionHeading
              id="run-indeterminate-heading"
              certainty="indeterminate"
              reasonCount={report.indeterminate.length}
            />
            <CertaintyCaption certainty="indeterminate" />
            <ul>
              {report.indeterminate.map((f) => (
                <IndeterminateRow key={f.reasonKey} finding={f} />
              ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  )
}
