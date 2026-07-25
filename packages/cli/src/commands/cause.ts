import { parseArgs } from 'node:util'

import {
  convergencePoints,
  cycleReEntries,
  DEFAULT_CAUSAL_MAX_DEPTH,
  downstreamRunCount,
  edgesInto,
  edgesOutOf,
  isCausalTraversalComplete,
  lostTrails,
  originStatement,
  recordedOrigins,
  suspicionQuestion,
} from '@agent-flight-recorder/sdk'

import { getCausalTrace } from '../apiClient.js'
import { formatTimestamp, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { CausalDirection, CausalTraversal, RecordedCausalEdge } from '@agent-flight-recorder/sdk'

export const CAUSE_HELP = `Usage: afr cause <runId> [options]

What caused this run, and what did it break?

Runs are islands in every other view here: 'runs get' shows one run failing for
reasons that are not in it. This command walks the RECORDED causal graph — up
to what produced this run's input, down to what consumed its output, or outward
to the whole connected component for an incident.

EVERY EDGE WAS RECORDED, NEVER INFERRED. This is the rule the command is built
around and the reason to trust an arrow it draws:

  RECORDED    run_b's log records reading artifact 4f2a, and run_a's log
              records writing it, same SHA-256. A handoff somebody wrote down
              at the moment it happened. THIS IS THE ONLY THING WALKED.

  SUSPECTED   run_a and run_b ran ninety seconds apart in the same session.
              A coincidence. Two runs adjacent in time, sharing a session, or
              touching the same resource are NOT thereby causally linked.

Suspected links are printed in their own section, AS QUESTIONS, WITH NO
DIRECTION — because direction is exactly the thing that cannot be inferred.
"These two runs are related" is sometimes computable; "this one caused that
one" never is. The contract gives a suspicion no from/to field of any name, so
it is not merely marked do-not-walk, it is unwalkable. Each one prints what
INSTRUMENTATION would turn it into a real edge, which is the actual fix.

A SUSPECTED LINK CAN NEVER CHANGE THE EXIT CODE, and there is no flag to make
it. --fail-on has no setting that fires on a coincidence.

THREE WAYS A WALK ENDS, AND ONLY ONE OF THEM MEANS YOU ARE NOT FINISHED:

  ORIGIN      "The recorded chain starts at run_a." Its complete edge set was
              read and it is empty. Investigation over — go read run_a.

  LOOP        "The chain loops: run_a -> run_b -> run_a." A retry loop or a
              supervisor pattern. The walk closed the loop and read everything
              it meant to, so this frontier is FINISHED — there is simply no
              earlier run to go and read. Reporting this as a lost trail would
              mean no retry chain could ever exit 0.

  TRAIL LOST  "We lost the trail at run_a." The depth limit bit, the budget ran
              out, the producing run aged out of retention, a convergence was
              not expanded, or the adjacency read could not be confirmed
              complete. The chain very likely continues; WE stopped following
              it. THIS IS THE ONLY ONE THAT MEANS INCOMPLETE.

THE LAST IS THE COMMON CASE IN PRODUCTION, because the SDK may simply never
have recorded the edge. All three are different types in the contract, sharing
no field but their discriminant — 'originRunId ?? lastReachedRunId' does not
compile — so nothing here can print a lost trail under an "Origin:" heading.
AND NOTE WHAT AN ORIGIN STILL DOES NOT MEAN: it is the origin of what was
RECORDED, not a root cause. An uninstrumented handoff is invisible to any walk,
however complete.

FAN-IN IS SHOWN, NOT TERMINATED ON. A run that consumed several upstream
outputs has several stories, and reading only the first is how the wrong thing
gets rolled back — so convergence points are listed explicitly. They are not a
kind of ending: the walk continues through every producer, and each of those
branches ends in one of the three ways above. A walk that STOPS at a
convergence without expanding it is a LOST TRAIL, because the chain provably
continues in N directions nobody read.

Options:
  --direction <d>   up | down | both. REQUIRED — there is deliberately no
                    default. "What caused this" and "what did this break" are
                    opposite questions, and a monitoring loop that gets the
                    other one gets a well-formed answer to a question it did
                    not ask.
                      up    what produced this run's input
                      down  what consumed this run's output (blast radius)
                      both  the whole connected component — the incident
  --max-depth <n>   Hop ceiling. Default ${DEFAULT_CAUSAL_MAX_DEPTH}. Sent to the server and VERIFIED
                    on the way back; a deployment that drops it walks to its own
                    default and reports "depth limit reached" at a depth nobody
                    chose. That mismatch is refused (exit 4), never rendered.
  --limit <n>       Max nodes in the page (server-capped).
  --fail-on <what>  What makes this command fail. Default: none.
                      downstream  exit 10 if any run consumed this run's output
                      none        never exit 10 (report only)
                    There is no setting that fires on a suspected link.
  --json            Print the raw traversal as JSON
  --help            Show this message

EXIT CODES — READ THIS BEFORE SCRIPTING IT:
  0   complete trace  — EVERY frontier finished (an established origin, or a
                        closed loop), and nothing at or above --fail-on
  10  impact          — runs consumed this run's output (--fail-on downstream)
  11  truncated       — THE TRAIL WAS LOST somewhere, or the walk did not
                        finish: depth limit, budget, an unreadable adjacency, a
                        sampled edge set, pages remaining, or an open question.
                        The trace you are looking at is partial.
  1   usage (bad flags, missing AFR_API_KEY/AFR_BASE_URL)
  2   auth (401/403)     3  not found (404)     4  network/rate-limit/server

  A BOUNDED TRAVERSAL NEVER BUYS A CLEAN EXIT. One lost trail anywhere in the
  graph makes the whole trace incomplete — however many other branches ended
  cleanly — because your question is not answered by the branches that
  terminated, it is answered by the one that did not. A CLOSED LOOP IS NOT A
  LOST TRAIL and does not cost you exit 0: the walk read everything it meant to.

  --fail-on none DOES NOT SILENCE EXIT 11, AND THIS IS A DELIBERATE DIFFERENCE
  FROM 'afr fleet', where --fail-on none does reach exit 0 on an incomplete
  sweep. There, 'none' turns off an ALARM and says so. Here, exit 11 is not a
  threshold — it is the statement "this answer is partial", which is the
  primary product of a tracing command rather than a gate bolted onto it.
  There is no flag to turn it off, because a partial trace presented as a
  finished one is the one output that ends an investigation on the wrong run.

  10 WINS OVER 11 when both apply. A run that consumed this one's output did so
  whether or not some other branch went unread, and suppressing the impact
  signal because the graph was cut short would silence it precisely when the
  graph is largest — which is during the incident. THE DOWNSTREAM COUNT IS
  THEN A FLOOR, and it is printed as one.

  Exit 4 covers the refusals worth knowing about: the SDK will not return a
  traversal it cannot verify — one walked in the wrong direction, one with no
  scan record, one serving a suspected link in the edge list, one whose
  suspicion carries a direction or a prose headline, one whose edge cites a
  record written in neither of its endpoints, one claiming an ARTIFACT HANDOFF
  with no recorded read by the consumer (a matching SHA-256 found by joining
  two runs' artifact rows is a coincidence, not a handoff — however exact the
  match), ONE CLAIMING AN ORIGIN WITH NO PROOF BEHIND IT, one claiming a LOOP
  whose path does not close, or one reporting no frontiers at all. Several of
  those look like a finished trace.

Scripting it:
  afr cause run_abc --direction up               # what caused this failure
  afr cause run_abc --direction down --fail-on downstream   # what did it break
  afr cause run_abc --direction both --json      # the whole incident, raw
`

/** Runs consumed the subject's output, at or above the threshold. Above the 0-4 band so it can never collide with a transport failure. */
export const CAUSE_EXIT_IMPACT = 10
/**
 * The trail was lost, or the walk did not finish.
 *
 * NOT SUPPRESSIBLE BY `--fail-on none`. See {@link exitCodeForCause}.
 */
export const CAUSE_EXIT_TRUNCATED = 11

/**
 * What makes this command fail with exit 10.
 *
 * NOTE WHAT IS ABSENT AND CANNOT BE ADDED WITHOUT A CONTRACT CHANGE: there is
 * no value that fires on a {@link SuspectedLink}. `computeCausalVerdict` does
 * not accept a suspected-link count, so there is nothing for such a threshold
 * to read.
 */
export type CauseFailOn = 'downstream' | 'none'

const VALID_FAIL_ON: readonly CauseFailOn[] = ['downstream', 'none']

/** The default threshold. Tracing is the primary use; impact gating is opt-in. */
export const DEFAULT_CAUSE_FAIL_ON: CauseFailOn = 'none'

/** `--direction` as an operator types it, mapped to the contract's vocabulary. */
const DIRECTION_ALIASES: Record<string, CausalDirection> = {
  up: 'upstream',
  upstream: 'upstream',
  down: 'downstream',
  downstream: 'downstream',
  both: 'component',
  component: 'component',
}

export interface CauseArgs {
  runId?: string
  /** Raw `--direction` value, as typed — validated by `resolveDirection` before use. */
  direction?: string
  maxDepth?: number
  limit?: number
  /** Raw `--fail-on` value, as typed. */
  failOn?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr cause` flags (argv AFTER `cause`). */
export function parseCauseArgs(argv: string[]): CauseArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      direction: { type: 'string', short: 'd' },
      'max-depth': { type: 'string' },
      limit: { type: 'string' },
      'fail-on': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: CauseArgs = {}
  if (positionals[0] !== undefined) result.runId = positionals[0]
  if (values['direction']) result.direction = values['direction']
  if (values['max-depth']) result.maxDepth = Number(values['max-depth'])
  if (values['limit']) result.limit = Number(values['limit'])
  if (values['fail-on']) result.failOn = values['fail-on']
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

/**
 * Validate `--direction`. REQUIRED, with no default, and an unknown value is a
 * usage error rather than a silent fallback.
 *
 * A defaulted direction is the specific bug this guards: the two directions
 * answer opposite questions, both produce well-formed output, and a script that
 * got the other one has no way to tell — it just reads a confident trace of the
 * wrong half of the graph.
 */
function resolveDirection(args: CauseArgs): CausalDirection | CommandFailure {
  if (args.direction === undefined) {
    return {
      ok: false,
      exitCode: 1,
      message:
        `--direction is required (up | down | both). There is deliberately no default: "what caused this" and ` +
        `"what did this break" are opposite questions, and both produce a well-formed trace — a script that got ` +
        `the other one has nothing on screen to tell it so.`,
    }
  }
  const resolved = DIRECTION_ALIASES[args.direction]
  if (resolved === undefined) {
    return {
      ok: false,
      exitCode: 1,
      message: `--direction must be one of up, down, both — got "${args.direction}".`,
    }
  }
  return resolved
}

/** Validate `--fail-on` against the closed set — an unknown value is a usage error, never the default. */
function resolveFailOn(args: CauseArgs): CauseFailOn | CommandFailure {
  if (args.failOn === undefined) return DEFAULT_CAUSE_FAIL_ON
  if (!(VALID_FAIL_ON as readonly string[]).includes(args.failOn)) {
    return {
      ok: false,
      exitCode: 1,
      message:
        `--fail-on must be one of ${VALID_FAIL_ON.join(', ')} — got "${args.failOn}". ` +
        `Note there is deliberately no threshold that fires on a suspected link: two runs adjacent in time are ` +
        `not causally linked, and paging on a coincidence sends someone to an innocent run.`,
    }
  }
  return args.failOn as CauseFailOn
}

/** A successful walk. */
export interface CauseResult {
  ok: true
  failOn: CauseFailOn
  direction: CausalDirection
  traversal: CausalTraversal
}

export type CauseCommandResult = CauseResult | CommandFailure

/**
 * `afr cause` — walk the recorded causal graph around one run.
 *
 * @param args - parsed flags.
 * @param env - CLI environment (injectable for tests).
 * @param fetchImpl - injectable fetch (tests never touch the network).
 */
export async function runCause(
  args: CauseArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<CauseCommandResult> {
  if (args.runId === undefined || args.runId.length === 0) {
    return { ok: false, exitCode: 1, message: 'afr cause requires a run id: afr cause <runId> --direction up' }
  }
  const direction = resolveDirection(args)
  if (isCommandFailure(direction)) return direction

  const maxDepth = args.maxDepth ?? DEFAULT_CAUSAL_MAX_DEPTH
  if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
    return { ok: false, exitCode: 1, message: `--max-depth must be a positive integer — got "${args.maxDepth}".` }
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    return { ok: false, exitCode: 1, message: `--limit must be a positive integer — got "${args.limit}".` }
  }

  const failOn = resolveFailOn(args)
  if (isCommandFailure(failOn)) return failOn

  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    const data = await getCausalTrace(
      config,
      { runId: args.runId, direction, maxDepth, ...(args.limit !== undefined && { limit: args.limit }) },
      fetchImpl
    )
    // Deliberately ONE request. Paging lists the NODES of a graph the engine
    // already walked whole; it is not a way to assemble a traversal out of
    // fragments. An outstanding cursor keeps the trace incomplete.
    return { ok: true, failOn, direction, traversal: data.traversal }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** The numbers every gate decision is made from. */
interface CauseTally {
  /** RECORDED edges. The only class the exit code can see. */
  edges: number
  /** Runs downstream of the subject. A FLOOR when `complete` is false. */
  downstream: number
  /** Frontiers where the trail was lost. Each one is a reason `complete` is false. */
  lost: number
  /** Questions the walk could not answer. */
  unanswered: number
  /**
   * From contracts' single completeness definition — NOT recomputed here. It
   * folds in every way of not having finished (a lost trail on any frontier,
   * the row ceiling, a sampled edge set, an outstanding cursor, an open
   * question, an unreadable gate collection), and it is the same predicate the
   * web UI and the MCP projection use. A local re-derivation is how a
   * monitoring loop and a graph view come to disagree about whether a trace is
   * finished.
   */
  complete: boolean
}

function tally(result: CauseResult): CauseTally {
  return {
    edges: result.traversal.edges.length,
    downstream: downstreamRunCount(result.traversal),
    lost: lostTrails(result.traversal).length,
    unanswered: result.traversal.unanswered.length,
    complete: isCausalTraversalComplete(result.traversal),
  }
}

/**
 * Process exit code for a completed walk.
 *
 * COMPUTED FROM THE TRAVERSAL'S CONTENTS, NOT FROM THE SERVER'S `verdict`
 * STRING. `FlightReader` already refuses a response whose verdict disagrees
 * with its own contents, so the two can only ever say the same thing — which is
 * exactly why deriving the gate from the facts costs nothing and removes a whole
 * class of "the string said complete" failure.
 *
 * Order of precedence:
 *  1. Impact at or above the threshold -> 10, EVEN IF the trace was truncated.
 *     A run that consumed this one's output did so whether or not another
 *     branch went unread, and truncation is likeliest when the graph is
 *     largest. The count is then a FLOOR, and {@link printCause} says so on the
 *     same line as the number.
 *  2. Incomplete trace -> 11. A lost trail anywhere, a truncated scan, a
 *     sampled edge set, an outstanding cursor, or an open question.
 *  3. Otherwise 0.
 *
 * NOTE WHAT `--fail-on none` DOES AND DOES NOT DO. It removes step 1 — there is
 * no impact alarm. IT DOES NOT REACH EXIT 0 ON A TRUNCATED TRACE, and that is a
 * deliberate divergence from `exitCodeForFleet`, where `--fail-on none`
 * short-circuits to 0. The difference is what the two commands are for: `afr
 * fleet` is an alarm, and `none` turns the alarm off. `afr cause` is a TRACING
 * command, and "this answer is partial" is its primary output rather than a
 * gate bolted onto it. A partial trace presented as a finished one ends an
 * investigation on the wrong run, so there is no flag that buys it a clean exit.
 *
 * NOTE ALSO WHAT NEVER APPEARS: `traversal.suspected`. It is not read by this
 * function, at any threshold. A coincidence cannot page anyone.
 */
export function exitCodeForCause(result: CauseResult): number {
  const counts = tally(result)
  if (result.failOn === 'downstream' && counts.downstream > 0) return CAUSE_EXIT_IMPACT
  if (!counts.complete) return CAUSE_EXIT_TRUNCATED
  return 0
}

// ---------------------------------------------------------------------------
// Rendering — facts first, then the honest gaps, then the coincidences
// ---------------------------------------------------------------------------

/** The one-line headline, in the operator's own words rather than the verdict enum's. */
function headline(result: CauseResult): string {
  const counts = tally(result)
  const subject = truncateId(result.traversal.subjectRunId)
  if (counts.edges === 0) {
    return counts.complete
      ? `NO RECORDED CHAIN — nothing recorded produced or consumed ${subject}'s work, and the walk finished`
      : `CANNOT TELL — no edges found, but the walk did not finish (see WALK below). "Found nothing" is not "there is nothing".`
  }
  const direction =
    result.direction === 'upstream' ? 'upstream' : result.direction === 'downstream' ? 'downstream' : 'in this component'
  const floor = counts.complete ? '' : ' (AT LEAST — the trace is partial)'
  return (
    `CHAIN RECORDED — ${counts.edges} recorded edge(s) ${direction} of ${subject}` +
    (result.direction === 'upstream' ? '' : `; ${counts.downstream} run(s) consumed its output${floor}`)
  )
}

