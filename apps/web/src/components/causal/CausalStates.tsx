/**
 * CausalStates — the ways this screen can have no chain to show.
 *
 * ===========================================================================
 * WHY THESE ARE SEPARATE COMPONENTS AND NOT ONE EMPTY STATE
 * ===========================================================================
 *
 * "There is no lineage here" is four different facts with four different next
 * moves, and a generic empty state renders them identically:
 *
 *   NOTHING RECORDED       The walk finished, read edge sets, and found no
 *   (`isolated`)           edges. As far as anything was WRITTEN DOWN this run
 *                          stands alone — which is not the same as standing
 *                          alone, because recording is opt-in.
 *                          Next move: instrument the handoffs you expected.
 *
 *   WALK DID NOT FINISH    No edges, and we did not finish looking. "Found
 *   (`indeterminate`)      nothing" is not evidence here, and this is the most
 *                          likely outcome during a real incident.
 *                          Next move: raise the bound, resume, re-root.
 *
 *   QUERY FAILED           We know nothing. Next move: retry.
 *
 *   INCOHERENT             The traversal's own contents contradict each other.
 *                          Withheld rather than drawn.
 *
 * Which of the first two applies is decided by the contract's
 * `computeCausalVerdict` over `isCausalTraversalComplete` — never by this
 * file, and never by `edges.length === 0`. `isCausalTraversalComplete` exists
 * precisely because a predicate built only from "nothing went wrong" clauses
 * is vacuously true on an empty walk, and would certify a run as isolated from
 * zero reads.
 *
 * Collapsing any two of these is the failure `@/lib/services/serviceResult`
 * documents at length: the calmest copy wins by default, and the more broken
 * the backend, the more settled the product looks. On a surface whose job is
 * to say where a failure came from, "no lineage" rendered over an exception is
 * close to the worst available outcome.
 *
 * The four never share copy, never share a `data-testid`, and remain distinct
 * with every presentational attribute stripped — proved in
 * tests/unit/causal_ui_chain.test.tsx.
 */

import Link from 'next/link'

import type { CausalScan } from '@agent-flight-recorder/contracts'

const PANEL = 'border rounded-[4px] p-4 bg-graphite-deep'
const HEAD = 'font-mono text-sm font-semibold text-whiteout'
const BODY = 'mt-2 text-xs text-cloud leading-relaxed'
const DT = 'font-mono text-pewter whitespace-nowrap'
const DD = 'text-cloud leading-relaxed'
const DL = 'mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs'
const LINK =
  'inline-block mt-3 font-mono text-xs text-cloud underline underline-offset-2 hover:text-whiteout focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow focus-visible:ring-offset-2 focus-visible:ring-offset-blackout rounded-[4px]'

/**
 * `verdict: 'isolated'` — an EARNED answer, and bounded in the same breath.
 *
 * The bound is not decoration. The walk was complete over what was recorded;
 * it says nothing about handoffs nobody instrumented, and an operator who
 * reads this as "this run is unrelated to anything" has over-read it by
 * exactly the gap between those two sentences.
 */
export function NothingRecordedResult({
  subjectRunId,
  docsHref,
}: {
  subjectRunId: string
  docsHref: string
}) {
  return (
    <div data-testid="causal-isolated" className={`${PANEL} border-solid border-graphite-light`}>
      <h2 className={HEAD}>NO RECORDED EDGES — AND THE WALK FINISHED</h2>
      <p className={BODY}>
        Every edge set the walk touched was read to completion, and{' '}
        <span className="font-mono text-whiteout">{subjectRunId}</span> has no recorded neighbours in
        either direction. This is an answer, not an absence of data.
      </p>
      <p className={BODY}>
        <span className="text-whiteout">And it is bounded.</span> It covers what was WRITTEN DOWN.
        Recording is opt-in, so a handoff nobody instrumented is invisible to any walk however
        complete — this is not a finding that the run is unrelated to anything.
      </p>
      <Link href={docsHref} className={LINK}>
        How to record a causal edge
      </Link>
    </div>
  )
}

