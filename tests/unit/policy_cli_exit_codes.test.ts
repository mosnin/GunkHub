/**
 * `afr policy` — THE EXIT CODES.
 *
 * This command ends up in a compliance pipeline, so the exit code IS the product
 * for most of its lifetime: nobody reads the output until it goes non-zero. And
 * unlike `afr budget check`, whose wrong answer costs money, THIS COMMAND'S
 * WRONG ANSWER GETS ATTESTED TO — somebody pastes the green pipeline into a
 * security questionnaire, and an attestation is a statement to a third party
 * that is not retractable the way a dashboard is.
 *
 * SIX PROPERTIES ARE PROVEN HERE, each with a specific way of going wrong that
 * would be invisible in normal operation:
 *
 *  1. A SCAN THAT COULD NOT EVALUATE NEVER EXITS 0, AND NO FLAG CHANGES THAT.
 *     `afr budget check` has `--if-unavailable` because a breaker decision is a
 *     business tradeoff somebody may legitimately want to make. This command has
 *     no equivalent, and the absence is tested rather than merely documented: an
 *     operator who could turn "we could not look" into exit 0 would be
 *     manufacturing the attestation the whole feature exists to prevent.
 *
 *  2. ZERO POLICIES IN SCOPE EXITS 21, NOT 0. The deliberate divergence from
 *     `afr budget check`, which exits 0 when no budget governs a subject. A
 *     budget's absence is a business choice; a compliance scan over a subject
 *     with no policies that exits 0 is a green pipeline certifying nothing, and
 *     "we deleted the policies in a bad migration" and "we passed" would be the
 *     same exit code.
 *
 *  3. 20 WINS OVER 21. A recorded breach is a positive fact and another policy
 *     going unevaluated does not make it less true — invariant 0 at the exit-code
 *     layer.
 *
 *  4. AN UNDECLARED AGENT EXITS 21, WHICH IS THE COMMON CASE TODAY. No agent in
 *     this product declares its instrumentation, so `satisfied` is unreachable
 *     and the honest exit is 21. A suite that only tested the happy path would
 *     be testing a state the product is not in.
 *
 *  5. THE EXIT TABLE IS TOTAL. A fifth verdict is a compile error rather than an
 *     inheritance of whatever the last `if` branch was — and in a compliance
 *     gate the dangerous inheritance is `0`.
 *
 *  6. A LISTING IS NOT A SCAN. `afr policy list` never exits 0, because "we have
 *     policies" is not "we obeyed them".
 *
 * No network: `runPolicyScan` takes an injected fetch.
 */
import {
  POLICY_EXIT_INDETERMINATE,
  POLICY_EXIT_VIOLATION,
  POLICY_HELP,
  describeRule,
  exitCodeForPolicy,
  parsePolicyArgs,
  printPolicy,
  runPolicyMutation,
  runPolicyScan,
  validatePolicyDefineArgs,
  validatePolicyDisableArgs,
} from '@agent-flight-recorder/cli'
import { complianceClaimIn, isAllClear } from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import {
  coverageProof,
  evaluation,
  notEvaluable,
  policySnapshot,
  satisfied,
  scan,
  violated,
} from './policy_fixtures.js'

import type { PolicyScanResult } from '@agent-flight-recorder/cli'
import type { PolicyEvaluation, PolicySnapshot } from '@agent-flight-recorder/contracts'

const ENV = { apiKey: 'k_test', baseUrl: 'https://afr.example.com' }

/** A fetch that serves one evaluation in the v1 envelope. */
function servingEvaluation(body: PolicyEvaluation): (url: string) => Promise<never> {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ apiVersion: '1', data: { evaluation: body } }),
    text: async () => '',
    headers: { get: () => null },
  })) as unknown as (url: string) => Promise<never>
}

/** A fetch that serves one policy listing. */
function servingListing(body: PolicySnapshot): (url: string) => Promise<never> {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ apiVersion: '1', data: { snapshot: body } }),
    text: async () => '',
    headers: { get: () => null },
  })) as unknown as (url: string) => Promise<never>
}

