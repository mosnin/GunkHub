/**
 * HypothesisList — the proposals. NOT a table, and deliberately so.
 *
 * ===========================================================================
 * THE STRUCTURAL DISTINCTION, IN FULL
 * ===========================================================================
 *
 * This band and `ObservedCorrelationTable` must never be mistakable for one
 * another by someone scanning at 3am. Seven independent things differ, and no
 * two of them are colour:
 *
 *   1. ELEMENT TYPE        that band is a grid with a header row and aligned
 *                          numeric columns; this is a `<ul>` of prose with
 *                          `<dl>` bodies. Even squinting at a screenshot, one
 *                          is a table of data and one is a list of questions.
 *   2. NO BLAST RADIUS     a hypothesis has no `agentCount`, no
 *                          `lastObservedAt`, no span, no evidence list — its
 *                          contract type does not have those fields. The
 *                          observation's 12 is a measurement of the
 *                          CO-OCCURRENCE, and reprinting it beside a proposed
 *                          cause is precisely how conjecture is laundered into
 *                          a measurement.
 *   3. NO ORDINAL          the findings are ranked 1..N. These are unranked and
 *                          the section says so — ranking implies a magnitude,
 *                          and there is none to rank on. (The contract agrees:
 *                          `computeFleetHealthVerdict` has no place to put a
 *                          hypothesis count at all.)
 *   4. INTERROGATIVE       every heading is a question, COMPOSED by the
 *                          contract's `hypothesisQuestion` from `kind` +
 *                          `sharedValue`. The findings speak in the past
 *                          indicative. There is no free-prose headline field
 *                          for an engine to write an accusation into — a
 *                          declarative sentence about a named dependency
 *                          survives every label, column and colour placed
 *                          around it.
 *   5. NO EVIDENCE LINK    a finding links to the runs that record it. A
 *                          hypothesis has no run to link to and does not
 *                          pretend otherwise: it links only BACK to the
 *                          observations it rests on, under a label saying
 *                          exactly that.
 *   6. THE DENOMINATOR     every item shows how many UNAFFECTED agents share
 *                          the attribute too. See below — this is the field
 *                          that makes the dangerous sentence unwriteable.
 *   7. UNIQUE FIELD LABELS `WHY THIS IS NOT ESTABLISHED`, `WOULD BE TESTED BY`,
 *                          `SHARED BY`, `RESTS ON` appear nowhere in the
 *                          findings table, so a reader landing mid-page knows
 *                          which band they are in from any single row.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY NUMBER A HYPOTHESIS MAY SHOW IS A COMPARISON
 * ---------------------------------------------------------------------------
 *
 * "All 12 failing agents use model m-4" is true and, on its own, worthless —
 * 198 of the org's 200 agents may use m-4. At 3am the implication is what gets
 * acted on, and the action is rolling back a healthy model.
 *
 * So the affected count is NEVER rendered alone. It is rendered against the
 * unaffected population, and when that population was not measured the UI says
 * there is no denominator rather than letting the numerator imply one.
 * `unaffectedSharing: null` means NOT MEASURED and never zero — a base rate of
 * zero is the strongest possible support for a hypothesis, so conflating the
 * two inverts the meaning completely. The verdict is rendered as a word, not a
 * colour.
 *
 * AND `null` IS NOT THE ONLY UNUSABLE VALUE. Absent, string-typed, NaN, and a
 * dropped truncation flag all pass a `!== null` guard, and two of them promote
 * a hypothesis to `discriminating` — the top of what an operator reads first —
 * from unvalidated wire data. Everything here therefore goes through
 * `@/lib/fleet/safe`, which checks USABILITY rather than nullity and degrades
 * toward the weaker claim in every branch.
 */

import { hypothesisQuestion } from '@agent-flight-recorder/contracts'
import Link from 'next/link'

import type { FleetShareMeasurement, HypothesisedCause } from '@agent-flight-recorder/contracts'


import { HypothesisMarker } from '@/components/fleet/EvidenceMarker'
import { DISCRIMINATION_MEANING, DISCRIMINATION_WORD } from '@/lib/fleet/labels'
import { isExactlyTrue, renderCount, safeDiscrimination, usableMeasurement } from '@/lib/fleet/safe'

const FIELD_LABEL = 'text-xs font-mono uppercase text-pewter tracking-tight'

/**
 * The base rate. Rendered as a comparison or not at all.
 *
 * `data-discrimination` is a test hook; the WORD beside it is what a human
 * reads, and the test that matters strips every `data-*` attribute before
 * asserting.
 */
