/**
 * lib/policies/outcomes.ts — reading a policy evaluation into the three states
 * a screen may show, from a body nothing has vouched for.
 *
 * ===========================================================================
 * FOUR RULES, IN PRECEDENCE ORDER. EVERY FUNCTION BELOW IS ONE OF THEM.
 * ===========================================================================
 *
 * 1. A VIOLATION IS PROVABLE AND OUTRANKS EVERYTHING.
 *
 *    A recorded forbidden call is a positive fact in an append-only log. It
 *    survives a truncated scan, a malformed sibling outcome, an unreadable
 *    coverage field and a defect anywhere else in the body. `readOutcomes`
 *    therefore reads violations FIRST and independently, and
 *    {@link orderOutcomes} puts them at the top of the list no matter what else
 *    the evaluation says. The reverse ordering — a "show complete results only"
 *    filter — is the natural thing to build and it suppresses breaches.
 *
 * 2. `not_evaluable` MAY NEVER RENDER AS AN ALL-CLEAR.
 *
 *    Not as a green tick, not as an absence, not as an empty list, not as a
 *    denominator. It is a distinct state with its own required prose and its own
 *    required next action.
 *
 * 3. A `satisfied` FINDING WITHOUT AN INSTRUMENTATION DECLARATION IS DEMOTED.
 *
 *    `convex/helpers/policy.ts`'s `ACT_RECORDING_COMPLETENESS` says
 *    `not_established` for all three act kinds, and `packages/sdk/src` has no
 *    interception anywhere — `toolCall`, `httpRequest` and `llmRequest` are
 *    manual builders. So a complete read of an incomplete recording proves
 *    nothing about the world, and contracts makes that a TYPE ERROR by requiring
 *    a `CompleteInstrumentationClaim` on the licence.
 *
 *    A JSON body is not typechecked. {@link readOutcomes} therefore re-checks it
 *    and DEMOTES an undeclared `satisfied` to `not_evaluable` with kind
 *    `instrumentation_undeclared`. Demotion is safe in exactly one direction and
 *    this is that direction; there is no promotion anywhere in this file.
 *
 * 4. NO RATIO, NO PERCENTAGE, NO BARE SATISFIED COUNT IS DERIVABLE FROM
 *    ANYTHING HERE.
 *
 *    {@link OutcomeCounts} carries all three numbers or none, mirroring
 *    contracts' `PolicyOutcomeCounts`, and this module exports no division, no
 *    total, and no single-state count. A ratio is a compliance claim in visual
 *    form; the denominator that would mix runs we cleared with runs we could not
 *    open is exactly the arithmetic that turns `not_evaluable` into `satisfied`.
 *    `tests/unit/policy_ui_no_compliance_ratio.test.ts` pins it over the source.
 */
import { complianceClaimIn, type PolicyNotEvaluableKind } from '@agent-flight-recorder/contracts'

import { readConvexPolicyRow, type ConvexPolicyRow } from './localWire'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

// ---------------------------------------------------------------------------
// THE THREE STATES, AS A SCREEN NEEDS THEM
//
// FIELD-DISJOINT, exactly as contracts' `PolicyOutcome` is, and for the same
// reason: the union is USELESS UNNARROWED. There is no `policyId` and no message
// common to the three, so `o.satisfiedPolicyId ?? o.undecidedPolicyId` and every
// other shortcut that flattens three states into two is a compile error rather
// than a code-review catch.
// ---------------------------------------------------------------------------

/** One recorded event that proves the breach. Every field is checkable by opening the event. */
export interface ViolationCitation {
  readonly runId: string
  readonly eventId: string
  readonly sequenceNumber: number
  readonly eventType: string
  readonly observedValue: string
  readonly recordedAt: number
}

export interface ViewViolated {
  readonly state: 'violated'
  readonly violatedPolicyId: string
  readonly violatedPolicyRevision: number | null
  readonly violatedRationale: string
  readonly violatedPolicySummary: string
  /** NON-EMPTY BY TYPE. A violation with no citation is an accusation, not a finding. */
  readonly provenBy: readonly [ViolationCitation, ...ViolationCitation[]]
  readonly violationCount: number
  /** True when the scan stopped early: THERE MAY BE MORE, NEVER FEWER. */
  readonly violationCountIsFloor: boolean
}

