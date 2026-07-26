/**
 * CausalLadder — one direction of a causal chain, as a ladder of runs.
 *
 * See `@/lib/causal/ladder` for why this is a ladder and not a node-link
 * diagram, and why nothing on it is positioned by time.
 *
 * ===========================================================================
 * WHERE THE TERMINI GO, AND WHY IT IS NOT A DETAIL
 * ===========================================================================
 *
 * A `RecordedOrigin` renders INSIDE the `<li>` of the rung it proved. It is a
 * run: the walk reached it, read its complete edge set, and found it empty. It
 * has an ordinal and it is counted.
 *
 * A `LostTrail` renders as an `<aside>` AFTER the `</ol>` closes. It is not a
 * run — it marks the place a run is MISSING — so it gets no ordinal and is not
 * counted. That is the same claim the words and the field labels make, carried
 * a fourth time in DOM shape, where it survives every stylesheet being thrown
 * away.
 *
 * ===========================================================================
 * EVERY RUNG STATES WHAT RECORDED ITS EDGE, ALWAYS VISIBLE
 * ===========================================================================
 *
 * The citation is not behind a disclosure. A row whose evidence is one click
 * away gets read as a bare assertion, and "these two runs are connected" is
 * the assertion on this screen that must never be taken on trust. Every
 * non-subject rung shows the edge kind and the row that stores it — a run
 * field, an event with its sequence number, or an artifact with its SHA-256 —
 * from `RecordedCausalEdge.recordedBy`, which the contract types as non-empty.
 *
 * ===========================================================================
 * PER-ROW ADJACENCY IS THREE-VALUED AND SAYS SO
 * ===========================================================================
 *
 * `CausalNode.adjacency` distinguishes "the complete edge set was read and it
 * is empty" from "we did not read it". Collapsing those into a blank cell
 * would recreate, per row, the exact origin/lost-trail conflation the terminus
 * machinery exists to prevent — and it would do it 40 times on one screen.
 * Each row prints its own word.
 *
 * ===========================================================================
 * DEPTH IS TEXT, NOT ONLY INDENTATION
 * ===========================================================================
 *
 * Indentation is a styling channel, and a styling channel carries nothing once
 * the classes are gone — strip them and an indented tree collapses into a flat
 * list with its structure destroyed. So each row states its hop distance in
 * words as well.
 */

import Link from 'next/link'

import type { Ladder, LadderRow } from '@/lib/causal/ladder'
import type {
  CausalEvidence,
  ChainTerminus,
  RecordedCausalEdge,
} from '@agent-flight-recorder/contracts'

import {
  CycleReEntryTerminus,
  LostTrailTerminus,
  RecordedOriginTerminus,
  TERMINUS_STATE_WORD,
} from '@/components/causal/Terminus'
import { Badge } from '@/components/ui/Badge'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { truncateId } from '@/lib/utils'

/** Past-tense words for the recorded edge kinds. Never "caused". */
const EDGE_WORD: Readonly<Record<string, string>> = {
  spawned: 'was started by',
  artifact_handoff: 'read an artifact written by',
  output_consumed: 'was invoked with the output of',
  retry_of: 'is a retry of',
  delegated_to: 'was delegated to by',
}

/**
 * The three-valued adjacency, in words on every row.
 *
 * `no_edge_recorded` is a claim (we looked, it is empty). `adjacency_unread`
 * is the absence of one. They must never share a rendering — and neither may
 * be silent, because a blank cell reads as the reassuring one.
 */
const ADJACENCY_WORD: Readonly<Record<string, string>> = {
  edge_recorded: 'further edges recorded',
  no_edge_recorded: 'edge set read — empty',
  adjacency_unread: 'edge set NOT READ',
}

interface CausalLadderProps {
  ladder: Ladder
  /** Termini whose run sits on this ladder. */
  termini: readonly ChainTerminus[]
  headingId: string
  heading: string
  /** One sentence stating what this direction means. Never decorative. */
  caption: string
}

