import { parseArgs } from 'node:util'

import { isPatternScanComplete } from '@agent-flight-recorder/sdk'

import { listFailurePatterns } from '../apiClient.js'
import { formatTimestamp, renderTable, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike, V1ListFailurePatternsData } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { FailurePatternStatus } from '@agent-flight-recorder/contracts'
import type { FixConfidenceEntry, FixConfidenceState } from '@agent-flight-recorder/sdk'

const VALID_STATUSES: readonly FailurePatternStatus[] = ['open', 'acknowledged', 'resolved']

/** How many ungraded fingerprints to name before collapsing the rest into a count. */
const MAX_UNEVALUATED_LISTED = 5

/** Team B's fix-confidence vocabulary (convex/insights.ts §12), verbatim — never a parallel one. */
const VALID_STATES: readonly FixConfidenceState[] = ['unproven', 'proving', 'confirmed', 'regressed']

/**
 * ADR-006 cycle 3 removed the exposure scan from the read path (verdicts are
 * served from a periodically refreshed per-pattern snapshot), so all four
 * states are answerable here now. Cycle 2's client-side allow-list is gone
 * with it: rejecting a value the backend can answer would be the same
 * silent-wrongness failure in the opposite direction.
 *
 * A genuinely invalid value is still a usage error — see `resolveStateFilter`.
 */

export const PATTERNS_HELP = `Usage: afr patterns [options]

List recurring failure patterns for your organization — a durable memory of
fingerprinted, recurring failures derived from failed runs (ADR-005,
"Failure Patterns"). Each pattern rolls up every run that produced the same
fingerprint: a class, a human label, how many times it has recurred, when it
was first/last seen, and the agent versions it has affected.

This is derived, observability-grade data (CLAUDE.md) — never a substitute
for a single run's own event log or explanation ('afr explain <runId>').

Options:
  --agent <agentId>   Only patterns seen on at least one version of this agent
  --spiking           Only patterns currently flagged as spiking
                       (lastSpikeAssessment.isSpiking === true) — proactive
                       prevention (PREVENTION cycle 2)
  --muted             Only patterns an org admin has muted
  --active            Only patterns that are NOT muted (the default view is
                       unfiltered — this excludes muted patterns explicitly)
  --status <s>        Only patterns whose lifecycle status is exactly <s> —
                       one of 'open', 'acknowledged', 'resolved' (a pattern
                       with no status set is treated as 'open'). Resolution
                       lifecycle (ADR-006).
  --regressed         Only patterns that have regressedAt set — a RESOLVED
                       pattern that received a new occurrence after it was
                       resolved ("your fix didn't hold").
  --state <s>         Only patterns whose FIX-CONFIDENCE state is <s> — one of
                       'unproven', 'proving', 'confirmed', 'regressed'. A
                       different axis from --status: --status is what a human
                       ASSERTED, --state is what the EVIDENCE supports.

                       Verdicts are served from a periodically refreshed
                       snapshot. One older than the staleness bound is still
                       shown (it is the best available answer, and it can only
                       under-report) but is marked [stale] in the CONFIDENCE
                       column — a stale verdict is never printed as current.
                       Patterns with a live resolution but no usable snapshot
                       cannot be graded; they are reported as "not evaluated"
                       rather than silently dropped from a filtered page.

                       PREFER --state regressed OVER --regressed IN CI:
                       --regressed also matches a pattern whose regression
                       predates its current resolution (it regressed, was
                       genuinely re-fixed, and was re-resolved — regressedAt
                       is kept as history). --state regressed matches only a
                       recurrence strictly after the live resolvedAt, i.e. a
                       fix that actually did not hold. --state regressed also
                       keeps an exact, snapshot-free path, so it never depends
                       on the refresh cron having run.
  --limit <n>         Max number of patterns to return
  --json              Print the raw API response as JSON
  --help              Show this message

Exit codes: the usual 0/1/2/4 band, plus 11 — "could not evaluate". A
FILTERED request scans a bounded window of rows and filters it, so it can
come back short or empty purely because it hit the server's row ceiling. When
that happens the result is annotated [scan truncated N/M rows] and the command
exits 11 instead of 0, because exit 0 from a gate claims "I checked and it is
clean" and a truncated scan has not checked. Page with the API's nextCursor
until the scan completes, or treat the run as inconclusive. An UNFILTERED
listing never truncates and is unaffected.

Note: this command only REFLECTS mute state (a MUTED column, and the
--muted/--active filters above). There is no 'afr patterns mute' — muting is
an admin, audited, Clerk-authed org action taken in the web app, not a
key-authed read-API action. A muted, spiking pattern still shows up as
spiking here (mute suppresses future alerts, not visibility).

Note: this command likewise only REFLECTS resolution-lifecycle state (a
STATUS column, a REGRESSED marker, and the --status/--regressed filters
above). There is deliberately no 'afr patterns resolve/acknowledge/reopen' —
those are member-gated, audited, Clerk-authed org actions taken in the web
app. A key-authed write here would bypass both the member-gate and the audit
log that those actions require (ADR-006). This surface only ever reflects
lifecycle status; it never mutates it.
`

