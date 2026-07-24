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
  --limit <n>         Max number of patterns to return
  --json              Print the raw API response as JSON
  --help              Show this message
`

export interface PatternsArgs {
  agent?: string
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
      limit: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: PatternsArgs = {}
  if (values['agent']) result.agent = values['agent']
  if (values['limit']) result.limit = Number(values['limit'])
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
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

  try {
    const data = await listFailurePatterns(
      config,
      {
        ...(args.agent !== undefined && { agentId: args.agent }),
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

  const rows = result.patterns.map((pattern) => [
    truncateId(pattern.id),
    pattern.class,
    pattern.label,
    String(pattern.count),
    formatTimestamp(pattern.firstSeenAt),
    formatTimestamp(pattern.lastSeenAt),
    pattern.lastSpikeAssessment?.isSpiking ? 'yes' : '-',
  ])
  log(renderTable(['ID', 'CLASS', 'LABEL', 'COUNT', 'FIRST SEEN', 'LAST SEEN', 'SPIKING'], rows))
  if (result.nextCursor) {
    log('\n(more results available — narrow with --agent/--limit to see fewer pages)')
  }
}