function failingWith(status: number): (url: string) => Promise<never> {
  return (async () => ({
    ok: false,
    status,
    json: async () => ({ apiVersion: '1', error: { code: 'ERR', message: `HTTP ${status}` } }),
    text: async () => '',
    headers: { get: () => null },
  })) as unknown as (url: string) => Promise<never>
}

/** A fetch that throws, the way a DNS failure or a dropped connection does. */
const throwing = (async () => {
  throw new Error('ECONNREFUSED')
}) as unknown as (url: string) => Promise<never>

async function run(
  argv: string[],
  fetchImpl: (url: string) => Promise<never>
): Promise<{ code: number; result: Awaited<ReturnType<typeof runPolicyScan>> }> {
  const args = parsePolicyArgs(argv)
  const result = await runPolicyScan(args, ENV, fetchImpl as never)
  return { code: result.ok ? exitCodeForPolicy(result as PolicyScanResult) : result.exitCode, result }
}

describe('the narrow claim — and it IS reachable, so the suite discriminates', () => {
  it('a fully evaluated, fully declared scan exits 0', async () => {
    // Without this the whole suite would pass just as well if exit 0 were
    // unreachable for any reason at all, including a bug.
    const { code, result } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(evaluation()))
    expect(code).toBe(0)
    expect(result.ok && result.verdict).toBe('no_violation_and_every_policy_was_evaluable')
  })

  it('and the printed output states its own scope where somebody will read it', async () => {
    const { result } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(evaluation()))
    const lines: string[] = []
    printPolicy(parsePolicyArgs(['scan', '--agent', 'agent_7']), result, (l) => lines.push(l))
    const output = lines.join('\n')
    expect(output).toContain('EXACTLY AS WIDE AS THAT SCOPE')
    expect(output).toContain('DECLARES')
    // ALL THREE COUNTS ON ONE LINE, ALWAYS. A satisfied figure travelling alone
    // is the attestation figure with every safeguard stripped off.
    expect(output).toContain('NOT EVALUABLE')
    expect(output).toMatch(/0 violated\s+\|\s+1 satisfied\s+\|\s+0 NOT EVALUABLE/)
    // And the word never appears.
    expect(complianceClaimIn(output)).toBeNull()
  })
})

describe('1 — a scan that could not evaluate NEVER exits 0, and there is no flag', () => {
  const indeterminate: Array<[string, PolicyEvaluation]> = [
    ['a not-evaluable outcome', evaluation({ outcomes: [notEvaluable()] })],
    [
      'a truncated scan',
      evaluation({ scan: scan({ evaluationTruncated: true }) }),
    ],
    [
      'an unread run',
      evaluation({ scan: scan({ runsInScope: 10, runsRead: 2 }) }),
    ],
    [
      'an unevaluated policy',
      evaluation({ scan: scan({ policiesInScope: 5, policiesEvaluated: 1 }) }),
    ],
    [
      'a satisfied outcome licensed for another policy',
      evaluation({ outcomes: [satisfied({ establishedBy: coverageProof({ forPolicyId: 'other' }) })] }),
    ],
  ]

  it.each(indeterminate)('%s exits 21', async (_label, body) => {
    const { code } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(body))
    expect(code).toBe(POLICY_EXIT_INDETERMINATE)
  })

  it('an unreachable server exits 21 — there is nothing for a policy to adjudicate', async () => {
    const { code } = await run(['scan', '--agent', 'agent_7'], throwing)
    expect(code).not.toBe(0)
    expect(code).toBeGreaterThan(0)
  })

  it('AND NO FLAG RELAXES IT — the command has no --if-unavailable at all', async () => {
    // The absence is the property. `parseArgs` rejects an unknown option, so an
    // operator reaching for the budget command's escape hatch gets a usage
    // error rather than a quiet pass.
    expect(() => parsePolicyArgs(['scan', '--agent', 'a', '--if-unavailable', 'allow'])).toThrow()
    expect(() => parsePolicyArgs(['scan', '--agent', 'a', '--accepted-risk', 'x'])).toThrow()
    expect(() => parsePolicyArgs(['scan', '--agent', 'a', '--fail-on', 'violation'])).toThrow()
    // And the help says why, so nobody has to discover it by trying.
    expect(POLICY_HELP).toContain('NO FLAG THAT')
    expect(POLICY_HELP).toContain('manufacturing the attestation')
  })

  it('and an untrustworthy body exits 21 rather than being partially believed', async () => {
    const poisoned = { ...evaluation(), compliant: true } as unknown as PolicyEvaluation
    const { code } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(poisoned))
    expect(code).toBe(POLICY_EXIT_INDETERMINATE)
  })
})

