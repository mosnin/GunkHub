/**
 * CausalChainView — composes one `CausalTraversal` into the page body.
 *
 * ===========================================================================
 * TWO DIRECTIONS, TWO REGIONS, NEVER ONE MERGED LIST
 * ===========================================================================
 *
 * "What produced this" and "what ran on this" are opposite questions, and a
 * single list containing both loses the direction the moment the subject row
 * scrolls off. So they are two `<section>`s with two accessible names, each
 * carrying the frontiers that stopped on its own runs — a chain can end at a
 * recorded origin upstream while its downstream trail is lost, and that
 * combination is common and must be readable as exactly that.
 *
 * The subject appears in both, marked YOU ARE HERE, because a ladder with no
 * fixed point is a list of strangers.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF READING
 * ---------------------------------------------------------------------------
 *
 * The incoherence notice comes FIRST, because it qualifies everything below
 * it, and a caveat placed after the thing it qualifies is a caveat nobody
 * reads. Then the completeness banner. Then upstream — the operator arrived
 * holding a failure and the question is "where did this come from". Then
 * downstream. Then the two non-edge bands, which can never move a verdict and
 * must never be read before the things that can.
 */

import {
  convergencePoints,
  downstreamRunCount,
  isCausalTraversalComplete,
  lostTrails,
} from '@agent-flight-recorder/contracts'
import Link from 'next/link'

import type { CausalTraversal, ChainTerminus } from '@agent-flight-recorder/contracts'


import { CausalLadder } from '@/components/causal/CausalLadder'
import { IncoherentTraversalNotice } from '@/components/causal/CausalStates'
import {
  SuspectedLinksPanel,
  UnansweredCausalList,
} from '@/components/causal/SuspectedLinksPanel'
import { buildLadder } from '@/lib/causal/ladder'
import { truncateId } from '@/lib/utils'

interface CausalChainViewProps {
  /** Audited against inbound adjacency. */
  upstream: CausalTraversal
  /** Audited against outbound adjacency. */
  downstream: CausalTraversal
  incoherences: readonly { where: string; what: string }[]
}

/**
 * Which run a frontier stopped on, whichever kind it is.
 *
 * The contract deliberately gives the three termini three DIFFERENT run-id
 * field names (`originRunId` / `reEnteredRunId` / `lastReachedRunId`) so that
 * no template can print one under another's label without narrowing first.
 * This function is the one place that narrowing happens, and it returns `null`
 * for a kind it does not know rather than reaching for a field that might not
 * be there — an unknown frontier becomes UNPLACED, which is stated, instead of
 * silently landing on a ladder it does not belong to.
 */
function terminusRunId(t: ChainTerminus): string | null {
  if (t === null || typeof t !== 'object') return null
  if (t.terminus === 'recorded_origin') return t.originRunId
  if (t.terminus === 'cycle_reentry') return t.reEnteredRunId
  if (t.terminus === 'trail_lost') return t.lastReachedRunId
  return null
}

/** A half's frontiers, split into those on its ladder and those that are not. */
function splitTermini(
  traversal: CausalTraversal,
  onLadder: ReadonlySet<string>,
): { placed: ChainTerminus[]; unplaced: ChainTerminus[] } {
  const placed: ChainTerminus[] = []
  const unplaced: ChainTerminus[] = []
  const all = (Array.isArray(traversal?.termini) ? traversal.termini : []).filter(
    (t): t is ChainTerminus => t !== null && typeof t === 'object',
  )
  for (const t of all) {
    const runId = terminusRunId(t)
    // A frontier whose run is not on the ladder is UNPLACED rather than
    // dropped — silently losing a lost trail is exactly how an unfinished
    // trace renders as a finished one.
    if (runId !== null && onLadder.has(runId)) placed.push(t)
    else unplaced.push(t)
  }
  return { placed, unplaced }
}

