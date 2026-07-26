/**
 * FleetStates — the non-answers, kept apart from each other on purpose.
 *
 * ===========================================================================
 * "NOTHING FOUND" AND "STOPPED LOOKING" ARE COMPLETELY DIFFERENT ANSWERS
 * ===========================================================================
 *
 * And on this surface the second is the likely one. Data volume spikes during
 * an incident — that is what an incident is — so truncation is likeliest
 * during exactly the event this scan exists to explain. A page that renders a
 * truncated scan with the same calm copy as a completed one is self-concealing
 * in the precise way `serviceResult.ts` describes: the worse things get, the
 * more reassuring it looks.
 *
 * FIVE outcomes, five components, five `data-testid`s, five headlines. None
 * shares a shell with another, so no future "let's unify these empty states"
 * refactor can quietly give them one voice:
 *
 *   HealthyResult           complete scan, agents assessed, nothing failing.
 *                           The only earned all-clear, and even it is bounded.
 *   IsolatedFailuresResult  agents ARE failing; nothing was observed to
 *                           connect them. Not a clean fleet and not an
 *                           incident — a third thing, and the one most likely
 *                           to be misread as either.
 *   IndeterminateResult     the scan did not finish. NOT an answer.
 *   FleetScanFailed         the scan blew up. We know nothing at all.
 *   IncompleteScanBanner    correlations exist AND the scan did not finish.
 *                           Caveats the results; never replaces them.
 *
 * `ScanCoverageStrip` renders on EVERY outcome including the successful one,
 * because a findings list with no stated scope is the false-clean problem in
 * its other direction: the reader assumes the list is the whole fleet.
 *
 * ---------------------------------------------------------------------------
 * COMPLETENESS COMES FROM THE CONTRACT, NEVER FROM `scanTruncated` ALONE
 * ---------------------------------------------------------------------------
 *
 * `isFleetHealthScanComplete` is six conditions, and two of them are the ones
 * that matter: something must actually have been ASSESSED, and the correlation
 * pass must have run over the WHOLE ROSTER. A predicate made only of "nothing
 * went wrong" clauses is vacuously true on an empty scan, which yields an
 * org-wide all-clear derived from zero agents. This module never re-derives
 * that rule; it calls the contract's predicate.
 */

import { isFleetHealthScanComplete } from '@agent-flight-recorder/contracts'
import Link from 'next/link'

import type { FleetHealthScan } from '@agent-flight-recorder/contracts'


import { renderCount, usableCount } from '@/lib/fleet/safe'
import { formatDateTimeUtc } from '@/lib/fleet/window'
import { formatCoarseDuration } from '@/lib/utils'

const PANEL = 'border border-graphite-light rounded-[4px] bg-graphite-deep p-4'
const HEADLINE = 'font-mono text-sm font-semibold tracking-tight'
const BODY = 'mt-1.5 text-sm text-cloud leading-relaxed max-w-3xl'
const NOTE = 'mt-1.5 text-sm text-pewter leading-relaxed max-w-3xl'
const ACTION =
  'inline-flex items-center px-[18px] py-2 text-sm font-medium rounded-full bg-graphite hover:bg-graphite-light text-whiteout border border-graphite-light transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow'

// ---------------------------------------------------------------------------
// Coverage — always rendered
// ---------------------------------------------------------------------------

/**
 * What the scan actually covered.
 *
 * `page_local` gets its own loud line rather than folding into the completeness
 * flag. A page-local correlation pass can report zero clusters over a fleet
 * that is visibly on fire, because it never held enough of the fleet in one
 * place to see one — that is not an incomplete answer, it is a WRONG one, and
 * it must never read as merely partial.
 */
