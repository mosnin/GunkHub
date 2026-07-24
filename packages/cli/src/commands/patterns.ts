import { parseArgs } from 'node:util'

import { listFailurePatterns } from '../apiClient.js'
import { formatTimestamp, renderTable, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike, V1ListFailurePatternsData } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { FailurePatternStatus } from '@agent-flight-recorder/contracts'
import type { FixConfidenceState } from '@agent-flight-recorder/sdk'

const VALID_STATUSES: readonly FailurePatternStatus[] = ['open', 'acknowledged', 'resolved']

/** Team B's fix-confidence vocabulary (convex/insights.ts §12), verbatim — never a parallel one. */
const VALID_STATES: readonly FixConfidenceState[] = ['unproven', 'proving', 'confirmed', 'regressed']

/**
 * The only `--state` value `afr patterns` can answer. The other three depend
 * on per-pattern post-resolution run exposure, which the list endpoint cannot
 * measure across a whole page; `afr patterns evidence <fingerprint>` answers
 * those one pattern at a time.
 */
const LIST_ANSWERABLE_STATES: readonly FixConfidenceState[] = ['regressed']

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
  --state <s>         Only patterns whose FIX-CONFIDENCE state is <s>
                       (ADR-006 cycle 2). A different axis from --status:
                       --status is what a human ASSERTED, --state is what the
                       EVIDENCE supports. Only 'regressed' is answerable here;
                       'unproven'/'proving'/'confirmed' need per-pattern run
                       exposure — use 'afr patterns evidence <fingerprint>'.

                       PREFER --state regressed OVER --regressed IN CI:
                       --regressed also matches a pattern whose regression
                       predates its current resolution (it regressed, was
                       genuinely re-fixed, and was re-resolved — regressedAt
                       is kept as history). --state regressed matches only a
                       recurrence strictly after the live resolvedAt, i.e. a
                       fix that actually did not hold.
  --limit <n>         Max number of patterns to return
  --json              Print the raw API response as JSON
  --help              Show this message

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
 * Validate `--state` against Team B's closed fix-confidence vocabulary, and
 * then against the narrower set this endpoint can actually answer.
 *
 * TWO DISTINCT REJECTIONS, deliberately worded differently:
 *   - an unknown value ("regresed") is a typo — same posture as
 *     `resolveStatusFilter`, since silently ignoring it would return an
 *     unfiltered list that looks like a match.
 *   - a KNOWN but unanswerable value ('confirmed') is a real question this
 *     command cannot answer, so it names the command that can rather than
 *     pretending the filter applied. Both are caught locally, before any
 *     network round trip; the server rejects them too (defence in depth), but
 *     the CLI should not spend a rate-limit unit to learn this.
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
  if (!(LIST_ANSWERABLE_STATES as readonly string[]).includes(args.state)) {
    return {
      ok: false,
      exitCode: 1,
      message: `--state ${args.state} is not available on 'afr patterns' — it depends on per-pattern post-resolution run exposure, which cannot be measured across a whole page. Use 'afr patterns evidence <fingerprint>' for ${VALID_STATES.filter((s) => !LIST_ANSWERABLE_STATES.includes(s)).join('/')}.`,
    }
  }
  return { state: args.state as FixConfidenceState }
}

export type PatternsResult = (V1ListFailurePatternsData & { ok: true }) | CommandFailure

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
    return { ok: true, ...data }
  } catch (err) {
    return toCommandFailure(err)
  }
}

export function printPatterns(
  args: PatternsArgs,
  result: PatternsResult,
  log: (line: string) => void = console.log
): void {
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return
  }

  if (args.json) {
    log(JSON.stringify(result, null, 2))
    return
  }

  if (result.patterns.length === 0) {
    log('No recurring failure patterns found.')
    return
  }

  const rows = result.patterns.map((pattern) => {
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
    ]
  })
  log(
    renderTable(['ID', 'CLASS', 'LABEL', 'COUNT', 'FIRST SEEN', 'LAST SEEN', 'SPIKING', 'MUTED', 'STATUS'], rows)
  )
  if (result.nextCursor) {
    log(
      '\n(more results available — narrow with --agent/--spiking/--muted/--active/--status/--regressed/--state/--limit to see fewer pages)'
    )
  }
}
