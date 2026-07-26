import { parseArgs } from 'node:util'

import { getRunReplay } from '../apiClient.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike, V1ReplayData } from '../apiClient.js'
import type { CliEnv } from '../env.js'

export const REPLAY_HELP = `Usage: afr replay <runId> [options]

Reconstruct and print a run's event sequence (RUN_STARTED -> ... -> terminal)
as a readable transcript, from the replay projection.

Options:
  --json    Print the raw replay projection as JSON
  --help    Show this message
`

export interface ReplayArgs {
  runId?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr replay` args (argv AFTER `replay` — i.e. `[<runId>, ...flags]`). */
export function parseReplayArgs(argv: string[]): ReplayArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: ReplayArgs = {}
  if (positionals[0]) result.runId = positionals[0]
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

export type ReplayResult = (V1ReplayData & { ok: true }) | CommandFailure

/** `afr replay <runId>` — fetch and render the replay projection for a run. */
export async function runReplay(runId: string, env: CliEnv = readEnv(), fetchImpl?: ApiFetchLike): Promise<ReplayResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    const data = await getRunReplay(config, runId, fetchImpl)
    return { ok: true, ...data }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** Render a single replay frame as one transcript line, indented by nesting depth. */
function renderFrameLine(frame: V1ReplayData['projection']['frames'][number]): string {
  const indent = '  '.repeat(Math.min(frame.depth, 10))
  const elapsed = `+${frame.elapsed_ms}ms`.padEnd(10)
  const statusTag = frame.status === 'error' ? '[ERROR]' : frame.status === 'terminal' ? '[DONE]' : ''
  const tag = statusTag ? ` ${statusTag}` : ''
  return `${indent}${elapsed} ${frame.event.type.padEnd(16)} (${frame.actor})  ${frame.payloadPreview}${tag}`
}

export function printReplay(args: ReplayArgs, result: ReplayResult, log: (line: string) => void = console.log): void {
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return
  }

  if (args.json) {
    log(JSON.stringify(result, null, 2))
    return
  }

  const { projection, failureSummary } = result

  if (projection.frames.length === 0) {
    log('No events found for this run.')
    return
  }

  log(`Run ${projection.runId} — ${projection.totalEvents} event(s), ${projection.duration_ms}ms`)
  if (projection.truncated) {
    log('(projection truncated — the full event log is larger than the replay limit)')
  }
  log('')

  for (const frame of projection.frames) {
    log(renderFrameLine(frame))
  }

  if (!projection.isComplete) {
    log('\n(run has no terminal event yet — still in progress)')
  }

  if (failureSummary.hasFailure) {
    log('\nFailure summary:')
    if (failureSummary.primaryFailure) {
      const p = failureSummary.primaryFailure
      log(`  Primary failure: seq=${p.sequenceNumber} type=${p.type} reason=${p.reason}${p.errorMessage ? ` — ${p.errorMessage}` : ''}`)
    } else if (failureSummary.cannotInfer) {
      log('  Run failed, but no root cause could be inferred from the event log.')
    }
  }
}
