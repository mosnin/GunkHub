import { parseArgs } from 'node:util'

import { listFailurePatterns } from '../apiClient.js'
import { formatTimestamp, renderTable, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike, V1ListFailurePatternsData } from '../apiClient.js'
import type { CliEnv } from '../env.js'

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
  --limit <n>         Max number of patterns to return
  --json              Print the raw API response as JSON
  --help              Show this message

Note: this command only REFLECTS mute state (a MUTED column, and the
--muted/--active filters above). There is no 'afr patterns mute' — muting is
an admin, audited, Clerk-authed org action taken in the web app, not a
key-authed read-API action. A muted, spiking pattern still shows up as
spiking here (mute suppresses future alerts, not visibility).
`

export interface PatternsArgs {
  agent?: string
  spiking?: boolean
  /** Raw `--muted` flag, as typed. Combine with `active` via `resolveMutedFilter` — do not read this directly for filtering. */
  muted?: boolean
  /** Raw `--active` flag, as typed. Combine with `muted` via `resolveMutedFilter` — do not read this directly for filtering. */
  active?: boolean
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

  try {
    const data = await listFailurePatterns(
      config,
      {
        ...(args.agent !== undefined && { agentId: args.agent }),
        ...(args.spiking !== undefined && { spiking: args.spiking }),
        ...(mutedFilter.muted !== undefined && { muted: mutedFilter.muted }),
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
    return [
      truncateId(pattern.id),
      pattern.class,
      pattern.label,
      String(pattern.count),
      formatTimestamp(pattern.firstSeenAt),
      formatTimestamp(pattern.lastSeenAt),
      spikingCell,
      isMuted ? 'yes' : '-',
    ]
  })
  log(renderTable(['ID', 'CLASS', 'LABEL', 'COUNT', 'FIRST SEEN', 'LAST SEEN', 'SPIKING', 'MUTED'], rows))
  if (result.nextCursor) {
    log('\n(more results available — narrow with --agent/--spiking/--muted/--active/--limit to see fewer pages)')
  }
}