function ShareMeasurement({ h }: { h: HypothesisedCause }) {
  // THE CONTAINER, NOT ONLY ITS FIELDS. `sharedBy` is required by the type and
  // therefore assumed present — the same assumption that produced this bug
  // family one level down. A `null` or missing `sharedBy` must reach the same
  // "not measured" reading as a malformed one, not throw on field access.
  const m: Partial<FleetShareMeasurement> =
    h.sharedBy !== null && typeof h.sharedBy === 'object' ? h.sharedBy : {}
  // `safeDiscrimination` gates the contract's rule rather than reimplementing
  // it: anything not fully usable returns `base_rate_unmeasured` WITHOUT
  // `discriminationOf` ever dividing it. See @/lib/fleet/safe.
  const verdict = safeDiscrimination(m as FleetShareMeasurement)
  // USABILITY, not `!== null`. `undefined !== null` is true, which is how the
  // old guard reached `.toLocaleString()` on an absent field and threw — on the
  // one screen whose whole purpose is to be readable during an outage.
  const usable = usableMeasurement(m)

  return (
    <div className="flex flex-col gap-0.5" data-discrimination={verdict}>
      <dt className={FIELD_LABEL}>Shared by</dt>
      <dd className="flex flex-col gap-0.5">
        <span className="font-mono text-xs text-cloud tabular-nums">
          {/* `renderCount` prints `—` for anything unusable. Never `0`: zero is
              a strong claim, and a malformed field must make this screen say
              LESS, never more. */}
          {renderCount(m.affectedSharing)} of {renderCount(m.affectedTotal)} FAILING agents
          {usable !== null ? (
            <>
              {' · '}
              {usable.unaffectedSharing.toLocaleString()} of{' '}
              {usable.unaffectedTotal.toLocaleString()} HEALTHY agents
            </>
          ) : (
            // No fabricated denominator, and no silence either.
            <> · healthy agents NOT CHECKED</>
          )}
        </span>
        <span className="font-mono text-xs text-pewter">{DISCRIMINATION_WORD[verdict]}</span>
        <span className="text-sm text-pewter leading-relaxed">
          {DISCRIMINATION_MEANING[verdict]}
        </span>
        {/* EXACTLY `true`. An absent flag is not a promise that nothing was
            truncated, so it shows no truncation caveat — but it also fails
            `usableMeasurement` above, which is what reports it as unmeasured
            rather than letting a floor be compared as a total. */}
        {isExactlyTrue(m.measurementTruncated) && (
          <span className="text-sm text-pewter leading-relaxed">
            The measurement stopped on a ceiling, so both numbers are floors and the comparison is
            not sound however favourable it looks.
          </span>
        )}
      </dd>
    </div>
  )
}

interface HypothesisListProps {
  items: readonly HypothesisedCause[]
  /**
   * correlationKey -> the observed fact it names, so "rests on" points at a
   * readable observation rather than an opaque key. A key with no entry is
   * rendered as the key: never dropped, because a dangling pointer is itself
   * information about the report.
   */
  observedFacts: ReadonlyMap<string, string>
}

export function HypothesisList({ items, observedFacts }: HypothesisListProps) {
  return (
    <ul className="flex flex-col">
      {items.map((h) => (
        <li
          key={h.hypothesisKey}
          className="border-b border-graphite last:border-b-0 px-4 py-3 flex flex-col gap-2"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <span className="shrink-0 mt-0.5">
              <HypothesisMarker />
            </span>
            {/* COMPOSED, never transmitted. `hypothesisQuestion` builds the
                sentence from `kind` + `sharedValue`, and is interrogative in
                every branch. The engine has no field to write a headline in, so
                it cannot accuse a dependency — which is the failure no amount of
                surrounding chrome survives. This replaces the local
                kind-derived heading that was doing the same job for this one
                component; the contract now does it for the CLI and MCP too. */}
            <h3 className="text-sm text-cloud leading-relaxed min-w-0">{hypothesisQuestion(h)}</h3>
          </div>

          <dl className="pl-1 flex flex-col gap-1.5 max-w-3xl">
            <ShareMeasurement h={h} />

            <div className="flex flex-col gap-0.5">
              {/* Required by the contract precisely so a hypothesis always
                  states its own limit. Rendering it is what keeps that
                  requirement worth having. */}
              <dt className={FIELD_LABEL}>Why this is not established</dt>
              <dd className="text-sm text-pewter leading-relaxed">{h.notEstablishedBecause}</dd>
            </div>

            <div className="flex flex-col gap-0.5">
              {/* The difference between handing someone a suspicion and handing
                  them an experiment. A hypothesis with no test attached gets
                  acted on directly, which during an incident means rolling back
                  the first plausible thing. */}
              <dt className={FIELD_LABEL}>Would be tested by</dt>
              <dd className="text-sm text-cloud leading-relaxed">{h.wouldBeTestedBy}</dd>
            </div>

            {h.attributeConfigPath !== undefined && (
              <div className="flex flex-col gap-0.5">
                <dt className={FIELD_LABEL}>Attribute path</dt>
                <dd className="font-mono text-xs text-cloud break-all">{h.attributeConfigPath}</dd>
              </div>
            )}

            <div className="flex flex-col gap-0.5">
              {/* Pointers to evidence for something ELSE — never evidence for
                  this. The label carries that distinction on its own. */}
              <dt className={FIELD_LABEL}>Rests on these observations</dt>
              <dd>
                <ul className="flex flex-col gap-1">
                  {h.restingOn.map((key) => (
                    <li key={key}>
                      <Link
                        href={`#observed-${encodeURIComponent(key)}`}
                        className="font-mono text-xs text-cloud hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
                      >
                        {observedFacts.get(key) ?? key}
                      </Link>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  )
}