/** Render one recorded edge with the record it rests on. */
function renderEdge(edge: RecordedCausalEdge, indent: string, log: (line: string) => void): void {
  log(`${indent}${truncateId(edge.producerRunId)} --[${edge.kind}]--> ${truncateId(edge.consumerRunId)}`)
  log(`${indent}  ${edge.recordedFact}`)
  log(
    `${indent}  recorded ${formatTimestamp(edge.handoffAt)} | ` +
      edge.recordedBy.map((c) => `${c.cites} in ${truncateId(c.recordedInRunId)}`).join(', ')
  )
}

/** Print a cause result. `--json` prints the raw traversal and nothing else. */
export function printCause(
  args: CauseArgs,
  result: CauseCommandResult,
  log: (line: string) => void = console.log
): void {
  if (isCommandFailure(result)) {
    log(result.message)
    return
  }
  if (args.json) {
    log(JSON.stringify(result.traversal, null, 2))
    return
  }

  const traversal = result.traversal
  const counts = tally(result)
  const scan = traversal.scan

  log(headline(result))
  log(
    `verdict: ${traversal.verdict}   direction: ${scan.direction}   gate: --fail-on ${result.failOn}   ` +
      `max depth: ${scan.maxDepthRequested}   deepest reached: ${scan.deepestReached}`
  )
  log('')

  if (traversal.edges.length > 0) {
    log('RECORDED EDGES — what was written down at the moment of the handoff')
    for (const node of traversal.nodes) {
      const into = edgesInto(traversal, node.runId)
      const outOf = edgesOutOf(traversal, node.runId)
      if (into.length === 0 && outOf.length === 0) continue
      const marker = node.runId === traversal.subjectRunId ? ' <- SUBJECT' : ''
      log(
        `  ${truncateId(node.runId).padEnd(14)} ${node.status.toUpperCase().padEnd(10)} ` +
          `${node.hopsFromSubject} hop(s)${marker}`
      )
      for (const edge of into) renderEdge(edge, '      in   ', log)
      for (const edge of outOf) renderEdge(edge, '      out  ', log)
    }
    log('')
  }

  // THE TWO TERMINI, IN SEPARATE SECTIONS, NEVER INTERLEAVED. They are opposite
  // claims and each has its own sentence, composed by contracts'
  // originStatement() rather than written here — so no future edit to this file
  // can put a lost trail under a heading that reads like a conclusion.
  const origins = recordedOrigins(traversal)
  if (origins.length > 0) {
    log('WHERE THE RECORDED CHAIN ENDS — the walk finished on these frontiers')
    for (const origin of origins) log(`  ${originStatement(origin)}`)
    log('')
  }

  const cycles = cycleReEntries(traversal)
  if (cycles.length > 0) {
    log('WHERE THE CHAIN LOOPS — also finished. A loop has no origin to find.')
    for (const cycle of cycles) log(`  ${originStatement(cycle)}`)
    log('')
  }

  const convergences = convergencePoints(traversal)
  if (convergences.length > 0) {
    log('CONVERGENCE POINTS — these runs consumed SEVERAL upstream outputs')
    for (const { runId, producers } of convergences) {
      log(
        `  ${truncateId(runId).padEnd(14)} <- ${producers.map((e) => truncateId(e.producerRunId)).join(', ')}  ` +
          `(${producers.length} producers — there are ${producers.length} stories here, not one)`
      )
    }
    log('')
  }

  const lost = lostTrails(traversal)
  if (lost.length > 0) {
    log('WHERE THE TRAIL WAS LOST — NOT where the chain ends. These frontiers are unfinished.')
    for (const trail of lost) log(`  [${trail.kind}] ${originStatement(trail)}`)
    log('')
  }

  if (traversal.unanswered.length > 0) {
    log('COULD NOT ANSWER — reached and left open. Not connected, not isolated: unchecked.')
    for (const question of traversal.unanswered) {
      log(`  [${question.kind}] ${question.undecidedQuestion}`)
      log(`      could not decide: ${question.unknownBecause}`)
      if (question.remedy !== undefined) log(`      to make it answerable: ${question.remedy}`)
    }
    log('')
  }

  if (traversal.suspected.length > 0) {
    log('SUSPECTED, NOT RECORDED — coincidences. NOT edges, NOT directional, NOT walked.')
    for (const link of traversal.suspected) {
      // COMPOSED, never transmitted. The engine supplies `kind` and the shared
      // value; the interrogative, direction-free frame comes from contracts, so
      // no engine can put "run_a caused run_b" on this screen.
      log(`  [${link.kind}] ${suspicionQuestion(link)}`)
      log(`      runs (UNORDERED — the order means nothing): ${link.runIds.map((id) => truncateId(id)).join(', ')}`)
      log(`      not an edge: ${link.notAnEdgeBecause}`)
      log(`      to record it properly: ${link.wouldBeRecordedBy}`)
    }
    log('')
  }

  log(
    `WALK  ${scan.runsVisited} run(s) visited  |  ${scan.edgesRead} edge row(s) read  |  ` +
      `edge sets read complete: ${scan.edgeSetsComplete ? 'yes' : 'NO'}` +
      `${scan.scanTruncated ? `  |  TRUNCATED at the server's row ceiling${scan.scanRowCeiling === undefined ? '' : ` (${scan.scanRowCeiling})`}` : ''}`
  )
  if (!scan.edgeSetsComplete) {
    log(
      '  EDGE SETS WERE SAMPLED — arrows the engine had access to may be missing from this graph. That is a ' +
        'different and worse gap than the arrows nobody recorded: this one was readable and was not read.'
    )
  }
  if (scan.nextCursor !== undefined) {
    log('  PAGES REMAIN — this is not the whole graph. Raise --limit; this command does not follow the cursor.')
  }
  if (counts.lost > 0) {
    log(
      `  ${counts.lost} FRONTIER(S) LOST — this trace is PARTIAL. Runs not reached are not runs that are ` +
        'unconnected, and the origin above is the origin of what was RECORDED, not a root cause. An ' +
        'uninstrumented handoff is invisible to any walk, however complete.'
    )
  }
  if (!counts.complete && counts.edges > 0 && result.direction !== 'upstream') {
    log(
      `  THE DOWNSTREAM COUNT (${counts.downstream}) IS A FLOOR, not a total. More runs may have consumed this ` +
        "output than this walk reached."
    )
  }
}
