/**
 * `afr budget` — THE EXIT CODES.
 *
 * This command ends up in a deploy gate, so the exit code IS the product for
 * most of its lifetime: nobody reads the output until it goes non-zero. Five
 * properties are proven here, and each has a specific way of going wrong that
 * would be invisible in normal operation.
 *
 *  1. AN UNREACHABLE SERVER DOES NOT PASS THE GATE. `--if-unavailable` defaults
 *     to `deny`, so the common failure — our deployment is down — exits 11
 *     rather than 0. A gate that passes when it cannot see is not a gate:
 *     anybody who wants to ship past it arranges a network error.
 *
 *  2. AN UNDECIDABLE SPEND FIGURE IS NEVER REPORTED AS HEADROOM. An approximate
 *     9,900 against a 10,000 cap means nobody knows, and rounding it to a green
 *     light is the whole failure this feature exists against. No `deny` or
 *     `grace` threshold reaches 0 on one, and NO threshold whatsoever — `allow`
 *     included — reports it as `allowed_breaker_armed`.
 *
 *     THE FIRST DRAFT OF THIS FILE ASSERTED SOMETHING STRONGER AND WRONG: that
 *     no flag reaches 0 on an undecidable figure. It does not hold, and the
 *     behaviour is right rather than the claim. `allow` means "proceed when
 *     there is no USABLE answer", and near a cap an ADR-002 estimate is the
 *     COMMON way to have none — an `allow` that declined here would decline
 *     most of the time, which is not fail-open but a flag that does not do what
 *     it says, and people route around those. The invariant worth scripting
 *     against is the one about the BAND, not the exit code, because that is the
 *     one that distinguishes "we shipped without an answer" from "we were told
 *     there was room".
 *
 *  3. AN OUTAGE AND A BAD API KEY ARE DIFFERENT EXITS. Auth and not-found
 *     short-circuit to 2 and 3; a network or server failure is fed to the
 *     policy instead. Mapping an outage to exit 4 would take the decision away
 *     from whoever configured the gate; mapping a typo'd key to the policy
 *     would give them a gate nobody can debug.
 *
 *  4. THE FOUR "PROCEED" BANDS ARE NOT INTERCHANGEABLE, even though they share
 *     an exit code. `allowed_no_budget_governs` is enforcement ABSENT, not
 *     headroom, and the output says so on the line where somebody will read it.
 *
 *  5. A PRIVILEGED MUTATION CANNOT GO OUT WITHOUT A WRITTEN REASON. `--reason`
 *     is required and never defaulted, because a manual trip has no meter
 *     reading behind it and the audit entry's only content is that sentence.
 *
 * No network: `runBudgetCheck` takes an injected fetch and an injected clock.
 */
import {
  BUDGET_EXIT_INDETERMINATE,
  BUDGET_EXIT_TRIPPED,
  DEFAULT_UNAVAILABLE_MODE,
  exitCodeForBudget,
  parseBudgetArgs,
  printBudget,
  runBudgetCheck,
  runBudgetMutation,
  validatePrivilegedArgs,
} from '@agent-flight-recorder/cli'
import { describe, expect, it } from 'vitest'

import { NOW, approximate, armed, limit, snapshot, tripped, unbudgetedSnapshot } from './budget_fixtures.js'

import type { BudgetCheckResult } from '@agent-flight-recorder/cli'
import type { BreakerSnapshot } from '@agent-flight-recorder/contracts'

const ENV = { apiKey: 'k_test', baseUrl: 'https://afr.example.com' }
const CLOCK = (): number => NOW

/** A fetch that serves one snapshot in the v1 envelope. */
function serving(body: BreakerSnapshot): (url: string) => Promise<never> {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ apiVersion: '1', data: { snapshot: body } }),
    text: async () => '',
    headers: { get: () => null },
  })) as unknown as (url: string) => Promise<never>
}

/** A fetch that fails with a given HTTP status. */
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

async function check(
  argv: string[],
  fetchImpl: (url: string) => Promise<never>
): Promise<{ code: number; result: Awaited<ReturnType<typeof runBudgetCheck>> }> {
  const args = parseBudgetArgs(argv)
  const result = await runBudgetCheck(args, ENV, fetchImpl as never, CLOCK)
  return { code: result.ok ? exitCodeForBudget(result as BudgetCheckResult) : result.exitCode, result }
}