export function CausalChainView({ upstream, downstream, incoherences }: CausalChainViewProps) {
  const upLadder = buildLadder(upstream, 'upstream')
  const downLadder = buildLadder(downstream, 'downstream')

  const up = splitTermini(upstream, new Set(upLadder.rows.map((r) => r.node.runId)))
  const down = splitTermini(downstream, new Set(downLadder.rows.map((r) => r.node.runId)))

  const upTermini = up.placed
  const downTermini = down.placed
  const unplaced = [...up.unplaced, ...down.unplaced]

  // BOTH halves must be complete for anything on this page to be a total.
  const complete = isCausalTraversalComplete(upstream) && isCausalTraversalComplete(downstream)
  const blastRadius = downstreamRunCount(downstream)
  const suspected = [
    ...(Array.isArray(upstream?.suspected) ? upstream.suspected : []),
    ...(Array.isArray(downstream?.suspected) ? downstream.suspected : []),
  ]
  const unanswered = [
    ...(Array.isArray(upstream?.unanswered) ? upstream.unanswered : []),
    ...(Array.isArray(downstream?.unanswered) ? downstream.unanswered : []),
  ]

  return (
    <div className="flex flex-col gap-4">
      <IncoherentTraversalNotice findings={incoherences} />

      {!complete && (
        <div
          data-testid="causal-incomplete-banner"
          className="border border-dashed border-graphite-light rounded-[4px] p-3 bg-graphite-deep"
        >
          <h2 className="font-mono text-xs font-semibold text-whiteout">
            THIS TRACE IS NOT COMPLETE — EVERY COUNT BELOW IS A LOWER BOUND
          </h2>
          <p className="mt-1 text-xs text-pewter leading-relaxed">
            At least one frontier lost the trail, or a question below went undecided. The chains
            shown are real; they are not all of it. A count here can only be larger, never smaller.
          </p>
        </div>
      )}

      <div
        data-testid="causal-blast-radius"
        className="border border-graphite rounded-[4px] bg-graphite-deep px-4 py-3 flex items-baseline justify-between gap-4"
      >
        <span className="text-sm text-whiteout">Runs downstream of this one</span>
        <span className="font-mono text-xs text-pewter">
          <span className="text-whiteout text-xl tabular-nums">{blastRadius}</span>{' '}
          {/* The floor/total distinction on the SAME line as the number, not below it. */}
          {complete ? 'reached — a total' : 'reached — a FLOOR, the walk did not finish'}
        </span>
      </div>

      <CausalLadder
        ladder={upLadder}
        termini={upTermini}
        headingId="causal-upstream-heading"
        heading="What produced this run"
        caption="Read top to bottom: causation flows downward, each rung to the one below it. Every rung names the stored row that records its edge. Position here comes only from recorded edges — never from timestamps."
      />

      <CausalLadder
        ladder={downLadder}
        termini={downTermini}
        headingId="causal-downstream-heading"
        heading="What ran on this run's output"
        caption="Read top to bottom: the run you are investigating first, then what each recorded edge leads to. Indentation is the hop distance, which every rung also states in words."
      />

      {unplaced.length > 0 && (
        <div
          data-testid="causal-unplaced-termini"
          className="border border-dotted border-graphite-light rounded-[4px] p-3 bg-graphite-deep"
        >
          <h2 className="font-mono text-xs font-semibold text-whiteout">
            {unplaced.length} {unplaced.length === 1 ? 'FRONTIER' : 'FRONTIERS'} COULD NOT BE PLACED
          </h2>
          <p className="mt-1 text-xs text-pewter leading-relaxed">
            The walk reported stopping at{' '}
            {unplaced.map((t) => terminusRunId(t) ?? 'an unreadable run').join(', ')}, which no
            ladder above contains. They are named rather than dropped: a frontier that vanishes
            makes an unfinished trace look finished.
          </p>
        </div>
      )}

      <ConvergencePanel traversal={upstream} headingId="causal-convergence-heading" />

      <UnansweredCausalList items={unanswered} headingId="causal-unanswered-heading" />

      <SuspectedLinksPanel items={suspected} headingId="causal-suspected-heading" />

      <CoverageFooter
        upstream={upstream}
        downstream={downstream}
        complete={complete}
        lostCount={lostTrails(upstream).length + lostTrails(downstream).length}
      />
    </div>
  )
}

/**
 * WHERE THE CHAIN FORKS — runs with more than one recorded producer.
 *
 * "What caused this?" has a genuinely different answer at a convergence: a
 * single chain has one story, a run that consumed three upstream outputs has
 * THREE, and reading only the first is how the wrong thing gets rolled back.
 * The ladder above is a path, and a path renders a fork as whichever branch
 * happened to be walked first — so the merge points are enumerated here rather
 * than left for someone to notice by counting arrows.
 *
 * A convergence is an ORDINARY INTERIOR NODE, not a fourth terminus: the walk
 * continues through every producer and each branch terminates on its own, so a
 * fan-in band would double-count against the branch termini describing the
 * same walk. (A walk that STOPS at one is a `LostTrail` with kind
 * `convergence_not_followed`, and it renders as a lost trail like any other.)
 * So this is a plain list beside the ladders, with no terminus treatment and
 * no ordinals — its rows are not positions in a chain.
 */
