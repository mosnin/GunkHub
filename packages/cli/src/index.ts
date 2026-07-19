/**
 * @agent-flight-recorder/cli
 *
 * `afr` — command-line interface for Agent Flight Recorder. Authenticates
 * against a deployment via `AFR_API_KEY` / `AFR_BASE_URL` env vars (see
 * `src/env.ts`).
 *
 * Command dispatch is structured so cycle 2 (the read API — `GET /api/runs`,
 * `GET /api/runs/:id`, replay/tail/export) only has to replace the
 * `scaffoldedCommand(...)` calls below with real handlers; the arg parsing,
 * dispatch tree, and exit-code conventions are already in place.
 */
import { parseArgs } from 'node:util'

import { printConfigCheck, runConfigCheck } from './commands/config-check.js'
import { printRecordDemo, runRecordDemo } from './commands/record-demo.js'
import { printScaffolded, scaffoldedCommand } from './commands/scaffolded.js'
import { runVersion } from './commands/version.js'

export { readEnv } from './env.js'
export type { CliEnv } from './env.js'
export { CLI_VERSION } from './version.js'
export { runVersion } from './commands/version.js'
export { runConfigCheck, printConfigCheck } from './commands/config-check.js'
export type { ConfigCheck, ConfigCheckResult, FetchLike } from './commands/config-check.js'
export { runRecordDemo, printRecordDemo } from './commands/record-demo.js'
export type { RecordDemoResult } from './commands/record-demo.js'
export { scaffoldedCommand, printScaffolded } from './commands/scaffolded.js'
export type { ScaffoldedResult } from './commands/scaffolded.js'

function printHelp(log: (line: string) => void = console.log): void {
  log(`afr — Agent Flight Recorder CLI

Usage:
  afr <command> [subcommand] [args]

Commands:
  afr record demo            Run a small demo agent end-to-end against your configured backend
  afr config check           Validate AFR_API_KEY / AFR_BASE_URL and ping /api/health
  afr version                Print CLI and SDK version

Coming in cycle 2 (requires the read API):
  afr runs list               List runs
  afr runs get <runId>         Get a single run
  afr replay <runId>           Replay a run
  afr tail <runId>             Tail a run's events live
  afr export <runId>           Export a run

Environment variables:
  AFR_API_KEY                 Organization API key
  AFR_BASE_URL                Base URL of your Agent Flight Recorder deployment
`)
}

/**
 * Top-level command dispatch, exported (rather than only reachable via the
 * CLI entry point below) so tests can exercise arg parsing and dispatch
 * in-process instead of spawning a subprocess.
 *
 * @param argv - argv WITHOUT the `node`/script prefix (i.e. `process.argv.slice(2)`)
 * @returns process exit code
 */
export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values['help']) {
    printHelp(log)
    return 0
  }

  const [command, subcommand, ...rest] = positionals

  switch (command) {
    case undefined:
    case 'help':
      printHelp(log)
      return command === undefined ? 1 : 0

    case 'version':
      return runVersion(log)

    case 'config': {
      if (subcommand === 'check') {
        const result = await runConfigCheck()
        printConfigCheck(result, log)
        return result.ok ? 0 : 1
      }
      log(`Unknown 'config' subcommand: ${subcommand ?? '(none)'}. Try 'afr config check'.`)
      return 1
    }

    case 'record': {
      if (subcommand === 'demo') {
        const result = await runRecordDemo()
        printRecordDemo(result, log)
        return result.success ? 0 : 1
      }
      log(`Unknown 'record' subcommand: ${subcommand ?? '(none)'}. Try 'afr record demo'.`)
      return 1
    }

    // Scaffolded for cycle 2 — see file header.
    case 'runs': {
      if (subcommand === 'list' || subcommand === 'get') {
        printScaffolded(scaffoldedCommand(`runs ${subcommand}${rest.length > 0 ? ` ${rest.join(' ')}` : ''}`), log)
        return 1
      }
      log(`Unknown 'runs' subcommand: ${subcommand ?? '(none)'}. Try 'afr runs list' or 'afr runs get <runId>'.`)
      return 1
    }
    case 'replay':
      printScaffolded(scaffoldedCommand(`replay${subcommand ? ` ${subcommand}` : ''}`), log)
      return 1
    case 'tail':
      printScaffolded(scaffoldedCommand(`tail${subcommand ? ` ${subcommand}` : ''}`), log)
      return 1
    case 'export':
      printScaffolded(scaffoldedCommand(`export${subcommand ? ` ${subcommand}` : ''}`), log)
      return 1

    default:
      log(`Unknown command: ${command}. Run 'afr help' for usage.`)
      return 1
  }
}

// Only run when this module is the process entry point (not when imported by tests).
const isMainModule =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`

if (isMainModule) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    })
}
