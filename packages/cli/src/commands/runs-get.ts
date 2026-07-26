import { parseArgs } from 'node:util'

import { getRun } from '../apiClient.js'
import { formatDuration, formatTimestamp } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike, V1GetRunData } from '../apiClient.js'
import type { CliEnv } from '../env.js'

export const RUNS_GET_HELP = `Usage: afr runs get <runId> [options]

Show details for a single run.

Options:
  --json    Print the raw API response as JSON
  --help    Show this message
`

export interface RunsGetArgs {
  runId?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr runs get` args (argv AFTER `runs get` — i.e. `[<runId>, ...flags]`). */
export function parseRunsGetArgs(argv: string[]): RunsGetArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: RunsGetArgs = {}
  if (positionals[0]) result.runId = positionals[0]
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

export type RunsGetResult = (V1GetRunData & { ok: true }) | CommandFailure

/** `afr runs get <runId>` — fetch a single run's detail through the v1 read API. */
export async function runRunsGet(
  runId: string,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<RunsGetResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    const data = await getRun(config, runId, fetchImpl)
    return { ok: true, ...data }
  } catch (err) {
    return toCommandFailure(err)
  }
}

export function printRunsGet(args: RunsGetArgs, result: RunsGetResult, log: (line: string) => void = console.log): void {
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return
  }

  if (args.json) {
    log(JSON.stringify(result, null, 2))
    return
  }

  const { run, eventCount, artifactCount } = result
  log(`Run:          ${run.id}`)
  log(`Status:       ${run.status}`)
  log(`Agent:        ${run.agentId}${run.agentVersionId ? ` (version ${run.agentVersionId})` : ''}`)
  log(`Project:      ${run.projectId}`)
  if (run.environment) log(`Environment:  ${run.environment}`)
  if (run.sessionId) log(`Session:      ${run.sessionId}`)
  if (run.parentRunId) log(`Parent run:   ${run.parentRunId}`)
  log(`Started:      ${formatTimestamp(run.startedAt)}`)
  log(`Ended:        ${formatTimestamp(run.endedAt)}`)
  log(`Duration:     ${formatDuration(run.startedAt, run.endedAt)}`)
  log(`Events:       ${eventCount}`)
  log(`Artifacts:    ${artifactCount}`)
  if (run.tags.length > 0) log(`Tags:         ${run.tags.join(', ')}`)
  if (run.labels && run.labels.length > 0) log(`Labels:       ${run.labels.join(', ')}`)
  if (run.triageState) log(`Triage:       ${run.triageState}`)
  if (run.tokensIn !== undefined || run.tokensOut !== undefined) {
    log(`Tokens:       in=${run.tokensIn ?? 0} out=${run.tokensOut ?? 0}`)
  }
}
