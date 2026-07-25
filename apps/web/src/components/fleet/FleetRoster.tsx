/**
 * FleetRoster — the raw material, deliberately BELOW the correlations.
 *
 * ===========================================================================
 * WHY THE ROSTER IS NOT THE HEADLINE
 * ===========================================================================
 *
 * Nine agent rows are what an operator would have to assemble a conclusion
 * from, one at a time, under pressure. The correlation bands above already did
 * that assembly. So the roster sits last: it is where you go to check the
 * assembly, or to find the agent that the correlations did NOT connect to
 * anything.
 *
 * Ordering is by concern — failing, then degrading, then unobserved, then
 * healthy — because the point of a roster during an incident is finding the
 * rows that need attention, not reading it alphabetically.
 *
 * ---------------------------------------------------------------------------
 * `unobserved` IS NOT `healthy`, AND THE COPY NEVER LETS IT READ AS ONE
 * ---------------------------------------------------------------------------
 *
 * An agent with no runs in the window has not passed anything — it has not
 * been tested. It is the state an agent lands in precisely when it has
 * silently stopped being invoked at all (a scheduler died, a queue backed up),
 * which is itself an incident worth seeing. So it is ordered ABOVE healthy,
 * labelled `NOT OBSERVED` rather than with any word implying a pass, and its
 * meaning is spelled out for assistive technology.
 *
 * `observationTruncated` marks rows whose counts are FLOORS. A truncated row
 * showing `HEALTHY` is not an earned pass, and the row says so rather than
 * relying on the reader to have noticed the scan banner further up.
 */

import Link from 'next/link'

import type { AgentHealthEntry } from '@agent-flight-recorder/contracts'

import { AGENT_HEALTH_LABEL, AGENT_HEALTH_MEANING } from '@/lib/fleet/labels'
import { renderCount, usableCount } from '@/lib/fleet/safe'

const GRID = 'grid grid-cols-[minmax(0,1fr)_104px_72px_72px_72px] gap-3 items-center'
const HEADER_CELL = 'text-xs font-mono uppercase text-pewter tracking-tight'

/** Failing first, then degrading, then untested, then passed. */
const CONCERN: Record<AgentHealthEntry['state'], number> = {
  failing: 0,
  degrading: 1,
  unobserved: 2,
  healthy: 3,
}

/**
 * The state chip. Distinguished by WORD first — the border style and fill are
 * reinforcement, exactly as in `EvidenceMarker`.
 */
function StateChip({ state }: { state: AgentHealthEntry['state'] }) {
  const style: Record<AgentHealthEntry['state'], string> = {
    failing: 'border-solid bg-graphite border-graphite-light text-ember',
    degrading: 'border-solid bg-transparent border-graphite-light text-cloud',
    // Dotted, like the UNANSWERED band: this row was not tested either.
    unobserved: 'border-dotted bg-transparent border-graphite-light text-cloud',
    healthy: 'border-solid bg-transparent border-graphite-light text-pewter',
  }
  return (
    <span
      data-agent-state={state}
      className={`inline-flex items-center rounded-[4px] border font-mono text-xs px-2 py-0.5 whitespace-nowrap ${style[state]}`}
    >
      {AGENT_HEALTH_LABEL[state]}
      <span className="sr-only"> — {AGENT_HEALTH_MEANING[state]}</span>
    </span>
  )
}

export function FleetRoster({ roster }: { roster: readonly AgentHealthEntry[] }) {
  const ordered = [...roster].sort(
    (a, b) =>
      CONCERN[a.state] - CONCERN[b.state] ||
      // `usableCount` first: a NaN or string `runsFailed` makes every
      // comparison false and silently randomises the order of the rows an
      // operator scans for the worst agent.
      (usableCount(b.runsFailed) ?? -1) - (usableCount(a.runsFailed) ?? -1) ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0),
  )

  return (
    <div>
      <div className={`${GRID} px-4 py-2 border-b border-graphite`}>
        <span className={HEADER_CELL}>Agent</span>
        <span className={HEADER_CELL}>State</span>
        <span className={`${HEADER_CELL} text-right`}>Runs</span>
        <span className={`${HEADER_CELL} text-right`}>Failed</span>
        <span className={`${HEADER_CELL} text-right`}>Fingerprints</span>
      </div>

      {ordered.map((a) => (
        <div key={a.agentId} className={`${GRID} px-4 py-2 border-b border-graphite last:border-b-0`}>
          <span className="min-w-0">
            <Link
              href={`/agents/${encodeURIComponent(a.agentId)}`}
              className="block font-mono text-sm text-cloud truncate hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
            >
              {a.agentName ?? a.agentId}
            </Link>
            {a.observationTruncated && (
              // Stated on the row itself. A reader scanning the roster for the
              // one bad agent will not have the scan banner in view.
              <span className="block text-xs text-ember">
                counts are floors — this agent’s scan was truncated
              </span>
            )}
          </span>
          <StateChip state={a.state} />
          <span className="font-mono text-sm text-cloud tabular-nums text-right">
            {renderCount(a.runsObserved)}
          </span>
          <span className="font-mono text-sm text-cloud tabular-nums text-right">
            {renderCount(a.runsFailed)}
          </span>
          <span className="font-mono text-sm text-cloud tabular-nums text-right">
            {renderCount(a.distinctFingerprints)}
          </span>
        </div>
      ))}
    </div>
  )
}