export function CausalLadder({ ladder, termini, headingId, heading, caption }: CausalLadderProps) {
  const rows = ladder.rows
  const origins = termini.filter((t) => t?.terminus === 'recorded_origin')
  // Everything that is NOT an origin renders after the list, because only an
  // origin is a proof about a rung. A cycle re-entry closed the walk and a
  // lost trail did not, and they are told apart by their own words, glyphs,
  // field labels and — for the cycle — the ordered loop path it carries.
  const afterList = termini.filter((t) => t?.terminus !== 'recorded_origin')

  const originByRun = new Map<string, Extract<ChainTerminus, { terminus: 'recorded_origin' }>>()
  for (const o of origins) {
    if (o.terminus === 'recorded_origin') originByRun.set(o.originRunId, o)
  }

  return (
    <section
      aria-labelledby={headingId}
      data-direction={ladder.direction}
      className="border border-graphite rounded-[4px] bg-graphite-deep"
    >
      <div className="flex items-baseline justify-between gap-4 px-4 py-3 border-b border-graphite">
        <h2 id={headingId} className="text-sm font-semibold text-whiteout">
          {heading}
        </h2>
        <div className="flex items-baseline gap-3 shrink-0 font-mono text-xs text-pewter tabular-nums">
          <span>
            <span className="text-whiteout">{rows.length}</span>{' '}
            {rows.length === 1 ? 'run' : 'runs'}
          </span>
          {/*
            One state word per frontier. A ladder with three frontiers, two
            ended and one lost, must not be summarised into a single word —
            summarising is what turns "mostly finished" into "finished".
          */}
          {termini.map((t, i) => (
            <span key={`${t?.terminus}:${i}`} data-chain-state={t?.terminus} className="text-cloud">
              {TERMINUS_STATE_WORD[t?.terminus] ??
                'TERMINUS UNREADABLE'}
            </span>
          ))}
        </div>
      </div>

      <p className="px-4 py-2 text-xs text-pewter border-b border-graphite leading-relaxed">
        {caption}
      </p>

      <div className="p-3">
        {rows.length === 0 ? (
          // Not an ordinary empty state: the subject is always a row, so zero
          // rows means the traversal could not be read. Saying so beats a
          // blank box, which reads as "no lineage".
          <p className="text-xs text-ember leading-relaxed">
            No rows could be built for this direction, not even the run being investigated. That is
            a defect in the traversal, not a statement that this run has no lineage.
          </p>
        ) : (
          <ol className="flex flex-col gap-0">
            {rows.map((row, i) => (
              <Rung
                key={`${row.node.runId}:${i}`}
                row={row}
                ordinal={i + 1}
                direction={ladder.direction}
              >
                {(() => {
                  const origin = originByRun.get(row.node.runId)
                  return origin === undefined ? null : <RecordedOriginTerminus origin={origin} />
                })()}
              </Rung>
            ))}
          </ol>
        )}

        {/*
          NO FRONTIER AT ALL. `CausalTraversal.termini` is a NON-EMPTY tuple, so
          this shape is unspellable in typed code — and Team A observed it on
          the wire, for an ordinary parent/child pair.

          It is the purest form of the defect this whole surface exists against:
          with no terminus rendered, the ladder simply ends, and a ladder that
          simply ends reads as a chain that ended. Every natural check agrees —
          `termini.every(t => t.terminus === 'recorded_origin')` is VACUOUSLY
          TRUE over an empty list. So the absence is rendered as loudly as any
          lost trail, and deliberately in the same slot a terminus would occupy.
        */}
        {termini.length === 0 && (
          <p
            data-terminus="absent"
            className="mt-3 border border-dotted border-graphite-light rounded-[4px] p-3 text-xs text-ember leading-relaxed"
          >
            NO FRONTIER REPORTED — this walk did not say where it stopped. A walk always stops
            somewhere, so this is a defect in the traversal rather than a chain that ended. Do not
            read the rungs above as complete.
          </p>
        )}

        {afterList.map((t, i) => {
          if (t.terminus === 'trail_lost') {
            return <LostTrailTerminus key={`lost:${t.lastReachedRunId}:${i}`} lost={t} />
          }
          if (t.terminus === 'cycle_reentry') {
            return <CycleReEntryTerminus key={`cycle:${t.reEnteredRunId}:${i}`} cycle={t} />
          }
          // A frontier speaking a vocabulary this build does not know. Named,
          // never dropped: a frontier that vanishes makes an unfinished trace
          // look finished.
          return (
            <p key={`unknown:${i}`} data-terminus="unknown" className="mt-3 text-xs text-ember leading-relaxed">
              A frontier of this walk reported a kind of stop this page does not recognise, so it
              cannot be shown. Do not read the chain above as finished.
            </p>
          )
        })}

        {ladder.orphanNodeIds.length > 0 && (
          <p
            data-testid="causal-orphan-nodes"
            className="mt-3 text-xs text-pewter leading-relaxed font-mono"
          >
            {ladder.orphanNodeIds.length} run
            {ladder.orphanNodeIds.length === 1 ? ' was' : 's were'} read by the walk but no recorded
            edge places {ladder.orphanNodeIds.length === 1 ? 'it' : 'them'} on this chain, so{' '}
            {ladder.orphanNodeIds.length === 1 ? 'it is' : 'they are'} not shown above.
          </p>
        )}
      </div>
    </section>
  )
}

interface RungProps {
  row: LadderRow
  ordinal: number
  direction: Ladder['direction']
  children?: React.ReactNode
}

