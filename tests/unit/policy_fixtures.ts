/**
 * Fixtures for the declarative policy suites.
 *
 * EVERY BUILDER PRODUCES A VALID OBJECT AND TAKES AN OVERRIDE, so a test that
 * wants to prove a barrier changes exactly one thing and nothing else. A test
 * that hand-builds an almost-valid body proves whichever defect it happened to
 * introduce rather than the one it names.
 */
import type {
  CompleteInstrumentationClaim,
  PolicyCoverageProof,
  PolicyDefinition,
  PolicyEvaluation,
  PolicyEvaluationScan,
  PolicyNotEvaluable,
  PolicyOutcome,
  PolicySatisfied,
  PolicySnapshot,
  PolicyViolated,
  PolicyViolationProof,
} from '@agent-flight-recorder/contracts'

export const NOW = 1_760_000_000_000

/** An agent that HAS declared complete recording for both operation classes. */
export function declared(
  overrides: Partial<CompleteInstrumentationClaim> = {}
): CompleteInstrumentationClaim {
  return {
    claims: 'complete',
    coversOperations: ['tool_denied', 'egress_denied'],
    mechanism: 'all outbound HTTP goes through recordedFetch(); node:http is not imported outside it',
    claimedByAgentVersionId: 'agentver_1',
    claimedAt: NOW - 100_000,
    ...overrides,
  }
}

/** A policy denying a NAMED tool. Not decidable over an externalized payload. */
export function toolPolicy(overrides: Partial<PolicyDefinition> = {}): PolicyDefinition {
  return {
    policyId: 'policy_1',
    orgId: 'org_1',
    name: 'no shell',
    revision: 3,
    rule: { kind: 'tool_denied', deniedTools: ['shell.exec'] },
    subject: { appliesTo: 'agent', agentId: 'agent_7' },
    rationale: 'SOC2 CC6.1 — no shell execution from customer-facing agents',
    enabled: true,
    createdAt: NOW - 1_000_000,
    ...overrides,
  }
}

/** A policy denying ALL egress. Decidable from the event TYPE alone. */
export function egressAllPolicy(overrides: Partial<PolicyDefinition> = {}): PolicyDefinition {
  return {
    policyId: 'policy_2',
    orgId: 'org_1',
    name: 'no network',
    revision: 1,
    rule: { kind: 'egress_denied' },
    subject: { appliesTo: 'environment', environment: 'production' },
    rationale: 'this agent class has no legitimate reason to reach the network',
    enabled: true,
    createdAt: NOW - 1_000_000,
    ...overrides,
  }
}

export function violationProof(overrides: Partial<PolicyViolationProof> = {}): PolicyViolationProof {
  return {
    proves: 'forbidden_operation_recorded',
    citedEvent: {
      runId: 'run_1',
      eventId: 'evt_9',
      sequenceNumber: 12,
      eventType: 'tool.call',
      recordedAt: NOW - 5_000,
    },
    observedValue: 'shell.exec',
    decidedBy: 'inline_payload',
    recordedFact: 'run_1 recorded a tool.call to shell.exec at sequence 12',
    ...overrides,
  }
}

/** A VALID coverage proof — five literals plus a declaration that covers the rule. */
export function coverageProof(overrides: Partial<PolicyCoverageProof> = {}): PolicyCoverageProof {
  return {
    proves: 'complete_log_read_found_nothing',
    runId: 'run_1',
    forPolicyId: 'policy_1',
    logReadComplete: true,
    payloadsAllReadable: true,
    runIsTerminal: true,
    crossOrgRowsSkipped: 0,
    forbiddenOperationsFound: 0,
    instrumentation: declared(),
    eventsExamined: 240,
    scannedAt: NOW - 1_000,
    ...overrides,
  }
}

export function violated(overrides: Partial<PolicyViolated> = {}): PolicyViolated {
  return {
    outcome: 'violated',
    violatedPolicyId: 'policy_1',
    violatedPolicyRevision: 3,
    violatedRule: { kind: 'tool_denied', deniedTools: ['shell.exec'] },
    violatedInRunId: 'run_1',
    provenBy: [violationProof()],
    violationCount: 1,
    violationCountIsFloor: false,
    violatedBecause: 'run_1 called shell.exec, which policy_1 forbids',
    ...overrides,
  }
}

export function satisfied(overrides: Partial<PolicySatisfied> = {}): PolicySatisfied {
  return {
    outcome: 'satisfied',
    satisfiedPolicyId: 'policy_1',
    satisfiedPolicyRevision: 3,
    satisfiedInRunId: 'run_1',
    establishedBy: coverageProof(),
    satisfiedBecause: 'run_1 was read end to end and records no call to shell.exec',
    ...overrides,
  }
}

export function notEvaluable(overrides: Partial<PolicyNotEvaluable> = {}): PolicyNotEvaluable {
  return {
    outcome: 'not_evaluable',
    undecidedPolicyId: 'policy_1',
    undecidedPolicyRevision: 3,
    forRunId: 'run_1',
    kind: 'instrumentation_undeclared',
    notEvaluableBecause:
      'agent version agentver_1 has not declared complete tool-call recording, so absence in this log means nothing',
    wouldBeEvaluableBy: 'declare complete tool-call instrumentation on this agent version',
    ...overrides,
  }
}

export function scan(overrides: Partial<PolicyEvaluationScan> = {}): PolicyEvaluationScan {
  return {
    subject: { appliesTo: 'agent', agentId: 'agent_7' },
    policiesInScope: 1,
    policiesEvaluated: 1,
    runsInScope: 1,
    runsRead: 1,
    evaluationTruncated: false,
    retentionHorizon: null,
    orderingCaveat: false,
    ...overrides,
  }
}

/** An evaluation. Defaults to the ALL-CLEAR shape, so every test below breaks exactly one thing. */
export function evaluation(overrides: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
  const outcomes: readonly PolicyOutcome[] = overrides.outcomes ?? [satisfied()]
  return {
    evaluatedAt: NOW - 1_000,
    outcomes,
    scan: overrides.scan ?? scan(),
    ...overrides,
  }
}

export function policySnapshot(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  const policies = overrides.policies ?? [toolPolicy()]
  return {
    evaluatedAt: NOW - 1_000,
    shelfLifeMs: 60_000,
    subject: { appliesTo: 'agent', agentId: 'agent_7' },
    policies,
    policiesInScope: overrides.policiesInScope ?? policies.length,
    listingTruncated: false,
    ...overrides,
  }
}