/**
 * `verdict: 'indeterminate'` — the walk did not finish. Not an answer.
 *
 * Names the specific bound rather than shrugging: a terminus that reads as a
 * shrug is one people learn to click past, which during an incident means
 * clicking past the only honest thing on the screen.
 */
export function WalkDidNotFinishResult({
  scan,
  reasons,
  continueHref,
}: {
  scan: CausalScan
  /** The specific obstacles, from the traversal's termini and unanswered set. */
  reasons: readonly string[]
  continueHref: string
}) {
  return (
    <div data-testid="causal-indeterminate" className={`${PANEL} border-dashed border-graphite-light`}>
      <h2 className={HEAD}>WALK DID NOT FINISH — THIS IS NOT A RESULT</h2>
      <p className={BODY}>
        No recorded edges were found AND the walk did not finish looking, so this page is not a
        finding that the run stands alone. Every count below is a{' '}
        <span className="text-whiteout">LOWER BOUND</span>: it can only be larger, never smaller —
        and it is likeliest to be larger during an incident, when the graph is biggest.
      </p>
      <dl className={DL}>
        <dt className={DT}>Depth asked for</dt>
        <dd className={`${DD} font-mono tabular-nums`}>{scan.maxDepthRequested}</dd>
        <dt className={DT}>Deepest reached</dt>
        <dd className={`${DD} font-mono tabular-nums`}>{scan.deepestReached}</dd>
        <dt className={DT}>Runs visited</dt>
        <dd className={`${DD} font-mono tabular-nums`}>{scan.runsVisited}</dd>
        <dt className={DT}>What stopped it</dt>
        <dd className={DD}>
          {reasons.length === 0 ? (
            'The traversal reported no specific obstacle, which is itself a defect — an unexplained stop is indistinguishable from laziness.'
          ) : (
            <ul className="flex flex-col gap-1">
              {reasons.map((r, i) => (
                <li key={`${i}:${r.slice(0, 24)}`}>{r}</li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      <Link href={continueHref} className={LINK}>
        Walk again with a larger depth
      </Link>
    </div>
  )
}

/** The query failed. We know nothing, and must claim nothing. */
export function CausalWalkFailed({ message, retryHref }: { message: string; retryHref: string }) {
  return (
    <div data-testid="causal-failed" className={`${PANEL} border-solid border-system-warning`}>
      <h2 className={HEAD}>QUERY FAILED</h2>
      <p className={`${BODY} text-ember`}>{message}</p>
      <p className={BODY}>
        Do not read this as a run with no lineage. The walk did not run, so nothing here is a fact
        about what produced this run or about what ran on its output.
      </p>
      <Link href={retryHref} className={LINK}>
        Retry the walk
      </Link>
    </div>
  )
}

/**
 * The traversal's own contents contradict each other, per the contract's
 * `traversalIncoherences` / `traversalUnusableFields`.
 *
 * WITHHELD rather than drawn, and STATED rather than dropped: a silently
 * shorter chain ends earlier than it should, and an early end reads as a
 * finding. This is what keeps a validation gate from becoming a second,
 * quieter way to lose the trail.
 */
export function IncoherentTraversalNotice({
  findings,
}: {
  findings: readonly { where: string; what: string }[]
}) {
  if (findings.length === 0) return null
  return (
    <div
      data-testid="causal-incoherent"
      className="border border-graphite-light rounded-[4px] p-3 bg-graphite-deep"
    >
      <h2 className="font-mono text-xs font-semibold text-whiteout">
        {findings.length === 1
          ? '1 PART OF THIS TRAVERSAL CONTRADICTS ITSELF'
          : `${findings.length} PARTS OF THIS TRAVERSAL CONTRADICT IT`}
      </h2>
      <p className="mt-1 text-xs text-pewter leading-relaxed">
        Each of these arrived describing the graph and could not be believed. Nothing built from
        them is drawn — an edge that cannot be checked is indistinguishable from an inferred one,
        and this surface never draws an inferred one. The chain shown may therefore stop earlier
        than the record does.
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {findings.map((f, i) => (
          <li key={`${f.where}:${i}`} className="text-xs text-cloud leading-relaxed">
            <span className="font-mono text-pewter">{f.where}</span> — {f.what}
          </li>
        ))}
      </ul>
    </div>
  )
}
