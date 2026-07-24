import { parseArgs } from 'node:util'

import { getRun, getRunExplanation } from '../apiClient.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { RunExplanation, RunStatus } from '@agent-flight-recorder/contracts'

export const EXPLAIN_HELP = `Usage: afr explain <runId> [options]

Fetch and render the root-cause explanation for a run — the flagship
"explainability layer" feature (ADR-004): failure class, a plain-English
summary, the root cause, a suggested fix (when available), and the event
sequence numbers the explanation is grounded in, so you can jump straight to
them with 'afr replay <runId>' or 'afr tail <runId>'.

Honest states:
  - a run that completed successfully (or is still running/pending/
    cancelled) prints a plain "nothing to explain" message instead of an
    error
  - a failed/timed-out run whose explanation has not been generated yet
    prints a clear "not generated yet" message instead of an error

(The v1 explanation endpoint itself only returns "an explanation or null" —
it cannot tell those two apart on its own, see docs/design/explanations.md's
"Known gap: coarse null state". This command disambiguates them itself by
also checking the run's own status via 'afr runs get'.)

Options:
  --json    Print the raw, derived result as JSON
  --help    Show this message
`

export interface ExplainArgs {
  runId?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr explain` args (argv AFTER `explain` — i.e. `[<runId>, ...flags]`). */
export function parseExplainArgs(argv: string[]): ExplainArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: ExplainArgs = {}
  if (positionals[0]) result.runId = positionals[0]
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

/** Run statuses ADR-004 generates explanations for. */
const FAILURE_STATUSES: ReadonlySet<RunStatus> = new Set(['failed', 'timed_out'])

export type ExplainResult =
  | { ok: true; status: 'ready'; runId: string; explanation: RunExplanation }
  | { ok: true; status: 'pending'; runId: string }
  | { ok: true; status: 'not_failed'; runId: string; runStatus: RunStatus }
  | CommandFailure

/**
 * `afr explain <runId>` — fetch a run's root-cause explanation through the
 * v1 read API, then disambiguate the endpoint's coarse `explanation: null`
 * result into the two distinct honest states the feature calls for by also
 * checking the run's own status (`getRun`) — see `EXPLAIN_HELP` above.
 */
export async function runExplain(
  runId: string,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<ExplainResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    const [runData, explanationData] = await Promise.all([
      getRun(config, runId, fetchImpl),
      getRunExplanation(config, runId, fetchImpl),
    ])

    if (explanationData.explanation) {
      return { ok: true, status: 'ready', runId, explanation: explanationData.explanation }
    }

    if (FAILURE_STATUSES.has(runData.run.status)) {
      return { ok: true, status: 'pending', runId }
    }

    return { ok: true, status: 'not_failed', runId, runStatus: runData.run.status }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** Human-readable label for a server-defined `failureClass` string (falls back to the raw value for unrecognized classes). */
function formatFailureClass(failureClass: string): string {
  const labels: Record<string, string> = {
    tool_error: 'Tool Error',
    llm_error: 'LLM Error',
    timeout: 'Timeout',
    upstream_dependency: 'Upstream Dependency Failure',
    invalid_output: 'Invalid Output',
    unknown: 'Unknown',
  }
  return labels[failureClass] ?? failureClass.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function printExplain(args: ExplainArgs, result: ExplainResult, log: (line: string) => void = console.log): void {
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return
  }

  if (args.json) {
    log(JSON.stringify(result, null, 2))
    return
  }

  switch (result.status) {
    case 'not_failed':
      log(
        result.runStatus === 'completed'
          ? 'This run completed successfully — nothing to explain.'
          : `This run hasn't failed (status: ${result.runStatus}) — nothing to explain yet.`
      )
      return

    case 'pending':
      log("An explanation hasn't been generated for this run yet.")
      log(`Check back shortly, or run 'afr replay ${result.runId}' for the raw failure summary in the meantime.`)
      return

    case 'ready': {
      const { explanation } = result
      const header = formatFailureClass(explanation.failureClass)
      const bar = '='.repeat(Math.min(60, Math.max(20, header.length + 10)))
      log(bar)
      log(`  ${header}`)
      log(bar)
      log('')
      log('Summary:')
      log(`  ${explanation.summary}`)
      log('')
      log('Root cause:')
      log(`  ${explanation.rootCause}`)
      if (explanation.suggestedFix) {
        log('')
        log('Suggested fix:')
        log(`  ${explanation.suggestedFix}`)
      }
      log('')
      if (explanation.citedSequenceNumbers.length > 0) {
        log(`Cited events (seq): ${explanation.citedSequenceNumbers.join(', ')}`)
        log(`  -> jump to them with 'afr replay ${result.runId}' or 'afr tail ${result.runId}'`)
      }
      log('')
      log(`Generated: ${new Date(explanation.generatedAt).toISOString()}${explanation.model ? ` (model: ${explanation.model})` : ''}`)
      return
    }
  }
}