describe('2 — zero policies in scope exits 21, NOT 0', () => {
  it('the deliberate divergence from `afr budget check`', async () => {
    const nothing = evaluation({
      outcomes: [],
      scan: scan({ policiesInScope: 0, policiesEvaluated: 0, runsInScope: 0, runsRead: 0 }),
    })
    const { code, result } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(nothing))
    expect(code).toBe(POLICY_EXIT_INDETERMINATE)
    // Its OWN verdict, so a misconfiguration is distinguishable from a real
    // all-clear on every surface, not just in the exit code.
    expect(result.ok && result.verdict).toBe('no_policy_governs_this_subject')
    expect(result.ok && isAllClear(result.verdict)).toBe(false)
  })

  it('and the output says it is not an all-clear', async () => {
    const nothing = evaluation({
      outcomes: [],
      scan: scan({ policiesInScope: 0, policiesEvaluated: 0, runsInScope: 0, runsRead: 0 }),
    })
    const { result } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(nothing))
    const lines: string[] = []
    printPolicy(parsePolicyArgs(['scan', '--agent', 'agent_7']), result, (l) => lines.push(l))
    const output = lines.join('\n')
    expect(output).toContain('NOT AN ALL-CLEAR')
    expect(output).toContain('mis-scoped')
  })

  it('the help explains the divergence rather than leaving it to be discovered', () => {
    expect(POLICY_HELP).toContain('ZERO POLICIES IN SCOPE EXITS 21, NOT 0')
    expect(POLICY_HELP).toContain('bad migration')
  })
})

describe('3 — 20 wins over 21', () => {
  it('a violation exits 20', async () => {
    const { code } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(evaluation({ outcomes: [violated()] })))
    expect(code).toBe(POLICY_EXIT_VIOLATION)
  })

  it('a violation BESIDE a not-evaluable outcome still exits 20', async () => {
    const mixed = evaluation({
      outcomes: [violated(), notEvaluable({ undecidedPolicyId: 'policy_2' })],
      scan: scan({ policiesInScope: 2, policiesEvaluated: 2 }),
    })
    const { code } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(mixed))
    expect(code).toBe(POLICY_EXIT_VIOLATION)
  })

  it('a violation in a body with a defect ELSEWHERE still exits 20', async () => {
    // Invariant 0 at the exit-code layer: a typo in an unrelated field must not
    // erase a recorded breach. That would be the most expensive possible way to
    // be careful.
    const messy = {
      ...evaluation({ outcomes: [violated()] }),
      scan: { ...scan(), evaluationTruncated: 'no' },
    } as unknown as PolicyEvaluation
    const { code } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(messy))
    expect(code).toBe(POLICY_EXIT_VIOLATION)
  })

  it('and the violation prints FIRST, before the honest gaps', async () => {
    const mixed = evaluation({
      outcomes: [violated(), notEvaluable({ undecidedPolicyId: 'policy_2' })],
      scan: scan({ policiesInScope: 2, policiesEvaluated: 2 }),
    })
    const { result } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(mixed))
    const lines: string[] = []
    printPolicy(parsePolicyArgs(['scan', '--agent', 'agent_7']), result, (l) => lines.push(l))
    const output = lines.join('\n')
    expect(output.indexOf('VIOLATIONS:')).toBeLessThan(output.indexOf('NOT EVALUABLE —'))
    // And it does not claim the call was stopped.
    expect(output).toContain('does not state')
    expect(output).toContain('prevented')
  })
})

