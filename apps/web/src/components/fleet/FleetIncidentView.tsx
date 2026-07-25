/**
 * FleetIncidentView — the composition. Three bands, three landmarks, one order.
 *
 * ===========================================================================
 * THE PAGE ANSWERS FOUR QUESTIONS IN THIS ORDER
 * ===========================================================================
 *
 *   HOW BAD, IN ONE WORD    the verdict banner
 *   WHAT IS SHARED          the observed correlations, ranked by blast radius
 *   WHAT MIGHT EXPLAIN IT   the hypotheses, last of the claim bands, with
 *                           their denominators and their tests attached
 *   WHAT WE COULD NOT CHECK the unanswered questions
 *   ...then the roster, which is the raw material, not the answer.
 *
 * The order is not negotiable. An operator reads top-down under pressure and
 * acts on the first thing that looks actionable; putting speculation above
 * fact would be the whole defect this surface exists to prevent, achieved by
 * layout alone.
 *
 * ---------------------------------------------------------------------------
 * THREE LANDMARKS, THREE ACCESSIBLE NAMES
 * ---------------------------------------------------------------------------
 *
 * Each band is a `<section aria-labelledby>` whose heading states its
 * epistemic status in words — "was recorded" / "might explain" / "could not be
 * checked". A screen-reader user navigating by landmark hears the difference
 * before hearing any content, and a finding can never appear inside the
 * hypothesis region because the three lists come from three non-unifiable
 * contract types.
 *
 * ---------------------------------------------------------------------------
 * ORPHAN HYPOTHESES ARE SURFACED, NOT SILENTLY RENDERED
 * ---------------------------------------------------------------------------
 *
 * A hypothesis naming a `correlationKey` this report does not contain is a
 * free-floating assertion — on screen it looks identical to one backed by
 * twelve cited occurrences, and nothing distinguishes them. The contract's
 * `orphanHypotheses` finds them; this view refuses to render them in the
 * hypothesis band and reports the count instead. Dropping them silently would
 * be the quieter version of the same problem.
 */

import {
  fleetReportIncoherences,
  isFleetHealthScanComplete,
  orphanHypotheses,
  rankFleetCorrelations,
} from '@agent-flight-recorder/contracts'

import type {
  AgentHealthEntry,
  FleetHealthReport,
  HypothesisedCause,
  ObservedCorrelation,
  UnansweredFleetQuestion,
} from '@agent-flight-recorder/contracts'


import { FleetRoster } from '@/components/fleet/FleetRoster'
import {
  HealthyResult,
  IncompleteScanBanner,
  IndeterminateResult,
  IsolatedFailuresResult,
  ScanCoverageStrip,
} from '@/components/fleet/FleetStates'
import { HypothesisList } from '@/components/fleet/HypothesisList'
import { ObservedCorrelationTable } from '@/components/fleet/ObservedCorrelationTable'
import { UnansweredList } from '@/components/fleet/UnansweredList'
import { VERDICT_MEANING, VERDICT_WORD } from '@/lib/fleet/labels'
import { renderCount, usableArray } from '@/lib/fleet/safe'

const SECTION = 'border border-graphite-light rounded-[4px] bg-graphite-deep overflow-hidden'
const CAPTION = 'px-4 py-2 text-xs text-pewter border-b border-graphite leading-relaxed'
const SECTION_HEAD =
  'flex items-baseline justify-between gap-4 px-4 py-3 border-b border-graphite'

interface FleetIncidentViewProps {
  report: FleetHealthReport
  widenHref: string
  widenLabel: string
  narrowHref: string
  narrowLabel: string
  continueHref?: string | undefined
}