export interface ViewNotEvaluable {
  readonly state: 'not_evaluable'
  readonly undecidedPolicyId: string
  readonly undecidedRationale: string
  readonly undecidedPolicySummary: string
  readonly kind: PolicyNotEvaluableKind | 'unreadable_finding'
  readonly notEvaluableBecause: string
  /** REQUIRED, as an ACTION. A band that reads as a shrug is one people configure around. */
  readonly wouldBeEvaluableBy: string
  readonly runsAffected: number | null
}

export interface ViewSatisfied {
  readonly state: 'satisfied'
  readonly satisfiedPolicyId: string
  readonly satisfiedRationale: string
  readonly satisfiedPolicySummary: string
  readonly runsEstablishedOver: number
  readonly eventsExamined: number
  /**
   * REQUIRED. The agent version whose DECLARATION this rests on, and the
   * mechanism it named. Not optional: an all-clear whose basis is not on screen
   * beside it is the sentence somebody forwards to an auditor.
   */
  readonly declaredBy: string
  readonly declaredMechanism: string
}

export type PolicyOutcomeView = ViewViolated | ViewNotEvaluable | ViewSatisfied

/** Total over the three states, declared once, so a fourth is a compile error here. */
const ALL_CLEAR_STATES: Record<PolicyOutcomeView['state'], boolean> = {
  violated: false,
  not_evaluable: false,
  satisfied: true,
}

/**
 * Is this one outcome an established all-clear for its own policy?
 *
 * FAILS CLOSED. Deliberately not called `isClean`, `isCompliant` or `passed` —
 * the short words are the ones that end up on badges.
 */
export function isEstablishedSatisfiedView(outcome: PolicyOutcomeView): boolean {
  const state = (outcome as { state?: unknown })?.state
  return typeof state === 'string' && ALL_CLEAR_STATES[state as PolicyOutcomeView['state']] === true
}

// ---------------------------------------------------------------------------
// READING
// ---------------------------------------------------------------------------

function policySummary(row: ConvexPolicyRow | null, fallbackId: string): string {
  if (row === null) return `policy ${fallbackId} (definition unreadable)`
  return `${row.prohibits} ${row.matcher.match} "${row.matcher.value}" @ ${row.scope}:${row.scopeId}`
}

function rationaleOf(row: ConvexPolicyRow | null): string {
  return row?.rationale ?? 'This policy carried no stated rationale in the evaluation body.'
}

function readCitations(value: unknown): ViolationCitation[] {
  if (!Array.isArray(value)) return []
  const out: ViolationCitation[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    if (!isNonEmptyString(raw['runId']) || !isNonEmptyString(raw['eventId'])) continue
    if (!isCount(raw['sequenceNumber']) || !isNonEmptyString(raw['eventType'])) continue
    if (!isNonEmptyString(raw['observedValue'])) continue
    out.push({
      runId: raw['runId'],
      eventId: raw['eventId'],
      sequenceNumber: raw['sequenceNumber'],
      eventType: raw['eventType'],
      observedValue: raw['observedValue'],
      recordedAt: typeof raw['observedAt'] === 'number' ? raw['observedAt'] : 0,
    })
  }
  return out
}

/**
 * The declaration a licence must carry before its `satisfied` may stand.
 *
 * `convex/helpers/policy.ts`'s `LocalExhaustiveRunRead.recordingDeclaration` is
 * OPTIONAL and nothing in the product produces one. Absent means the read was
 * complete and the RECORDING was never established — which is precisely the
 * state contracts spells `instrumentation_undeclared`.
 */
function readDeclaration(licence: unknown): { by: string; mechanism: string } | null {
  if (!isRecord(licence)) return null
  const decl = licence['recordingDeclaration']
  if (!isRecord(decl)) return null
  if (decl['proves'] !== 'agent_declared_complete_act_recording') return null
  const by = decl['declaredBy']
  if (!isNonEmptyString(by)) return null
  const kind = decl['forActKind']
  return {
    by,
    mechanism: isNonEmptyString(kind)
      ? `declares complete recording for ${kind}`
      : 'declares complete recording, without naming the act kind',
  }
}

/**
 * The DEMOTION, as its own named function so it is a thing a test can hold.
 *
 * Rule 3 of this file's header. Returns the `not_evaluable` an undeclared
 * `satisfied` becomes, with the prose and the next action contracts requires.
 */