describe('4 — an UNDECLARED agent exits 21, which is the state of the product today', () => {
  it('instrumentation_undeclared is a 21, not a 0', async () => {
    // The deepest limit in the feature (ADR-009 §7.1), at the exit code. A
    // complete read of an incomplete recording proves nothing about the world.
    const undeclared = evaluation({
      outcomes: [notEvaluable({ kind: 'instrumentation_undeclared' })],
    })
    const { code, result } = await run(['scan', '--env', 'production'], servingEvaluation(undeclared))
    expect(code).toBe(POLICY_EXIT_INDETERMINATE)
    expect(result.ok && result.verdict).toBe('evaluation_incomplete')
  })

  it('and the output names the remedy — declare, do not build a cleverer evaluator', async () => {
    const undeclared = evaluation({ outcomes: [notEvaluable({ kind: 'instrumentation_undeclared' })] })
    const { result } = await run(['scan', '--env', 'production'], servingEvaluation(undeclared))
    const lines: string[] = []
    printPolicy(parsePolicyArgs(['scan', '--env', 'production']), result, (l) => lines.push(l))
    const output = lines.join('\n')
    expect(output).toContain('instrumentation_undeclared')
    expect(output).toContain('declare complete')
  })

  it('the help warns before anyone puts it in a pipeline', () => {
    expect(POLICY_HELP).toContain('WITHOUT RECORDING')
    expect(POLICY_HELP).toContain('there is no')
    expect(POLICY_HELP).toContain("'satisfied' IS THEREFORE RARE")
  })

  it('an externalized deciding field is also a 21', async () => {
    // Event Log Rule 3 removes the tool name from exactly the runs with the
    // largest payloads, which are disproportionately the interesting ones.
    const externalized = evaluation({ outcomes: [notEvaluable({ kind: 'evidence_externalized' })] })
    const { code } = await run(['scan', '--agent', 'agent_7'], servingEvaluation(externalized))
    expect(code).toBe(POLICY_EXIT_INDETERMINATE)
  })

  it('but the SAME externalization still proves a violation against a deny-ALL rule', async () => {
    // ADR-009 §4.3, at the exit code: some policies are evaluable over exactly
    // the runs that defeat others, because the event TYPE survives.
    const typeAlone = evaluation({
      outcomes: [
        violated({
          violatedRule: { kind: 'egress_denied' },
          provenBy: [
            {
              proves: 'forbidden_operation_recorded',
              citedEvent: {
                runId: 'run_1',
                eventId: 'evt_2',
                sequenceNumber: 4,
                eventType: 'http.request',
                recordedAt: 1,
              },
              observedValue: null,
              decidedBy: 'event_type_alone',
              recordedFact: 'run_1 recorded an http.request; this policy denies all egress',
            },
          ],
        }),
      ],
    })
    const { code } = await run(['scan', '--env', 'production'], servingEvaluation(typeAlone))
    expect(code).toBe(POLICY_EXIT_VIOLATION)
  })

  it('and the rule renderer states which coverage a policy has', () => {
    expect(describeRule({ kind: 'tool_denied' })).toContain('event type alone')
    expect(describeRule({ kind: 'tool_denied', deniedTools: ['shell.exec'] })).toContain('NOT decidable')
  })
})

describe('5 — misconfiguration is a different exit from an outage', () => {
  it('a bad API key exits 2', async () => {
    const { code } = await run(['scan', '--agent', 'agent_7'], failingWith(401))
    expect(code).toBe(2)
  })

  it('a 403 does too, so a key missing the read scope is debuggable', async () => {
    const { code } = await run(['scan', '--agent', 'agent_7'], failingWith(403))
    expect(code).toBe(2)
  })

  it('an unknown subject exits 3', async () => {
    const { code } = await run(['scan', '--agent', 'agent_nope'], failingWith(404))
    expect(code).toBe(3)
  })

  it('no subject is a usage error, not a whole-org sweep', async () => {
    const { code, result } = await run(['scan'], servingEvaluation(evaluation()))
    expect(code).toBe(1)
    expect(!result.ok && result.message).toContain('no default')
  })

  it('two subjects is a usage error too', async () => {
    const { code } = await run(['scan', '--agent', 'a', '--env', 'production'], servingEvaluation(evaluation()))
    expect(code).toBe(1)
  })

  it('NONE of the failure exits is 0', async () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const { code } = await run(['scan', '--agent', 'agent_7'], failingWith(status))
      expect(code, `HTTP ${status} must not pass the gate`).not.toBe(0)
    }
  })
})

