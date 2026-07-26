import { Events, Recorder } from '@agent-flight-recorder/sdk'

import { readEnv } from '../env.js'

import type { CliEnv } from '../env.js'
import type { Transport } from '@agent-flight-recorder/sdk'

export interface RecordDemoResult {
  runId: string
  eventsRecorded: number
  success: boolean
  errors: string[]
}

/**
 * `afr record demo` — runs a small, representative demo agent end-to-end
 * through the SDK against the configured backend (`AFR_BASE_URL` /
 * `AFR_API_KEY`): starts a run, records an `llm.request`/`llm.response` pair
 * and a `tool.call`/`tool.result` pair, then ends the run.
 *
 * This is a real smoke test — a customer who just installed the CLI can run
 * `afr record demo` to confirm their API key and base URL are wired up
 * correctly before instrumenting their own agent.
 *
 * @param env - defaults to reading `AFR_API_KEY` / `AFR_BASE_URL` from `process.env`
 * @param transport - optional `Transport` override, used by tests to avoid real HTTP
 */
export async function runRecordDemo(env: CliEnv = readEnv(), transport?: Transport): Promise<RecordDemoResult> {
  if (!env.apiKey || !env.baseUrl) {
    return {
      runId: '',
      eventsRecorded: 0,
      success: false,
      errors: ['AFR_API_KEY and AFR_BASE_URL must both be set. Run `afr config check` for details.'],
    }
  }

  const recorder = new Recorder({ endpoint: env.baseUrl, apiKey: env.apiKey, agentId: 'afr-cli-demo' }, transport)

  const run = await recorder.startRun({ demo: true }, { source: 'afr-cli', name: 'afr-cli-demo-run' })

  let eventsRecorded = 0
  recorder.recordEvent(
    'llm.request',
    Events.llmRequest('demo-model', [{ role: 'user', content: 'What is 2 + 2?' }]).payload
  )
  eventsRecorded++

  recorder.recordEvent(
    'llm.response',
    Events.llmResponse('demo-model', '4', { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 }, 'stop').payload
  )
  eventsRecorded++

  recorder.recordEvent('tool.call', Events.toolCall('calculator', { expression: '2 + 2' }, 'call_demo_1').payload)
  eventsRecorded++

  recorder.recordEvent('tool.result', Events.toolResult('call_demo_1', { result: 4 }, 3).payload)
  eventsRecorded++

  const result = await recorder.endRun({ answer: 4 })

  return {
    runId: run.runId,
    eventsRecorded,
    success: result.success,
    errors: result.errors.map((e) => e.error),
  }
}

export function printRecordDemo(result: RecordDemoResult, log: (line: string) => void = console.log): void {
  log(`Run ID: ${result.runId || '(none — see errors below)'}`)
  log(`Events recorded: ${result.eventsRecorded}`)
  if (result.success) {
    log('Demo run completed successfully.')
  } else {
    log('Demo run FAILED:')
    for (const e of result.errors) log(`  - ${e}`)
  }
}
