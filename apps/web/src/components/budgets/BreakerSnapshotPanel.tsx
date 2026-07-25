import {
  decideBudget,
  decisionStatement,
  isBreakerSnapshotComplete,
  type BreakerSnapshot,
  type BudgetUnavailablePolicy,
} from '@agent-flight-recorder/contracts'

import type { BreakerSnapshotRead } from '@/lib/services/budgets'

import { BreakerStateCard } from '@/components/budgets/BreakerStateCard'
import { ErrorState } from '@/components/ui/ErrorState'
import { DECISION_LABEL } from '@/lib/budgets/vocabulary'

/**
 * WHAT THE BREAKERS SAY, AND — SEPARATELY — WHETHER THAT IS AN ANSWER.
 *
 * ---------------------------------------------------------------------------
 * THE THREE QUIET SCREENS, WHICH MUST NEVER LOOK ALIKE
 * ---------------------------------------------------------------------------
 *
 * Three completely different situations all produce a page with no breaker rows
 * on it, and the difference between them is the difference between an outage,
 * an absence of cost control, and a normal healthy configuration:
 *
 *   COULD NOT READ      A body arrived that cannot be enforced on, or the query
 *                       failed. Rendered as an ERROR with the refusal reasons
 *                       listed. Never as an empty list — "we could not read
 *                       your breakers" shown as "you have no breakers" is the
 *                       dangerous direction, because it reads as reassurance.
 *
 *   NO BUDGET GOVERNS   A complete, trustworthy answer whose count is zero.
 *                       Rendered as its OWN thing, stating plainly that this is
 *                       not headroom and that it is also what a deleted or
 *                       mis-scoped budget looks like. Contracts gives this its
 *                       own decision band (`AllowedNoBudgetGoverns`, whose
 *                       `budgetsInScope` is the literal type `0`) for exactly
 *                       this reason.
 *
 *   PARTIALLY EVALUATED `budgetsEvaluated < budgetsInScope`, or
 *                       `evaluationTruncated`. Every count is then a FLOOR and
 *                       the answer is not an all-clear. Called out above the
 *                       rows rather than left to be inferred from two numbers
 *                       nobody compares by eye.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION PREVIEW, AND WHY IT SHOWS THREE POLICIES RATHER THAN ONE
 * ---------------------------------------------------------------------------
 *
 * The SDK decides; this product does not. `BudgetUnavailablePolicy` is a
 * required, explicit choice made by whoever runs the agent — failing open and
 * failing closed have different costs paid by different people, and no library
 * (and no dashboard) gets to pick on their behalf.
 *
 * So the preview does not show "the" decision. It shows what an SDK holding
 * THIS snapshot would decide under each of the three policies, which is the
 * only honest framing and also the one that makes the told-yes-versus-not-asked
 * line visible: an operator can see, in one place, that the same snapshot
 * yields "checked — headroom established" under no policy at all and
 * "not checked — proceeding without an answer" under `allow`. Those are not the
 * same event, and a single green tick would have made them one.
 *
 * `decideBudget` is called rather than reimplemented, for the reason contracts
 * gives: three copies of "what is safe to enforce on" is how three layers come
 * to disagree.
 */
interface BreakerSnapshotPanelProps {
  read: BreakerSnapshotRead
  /** Retry affordance for the unreadable arm. Optional — server pages can omit it. */
  onRetry?: () => void
}

/**
 * The three policies, previewed side by side.
 *
 * The `acceptedRisk` strings are the ones this preview is about, written down
 * here because the contract requires them on the two arms that weaken the
 * breaker — you may fail open, and you may not do it without a sentence
 * somebody can find later. These are illustrative: the sentence that matters is
 * the one in the customer's own code.
 */
const PREVIEW_POLICIES: { id: string; caption: string; policy: BudgetUnavailablePolicy }[] = [
  {
    id: 'deny',
    caption: 'onUnavailable: "deny" — fail closed',
    policy: { onUnavailable: 'deny' },
  },
  {
    id: 'grace',
    caption: 'onUnavailable: "grace" — honour a yes we already had, briefly',
    policy: {
      onUnavailable: 'grace',
      graceMs: 60_000,
      acceptedRisk: 'Up to 60s of spend past the cap during an outage of this service.',
    },
  },
  {
    id: 'allow',
    caption: 'onUnavailable: "allow" — fail open',
    policy: {
      onUnavailable: 'allow',
      acceptedRisk: 'Unbounded spend while this service is unreachable.',
    },
  },
]