export function demoteUndeclaredSatisfaction(
  policyId: string,
  row: ConvexPolicyRow | null,
  runsAffected: number | null,
): ViewNotEvaluable {
  return {
    state: 'not_evaluable',
    undecidedPolicyId: policyId,
    undecidedRationale: rationaleOf(row),
    undecidedPolicySummary: policySummary(row, policyId),
    kind: 'instrumentation_undeclared',
    notEvaluableBecause:
      'the event log was read end to end and nothing forbidden was found — but nothing establishes that acts of ' +
      'this kind were completely recorded. The SDK records a tool call, an HTTP request or a model call only when ' +
      'the caller invokes the manual builder for it; nothing proxies, wraps or intercepts anything. An act ' +
      'performed outside the recorded path leaves no row whose absence this evaluation could detect, so an empty ' +
      'result here is a statement about the log and not about what the agent did.',
    wouldBeEvaluableBy:
      'have this agent version declare that it performs no act of this kind outside the recorded path. That ' +
      'declaration is falsifiable — a later recorded act through an unrecorded route contradicts it — which is ' +
      'what would make this decidable. Until then this policy is unevaluated over these runs.',
    runsAffected,
  }
}

/**
 * Read one finding into one of the three view states, or `null` when the finding
 * is not readable as any of them.
 *
 * A `null` is NOT a skip upstream — {@link readOutcomes} turns it into an
 * `unreadable_finding` not-evaluable, because an outcome dropped from a
 * compliance list reads as a policy with nothing to report.
 */
export function readFinding(raw: unknown): PolicyOutcomeView | null {
  if (!isRecord(raw)) return null
  const band = raw['finding'] ?? raw['outcome']

  // ---- RULE 1. Read FIRST, and with the loosest requirements of the three. --
  //
  // A violation is established by its citations and nothing else. It does not
  // need a readable policy row, a revision, a count, or a well-formed sibling
  // field — every one of those is reported as missing rather than allowed to
  // erase the breach.
  if (band === 'violated') {
    const policyId = raw['violatedPolicyId']
    if (!isNonEmptyString(policyId)) return null
    const citations = readCitations(raw['violatedBy'] ?? raw['provenBy'])
    if (citations.length === 0) return null
    const row = readConvexPolicyRow(raw['violatedPolicy'])
    const count = isCount(raw['violationCount']) ? raw['violationCount'] : citations.length
    return {
      state: 'violated',
      violatedPolicyId: policyId,
      violatedPolicyRevision: isCount(row?.revision) ? row.revision : null,
      violatedRationale: rationaleOf(row),
      violatedPolicySummary: policySummary(row, policyId),
      provenBy: citations as [ViolationCitation, ...ViolationCitation[]],
      violationCount: count,
      // FAILS CLOSED TO `true`. A dropped flag must never read as "this is the
      // total"; an under-counted breach is survivable, a floor rendered as a
      // total is not.
      violationCountIsFloor: raw['violationCountIsFloor'] !== false,
    }
  }

  if (band === 'not_evaluable') {
    const policyId = raw['notEvaluablePolicyId'] ?? raw['undecidedPolicyId']
    if (!isNonEmptyString(policyId)) return null
    const row = readConvexPolicyRow(raw['notEvaluablePolicy'])
    const because = raw['notEvaluableBecause']
    const next = raw['wouldBeEvaluableBy']
    return {
      state: 'not_evaluable',
      undecidedPolicyId: policyId,
      undecidedRationale: rationaleOf(row),
      undecidedPolicySummary: policySummary(row, policyId),
      kind: isNonEmptyString(raw['kind'])
        ? (raw['kind'] as PolicyNotEvaluableKind)
        : 'unreadable_finding',
      notEvaluableBecause: isNonEmptyString(because)
        ? because
        : 'the evaluation stated no reason. That is itself a reason not to treat this policy as checked.',
      wouldBeEvaluableBy: isNonEmptyString(next)
        ? next
        : 'no next step was stated by the evaluation. Open the run and check the policy definition by hand.',
      runsAffected: isCount(raw['runsAffected']) ? raw['runsAffected'] : null,
    }
  }

  if (band === 'satisfied') {
    const policyId = raw['satisfiedPolicyId']
    if (!isNonEmptyString(policyId)) return null
    const row = readConvexPolicyRow(raw['satisfiedPolicy'])
    const licences = Array.isArray(raw['establishedOver']) ? raw['establishedOver'] : []
    const runsAffected = licences.length > 0 ? licences.length : null

    // ---- RULE 3. THE DEMOTION. ------------------------------------------
    //
    // EVERY licence must carry a declaration, not merely one of them: a
    // satisfied finding spanning ten runs of which one declared is nine runs of
    // "we did not look" wearing the tenth run's badge.
    if (licences.length === 0) return demoteUndeclaredSatisfaction(policyId, row, runsAffected)
    const declarations = licences.map(readDeclaration)
    if (declarations.some((d) => d === null)) {
      return demoteUndeclaredSatisfaction(policyId, row, runsAffected)
    }

    // The all-clear must state its own basis in the same breath, so the prose is
    // re-checked here too: a producer that wrote a compliance word into a
    // mechanism string has smuggled the badge back through the one channel no
    // field name check covers.
    const first = declarations[0] as { by: string; mechanism: string }
    if (complianceClaimIn(first.mechanism) !== null || complianceClaimIn(rationaleOf(row)) !== null) {
      return demoteUndeclaredSatisfaction(policyId, row, runsAffected)
    }

    let eventsExamined = 0
    for (const licence of licences) {
      if (isRecord(licence) && isCount(licence['eventsExamined'])) {
        eventsExamined += licence['eventsExamined']
      }
    }
    return {
      state: 'satisfied',
      satisfiedPolicyId: policyId,
      satisfiedRationale: rationaleOf(row),
      satisfiedPolicySummary: policySummary(row, policyId),
      runsEstablishedOver: licences.length,
      eventsExamined,
      declaredBy: first.by,
      declaredMechanism: first.mechanism,
    }
  }

  return null
}

