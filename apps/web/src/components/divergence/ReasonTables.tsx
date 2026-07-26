/**
 * ReasonTables — the fleet blast radius, ranked BY REASON.
 *
 * ===========================================================================
 * THREE COMPONENTS, NOT ONE COMPONENT WITH A FLAG
 * ===========================================================================
 *
 * `ProvenReasonTable`, `SpeculativeReasonTable` and `IndeterminateReasonTable`
 * are separate components with separate prop types. None can accept another's
 * data: `ProvenDivergenceReason`, `SpeculativeDivergenceReason` and
 * `IndeterminateDivergenceReason` do not unify — each carries a distinct
 * `certainty` literal and an exemplar with a required field the others lack
 * (`provenBy` / `speculativeBecause` / `unknownBecause`).
 *
 * That is the strongest structural guarantee available. A single
 * `<ReasonTable certainty={...}>` would compile happily with the wrong band
 * passed, and one day would. Three components make the mistake unrepresentable
 * rather than merely unlikely.
 *
 * The tables also DIFFER IN THEIR FINAL COLUMN, which is the cue a scanning
 * reader picks up before reading any label:
 *
 *   proven         … | Runs | EVIDENCE        (event #N · tool.call)
 *   unproven       … | Runs | CONFIG CHANGE   (the path that changed)
 *   unknown        … | Runs | BLOCKED BY      (why it could not be decided)
 *
 * A proven row points at a recorded event. A speculative row cannot — there is
 * no event — so it points at a config path. An indeterminate row points at
 * neither, because it has neither; it points at the obstacle. The column header
 * alone tells a reader which table they are in, with no colour involved.
 *
 * ---------------------------------------------------------------------------
 * DRILL-DOWN IS NATIVE `<details>`, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * Reason → representative runs expands with `<details>`/`<summary>`. That buys
 * keyboard operation (Enter/Space), expanded/collapsed state exposed to
 * assistive technology, and browser find-in-page into collapsed content —
 * none of which needs a `'use client'` boundary or a line of JavaScript.
 *
 * Column widths are FIXED by one shared grid template applied identically to
 * the header row and every data row. A ranked work queue that reflows when a
 * long tool name appears is a queue an operator loses their place in.
 */

import Link from 'next/link'

import type {
  IndeterminateDivergenceReason,
  ProvenDivergenceReason,
  SpeculativeDivergenceReason,
} from '@agent-flight-recorder/contracts'

import { CertaintyMarker } from '@/components/divergence/CertaintyMarker'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import {
  DIMENSION_LABEL,
  INDETERMINATE_KIND_LABEL,
  PROVEN_KIND_LABEL,
  SPECULATIVE_KIND_LABEL,
} from '@/lib/divergence/labels'
import { truncateId } from '@/lib/utils'

const GRID = 'grid grid-cols-[16px_104px_minmax(0,1fr)_72px_200px] gap-3 items-center'
const HEADER_CELL = 'text-xs font-mono uppercase text-pewter tracking-tight'
const ROW =
  'w-full px-4 py-2.5 text-left cursor-pointer list-none marker:content-none [&::-webkit-details-marker]:hidden hover:bg-graphite focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]'

/** Disclosure caret. Decorative — `<details>` carries the real state. */
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

function RunCount({ n }: { n: number }) {
  return (
    <span className="font-mono text-sm text-whiteout tabular-nums text-right">
      {n.toLocaleString()}
    </span>
  )
}

/**
 * Representative runs for a reason. Bounded by the contract
 * (`MAX_DIVERGENCE_REPRESENTATIVE_RUNS`); when the bound binds, the list says
 * so rather than letting a sample read as the whole set.
 */
