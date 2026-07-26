import { parseArgs } from 'node:util'

import { getRunEvents } from '../apiClient.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { Event } from '@agent-flight-recorder/contracts'

export const TAIL_HELP = `Usage: afr tail <runId> [options]

Poll a run's event log and print new events as they arrive. Stops
automatically when a terminal event (run.completed / run.failed /
run.cancelled) is seen, after a maximum duration, or on Ctrl-C.

Options:
  --interval <ms>   Poll interval in milliseconds (default: 2000)
  --help            Show this message
`

export interface TailArgs {
  runId?: string
  interval?: number
  help?: boolean
}

/** Parse `afr tail` args (argv AFTER `tail` — i.e. `[<runId>, ...flags]`). */
export function parseTailArgs(argv: string[]): TailArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      interval: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: TailArgs = {}
  if (positionals[0]) result.runId = positionals[0]
  if (values['interval']) result.interval = Number(values['interval'])
  if (values['help']) result.help = true
  return result
}

const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled'])

export type TailStopReason = 'terminal' | 'timeout' | 'interrupted'

export interface TailOptions {
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number
  /** Give up (with reason 'timeout') after this many ms. Default 10 minutes. */
  maxDurationMs?: number
  /** Injectable sleep, so tests never wait in real time. Default `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>
  /** Polled every iteration; returning true stops the loop with reason 'interrupted' (wired to SIGINT in index.ts). */
  shouldStop?: () => boolean
  /** Injectable clock. Default `Date.now`. */
  now?: () => number
  /** Cap on iterations regardless of time — a safety net for tests. */
  maxIterations?: number
}

export type TailResult =
  | { ok: true; exitCode: 0; eventsSeen: number; stopReason: TailStopReason }
  | CommandFailure

/** `afr tail <runId>` — poll a run's events until a terminal event, timeout, or interrupt. */
export async function runTail(
  runId: string,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike,
  options: TailOptions = {},
  log: (line: string) => void = console.log
): Promise<TailResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  const intervalMs = options.intervalMs ?? 2000
  const maxDurationMs = options.maxDurationMs ?? 10 * 60 * 1000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const shouldStop = options.shouldStop ?? (() => false)
  const now = options.now ?? Date.now
  const maxIterations = options.maxIterations ?? Infinity

  const start = now()
  let cursor: string | undefined
  let eventsSeen = 0
  let iterations = 0

  for (;;) {
    if (shouldStop()) return { ok: true, exitCode: 0, eventsSeen, stopReason: 'interrupted' }
    if (now() - start > maxDurationMs) return { ok: true, exitCode: 0, eventsSeen, stopReason: 'timeout' }
    if (iterations >= maxIterations) return { ok: true, exitCode: 0, eventsSeen, stopReason: 'timeout' }
    iterations++

    let events: Event[]
    let nextCursor: string | undefined
    try {
      const page = await getRunEvents(config, runId, { ...(cursor !== undefined && { cursor }) }, fetchImpl)
      events = page.events
      nextCursor = page.nextCursor
    } catch (err) {
      return toCommandFailure(err)
    }

    for (const event of events) {
      log(`seq=${event.sequenceNumber} type=${event.type} t=${new Date(event.timestamp).toISOString()}`)
      eventsSeen++
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        return { ok: true, exitCode: 0, eventsSeen, stopReason: 'terminal' }
      }
    }

    cursor = nextCursor ?? cursor
    await sleep(intervalMs)
  }
}

export function printTailSummary(result: TailResult, log: (line: string) => void = console.log): void {
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return
  }
  const reason =
    result.stopReason === 'terminal'
      ? 'run reached a terminal state'
      : result.stopReason === 'interrupted'
        ? 'stopped'
        : 'stopped after reaching the maximum tail duration'
  log(`\n(${reason} — ${result.eventsSeen} event(s) seen)`)
}
