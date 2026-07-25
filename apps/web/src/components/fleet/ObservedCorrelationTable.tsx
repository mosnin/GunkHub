/**
 * ObservedCorrelationTable — the findings. Ranked by blast radius, shared
 * thing first.
 *
 * ===========================================================================
 * WHAT LEADS THE ROW IS WHAT IS SHARED
 * ===========================================================================
 *
 * "Nine agents, all failing fingerprint 9f3c since 14:03" is the answer. Nine
 * separate agent cards are the raw material an operator would then have to
 * assemble themselves, under time pressure, from memory. So the widest column
 * holds `observedFact` — the engine's own past-tense sentence about what was
 * recorded, rendered VERBATIM. Paraphrasing an observation is how an
 * observation stops being one; the contract is explicit that this field is
 * phrased about what was recorded and is deliberately not called `summary`.
 *
 * The agent list is drill-down, not the headline. It is the evidence for the
 * headline rather than the headline itself.
 *
 * ---------------------------------------------------------------------------
 * RANKED BY BLAST RADIUS, AND THE RANK IS VISIBLE
 * ---------------------------------------------------------------------------
 *
 * Ordering is `rankFleetCorrelations` from the contract — breadth first,
 * recency only as a tiebreak — and this component does not sort. It renders
 * the order it is given, so the product decision lives in exactly one place
 * and is unit-tested there.
 *
 * Rows carry an explicit ordinal, and the breadth column header names itself
 * as the sort key. Without both, "sorted by impact" is a claim the reader
 * reverse-engineers from two adjacent numbers — and a reader scanning under
 * stress assumes the top row is the newest, because every other list in every
 * other tool is.
 *
 * ---------------------------------------------------------------------------
 * `agentCount` VS `agentIds.length`
 * ---------------------------------------------------------------------------
 *
 * `agentIds` is bounded by `MAX_FLEET_CORRELATION_AGENTS`; `agentCount` is the
 * real size. The headline number is ALWAYS `agentCount`, and when the list is
 * shorter the row says so. Rendering `agentIds.length` as the blast radius
 * would under-report the incident by exactly the amount that matters most on
 * the biggest clusters.
 *
 * ---------------------------------------------------------------------------
 * STABLE COLUMNS, NATIVE DISCLOSURE
 * ---------------------------------------------------------------------------
 *
 * One shared grid template on the header and every row, so the table cannot
 * reflow when a long fact appears — an operator does not lose their place
 * mid-scan. Drill-down is `<details>`/`<summary>`: keyboard-operable, state
 * exposed to assistive technology, find-in-page reaches collapsed content, no
 * client boundary and no JavaScript.
 */

import Link from 'next/link'

import type {
  FleetHealthScan,
  FleetObservationEvidence,
  ObservedCorrelation,
} from '@agent-flight-recorder/contracts'

import { ObservedMarker } from '@/components/fleet/EvidenceMarker'
import { ObservationSpanCell } from '@/components/fleet/ObservationSpan'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { OBSERVED_KIND_LABEL } from '@/lib/fleet/labels'
import { renderCount, usableArray, usableCount } from '@/lib/fleet/safe'
import { truncateId } from '@/lib/utils'

const GRID = 'grid grid-cols-[16px_28px_minmax(0,1fr)_72px_260px] gap-3 items-center'
const HEADER_CELL = 'text-xs font-mono uppercase text-pewter tracking-tight'
const ROW =
  'w-full px-4 py-2.5 text-left cursor-pointer list-none marker:content-none [&::-webkit-details-marker]:hidden hover:bg-graphite focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]'

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="text-pewter text-xs transition-transform duration-100 group-open:rotate-90 inline-block"
    >
      ▸
    </span>
  )
}

/**
 * One citation. The two evidence kinds render DIFFERENTLY on purpose: a failure
 * occurrence points at a recorded run and links to it; a declared attribute
 * points at a config path in an immutable snapshot and has no run to link to.
 * Flattening them into one line would hide which kind of record is doing the
 * work behind a given claim.
 */
