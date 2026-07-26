import { parseArgs } from 'node:util'

import {
  divergenceByDimension,
  isDivergenceAnalysisComplete,
  isFleetDivergenceAnalysisComplete,
  mergeFleetDivergenceReports,
} from '@agent-flight-recorder/sdk'

import { getAgentDivergence, getRunDivergence } from '../apiClient.js'
import { truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type {
  DivergenceReport,
  FleetDivergenceReport,
  IndeterminateDivergence,
  ProvenDivergence,
  SpeculativeDivergence,
} from '@agent-flight-recorder/sdk'

export const COMPAT_HELP = `Usage:
  afr compat <runId>  --target <agentVersionId>   [options]
  afr compat --agent <agentId> --target <agentVersionId> [options]

Can I ship this version?

Takes what a run ACTUALLY DID — its recorded event log — and asks whether the
same run would still have been possible on a different agent version. Nothing
is executed: this is a structural analysis over the stored event history and
the two versions' config snapshots, the same idea as a Temporal replay test
(run the new code against the old history, fail on divergence).

Two modes:
  ONE RUN     afr compat <runId> --target <versionId>
              Everything that version would have broken about that run.
  FLEET       afr compat --agent <agentId> --target <versionId>
              The same question across the agent's recent runs, reported as
              DISTINCT REASONS. 340 broken runs with 12 root causes is a
              tractable morning; 340 individual reports is not.

THREE KINDS OF FINDING, AND THEY ARE NOT THE SAME KIND OF THING:

  PROVEN       "the run called tool 'search_web' at sequence 42; the target
               declares no such tool." Checkable against stored data. Every
               proven finding carries the recorded event it contradicts and
               the config path that decides it. THIS IS WHAT GATES A DEPLOY.

  SPECULATIVE  "the system prompt changed, so behaviour may differ." Possibly
               the most important thing on the page. Still not evidence, and
               it can never be checked. Reported separately, never counted as
               a failure unless you explicitly ask for it.

  UNANSWERED   "the target's tool list is a string, not an array." Neither
               clean nor broken: unchecked. Never exits 0, and each one says
               what would make it answerable.

They are separate types in the contract (mutually unassignable, no shared
message field), separate arrays on the wire, separate sections here, and
separately counted in --json. There is no severity dial to conflate them with.

WHY YOU MAY SEE A LOT OF "UNDECLARED". A version's configSnapshot is free-form
by design, and a free-form blob makes no claims — so there is nothing to check
against and the honest answer is 'cannot tell'. It is fixable, and per
dimension: publish versions whose snapshot declares its tools/model/budgets
(buildAgentConfigSnapshot in @agent-flight-recorder/sdk) and this command can
prove things about those dimensions from the next publish onward. Declaring one
dimension already buys real answers about that one — see BY DIMENSION in the
output.

Options:
  --target <versionId>  REQUIRED. The agent version to test against. There is
                         no "latest" default: a gate whose subject is implicit
                         changes meaning the next time someone publishes.
  --agent <agentId>     Fleet mode. Mutually exclusive with a <runId>.
  --since-days <n>      Fleet mode only. Restrict the scan to runs started in
                         the last n days.
  --limit <n>           Fleet mode only. Max runs per scan page (server-capped).
  --max-pages <n>       Fleet mode only. How many scan pages to follow before
                         stopping (default 20). A fleet scan is a bounded batch
                         with a cursor, not one query — this command follows the
                         cursor and merges the pages. Stopping early NEVER
                         produces a pass: the outstanding cursor keeps the scan
                         incomplete, so the verdict stays 'indeterminate' and
                         the exit code is 11.
  --fail-on <what>      What makes this command fail. Default: proven.
                          proven  exit 10 on any PROVEN divergence
                          any     exit 10 on proven OR speculative findings
                          none    never exit 10 (report only)
                        The threshold in force is printed on every run, so a
                        log always says what the gate was actually checking.
  --json                Print the raw report as JSON
  --help                Show this message

WHY 'proven' IS THE DEFAULT AND 'any' IS NOT. Speculative findings fire on
every prompt edit, which is most deploys. A gate that is red on every deploy
is a gate that gets switched off within a fortnight, taking the proven
findings with it. --fail-on any is there for the teams who want it, opted into
explicitly, on the record.

EXIT CODES — THIS IS A CI GATE, READ THIS BEFORE SCRIPTING IT:
  0   ship it        — nothing at or above the threshold, and the analysis was
                       COMPLETE
  10  do not ship    — findings at or above --fail-on
  11  cannot tell    — nothing found, but the analysis did not finish: a config
                       dimension was never declared or could not be read, the
                       event history was truncated, runs were skipped, the
                       fleet scan hit the server's row ceiling, or PAGES REMAIN.
                       "Nothing found" is not evidence of safety when you did
                       not finish looking.

                       A PARTIAL FLEET SCAN IS NEVER A PASS. The scan pages;
                       an outstanding cursor keeps the merged scan incomplete,
                       so a first page can never exit 0 no matter how clean it
                       looks. Read the BY DIMENSION table to see what WAS
                       established — a dimension the target never declared
                       shows as UNDECLARED and is fixable by publishing a
                       structured configSnapshot, not by ignoring the verdict.
  1   usage (bad flags, missing AFR_API_KEY/AFR_BASE_URL)
  2   auth (401/403)     3  not found (404)     4  network/rate-limit/server

  10 WINS OVER 11 when both apply. A proof does not become less true because
  something else went unchecked, so a proven divergence in a partial analysis
  is still 'do not ship' — never downgraded to 'cannot tell'.

  EXIT 0 IS UNREACHABLE ON AN INCOMPLETE ANALYSIS, with --fail-on proven or
  any. It is reachable with --fail-on none, which is not a gate and says so.

  Exit 4 covers one case worth knowing about: the SDK refuses a report it
  cannot verify — one that came back about a different version than the one
  requested (an older deployment silently drops an unknown query parameter and
  answers about the run's own version, against which every recorded run is
  trivially compatible), one with no coverage record, one serving a
  speculative finding inside the proven list, or one whose verdict contradicts
  its own findings. All four look exactly like a clean bill of health to a
  caller that trusts the response. None of them exits 0 here.

Scripting it in CI:
  afr compat --agent ag_123 --target ver_456          # blocks on proven divergence
  afr compat --agent ag_123 --target ver_456 --json   # 'verdict', 'provenReasons'

Server support: the divergence read endpoints are not wired yet. Until they
are, this command exits 3 (not found).
`

/** Findings at or above the threshold. Above the 0-4 band so it can never collide with a transport failure. */
export const COMPAT_EXIT_DIVERGENCE = 10
/** Nothing found, but the analysis did not finish — "nothing found" is not an answer here. */
export const COMPAT_EXIT_INDETERMINATE = 11

/** What makes this command fail. Always explicit in the output, never inferred silently. */
export type CompatFailOn = 'proven' | 'any' | 'none'

const VALID_FAIL_ON: readonly CompatFailOn[] = ['proven', 'any', 'none']

/** The default threshold. See COMPAT_HELP for why it is not `any`. */
export const DEFAULT_FAIL_ON: CompatFailOn = 'proven'

const MS_PER_DAY = 86_400_000

/**
 * How many scan pages `--agent` follows before stopping.
 *
 * A ceiling is required — an unbounded loop in a CI step is a hung build — but
 * it must never be the reason a build goes green. Stopping here leaves the last
 * page's `nextCursor` in the merged window, which makes the scan incomplete,
 * which makes the verdict `indeterminate`, which is exit 11. The bound costs a
 * conclusive answer, never a correct one.
 */
export const DEFAULT_MAX_PAGES = 20

export interface CompatArgs {
  /** Positional run id — single-run mode. */
  runId?: string
  /** `--agent` — fleet mode. Mutually exclusive with `runId`. */
  agent?: string
  target?: string
  sinceDays?: number
  limit?: number
  /** Fleet mode: how many scan pages to follow before giving up and reporting the scan incomplete. */
  maxPages?: number
  /** Raw `--fail-on` value, as typed — validated by `resolveFailOn` before use. */
  failOn?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr compat` flags (argv AFTER `compat`). */
export function parseCompatArgs(argv: string[]): CompatArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      target: { type: 'string' },
      'since-days': { type: 'string' },
      limit: { type: 'string' },
      'max-pages': { type: 'string' },
      'fail-on': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: CompatArgs = {}
  if (positionals[0]) result.runId = positionals[0]
  if (values['agent']) result.agent = values['agent']
  if (values['target']) result.target = values['target']
  if (values['since-days']) result.sinceDays = Number(values['since-days'])
  if (values['limit']) result.limit = Number(values['limit'])
  if (values['max-pages']) result.maxPages = Number(values['max-pages'])
  if (values['fail-on']) result.failOn = values['fail-on']
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

/**
 * Validate `--fail-on` against the closed set, same posture as `afr patterns`'
 * `--status`: an unknown value is a usage error (exit 1), never silently
 * treated as the default. A typo (`--fail-on proben`) that quietly fell back
 * to the default would be harmless today and catastrophic the day someone
 * types `--fail-on any` wrong and believes they are gating on it.
 */
function resolveFailOn(args: CompatArgs): CompatFailOn | CommandFailure {
  if (args.failOn === undefined) return DEFAULT_FAIL_ON
  if (!(VALID_FAIL_ON as readonly string[]).includes(args.failOn)) {
    return {
      ok: false,
      exitCode: 1,
      message: `--fail-on must be one of ${VALID_FAIL_ON.join(', ')} — got "${args.failOn}".`,
    }
  }
  return args.failOn as CompatFailOn
}

/** A successful single-run analysis. */
export interface CompatRunResult {
  ok: true
  mode: 'run'
  failOn: CompatFailOn
  report: DivergenceReport
}

/** A successful fleet analysis, merged from however many pages were fetched. */
export interface CompatFleetResult {
  ok: true
  mode: 'fleet'
  failOn: CompatFailOn
  report: FleetDivergenceReport
  /** How many scan pages were fetched and merged. Printed, so a partial scan is visible and not just encoded in the exit code. */
  pagesFetched: number
}

export type CompatCommandResult = CompatRunResult | CompatFleetResult | CommandFailure

/**
 * `afr compat` — "can I ship this version?", answered from recorded history.
 *
 * @param args - parsed flags.
 * @param env - CLI environment (injectable for tests).
 * @param fetchImpl - injectable fetch (tests never touch the network).
 * @param now - the clock, injected so `--since-days` is deterministic in tests.
 */
export async function runCompat(
  args: CompatArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike,
  now: number = Date.now()
): Promise<CompatCommandResult> {
  // Mode resolution first: a request that names both a run and an agent, or
  // neither, is not something to resolve one way silently — either choice
  // answers a question the operator did not ask.
  if (args.runId !== undefined && args.agent !== undefined) {
    return {
      ok: false,
      exitCode: 1,
      message:
        'Pass either a <runId> or --agent <agentId>, not both — one asks about a single recorded run, the other about an agent\'s recent history.',
    }
  }
  if (args.runId === undefined && args.agent === undefined) {
    return {
      ok: false,
      exitCode: 1,
      message: "Usage: afr compat <runId> --target <versionId>, or afr compat --agent <agentId> --target <versionId>.",
    }
  }
  if (!args.target) {
    return {
      ok: false,
      exitCode: 1,
      message:
        '--target <agentVersionId> is required. There is deliberately no "latest version" default: a gate whose subject is implicit silently changes meaning the next time someone publishes a version.',
    }
  }
  if (args.runId !== undefined && (args.sinceDays !== undefined || args.limit !== undefined)) {
    return {
      ok: false,
      exitCode: 1,
      message:
        '--since-days and --limit apply to the fleet scan (--agent) only. A single run is analysed whole; a window over it would silently narrow what was checked.',
    }
  }
  if (args.sinceDays !== undefined && (!Number.isFinite(args.sinceDays) || args.sinceDays <= 0)) {
    return { ok: false, exitCode: 1, message: `--since-days must be a positive number of days — got "${args.sinceDays}".` }
  }

  const failOn = resolveFailOn(args)
  if (isCommandFailure(failOn)) return failOn

  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    if (args.runId !== undefined) {
      const data = await getRunDivergence(config, args.runId, { targetVersionId: args.target }, fetchImpl)
      return { ok: true, mode: 'run', failOn, report: data.report }
    }
    const agentId = args.agent ?? ''
    const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES
    const base = {
      targetVersionId: args.target,
      ...(args.sinceDays !== undefined && { since: Math.floor(now - args.sinceDays * MS_PER_DAY) }),
      ...(args.limit !== undefined && { limit: args.limit }),
    }

    // A FLEET SCAN IS A BOUNDED BATCH WITH A CURSOR, so a fleet ANSWER is
    // assembled from pages here rather than assumed to arrive whole. Stopping
    // at page one and reporting it would be the worst bug this command can
    // have: the twelfth reason, on the run that matters, is on page four, and
    // a clean first page looks exactly like a clean fleet.
    //
    // Running out of pages is NOT quietly tolerated either. The last page's
    // `nextCursor` survives into the merged window, `isFleetScanComplete`
    // counts an outstanding cursor as incomplete, and the verdict is therefore
    // `indeterminate` -> exit 11. Raising `--max-pages` is the operator's
    // decision to make, and they are told to make it.
    const pages = []
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const data = await getAgentDivergence(
        config,
        agentId,
        { ...base, ...(cursor !== undefined && { cursor }) },
        fetchImpl
      )
      pages.push(data.report)
      const next = data.report.window.nextCursor
      if (next === undefined) break
      if (next === cursor) {
        // The server handed back the cursor it was just given. Looping on a
        // stalled cursor would hang a CI job forever; the same guard
        // `iterateEvents` applies, for the same reason.
        return {
          ok: false,
          exitCode: 4,
          message: `afr compat --agent ${agentId}: the server returned a non-advancing scan cursor ("${next}") — refusing to loop forever.`,
        }
      }
      cursor = next
    }

    // The merge is contracts' — one implementation, shared with every other
    // surface that assembles pages, because a CLI that added up reasons
    // differently from the web UI would be two answers to one question.
    return { ok: true, mode: 'fleet', failOn, report: mergeFleetDivergenceReports(pages), pagesFetched: pages.length }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** The four numbers every gate decision is made from, for either mode. */
interface CompatTally {
  proven: number
  speculative: number
  /** Questions the analysis could not answer. Each one is a reason `complete` is false. */
  indeterminate: number
  /**
   * From contracts' single completeness definition — NOT recomputed here. It
   * folds in both ways of not having looked (an unreached dimension and an
   * unanswerable question), and it is the same predicate the web UI and the
   * MCP projection use. A local re-derivation is how a gate and a dashboard
   * come to disagree about whether a version ships.
   */
  complete: boolean
}

function tally(result: CompatRunResult | CompatFleetResult): CompatTally {
  if (result.mode === 'run') {
    return {
      proven: result.report.proven.length,
      speculative: result.report.speculative.length,
      indeterminate: result.report.indeterminate.length,
      complete: isDivergenceAnalysisComplete(result.report),
    }
  }
  return {
    proven: result.report.provenReasons.length,
    speculative: result.report.speculativeReasons.length,
    indeterminate: result.report.indeterminateReasons.length,
    complete: isFleetDivergenceAnalysisComplete(result.report),
  }
}

/**
 * Process exit code for a completed analysis.
 *
 * COMPUTED FROM THE REPORT'S CONTENTS, NOT FROM THE SERVER'S `verdict` STRING,
 * and the distinction is the point. `verdict` is a summary a server produced;
 * the arrays and the coverage record are the facts it summarised. `FlightReader`
 * already refuses a response whose verdict disagrees with its own contents, so
 * the two can only ever say the same thing — which is exactly why deriving the
 * gate from the facts costs nothing and removes a whole class of "the string
 * said compatible" failure.
 *
 * Order of precedence:
 *  1. `--fail-on none` short-circuits to 0. It is not a gate and its help text
 *     says so; pretending otherwise would make the flag useless.
 *  2. Findings at or above the threshold -> 10, EVEN IF the analysis was
 *     incomplete. A proof does not weaken because something else went
 *     unchecked; downgrading it to "cannot tell" would let a partial analysis
 *     hide a certainty.
 *  3. Incomplete analysis -> 11. This is the false-clean case, and it is the
 *     only reason this command has an eleventh exit code at all.
 *  4. Otherwise 0.
 */
export function exitCodeForCompat(result: CompatRunResult | CompatFleetResult): number {
  if (result.failOn === 'none') return 0
  const counts = tally(result)
  const blocking = result.failOn === 'any' ? counts.proven + counts.speculative : counts.proven
  if (blocking > 0) return COMPAT_EXIT_DIVERGENCE
  if (!counts.complete) return COMPAT_EXIT_INDETERMINATE
  return 0
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderProven(finding: ProvenDivergence, log: (line: string) => void): void {
  log(`  [${finding.kind}] ${finding.provenClaim}`)
  for (const proof of finding.provenBy) {
    log(
      `      seq ${proof.citedEvent.sequenceNumber} ${proof.citedEvent.eventType} — recorded ` +
        `${JSON.stringify(proof.recordedValue)}; target ${proof.targetConfigPath} = ` +
        `${proof.targetValue === null ? '(absent)' : JSON.stringify(proof.targetValue)}`
    )
  }
}

function renderSpeculative(finding: SpeculativeDivergence, log: (line: string) => void): void {
  log(`  [${finding.kind}] ${finding.speculativeConcern}`)
  log(`      changed: ${finding.changedConfigPath}`)
  log(`      not provable: ${finding.speculativeBecause}`)
}

function renderIndeterminate(finding: IndeterminateDivergence, log: (line: string) => void): void {
  log(`  [${finding.kind}] ${finding.undecidedQuestion}`)
  log(`      dimension: ${finding.dimension}`)
  log(`      could not decide: ${finding.unknownBecause}`)
}

/** The one-line headline, in the operator's own words rather than the verdict enum's. */
function headline(result: CompatRunResult | CompatFleetResult): string {
  const counts = tally(result)
  if (counts.proven > 0) {
    return result.mode === 'run'
      ? `DO NOT SHIP — ${counts.proven} proven divergence${counts.proven === 1 ? '' : 's'}: this run could not have happened on ${result.report.targetVersionId}`
      : `DO NOT SHIP — ${counts.proven} distinct proven reason${counts.proven === 1 ? '' : 's'} across ${result.report.runsWithProvenDivergence} run${result.report.runsWithProvenDivergence === 1 ? '' : 's'}`
  }
  if (!counts.complete) {
    return counts.indeterminate > 0
      ? `CANNOT TELL — nothing proven, but ${counts.indeterminate} question${counts.indeterminate === 1 ? '' : 's'} could not be answered`
      : 'CANNOT TELL — nothing proven, but the analysis did not finish (see COVERAGE below)'
  }
  if (counts.speculative > 0) {
    return `SHIPPABLE, WITH CAVEATS — nothing proven; ${counts.speculative} speculative change${counts.speculative === 1 ? '' : 's'} to be aware of`
  }
  return 'SHIP IT — nothing proven, nothing speculative, analysis complete'
}

/** Print a compat result. `--json` prints the raw report and nothing else. */
export function printCompat(args: CompatArgs, result: CompatCommandResult, log: (line: string) => void = console.log): void {
  if (isCommandFailure(result)) {
    log(result.message)
    return
  }

  if (args.json) {
    log(JSON.stringify(result.report, null, 2))
    return
  }

  const counts = tally(result)
  log(headline(result))
  log(`verdict: ${result.report.verdict}   gate: --fail-on ${result.failOn}   target: ${result.report.targetVersionId}`)
  log('')

  if (result.mode === 'run') {
    const report = result.report
    if (report.proven.length > 0) {
      log(`PROVEN — this run could not have happened on ${report.targetVersionId}`)
      for (const finding of report.proven) renderProven(finding, log)
      log('')
    }
    if (report.indeterminate.length > 0) {
      log('COULD NOT ANSWER — these questions were reached and left open. Not clean, not broken: unchecked.')
      for (const finding of report.indeterminate) renderIndeterminate(finding, log)
      log('')
    }
    if (report.speculative.length > 0) {
      log('SPECULATIVE — behaviour may differ. NOT evidence; nothing here says the run would have failed.')
      for (const finding of report.speculative) renderSpeculative(finding, log)
      log('')
    }
    // PER-DIMENSION, ALWAYS — a single `indeterminate` at the top tells an
    // operator nothing about what WAS established, and a verdict that reads as
    // a shrug is one people learn to click past. This table is what makes a
    // partial analysis actionable: it says which dimensions were proven
    // broken, which were genuinely cleared, and which nobody ever declared.
    log('BY DIMENSION')
    for (const outcome of divergenceByDimension(report)) {
      const detail =
        outcome.state === 'undeclared'
          ? 'the target version declares nothing here — publish a structured configSnapshot to make it checkable'
          : `${outcome.provenCount} proven, ${outcome.speculativeCount} speculative, ${outcome.indeterminateCount} unanswered`
      log(`  ${outcome.dimension.padEnd(16)} ${outcome.state.toUpperCase().padEnd(14)} ${detail}`)
    }
    log('')
    log(
      `COVERAGE  events examined: ${report.coverage.eventsExamined}` +
        `${report.coverage.eventHistoryComplete ? '' : ' (HISTORY TRUNCATED)'}`
    )
    for (const gap of report.coverage.unassessed) {
      log(`  NOT ASSESSED  ${gap.dimension} — ${gap.reason}${gap.detail === undefined ? '' : ` (${gap.detail})`}`)
    }
    if (!counts.complete) {
      log('  An unassessed dimension is not a clean one. Nothing above rules out a divergence there.')
      if (divergenceByDimension(report).some((d) => d.state === 'undeclared')) {
        log(
          `  Most of these are fixable: a version whose configSnapshot declares its tools/model/budgets ` +
            `(buildAgentConfigSnapshot in @agent-flight-recorder/sdk) is analysable on those dimensions from ` +
            `its next publish onward. Declaring even one dimension is worth doing — coverage is per-dimension.`
        )
      }
    }
    return
  }

  const report = result.report
  if (report.provenReasons.length > 0) {
    log('PROVEN REASONS — distinct root causes, most-affecting first')
    for (const reason of report.provenReasons) {
      log(
        `  ${String(reason.affectedRunCount).padStart(5)} runs  [${reason.kind}] ${reason.exemplar.provenClaim}`
      )
      log(`         e.g. ${reason.representativeRunIds.map((id) => truncateId(id)).join(', ') || '(none listed)'}`)
    }
    log('')
  }
  if (report.indeterminateReasons.length > 0) {
    log('COULD NOT ANSWER — distinct questions this scan left open. These runs are not cleared.')
    for (const reason of report.indeterminateReasons) {
      log(`  ${String(reason.affectedRunCount).padStart(5)} runs  [${reason.kind}] ${reason.exemplar.undecidedQuestion}`)
      log(`         could not decide: ${reason.exemplar.unknownBecause}`)
    }
    log('')
  }
  if (report.speculativeReasons.length > 0) {
    log('SPECULATIVE REASONS — behaviour may differ. NOT evidence.')
    for (const reason of report.speculativeReasons) {
      log(`  ${String(reason.affectedRunCount).padStart(5)} runs  [${reason.kind}] ${reason.exemplar.speculativeConcern}`)
      log(`         not provable: ${reason.exemplar.speculativeBecause}`)
    }
    log('')
  }
  log(
    `SCAN  ${report.window.runsAnalyzed} of ${report.window.runsScanned} runs analysed over ` +
      `${result.pagesFetched} page${result.pagesFetched === 1 ? '' : 's'}` +
      `${report.window.since === undefined ? '' : ` since ${new Date(report.window.since).toISOString()}`}` +
      `${report.window.runsUnassessable > 0 ? `  |  ${report.window.runsUnassessable} could not be analysed` : ''}` +
      `${report.window.runsSkippedForBudget > 0 ? `  |  ${report.window.runsSkippedForBudget} skipped for budget` : ''}` +
      `${report.window.scanTruncated ? `  |  SCAN TRUNCATED at the server's row ceiling${report.window.scanRowCeiling === undefined ? '' : ` (${report.window.scanRowCeiling})`}` : ''}`
  )
  if (report.window.nextCursor !== undefined) {
    // The line that stops a first page being read as a fleet verdict. It is
    // stated in words as well as in the exit code, because the person reading
    // a CI log is not the person who wrote the exit-code table.
    log(
      `  PAGES REMAIN after ${result.pagesFetched} page(s) — THIS IS NOT THE WHOLE FLEET. Reasons on the ` +
        `unscanned runs are not absent, they are unread. Re-run with --max-pages higher (default ` +
        `${DEFAULT_MAX_PAGES}) to finish the scan.`
    )
  }
  if (!counts.complete) {
    log('  Runs that were not analysed are not runs that passed. This scan has not cleared them.')
  }
}