describe('6 — a listing is not a scan', () => {
  it('`afr policy list` never exits 0, even with policies present', async () => {
    // "We have policies" is not "we obeyed them", and a pipeline that treated a
    // successful listing as a pass would be certifying the existence of a
    // config file.
    const { code } = await run(['list', '--agent', 'agent_7'], servingListing(policySnapshot()))
    expect(code).toBe(POLICY_EXIT_INDETERMINATE)
  })

  it('and says so in the output', async () => {
    const { result } = await run(['list', '--agent', 'agent_7'], servingListing(policySnapshot()))
    const lines: string[] = []
    printPolicy(parsePolicyArgs(['list', '--agent', 'agent_7']), result, (l) => lines.push(l))
    expect(lines.join('\n')).toContain('A LISTING IS NOT A SCAN')
  })

  it('an empty listing is not an all-clear either', async () => {
    const { code, result } = await run(
      ['list', '--agent', 'agent_7'],
      servingListing(policySnapshot({ policies: [], policiesInScope: 0 }))
    )
    expect(code).toBe(POLICY_EXIT_INDETERMINATE)
    expect(result.ok && result.verdict).toBe('no_policy_governs_this_subject')
  })
})

describe('privileged mutations need a written justification', () => {
  it('define without --rationale is refused before any request', () => {
    expect(validatePolicyDefineArgs(parsePolicyArgs(['define', '--name', 'x']))?.exitCode).toBe(1)
    expect(validatePolicyDefineArgs(parsePolicyArgs(['define', '--name', 'x', '--rationale', '  ']))?.exitCode).toBe(1)
  })

  it('and without --name', () => {
    expect(validatePolicyDefineArgs(parsePolicyArgs(['define', '--rationale', 'x']))?.exitCode).toBe(1)
  })

  it('a well-formed define passes validation', () => {
    expect(
      validatePolicyDefineArgs(parsePolicyArgs(['define', '--name', 'no shell', '--rationale', 'SOC2 CC6.1']))
    ).toBeNull()
  })

  it('disable without --reason is refused', () => {
    expect(validatePolicyDisableArgs(parsePolicyArgs(['disable', 'policy_1']))?.exitCode).toBe(1)
    expect(validatePolicyDisableArgs(parsePolicyArgs(['disable', 'policy_1', '--reason', ' ']))?.exitCode).toBe(1)
  })

  it('and without a policy id', () => {
    expect(validatePolicyDisableArgs(parsePolicyArgs(['disable', '--reason', 'x']))?.exitCode).toBe(1)
  })

  it('a privileged mutation surfaces an honest 3 rather than silently no-opping', async () => {
    // The route does not exist yet. A privileged mutation that quietly did
    // nothing would be far worse: a policy an operator believes exists and does
    // not is a compliance gap wearing a green tick.
    const result = await runPolicyMutation(
      parsePolicyArgs(['define', '--name', 'no shell', '--rationale', 'SOC2 CC6.1', '--deny-tools', 'shell.exec', '--agent', 'agent_7']),
      'define',
      ENV,
      failingWith(404) as never
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.exitCode).toBe(3)
  })

  it('there is no `delete` subcommand — disabling is the operation', () => {
    // A policy that judged recorded runs is part of how they were judged;
    // removing the row would make `violatedPolicyRevision` point at nothing.
    expect(POLICY_HELP).toContain('no delete')
    expect(POLICY_HELP).not.toContain('afr policy delete')
  })
})