export interface PatternsArgs {
  agent?: string
  spiking?: boolean
  /** Raw `--muted` flag, as typed. Combine with `active` via `resolveMutedFilter` — do not read this directly for filtering. */
  muted?: boolean
  /** Raw `--active` flag, as typed. Combine with `muted` via `resolveMutedFilter` — do not read this directly for filtering. */
  active?: boolean
  /** Raw `--status` value, as typed — validated against `VALID_STATUSES` by `resolveStatusFilter` before use. */
  status?: string
  regressed?: boolean
  /** Raw `--state` value, as typed — validated against `VALID_STATES` by `resolveStateFilter` before use. */
  state?: string
  limit?: number
  json?: boolean
  help?: boolean
}

/** Parse `afr patterns` flags (argv AFTER `patterns`). */
export function parsePatternsArgs(argv: string[]): PatternsArgs {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      spiking: { type: 'boolean' },
      muted: { type: 'boolean' },
      active: { type: 'boolean' },
      status: { type: 'string' },
      regressed: { type: 'boolean' },
      state: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: PatternsArgs = {}
  if (values['agent']) result.agent = values['agent']
  if (values['spiking']) result.spiking = true
  if (values['muted']) result.muted = true
  if (values['active']) result.active = true
  if (values['status']) result.status = values['status']
  if (values['regressed']) result.regressed = true
  if (values['state']) result.state = values['state']
  if (values['limit']) result.limit = Number(values['limit'])
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

/**
 * Resolve `--muted`/`--active` (the tri-state mute filter: only-muted /
 * only-active / unfiltered) into the single `muted` param the read API
 * takes, or a `CommandFailure` (exit 1 — usage) when both are passed, since
 * that is a contradictory request rather than one this command can silently
 * resolve one way.
 */
function resolveMutedFilter(args: PatternsArgs): { muted?: boolean } | CommandFailure {
  if (args.muted && args.active) {
    return { ok: false, exitCode: 1, message: '--muted and --active are mutually exclusive — pass at most one.' }
  }
  if (args.muted) return { muted: true }
  if (args.active) return { muted: false }
  return {}
}

/**
 * Validate `--status` against the closed set of lifecycle statuses
 * (ADR-006). Unlike `--muted`/`--active`'s permissive-elsewhere posture,
 * a garbage `--status` value is a usage error (exit 1) rather than silently
 * treated as unset — the flag only makes sense with one of the three known
 * values, and silently ignoring a typo (e.g. `--status resovled`) would
 * return an unfiltered list that looks like a match.
 */
function resolveStatusFilter(args: PatternsArgs): { status?: FailurePatternStatus } | CommandFailure {
  if (args.status === undefined) return {}
  if (!(VALID_STATUSES as readonly string[]).includes(args.status)) {
    return {
      ok: false,
      exitCode: 1,
      message: `--status must be one of ${VALID_STATUSES.join(', ')} — got "${args.status}".`,
    }
  }
  return { status: args.status as FailurePatternStatus }
}

/**
 * Validate `--state` against Team B's closed fix-confidence vocabulary.
 *
 * An unknown value ("regresed") is a usage error, same posture as
 * `resolveStatusFilter` — silently ignoring a typo would return an unfiltered
 * list that looks like a match. Caught locally, before any network round trip,
 * so a typo does not spend a rate-limit unit.
 */
function resolveStateFilter(args: PatternsArgs): { state?: FixConfidenceState } | CommandFailure {
  if (args.state === undefined) return {}
  if (!(VALID_STATES as readonly string[]).includes(args.state)) {
    return {
      ok: false,
      exitCode: 1,
      message: `--state must be one of ${VALID_STATES.join(', ')} — got "${args.state}".`,
    }
  }
  return { state: args.state as FixConfidenceState }
}

/**
 * Exit code for "I could not complete the check" — a scan that stopped on the
 * server's row ceiling while a filter was active.
 *
 * WHY NOT 0. `afr patterns --state regressed` is the CI gate the README
 * documents, and exit 0 from a gate is a claim: *I looked, and it is clean.*
 * A truncated scan has not earned that claim. It looked at the first 2,000
 * rows the server was willing to read and found nothing there — a regression
 * can exist past the ceiling, and exiting 0 would let the build go green on a
 * question nobody answered. "Could not evaluate" is a third outcome and it
 * needs its own code; collapsing it into either "clean" or "broken" throws
 * away the only distinction that matters.
 *
 * WHY 11. The existing band is 0-4 (ok / usage / auth / not-found /
 * network-server) and every one of those means something specific about the
 * REQUEST; this is about the ANSWER, so it must not collide with them. The
 * `afr triage` work in flight proposes `10` = issues found and `11` = could
 * not evaluate (mirroring the MCP triage verdicts `issues` / `clear` /
 * `unknown` in `packages/mcp/src/triage.ts`). This is the `unknown` case, so
 * it takes `11` rather than inventing a third numbering that a CI script
 * would then have to special-case per command. `10` is deliberately left
 * unused here: `afr patterns` still exits 0 when it finds matching patterns,
 * because that is a pre-existing contract and changing it is a separate
 * decision from this one.
 *
 * WHY ONLY WITH A FILTER. Unfiltered listing does not truncate — the server
 * sizes its scan to the page (`convex/read_api.ts`: `scanSize = filtering ?
 * PATTERN_SCAN_ROW_CEILING : needed`). And an unfiltered browse makes no
 * whole-dataset claim to falsify: "here are some patterns" stays true. The
 * annotation still prints in that case; only the exit code is withheld.
 */
export const PATTERNS_SCAN_INCOMPLETE_EXIT_CODE = 11

/**
 * A page that came back fine but did not answer the question asked of it.
 *
 * Modelled as a `CommandFailure` (`ok: false`) *carrying its data*, rather
 * than as a success with a flag, for one reason: `packages/cli/src/index.ts`
 * derives every command's process exit code from `result.ok ? 0 :
 * result.exitCode`. Being a failure IS how a non-zero exit code reaches the
 * shell. It is also the truthful shape — an incomplete check is not a
 * successful one — and `printPatterns` still renders the full table from
 * `data`, so nothing the server did return is thrown away.
 */
export interface PatternsScanIncomplete extends CommandFailure {
  exitCode: typeof PATTERNS_SCAN_INCOMPLETE_EXIT_CODE
  /** Marker so `printPatterns` can tell this apart from a real request failure. */
  scanIncomplete: true
  /** The page the server did return — rendered in full, annotated as partial. */
  data: V1ListFailurePatternsData
}

export type PatternsResult =
  | (V1ListFailurePatternsData & { ok: true })
  | PatternsScanIncomplete
  | CommandFailure

/** Narrow a `PatternsResult` to the truncated-scan case. */
function isScanIncomplete(result: PatternsResult): result is PatternsScanIncomplete {
  return !result.ok && 'scanIncomplete' in result
}

/**
 * Did the caller narrow the request at all? Only a narrowed request makes the
 * whole-dataset claim ("no pattern anywhere is in state X") that a truncated
 * scan cannot support — see {@link PATTERNS_SCAN_INCOMPLETE_EXIT_CODE}.
 */
function hasActiveFilter(args: PatternsArgs): boolean {
  return (
    args.agent !== undefined ||
    args.spiking === true ||
    args.muted === true ||
    args.active === true ||
    args.status !== undefined ||
    args.regressed === true ||
    args.state !== undefined
  )
}

/** `afr patterns` — list recurring failure patterns through the v1 read API. */
export async function runPatterns(
  args: PatternsArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<PatternsResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  const mutedFilter = resolveMutedFilter(args)
  if (isCommandFailure(mutedFilter)) return mutedFilter

  const statusFilter = resolveStatusFilter(args)
  if (isCommandFailure(statusFilter)) return statusFilter

  const stateFilter = resolveStateFilter(args)
  if (isCommandFailure(stateFilter)) return stateFilter

  try {
    const data = await listFailurePatterns(
      config,
      {
        ...(args.agent !== undefined && { agentId: args.agent }),
        ...(args.spiking !== undefined && { spiking: args.spiking }),
        ...(mutedFilter.muted !== undefined && { muted: mutedFilter.muted }),
        ...(statusFilter.status !== undefined && { status: statusFilter.status }),
        ...(args.regressed !== undefined && { regressed: args.regressed }),
        ...(stateFilter.state !== undefined && { state: stateFilter.state }),
        ...(args.limit !== undefined && { limit: args.limit }),
      },
      fetchImpl
    )
    if (!isPatternScanComplete(data) && hasActiveFilter(args)) {
      return {
        ok: false,
        exitCode: PATTERNS_SCAN_INCOMPLETE_EXIT_CODE,
        scanIncomplete: true,
        message: `scan incomplete ${formatScanAnnotation(data)} — this page is not a whole-dataset answer. Page with the API's cursor, or widen/narrow the filter, before treating it as clean.`,
        data,
      }
    }
    return { ok: true, ...data }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** Human-scale age, for annotating a stale verdict with HOW stale it is. */
function formatAge(ms: number): string {
  const hours = ms / (60 * 60 * 1000)
  if (hours < 1) return `${String(Math.max(1, Math.round(ms / 60_000)))}m`
  if (hours < 48) return `${hours.toFixed(0)}h`
  return `${(hours / 24).toFixed(0)}d`
}

/**
 * The truncation marker, in this command's existing bracket-annotation idiom
 * (`[muted]`, `[stale 9h]`) rather than a second one.
 *
 * Those annotations qualify the cell they sit in; this one qualifies the whole
 * result, so it sits at the end of the sentence it qualifies instead of in a
 * column. Row counts are included when the deployment sent them, because
 * "truncated at 2000 of 2000 rows" tells a reader how much WAS established,
 * which is the only actionable part of an inconclusive answer.
 */
function formatScanAnnotation(data: V1ListFailurePatternsData): string {
  const { scannedRows, scanRowCeiling } = data
  if (scannedRows === undefined || scanRowCeiling === undefined) return '[scan truncated]'
  return `[scan truncated ${String(scannedRows)}/${String(scanRowCeiling)} rows]`
}

/**
 * Render one pattern's confidence verdict.
 *
 * THREE OUTCOMES, THREE DISTINCT RENDERINGS — the whole point of the envelope:
 *
 *   confirmed 82%           a fresh verdict
 *   confirmed 82% [stale 9h]  a real verdict that has aged past the bound
 *   -                       no usable snapshot; nothing has been graded
 *
 * A stale verdict is SHOWN, not hidden: it is the best available answer, and
 * it can only under-report (soak and exposure accumulate, and the one
 * downgrade a verdict can take — `regressed` — is written eagerly and never
 * waits for a refresh). But it is never shown as though it were current. A
 * stale `confirmed` rendered identically to a fresh one would put unearned
 * confidence back on the screen at the very last step of a feature built to
 * remove it, which is why the marker is inline in the cell rather than a
 * footnote a reader can skip — it travels with the number it qualifies.
 *
 * `-` (no snapshot) is deliberately NOT rendered as `unproven`. "We have not
 * graded this" and "we graded this and found no evidence" are different
 * claims, and the second is a verdict this row has not earned.
 */
function formatConfidenceCell(entry: FixConfidenceEntry | undefined): string {
  if (!entry || entry.basis === 'none' || entry.state === null) return '-'
  const score = entry.score !== null ? ` ${(entry.score * 100).toFixed(0)}%` : ''
  const staleness = entry.stale ? ` [stale${entry.ageMs !== null ? ` ${formatAge(entry.ageMs)}` : ''}]` : ''
  return `${entry.state}${score}${staleness}`
}

/**
 * Footnotes that cannot be expressed per-row: how many verdicts are stale, and
 * which patterns could not be graded at all.
 *
 * `unevaluated` is printed even though those patterns are ABSENT from a
 * filtered page — that is exactly why it must be printed. A pattern with a
 * live resolution and no usable snapshot does not match `--state confirmed`,
 * but it is not evidence that it is unconfirmed either; letting it vanish
 * silently would let a reader conclude "nothing else needs attention" from a
 * page that simply could not evaluate part of its input.
 */
function printConfidenceFootnotes(result: V1ListFailurePatternsData, log: (line: string) => void): void {
  const envelope = result.fixConfidence
  if (!envelope) return

  if (envelope.staleCount > 0) {
    log(
      `\n${String(envelope.staleCount)} verdict(s) marked [stale] — older than ${formatAge(envelope.stalenessBoundMs)} and awaiting refresh. A stale verdict can under-report, never over-report.`
    )
  }

  if (envelope.unevaluated.length > 0) {
    const shown = envelope.unevaluated.slice(0, MAX_UNEVALUATED_LISTED)
    const remainder = envelope.unevaluated.length - shown.length
    log(
      `\n${String(envelope.unevaluated.length)} pattern(s) on this page have a resolution but NO confidence verdict yet, so they could not be graded${
        result.patterns.length === 0 ? '' : ' and cannot match a --state filter'
      }: ${shown.map((hash) => truncateId(hash)).join(', ')}${remainder > 0 ? `, +${String(remainder)} more` : ''}`
    )
    log("  (not the same as 'no evidence' — run 'afr patterns evidence <fingerprint>' to grade one now)")
  }
}

export function printPatterns(
  args: PatternsArgs,
  result: PatternsResult,
  log: (line: string) => void = console.log
): void {
  const incomplete = isScanIncomplete(result)

  if (!result.ok && !incomplete) {
    log(`Error: ${result.message}`)
    return
  }

  // A truncated scan is a failure by exit code but not by content: the server
  // answered, the answer is just partial. Everything below renders from the
  // page either way, with the partiality stated rather than implied.
  const data: V1ListFailurePatternsData = incomplete ? result.data : result

  if (args.json) {
    log(
      JSON.stringify(
        incomplete
          ? { ok: false, scanIncomplete: true, exitCode: result.exitCode, ...data }
          : result,
        null,
        2
      )
    )
    return
  }

  if (data.patterns.length === 0) {
    // NOT "No recurring failure patterns found." That sentence is a claim
    // about the whole dataset, and after a truncated scan it is false — the
    // scan stopped early and nothing is known about what lies past the
    // ceiling. Say what was actually established instead.
    if (data.scanTruncated === true) {
      log(
        `No matching patterns in the rows scanned ${formatScanAnnotation(data)} — the scan stopped on the server's row ceiling, not on the end of the table. This is NOT "none exist": nothing is known about the rows beyond it.`
      )
      log("  (page with the API's nextCursor until scanTruncated is false, or treat this run as inconclusive)")
      return
    }
    log('No recurring failure patterns found.')
    return
  }

  // Keyed by fingerprint rather than by array position. The envelope
  // documents `entries` as parallel to `patterns`, and it is — but a verdict
  // rendered against the WRONG pattern is the most damaging way this display
  // could fail, and a map costs nothing to be certain.
  const confidenceByFingerprint = new Map(
    (data.fixConfidence?.entries ?? []).map((entry) => [entry.fingerprintHash, entry])
  )

  const rows = data.patterns.map((pattern) => {
    const isSpiking = pattern.lastSpikeAssessment?.isSpiking === true
    const isMuted = pattern.muted === true
    // Mute suppresses future ALERTS, not visibility (CLAUDE.md / ADR-005) —
    // a muted, spiking pattern must stay visibly distinct from an active
    // spiking one, so the spike marker itself is annotated rather than
    // hidden or left indistinguishable.
    const spikingCell = isSpiking
      ? `yes (${pattern.lastSpikeAssessment?.recentCount})${isMuted ? ' [muted]' : ''}`
      : '-'
    // Resolution lifecycle (ADR-006): absent `status` means 'open' (the
    // documented default for pre-lifecycle rows). A pattern is shown as
    // "REGRESSED" — distinct from its literal `status` value — when it is
    // open AND carries `regressedAt`: that combination is exactly what the
    // backend's regression guard produces the moment a resolved pattern gets
    // a new occurrence (status flips back to 'open', regressedAt is stamped)
    // and is the "reopened by a regression" signal an engineer needs to see
    // at a glance, distinct from a pattern that was manually reopened
    // (status 'open', no regressedAt) or one still resolved.
    const status = pattern.status ?? 'open'
    const isRecentRegression = status === 'open' && pattern.regressedAt !== undefined
    const statusCell = isRecentRegression ? 'REGRESSED' : status
    return [
      truncateId(pattern.id),
      pattern.class,
      pattern.label,
      String(pattern.count),
      formatTimestamp(pattern.firstSeenAt),
      formatTimestamp(pattern.lastSeenAt),
      spikingCell,
      isMuted ? 'yes' : '-',
      statusCell,
      formatConfidenceCell(confidenceByFingerprint.get(pattern.fingerprintHash)),
    ]
  })
  log(
    renderTable(
      ['ID', 'CLASS', 'LABEL', 'COUNT', 'FIRST SEEN', 'LAST SEEN', 'SPIKING', 'MUTED', 'STATUS', 'CONFIDENCE'],
      rows
    )
  )

  printConfidenceFootnotes(data, log)
  // A truncated scan that DID return matches is still incomplete: these rows
  // are real, but they are not the complete set. Stated after the table, where
  // a reader is deciding what the output means.
  if (data.scanTruncated === true) {
    log(
      `\nThis list is PARTIAL ${formatScanAnnotation(data)} — the scan stopped on the server's row ceiling, not on the end of the table. More matches may exist past it.`
    )
  }
  if (data.nextCursor) {
    log(
      '\n(more results available — narrow with --agent/--spiking/--muted/--active/--status/--regressed/--state/--limit to see fewer pages)'
    )
  }
}
