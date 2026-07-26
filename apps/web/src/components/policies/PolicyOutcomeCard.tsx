import Link from 'next/link'

import type { PolicyOutcomeView } from '@/lib/policies/outcomes'

import { NOT_EVALUABLE_LABEL, OUTCOME_STATE_LABEL } from '@/lib/policies/vocabulary'

/**
 * ONE POLICY'S OUTCOME OVER THE RUNS THAT WERE EVALUATED.
 *
 * ===========================================================================
 * THE THREE STATES ARE DISTINGUISHED BY WORDS FIRST AND COLOUR NEVER
 * ===========================================================================
 *
 * Strip every class from this file and the three still read as three different
 * things, because each carries its own heading text, its own explanation, and
 * its own required extra content: a VIOLATED card cites events, a NOT EVALUABLE
 * card states what would decide it, and a NO VIOLATION FOUND card names the
 * agent declaration it rests on. Colour is redundant reinforcement.
 *
 * `tests/unit/policy_ui_three_states.test.tsx` amputates every `class`,
 * `style`, `title` and `data-*` attribute from the rendered tree and asserts the
 * three remain distinguishable — because a reader in greyscale, in forced-colors
 * mode, on a screen reader, or looking at a screenshot pasted into a channel has
 * strictly more information than that test does.
 *
 * ===========================================================================
 * `not_evaluable` IS NOT DRAWN AS A CALM STATE, AND IT IS NOT DRAWN AS AN ERROR
 * ===========================================================================
 *
 * It is the universal state in this product today: no agent declares its
 * instrumentation, so nothing can license a satisfaction, so every honest
 * outcome is `violated` or `not_evaluable`. Two failure modes bracket it and
 * both are real:
 *
 *   DRAWN CALM (a grey row, a dash, an empty cell) it teaches an operator that
 *     the majority of their compliance screen means "fine", when it means "we
 *     could not look". That is the sentence somebody forwards to an auditor.
 *   DRAWN AS A DEFECT (a red error box, a retry button, a stack trace) it gets
 *     filed as a bug, and the fix somebody reaches for is to loosen the type
 *     that makes satisfaction hard.
 *
 * So it is drawn as WHAT IT IS: a stated, expected, actionable state, with the
 * reason and the next action on the card. `wouldBeEvaluableBy` is not optional
 * chrome — it is the difference between a product that says "I cannot tell" and
 * one that says "I cannot tell YET, and here is what to do".
 *
 * ===========================================================================
 * NOTHING BELOW IS SPREAD, AND NOTHING BELOW CLAIMS PREVENTION
 * ===========================================================================
 *
 * The three view states share no field (`violatedPolicyId` /
 * `undecidedPolicyId` / `satisfiedPolicyId`), exactly as contracts' outcomes do,
 * so no renderer can print one under another's heading by forgetting to narrow.
 * There is no `{...outcome}` spread anywhere here and no shared accessor pulling
 * the id out before the branch.
 *
 * A violation states that the act was RECORDED. It never states that it was
 * blocked, denied, stopped or prevented — this product records agent
 * executions, it does not run them.
 */
interface PolicyOutcomeCardProps {
  outcome: PolicyOutcomeView
}

