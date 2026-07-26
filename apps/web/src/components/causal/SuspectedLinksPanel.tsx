/**
 * SuspectedLinksPanel — the coincidences, and every affordance that could make
 * one look like an edge, removed.
 *
 * ===========================================================================
 * THE RULE THIS COMPONENT EXISTS TO NOT BREAK
 * ===========================================================================
 *
 * A causal edge is RECORDED, never inferred. Nothing in this UI may suggest a
 * link the data does not assert — and the easiest way to suggest one is not a
 * label, it is a LAYOUT. Two runs placed in sequence read as a sequence. A
 * sequence reads as a chain. No amount of "these may be unrelated" copy
 * survives contact with a list that looks like the ladder above it.
 *
 * `SuspectedLink` is the contract's quarantine for these: no direction, no
 * producer/consumer pair, no `recordedFact`, no prose headline at all. Its
 * sentence is composed by `suspicionQuestion`, which is interrogative in every
 * branch and directional in none. So the rendering rule here is simply: do not
 * add back what the type deliberately withheld.
 *
 *   NOT ORDERED BY TIME. The load-bearing one. `firstSeenAt`/`lastSeenAt`
 *   exist on the type, and this panel does not sort by them: a time-ordered
 *   list of runs beside a causal chain is read as the chain's timeline, and
 *   `temporal_adjacency` is itself one of the suspicion kinds — ordering these
 *   by time would stage the very inference the panel exists to refuse. Rows
 *   are sorted by `linkKey`: stable, shareable, and meaningless as a sequence.
 *
 *   NOT AN `<ol>`, AND NEITHER ARE THE RUN IDS. Ordinals mark position in a
 *   chain; there are no positions here. `runIds` is explicitly unordered in
 *   the contract, so the ids are additionally SORTED before display — a reader
 *   who takes `runIds[0]` as "the cause" is reading something that is not
 *   there, and an arrival-ordered list invites exactly that.
 *
 *   NO ARROWS, NO CONNECTORS, NO INDENTATION. Nothing draws a line between two
 *   runs and every row sits at the same offset.
 *
 *   A SEPARATE, SEPARATELY-NAMED LANDMARK outside every ladder, so a
 *   screen-reader user cannot arrive here believing they are still reading
 *   lineage.
 *
 *   EVERY ROW CARRIES ITS OWN LIMIT AND ITS OWN FIX. `notAnEdgeBecause` and
 *   `wouldBeRecordedBy` are required by the contract and both are rendered per
 *   row, not once in a heading a scanner skips. Unlike a fleet hypothesis,
 *   which is closed by an experiment, a suspicion is closed by CODE — and it
 *   stays open forever until somebody writes it.
 */

import { suspicionQuestion } from '@agent-flight-recorder/contracts'
import Link from 'next/link'


import type { SuspectedLink } from '@agent-flight-recorder/contracts'

import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { truncateId } from '@/lib/utils'

interface SuspectedLinksPanelProps {
  items: readonly SuspectedLink[]
  headingId: string
}