function Rung({ row, ordinal, direction, children }: RungProps) {
  const { node, arrivedBy } = row
  const indent = direction === 'downstream' ? Math.min(row.depth, 8) * 16 : 0

  return (
    <li
      data-rung={ordinal}
      data-depth={row.depth}
      className="py-1.5"
      style={indent > 0 ? { paddingInlineStart: indent } : undefined}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-pewter tabular-nums w-6 shrink-0" aria-hidden="true">
          {ordinal}
        </span>
        <span className="sr-only">Rung {ordinal}. </span>

        <Badge status={node.status} />

        <Link
          href={`/runs/${encodeURIComponent(node.runId)}`}
          className="font-mono text-xs text-whiteout underline underline-offset-2 hover:text-cloud focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow focus-visible:ring-offset-2 focus-visible:ring-offset-blackout rounded-[4px]"
        >
          {truncateId(node.runId, 20)}
        </Link>
        <CopyToClipboardButton value={node.runId} label={`Copy run id ${node.runId}`} />

        <span className="font-mono text-xs text-pewter tabular-nums ml-auto shrink-0">
          {row.depth === 0 ? 'this run' : `${row.depth} ${row.depth === 1 ? 'hop' : 'hops'} away`}
        </span>

        <span
          data-adjacency={node.adjacency}
          className="font-mono text-xs text-pewter shrink-0 border border-graphite-light rounded-[4px] px-1.5 py-0.5"
        >
          {ADJACENCY_WORD[node.adjacency] ?? 'adjacency UNREADABLE'}
        </span>

        {row.isSubject && (
          <span className="font-mono text-xs text-neon-glow border border-graphite-light rounded-[4px] px-1.5 py-0.5 shrink-0">
            YOU ARE HERE
          </span>
        )}
      </div>

      {/*
        The citation, always visible. This is the one row on the screen whose
        claim is "these two runs are connected", so its evidence is not behind
        a disclosure. A row with no `arrivedBy` is the subject — and
        `@/lib/causal/ladder` guarantees that, because it only ever appends a
        row it holds a recorded edge for.
      */}
      {arrivedBy !== undefined ? (
        <p className="ml-8 mt-0.5 text-xs text-pewter font-mono leading-relaxed">
          <span aria-hidden="true">└ </span>
          {EDGE_WORD[arrivedBy.kind] ?? arrivedBy.kind}{' '}
          <span className="text-cloud">
            {truncateId(
              direction === 'upstream' ? arrivedBy.consumerRunId : arrivedBy.producerRunId,
              16,
            )}
          </span>
          {' — '}
          <CitationText edge={arrivedBy} />
        </p>
      ) : (
        <p className="ml-8 mt-0.5 text-xs text-pewter leading-relaxed">
          On this chain because you asked about it — not because of a recorded edge.
        </p>
      )}

      {children}
    </li>
  )
}

/**
 * The stored row that carries the edge, named so an operator can open it and
 * check the claim. That checkability is what makes a `RecordedCausalEdge` a
 * fact rather than an assertion.
 */
function CitationText({ edge }: { edge: RecordedCausalEdge }) {
  const cites: CausalEvidence[] = Array.isArray(edge.recordedBy) ? edge.recordedBy : []
  const first = cites[0]
  if (first === undefined) {
    // Unreachable through the contract's non-empty tuple, and rendered anyway:
    // this crosses a wire, and an edge with no citation must read as a defect
    // rather than as a bare arrow.
    return <span className="text-ember">no citation was carried — do not trust this edge</span>
  }
  const more = cites.length > 1 ? ` (+${cites.length - 1} more)` : ''

  if (first.cites === 'run_field') {
    return (
      <>
        recorded in run field <span className="text-cloud">{first.field}</span> on run{' '}
        <span className="text-cloud">{truncateId(first.recordedInRunId, 16)}</span>
        {more}
      </>
    )
  }
  if (first.cites === 'event') {
    return (
      <>
        recorded in event <span className="text-cloud">{first.eventType}</span> #
        <span className="text-cloud tabular-nums">{first.sequenceNumber}</span> on run{' '}
        <span className="text-cloud">{truncateId(first.recordedInRunId, 16)}</span>
        {more}
      </>
    )
  }
  return (
    <>
      {/*
        BOTH the digest and the role, because they carry different halves of
        the claim. The SHA-256 is what makes this an identity claim rather than
        a filename collision — two runs referencing "output.json" share a name,
        two referencing the same digest share a byte sequence. The ROLE is what
        gives it a DIRECTION: a shared hash has none, a recorded read does.
        Printing the digest alone would show a coincidence dressed as an edge.
      */}
      recorded by run{' '}
      <span className="text-cloud">{truncateId(first.recordedInRunId, 16)}</span> having{' '}
      <span className="text-cloud">{first.role}</span> artifact{' '}
      <span className="text-cloud">{truncateId(first.artifactId, 12)}</span> sha
      <span className="text-cloud">{first.sha256.slice(0, 8)}</span>
      {more}
    </>
  )
}