function ConvergencePanel({
  traversal,
  headingId,
}: {
  traversal: CausalTraversal
  headingId: string
}) {
  const points = convergencePoints(traversal)
  if (points.length === 0) return null

  return (
    <section
      aria-labelledby={headingId}
      data-testid="causal-convergence"
      className="border border-graphite rounded-[4px] bg-graphite-deep"
    >
      <div className="flex items-baseline justify-between gap-4 px-4 py-3 border-b border-graphite">
        <h2 id={headingId} className="text-sm font-semibold text-whiteout">
          Where the chain forks
        </h2>
        <span className="font-mono text-xs text-pewter tabular-nums shrink-0">
          <span className="text-whiteout">{points.length}</span>{' '}
          {points.length === 1 ? 'convergence' : 'convergences'}
        </span>
      </div>
      <p className="px-4 py-2 text-xs text-pewter border-b border-graphite leading-relaxed">
        Each of these runs has more than one recorded producer. There are several stories upstream
        of it, not one — the ladder above shows a path, and a path can only show one of them.
      </p>
      <div className="p-3">
        <ul className="flex flex-col gap-2">
          {points.map((p) => (
            <li key={p.runId} className="text-xs text-cloud leading-relaxed">
              <Link
                href={`/runs/${encodeURIComponent(p.runId)}/causal`}
                className="font-mono text-whiteout underline underline-offset-2 hover:text-cloud focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow focus-visible:ring-offset-2 focus-visible:ring-offset-blackout rounded-[4px]"
              >
                {truncateId(p.runId, 20)}
              </Link>{' '}
              has{' '}
              <span className="font-mono text-whiteout tabular-nums">{p.producers.length}</span>{' '}
              recorded producers —{' '}
              <span className="font-mono text-pewter">
                {p.producers.map((e) => truncateId(e.producerRunId, 12)).join(', ')}
              </span>
              . That is {p.producers.length} stories here, not one.
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/**
 * What the walk covered, stated on EVERY outcome including the successful one.
 *
 * Coverage that appears only when something went wrong trains an operator to
 * read its absence as completeness — and completeness is precisely the claim
 * this feature must never make by default.
 */
function CoverageFooter({
  upstream,
  downstream,
  complete,
  lostCount,
}: {
  upstream: CausalTraversal
  downstream: CausalTraversal
  complete: boolean
  lostCount: number
}) {
  // Two walks, two coverage rows. Deliberately NOT summed into one: neither
  // engine made a claim about the pair, and inventing a combined figure would
  // be inventing a completeness nobody asserted.
  const halves = [
    { label: 'Upstream walk', scan: upstream?.scan },
    { label: 'Downstream walk', scan: downstream?.scan },
  ].filter((h): h is { label: string; scan: NonNullable<typeof h.scan> } =>
    h.scan !== null && typeof h.scan === 'object',
  )
  if (halves.length === 0) return null

  return (
    <div
      data-testid="causal-walk-coverage"
      className="border border-graphite rounded-[4px] bg-graphite-deep px-4 py-3"
    >
      <h2 className="font-mono text-xs font-semibold text-whiteout">WHAT THESE WALKS COVERED</h2>
      {halves.map((h) => (
        <dl
          key={h.label}
          data-coverage={h.scan.direction}
          className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs"
        >
          <dt className="font-mono text-pewter whitespace-nowrap">{h.label}</dt>
          <dd className="font-mono text-cloud tabular-nums">
            depth {h.scan.deepestReached} of {h.scan.maxDepthRequested} asked for,{' '}
            {h.scan.runsVisited} run(s) visited, {h.scan.edgesRead} edge(s) read
          </dd>
          <dt className="font-mono text-pewter whitespace-nowrap">Edge sets read in full</dt>
          {/*
            `false` is worse than a missing arrow nobody recorded: it means the
            graph may be missing arrows the engine HAD access to, and a sampled
            edge set produces a plausible, connected, entirely wrong picture of
            an incident.
          */}
          <dd className="font-mono text-cloud">
            {h.scan.edgeSetsComplete
              ? 'yes'
              : 'NO — arrows the engine could have read may be missing from this graph'}
          </dd>
        </dl>
      ))}
      <p className="mt-2 text-xs text-pewter leading-relaxed font-mono">
        Frontiers that lost the trail: <span className="text-whiteout tabular-nums">{lostCount}</span>
      </p>
      <p className="mt-2 text-xs text-pewter leading-relaxed">
        {complete
          ? 'These walks see recorded edges and nothing else. A handoff that happened without being recorded is not on this page and cannot be — so nothing here is evidence that two runs are unrelated.'
          : 'These walks did not both finish, and they see recorded edges and nothing else. A handoff that happened without being recorded is not on this page and cannot be — so nothing here is evidence that two runs are unrelated, and nothing on it is a complete trace.'}
      </p>
      <p className="mt-1 text-xs text-pewter leading-relaxed">
        The two directions were walked separately, so they are two snapshots rather than one. Each
        states its own coverage above; neither is combined into a claim the other did not make.
      </p>
    </div>
  )
}
