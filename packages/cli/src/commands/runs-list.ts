import { parseArgs } from 'node:util'

import { listRuns } from '../apiClient.js'
import { formatTimestamp, renderTable, truncateId } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike, V1ListRunsData } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { RunStatus } from '@agent-flight-recorder/contracts'

export const RUNS_LIST_HELP = `Usage: afr runs list [options]

List runs for your organization.

Options:
  --status <status>       Filter by run status (pending|running|completed|failed|cancelled|timed_out)
  --agent <agentId>       Filter by agent id
  --env <environment>     Filter by environment label
  --session <sessionId>   Filter by session id
  --limit <n>             Max number of runs to return
  --triage <state>        Filter by triage state (open|investigating|resolved). CLIENT-SIDE ONLY —
                          the v1 API has no server-side triage filter (see docs/api_reference.md);
                          this filters the current page's results, so combine with a narrow
                          --status/--agent/--limit or it may miss runs on later pages.
  --label <tag>           Filter to runs whose tags include this value. CLIENT-SIDE ONLY, same
                          page-local caveat as --triage.
  --json                  Print the raw API response as JSON
  --help                  Show this message
`

export interface RunsListArgs {
  status?: string
  agent?: string
  env?: string
  session?: string
  limit?: number
  triage?: string
  label?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr runs list` flags (argv AFTER `runs list`). */
export function parseRunsListArgs(argv: string[]): RunsListArgs {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      status: { type: 'string' },
      agent: { type: 'string' },
      env: { type: 'string' },
      session: { type: 'string' },
      limit: { type: 'string' },
      triage: { type: 'string' },
      label: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: RunsListArgs = {}
  if (values['status']) result.status = values['status']
  if (values['agent']) result.agent = values['agent']
  if (values['env']) result.env = values['env']
  if (values['session']) result.session = values['session']
  if (values['limit']) result.limit = Number(values['limit'])
  if (values['triage']) result.triage = values['triage']
  if (values['label']) result.label = values['label']
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

export type RunsListResult = (V1ListRunsData & { ok: true }) | CommandFailure

/** `afr runs list` — list runs through the v1 read API. */
export async function runRunsList(
  args: RunsListArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<RunsListResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    const data = await listRuns(
      config,
      {
        ...(args.status !== undefined && { status: args.status as RunStatus }),
        ...(args.agent !== undefined && { agentId: args.agent }),
        ...(args.env !== undefined && { environment: args.env }),
        ...(args.session !== undefined && { sessionId: args.session }),
        ...(args.limit !== undefined && { limit: args.limit }),
      },
      fetchImpl
    )
    // --triage/--label have no server-side equivalent in the v1 API (see
    // docs/api_reference.md) — filter the already-fetched page client-side.
    // This is a documented, known gap: it only narrows the current page, it
    // does not change what the server considers a "match" for pagination.
    const runs = data.runs.filter((run) => {
      if (args.triage !== undefined && (run.triageState ?? 'open') !== args.triage) return false
      if (args.label !== undefined && !run.tags.includes(args.label)) return false
      return true
    })
    return { ok: true, ...data, runs }
  } catch (err) {
    return toCommandFailure(err)
  }
}

export function printRunsList(
  args: RunsListArgs,
  result: RunsListResult,
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

  if (result.runs.length === 0) {
    log('No runs found.')
    return
  }

  const rows = result.runs.map((run) => [
    truncateId(run.id),
    run.status,
    run.agentId,
    formatTimestamp(run.startedAt),
    run.endedAt !== undefined ? formatTimestamp(run.endedAt) : '-',
  ])
  log(renderTable(['ID', 'STATUS', 'AGENT', 'STARTED', 'ENDED'], rows))
  if (result.nextCursor) {
    log('\n(more results available — narrow with --status/--agent/--limit to see fewer pages)')
  }
}