function Citation({ evidence }: { evidence: FleetObservationEvidence }) {
  if (evidence.cites === 'failure_occurrence') {
    return (
      <li className="flex items-center gap-1.5 min-w-0">
        <span className="font-mono text-xs text-pewter shrink-0">run</span>
        <Link
          href={`/runs/${encodeURIComponent(evidence.runId)}`}
          className="font-mono text-xs text-cloud hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
        >
          {truncateId(evidence.runId, 18)}
        </Link>
        <CopyToClipboardButton value={evidence.runId} label="Copy run ID" />
        <span className="font-mono text-xs text-pewter truncate">
          on {evidence.agentId} · fingerprint {truncateId(evidence.fingerprintHash, 12)}
        </span>
      </li>
    )
  }
  return (
    <li className="flex items-center gap-1.5 min-w-0">
      <span className="font-mono text-xs text-pewter shrink-0">declared</span>
      <code className="font-mono text-xs text-cloud truncate">
        {evidence.declaredConfigPath} = {evidence.declaredValue}
      </code>
      <span className="font-mono text-xs text-pewter truncate">
        in version {truncateId(evidence.agentVersionId, 12)}
      </span>
    </li>
  )
}

interface ObservedCorrelationTableProps {
  /** Already ordered by `rankFleetCorrelations`. This component never re-sorts. */
  items: readonly ObservedCorrelation[]
  scan: FleetHealthScan
}

export function ObservedCorrelationTable({ items, scan }: ObservedCorrelationTableProps) {
  return (
    <div>
      <div className={`${GRID} px-4 py-2 border-b border-graphite`}>
        <span />
        <span className={`${HEADER_CELL} text-right`}>#</span>
        {/* The column only an OBSERVED table has: what was recorded. */}
        <span className={HEADER_CELL}>What was recorded</span>
        {/* The sort key, named, so the order is not a guess. */}
        <span className={`${HEADER_CELL} text-right`}>Agents ▼</span>
        <span className={HEADER_CELL}>When</span>
      </div>

      {items.map((c, i) => {
        // Resolved ONCE per row, so the headline number, the "showing N of M"
        // caveat and the drill-down list cannot disagree with each other.
        const agentIds = usableArray<string>(c.agentIds)
        const agentCount = usableCount(c.agentCount)
        const citations = usableArray<FleetObservationEvidence>(c.observedBy)
        return (
        <details
          key={c.correlationKey}
          // Anchor target for the hypothesis band's "rests on" back-links, so a
          // reader can jump from a proposal to the observation under it without
          // losing the page. A plain fragment, so it survives being pasted.
          id={`observed-${c.correlationKey}`}
          className="group border-b border-graphite last:border-b-0 scroll-mt-4"
        >
          <summary className={`${ROW} ${GRID}`}>
            <Caret />
            <span className="font-mono text-xs text-pewter tabular-nums text-right">{i + 1}</span>
            <span className="min-w-0">
              {/* VERBATIM. The engine's own past-tense sentence. */}
              <span className="block text-sm text-whiteout truncate" title={c.observedFact}>
                {c.observedFact}
              </span>
              <span className="block font-mono text-xs text-pewter truncate">
                {OBSERVED_KIND_LABEL[c.kind]}
              </span>
            </span>
            {/* Blast radius — `agentCount`, never the bounded list length. The
                largest type on the row, because it is what triage turns on. */}
            <span className="font-mono text-xl text-whiteout tabular-nums text-right leading-none">
              {renderCount(c.agentCount)}
            </span>
            <ObservationSpanCell correlation={c} scan={scan} />
          </summary>

          <div className="px-4 pb-4 pt-1 pl-[60px] flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ObservedMarker />
              <span className="font-mono text-xs text-pewter">{c.correlationKey}</span>
              <CopyToClipboardButton value={c.correlationKey} label="Copy correlation key" />
            </div>

            <div>
              <div className="text-xs font-mono uppercase text-pewter mb-1.5">
                Agents in this cluster
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {agentIds.map((id) => (
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
              {/* Only claim a larger cluster when the count is USABLE and
                  actually larger. An unusable count must not manufacture a
                  "showing 9 of —" caveat about a bound that may not exist. */}
              {agentCount !== null && agentCount > agentIds.length && (
                // The bound is stated rather than left to be inferred from a
                // list that quietly stops.
                <p className="mt-1.5 text-xs text-pewter">
                  Showing {agentIds.length} of {agentCount.toLocaleString()} agents — the
                  cluster is larger than the list the scan carries.
                </p>
              )}
            </div>

            {/* THE EVIDENCE. `observedBy` is non-empty BY TYPE, so this heading
                can never sit above an empty list. */}
            <div>
              <div className="text-xs font-mono uppercase text-pewter mb-1.5">Observed in</div>
              <ul className="flex flex-col gap-1">
                {citations.map((e, j) => (
                  <Citation key={j} evidence={e} />
                ))}
              </ul>
            </div>
          </div>
        </details>
        )
      })}
    </div>
  )
}