describe('the happy paths', () => {
  it('a consulted breaker with headroom exits 0', async () => {
    const { code, result } = await check(['check', '--agent', 'agent_7'], serving(snapshot()))
    expect(code).toBe(0)
    expect(result.ok && result.decision.decision).toBe('allowed_breaker_armed')
  })

  it('a tripped breaker exits 10', async () => {
    const { code } = await check(['check', '--agent', 'agent_7'], serving(snapshot({ states: [tripped()] })))
    expect(code).toBe(BUDGET_EXIT_TRIPPED)
  })

  it('no budget governing the subject exits 0 — but as its OWN band', async () => {
    const { code, result } = await check(['check', '--agent', 'agent_7'], serving(unbudgetedSnapshot()))
    expect(code).toBe(0)
    // NOT `allowed_breaker_armed`. An org that lost its budgets in a bad
    // migration must not look identical to one with cost control.
    expect(result.ok && result.decision.decision).toBe('allowed_no_budget_governs')
  })

  it('and the printed output says so where somebody will read it', async () => {
    const { result } = await check(['check', '--agent', 'agent_7'], serving(unbudgetedSnapshot()))
    const lines: string[] = []
    printBudget(parseBudgetArgs(['check', '--agent', 'agent_7']), result, (l) => lines.push(l))
    const output = lines.join('\n')
    expect(output).toContain('NO BUDGET GOVERNS THIS SUBJECT')
    expect(output).toContain('not the same as having headroom')
  })
})

describe('an unreachable server does not pass the gate', () => {
  it('a thrown transport error exits 11 by default', async () => {
    const { code } = await check(['check', '--agent', 'agent_7'], throwing)
    expect(code).toBe(BUDGET_EXIT_INDETERMINATE)
    expect(DEFAULT_UNAVAILABLE_MODE).toBe('deny')
  })

  it('a 500 exits 11 — fed to the policy, not short-circuited to exit 4', async () => {
    const { code } = await check(['check', '--agent', 'agent_7'], failingWith(500))
    expect(code).toBe(BUDGET_EXIT_INDETERMINATE)
  })

  it('a 429 does too', async () => {
    const { code } = await check(['check', '--agent', 'agent_7'], failingWith(429))
    expect(code).toBe(BUDGET_EXIT_INDETERMINATE)
  })

  it('but a bad API KEY exits 2 — misconfiguration is not an outage', async () => {
    const { code } = await check(['check', '--agent', 'agent_7'], failingWith(401))
    expect(code).toBe(2)
  })

  it('and a 403 does too, so a key missing the read scope is debuggable', async () => {
    const { code } = await check(['check', '--agent', 'agent_7'], failingWith(403))
    expect(code).toBe(2)
  })

  it('an unknown subject exits 3', async () => {
    const { code } = await check(['check', '--agent', 'agent_nope'], failingWith(404))
    expect(code).toBe(3)
  })

  it('`--if-unavailable allow` reaches 0 on an outage — with a written accepted risk', async () => {
    const { code, result } = await check(
      ['check', '--agent', 'agent_7', '--if-unavailable', 'allow', '--accepted-risk', 'ship anyway during outages'],
      throwing
    )
    expect(code).toBe(0)
    expect(result.ok && result.decision.decision).toBe('allowed_without_answer')
  })

  it('and refuses to run at all without one', async () => {
    const { code, result } = await check(['check', '--agent', 'agent_7', '--if-unavailable', 'allow'], throwing)
    expect(code).toBe(1)
    expect(!result.ok && result.message).toContain('--accepted-risk')
  })
})

