import { isAllClear } from '@agent-flight-recorder/contracts'

import type { PolicyEvaluationView as EvaluationView } from '@/lib/services/policies'

import { PolicyOutcomeCard } from '@/components/policies/PolicyOutcomeCard'
import { countOutcomes, orderOutcomes } from '@/lib/policies/outcomes'
import { VERDICT_LABEL } from '@/lib/policies/vocabulary'

/**
 * A WHOLE EVALUATION: the verdict, what the scan covered, and the per-policy
 * outcomes.
 *
 * ===========================================================================
 * THE THREE COUNTS ARE SHOWN TOGETHER OR NOT AT ALL, AND THERE IS NO RATIO
 * ===========================================================================
 *
 * `countOutcomes` returns all three numbers and there is no function anywhere in
 * this feature that returns one of them alone. That is contracts'
 * `PolicyOutcomeCounts` rule reproduced at the render layer, and the reason is
 * the same: the proof does not aggregate, the prose does not aggregate, the
 * instrumentation disclaimer does not aggregate — THE WORD DOES. A satisfied
 * figure travelling alone is the attestation figure with every safeguard above
 * it stripped off, and it is the figure that gets pasted into a security
 * questionnaire.
 *
 * SO THERE IS NO BAR, NO METER, NO PERCENTAGE, NO DONUT AND NO TOTAL. A ratio is
 * a compliance claim in visual form: any denominator here would either exclude
 * the not-evaluable outcomes (asserting they do not count) or include them
 * (asserting they are the same kind of thing as a checked run). Both are false,
 * and a chart makes the falsehood look measured.
 *
 * `tests/unit/policy_ui_no_compliance_ratio.test.ts` pins this over the source
 * of every file in this feature.
 *
 * ===========================================================================
 * VIOLATIONS ARE RENDERED FIRST, UNCONDITIONALLY
 * ===========================================================================
 *
 * `orderOutcomes` puts them at the top regardless of the verdict, the scan's
 * completeness, or whether anything else in the body could be read. A recorded
 * forbidden call is a positive fact in an append-only log and it survives a
 * truncated scan — the natural thing to build here is a "only show complete
 * results" filter, and that filter suppresses breaches.
 */
interface PolicyEvaluationViewProps {
  evaluation: EvaluationView
  /** Where this evaluation came from, in words — "run run_9" or "policy pol_3 across 25 runs". */
  scopeLabel: string
}

