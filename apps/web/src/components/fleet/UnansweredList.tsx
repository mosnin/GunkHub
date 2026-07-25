/**
 * UnansweredList — the third band: questions the scan could not decide.
 *
 * ===========================================================================
 * WHY A THIRD BAND EXISTS AT ALL
 * ===========================================================================
 *
 * A real scan over a real roster routinely lands on a question it cannot
 * answer: an agent whose versions declare no model, so whether it shares the
 * cluster's model is unknown; a roster page that ran out of budget, so whether
 * the burst is 12 agents or 40 is unread. With only OBSERVED and HYPOTHESIS
 * available, both places to put that are lies — file it as observed and a gap
 * becomes a fact; file it as a hypothesis and "we could not check" renders as
 * "we checked, and here is a theory". Dropping it is worse than either,
 * because a gap rendered as nothing reads as nothing wrong.
 *
 * ---------------------------------------------------------------------------
 * A THIRD ELEMENT SHAPE, AND A THIRD GRAMMATICAL MOOD
 * ---------------------------------------------------------------------------
 *
 * The findings band is a grid of rows. The hypothesis band is a list of
 * conditional proposals with a base-rate measurement. This band is a list of
 * OPEN QUESTIONS with a `<dl>` of two fields that appear nowhere else:
 * `WHAT BLOCKED IT` and `TO MAKE THIS ANSWERABLE`. It carries no measurement
 * of any kind, and it never links to a run — there is nothing recorded to
 * link to, which is the whole point of the band.
 *
 * The `remedy` field is what separates "I cannot tell" from "I cannot tell
 * YET, and here is what to do". A band that reads as a shrug is one people
 * learn to click past, which during an incident means clicking past the only
 * honest thing on the screen. So a question without a remedy says so
 * explicitly rather than simply ending.
 */

import Link from 'next/link'

import type { UnansweredFleetQuestion } from '@agent-flight-recorder/contracts'

import { UnansweredMarker } from '@/components/fleet/EvidenceMarker'
import { UNANSWERED_KIND_LABEL } from '@/lib/fleet/labels'
import { usableArray } from '@/lib/fleet/safe'

const FIELD_LABEL = 'text-xs font-mono uppercase text-pewter tracking-tight'

export function UnansweredList({ items }: { items: readonly UnansweredFleetQuestion[] }) {
  return (
    <ul className="flex flex-col">
      {items.map((q) => (
        <li
          key={q.questionKey}
          className="border-b border-graphite last:border-b-0 px-4 py-3 flex flex-col gap-2"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <span className="shrink-0 mt-0.5">
              <UnansweredMarker />
            </span>
            <h3 className="text-sm text-cloud leading-relaxed min-w-0">
              {/* Phrased as the OPEN QUESTION — never as a claim, never as a
                  concern. The contract requires the engine to write it that
                  way; this renders it verbatim. */}
              Undecided: {q.undecidedQuestion}
            </h3>
          </div>

          <dl className="pl-1 flex flex-col gap-1.5 max-w-3xl">
            <div className="flex flex-col gap-0.5">
              <dt className={FIELD_LABEL}>What blocked it</dt>
              <dd className="text-sm text-pewter leading-relaxed">
                {q.unknownBecause}{' '}
                <span className="font-mono text-xs">({UNANSWERED_KIND_LABEL[q.kind]})</span>
              </dd>
            </div>

            <div className="flex flex-col gap-0.5">
              <dt className={FIELD_LABEL}>To make this answerable</dt>
              <dd className="text-sm text-cloud leading-relaxed">
                {q.remedy ??
                  'The engine reported no remedy for this one. It stays open until the scan can be run with more budget, or the underlying data is completed.'}
              </dd>
            </div>

            {usableArray<string>(q.agentIds).length > 0 && (
              <div className="flex flex-col gap-0.5">
                <dt className={FIELD_LABEL}>Bears on these agents</dt>
                <dd>
                  <ul className="flex flex-wrap gap-x-4 gap-y-1">
                    {usableArray<string>(q.agentIds).map((id) => (
                      <li key={id}>
                        <Link
                          href={`/agents/${encodeURIComponent(id)}`}
                          className="font-mono text-xs text-cloud hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
                        >
                          {id}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        </li>
      ))}
    </ul>
  )
}
