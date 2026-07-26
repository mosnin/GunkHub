import { parseArgs } from 'node:util'

import { SCAN_LIMIT, TRIAGE_REQUEST_FIELDS, toTriageResult } from '@agent-flight-recorder/sdk'

import { listFailurePatterns } from '../apiClient.js'
import { formatTimestamp, renderTable, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { TriagePointer, TriageResult } from '@agent-flight-recorder/sdk'

export const TRIAGE_HELP = `Usage: afr triage [options]

The cheap first hop: one call, zero required arguments, answering "what is
wrong right now, and what should I look at first?".

Ranks your organization's recurring failure patterns and prints the top few,
each with the exact next command to run. This is the same ranking, the same
scores and the same next-hop targets the 'afr_triage' MCP tool serves — one
implementation, in @agent-flight-recorder/sdk, imported by both. A CLI that
ranked failures differently from the agent-facing tool would be two answers
to one question.

Ranking (highest first): regressed, spiking, open, acknowledged, resolved.
Recency and volume order items WITHIN a signal class and can never promote one
across a class. Muted patterns are shown, flagged, and always sorted last —
muting suppresses alerting, not existence.

Options:
  --agent <agentId>   Only patterns seen on at least one version of this agent
  --json              Print the raw TriageResult as JSON — byte-identical to
                       what the MCP tool returns, including next-hop pointers
                       in their MCP tool-name form
  --help              Show this message

EXIT CODES — THIS IS A CI GATE, READ THIS BEFORE SCRIPTING IT:
  0   verdict 'clear'   — the scan completed and found nothing to look at
  10  verdict 'issues'  — ranked items were found
  11  verdict 'unknown' — NOTHING WAS FOUND, BUT THE VIEW WAS INCOMPLETE, so
                          "nothing found" is not evidence of health
  1   usage (bad flag, missing AFR_API_KEY/AFR_BASE_URL)
  2   auth (401/403)      3  not found (404)      4  network/rate-limit/server

  Exit 0 is UNREACHABLE on an incomplete scan. Verdict 'clear' is only ever
  produced when every honesty check passed, so a truncated or partially
  ungradeable view can never report itself as healthy. That is a property of
  how the verdict is constructed, not a convention this command applies on
  top of it — which is why the gate cannot be silently weakened later.

  10 wins over 11 when both apply: findings are actionable, and an incomplete
  scan that still found something is reported as findings with the
  incompleteness stated in the output and in --json's 'complete' field.

  NOTE THE DELIBERATE DIFFERENCE FROM 'afr patterns --state regressed'.
  That command exits 0 whether or not it matched, and relies on an external
  'jq -e' to turn a finding into a build failure. That is how a build stays
  green while something is wrong — the gate only works if someone remembered
  to add the jq. 'afr triage' fails the build itself. Do not "harmonise" the
  two: the difference is the point.

Scripting it in CI:
  afr triage            # non-zero on findings OR on a scan it could not finish
  afr triage --json     # 'verdict', 'complete', 'caveats', 'items[].next'
`

/** Findings were ranked. Above the 0-4 band so it can never collide with a transport failure. */
export const TRIAGE_EXIT_FINDINGS = 10
/** Nothing was found, but the view was incomplete — "no findings" is not an answer here. */
export const TRIAGE_EXIT_INCOMPLETE = 11

export interface TriageArgs {
  agent?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr triage` flags (argv AFTER `triage`). */
export function parseTriageArgs(argv: string[]): TriageArgs {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: TriageArgs = {}
  if (values['agent']) result.agent = values['agent']
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

export type TriageCommandResult = (TriageResult & { ok: true }) | CommandFailure

/**
 * `afr triage` — rank what is wrong right now, through the v1 read API.
 *
 * ONE upstream read, composed from the EXISTING `GET /api/v1/patterns` with the
 * ranking's own field selection and scan limit. There is deliberately no
 * `/api/v1/triage` endpoint: a new route would be a new surface to secure,
 * rate-limit, document and keep in sync, to solve a problem composition already
 * solves. Every field the ranking needs is already declared and forwarded.
 *
 * @param args - parsed flags.
 * @param env - CLI environment (injectable for tests).
 * @param fetchImpl - injectable fetch (tests never touch the network).
 * @param now - the clock, injected so the recency term is deterministic in tests.
 */
export async function runTriage(
  args: TriageArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike,
  now: number = Date.now()
): Promise<TriageCommandResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    const data = await listFailurePatterns(
      config,
      {
        ...(args.agent !== undefined && { agentId: args.agent }),
        limit: SCAN_LIMIT,
        fields: [...TRIAGE_REQUEST_FIELDS],
      },
      fetchImpl
    )
    // `data` is passed as the scan-marker argument as well as being destructured:
    // `toTriageResult` reads `scanTruncated` off it, and an absent marker resolves
    // to "complete" rather than being guessed at.
    const result = toTriageResult(data.patterns, data.fixConfidence, data.nextCursor, now, data)
    return { ok: true, ...result }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/**
 * Process exit code for a completed triage run.
 *
 * `'clear'` requires `complete` as well as the verdict, and THE REDUNDANCY IS
 * DELIBERATE. The ranking computes
 * `verdict = items.length > 0 ? 'issues' : complete ? 'clear' : 'unknown'`, so
 * `'clear'` already implies `complete` and the second check is unreachable
 * today. It is here anyway because this is the one line in the command where
 * being wrong turns a red build green, and the invariant it depends on now
 * lives in a DIFFERENT PACKAGE (`@agent-flight-recorder/sdk`), shared with the
 * MCP server. If that construction is ever changed — reasonably, for the MCP
 * surface, by someone who never opens this file — the gate must not silently
 * start passing incomplete scans.
 *
 * So: exit 0 requires both that nothing was found AND that the view was whole.
 * Anything else is non-zero. A redundant check on a CI gate is not clutter; it
 * is the cheapest possible insurance against the exact failure this product
 * exists to prevent.
 */
export function exitCodeForTriage(result: TriageResult): number {
  switch (result.verdict) {
    case 'issues':
      return TRIAGE_EXIT_FINDINGS
    case 'unknown':
      return TRIAGE_EXIT_INCOMPLETE
    case 'clear':
      return result.complete ? 0 : TRIAGE_EXIT_INCOMPLETE
  }
}

/**
 * MCP tool name -> the `afr` command that does the same thing.
 *
 * The RANKING emits next hops as MCP tool names, because it is one
 * implementation shared with the MCP server and the pointer targets are part of
 * what is shared. A human at a terminal cannot run `afr_get_pattern_evidence`,
 * so the table below renders the CLI equivalent — the same TARGET, spelled for
 * this surface.
 *
 * `--json` is NOT translated: it emits the pointer verbatim, so a machine
 * reading either surface gets byte-identical pointers.
 *
 * An unrecognized tool name falls back to printing it raw rather than throwing.
 * A new rung added to the ladder should degrade to a slightly awkward hint, not
 * take down the command that is supposed to tell you what is broken.
 */
function renderPointer(pointer: TriagePointer): string {
  const args = pointer.args
  switch (pointer.tool) {
    case 'afr_explain_run':
      return `afr explain ${String(args['runId'] ?? '')}`
    case 'afr_get_pattern_evidence':
      return `afr patterns evidence ${String(args['fingerprintHash'] ?? '')}`
    case 'afr_list_failure_patterns':
      return `afr patterns${args['cursor'] !== undefined ? ' (next page)' : ''}`
    case 'afr_list_runs':
      return `afr runs list --status ${String(args['status'] ?? 'failed')} --limit ${String(args['limit'] ?? 20)}`
    default:
      return `${pointer.tool} ${JSON.stringify(args)}`
  }
}

export function printTriage(
  args: TriageArgs,
  result: TriageCommandResult,
  log: (line: string) => void = console.log
): void {
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return
  }

  if (args.json) {
    // The `ok` discriminator is dropped so `--json` is the RANKING's result
    // verbatim — the same object the MCP tool serves, pointers and all. A
    // consumer diffing the two surfaces should find nothing.
    const { ok: _ok, ...raw } = result
    log(JSON.stringify(raw, null, 2))
    return
  }

  if (result.items.length === 0) {
    // Two different answers, never collapsed. `clear` is "I looked everywhere
    // and found nothing"; `unknown` is "I could not finish looking", and
    // printing the first when the second is true is the exact failure this
    // command exists to prevent.
    if (result.verdict === 'clear') {
      log(`Nothing to triage — ${String(result.scanned)} pattern(s) scanned, none needing attention.`)
    } else {
      log('COULD NOT DETERMINE whether anything is wrong — the view was incomplete.')
      log('This is NOT a clean bill of health.')
    }
  } else {
    const rows = result.items.map((item) => [
      truncateId(item.fingerprintHash),
      item.signal.toUpperCase(),
      String(item.score),
      item.class,
      item.label,
      String(item.count),
      formatTimestamp(item.lastSeenAt),
      item.muted === true ? 'yes' : '-',
      renderPointer(item.next),
    ])
    log(
      renderTable(
        ['FINGERPRINT', 'SIGNAL', 'SCORE', 'CLASS', 'LABEL', 'COUNT', 'LAST SEEN', 'MUTED', 'NEXT'],
        rows
      )
    )
    log(`\nShowing ${String(result.items.length)} of ${String(result.scanned)} pattern(s) scanned.`)
  }

  // Caveats print for EVERY incomplete result, findings or not. When items were
  // found the exit code is 10 (findings) rather than 11, so this block is the
  // only thing telling a reader the list may be partial — dropping it would
  // make a truncated scan indistinguishable from a whole one.
  if (result.caveats && result.caveats.length > 0) {
    log('\nIncomplete view:')
    for (const caveat of result.caveats) log(`  - ${caveat}`)
  }

  if (result.unevaluated) {
    log(
      `\n${String(result.unevaluated.count)} resolution(s) could not be graded: ${result.unevaluated.sample
        .map((hash) => truncateId(hash))
        .join(', ')}`
    )
    log("  (not the same as 'the fix held' — run 'afr patterns evidence <fingerprint>' to grade one)")
  }

  if (result.next) {
    log(`\nNext: ${renderPointer(result.next)}`)
  }
}
