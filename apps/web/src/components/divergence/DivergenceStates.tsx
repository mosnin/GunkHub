/**
 * DivergenceStates — the verdict banner, and the ways this surface can have
 * nothing to show.
 *
 * ===========================================================================
 * "NO DIVERGENCES FOUND" AND "COULD NOT ANALYSE" ARE OPPOSITE ANSWERS
 * ===========================================================================
 *
 * `AgentVersion.configSnapshot` is optional (packages/contracts/src/
 * entities.ts), so a target version with nothing to compare against is
 * reachable in production, not a theoretical branch.
 *
 * If that case rendered as `<EmptyState title="No divergences found">`, an
 * operator deciding whether to ship would read a green light produced by the
 * total absence of analysis. They would ship. This is the worst outcome
 * available to this feature and it is one careless `catch {}` away at all
 * times, which is why the service layer returns a four-way status and why
 * {@link UnanalysableResult} is its own component rather than a variant prop on
 * the clean one. There is no shared component and no shared prop between them,
 * so no future refactor can collapse them behind a boolean.
 *
 * ---------------------------------------------------------------------------
 * THE VERDICT BANNER IS THE PAGE'S ANSWER
 * ---------------------------------------------------------------------------
 *
 * `DivergenceVerdict` has four values and exactly TWO of them are green lights.
 * {@link VerdictBanner} renders the word plus the sentence that stops it being
 * misread — in particular for `indeterminate`, which is not a hedge but the
 * answer that exists specifically to prevent a false clean.
 *
 * The verdict shown is always the one recomputed from the report's own contents
 * by the contract's `computeDivergenceVerdict` (see lib/divergence/adapt.ts),
 * never a string the server asserted.
 */

import type { DivergenceVerdict } from '@agent-flight-recorder/contracts'

import { CertaintyMarker } from '@/components/divergence/CertaintyMarker'
import { Card } from '@/components/ui/Card'
import { CLEAN_RESULT_LIMIT, isShippableVerdict, VERDICT_COPY } from '@/lib/divergence/labels'

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

interface VerdictBannerProps {
  verdict: DivergenceVerdict
  /** What the verdict is about, e.g. "this run" or "version 2.0.0 across 40 runs". */
  scope: string
}

/**
 * The one-word answer to "can I ship this?", with its qualifying sentence.
 *
 * `data-verdict` and `data-shippable` are the structural hooks the tests assert
 * on — `data-shippable` in particular, because "is this a green light" is the
 * single bit an operator acts on and it must not be inferrable only from
 * colour.
 */
export function VerdictBanner({ verdict, scope }: VerdictBannerProps) {
  const copy = VERDICT_COPY[verdict]
  const shippable = isShippableVerdict(verdict)
  return (
    <Card>
      <div
        data-testid="divergence-verdict"
        data-verdict={verdict}
        data-shippable={shippable ? 'true' : 'false'}
        className="px-4 py-4 flex flex-col gap-2 items-start"
      >
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* A verdict driven by one band carries that band's marker, so the
              banner and the section it came from are visibly the same claim. */}
          {copy.certainty !== null && <CertaintyMarker certainty={copy.certainty} />}
          <span className="font-mono text-sm font-medium text-whiteout tracking-tight">
            {copy.word}
          </span>
        </div>
        <h2 className="text-sm font-semibold text-whiteout">{scope}</h2>
        <p className="text-sm text-cloud max-w-3xl leading-relaxed">{copy.detail}</p>
        {/* Rendered on the GREEN states, not the red ones. A clean report says
            the target would not have BROKEN on recorded history; it never says
            it would BEHAVE the same, and an operator will read it as the latter
            unless told. See CLEAN_RESULT_LIMIT for the full argument. */}
        {shippable && (
          <p
            data-testid="divergence-clean-limit"
            className="text-sm text-pewter max-w-3xl leading-relaxed border-t border-graphite pt-2 mt-1"
          >
            {CLEAN_RESULT_LIMIT}
          </p>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Unanalysable — the state that must never look like "clean"
// ---------------------------------------------------------------------------

interface UnanalysableResultProps {
  why: string
  remedy: string
}

/**
 * The analysis could not run at all.
 *
 * Deliberately unlike every other state here: a dashed container rather than a
 * `<Card>`, the words `CANNOT ANALYSE`, and copy whose first line says outright
 * that this is not a finding of safety. It shares no component, no test id and
 * no status word with {@link VerdictBanner}.
 */
export function UnanalysableResult({ why, remedy }: UnanalysableResultProps) {
  return (
    <div
      data-testid="divergence-unanalysable"
      data-shippable="false"
      className="rounded-[4px] border border-dashed border-graphite-light bg-graphite-deep"
    >
      <div className="px-4 py-6 flex flex-col items-start gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-dashed border-graphite-light bg-transparent px-2 py-0.5 font-mono text-xs font-medium text-ember">
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 shrink-0 rounded-[4px] border border-ember bg-transparent"
          />
          CANNOT ANALYSE
        </span>
        <h3 className="text-sm font-semibold text-whiteout">
          This is not a finding of &ldquo;no divergences&rdquo;.
        </h3>
        <p className="text-sm text-cloud max-w-3xl leading-relaxed">{why}</p>
        <p className="text-sm text-pewter max-w-3xl leading-relaxed">{remedy}</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * The query failed.
 *
 * Distinct from unanalysable: unanalysable means we asked and the data cannot
 * answer; this means we could not ask. Both are non-answers, but only one has a
 * remedy the operator controls, so they do not share copy.
 */
export function DivergenceErrorResult({ message }: { message: string }) {
  return (
    <div
      data-testid="divergence-error"
      data-shippable="false"
      className="rounded-[4px] border border-graphite-light bg-graphite-deep"
    >
      <div className="px-4 py-6 flex flex-col items-start gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-graphite-light bg-graphite px-2 py-0.5 font-mono text-xs font-medium text-ember">
          <span aria-hidden="true" className="w-1.5 h-1.5 shrink-0 rounded-[4px] bg-system-warning" />
          ANALYSIS FAILED
        </span>
        <h3 className="text-sm font-semibold text-whiteout">The analysis did not run.</h3>
        <p className="text-sm text-cloud max-w-3xl leading-relaxed">{message}</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Nothing asked yet
// ---------------------------------------------------------------------------

/**
 * No target has been chosen.
 *
 * Not an empty state, and not a verdict. Nothing has been asked, so nothing is
 * absent — rendering "no divergences" here would be a claim the page has not
 * earned.
 */
export function NoTargetChosen({ description }: { description: string }) {
  return (
    <Card>
      <div className="px-4 py-6">
        <h2 className="text-sm font-semibold text-whiteout">
          Choose a target version to analyse.
        </h2>
        <p className="mt-1.5 text-sm text-pewter max-w-3xl leading-relaxed">{description}</p>
      </div>
    </Card>
  )
}