export function ScanCoverageStrip({ scan }: { scan: FleetHealthScan }) {
  const complete = isFleetHealthScanComplete(scan)
  return (
    <div
      data-testid="fleet-scan-coverage"
      data-scan-complete={complete ? 'true' : 'false'}
      className="flex flex-col gap-1.5 px-4 py-2.5 border border-graphite-light rounded-[4px] bg-graphite-deep"
    >
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono text-xs text-pewter">
        <span>
          Window{' '}
          <span className="text-cloud tabular-nums">
            {formatDateTimeUtc(scan.since)} → {formatDateTimeUtc(scan.until)}
          </span>
        </span>
        <span>
          Burst width{' '}
          <span className="text-cloud tabular-nums">
            {formatCoarseDuration(scan.burstWindowMs)}
          </span>
        </span>
        <span>
          Roster <span className="text-cloud tabular-nums">{renderCount(scan.agentsInRoster)}</span>
        </span>
        <span>
          Assessed{' '}
          <span className="text-cloud tabular-nums">{renderCount(scan.agentsAssessed)}</span>
        </span>
        {(usableCount(scan.agentsUnassessable) ?? 0) > 0 && (
          <span className="text-ember">
            Unassessable{' '}
            <span className="tabular-nums">{renderCount(scan.agentsUnassessable)}</span>
          </span>
        )}
        {(usableCount(scan.agentsSkippedForBudget) ?? 0) > 0 && (
          <span className="text-ember">
            Never reached{' '}
            <span className="tabular-nums">{renderCount(scan.agentsSkippedForBudget)}</span>
          </span>
        )}
        <span>
          Scan{' '}
          <span className={complete ? 'text-cloud' : 'text-ember'}>
            {complete ? 'COMPLETE' : 'INCOMPLETE'}
          </span>
        </span>
      </div>

      {scan.correlationBasis === 'page_local' && (
        <p className="text-sm text-ember leading-relaxed max-w-3xl">
          The correlation pass ran over ONE PAGE of the roster, not the whole fleet. A cluster
          split across pages is invisible on every page and in any merge of them — so an empty
          result here is not a small answer, it is the wrong one.
        </p>
      )}

      {!scan.baseRatesMeasured && (
        <p className="text-sm text-pewter leading-relaxed max-w-3xl">
          Base rates across unaffected agents were not measured, so no hypothesis below can be
          ranked or ruled out. This does not affect anything in the observed band.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The verdict, in one word
// ---------------------------------------------------------------------------

// (Verdict copy lives in @/lib/fleet/labels so the four verdicts cannot drift
// into sounding alike.)

// ---------------------------------------------------------------------------
// 1. Complete scan, nothing failing — the only earned all-clear
// ---------------------------------------------------------------------------

export function HealthyResult({ scan, widenHref, widenLabel }: ResultProps) {
  return (
    <div data-testid="fleet-healthy" data-scan-complete="true" className={PANEL}>
      <h2 className={`${HEADLINE} text-neon-glow`}>NOTHING CORRELATED — AND NOTHING FAILING</h2>
      <p className={BODY}>
        The scan finished over the whole roster. It assessed{' '}
        {renderCount(scan.agentsAssessed)} agents and found none of them failing, so there was
        nothing to correlate.
      </p>
      {/* Stated positively AND bounded. A negative finding is worth having,
          but only if its scope travels with it. */}
      <p className={NOTE}>
        This is an answer, not an absence of data — but it covers only this window, and only
        failures that were recorded. An agent failing silently, or one whose runs are not
        instrumented, cannot appear here.
      </p>
      <div className="mt-3">
        <Link href={widenHref} className={ACTION}>
          Widen to {widenLabel}
        </Link>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. Agents ARE failing — but nothing connects them
// ---------------------------------------------------------------------------

/**
 * The state most likely to be misread in BOTH directions: as an all-clear
 * (there is no fleet event) or as an incident (agents are failing). It is
 * neither, and it says so in the first sentence.
 */
export function IsolatedFailuresResult({
  scan,
  agentsFailing,
  widenHref,
  widenLabel,
}: ResultProps & { agentsFailing: number }) {
  return (
    <div data-testid="fleet-isolated-failures" data-scan-complete="true" className={PANEL}>
      <h2 className={`${HEADLINE} text-ember`}>AGENTS FAILING — NOTHING CONNECTS THEM</h2>
      <p className={BODY}>
        {renderCount(agentsFailing)} of {renderCount(scan.agentsAssessed)} assessed agents
        are failing or degrading in this window, and the scan observed nothing that links them.
        These are real problems. They are not one incident.
      </p>
      <p className={NOTE}>
        Nothing here says the failures are unrelated — only that nothing recorded connects them. A
        shared cause that leaves no shared fingerprint and no shared declaration is invisible to
        this scan. The roster below is where to start.
      </p>
      <div className="mt-3">
        <Link href={widenHref} className={ACTION}>
          Widen to {widenLabel}
        </Link>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. The scan did not finish — NOT an answer
// ---------------------------------------------------------------------------

export function IndeterminateResult({
  scan,
  continueHref,
  narrowHref,
  narrowLabel,
}: {
  scan: FleetHealthScan
  continueHref?: string | undefined
  narrowHref: string
  narrowLabel: string
}) {
  return (
    <div data-testid="fleet-indeterminate" data-scan-complete="false" className={PANEL}>
      <h2 className={`${HEADLINE} text-ember`}>SCAN DID NOT FINISH — THIS IS NOT A RESULT</h2>
      <p className={BODY}>
        The scan stopped before it covered the fleet, and found no correlation before it stopped.
        That is not a finding that the fleet is healthy. It is a statement that the question was
        not answered.
      </p>
      <p className={NOTE}>{reasonsFor(scan)}</p>
      {/* The direction of the error is the actionable part: an unfinished scan
          can only hide breadth, never invent it. */}
      <p className={NOTE}>
        Anything a truncated scan does show is a LOWER BOUND — real blast radius can only be
        larger, never smaller. Truncation is likeliest during an incident, when volume spikes, so
        seeing this here is expected rather than reassuring.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {continueHref !== undefined && (
          <Link href={continueHref} className={ACTION}>
            Continue the scan
          </Link>
        )}
        <Link href={narrowHref} className={ACTION}>
          Narrow to {narrowLabel}
        </Link>
      </div>
    </div>
  )
}

/** Names every specific condition that made the scan incomplete, in order. */
function reasonsFor(scan: FleetHealthScan): string {
  const reasons: string[] = []
  if ((usableCount(scan.agentsAssessed) ?? 0) === 0) reasons.push('no agent was assessed at all')
  if (scan.correlationBasis === 'page_local')
    reasons.push('the correlation pass saw only one page of the roster')
  if (scan.scanTruncated)
    reasons.push(
      // USABILITY, not `!== undefined`: a string or NaN ceiling would render
      // as "the row ceiling (NaN) was reached", which reads as a bug report
      // rather than as the limit an operator needs to raise.
      usableCount(scan.scanRowCeiling) !== null
        ? `the row ceiling (${renderCount(scan.scanRowCeiling)}) was reached`
        : 'the row ceiling was reached',
    )
  if ((usableCount(scan.agentsUnassessable) ?? 0) > 0)
    reasons.push(`${renderCount(scan.agentsUnassessable)} agents could not be assessed`)
  if ((usableCount(scan.agentsSkippedForBudget) ?? 0) > 0)
    reasons.push(`${renderCount(scan.agentsSkippedForBudget)} agents were never reached`)
  if (scan.nextCursor !== undefined) reasons.push('roster pages remain unread')
  return reasons.length > 0
    ? `What stopped it: ${reasons.join('; ')}.`
    : 'The engine reported the scan as incomplete without naming a specific limit.'
}

// ---------------------------------------------------------------------------
// 4. Correlations exist, but the scan did not finish
// ---------------------------------------------------------------------------

export function IncompleteScanBanner({
  scan,
  continueHref,
}: {
  scan: FleetHealthScan
  continueHref?: string | undefined
}) {
  return (
    <div
      data-testid="fleet-incomplete-banner"
      className="border border-graphite-light rounded-[4px] bg-graphite-deep px-4 py-3"
    >
      <h2 className={`${HEADLINE} text-ember`}>
        SCAN DID NOT FINISH — EVERY COUNT BELOW IS A LOWER BOUND
      </h2>
      <p className={NOTE}>
        More agents may be in each cluster than shown, and correlations the scan never reached are
        missing entirely. Counts can only rise.
      </p>
      <p className={NOTE}>{reasonsFor(scan)}</p>
      {continueHref !== undefined && (
        <div className="mt-3">
          <Link href={continueHref} className={ACTION}>
            Continue the scan
          </Link>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5. The scan failed
// ---------------------------------------------------------------------------

export function FleetScanFailed({ message, retryHref }: { message: string; retryHref: string }) {
  return (
    <div data-testid="fleet-scan-failed" data-scan-complete="false" className={PANEL}>
      <h2 className={`${HEADLINE} text-ember`}>SCAN FAILED</h2>
      <p className={BODY}>{message}</p>
      <p className={NOTE}>
        Nothing on this page has been checked. Do not read this as a healthy fleet — the scan did
        not run, so it made no claim either way.
      </p>
      <div className="mt-3">
        <Link href={retryHref} className={ACTION}>
          Retry the scan
        </Link>
      </div>
    </div>
  )
}

interface ResultProps {
  scan: FleetHealthScan
  widenHref: string
  widenLabel: string
}