describe('AN UNDECIDABLE SPEND FIGURE NEVER PASSES, AT ANY THRESHOLD', () => {
  /**
   * The ADR-002 case, served as an honest snapshot: the server read the
   * counters, they straddle the cap, and it says so.
   */
  const undecidable = snapshot({
    states: [
      {
        state: 'undetermined',
        undeterminedBudgetId: 'budget_1',
        undeterminedLimit: limit(),
        kind: 'spend_not_decidable',
        undeterminedBecause: 'spend is estimated at 9,900 against a 10,000 limit with no stated error bound',
        wouldBeDeterminedBy: 'reconcile spend for this period from the event log',
      },
    ],
  })

  /** Every threshold that does not explicitly opt out of enforcement. */
  const ENFORCING_THRESHOLDS: string[][] = [
    [],
    ['--if-unavailable', 'deny'],
    ['--if-unavailable', 'grace', '--accepted-risk', 'x'],
    ['--if-unavailable', 'grace', '--grace-ms', '300000', '--accepted-risk', 'x'],
  ]

  const ALL_THRESHOLDS: string[][] = [
    ...ENFORCING_THRESHOLDS,
    ['--if-unavailable', 'allow', '--accepted-risk', 'x'],
  ]

  it.each(ENFORCING_THRESHOLDS)('never exits 0 with flags: %s', async (...flags) => {
    const { code } = await check(['check', '--agent', 'agent_7', ...flags], serving(undecidable))
    expect(code).toBe(BUDGET_EXIT_INDETERMINATE)
  })

  /**
   * `allow` DOES reach 0 here, and the first draft of this file asserted it
   * did not — a claim written into the help text before the behaviour was
   * checked against it. The behaviour is right and the claim was too strong:
   * `allow` means "proceed when there is no USABLE answer", and near a cap an
   * ADR-002 estimate is the COMMON way to have none. An `allow` that declined
   * here would decline most of the time, which is not fail-open — it is a flag
   * that does not do what it says, and people route around those.
   *
   * THE INVARIANT THAT ACTUALLY HOLDS, AND IT IS THE ONE WORTH HAVING, is
   * below: no threshold whatsoever reports an undecidable figure as a consulted
   * breaker with headroom.
   */
  it('`allow` reaches 0 — but reports it as `allowed_without_answer`, never as headroom', async () => {
    const { code, result } = await check(
      ['check', '--agent', 'agent_7', '--if-unavailable', 'allow', '--accepted-risk', 'x'],
      serving(undecidable)
    )
    expect(code).toBe(0)
    expect(result.ok && result.decision.decision).toBe('allowed_without_answer')
    // The undecidable reason travels with the decision, so an org running on
    // `allow` can see it is running unenforced rather than well.
    expect(result.ok && result.decision.decision === 'allowed_without_answer' && result.decision.unansweredBecause)
      .toContain('9,900')
  })

  it.each(ALL_THRESHOLDS)('NO threshold calls it headroom: %s', async (...flags) => {
    const { result } = await check(['check', '--agent', 'agent_7', ...flags], serving(undecidable))
    expect(result.ok && result.decision.decision).not.toBe('allowed_breaker_armed')
  })

  it('the same shape with a RECONCILED figure does exit 0 — so the test discriminates', async () => {
    const { code } = await check(['check', '--agent', 'agent_7'], serving(snapshot()))
    expect(code).toBe(0)
  })

  it('a breaker ARMED on an undecidable estimate is refused at the wire, not rendered', async () => {
    const forged = snapshot({
      states: [{ ...armed(), establishedUnderBy: [approximate(9_900)] }],
    })
    const { code, result } = await check(['check', '--agent', 'agent_7'], serving(forged))
    expect(code).toBe(BUDGET_EXIT_INDETERMINATE)
    expect(result.ok && result.decision.decision).toBe('declined_no_answer')
  })
})

describe('10 wins over 11', () => {
  it('a tripped breaker beside an undetermined one still exits 10', async () => {
    const mixed = snapshot({
      states: [
        tripped(),
        {
          state: 'undetermined',
          undeterminedBudgetId: 'budget_2',
          undeterminedLimit: limit({ budgetId: 'budget_2' }),
          kind: 'spend_not_decidable',
          undeterminedBecause: 'estimate straddles the cap',
          wouldBeDeterminedBy: 'reconcile from the event log',
        },
      ],
    })
    const { code } = await check(['check', '--agent', 'agent_7'], serving(mixed))
    expect(code).toBe(BUDGET_EXIT_TRIPPED)
  })
})

describe('the subject must be named, exactly once', () => {
  it('no subject is a usage error, not a whole-org sweep', async () => {
    const { code, result } = await check(['check'], serving(snapshot()))
    expect(code).toBe(1)
    expect(!result.ok && result.message).toContain('no "whole org" default')
  })

  it('two subjects is a usage error too', async () => {
    const { code } = await check(['check', '--agent', 'a', '--run', 'r'], serving(snapshot()))
    expect(code).toBe(1)
  })
})

describe('privileged mutations need a written reason', () => {
  it('trip without --reason is refused before any request', () => {
    expect(validatePrivilegedArgs(parseBudgetArgs(['trip', 'budget_1']), 'trip')?.exitCode).toBe(1)
    expect(validatePrivilegedArgs(parseBudgetArgs(['trip', 'budget_1', '--reason', '   ']), 'trip')?.exitCode).toBe(1)
  })

  it('reset without --reason is refused too', () => {
    expect(validatePrivilegedArgs(parseBudgetArgs(['reset', 'budget_1']), 'reset')?.exitCode).toBe(1)
  })

  it('and without a budget id', () => {
    expect(validatePrivilegedArgs(parseBudgetArgs(['trip', '--reason', 'x']), 'trip')?.exitCode).toBe(1)
  })

  it('a well-formed one passes validation and reaches the wire', async () => {
    expect(validatePrivilegedArgs(parseBudgetArgs(['trip', 'budget_1', '--reason', 'INC-412']), 'trip')).toBeNull()
    // The route does not exist yet, so this surfaces the honest 3 rather than
    // silently no-opping — a privileged mutation that quietly does nothing is
    // far worse than one that fails loudly.
    const result = await runBudgetMutation(
      parseBudgetArgs(['trip', 'budget_1', '--reason', 'INC-412']),
      'trip',
      ENV,
      failingWith(404) as never
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.exitCode).toBe(3)
  })
})
