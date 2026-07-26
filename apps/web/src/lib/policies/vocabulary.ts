/**
 * lib/policies/vocabulary.ts — the words this feature shows a human, in one
 * place.
 *
 * ===========================================================================
 * WHY THE LABELS ARE LONG, AND WHY THAT IS NOT A STYLE PREFERENCE
 * ===========================================================================
 *
 * Every short spelling of the good outcome — `clean`, `compliant`, `passed`,
 * `ok`, `✓` — is a word somebody puts on a badge, and a badge does not carry
 * "over the runs we read, in the window we asked about, on the agent's own
 * declaration that it records what it does". Contracts refuses those spellings
 * at the wire (`FORBIDDEN_COMPLIANCE_CLAIM_FIELDS`) and in prose
 * (`FORBIDDEN_COMPLIANCE_PROSE`); this file is the same refusal at the last
 * layer, where the words actually reach a person.
 *
 * NOTHING HERE ABBREVIATES `not_evaluable`. It is the universal state in this
 * product today — no agent declares its instrumentation, so nothing can license
 * a satisfaction — and the failure mode is specific: if it reads as a defect,
 * operators file it as one, and somebody "fixes" it by loosening the type. So
 * the label says what it is (a state, not an error) and the explanation says why
 * it is the honest answer.
 *
 * `tests/unit/policy_ui_three_states.test.tsx` §4 asserts that no string in this
 * file trips contracts' own `complianceClaimIn` prose guard — including the
 * near-misses: the honest way to warn against a clean reading is to name what
 * the result is NOT ("not a finding that nothing was violated"), not to quote
 * the badge word in a negation. A blanket guard cannot tell a negation from an
 * assertion, and copy that trips it turns a real smuggled claim into one entry
 * in a haystack of our own false positives.
 */
import type { PolicyNotEvaluableKind, PolicyVerdict } from '@agent-flight-recorder/contracts'

/** The one-line heading and the sentence under it, for each of the three states. */
export const OUTCOME_STATE_LABEL = {
  violated: {
    label: 'VIOLATED',
    meaning:
      'The recorded log contains the operation this policy forbids, at the events cited below. This states that ' +
      'the act WAS RECORDED. It does not state that anything was prevented, and nothing in this product could ' +
      'have prevented it.',
  },
  not_evaluable: {
    label: 'NOT EVALUABLE',
    meaning:
      'This policy was NOT checked over these runs. That is not a finding of no violation — it is the absence of ' +
      'a finding, and it may not be read, quoted or forwarded as evidence that nothing happened.',
  },
  satisfied: {
    label: 'NO VIOLATION FOUND',
    meaning:
      'The log was read end to end over a finished run, every deciding field was legible, and nothing forbidden ' +
      'appears. This rests on the agent version\'s own declaration that it records what it does — a claim this ' +
      'product cannot verify. If the declaration is wrong, this result is wrong and nothing in the log would ' +
      'show it.',
  },
} as const

/**
 * Why a policy could not be decided, in words, for every kind contracts defines,
 * plus the local spellings `convex/helpers/policy.ts` still emits and the one
 * this interface produces on its own.
 *
 * ===========================================================================
 * A TOTAL RECORD, AND THE TOTALITY IS THE POINT
 * ===========================================================================
 *
 * Keyed on contracts' `PolicyNotEvaluableKind`, so a new kind added there is a
 * COMPILE ERROR here until somebody has written the sentence a person reads.
 * That barrier has already earned its keep twice: `deciding_field_unreadable`
 * and `policy_disabled` both arrived this way and both needed real copy, not a
 * placeholder — the first because it replaced a path that used to clear
 * silently, the second because "we did not check this because you turned it off"
 * is a different instruction to an operator than any other row on the screen.
 *
 * A band that renders with no explanation reads as a shrug, and a band that
 * reads as a shrug is one people learn to configure around — which here means
 * turning it into a tick.
 *
 * THE EXTRA KEYS ARE NOT AN EXPANSION OF THE VOCABULARY. They are the local
 * spellings the Convex engine still emits (`deciding_field_externalized`,
 * `event_log_read_truncated`, `run_in_progress`, `sequence_gap`,
 * `run_unavailable`) plus `unreadable_finding`, which only this layer can
 * produce — see `readOutcomes`. They exist so an engine-side spelling reaches a
 * reader with a sentence rather than as a bare token, and they go away when the
 * two vocabularies are reconciled.
 */
export const NOT_EVALUABLE_LABEL: Record<
  | PolicyNotEvaluableKind
  | 'unreadable_finding'
  | 'deciding_field_externalized'
  | 'event_log_read_truncated'
  | 'run_in_progress'
  | 'sequence_gap'
  | 'run_unavailable',
  string