export function PolicyEvaluationPanel({ evaluation, scopeLabel }: PolicyEvaluationViewProps) {
  const outcomes = orderOutcomes(evaluation.outcomes)
  const counts = countOutcomes(outcomes)
  const verdict = VERDICT_LABEL[evaluation.verdict]
  const allClear = isAllClear(evaluation.verdict)
  const scan = evaluation.scan

  return (
    <section className="flex flex-col gap-3">
      <article
        className={
          evaluation.verdict === 'violations_found'
            ? 'rounded-[4px] border border-system-warning bg-graphite-deep p-4'
            : 'rounded-[4px] border border-graphite-light bg-graphite-deep p-4'
        }
      >
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold text-whiteout">{verdict.label}</h2>
          <span className="text-xs font-mono text-pewter">{scopeLabel}</span>
          <time
            dateTime={new Date(evaluation.evaluatedAt).toISOString()}
            className="text-xs font-mono text-pewter tabular-nums"
          >
            {new Date(evaluation.evaluatedAt).toISOString()}
          </time>
        </header>
        <p className="mt-2 text-sm text-cloud leading-relaxed">{verdict.meaning}</p>
        {/* The server's own composed statement, verbatim and guarded upstream
            against compliance vocabulary. It is the sentence most likely to be
            quoted out of this whole feature. */}
        <p className="mt-2 text-sm text-whiteout leading-relaxed">{evaluation.verdictStatement}</p>
        {allClear ? (
          <p className="mt-2 text-sm text-whiteout leading-relaxed">
            This result is exactly as wide as the coverage stated below and no wider. Quote the coverage with the
            result or do not quote the result.
          </p>
        ) : null}
      </article>

      {/* THE THREE COUNTS, AS THREE LABELLED FIGURES. Not a chart, not a
          denominator, not a summary number. Each is stated with the word that
          says what it means, so a reader cannot mistake the satisfied figure for
          a score. */}
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-[4px] border border-graphite-light bg-graphite-deep p-3">
          <dt className="text-xs font-mono uppercase tracking-wider text-pewter">
            Policies violated
          </dt>
          <dd className="mt-1 text-sm font-mono text-whiteout tabular-nums">{counts.violated}</dd>
          <p className="mt-1 text-xs text-cloud leading-relaxed">
            Recorded in the log. Proven, and true regardless of anything else here that could not be read.
          </p>
        </div>
        <div className="rounded-[4px] border border-graphite-light bg-graphite-deep p-3">
          <dt className="text-xs font-mono uppercase tracking-wider text-pewter">
            Policies not evaluable
          </dt>
          <dd className="mt-1 text-sm font-mono text-whiteout tabular-nums">
            {counts.notEvaluable}
          </dd>
          <p className="mt-1 text-xs text-cloud leading-relaxed">
            Not checked. This is not a count of policies with nothing to report; it is a count of questions this
            evaluation could not answer.
          </p>
        </div>
        <div className="rounded-[4px] border border-graphite-light bg-graphite-deep p-3">
          <dt className="text-xs font-mono uppercase tracking-wider text-pewter">
            Policies with no violation found
          </dt>
          <dd className="mt-1 text-sm font-mono text-whiteout tabular-nums">{counts.satisfied}</dd>
          <p className="mt-1 text-xs text-cloud leading-relaxed">
            Each rests on the agent version&apos;s own declaration that it records what it does. Read the cards
            below for whose declaration, and for what it said.
          </p>
        </div>
      </dl>

      <article className="rounded-[4px] border border-graphite-light bg-graphite-deep p-3">
        <h3 className="text-xs font-mono uppercase tracking-wider text-pewter">
          What this evaluation covered
        </h3>
        <ul className="mt-2 flex flex-col gap-1">
          <li className="text-xs font-mono text-cloud tabular-nums">
            {scan.policiesEvaluated} of {scan.policiesInScope} governing policies produced a finding
          </li>
          <li className="text-xs font-mono text-cloud tabular-nums">
            {scan.runsRead} of {scan.runsInScope} runs in scope were opened
          </li>
          {scan.evaluationTruncated ? (
            <li className="text-xs text-whiteout leading-relaxed">
              This evaluation ended on a server ceiling, so EVERY COUNT ON THIS PAGE IS A FLOOR. What is past the
              ceiling was not looked at.
            </li>
          ) : (
            <li className="text-xs font-mono text-cloud">
              the evaluation did not stop on a server ceiling
            </li>
          )}
          {scan.foreignRowsSkipped > 0 ? (
            <li className="text-xs text-whiteout leading-relaxed">
              {scan.foreignRowsSkipped} row(s) outside this organization were excluded from the report entirely.
            </li>
          ) : null}
        </ul>
      </article>

      {outcomes.length === 0 ? (
        // AN EMPTY OUTCOME LIST IS NOT AN ALL-CLEAR AND MUST NOT LOOK LIKE ONE.
        // An empty set satisfies every prohibition vacuously, and a scan pointed
        // at the wrong project produces exactly this.
        <article className="rounded-[4px] border border-graphite-light bg-graphite-deep p-4">
          <h3 className="text-sm font-semibold text-whiteout">NO OUTCOME WAS PRODUCED</h3>
          <p className="mt-2 text-sm text-cloud leading-relaxed">
            This evaluation returned no per-policy result. That is not a finding that nothing was violated — it
            means nothing was evaluated. Either no policy governs this subject, or no run was in scope, or the
            evaluation could not run. Check the coverage above and the policy definitions.
          </p>
        </article>
      ) : (
        <ul className="flex flex-col gap-3">
          {outcomes.map((outcome, index) => (
            <li key={`${outcome.state}-${index}`}>
              <PolicyOutcomeCard outcome={outcome} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