export function PolicyOutcomeCard({ outcome }: PolicyOutcomeCardProps) {
  if (outcome.state === 'violated') {
    const label = OUTCOME_STATE_LABEL.violated
    return (
      <article className="rounded-[4px] border border-system-warning bg-graphite-deep p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full bg-system-warning shadow-[var(--shadow-glow-warn)] shrink-0"
            />
            <h3 className="text-sm font-semibold text-whiteout">{label.label}</h3>
          </span>
          <code className="text-xs font-mono text-pewter">{outcome.violatedPolicyId}</code>
          <span className="text-xs font-mono text-pewter">
            {/* A revision the finding did not name is stated as absent rather
                than defaulted. A finding that does not name the revision it was
                judged under is one nobody can reproduce: the rule may have been
                three tools wider last Tuesday. */}
            {outcome.violatedPolicyRevision === null
              ? 'revision not stated by the evaluation'
              : `revision ${outcome.violatedPolicyRevision}`}
          </span>
        </header>
        <p className="mt-2 text-sm text-cloud leading-relaxed">{label.meaning}</p>
        <p className="mt-2 text-sm text-whiteout leading-relaxed">{outcome.violatedRationale}</p>
        <p className="mt-2 text-xs font-mono text-pewter">{outcome.violatedPolicySummary}</p>

        <h4 className="mt-3 text-xs font-mono uppercase tracking-wider text-pewter">
          {/* A FLOOR IS NEVER RENDERED AS A TOTAL. `violationCountIsFloor` fails
              closed to `true` upstream, so an unreadable flag reads as "at
              least" rather than as an exact count. Under-counting a breach is
              survivable; a floor presented as a total is how a bounded scan
              becomes an understated finding. */}
          {outcome.violationCountIsFloor
            ? `Recorded operations matching this rule: at least ${outcome.violationCount}`
            : `Recorded operations matching this rule: ${outcome.violationCount}`}
        </h4>
        {outcome.violationCountIsFloor ? (
          <p className="mt-1 text-xs text-cloud leading-relaxed">
            The scan stopped before the end of the log, so there may be more matching operations and there cannot
            be fewer.
          </p>
        ) : null}

        <ul className="mt-2 flex flex-col gap-2">
          {outcome.provenBy.map((citation) => (
            <li
              key={citation.eventId}
              className="rounded-[4px] border border-graphite-light bg-graphite p-3"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <code className="text-xs font-mono text-whiteout">{citation.eventType}</code>
                <code className="text-xs font-mono text-neon-glow break-all">
                  {citation.observedValue}
                </code>
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-xs font-mono text-pewter tabular-nums">
                  sequence {citation.sequenceNumber}
                </span>
                <code className="text-xs font-mono text-pewter">{citation.eventId}</code>
                <Link
                  href={`/runs/${citation.runId}`}
                  className="text-xs font-mono text-cloud underline underline-offset-2"
                >
                  open run {citation.runId}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </article>
    )
  }

  if (outcome.state === 'not_evaluable') {
    const label = OUTCOME_STATE_LABEL.not_evaluable
    const why = NOT_EVALUABLE_LABEL[outcome.kind]
    return (
      <article className="rounded-[4px] border border-graphite-light bg-graphite-deep p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full border border-pewter shrink-0"
            />
            <h3 className="text-sm font-semibold text-whiteout">{label.label}</h3>
          </span>
          <code className="text-xs font-mono text-pewter">{outcome.undecidedPolicyId}</code>
          <code className="text-xs font-mono text-pewter">{outcome.kind}</code>
          {outcome.runsAffected === null ? null : (
            <span className="text-xs font-mono text-pewter tabular-nums">
              {outcome.runsAffected} run(s) unchecked
            </span>
          )}
        </header>
        <p className="mt-2 text-sm text-cloud leading-relaxed">{label.meaning}</p>
        {why === undefined ? null : (
          <p className="mt-2 text-sm text-cloud leading-relaxed">Why: {why}</p>
        )}
        {/* The evaluation's own account, verbatim. Rephrasing it here is how a
            caveat gets dropped. */}
        <p className="mt-2 text-sm text-whiteout leading-relaxed">{outcome.notEvaluableBecause}</p>
        <h4 className="mt-3 text-xs font-mono uppercase tracking-wider text-pewter">
          What would decide it
        </h4>
        <p className="mt-1 text-sm text-whiteout leading-relaxed">{outcome.wouldBeEvaluableBy}</p>
        <p className="mt-2 text-xs font-mono text-pewter">{outcome.undecidedPolicySummary}</p>
      </article>
    )
  }

  const label = OUTCOME_STATE_LABEL.satisfied
  return (
    <article className="rounded-[4px] border border-graphite-light bg-graphite-deep p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full bg-neon-glow shadow-[var(--shadow-glow)] shrink-0"
          />
          <h3 className="text-sm font-semibold text-whiteout">{label.label}</h3>
        </span>
        <code className="text-xs font-mono text-pewter">{outcome.satisfiedPolicyId}</code>
        <span className="text-xs font-mono text-pewter tabular-nums">
          {outcome.runsEstablishedOver} run(s), {outcome.eventsExamined} event(s) examined
        </span>
      </header>
      <p className="mt-2 text-sm text-cloud leading-relaxed">{label.meaning}</p>
      {/* THE BASIS IS ON THE CARD, NOT IN A TOOLTIP AND NOT ON A DETAIL PAGE.
          An operator reading "no violation found" will not go and look up what
          it rests on, and a reviewer six months later certainly will not. The
          declaring agent version and the mechanism it named are the whole of the
          claim. */}
      <h4 className="mt-3 text-xs font-mono uppercase tracking-wider text-pewter">
        This rests on a claim the agent made, not on something we observed
      </h4>
      <p className="mt-1 text-sm text-whiteout leading-relaxed">
        Agent version <code className="font-mono text-neon-glow">{outcome.declaredBy}</code>{' '}
        {outcome.declaredMechanism}. If that declaration is wrong, this result is wrong, and nothing in the log
        would show it.
      </p>
      <p className="mt-2 text-sm text-whiteout leading-relaxed">{outcome.satisfiedRationale}</p>
      <p className="mt-2 text-xs font-mono text-pewter">{outcome.satisfiedPolicySummary}</p>
    </article>
  )
}