> = {
  instrumentation_undeclared:
    'the agent has not declared that it records the acts this rule is about. The SDK writes a tool call, an HTTP ' +
    'request or a model call only when the caller invokes the manual builder for it; nothing intercepts anything. ' +
    'An empty result is therefore a statement about the log, not about what the agent did.',
  evidence_externalized:
    'the payload carrying the deciding field was larger than 10 KB and was written to blob storage (Event Log ' +
    'Rule 3), so the field is not in the event row and the artifact was not fetched.',
  deciding_field_unreadable:
    'the value this rule turns on WAS recorded and could not be interpreted — a URL that does not parse, a host ' +
    'that cannot be normalised, a tool name that is not a string. The event is there; the field is unusable. ' +
    'This is evidence we could not read, and it is deliberately NOT the same state as a field that was read and ' +
    'matched nothing: an unreadable value used to count as a legible one, match against nothing, and clear the ' +
    'run — which is a false clean result built out of a broken emitter. The remedy is to fix whatever wrote that ' +
    'payload, not to re-run the scan.',
  policy_disabled:
    'this policy is SWITCHED OFF, so it governs nothing and this run was not graded against it. Nothing failed ' +
    'here — somebody turned the rule off, and this row is saying so rather than quietly omitting it. It is ' +
    'reported as unevaluated rather than as clean for one specific reason: if a disabled policy produced a ' +
    'clean result, a failing scan could be made to pass by switching off the policies it was failing. It is not ' +
    'reported as a violation either, because a violation on a rule nobody enabled is a false finding somebody ' +
    'acts on — a rollback, or a blocked deploy, on a rule that was explicitly turned off. Unevaluated is the ' +
    'only reading that is wrong in neither direction.',
  deciding_field_externalized:
    'the payload carrying the deciding field was externalised to blob storage, so the value that would decide ' +
    'this rule is not in the event row.',
  log_not_read_to_end:
    'the scan stopped on a ceiling before it reached the end of the log. What is past that point is unknown, and ' +
    'a violation is exactly as likely to be there as anywhere else.',
  event_log_read_truncated:
    'the scan stopped on a ceiling before it reached the end of the log, so this run was not read through.',
  run_in_flight:
    'the run has not reached a terminal event. It may still record the forbidden act — "no violation so far" is ' +
    'a stopwatch, not a finding.',
  run_in_progress:
    'the run has not finished. It may still record the forbidden act.',
  run_unreadable:
    'the run itself could not be read. It may have been purged under the org\'s retention window (ADR-001), or ' +
    'it may not exist; those two are deliberately indistinguishable from outside the organization that owns it.',
  run_unavailable:
    'the run itself could not be read, either because it was purged under retention or because it is not there.',
  scan_contaminated:
    'the scan read rows it could not account for, so nothing it found or did not find covers this policy.',
  sequence_gap:
    'the run\'s sequence numbers were not contiguous, so the log this evaluation read is not the whole log ' +
    '(Event Log Rule 4).',
  run_not_opened:
    'the cross-run scan never opened this run. It is listed rather than omitted, because a run missing from a ' +
    'report reads as a run with nothing to report.',
  no_runs_in_scope:
    'no run is in scope at all, so nothing was evaluated over. An empty set satisfies every prohibition ' +
    'vacuously, and a scan pointed at the wrong project produces exactly that — which is why it is this state ' +
    'and not a green one.',
  policy_unreadable:
    'the policy row was read but its rule is one this engine cannot interpret. A rule nothing can evaluate is a ' +
    'control that appears to be in force and grades nothing.',
  coverage_unestablished:
    'nothing positive was established about the coverage of this evaluation.',
  unreadable_finding:
    'the evaluation returned a result this interface could not read. It is shown rather than dropped.',
}

/** The four verdicts, spelled out. Exactly one of them is an all-clear and its name is long on purpose. */
export const VERDICT_LABEL: Record<PolicyVerdict, { label: string; meaning: string }> = {
  violations_found: {
    label: 'VIOLATIONS FOUND',
    meaning:
      'At least one policy was broken and the record shows it. This remains true regardless of anything else in ' +
      'this evaluation that could not be read.',
  },
  no_policy_governs_this_subject: {
    label: 'NO POLICY GOVERNS THIS SUBJECT',
    meaning:
      'Nothing was checked, because there was nothing to check. THIS IS NOT AN ALL-CLEAR. It is also what a ' +
      'deleted, disabled or mis-scoped policy set looks like — if you expected coverage here, the policies are ' +
      'not attached to this subject.',
  },
  evaluation_incomplete: {
    label: 'EVALUATION INCOMPLETE',
    meaning:
      'Something was not looked at, so this cannot support a statement that no violation occurred. Read the ' +
      'per-policy outcomes below: each one that could not be decided says what would decide it, and today the ' +
      'most common answer is that the agent has not declared its instrumentation.',
  },
  no_violation_and_every_policy_was_evaluable: {
    label: 'NO VIOLATION FOUND, AND EVERY POLICY WAS EVALUABLE',
    meaning:
      'Every policy governing this subject was evaluable over every run in scope, each read end to end, each on ' +
      'an agent version that DECLARES complete recording for the relevant operations. This claim is exactly as ' +
      'wide as that scope and no wider. It rests on the agents\' own declarations, which this product cannot ' +
      'verify. Quote the scope with the result or do not quote the result.',
  },
}

/** What each stored act kind forbids, in words, for the definition list. */
export const ACT_KIND_LABEL: Record<string, string> = {
  tool_invocation: 'tool call',
  egress_to_host: 'HTTP request to host',
  model_invocation: 'model call',
}