function DecisionPreview({ snapshot }: { snapshot: BreakerSnapshot }) {
  // `receivedAt` is the client's own clock at the moment the snapshot arrived —
  // this render. The honouring ceiling is anchored on it and NOT on the
  // server's `evaluatedAt`, because a cap computed from a server-supplied
  // timestamp is defeated by the value it is capping.
  const receivedAt = Date.now()

  return (
    <section className="rounded-[4px] border border-graphite bg-graphite-deep p-4">
      <h3 className="text-sm font-semibold text-whiteout">What an SDK holding this snapshot would decide</h3>
      <p className="mt-1.5 text-sm text-pewter leading-relaxed">
        The decision belongs to whoever runs the agent, not to this service: the unavailability policy is a
        required, explicit choice, because failing open and failing closed have different costs paid by different
        people. All three are shown so the difference between being told yes and not having asked stays visible.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {PREVIEW_POLICIES.map(({ id, caption, policy }) => {
          const decision = decideBudget({ snapshot, receivedAt, now: receivedAt, policy })
          const label = DECISION_LABEL[decision.decision]
          return (
            <div key={id} className="rounded-[4px] border border-graphite-light bg-graphite p-3">
              <p className="text-xs font-mono text-pewter">{caption}</p>
              <p className="mt-1 text-sm font-semibold text-whiteout">{label.label}</p>
              <p className="mt-1 text-sm text-pewter leading-relaxed">{label.meaning}</p>
              {/* The contract's own composed sentence. Every decline branch of it
                  names the SDK as the subject and then says, in the same breath,
                  what that does not establish. */}
              <p className="mt-2 text-xs font-mono text-cloud leading-relaxed">
                {decisionStatement(decision)}
              </p>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function BreakerSnapshotPanel({ read, onRetry }: BreakerSnapshotPanelProps) {
  if (read.kind === 'unreadable') {
    return (
      <div>
        <ErrorState
          title="Breaker state could not be read"
          message={
            'A response arrived but it cannot be relied on, so no conclusion is being drawn from it. This is NOT ' +
            'the same as having no budgets configured, and it is not being shown as an empty list for that reason.'
          }
          {...(onRetry !== undefined ? { retry: onRetry } : {})}
        />
        <ul className="mx-auto mt-2 max-w-xl list-disc space-y-1 pl-5">
          {read.refusals.map((refusal) => (
            <li key={refusal} className="font-mono text-xs text-ember leading-relaxed">
              {refusal}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const { snapshot } = read
  const { scan } = snapshot
  const complete = isBreakerSnapshotComplete(snapshot)

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-[4px] border border-graphite bg-graphite-deep p-4">
        <h3 className="text-sm font-semibold text-whiteout">Evaluation</h3>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="font-mono text-pewter">evaluated at</dt>
          <dd className="font-mono text-cloud tabular-nums">
            {new Date(snapshot.evaluatedAt).toISOString()}
          </dd>
          <dt className="font-mono text-pewter">answer good until</dt>
          <dd className="font-mono text-cloud tabular-nums">
            {new Date(snapshot.freshUntil).toISOString()}
          </dd>
          <dt className="font-mono text-pewter">budgets in scope</dt>
          <dd className="font-mono text-cloud tabular-nums">{scan.budgetsInScope}</dd>
          <dt className="font-mono text-pewter">budgets evaluated</dt>
          <dd className="font-mono text-cloud tabular-nums">{scan.budgetsEvaluated}</dd>
        </dl>

        {!complete && (
          <p className="mt-3 rounded-[4px] border border-system-warning bg-graphite p-3 text-sm text-ember leading-relaxed">
            This evaluation is not a complete answer
            {/* "reached a server ceiling", not "stopped on" one. The word is
                avoided deliberately: `tests/unit/budget_ui_execution_claim.test.ts`
                bans the execution vocabulary bluntly rather than trying to tell
                a legitimate subject from an illegitimate one, and a blunt ban
                that costs an occasional rewording is worth more than a clever
                one that can be argued around. */}
            {scan.evaluationTruncated ? ' — it reached a server ceiling, so every count above is a floor' : ''}
            {scan.budgetsEvaluated !== scan.budgetsInScope
              ? ` — ${scan.budgetsEvaluated} of ${scan.budgetsInScope} governing budgets were read`
              : ''}
            . An incomplete evaluation is not an all-clear, and an SDK reading it will treat it as no answer at all.
          </p>
        )}
      </section>

      {scan.budgetsInScope === 0 ? (
        // NOT an EmptyState component. This is a specific, load-bearing fact
        // with its own remedy, and the generic "nothing here yet, go make one"
        // framing would file it alongside an unvisited list.
        <section className="rounded-[4px] border border-graphite-light bg-graphite-deep p-4">
          <h3 className="text-sm font-semibold text-whiteout">No budget governs this organization</h3>
          <p className="mt-1.5 text-sm text-cloud leading-relaxed">
            This is a complete answer, and it is not headroom — there is no cap here, so there is nothing to have
            room in. Note that it is also exactly what a deleted, disabled or mis-scoped budget looks like: if you
            expected a limit to apply, the budget is not attached where you think it is.
          </p>
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          {snapshot.states.map((state, index) => (
            <BreakerStateCard key={index} state={state} />
          ))}
        </div>
      )}

      <DecisionPreview snapshot={snapshot} />
    </div>
  )
}
