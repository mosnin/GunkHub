/**
 * fleet/labels.ts — human copy for the fleet contract's enums, and the
 * epistemic vocabulary the three bands are separated by.
 *
 * Entity types come from `@agent-flight-recorder/contracts` (CLAUDE.md §
 * Repo Conventions). Nothing in this file redeclares one; it maps wire enums
 * onto words a reader who has not learned the vocabulary can act on, and it
 * keeps that copy in ONE place so the three bands cannot quietly converge on
 * similar-sounding language.
 *
 * ---------------------------------------------------------------------------
 * THE THREE WORDS, AND WHY THESE THREE
 * ---------------------------------------------------------------------------
 *
 *   OBSERVED     it happened. Past indicative.
 *   HYPOTHESIS   might it be this? Interrogative/conditional.
 *   UNANSWERED   we could not check. Neither a finding nor its absence.
 *
 * No one of these is a substring of another, which matters more than it
 * sounds: a previous surface in this codebase used `PROVEN`/`UNPROVEN`, where
 * a text assertion for the first passes on the second, and the test that was
 * supposed to guarantee the distinction could not tell them apart.
 */

import type {
  AgentHealthState,
  FleetHealthVerdict,
  ObservedCorrelationKind,
  ShareDiscrimination,
  UnansweredFleetQuestionKind,
} from '@agent-flight-recorder/contracts'

export const OBSERVED_KIND_LABEL: Readonly<Record<ObservedCorrelationKind, string>> = {
  shared_failure_fingerprint: 'Same failure on several agents',
  temporal_burst: 'Several agents began failing at once',
  shared_declared_attribute: 'Cluster declares the same thing',
}

// HYPOTHESIS_KIND_LABEL is deliberately GONE. The hypothesis heading was the
// last place this UI composed its own sentence about a proposed cause, and
// contracts 0.18.0 removed `candidateExplanation` and made
// `hypothesisQuestion(h)` the single composer — always interrogative, in every
// branch, pinned by a test over the whole enum. Reintroducing a local label map
// here would give this surface a second way to phrase a hypothesis, which is
// exactly the drift the composer exists to prevent. Use `hypothesisQuestion`.

export const UNANSWERED_KIND_LABEL: Readonly<Record<UnansweredFleetQuestionKind, string>> = {
  roster_incomplete: 'Roster not fully enumerated',
  attribute_undeclared: 'Attribute not declared',
  occurrence_history_truncated: 'Failure history truncated',
  base_rate_unmeasurable: 'Base rate not measurable',
  engine_limit: 'Engine ceiling reached',
}

/**
 * Roster states. `unobserved` is NOT a synonym for healthy and its copy must
 * never imply a pass — an agent with no runs has not been tested, and that is
 * itself frequently the incident (a scheduler died, a queue stalled).
 */
export const AGENT_HEALTH_LABEL: Readonly<Record<AgentHealthState, string>> = {
  failing: 'FAILING',
  degrading: 'DEGRADING',
  healthy: 'HEALTHY',
  unobserved: 'NOT OBSERVED',
}

export const AGENT_HEALTH_MEANING: Readonly<Record<AgentHealthState, string>> = {
  failing: 'recorded failures in this window, at or above the failing threshold',
  degrading: 'recorded failures in this window, below the failing threshold',
  healthy: 'runs were observed in this window and none of them failed',
  unobserved: 'no runs at all in this window — nothing was tested, so this is not a pass',
}

/**
 * The verdict, in the operator's own question form. `indeterminate` gets the
 * longest, bluntest copy because it is the one a reader is most likely to skim
 * as "fine".
 */
export const VERDICT_WORD: Readonly<Record<FleetHealthVerdict, string>> = {
  correlated_failures: 'CORRELATED FAILURES',
  isolated_failures: 'ISOLATED FAILURES',
  healthy: 'NOTHING CORRELATED',
  indeterminate: 'INDETERMINATE',
}

export const VERDICT_MEANING: Readonly<Record<FleetHealthVerdict, string>> = {
  correlated_failures:
    'Several agents are failing in a way that was observed to connect them. This is a fleet event.',
  isolated_failures:
    'Agents are failing, but nothing was observed to connect them. These are real problems and they are not one incident.',
  healthy:
    'The scan finished, agents were assessed, and nothing was failing or correlated in this window.',
  indeterminate:
    'The scan did not finish. Nothing correlated was found, and that is not evidence that nothing is wrong — the question was not answered.',
}

/**
 * What a base-rate measurement supports. Three-valued on purpose: forcing
 * "we did not measure" into yes/no lies in the incident-shaped direction.
 */
export const DISCRIMINATION_WORD: Readonly<Record<ShareDiscrimination, string>> = {
  discriminating: 'MORE COMMON AMONG THE FAILING',
  not_discriminating: 'JUST AS COMMON AMONG THE HEALTHY',
  base_rate_unmeasured: 'BASE RATE NOT MEASURED',
}

export const DISCRIMINATION_MEANING: Readonly<Record<ShareDiscrimination, string>> = {
  discriminating:
    'The failing agents share this markedly more often than the healthy ones do. Worth reading first — still not proof.',
  not_discriminating:
    'The healthy agents share this about as often as the failing ones. It does not distinguish them, so it explains nothing on its own.',
  base_rate_unmeasured:
    'The healthy agents were not checked, so there is no denominator. This number cannot support or weaken the hypothesis — it is only a count of the failing side.',
}
