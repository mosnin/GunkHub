import { parseArgs } from 'node:util'

import {
  citedAgentCount,
  discriminationOf,
  hypothesisQuestion,
  hypothesesFor,
  isFleetHealthAnalysisComplete,
  rankFleetCorrelations,
} from '@agent-flight-recorder/sdk'

import { getFleetHealth } from '../apiClient.js'
import { formatTimestamp, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { FleetHealthReport, HypothesisedCause, ObservedCorrelation } from '@agent-flight-recorder/sdk'

export const FLEET_HELP = `Usage: afr fleet [options]

What is wrong across everything, and what is it that is actually wrong?

Every other view in this product is one run or one agent. That is the wrong
altitude when you are running hundreds: the thing worth catching is not "agent
41 failed", it is "twelve agents started failing inside four minutes". This
command sweeps the whole org — a roster with a health state per agent, plus
CROSS-AGENT correlations inside the window.

  NOT TO BE CONFUSED WITH 'afr compat --agent'. That is ONE agent across MANY
  of its runs ("can I ship this version?"). This is MANY AGENTS at one moment
  ("is something wrong across the fleet right now?"). Different subject,
  different question, different exit-code meaning.

WHAT IT LOOKS FOR
  SHARED FINGERPRINT  N agents recorded the same failure fingerprint.
  TEMPORAL BURST      N agents began failing inside --window of each other,
                      WITHOUT needing to share a fingerprint. This is the one
                      that catches a model provider degrading or a shared tool
                      changing shape, because those rarely produce one tidy
                      fingerprint — they produce twelve different ones at once,
                      and every per-agent view shows twelve unrelated problems.

TWO KINDS OF LINE, AND THEY ARE NOT THE SAME KIND OF THING:

  OBSERVED     "12 agents recorded failures matching 9f3c between 14:02:11 and
               14:06:40." Checkable against stored rows. Every observation
               carries the recorded failures it is made of. THIS IS WHAT THE
               EXIT CODE IS COMPUTED FROM.

  HYPOTHESIS   "these 12 all call model m-4; if m-4 is degrading it would
               produce this pattern." A reading, not a finding. Causation needs
               a counterfactual and a flight recorder stores only what
               happened, so this can NEVER be checked from recorded data — no
               matter how much of it there is.

They are separate types in the contract (mutually unassignable, no shared text
field), separate arrays on the wire, separate sections here, and separately
counted in --json.

  A HYPOTHESIS CAN NEVER CHANGE THE EXIT CODE, and there is deliberately no
  flag to make it. --fail-on has no setting that fires on a guess. This is a
  DELIBERATE DIFFERENCE from 'afr compat', which does offer --fail-on any for
  speculative findings: a speculative divergence is read at leisure before a
  deploy, and this is read at 3am by someone deciding what to roll back. Paging
  on a guess is how the healthy dependency gets rolled back while the actual
  cause keeps burning.

EVERY HYPOTHESIS PRINTS ITS DENOMINATOR. "All 12 failing agents use model m-4"
is worthless — actively misleading — if 198 of your 200 agents use m-4. So each
hypothesis is printed with how many UNAFFECTED agents share the same attribute,
and is marked one of:
  DISCRIMINATING     markedly more common among the failing than the healthy
  NOT DISCRIMINATING the healthy share it too; this explains nothing
  BASE RATE UNKNOWN  no comparison group was measured. Not weak support — NO
                     support. Ranked last and never read as an explanation.

Options:
  --since-hours <n>   Observation window, hours back from now. Default 24.
                       The resolved window is printed on every run, so a log
                       always says what was actually swept.
  --window <n>        Burst width in MINUTES: how close in time failures on
                       different agents must be to count as coincident.
                       Default 15. Sent to the server and VERIFIED on the way
                       back — a deployment that drops it correlates over its
                       own, usually much wider, default, which turns a day of
                       ordinary background failure into a four-minute
                       "incident". That mismatch is refused (exit 4), never
                       rendered.
  --limit <n>         Max agents in the roster page (server-capped).
  --fail-on <what>    What makes this command fail. Default: correlated.
                        correlated  exit 10 on any OBSERVED cross-agent
                                    correlation
                        any         exit 10 on that, or on any failing agent
                                    at all (even with nothing connecting them)
                        none        never exit 10 (report only)
                      There is no setting that fires on a hypothesis — see
                      above. The threshold in force is printed on every run.
  --json              Print the raw report as JSON
  --help              Show this message

EXIT CODES — THIS ENDS UP IN A MONITORING LOOP, READ THIS BEFORE SCRIPTING IT:
  0   nothing to do   — nothing at or above the threshold, and the sweep was
                        COMPLETE
  10  fleet event     — findings at or above --fail-on
  11  cannot tell     — nothing found, but the sweep did not finish: the roster
                        ceiling was hit, agents were skipped or unassessable,
                        PAGES REMAIN, a question was left open, or the server
                        correlated only over one page of the roster.
                        "Nothing found" is not evidence of health when you did
                        not finish looking.
  1   usage (bad flags, missing AFR_API_KEY/AFR_BASE_URL)
  2   auth (401/403)     3  not found (404)     4  network/rate-limit/server

  10 WINS OVER 11 when both apply, AND THAT ORDER IS THE IMPORTANT ONE HERE.
  Data volume spikes during an incident — that is what an incident is — so a
  truncated sweep is LIKELIEST during exactly the event this command exists to
  catch. An observation does not become less true because something else went
  unread, so a correlation found in a partial sweep still pages you.

  EXIT 0 IS UNREACHABLE ON AN INCOMPLETE SWEEP, with --fail-on correlated or
  any. It is reachable with --fail-on none, which is not a gate and says so.

  A PAGED SWEEP IS NEVER A PASS, and this command deliberately does NOT follow
  the cursor and merge, the way 'afr compat --agent' does. Cross-agent
  correlation does not compose across pages: a burst of twelve agents split
  across two roster pages is a cluster of four and a cluster of eight to a
  page-local engine, both possibly under threshold, so the incident is
  invisible on every page AND in any merge of them — silently, with nothing in
  the output saying a cluster was cut in half. Raise --limit instead; an
  outstanding cursor keeps the sweep incomplete and exits 11.

  Exit 4 covers the refusals worth knowing about: the SDK will not return a
  report it cannot verify — one whose window parameters were ignored, one with
  no scan record, one whose correlation cites failures outside the window it
  claims, one serving a hypothesis in the observed list, one whose hypothesis
  has no base rate, or one resting on an observation the report does not
  contain. Several of those look like a clean fleet; the rest look like a
  confident explanation. None of them exits 0 or 10 here.

Scripting it:
  afr fleet                                  # pages on a cross-agent correlation
  afr fleet --window 5 --since-hours 2       # tight sweep during an incident
  afr fleet --json                           # 'verdict', 'correlations', 'scan'
`

/** Findings at or above the threshold. Above the 0-4 band so it can never collide with a transport failure. */
export const FLEET_EXIT_CORRELATED = 10
/** Nothing found, but the sweep did not finish — "nothing found" is not an answer here. */
export const FLEET_EXIT_INDETERMINATE = 11

/**
 * What makes this command fail.
 *
 * NOTE WHAT IS ABSENT AND CANNOT BE ADDED WITHOUT A CONTRACT CHANGE: there is
 * no value that fires on a {@link HypothesisedCause}. `computeFleetHealthVerdict`
 * does not accept a hypothesis count, so there is nothing for such a threshold
 * to read.
 */
export type FleetFailOn = 'correlated' | 'any' | 'none'

const VALID_FAIL_ON: readonly FleetFailOn[] = ['correlated', 'any', 'none']

/** The default threshold. */
export const DEFAULT_FLEET_FAIL_ON: FleetFailOn = 'correlated'

const MS_PER_HOUR = 3_600_000
const MS_PER_MINUTE = 60_000

/** Default observation window, in hours. Printed on every run so it is never implicit in a log. */
export const DEFAULT_SINCE_HOURS = 24

/**
 * Default burst width, in minutes.
 *
 * Wide enough that a provider degradation rolling through a fleet of staggered
 * cron agents still lands inside one window; narrow enough that it does not
 * sweep up an ordinary hour of unrelated failures and call it an incident. It
 * is a judgement call, which is why it is a flag and why the resolved value is
 * printed and verified against the server's echo.
 */
export const DEFAULT_BURST_WINDOW_MINUTES = 15

export interface FleetArgs {
  sinceHours?: number
  /** `--window`, in MINUTES. Converted to `burstWindowMs` for the wire. */
  windowMinutes?: number
  limit?: number
  /** Raw `--fail-on` value, as typed — validated by `resolveFailOn` before use. */
  failOn?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr fleet` flags (argv AFTER `fleet`). */
export function parseFleetArgs(argv: string[]): FleetArgs {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'since-hours': { type: 'string' },
      window: { type: 'string' },
      limit: { type: 'string' },
      'fail-on': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: FleetArgs = {}
  if (values['since-hours']) result.sinceHours = Number(values['since-hours'])
  if (values['window']) result.windowMinutes = Number(values['window'])
  if (values['limit']) result.limit = Number(values['limit'])
  if (values['fail-on']) result.failOn = values['fail-on']
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

/**
 * Validate `--fail-on` against the closed set — same posture as `afr compat`:
 * an unknown value is a usage error (exit 1), never silently treated as the
 * default. A typo that quietly fell back to the default is harmless until the
 * day someone means to widen the gate and believes they have.
 */
function resolveFailOn(args: FleetArgs): FleetFailOn | CommandFailure {
  if (args.failOn === undefined) return DEFAULT_FLEET_FAIL_ON
  if (!(VALID_FAIL_ON as readonly string[]).includes(args.failOn)) {
    return {
      ok: false,
      exitCode: 1,
      message:
        `--fail-on must be one of ${VALID_FAIL_ON.join(', ')} — got "${args.failOn}". ` +
        `Note there is deliberately no threshold that fires on a hypothesis: paging on a guess is how the ` +
        `healthy dependency gets rolled back while the actual cause keeps burning.`,
    }
  }
  return args.failOn as FleetFailOn
}

/** A successful sweep. */
export interface FleetResult {
  ok: true
  failOn: FleetFailOn
  report: FleetHealthReport
}

export type FleetCommandResult = FleetResult | CommandFailure

/**
 * `afr fleet` — the org-wide sweep.
 *
 * @param args - parsed flags.
 * @param env - CLI environment (injectable for tests).
 * @param fetchImpl - injectable fetch (tests never touch the network).
 * @param now - the clock, injected so the window is deterministic in tests.
 */
export async function runFleet(
  args: FleetArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike,
  now: number = Date.now()
): Promise<FleetCommandResult> {
  const sinceHours = args.sinceHours ?? DEFAULT_SINCE_HOURS
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    return { ok: false, exitCode: 1, message: `--since-hours must be a positive number of hours — got "${args.sinceHours}".` }
  }
  const windowMinutes = args.windowMinutes ?? DEFAULT_BURST_WINDOW_MINUTES
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return { ok: false, exitCode: 1, message: `--window must be a positive number of minutes — got "${args.windowMinutes}".` }
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    return { ok: false, exitCode: 1, message: `--limit must be a positive integer — got "${args.limit}".` }
  }

  const failOn = resolveFailOn(args)
  if (isCommandFailure(failOn)) return failOn

  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    const data = await getFleetHealth(
      config,
      {
        since: Math.floor(now - sinceHours * MS_PER_HOUR),
        until: Math.floor(now),
        burstWindowMs: Math.floor(windowMinutes * MS_PER_MINUTE),
        ...(args.limit !== undefined && { limit: args.limit }),
      },
      fetchImpl
    )
    // Deliberately ONE request. See FLEET_HELP: following the cursor and
    // merging pages would assemble a fleet answer out of page-local
    // correlations, which is a report about a fleet that does not exist. An
    // outstanding cursor is reported, and keeps the sweep incomplete.
    return { ok: true, failOn, report: data.report }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** The numbers every gate decision is made from. */
interface FleetTally {
  /** OBSERVED correlations. The only finding class the exit code can see. */
  correlations: number
  agentsFailing: number
  /** Questions the sweep could not answer. Each one is a reason `complete` is false. */
  unanswered: number
  /**
   * From contracts' single completeness definition — NOT recomputed here. It
   * folds in every way of not having looked (roster ceiling, skipped agents,
   * outstanding cursor, a page-local correlation basis, and an unanswered
   * question), and it is the same predicate the web UI and the MCP projection
   * use. A local re-derivation is how a monitoring loop and a dashboard come to
   * disagree about whether the fleet is on fire.
   */
  complete: boolean
}

function tally(result: FleetResult): FleetTally {
  return {
    correlations: result.report.correlations.length,
    agentsFailing: result.report.agentsFailing,
    unanswered: result.report.unanswered.length,
    complete: isFleetHealthAnalysisComplete(result.report),
  }
}

/**
 * Process exit code for a completed sweep.
 *
 * COMPUTED FROM THE REPORT'S CONTENTS, NOT FROM THE SERVER'S `verdict` STRING.
 * `FlightReader` already refuses a response whose verdict disagrees with its
 * own contents, so the two can only ever say the same thing — which is exactly
 * why deriving the gate from the facts costs nothing and removes a whole class
 * of "the string said healthy" failure.
 *
 * Order of precedence:
 *  1. `--fail-on none` short-circuits to 0. It is not a gate and its help says so.
 *  2. Findings at or above the threshold -> 10, EVEN IF the sweep was
 *     incomplete. Truncation is likeliest during the incident, so demoting an
 *     observation to "cannot tell" because the sweep was cut short would
 *     silence the alarm precisely when it is right.
 *  3. Incomplete sweep -> 11. The false-clean case.
 *  4. Otherwise 0.
 *
 * NOTE WHAT NEVER APPEARS: `report.hypotheses`. It is not read by this
 * function, at any threshold. A guess cannot page anyone.
 */
export function exitCodeForFleet(result: FleetResult): number {
  if (result.failOn === 'none') return 0
  const counts = tally(result)
  const blocking = result.failOn === 'any' ? counts.correlations + counts.agentsFailing : counts.correlations
  if (blocking > 0) return FLEET_EXIT_CORRELATED
  if (!counts.complete) return FLEET_EXIT_INDETERMINATE
  return 0
}

// ---------------------------------------------------------------------------
// Rendering — one screen, ranked, leading with what is SHARED
// ---------------------------------------------------------------------------

/** The one-line headline, in the operator's own words rather than the verdict enum's. */
function headline(result: FleetResult): string {
  const counts = tally(result)
  if (counts.correlations > 0) {
    const top = rankFleetCorrelations(result.report.correlations)[0]
    if (top === undefined) {
      return `FLEET EVENT — ${counts.correlations} observed cross-agent correlation${counts.correlations === 1 ? '' : 's'}`
    }
    // The claim and its corroboration, on the same line. `agentCount` is
    // checked against the listed and cited agents before it ever reaches here
    // (contracts' fleetReportIncoherences), but beyond
    // MAX_FLEET_CORRELATION_AGENTS it is a claim the report cannot fully
    // verify — so the number of agents the evidence actually names is stated
    // next to it rather than left for someone to go and look up.
    const cited = citedAgentCount(top)
    return (
      `FLEET EVENT — ${counts.correlations} observed cross-agent correlation${counts.correlations === 1 ? '' : 's'}; ` +
      `the broadest spans ${top.agentCount} agent${top.agentCount === 1 ? '' : 's'} ` +
      `(evidence names ${cited})`
    )
  }
  if (!counts.complete) {
    return counts.unanswered > 0
      ? `CANNOT TELL — nothing correlated, but ${counts.unanswered} question${counts.unanswered === 1 ? '' : 's'} could not be answered`
      : 'CANNOT TELL — nothing correlated, but the sweep did not finish (see SWEEP below)'
  }
  if (counts.agentsFailing > 0) {
    return `ISOLATED FAILURES — ${counts.agentsFailing} agent${counts.agentsFailing === 1 ? '' : 's'} failing, nothing observed to connect them`
  }
  return 'FLEET HEALTHY — every assessed agent ran clean, sweep complete'
}

const DISCRIMINATION_LABEL = {
  discriminating: 'DISCRIMINATING',
  not_discriminating: 'NOT DISCRIMINATING',
  base_rate_unmeasured: 'BASE RATE UNKNOWN',
} as const

/**
 * Render one hypothesis with its denominator ALWAYS ATTACHED.
 *
 * The base rate is not an optional detail line that a narrow terminal drops —
 * it is on the same line as the claim, because the claim without it reads as
 * an accusation.
 */
function renderHypothesis(hypothesis: HypothesisedCause, log: (line: string) => void): void {
  const share = hypothesis.sharedBy
  const discrimination = discriminationOf(share)
  const healthy =
    share.unaffectedSharing === null || share.unaffectedTotal === null
      ? 'healthy agents: NOT MEASURED'
      : `healthy agents sharing it: ${share.unaffectedSharing}/${share.unaffectedTotal}`
  // COMPOSED, never transmitted. The engine supplies `kind` and the shared
  // value; the interrogative frame comes from contracts, so no engine can put
  // "model m-4 is failing" on an incident screen.
  log(`    HYPOTHESIS [${hypothesis.kind}] ${hypothesisQuestion(hypothesis)}`)
  log(
    `      ${DISCRIMINATION_LABEL[discrimination]} — ${share.affectedSharing}/${share.affectedTotal} failing agents ` +
      `share it; ${healthy}${share.measurementTruncated ? ' (measurement truncated)' : ''}`
  )
  log(`      cannot be established: ${hypothesis.notEstablishedBecause}`)
  log(`      to test it: ${hypothesis.wouldBeTestedBy}`)
}

/** Render one observation, then the hypotheses that rest on it — facts first, always. */
function renderCorrelation(
  report: FleetHealthReport,
  correlation: ObservedCorrelation,
  log: (line: string) => void
): void {
  log(
    `  ${String(correlation.agentCount).padStart(4)} agents  [${correlation.kind}] ${correlation.observedFact}`
  )
  log(
    `           ${formatTimestamp(correlation.firstObservedAt)} .. ${formatTimestamp(correlation.lastObservedAt)}  |  ` +
      `${correlation.agentIds.map((id) => truncateId(id)).join(', ') || '(none listed)'}` +
      `${correlation.agentCount > correlation.agentIds.length ? ` (+${correlation.agentCount - correlation.agentIds.length} more)` : ''}`
  )
  log(
    `           evidence: ${correlation.observedBy.length} cited occurrence(s) across ` +
      `${citedAgentCount(correlation)} distinct agent(s)`
  )
  for (const hypothesis of hypothesesFor(report, correlation.correlationKey)) {
    renderHypothesis(hypothesis, log)
  }
}

/** Print a fleet result. `--json` prints the raw report and nothing else. */
export function printFleet(
  args: FleetArgs,
  result: FleetCommandResult,
  log: (line: string) => void = console.log
): void {
  if (isCommandFailure(result)) {
    log(result.message)
    return
  }

  if (args.json) {
    log(JSON.stringify(result.report, null, 2))
    return
  }

  const report = result.report
  const counts = tally(result)
  const scan = report.scan

  log(headline(result))
  log(
    `verdict: ${report.verdict}   gate: --fail-on ${result.failOn}   ` +
      `window: ${formatTimestamp(scan.since)} .. ${formatTimestamp(scan.until)}   ` +
      `burst width: ${Math.round(scan.burstWindowMs / MS_PER_MINUTE)}m`
  )
  log('')

  // OBSERVED FIRST, RANKED BY BREADTH. Recency orders only within equal
  // breadth — during an incident the most recent cluster is usually a
  // downstream symptom and the broadest is usually nearest what changed, and
  // the person reading this has about ninety seconds.
  if (report.correlations.length > 0) {
    log('OBSERVED ACROSS AGENTS — what demonstrably happened, broadest first')
    for (const correlation of rankFleetCorrelations(report.correlations)) {
      renderCorrelation(report, correlation, log)
    }
    log('')
  }

  if (report.unanswered.length > 0) {
    log('COULD NOT ANSWER — reached and left open. Not clean, not broken: unchecked.')
    for (const question of report.unanswered) {
      log(`  [${question.kind}] ${question.undecidedQuestion}`)
      log(`      could not decide: ${question.unknownBecause}`)
      if (question.remedy !== undefined) log(`      to make it answerable: ${question.remedy}`)
    }
    log('')
  }

  const troubled = report.roster.filter((entry) => entry.state === 'failing' || entry.state === 'degrading')
  const unobserved = report.roster.filter((entry) => entry.state === 'unobserved')
  if (troubled.length > 0) {
    log(`ROSTER — ${counts.agentsFailing} agent(s) failing or degrading (showing ${troubled.length} from this page)`)
    for (const entry of troubled) {
      log(
        `  ${entry.state.toUpperCase().padEnd(10)} ${truncateId(entry.agentId).padEnd(14)} ` +
          `${entry.runsFailed}/${entry.runsObserved} runs failed, ${entry.distinctFingerprints} distinct fingerprint(s)` +
          `${entry.observationTruncated ? '  [COUNTS ARE FLOORS — this agent\'s scan truncated]' : ''}` +
          `${entry.lastFailureAt === undefined ? '' : `  last ${formatTimestamp(entry.lastFailureAt)}`}`
      )
    }
    log('')
  }
  if (unobserved.length > 0) {
    // Worth its own line: an agent that stopped running entirely is invisible
    // in a failure count and is frequently the actual incident.
    log(
      `  ${unobserved.length} agent(s) had NO runs in this window. That is not a pass — nothing was tested, and an ` +
        `agent that silently stopped being invoked looks identical to a healthy one here.`
    )
    log('')
  }

  log(
    `SWEEP  ${scan.agentsAssessed} of ${scan.agentsInRoster} agents assessed  |  ` +
      `${scan.occurrencesScanned} failure occurrence(s) read  |  correlated over: ${scan.correlationBasis}` +
      `${scan.agentsUnassessable > 0 ? `  |  ${scan.agentsUnassessable} could not be assessed` : ''}` +
      `${scan.agentsSkippedForBudget > 0 ? `  |  ${scan.agentsSkippedForBudget} skipped for budget` : ''}` +
      `${scan.scanTruncated ? `  |  TRUNCATED at the server's row ceiling${scan.scanRowCeiling === undefined ? '' : ` (${scan.scanRowCeiling})`}` : ''}`
  )
  if (!scan.baseRatesMeasured) {
    log(
      '  BASE RATES NOT MEASURED — no hypothesis below can be ranked against the healthy agents. An attribute ' +
        'every healthy agent also has explains nothing, and this sweep cannot tell you which case you are in.'
    )
  }
  if (scan.correlationBasis === 'page_local') {
    log(
      '  CORRELATED OVER ONE PAGE ONLY — a cluster split across roster pages is invisible on every page and in ' +
        'any merge of them. Raise --limit so the whole roster is correlated at once.'
    )
  }
  if (scan.nextCursor !== undefined) {
    log(
      '  PAGES REMAIN — THIS IS NOT THE WHOLE FLEET. Agents after the ceiling are not agents that passed, they ' +
        'are agents unread. Raise --limit; this command does not follow the cursor, because merging page-local ' +
        'correlations produces a report about a fleet that does not exist.'
    )
  }
  if (!counts.complete) {
    log('  Agents that were not assessed are not agents that are healthy. This sweep has not cleared them.')
  }
}