function RepresentativeRuns({
  runIds,
  total,
  targetVersionId,
}: {
  runIds: readonly string[]
  total: number
  targetVersionId: string
}) {
  if (runIds.length === 0) {
    return (
      <p className="mt-2 text-xs text-pewter">
        This reason is a property of the scan itself rather than of particular runs, so there are no
        representative runs to open.
      </p>
    )
  }
  return (
    <div className="mt-2">
      <div className="text-xs font-mono uppercase text-pewter mb-1.5">Representative runs</div>
      <ul className="flex flex-col gap-1">
        {runIds.map((id) => (
          <li key={id} className="flex items-center gap-1.5">
            <Link
              href={`/runs/${encodeURIComponent(id)}/divergence?target=${encodeURIComponent(targetVersionId)}`}
              className="font-mono text-xs text-cloud hover:text-neon-glow transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
            >
              {truncateId(id, 16)}
            </Link>
            <CopyToClipboardButton value={id} label="Copy run ID" />
          </li>
        ))}
      </ul>
      {total > runIds.length && (
        <p className="mt-1.5 text-xs text-pewter">
          Showing {runIds.length} of {total.toLocaleString()} affected runs.
        </p>
      )}
    </div>
  )
}

function Header({ lastColumn }: { lastColumn: string }) {
  return (
    <div className={`${GRID} px-4 py-2 border-b border-graphite`}>
      <span />
      <span className={HEADER_CELL}>Certainty</span>
      <span className={HEADER_CELL}>Reason</span>
      <span className={`${HEADER_CELL} text-right`}>Runs</span>
      <span className={HEADER_CELL}>{lastColumn}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Proven
// ---------------------------------------------------------------------------

interface ProvenTableProps {
  reasons: readonly ProvenDivergenceReason[]
  targetVersionId: string
}

export function ProvenReasonTable({ reasons, targetVersionId }: ProvenTableProps) {
  return (
    <div>
      {/* The column only a PROVEN table can have: it points at a recorded event. */}
      <Header lastColumn="Evidence" />

      {reasons.map((r) => {
        // `provenBy` is non-empty BY TYPE, and the first entry is the earliest.
        const proof = r.exemplar.provenBy[0]
        return (
          <details key={r.reasonKey} className="group border-b border-graphite last:border-b-0">
            <summary className={`${ROW} ${GRID}`}>
              <Caret />
              <CertaintyMarker certainty="proven" compact />
              <span className="min-w-0">
                <span className="block text-sm text-whiteout truncate">
                  {PROVEN_KIND_LABEL[r.kind]}
                </span>
                <span
                  className="block font-mono text-xs text-pewter truncate"
                  title={proof.recordedValue}
                >
                  {proof.recordedValue}
                </span>
              </span>
              <RunCount n={r.affectedRunCount} />
              <span className="font-mono text-xs text-pewter truncate">
                event {proof.citedEvent.sequenceNumber.toLocaleString()} ·{' '}
                {proof.citedEvent.eventType}
              </span>
            </summary>

            <div className="px-4 pb-4 pt-1 pl-[36px]">
              {/* The engine's own words about this finding, in the past tense.
                  Rendered verbatim — paraphrasing a proof is how a proof stops
                  being one. */}
              <p className="text-sm text-cloud leading-relaxed max-w-3xl">
                {r.exemplar.provenClaim}
              </p>
              <dl className="mt-2 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-1 max-w-2xl">
                <dt className="font-mono text-xs uppercase text-pewter">Recorded</dt>
                <dd className="font-mono text-xs text-cloud break-words">{proof.recordedValue}</dd>
                <dt className="font-mono text-xs uppercase text-pewter">Target</dt>
                <dd className="font-mono text-xs text-cloud break-words">
                  {/* `null` is MEANINGFUL here — it is the proof itself for
                      every `*_removed` kind, and is not "unknown". */}
                  {proof.targetValue ?? 'not declared'}
                </dd>
                <dt className="font-mono text-xs uppercase text-pewter">Config path</dt>
                <dd className="font-mono text-xs text-cloud break-words">
                  {proof.targetConfigPath}
                </dd>
              </dl>
              <RepresentativeRuns
                runIds={r.representativeRunIds}
                total={r.affectedRunCount}
                targetVersionId={targetVersionId}
              />
            </div>
          </details>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Speculative
// ---------------------------------------------------------------------------

interface SpeculativeTableProps {
  reasons: readonly SpeculativeDivergenceReason[]
  targetVersionId: string
}

export function SpeculativeReasonTable({ reasons, targetVersionId }: SpeculativeTableProps) {
  return (
    <div>
      {/* The counterpart column. A speculative row has no event to cite, so it
          cites the config path instead. */}
      <Header lastColumn="Config change" />

      {reasons.map((r) => (
        <details key={r.reasonKey} className="group border-b border-graphite last:border-b-0">
          <summary className={`${ROW} ${GRID}`}>
            <Caret />
            <CertaintyMarker certainty="speculative" compact />
            <span className="min-w-0">
              <span className="block text-sm text-cloud truncate">
                {SPECULATIVE_KIND_LABEL[r.kind]}
              </span>
              <span
                className="block font-mono text-xs text-pewter truncate"
                title={r.exemplar.changedConfigPath}
              >
                {r.exemplar.changedConfigPath}
              </span>
            </span>
            <RunCount n={r.affectedRunCount} />
            <span className="font-mono text-xs text-pewter truncate">
              {r.exemplar.changedConfigPath}
            </span>
          </summary>

          <div className="px-4 pb-4 pt-1 pl-[36px]">
            <p className="text-sm text-cloud leading-relaxed max-w-3xl">
              {r.exemplar.speculativeConcern}
            </p>
            {/* `speculativeBecause` is REQUIRED by the contract precisely so a
                speculative finding always states its own limit. Rendering it is
                what keeps that requirement worth having. */}
            <p className="mt-1.5 text-sm text-pewter leading-relaxed max-w-3xl">
              Cannot be proven from recorded history: {r.exemplar.speculativeBecause}
            </p>
            <RepresentativeRuns
              runIds={r.representativeRunIds}
              total={r.affectedRunCount}
              targetVersionId={targetVersionId}
            />
          </div>
        </details>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Indeterminate
// ---------------------------------------------------------------------------

interface IndeterminateTableProps {
  reasons: readonly IndeterminateDivergenceReason[]
  targetVersionId: string
}

export function IndeterminateReasonTable({ reasons, targetVersionId }: IndeterminateTableProps) {
  return (
    <div>
      {/* Neither an event nor a config change — an obstacle. */}
      <Header lastColumn="Blocked by" />

      {reasons.map((r) => (
        <details key={r.reasonKey} className="group border-b border-graphite last:border-b-0">
          <summary className={`${ROW} ${GRID}`}>
            <Caret />
            <CertaintyMarker certainty="indeterminate" compact />
            <span className="min-w-0">
              <span className="block text-sm text-cloud truncate">
                {INDETERMINATE_KIND_LABEL[r.kind]}
              </span>
              <span className="block font-mono text-xs text-pewter truncate">
                {DIMENSION_LABEL[r.exemplar.dimension]}
              </span>
            </span>
            <RunCount n={r.affectedRunCount} />
            <span className="font-mono text-xs text-pewter truncate">
              {INDETERMINATE_KIND_LABEL[r.kind]}
            </span>
          </summary>

          <div className="px-4 pb-4 pt-1 pl-[36px]">
            {/* Phrased as the open QUESTION, never as a claim or a concern. */}
            <p className="text-sm text-cloud leading-relaxed max-w-3xl">
              Undecided: {r.exemplar.undecidedQuestion}
            </p>
            <p className="mt-1.5 text-sm text-pewter leading-relaxed max-w-3xl">
              {r.exemplar.unknownBecause}
            </p>
            {/* The contract's `remedy` is what separates "I cannot tell" from
                "I cannot tell YET, and here is what to do". Without it an
                operator learns to click past the whole band. */}
            {r.exemplar.remedy !== undefined && (
              <p className="mt-1.5 text-sm text-cloud leading-relaxed max-w-3xl">
                To make this answerable: {r.exemplar.remedy}
              </p>
            )}
            <RepresentativeRuns
              runIds={r.representativeRunIds}
              total={r.affectedRunCount}
              targetVersionId={targetVersionId}
            />
          </div>
        </details>
      ))}
    </div>
  )
}
