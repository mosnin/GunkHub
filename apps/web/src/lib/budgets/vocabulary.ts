/**
 * THE WORDS THIS PRODUCT USES FOR BREAKER STATES AND SDK DECISIONS.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LABELS LIVE IN ONE FILE AND NOT AT THEIR RENDER SITES
 * ---------------------------------------------------------------------------
 *
 * Contracts gives three breaker states and six decisions their own types with
 * no shared fields, so no renderer can print one under another's heading by
 * forgetting to narrow. That barrier stops at the TYPE. It does not stop a
 * renderer from narrowing correctly and then giving two distinct bands the same
 * green tick — which collapses them just as completely, one layer later, where
 * nothing is checking.
 *
 * The specific collapse this file exists to prevent is the told-yes-versus-
 * not-asked line. FOUR of the six decisions mean "proceed" and they are not
 * interchangeable:
 *
 *   allowed_breaker_armed        enforcement WORKED       — we asked, we were told yes
 *   allowed_no_budget_governs    enforcement ABSENT       — there was nothing to ask
 *   allowed_within_grace         enforcement DEGRADED     — an old yes, honoured past expiry
 *   allowed_without_answer       enforcement OFF          — we could not ask, policy proceeds
 *
 * An organization whose decisions are entirely the fourth band has no budget
 * control whatsoever, and on any surface that renders all four alike its graphs
 * are indistinguishable from an organization that has. So:
 *
 *   1. THE LABELS ARE TOTAL RECORDS. A seventh decision band is a compile error
 *      here until somebody writes what it says.
 *   2. EVERY LABEL IS DISTINCT AS PLAIN TEXT. Strip every colour, icon, dot and
 *      font from this UI and the four proceed bands still read as four
 *      different sentences. Pinned by
 *      `tests/unit/budget_ui_proceed_reasons.test.ts`, which compares the
 *      labels with all styling removed.
 *   3. NOTHING NAMES THE AGENT AS ITS SUBJECT. Every string below is about the
 *      BREAKER or about THE SDK. There is no "stopped", "halted", "blocked",
 *      "prevented" or "enforced" in any of them, because we record and we
 *      decline — we do not stop a process and cannot observe whether one
 *      stopped. Pinned by `tests/unit/budget_ui_no_execution_claim.test.ts`.
 *
 * THE FULL PROSE IS STILL COMPOSED BY CONTRACTS. `decisionStatement` and
 * `spendStatement` are the authoritative sentences and this file never
 * duplicates or paraphrases them — these are SHORT LABELS for a column, shown
 * alongside the contract's own sentence, never instead of it.
 */
import type { BreakerState, BudgetDecision } from '@agent-flight-recorder/contracts'

/**
 * How much of an answer a band represents. Drives ORDERING and grouping only —
 * never a single shared colour, because collapsing four bands onto one axis is
 * the defect this file exists against.
 */
export type EnforcementPosture =
  /** We asked and were told. The only posture that means the breaker did its job. */
  | 'answered'
  /** The breaker withheld. A fact about the breaker and about the SDK, never about an agent. */
  | 'withheld'
  /** No answer was established: nothing was asked, or nothing could be concluded. */
  | 'unestablished'

export interface BandLabel {
  /** Short, distinct, plain text. Legible with every style stripped. */
  label: string
  /** One sentence of what it means, for a caption under the label. */
  meaning: string
  posture: EnforcementPosture
}

/**
 * The three breaker states.
 *
 * NOTE `undetermined` IS NOT PHRASED AS A SHRUG. In this deployment it is the
 * MOST COMMON state by a wide margin — every counter-backed budget below its
 * limit reports it — so a label reading "unknown" would train operators to
 * ignore the majority of their own screen.
 */
export const BREAKER_STATE_LABEL: Record<BreakerState['state'], BandLabel> = {
  tripped: {
    label: 'Tripped',
    meaning:
      'The limit was reached, or an operator tripped this breaker by hand. This is a fact about the breaker; ' +
      'it does not establish that any spend was avoided.',
    posture: 'withheld',
  },
  armed: {
    label: 'Armed — headroom established',
    meaning:
      'An exact figure was summed and it is below the limit even at its least favourable reading. Only a ' +
      'run-scoped budget reconciled from the event log can reach this state.',
    posture: 'answered',
  },
  undetermined: {
    label: 'Not established',
    meaning:
      'No conclusion could be drawn — the available figure cannot decide this limit in either direction. This is ' +
      // Phrased as what the budget IS rather than as what is not being done to
      // it. "not being enforced" would be honest, but the execution-claim gate
      // bans the word bluntly rather than trying to distinguish a legitimate
      // negation from an illegitimate assertion — and a blunt ban that costs an
      // occasional rewording is worth more than a clever one that can be argued
      // around at 3am.
      'not headroom, and a budget that sits here permanently is a limit nothing can act on.',
    posture: 'unestablished',
  },
}

/**
 * The six decision bands, as a total record.
 *
 * THE FOUR PROCEED BANDS READ AS FOUR DIFFERENT SENTENCES, and the difference
 * is carried by the words rather than by anything a stylesheet supplies. Two of
 * them lead with "Not checked", which is deliberate: that is the fact an
 * operator most needs and the one a green tick most reliably destroys.
 */
export const DECISION_LABEL: Record<BudgetDecision['decision'], BandLabel> = {
  allowed_breaker_armed: {
    label: 'Checked — headroom established',
    meaning:
      'Every governing breaker was consulted and each established headroom. This is the only band in which the ' +
      'budget check did the job it exists to do.',
    posture: 'answered',
  },
  allowed_no_budget_governs: {
    label: 'Not checked — no budget governs this subject',
    meaning:
      'There is no cap here, so there is nothing to have room in. This is also what a deleted, disabled or ' +
      'mis-scoped budget looks like.',
    posture: 'unestablished',
  },
  allowed_within_grace: {
    label: 'Degraded — honouring an expired answer',
    meaning:
      'The last answer said there was headroom, it has expired, and the server could not be re-asked. The ' +
      'configured grace is being honoured for a bounded window, after which this becomes a decline.',
    posture: 'unestablished',
  },
  allowed_without_answer: {
    label: 'Not checked — proceeding without an answer',
    meaning:
      'No answer was obtained and the configured policy proceeds regardless. This is not evidence of headroom and ' +
      'must never be counted as any.',
    posture: 'unestablished',
  },
  declined_breaker_tripped: {
    label: 'Declined by the SDK — breaker tripped',
    meaning:
      'The breaker is tripped and the SDK returned a decline. Those are the two facts; what the calling process ' +
      'did next is not one of them.',
    posture: 'withheld',
  },
  declined_no_answer: {
    label: 'Declined by the SDK — no usable answer',
    meaning:
      'The breaker could not be consulted and the configured policy declines. This is not a claim that a breaker ' +
      'is tripped — that is not known.',
    posture: 'withheld',
  },
}