export function SuspectedLinksPanel({ items, headingId }: SuspectedLinksPanelProps) {
  const rows = [...items]
    .filter((s): s is SuspectedLink => s !== null && typeof s === 'object')
    .sort((a, b) => (a.linkKey ?? '').localeCompare(b.linkKey ?? ''))

  return (
    <section
      aria-labelledby={headingId}
      data-testid="causal-suspected"
      className="border border-graphite rounded-[4px] bg-graphite-deep"
    >
      <div className="flex items-baseline justify-between gap-4 px-4 py-3 border-b border-graphite">
        <h2 id={headingId} className="text-sm font-semibold text-whiteout">
          Coincidences — nothing recorded a handoff
        </h2>
        <span className="font-mono text-xs text-pewter tabular-nums shrink-0">
          <span className="text-whiteout">{rows.length}</span>{' '}
          {rows.length === 1 ? 'coincidence' : 'coincidences'}
        </span>
      </div>

      <p className="px-4 py-2 text-xs text-pewter border-b border-graphite leading-relaxed">
        Nothing below is an edge, and nothing below is evidence that there is no edge. Each is a
        reason someone might wrongly draw one. They carry no direction, they are never walked, and
        they cannot move the verdict above. Listed by key, not by time: an ordering by time would
        read as a sequence, and a sequence would read as a chain.
      </p>

      <div className="p-3">
        {rows.length === 0 ? (
          <p className="text-xs text-pewter leading-relaxed">
            No coincidences were raised for this run. That is not a finding either — it means
            nothing was flagged, not that nothing is related.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((s) => (
              <li key={s.linkKey} data-suspicion={s.kind} className="flex flex-col gap-1">
                {/*
                  Composed by the contract, interrogative in every branch. A
                  free-text headline is the one field no amount of surrounding
                  chrome survives at 3am, which is why the type has none.
                */}
                <h3 className="text-xs text-cloud leading-relaxed">{suspicionQuestion(s)}</h3>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="font-mono text-pewter whitespace-nowrap">Why this is not an edge</dt>
                  <dd className="text-cloud leading-relaxed">{s.notAnEdgeBecause}</dd>
                  <dt className="font-mono text-pewter whitespace-nowrap">
                    Would be recorded by
                  </dt>
                  <dd className="text-cloud leading-relaxed">{s.wouldBeRecordedBy}</dd>
                  <dt className="font-mono text-pewter whitespace-nowrap">Runs involved</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    {/*
                      Sorted, because the contract says the order carries no
                      meaning and a list in arrival order invites a reader to
                      find one anyway.
                    */}
                    {[...(Array.isArray(s.runIds) ? s.runIds : [])].sort().map((id) => (
                      <span key={id} className="inline-flex items-center gap-1">
                        <Link
                          href={`/runs/${encodeURIComponent(id)}`}
                          className="font-mono text-xs text-cloud underline underline-offset-2 hover:text-whiteout focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow focus-visible:ring-offset-2 focus-visible:ring-offset-blackout rounded-[4px]"
                        >
                          {truncateId(id, 16)}
                        </Link>
                        <CopyToClipboardButton value={id} label={`Copy run id ${id}`} />
                      </span>
                    ))}
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/**
 * Questions the walk could not answer — the third band.
 *
 * Not an edge and not the absence of one. Rendered because a gap shown as
 * nothing reads as "nothing wrong", and because in the contract every one of
 * these makes the traversal incomplete, which is what stops the verdict
 * certifying an island.
 */
export function UnansweredCausalList({
  items,
  headingId,
}: {
  items: readonly {
    questionKey: string
    kind: string
    undecidedQuestion: string
    unknownBecause: string
    remedy?: string
  }[]
  headingId: string
}) {
  const rows = items.filter((q) => q !== null && typeof q === 'object')
  if (rows.length === 0) return null

  return (
    <section
      aria-labelledby={headingId}
      data-testid="causal-unanswered"
      className="border border-graphite rounded-[4px] bg-graphite-deep"
    >
      <div className="flex items-baseline justify-between gap-4 px-4 py-3 border-b border-graphite">
        <h2 id={headingId} className="text-sm font-semibold text-whiteout">
          What this walk could not decide
        </h2>
        <span className="font-mono text-xs text-pewter tabular-nums shrink-0">
          <span className="text-whiteout">{rows.length}</span>{' '}
          {rows.length === 1 ? 'question' : 'questions'}
        </span>
      </div>

      <p className="px-4 py-2 text-xs text-pewter border-b border-graphite leading-relaxed">
        Neither findings nor the absence of findings. Each of these is why nothing on this page is a
        complete trace.
      </p>

      <div className="p-3">
        <ul className="flex flex-col gap-3">
          {rows.map((q) => (
            <li key={q.questionKey} className="flex flex-col gap-1">
              <h3 className="text-xs text-cloud leading-relaxed">{q.undecidedQuestion}</h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="font-mono text-pewter whitespace-nowrap">What blocked it</dt>
                <dd className="text-cloud leading-relaxed">
                  <span className="font-mono text-pewter">{q.kind}</span> — {q.unknownBecause}
                </dd>
                {q.remedy !== undefined && (
                  <>
                    <dt className="font-mono text-pewter whitespace-nowrap">
                      To make this answerable
                    </dt>
                    <dd className="text-cloud leading-relaxed">{q.remedy}</dd>
                  </>
                )}
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
