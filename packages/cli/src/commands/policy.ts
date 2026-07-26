import { parseArgs } from 'node:util'

import {
  computePolicyVerdict,
  countPolicyOutcomes,
  establishedViolations,
  isAllClear,
  policyOutcomeStatement,
  policyVerdictStatement,
  POLICY_RULE_KINDS,
} from '@agent-flight-recorder/sdk'

import { disablePolicy, getPolicyEvaluation, getPolicySnapshot, upsertPolicy } from '../apiClient.js'
import { formatTimestamp, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type {
  PolicyDefinition,
  PolicyEvaluation,
  PolicyMutationResult,
  PolicyRule,
  PolicySubject,
  PolicySubjectParams,
  PolicyVerdict,
} from '@agent-flight-recorder/sdk'

export const POLICY_HELP = `Usage: afr policy <subcommand> [options]

Declarative policy over RECORDED runs — "agent X may not call tool Y", "no run
in env Z may egress to host H", checked against what was actually recorded.

Subcommands:
  afr policy scan            Evaluate every policy governing a subject against
                             recorded runs. THIS IS THE COMPLIANCE GATE.
  afr policy list            Show every policy governing a subject.
  afr policy define          Create or replace a policy. PRIVILEGED.
  afr policy disable <id>    Disable a policy. PRIVILEGED. --reason required.
                             There is deliberately no delete: a policy that
                             judged recorded runs is part of how they were
                             judged, and removing it makes past findings
                             uninterpretable.

READ THIS BEFORE PUTTING 'scan' IN A COMPLIANCE PIPELINE:

  THIS TOOL CANNOT TELL YOU THAT YOU ARE COMPLIANT. It can tell you that a
  forbidden operation WAS RECORDED, which is a fact. It can tell you that it
  could not establish anything, which is the common answer. And in a narrow,
  well-defined case it can tell you that no violation appears in a set of runs
  it read end to end — which is a much smaller claim than it sounds, and the
  output states its own scope every time rather than trusting you to remember.

  WHAT 'no violation found' DOES NOT MEAN:
    - It does not cover runs outside the subject and window you asked about.
    - It does not cover runs purged under your retention window (ADR-001).
      A compliance report can go clean BY ELAPSED TIME, and the output names
      the horizon so that cannot happen quietly.
    - It does not cover acts nobody wrote a policy for. Unlisted is not
      permitted.
    - ABOVE ALL, it does not cover acts your agent performed WITHOUT RECORDING
      THEM. The SDK's HTTP and tool builders are called by hand; there is no
      interception. A run that egressed through a plain fetch() is, to this
      tool, identical to one that touched no network at all. That gap is closed
      only by the agent DECLARING complete instrumentation, and until it does,
      'no violation found' is not reachable at all for it — you will get exit
      21 with kind 'instrumentation_undeclared', which is the honest answer.

  'satisfied' IS THEREFORE RARE AND 'not_evaluable' IS THE NORM. That is the
  design working, not the tool failing.

WHAT THIS COMMAND CAN AND CANNOT TELL YOU:

  "The policy was broken."    A fact about the RECORD. We own it, and it stays
                              true even if the rest of the scan was unreadable.
  "The scan exited 20."       A fact about THIS PROCESS. We own it.
  "The call was prevented."   NOT A FACT WE HAVE. Nothing here intercepts
                              anything, and nothing it prints will claim it did.
  "The org is compliant."     NOT A FACT ANYONE HAS. No flag produces that word,
                              and the API refuses a response body that carries
                              it.

Options (scan / list):
  --agent <agentId>         Subject: this agent
  --project <projectId>     Subject: this project
  --env <environment>       Subject: runs labelled with this environment.
                            NOTE: 'environment' is a label the CLIENT chose and
                            is not validated. An agent that mislabels itself is
                            outside every rule scoped this way.
  --org                     Subject: the whole organization
                            EXACTLY ONE is required. There is no default: a gate
                            whose subject is implicit silently changes meaning
                            the day someone adds an org-wide policy.
  --json                    Print the raw evaluation and verdict as JSON
  --help                    Show this message

Options (define):
  --name <text>             REQUIRED. Human-readable policy name.
  --deny-tools <a,b,c>      Forbid these tools. OMIT the value to forbid ALL
                            tool calls — which is not shorthand, it is the only
                            form under which an externalized (>10 KB) payload
                            still proves a violation, because the event TYPE
                            survives externalization and the tool name does not.
  --deny-hosts <a,b>        Forbid egress to these hosts and their subdomains.
                            Omit the value to forbid ALL egress, same reasoning.
  --rationale <text>        REQUIRED. Why this is forbidden. Travels into every
                            finding, so a violation on a screen explains itself.
  --agent / --project / --env / --org   Who it applies to.

Options (disable):
  --reason <text>           REQUIRED. Written to the append-only admin audit log
                            server-side.

EXIT CODES — READ THIS BEFORE PUTTING IT IN A PIPELINE:
  0   no violation, and every policy was evaluable over every run in scope.
      THE NARROW CLAIM DESCRIBED ABOVE. Reachable only when the scan was
      complete AND at least one policy governs the subject AND every agent
      involved has declared its instrumentation.
  20  VIOLATION — a forbidden operation is in the record. The pipeline should
      stop. 20 WINS OVER 21: a recorded breach is a positive fact, and another
      policy going unevaluated does not make it less true.
  21  COULD NOT ESTABLISH — anything not evaluable, any unread run, a truncated
      scan, an untrustworthy response, OR NO POLICY GOVERNING THE SUBJECT AT
      ALL. This is the common exit and it is NOT a pass.
  1   usage (bad flags, missing AFR_API_KEY/AFR_BASE_URL)
  2   auth (401/403)     3  not found (404)     4  network/rate-limit/server

  A SCAN THAT COULD NOT EVALUATE NEVER EXITS 0, AND THERE IS NO FLAG THAT
  CHANGES THAT. 'afr budget check' has --if-unavailable because a breaker
  decision is a business tradeoff somebody may legitimately want to make. This
  command has no equivalent, deliberately: the output of a compliance scan gets
  attested to, and an operator who could turn "we could not look" into exit 0
  would be manufacturing the attestation this whole feature exists to prevent.
  If you need the pipeline to proceed anyway, do it in the pipeline, where the
  decision is visible in a config file somebody reviews.

  ZERO POLICIES IN SCOPE EXITS 21, NOT 0, and this differs deliberately from
  'afr budget check', which exits 0 when no budget governs a subject. A budget
  is a cost control and its absence is a business choice. A compliance scan over
  a subject with no policies attached that exits 0 is a green pipeline
  certifying nothing — and "we deleted the policies in a bad migration" and "we
  passed" would be the same exit code.

Scripting it:
  afr policy scan --agent agent_7                # compliance gate, fails closed
  afr policy scan --env production --json
  afr policy list --org
  afr policy define --name 'no shell' --deny-tools shell.exec,shell.spawn \\
      --agent agent_7 --rationale 'SOC2 CC6.1 — no shell from customer agents'
`

/** A forbidden operation is in the record. Above the 0-4 band so it can never collide with a transport failure. */
export const POLICY_EXIT_VIOLATION = 20

/**
 * The scan could not establish anything.
 *
 * NOT SUPPRESSIBLE, AND THERE IS NO FLAG. See {@link exitCodeForPolicy} and this
 * file's help text.
 */
export const POLICY_EXIT_INDETERMINATE = 21

export interface PolicyArgs {
  /** `scan` | `list` | `define` | `disable`. */
  subcommand?: string
  /** Policy id, for `disable`. */
  policyId?: string
  agentId?: string
  projectId?: string
  environment?: string
  org?: boolean
  name?: string
  /** Present with a value: those tools. Present with an empty string: ALL tools. Absent: not a tool rule. */
  denyTools?: string
  denyHosts?: string
  rationale?: string
  reason?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr policy` flags (argv AFTER `policy`). */
export function parsePolicyArgs(argv: string[]): PolicyArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      project: { type: 'string' },
      env: { type: 'string' },
      org: { type: 'boolean' },
      name: { type: 'string' },
      'deny-tools': { type: 'string' },
      'deny-hosts': { type: 'string' },
      rationale: { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: PolicyArgs = {}
  if (positionals[0] !== undefined) result.subcommand = positionals[0]
  if (positionals[1] !== undefined) result.policyId = positionals[1]
  if (values['agent']) result.agentId = values['agent']
  if (values['project']) result.projectId = values['project']
  if (values['env']) result.environment = values['env']
  if (values['org']) result.org = true
  if (values['name']) result.name = values['name']
  if (values['deny-tools'] !== undefined) result.denyTools = values['deny-tools']
  if (values['deny-hosts'] !== undefined) result.denyHosts = values['deny-hosts']
  if (values['rationale']) result.rationale = values['rationale']
  if (values['reason']) result.reason = values['reason']
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

/**
 * Resolve the subject. EXACTLY ONE, and neither zero nor two is a usable
 * question.
 *
 * Zero would mean "everything", which changes meaning the day somebody adds an
 * org-wide policy. Two would mean the tool silently picks, and whichever it
 * picked would be the one somebody's gate was not asking about.
 */
function resolveSubject(args: PolicyArgs): PolicySubjectParams | CommandFailure {
  const named: PolicySubjectParams[] = []
  if (args.agentId !== undefined) named.push({ agentId: args.agentId })
  if (args.projectId !== undefined) named.push({ projectId: args.projectId })
  if (args.environment !== undefined) named.push({ environment: args.environment })
  if (args.org === true) named.push({ orgWide: true })

  if (named.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        'Name a subject: --agent <id>, --project <id>, --env <name> or --org. There is deliberately no default — ' +
        'a compliance gate whose subject is implicit silently changes meaning the day someone adds an org-wide ' +
        'policy, and a scan that quietly widened or narrowed is one nobody can attest to.',
    }
  }
  if (named.length > 1) {
    return {
      ok: false,
      exitCode: 1,
      message: 'Name exactly one subject (--agent, --project, --env or --org) — not several. Run the command once each.',
    }
  }
  return named[0] as PolicySubjectParams
}

/** A successful policy scan. */
export interface PolicyScanResult {
  ok: true
  subcommand: 'scan' | 'list'
  evaluation: PolicyEvaluation | null
  /** THE verdict, from contracts' single rule — never re-derived here. */
  verdict: PolicyVerdict
  /** For `list`. */
  policies: readonly PolicyDefinition[]
}

export type PolicyCommandResult = PolicyScanResult | CommandFailure

/**
 * `afr policy scan` — evaluate every policy governing a subject against recorded
 * runs.
 *
 * A TRANSPORT FAILURE IS AN ERROR HERE, UNLIKE `afr budget check`. That command
 * feeds an outage to a caller-configured `--if-unavailable` policy, because a
 * budget breaker decision is a business tradeoff somebody may legitimately want
 * to make. THIS COMMAND HAS NO SUCH FLAG: an unreachable server means the scan
 * did not happen, which is exit 21 under every circumstance, and there is
 * nothing for a policy to adjudicate.
 *
 * @param args - parsed flags.
 * @param env - CLI environment (injectable for tests).
 * @param fetchImpl - injectable fetch (tests never touch the network).
 */
export async function runPolicyScan(
  args: PolicyArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<PolicyCommandResult> {
  const subject = resolveSubject(args)
  if (isCommandFailure(subject)) return subject

  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  const subcommand = args.subcommand === 'list' ? 'list' : 'scan'

  if (subcommand === 'list') {
    try {
      const data = await getPolicySnapshot(config, subject, fetchImpl)
      return {
        ok: true,
        subcommand,
        evaluation: null,
        // A listing establishes nothing about runs. It is never an all-clear,
        // and giving it one would be the exact conflation this feature exists
        // against — "we have policies" is not "we obeyed them".
        verdict: data.snapshot.policiesInScope === 0 ? 'no_policy_governs_this_subject' : 'evaluation_incomplete',
        policies: data.snapshot.policies,
      }
    } catch (err) {
      return toCommandFailure(err)
    }
  }

  try {
    const data = await getPolicyEvaluation(config, subject, fetchImpl)
    return {
      ok: true,
      subcommand,
      evaluation: data.evaluation,
      verdict: computePolicyVerdict(data.evaluation),
      policies: [],
    }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/**
 * WHICH VERDICT EARNS WHICH EXIT CODE. A TOTAL TABLE.
 *
 * Total over {@link PolicyVerdict}, so a fifth verdict is a COMPILE ERROR here
 * until somebody assigns it a code. That totality is the point: an exit code
 * chosen by an `if` chain with a fallthrough is one where a new verdict inherits
 * whatever the last branch was, and in a compliance gate the dangerous
 * inheritance is `0`.
 *
 * NOTE THAT ONLY ONE ENTRY IS `0`, and it is the verdict whose own name states
 * its preconditions.
 */
const POLICY_EXIT_CODES: Record<PolicyVerdict, number> = {
  violations_found: POLICY_EXIT_VIOLATION,
  // NOT 0. See this file's help text: a compliance scan over a subject with no
  // policies attached that exits 0 is a green pipeline certifying nothing, and
  // "we deleted the policies in a bad migration" would be indistinguishable from
  // "we passed". This is the deliberate divergence from `afr budget check`.
  no_policy_governs_this_subject: POLICY_EXIT_INDETERMINATE,
  evaluation_incomplete: POLICY_EXIT_INDETERMINATE,
  no_violation_and_every_policy_was_evaluable: 0,
}

/**
 * Process exit code for a completed policy scan.
 *
 * COMPUTED FROM THE VERDICT, which comes from contracts' single
 * `computePolicyVerdict` rule. A locally-invented gate is a locally-invented
 * all-clear.
 *
 * DOUBLE-GATED ON PURPOSE, and the redundancy is not an oversight. The exit code
 * is 0 only when the table says so AND `isAllClear` — the contract's own
 * predicate — agrees. Two independent readings of the same fact, because this
 * one number is the entire product for most of this command's lifetime: nobody
 * reads the output until it goes non-zero, and a wrong 0 here is an attestation
 * nobody checked.
 */
export function exitCodeForPolicy(result: PolicyScanResult): number {
  const fromTable = POLICY_EXIT_CODES[result.verdict]
  if (fromTable === undefined) return POLICY_EXIT_INDETERMINATE
  if (fromTable === 0 && !isAllClear(result.verdict)) return POLICY_EXIT_INDETERMINATE
  return fromTable
}

// ---------------------------------------------------------------------------
// Rendering — the verdict first, then the violations, then the honest gaps
// ---------------------------------------------------------------------------

/** Render one policy definition. */
function renderPolicy(policy: PolicyDefinition, log: (line: string) => void): void {
  log(
    `  ${truncateId(policy.policyId).padEnd(16)} ${policy.enabled ? 'ENABLED ' : 'DISABLED'} rev ${policy.revision}  ` +
      `${policy.name}`
  )
  log(`      ${describeRule(policy.rule)}  |  applies to ${describeSubject(policy.subject)}`)
  log(`      ${policy.rationale}`)
}

/** A rule in one line, with the operation-denial case called out because its coverage differs. */
export function describeRule(rule: PolicyRule): string {
  if (!rule || typeof rule !== 'object') return 'UNREADABLE RULE'
  if (rule.kind === 'tool_denied') {
    return rule.deniedTools === undefined
      ? 'denies ALL tool calls (decidable from the event type alone, so externalized payloads still prove it)'
      : `denies tools: ${rule.deniedTools.join(', ')} (NOT decidable over externalized payloads — the tool name is gone)`
  }
  if (rule.kind === 'egress_denied') {
    return rule.deniedHosts === undefined
      ? 'denies ALL egress (decidable from the event type alone, so externalized payloads still prove it)'
      : `denies egress to: ${rule.deniedHosts.join(', ')} (NOT decidable over externalized payloads — the URL is gone)`
  }
  return 'UNREADABLE RULE'
}

/** A subject in one line. */
export function describeSubject(subject: PolicySubject): string {
  if (!subject || typeof subject !== 'object') return 'an unreadable subject'
  if (subject.appliesTo === 'org') return 'the whole organization'
  if (subject.appliesTo === 'project') return `project ${subject.projectId}`
  if (subject.appliesTo === 'agent') return `agent ${subject.agentId}`
  if (subject.appliesTo === 'environment') {
    return `runs labelled environment="${subject.environment}" (A SELF-REPORT, not a trust boundary)`
  }
  return 'an unreadable subject'
}

/**
 * Print a policy scan/list result.
 *
 * `--json` prints the evaluation and the verdict and nothing else — and note
 * what is NOT in that object: there is no `compliant`, no `clean`, no bare
 * `satisfiedCount`. The counts print all three or none, because a satisfied
 * figure travelling alone is the attestation figure with every safeguard
 * stripped off.
 */
export function printPolicy(
  args: PolicyArgs,
  result: PolicyCommandResult,
  log: (line: string) => void = console.log
): void {
  if (isCommandFailure(result)) {
    log(result.message)
    return
  }
  if (args.json) {
    log(JSON.stringify({ verdict: result.verdict, evaluation: result.evaluation }, null, 2))
    return
  }

  if (result.subcommand === 'list') {
    if (result.policies.length === 0) {
      log(
        'NO POLICY GOVERNS THIS SUBJECT. That is not the same as being compliant — it is also what a deleted, ' +
          'disabled or mis-scoped policy set looks like. If you expected coverage here, it is not attached.'
      )
      return
    }
    log(`${result.policies.length} policy/policies govern this subject:`)
    for (const policy of result.policies) renderPolicy(policy, log)
    log('')
    log(
      'A LISTING IS NOT A SCAN. These policies exist; nothing here says any run obeyed them. Run ' +
        "'afr policy scan' for that, and read its scope caveats."
    )
    return
  }

  const evaluation = result.evaluation
  if (evaluation === null) {
    log('NO EVALUATION — the policies were not checked against any run. There is nothing to show.')
    return
  }

  // THE SENTENCE IS COMPOSED BY CONTRACTS, never written here — so no future
  // edit to this file can phrase an unevaluable scan as an all-clear.
  log(policyVerdictStatement(result.verdict, evaluation))
  log('')

  const counts = countPolicyOutcomes(evaluation.outcomes)
  // ALL THREE, ALWAYS, ON ONE LINE. `countPolicyOutcomes` is the only counting
  // function in the contract and it returns all three or nothing; printing them
  // together is the rendering half of the same rule.
  log(
    `OUTCOMES  ${counts.violated} violated  |  ${counts.satisfied} satisfied  |  ` +
      `${counts.notEvaluable} NOT EVALUABLE`
  )
  log(
    `SCAN      ${evaluation.scan.policiesEvaluated} of ${evaluation.scan.policiesInScope} policies  |  ` +
      `${evaluation.scan.runsRead} of ${evaluation.scan.runsInScope} runs read  |  evaluated ` +
      `${formatTimestamp(evaluation.evaluatedAt)}` +
      `${evaluation.scan.evaluationTruncated ? '  |  SCAN TRUNCATED' : ''}`
  )
  if (evaluation.scan.retentionHorizon !== null) {
    log(
      `RETENTION Runs before ${formatTimestamp(evaluation.scan.retentionHorizon)} have been purged (ADR-001) and ` +
        `are in NO result above. A report can go clean by elapsed time; this line is why that cannot happen quietly.`
    )
  }
  if (evaluation.scan.orderingCaveat) {
    log(
      'ORDERING  Some runs in scope are OTel-derived, so sequence numbers below are ARRIVAL order, not occurrence ' +
        'order (ADR-007).'
    )
  }
  log('')

  // VIOLATIONS FIRST, and separately from everything else, because they survive
  // a defect anywhere else in the body.
  const violations = establishedViolations(evaluation)
  if (violations.length > 0) {
    log('VIOLATIONS:')
    for (const violation of violations) log(`  ${policyOutcomeStatement(violation)}`)
    log('')
  }

  const notEvaluable = evaluation.outcomes.filter((o) => o.outcome === 'not_evaluable')
  if (notEvaluable.length > 0) {
    log('NOT EVALUABLE — these were NOT checked, and this section is NOT an all-clear:')
    for (const outcome of notEvaluable) log(`  ${policyOutcomeStatement(outcome)}`)
  }
}

// ---------------------------------------------------------------------------
// PRIVILEGED — define and disable
// ---------------------------------------------------------------------------

/**
 * Build the rule from flags.
 *
 * `--deny-tools` WITH NO VALUE IS NOT A MISTAKE, it is the deny-the-operation
 * form, and it is the one whose findings survive Event Log Rule 3. Distinguished
 * from an absent flag by `parseArgs` giving an empty string for the former.
 */
function resolveRule(args: PolicyArgs): PolicyRule | CommandFailure {
  const tools = args.denyTools
  const hosts = args.denyHosts
  if (tools !== undefined && hosts !== undefined) {
    return {
      ok: false,
      exitCode: 1,
      message:
        'A policy denies tools OR egress, not both. Two prohibitions are two policies — which is more rows and a ' +
        'legible diff, and that is the trade this feature wants.',
    }
  }
  if (tools !== undefined) {
    const list = tools.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
    return list.length === 0 ? { kind: 'tool_denied' } : { kind: 'tool_denied', deniedTools: list }
  }
  if (hosts !== undefined) {
    const list = hosts.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
    return list.length === 0 ? { kind: 'egress_denied' } : { kind: 'egress_denied', deniedHosts: list }
  }
  return {
    ok: false,
    exitCode: 1,
    message: `Name what is forbidden: --deny-tools or --deny-hosts (one of ${POLICY_RULE_KINDS.join(', ')}).`,
  }
}

/** Build the subject from flags, for a definition. */
function resolveDefinitionSubject(args: PolicyArgs): PolicySubject | CommandFailure {
  const params = resolveSubject(args)
  if (isCommandFailure(params)) return params
  if (params.agentId !== undefined) return { appliesTo: 'agent', agentId: params.agentId }
  if (params.projectId !== undefined) return { appliesTo: 'project', projectId: params.projectId }
  if (params.environment !== undefined) return { appliesTo: 'environment', environment: params.environment }
  return { appliesTo: 'org' }
}

/**
 * Validate a privileged mutation's arguments.
 *
 * `--rationale` IS REQUIRED AND IS NOT DEFAULTED. It travels into every finding
 * this policy produces, so a defaulted one would put "n/a" on a compliance
 * screen next to a real violation forever. `--reason` on `disable` is required
 * for the same class of argument as `afr budget trip --reason`: the act has no
 * arithmetic behind it and the audit entry's only content is that sentence.
 */
export function validatePolicyDefineArgs(args: PolicyArgs): CommandFailure | null {
  if (args.name === undefined || args.name.trim().length === 0) {
    return { ok: false, exitCode: 1, message: 'afr policy define requires --name "<policy name>".' }
  }
  if (args.rationale === undefined || args.rationale.trim().length === 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        '--rationale is required for `afr policy define`. It travels into every finding this policy produces, so ' +
        'a violation on a screen at 3am explains itself instead of showing a policy id somebody has to go look up.',
    }
  }
  return null
}

/** Validate `afr policy disable`. */
export function validatePolicyDisableArgs(args: PolicyArgs): CommandFailure | null {
  if (args.policyId === undefined || args.policyId.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      message: 'afr policy disable requires a policy id: afr policy disable <policyId> --reason "..."',
    }
  }
  if (args.reason === undefined || args.reason.trim().length === 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        '--reason is required for `afr policy disable` and is written to the append-only admin audit log. Turning ' +
        'off a compliance control is the act most likely to be asked about later, so the justification has to be ' +
        'a sentence somebody can read six months from now.',
    }
  }
  return null
}

/** A successful privileged mutation. */
export interface PolicyMutationCommandResult {
  ok: true
  verb: 'define' | 'disable'
  result: PolicyMutationResult
}

export type PolicyPrivilegedResult = PolicyMutationCommandResult | CommandFailure

/**
 * `afr policy define` / `afr policy disable` — the privileged half.
 *
 * THE AUDIT IS SERVER-SIDE AND IS NOT OPTIONAL. The backend writes the
 * append-only admin audit log entry and returns its id, which is printed as the
 * receipt. A client that could define or disable a policy without leaving a
 * record would be a client that can silently remove an org's compliance
 * controls.
 *
 * NOTE WHAT A DEFINITION DOES AND DOES NOT DO: it changes what future scans
 * report. It does not reach into anybody's running agent, it does not gate
 * ingest, and it cannot cause any event to go unrecorded — there is no field in
 * `UpsertPolicyRequest` that could express that, deliberately.
 */
export async function runPolicyMutation(
  args: PolicyArgs,
  verb: 'define' | 'disable',
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<PolicyPrivilegedResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  if (verb === 'disable') {
    const invalid = validatePolicyDisableArgs(args)
    if (invalid !== null) return invalid
    try {
      const result = await disablePolicy(
        config,
        { policyId: args.policyId as string, reason: (args.reason as string).trim() },
        fetchImpl
      )
      return { ok: true, verb, result }
    } catch (err) {
      return toCommandFailure(err)
    }
  }

  const invalid = validatePolicyDefineArgs(args)
  if (invalid !== null) return invalid
  const rule = resolveRule(args)
  if (isCommandFailure(rule)) return rule
  const subject = resolveDefinitionSubject(args)
  if (isCommandFailure(subject)) return subject

  try {
    const result = await upsertPolicy(
      config,
      {
        ...(args.policyId !== undefined && { policyId: args.policyId }),
        name: (args.name as string).trim(),
        rule,
        subject,
        rationale: (args.rationale as string).trim(),
        enabled: true,
      },
      fetchImpl
    )
    return { ok: true, verb, result }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** Print the outcome of a privileged policy mutation, receipt first. */
export function printPolicyMutation(
  result: PolicyPrivilegedResult,
  log: (line: string) => void = console.log
): void {
  if (isCommandFailure(result)) {
    log(result.message)
    return
  }
  const verb = result.verb === 'define' ? 'DEFINED' : 'DISABLED'
  log(`Policy ${verb}: ${result.result.policyId} rev ${result.result.revision} at ${formatTimestamp(result.result.appliedAt)}`)
  log(`Audit log entry: ${result.result.auditLogId}  <- the receipt. Cite this, not this terminal.`)
  if (result.verb === 'define') {
    log(
      'This changes what FUTURE scans report. It does not reach into any running agent, it does not gate ingest, ' +
        'and it cannot cause any event to go unrecorded — a flight recorder must never refuse to record a ' +
        'violation, so there is no field in this request that could have asked it to.'
    )
  }
}