/**
 * Read every finding, keeping the unreadable ones as their own not-evaluable
 * rather than dropping them.
 */
export function readOutcomes(findings: unknown): PolicyOutcomeView[] {
  if (!Array.isArray(findings)) return []
  const out: PolicyOutcomeView[] = []
  for (const [index, raw] of findings.entries()) {
    const read = readFinding(raw)
    if (read !== null) {
      out.push(read)
      continue
    }
    out.push({
      state: 'not_evaluable',
      undecidedPolicyId: `finding[${index}]`,
      undecidedRationale: 'This finding could not be read, so its policy is unaccounted for.',
      undecidedPolicySummary: `finding[${index}] (unreadable)`,
      kind: 'unreadable_finding',
      notEvaluableBecause:
        'the evaluation returned a finding this interface could not read as any of the three states. It is shown ' +
        'rather than dropped: a policy missing from a report reads as a policy with nothing to report.',
      wouldBeEvaluableBy:
        're-run the evaluation, and if it recurs report the malformed finding — the evaluation cannot be treated ' +
        'as covering this policy in the meantime.',
      runsAffected: null,
    })
  }
  return out
}

/**
 * RULE 1 IN THE RENDER ORDER: violations first, then everything that was not
 * looked at, then the established all-clears.
 *
 * The ordering is not cosmetic. A reader under incident pressure acts on what is
 * at the top of the screen, and the one state that is a PROVEN FACT belongs
 * there — above, not below, whatever else in the same report could not be read.
 */
const STATE_RANK: Record<PolicyOutcomeView['state'], number> = {
  violated: 0,
  not_evaluable: 1,
  satisfied: 2,
}

export function orderOutcomes(outcomes: readonly PolicyOutcomeView[]): PolicyOutcomeView[] {
  return [...outcomes].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])
}

/**
 * The three counts, ALL THREE OR NONE.
 *
 * Mirrors contracts' `PolicyOutcomeCounts` exactly, including the reason it is
 * shaped that way: a satisfied figure travelling alone is the attestation figure
 * with every safeguard stripped off. There is deliberately no `countSatisfied`,
 * no total, and no ratio in this module.
 */
export interface OutcomeCounts {
  readonly violated: number
  readonly notEvaluable: number
  readonly satisfied: number
}

export function countOutcomes(outcomes: readonly PolicyOutcomeView[]): OutcomeCounts {
  let violated = 0
  let notEvaluable = 0
  let satisfied = 0
  for (const o of outcomes) {
    if (o.state === 'violated') violated += 1
    else if (o.state === 'not_evaluable') notEvaluable += 1
    else satisfied += 1
  }
  return { violated, notEvaluable, satisfied }
}
