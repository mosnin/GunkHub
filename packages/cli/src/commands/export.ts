import { parseArgs } from 'node:util'

import { getRun, getRunEvents, getRunReplay } from '../apiClient.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike } from '../apiClient.js'
import type { CliEnv } from '../env.js'
import type { Event, Run } from '@agent-flight-recorder/contracts'

export const EXPORT_HELP = `Usage: afr export <runId> [options]

Export a run's run record, full event log, and replay projection as a bundle.

NOTE ON AUTH: the web app's ndjson bundle endpoint
(GET /api/export/runs/:runId) is Clerk-session-authed, not key-authed, so a
key-authed CLI cannot call it directly. This command instead assembles the
same kind of bundle client-side from the v1 read API
(GET /api/v1/runs/:id, /events, /replay) — every field the v1 API exposes is
included; artifacts and comments are NOT (the v1 read API does not expose
them as of this cycle), so a bundle from this command is a subset of the web
app's export. Use the web app's export for a complete bundle including
artifacts/comments.

Options:
  --out <file>              Write to a file instead of stdout
  --format <ndjson|json>    Output format (default: ndjson)
  --help                    Show this message
`

export interface ExportArgs {
  runId?: string
  out?: string
  format?: 'ndjson' | 'json'
  help?: boolean
}

/** Parse `afr export` args (argv AFTER `export` — i.e. `[<runId>, ...flags]`). */
export function parseExportArgs(argv: string[]): ExportArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: ExportArgs = {}
  if (positionals[0]) result.runId = positionals[0]
  if (values['out']) result.out = values['out']
  if (values['format'] === 'json' || values['format'] === 'ndjson') result.format = values['format']
  if (values['help']) result.help = true
  return result
}

export interface ExportBundle {
  apiVersion: 'v1'
  run: Run
  events: Event[]
  replay: Awaited<ReturnType<typeof getRunReplay>>
}

const EVENTS_PAGE_SIZE = 500

/** Injectable file writer so tests never touch a real filesystem. */
export type WriteFileLike = (path: string, content: string) => Promise<void>

async function defaultWriteFile(path: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, content, 'utf8')
}

/** Assemble a run's export bundle client-side from the v1 read API (run + all events, paginated + replay). */
async function assembleBundle(
  config: import('../apiClient.js').ApiClientConfig,
  runId: string,
  fetchImpl?: ApiFetchLike
): Promise<ExportBundle> {
  const [{ run }, replay] = await Promise.all([getRun(config, runId, fetchImpl), getRunReplay(config, runId, fetchImpl)])

  const events: Event[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await getRunEvents(
      config,
      runId,
      { limit: EVENTS_PAGE_SIZE, ...(cursor !== undefined && { cursor }) },
      fetchImpl
    )
    events.push(...page.events)
    cursor = page.nextCursor
    if (!cursor || page.events.length === 0) break
  }

  return { apiVersion: 'v1', run, events, replay }
}

function renderNdjson(bundle: ExportBundle): string {
  const lines: string[] = []
  lines.push(JSON.stringify({ record: 'run', run: bundle.run }))
  for (const event of bundle.events) {
    lines.push(JSON.stringify({ record: 'event', event }))
  }
  lines.push(JSON.stringify({ record: 'replay', ...bundle.replay }))
  return `${lines.join('\n')}\n`
}

function renderJson(bundle: ExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

export type ExportResult =
  | { ok: true; exitCode: 0; content: string; destination?: string; eventCount: number }
  | CommandFailure

/** `afr export <runId>` — assemble and write/print a run's export bundle from the v1 read API. */
export async function runExport(
  runId: string,
  args: ExportArgs,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike,
  writeFileImpl: WriteFileLike = defaultWriteFile
): Promise<ExportResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  const format = args.format ?? 'ndjson'

  let bundle: ExportBundle
  try {
    bundle = await assembleBundle(config, runId, fetchImpl)
  } catch (err) {
    return toCommandFailure(err)
  }

  const content = format === 'json' ? renderJson(bundle) : renderNdjson(bundle)

  if (args.out) {
    try {
      await writeFileImpl(args.out, content)
    } catch (err) {
      return { ok: false, exitCode: 4, message: `Failed to write ${args.out}: ${err instanceof Error ? err.message : String(err)}` }
    }
    return { ok: true, exitCode: 0, content, destination: args.out, eventCount: bundle.events.length }
  }

  return { ok: true, exitCode: 0, content, eventCount: bundle.events.length }
}

export function printExport(result: ExportResult, log: (line: string) => void = console.log): void {
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return
  }
  if (result.destination) {
    log(`Wrote ${result.eventCount} event(s) to ${result.destination}`)
    return
  }
  log(result.content)
}