export function FleetIncidentView({
  report,
  widenHref,
  widenLabel,
  narrowHref,
  narrowLabel,
  continueHref,
}: FleetIncidentViewProps) {
  // NORMALISE THE COLLECTIONS BEFORE ANYTHING WALKS THEM. Every contract helper
  // here — `fleetReportIncoherences`, `orphanHypotheses` — calls `.flatMap` /
  // `.filter` on these, so a non-array from the wire throws before any of this
  // component's own guards run. `usableArray` degrades to empty, which reads as
  // "nothing to show" and is caught by the completeness rules, rather than
  // taking down the screen.
  const { scan, verdict, agentsFailing } = report
  const correlations = usableArray<ObservedCorrelation>(report.correlations)
  const hypotheses = usableArray<HypothesisedCause>(report.hypotheses)
  const unanswered = usableArray<UnansweredFleetQuestion>(report.unanswered)
  const roster = usableArray<AgentHealthEntry>(report.roster)
  const safeReport: FleetHealthReport = {
    ...report,
    correlations: [...correlations],
    hypotheses: [...hypotheses],
  }

  // GATE BEFORE RANKING. `rankFleetCorrelations` sorts on `agentCount` first,
  // so an unchecked breadth decides what an operator reads first — the contract
  // says outright to rank only correlations that have passed this. A
  // correlation whose own numbers refute each other (evidence outside its
  // window, a burst wider than the burst window, a breadth its citations cannot
  // corroborate) is withheld rather than ranked, and the withholding is stated
  // below. Verifying a field is present and well-formed is not the same as
  // verifying its numbers agree with the other numbers in the same report; this
  // is the only entry point that has both halves in hand.
  const incoherences = fleetReportIncoherences(safeReport)
  const incoherentKeys = new Set(incoherences.map((f) => f.correlationKey))
  const coherent = correlations.filter((c) => !incoherentKeys.has(c.correlationKey))

  const ranked = rankFleetCorrelations(coherent)
  const orphans = orphanHypotheses(safeReport)
  const orphanKeys = new Set(orphans.map((h) => h.hypothesisKey))
  const grounded = hypotheses.filter((h) => !orphanKeys.has(h.hypothesisKey))
  const observedFacts = new Map(ranked.map((c) => [c.correlationKey, c.observedFact] as const))
  const complete = isFleetHealthScanComplete(scan)

  return (
    <div className="flex flex-col gap-4">
      {/* One word, first. `data-verdict` is a test hook; the WORD is what a
          human reads, and the word differs for all four verdicts. */}
      <div
        data-testid="fleet-verdict"
        data-verdict={verdict}
        className="border border-graphite-light rounded-[4px] bg-graphite-deep px-4 py-3"
      >
        <h2
          className={`font-mono text-sm font-semibold tracking-tight ${
            verdict === 'healthy' ? 'text-neon-glow' : 'text-ember'
          }`}
        >
          {VERDICT_WORD[verdict]}
        </h2>
        <p className="mt-1.5 text-sm text-cloud leading-relaxed max-w-3xl">
          {VERDICT_MEANING[verdict]}
        </p>
      </div>

      <ScanCoverageStrip scan={scan} />

      {incoherentKeys.size > 0 && (
        // Named, never silently dropped. A withheld correlation is a fact about
        // the engine, and an operator comparing this screen against a CLI run
        // must be able to see why the two disagree.
        <p
          data-testid="fleet-incoherent-withheld"
          className="text-sm text-ember leading-relaxed px-4"
        >
          {incoherentKeys.size.toLocaleString()} correlation
          {incoherentKeys.size === 1 ? ' was' : 's were'} withheld because{' '}
          {incoherentKeys.size === 1 ? 'its' : 'their'} own numbers contradict each other (
          {[...new Set(incoherences.map((f) => f.incoherence))].join(', ')}). A correlation that
          disagrees with itself cannot be ranked, because the field it would be ranked on is the
          one in doubt.
        </p>
      )}

      {ranked.length === 0 ? (
        // Which non-answer is shown turns on the CONTRACT's completeness
        // predicate and the verdict — never on the result list happening to be
        // empty. An empty list means four different things and they are four
        // different panels.
        !complete ? (
          <IndeterminateResult
            scan={scan}
            continueHref={continueHref}
            narrowHref={narrowHref}
            narrowLabel={narrowLabel}
          />
        ) : agentsFailing > 0 ? (
          <IsolatedFailuresResult
            scan={scan}
            agentsFailing={agentsFailing}
            widenHref={widenHref}
            widenLabel={widenLabel}
          />
        ) : (
          <HealthyResult scan={scan} widenHref={widenHref} widenLabel={widenLabel} />
        )
      ) : (
        <>
          {!complete && <IncompleteScanBanner scan={scan} continueHref={continueHref} />}

          <section aria-labelledby="fleet-observed-heading" className={SECTION}>
            <div className={SECTION_HEAD}>
              <h2 id="fleet-observed-heading" className="text-sm font-semibold text-whiteout">
                What was recorded across agents
              </h2>
              <div className="flex items-baseline gap-3 shrink-0 font-mono text-xs text-pewter tabular-nums">
                <span>
                  <span className="text-whiteout">{ranked.length.toLocaleString()}</span>{' '}
                  {ranked.length === 1 ? 'correlation' : 'correlations'}
                </span>
                <span>
                  <span className="text-whiteout">{renderCount(agentsFailing)}</span> failing
                </span>
              </div>
            </div>
            {/* Past indicative. States what the band is AND what it is not. */}
            <p className={CAPTION}>
              Each row is a recorded fact: these agents failed this way, cited by these rows, in
              this window. Ranked by how many agents each one hit — not by how recently it
              happened. None of it says why.
            </p>
            <ObservedCorrelationTable items={ranked} scan={scan} />
          </section>

          {grounded.length > 0 && (
            <section aria-labelledby="fleet-hypothesis-heading" className={SECTION}>
              <div className={SECTION_HEAD}>
                <h2 id="fleet-hypothesis-heading" className="text-sm font-semibold text-cloud">
                  What might explain them — untested
                </h2>
                {/* No count of agents or runs. This band's magnitude is not a
                    thing that exists; see HypothesisList's header. */}
                <span className="shrink-0 font-mono text-xs text-pewter uppercase tracking-tight">
                  Unranked
                </span>
              </div>
              <p className={CAPTION}>
                Nothing below is a finding. Each is a question the recorded data does not answer.
                They are listed unranked and without blast radius, because a hypothesis has none of
                its own — the numbers above belong to the observations, not to any explanation of
                them. Every one names what would test it. Test before acting.
              </p>
              <HypothesisList items={grounded} observedFacts={observedFacts} />
            </section>
          )}

          {orphans.length > 0 && (
            // Reported, not rendered as a hypothesis. On screen an orphan is
            // indistinguishable from a grounded one, which is exactly why it
            // cannot be allowed into the band.
            <p className="text-sm text-ember leading-relaxed px-4">
              {orphans.length.toLocaleString()} hypoth
              {orphans.length === 1 ? 'esis names an observation' : 'eses name observations'} this
              report does not contain, and {orphans.length === 1 ? 'was' : 'were'} withheld: a
              proposal with no observation under it is indistinguishable on screen from one backed
              by cited evidence.
            </p>
          )}
        </>
      )}

      {unanswered.length > 0 && (
        <section aria-labelledby="fleet-unanswered-heading" className={SECTION}>
          <div className={SECTION_HEAD}>
            <h2 id="fleet-unanswered-heading" className="text-sm font-semibold text-cloud">
              What the scan could not check
            </h2>
            <span className="shrink-0 font-mono text-xs text-pewter tabular-nums">
              <span className="text-whiteout">{unanswered.length.toLocaleString()}</span>{' '}
              {unanswered.length === 1 ? 'question' : 'questions'}
            </span>
          </div>
          <p className={CAPTION}>
            Neither findings nor the absence of findings. Each is a question this scan could not
            decide, with what blocked it and what would make it answerable. While any of these are
            open, nothing on this page is a clean bill of health.
          </p>
          <UnansweredList items={unanswered} />
        </section>
      )}

      {roster.length > 0 && (
        <section aria-labelledby="fleet-roster-heading" className={SECTION}>
          <div className={SECTION_HEAD}>
            <h2 id="fleet-roster-heading" className="text-sm font-semibold text-cloud">
              Agent roster for this window
            </h2>
            <span className="shrink-0 font-mono text-xs text-pewter tabular-nums">
              <span className="text-whiteout">{roster.length.toLocaleString()}</span> agents
            </span>
          </div>
          <p className={CAPTION}>
            The raw material the bands above were assembled from, most concerning first. An agent
            with no runs is NOT OBSERVED, which is not a pass — nothing about it was tested, and a
            silently idle agent is frequently the incident.
          </p>
          <FleetRoster roster={roster} />
        </section>
      )}
    </div>
  )
}
