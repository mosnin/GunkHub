import { parseArgs } from 'node:util'

import {
  compareSpendToLimit,
  decideBudget,
  decisionStatement,
  isBreakerSnapshotComplete,
  mayProceed,
  MAX_BREAKER_GRACE_MS,
  spendStatement,
  snapshotRefusals,
} from '@agent-flight-recorder/sdk'

import { getBudgetSnapshot, resetBudget, tripBudget } from '../apiClient.js'
import { formatTimestamp, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type {
  BreakerSnapshot,
  BreakerState,
  BudgetDecision,
  BudgetMutationResult,
  BudgetUnavailablePolicy,
} from '@agent-flight-recorder/sdk'

export const BUDGET_HELP = `Usage: afr budget <subcommand> [options]

Budget circuit breakers — a limit on what an agent may spend that is a FACT
rather than a hope.

Subcommands:
  afr budget check           Ask the breakers governing a subject, and exit on
                             the answer. THIS IS THE DEPLOY GATE.
  afr budget list            Show every breaker governing a subject, with the
                             spend figure behind each one.
  afr budget trip <id>       Trip a breaker by hand. PRIVILEGED. --reason required.
  afr budget reset <id>      Clear a tripped breaker. PRIVILEGED. --reason required.

WHAT THIS COMMAND CAN AND CANNOT TELL YOU:

  "The breaker is tripped."   A fact about the BREAKER, established by the
                              server from spend it summed. We own it.
  "The CLI declined."         A fact about THIS PROCESS's exit code. We own it.
  "The agent was stopped."    NOT A FACT WE HAVE. This tool records and it
                              declines; it does not stop anyone's agents, and
                              nothing it prints will claim it did. If you need
                              "spend was capped" for an audit, this is not that
                              evidence and no flag makes it so.

EXACT AND APPROXIMATE SPEND ARE PRINTED DIFFERENTLY, AND THE DIFFERENCE MATTERS:

  RECONCILED    Summed from the immutable event log. Compare it to the limit
                directly.
  APPROXIMATE   From ADR-002's usage counters, which sample. NOT billing-grade,
                and it may be wrong IN EITHER DIRECTION. An approximate 9,900
                against a 10,000 cap does not mean you have room — it means
                NOBODY KNOWS, and this command says so rather than rounding it
                down. Every approximate figure prints its error bounds, and
                "unbounded" is one of the things a bound can be.

WHAT HAPPENS WHEN THE SERVER CANNOT BE REACHED — READ THIS BEFORE SCRIPTING IT:

  --if-unavailable decides, and it DEFAULTS TO deny. A gate that passes when it
  cannot reach the breaker is not a gate: anybody who wants to ship past it
  causes a network error, and "the check errored" is the easiest condition in
  computing to arrange. The other two arms exist and are honest choices:

    deny   (default) no answer, no pass. Exit 11.
    grace  honour a yes we ALREADY received, for --grace-ms past its expiry.
           Never invents one: a subject whose last answer was 'tripped', or who
           never got an answer, gets nothing from it.
    allow  no answer, pass anyway. Requires --accepted-risk, because you may
           weaken the breaker and you may not do it without a sentence somebody
           can find later. The decision is still reported as
           'allowed_without_answer' — never as headroom.

Options (check / list):
  --run <runId>             Subject: this run and everything above it
  --agent <agentId>         Subject: this agent
  --project <projectId>     Subject: this project
                            EXACTLY ONE subject is required. There is no "the
                            whole org" default: a gate whose subject is implicit
                            silently changes meaning the day someone adds an
                            org-wide budget.
  --if-unavailable <mode>   deny | grace | allow. Default: deny
  --grace-ms <n>            Grace window for --if-unavailable grace (max ${MAX_BREAKER_GRACE_MS})
  --accepted-risk <text>    Required for grace and allow. Echoed into the output.
  --json                    Print the raw snapshot and decision as JSON
  --help                    Show this message

Options (trip / reset):
  --reason <text>           REQUIRED. Written to the append-only admin audit log
                            server-side. A manual trip is the one kind that
                            arithmetic cannot justify, so the justification has
                            to be a human sentence somebody can read later.

EXIT CODES — READ THIS BEFORE PUTTING IT IN A DEPLOY GATE:
  0   proceed            — the breakers were consulted and there is headroom, OR
                           no budget governs this subject (which is NOT the same
                           thing, and the output says which), OR an expired yes
                           was honoured inside --if-unavailable grace.
  10  tripped            — a breaker governing this subject IS TRIPPED. The
                           deploy should not go out.
  11  cannot establish   — the breakers could not be consulted, or the spend
                           figure available cannot decide the question. NOT a
                           pass. This is the common exit when spend is close to
                           a cap and the only figure available is approximate,
                           and rounding it to 0 is precisely the bug this
                           command exists not to have.
  1   usage (bad flags, missing AFR_API_KEY/AFR_BASE_URL)
  2   auth (401/403)     3  not found (404)     4  network/rate-limit/server

  10 WINS OVER 11 WHEN BOTH APPLY. A tripped breaker is a fact we were given;
  another breaker's state being undecidable does not make it less true, and
  suppressing a trip because some other question went unanswered would silence
  the signal exactly when the picture is murkiest.

  NEITHER deny NOR grace EVER REACHES 0 ON AN UNDECIDABLE FIGURE, and that is
  the case to understand: ADR-002's counters are approximate, so "the breakers
  were read and the spend straddles the cap" is the COMMON answer near a limit,
  not an edge case. It exits 11, because it is a real reading of real data that
  does not support a conclusion.

  --if-unavailable allow DOES reach 0 on it, and that is deliberate rather than
  an oversight: 'allow' means "proceed when there is no USABLE answer", and an
  undecidable figure is not one. Making 'allow' decline here would mean it
  declined most of the time near a cap, which is not fail-open — it is a flag
  that does not do what it says, and people route around those. What 'allow'
  can never do is make it look like headroom: the decision is reported as
  'allowed_without_answer' and carries the undecidable reason verbatim, so an
  org running on 'allow' can see it is running unenforced.

  NO THRESHOLD REPORTS AN UNDECIDABLE FIGURE AS 'allowed_breaker_armed'. That
  is the invariant, and it is the one worth scripting against — rounding an
  approximate figure near a cap into a green light is the failure this feature
  was built against, and it is a different failure from an operator explicitly
  choosing to ship without an answer.

Scripting it:
  afr budget check --agent agent_7                       # deploy gate, fails closed
  afr budget check --run run_abc --if-unavailable grace --grace-ms 30000 \\
      --accepted-risk 'up to 30s of spend past cap during an AFR outage'
  afr budget list --agent agent_7                        # what governs this agent
  afr budget trip budget_9 --reason 'runaway retry loop, incident INC-412'
`

/** A breaker governing the subject is tripped. Above the 0-4 band so it can never collide with a transport failure. */
export const BUDGET_EXIT_TRIPPED = 10

/**
 * The breakers could not be consulted, or the spend figure cannot decide.
 *
 * NOT SUPPRESSIBLE. See {@link exitCodeForBudget} and this file's help text.
 */
export const BUDGET_EXIT_INDETERMINATE = 11

/** `--if-unavailable`, as an operator types it. */
export type BudgetUnavailableMode = 'deny' | 'grace' | 'allow'

const VALID_MODES: readonly BudgetUnavailableMode[] = ['deny', 'grace', 'allow']

/**
 * The default posture. FAIL CLOSED.
 *
 * A CLI default is a real choice, unlike the SDK's, where the policy is a
 * required argument with no default at all. The difference is deliberate: the
 * SDK is embedded in a customer's agent loop where the cost of failing closed
 * lands on their production traffic, so nobody should inherit that choice. This
 * command is a GATE, and a gate that passes when it cannot see is not a gate.
 */
export const DEFAULT_UNAVAILABLE_MODE: BudgetUnavailableMode = 'deny'

/** Default grace window when `--if-unavailable grace` is chosen without `--grace-ms`. */
export const DEFAULT_GRACE_MS = 30_000

export interface BudgetArgs {
  /** `check` | `list` | `trip` | `reset`. */
  subcommand?: string
  /** Budget id, for `trip`/`reset`. */
  budgetId?: string
  runId?: string
  agentId?: string
  projectId?: string
  /** Raw `--if-unavailable`, as typed. */
  ifUnavailable?: string
  graceMs?: number
  acceptedRisk?: string
  reason?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr budget` flags (argv AFTER `budget`). */
export function parseBudgetArgs(argv: string[]): BudgetArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      agent: { type: 'string' },
      project: { type: 'string' },
      'if-unavailable': { type: 'string' },
      'grace-ms': { type: 'string' },
      'accepted-risk': { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: BudgetArgs = {}
  if (positionals[0] !== undefined) result.subcommand = positionals[0]
  if (positionals[1] !== undefined) result.budgetId = positionals[1]
  if (values['run']) result.runId = values['run']
  if (values['agent']) result.agentId = values['agent']
  if (values['project']) result.projectId = values['project']
  if (values['if-unavailable']) result.ifUnavailable = values['if-unavailable']
  if (values['grace-ms']) result.graceMs = Number(values['grace-ms'])
  if (values['accepted-risk']) result.acceptedRisk = values['accepted-risk']
  if (values['reason']) result.reason = values['reason']
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

/**
 * Resolve the subject. EXACTLY ONE, and neither zero nor two is a usable
 * question.
 *
 * Zero would mean "the whole org", which changes meaning the day somebody adds
 * an org-wide budget. Two would mean the tool silently picks, and whichever it
 * picked would be the one somebody's gate was not asking about.
 */
function resolveSubject(args: BudgetArgs): { runId?: string; agentId?: string; projectId?: string } | CommandFailure {
  const named: { runId?: string; agentId?: string; projectId?: string }[] = []
  if (args.runId !== undefined) named.push({ runId: args.runId })
  if (args.agentId !== undefined) named.push({ agentId: args.agentId })
  if (args.projectId !== undefined) named.push({ projectId: args.projectId })

  if (named.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        'Name a subject: --run <runId>, --agent <agentId> or --project <projectId>. There is deliberately no ' +
        '"whole org" default — a gate whose subject is implicit silently changes meaning the day someone adds an ' +
        'org-wide budget, and it changes it in the direction that stops deploys.',
    }
  }
  if (named.length > 1) {
    return {
      ok: false,
      exitCode: 1,
      message: 'Name exactly one subject (--run, --agent or --project) — not several. Run the command once each.',
    }
  }
  return named[0] as { runId?: string; agentId?: string; projectId?: string }
}

/**
 * Build the explicit unavailability policy from flags.
 *
 * The two permissive arms REQUIRE `--accepted-risk`, mirroring the SDK's
 * constructor. Weakening a breaker is legitimate; doing it without a sentence
 * somebody can find later is not.
 */
function resolvePolicy(args: BudgetArgs): BudgetUnavailablePolicy | CommandFailure {
  const raw = args.ifUnavailable ?? DEFAULT_UNAVAILABLE_MODE
  if (!(VALID_MODES as readonly string[]).includes(raw)) {
    return {
      ok: false,
      exitCode: 1,
      message: `--if-unavailable must be one of ${VALID_MODES.join(', ')} — got "${raw}".`,
    }
  }
  const mode = raw as BudgetUnavailableMode
  if (mode === 'deny') return { onUnavailable: 'deny' }

  const acceptedRisk = args.acceptedRisk
  if (acceptedRisk === undefined || acceptedRisk.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        `--if-unavailable ${mode} requires --accepted-risk "<what you are accepting>". You may weaken the ` +
        `breaker; you may not do it without a sentence somebody can find later. Example: --accepted-risk ` +
        `'up to 30s of spend past the cap during an AFR outage'.`,
    }
  }
  if (mode === 'allow') return { onUnavailable: 'allow', acceptedRisk }

  const graceMs = args.graceMs ?? DEFAULT_GRACE_MS
  if (!Number.isInteger(graceMs) || graceMs <= 0) {
    return { ok: false, exitCode: 1, message: `--grace-ms must be a positive integer — got "${args.graceMs}".` }
  }
  if (graceMs > MAX_BREAKER_GRACE_MS) {
    return {
      ok: false,
      exitCode: 1,
      message:
        `--grace-ms ${graceMs} exceeds the ceiling (${MAX_BREAKER_GRACE_MS}). Beyond that window you are not ` +
        `riding out a brief outage, you are failing open on a timer — which is a legitimate choice, but it is ` +
        `--if-unavailable allow and should say so.`,
    }
  }
  return { onUnavailable: 'grace', graceMs, acceptedRisk }
}

/** A successful breaker read. */
export interface BudgetCheckResult {
  ok: true
  subcommand: 'check' | 'list'
  policy: BudgetUnavailablePolicy
  /** `null` when the server could not be reached and the policy tolerated it. */
  snapshot: BreakerSnapshot | null
  /** THE decision, from contracts' single rule — never re-derived here. */
  decision: BudgetDecision
}

export type BudgetCommandResult = BudgetCheckResult | CommandFailure

/**
 * `afr budget check` / `afr budget list` — ask the breakers governing a subject.
 *
 * ONE REQUEST. The whole governing set comes back together, because an agent
 * under an org cap, a project cap and a per-run cap should not pay three round
 * trips to find out it is fine.
 *
 * A TRANSPORT FAILURE IS NOT AN ERROR HERE, IT IS AN INPUT. Unlike every other
 * read command in this CLI, a failure to reach the server does not short-circuit
 * to exit 4 — it feeds `decideBudget` as "no answer", and the caller's own
 * `--if-unavailable` policy decides what that means. Mapping it to exit 4 would
 * make an outage indistinguishable from a bad API key, and would take the
 * decision away from the person who configured the gate. Auth and not-found
 * failures still short-circuit: those are not outages, they are misconfiguration,
 * and a gate that fails closed on a typo'd key is a gate nobody can debug.
 *
 * @param args - parsed flags.
 * @param env - CLI environment (injectable for tests).
 * @param fetchImpl - injectable fetch (tests never touch the network).
 * @param now - injectable clock, so freshness and grace are testable without sleeping.
 */
export async function runBudgetCheck(
  args: BudgetArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike,
  now: () => number = Date.now
): Promise<BudgetCommandResult> {
  const subject = resolveSubject(args)
  if (isCommandFailure(subject)) return subject

  const policy = resolvePolicy(args)
  if (isCommandFailure(policy)) return policy

  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  const subcommand = args.subcommand === 'list' ? 'list' : 'check'

  let snapshot: BreakerSnapshot | null = null
  let unavailableBecause: string | undefined
  // Stamped from the clock THIS process controls, at the moment the body
  // arrives — the honouring ceiling is anchored on it rather than on the
  // server's `evaluatedAt`, which a server clock an hour fast would otherwise
  // turn into an hour of extra permission.
  let receivedAt = now()
  try {
    const data = await getBudgetSnapshot(config, subject, fetchImpl)
    receivedAt = now()
    snapshot = data.snapshot
    // Belt and braces: `FlightReader` already refused anything untrustworthy,
    // but the guard's own refusal list is the shared definition and running it
    // here keeps the CLI and the SDK from drifting on what is safe to enforce on.
    const refusals = snapshotRefusals(data.snapshot)
    if (refusals.length > 0) {
      snapshot = null
      unavailableBecause = `the snapshot was refused: ${refusals.join('; ')}`
    }
  } catch (err) {
    const failure = toCommandFailure(err)
    // Auth (2) and not-found (3) are misconfiguration, not unavailability.
    if (failure.exitCode === 2 || failure.exitCode === 3 || failure.exitCode === 1) return failure
    unavailableBecause = failure.message
  }

  const decision = decideBudget({
    snapshot,
    ...(unavailableBecause !== undefined && { unavailableBecause }),
    receivedAt,
    now: now(),
    policy,
  })
  return { ok: true, subcommand, policy, snapshot, decision }
}

/**
 * Process exit code for a completed breaker read.
 *
 * COMPUTED FROM THE DECISION'S BAND, NOT FROM A STRING THE SERVER HANDED US,
 * and the decision itself comes from contracts' single `decideBudget` rule. A
 * locally-invented gate is a locally-invented all-clear.
 *
 * Precedence:
 *  1. `declined_breaker_tripped` -> 10. A trip is a fact we were given, and it
 *     stays true whatever else went unread.
 *  2. Any other decline -> 11. "We could not establish" is not a pass, and
 *     there is no flag that makes it one.
 *  3. Otherwise 0 — but note that THREE different bands reach 0 and they mean
 *     different things ({@link printBudget} prints which).
 */
export function exitCodeForBudget(result: BudgetCheckResult): number {
  if (result.decision.decision === 'declined_breaker_tripped') return BUDGET_EXIT_TRIPPED
  if (!mayProceed(result.decision)) return BUDGET_EXIT_INDETERMINATE
  return 0
}

// ---------------------------------------------------------------------------
// Rendering — the decision first, then the evidence, then the honest gaps
// ---------------------------------------------------------------------------

/** Render one breaker state with the spend figure behind it. */
function renderState(state: BreakerState, log: (line: string) => void): void {
  if (state.state === 'tripped') {
    log(`  TRIPPED    ${truncateId(state.trippedBudgetId).padEnd(16)} ${state.trippedLimit.meter} ` +
      `limit ${state.trippedLimit.limitAmount} / ${state.trippedLimit.period}`)
    log(`      tripped ${formatTimestamp(state.trippedAt)} by ${state.trippedBy}: ${state.trippedBecause}`)
    for (const figure of state.determinedFrom) {
      log(`      ${spendStatement(figure, state.trippedLimit)}`)
    }
    return
  }
  if (state.state === 'armed') {
    log(`  ARMED      ${truncateId(state.armedBudgetId).padEnd(16)} ${state.armedLimit.meter} ` +
      `limit ${state.armedLimit.limitAmount} / ${state.armedLimit.period}`)
    for (const figure of state.establishedUnderBy) {
      log(`      ${spendStatement(figure, state.armedLimit)}  [${compareSpendToLimit(figure, state.armedLimit)}]`)
    }
    return
  }
  // UNDETERMINED. Printed in its own register — never as a quiet variant of
  // ARMED, because "we could not tell" rendered as "there is room" is the one
  // failure this feature exists to prevent.
  log(`  UNDETERMINED ${truncateId(state.undeterminedBudgetId).padEnd(14)} ${state.undeterminedLimit.meter} ` +
    `limit ${state.undeterminedLimit.limitAmount} / ${state.undeterminedLimit.period}`)
  log(`      [${state.kind}] could not establish: ${state.undeterminedBecause}`)
  log(`      to decide it: ${state.wouldBeDeterminedBy}`)
}

/** Print a budget check/list result. `--json` prints the raw snapshot and decision and nothing else. */
export function printBudget(
  args: BudgetArgs,
  result: BudgetCommandResult,
  log: (line: string) => void = console.log
): void {
  if (isCommandFailure(result)) {
    log(result.message)
    return
  }
  if (args.json) {
    log(JSON.stringify({ decision: result.decision, snapshot: result.snapshot }, null, 2))
    return
  }

  // THE SENTENCE IS COMPOSED BY CONTRACTS, never written here — so no future
  // edit to this file can phrase a decline as an outcome, or an unanswered
  // check as a green light.
  log(decisionStatement(result.decision))
  log('')

  const snapshot = result.snapshot
  if (snapshot === null) {
    log('NO SNAPSHOT — the breakers were not consulted. Nothing below; there is nothing to show.')
    return
  }

  log(
    `BREAKERS  ${snapshot.scan.budgetsEvaluated} of ${snapshot.scan.budgetsInScope} evaluated  |  ` +
      `evaluated ${formatTimestamp(snapshot.evaluatedAt)}  |  answer good until ${formatTimestamp(snapshot.freshUntil)}` +
      `${snapshot.scan.evaluationTruncated ? '  |  EVALUATION TRUNCATED' : ''}`
  )
  if (snapshot.scan.budgetsInScope === 0) {
    log(
      '  NO BUDGET GOVERNS THIS SUBJECT. That is not the same as having headroom — it is also what a deleted, ' +
        'disabled or mis-scoped budget looks like. If you expected a cap here, it is not attached.'
    )
  }
  for (const state of snapshot.states) renderState(state, log)

  if (!isBreakerSnapshotComplete(snapshot)) {
    log('')
    log(
      '  THIS EVALUATION IS INCOMPLETE — not every breaker governing this subject was read. An incomplete ' +
        'evaluation cannot establish headroom, however armed the breakers it did reach look.'
    )
  }
}

// ---------------------------------------------------------------------------
// PRIVILEGED — manual trip and reset
// ---------------------------------------------------------------------------

/**
 * Validate a privileged mutation's arguments.
 *
 * `--reason` IS REQUIRED AND IS NOT DEFAULTED. A manual trip is the one kind
 * arithmetic cannot justify — there is no meter reading behind it — so the
 * justification has to be a human sentence, and it is written to the
 * append-only admin audit log server-side (CLAUDE.md Event Log Rule 6). A
 * defaulted reason would put "n/a" in that log forever.
 */
export function validatePrivilegedArgs(args: BudgetArgs, verb: string): CommandFailure | null {
  if (args.budgetId === undefined || args.budgetId.length === 0) {
    return { ok: false, exitCode: 1, message: `afr budget ${verb} requires a budget id: afr budget ${verb} <budgetId> --reason "..."` }
  }
  if (args.reason === undefined || args.reason.trim().length === 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        `--reason is required for 'afr budget ${verb}' and is written to the append-only admin audit log. A manual ` +
        `${verb} is the one kind arithmetic cannot justify — there is no meter reading behind it — so the ` +
        `justification has to be a sentence somebody can read six months from now.`,
    }
  }
  return null
}

/** A successful privileged mutation. */
export interface BudgetMutationCommandResult {
  ok: true
  verb: 'trip' | 'reset'
  result: BudgetMutationResult
}

export type BudgetPrivilegedResult = BudgetMutationCommandResult | CommandFailure

/**
 * `afr budget trip` / `afr budget reset` — the privileged half.
 *
 * THE AUDIT IS SERVER-SIDE AND IS NOT OPTIONAL. This command sends a reason; the
 * backend writes the append-only admin audit log entry and returns its id, which
 * is printed as the receipt. A client that could trip a breaker without leaving
 * a record would be a client that can silently un-cap an org's spend.
 *
 * NOTE WHAT A TRIP DOES AND DOES NOT DO, because it is the same boundary as
 * everywhere else in this feature: it sets the breaker's state to tripped, so
 * every subsequent `check` declines. It does not reach into anybody's running
 * agent, and no output here says it did.
 *
 * @param args - parsed flags (needs `budgetId` and `--reason`).
 * @param verb - which mutation.
 * @param env - CLI environment (injectable for tests).
 * @param fetchImpl - injectable fetch (tests never touch the network).
 */
export async function runBudgetMutation(
  args: BudgetArgs,
  verb: 'trip' | 'reset',
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<BudgetPrivilegedResult> {
  const invalid = validatePrivilegedArgs(args, verb)
  if (invalid !== null) return invalid

  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  const request = { budgetId: args.budgetId as string, reason: (args.reason as string).trim() }
  try {
    const result = verb === 'trip'
      ? await tripBudget(config, request, fetchImpl)
      : await resetBudget(config, request, fetchImpl)
    return { ok: true, verb, result }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** Print the outcome of a privileged budget mutation, receipt first. */
export function printBudgetMutation(
  result: BudgetPrivilegedResult,
  log: (line: string) => void = console.log
): void {
  if (isCommandFailure(result)) {
    log(result.message)
    return
  }
  const verb = result.verb === 'trip' ? 'TRIPPED' : 'RESET'
  log(`Breaker ${verb}: ${result.result.budgetId} at ${formatTimestamp(result.result.appliedAt)}`)
  log(`Audit log entry: ${result.result.auditLogId}  <- the receipt. Cite this, not this terminal.`)
  if (result.verb === 'trip') {
    log(
      'Every subsequent `afr budget check` and every SDK BudgetGuard holding a fresh snapshot will now DECLINE ' +
        'for this budget. That is what changed. Agents already mid-flight are not reached by this — nothing here ' +
        'stops a running process, and this tool does not claim to have.'
    )
  }
}
