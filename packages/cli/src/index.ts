/**
 * @agent-flight-recorder/cli
 *
 * `afr` — command-line interface for Agent Flight Recorder. Authenticates
 * against a deployment via `AFR_API_KEY` / `AFR_BASE_URL` env vars (see
 * `src/env.ts`).
 *
 * `init` / `record demo` / `config check` / `version` talk to the SDK /
 * `/api/health` directly. `runs list|get`, `replay`, `tail`, `export`, and
 * `explain` talk to the public v1 read API (`GET /api/v1/runs...`, see
 * `src/apiClient.ts`) via `x-api-key` auth.
 */
import { COMPAT_HELP, exitCodeForCompat, parseCompatArgs, printCompat, runCompat } from './commands/compat.js'
import { printConfigCheck, runConfigCheck } from './commands/config-check.js'
import { EXPLAIN_HELP, parseExplainArgs, printExplain, runExplain } from './commands/explain.js'
import { EXPORT_HELP, parseExportArgs, printExport, runExport } from './commands/export.js'
import { INIT_HELP, parseInitArgs, printInit, runInit } from './commands/init.js'
import {
  PATTERNS_EVIDENCE_HELP,
  parsePatternsEvidenceArgs,
  printPatternsEvidence,
  runPatternsEvidence,
} from './commands/patterns-evidence.js'
import { PATTERNS_HELP, parsePatternsArgs, printPatterns, runPatterns } from './commands/patterns.js'
import { printRecordDemo, runRecordDemo } from './commands/record-demo.js'
import { REPLAY_HELP, parseReplayArgs, printReplay, runReplay } from './commands/replay.js'
import { RUNS_GET_HELP, parseRunsGetArgs, printRunsGet, runRunsGet } from './commands/runs-get.js'
import { RUNS_LIST_HELP, parseRunsListArgs, printRunsList, runRunsList } from './commands/runs-list.js'
import { TAIL_HELP, parseTailArgs, printTailSummary, runTail } from './commands/tail.js'
import { TRIAGE_HELP, exitCodeForTriage, parseTriageArgs, printTriage, runTriage } from './commands/triage.js'
import { runVersion } from './commands/version.js'

export { readEnv } from './env.js'
export type { CliEnv } from './env.js'
export { CLI_VERSION } from './version.js'
export { runVersion } from './commands/version.js'
export {
  parseCompatArgs,
  runCompat,
  printCompat,
  exitCodeForCompat,
  COMPAT_EXIT_DIVERGENCE,
  COMPAT_EXIT_INDETERMINATE,
  DEFAULT_FAIL_ON,
  DEFAULT_MAX_PAGES,
} from './commands/compat.js'
export type {
  CompatArgs,
  CompatCommandResult,
  CompatRunResult,
  CompatFleetResult,
  CompatFailOn,
} from './commands/compat.js'
export { runConfigCheck, printConfigCheck } from './commands/config-check.js'
export type { ConfigCheck, ConfigCheckResult, FetchLike } from './commands/config-check.js'
export { runRecordDemo, printRecordDemo } from './commands/record-demo.js'
export type { RecordDemoResult } from './commands/record-demo.js'
export { parseInitArgs, runInit, printInit, quickstartFileContents, DEFAULT_QUICKSTART_FILE } from './commands/init.js'
export type { InitArgs, InitResult, FileExistsLike, WriteFileLike as InitWriteFileLike } from './commands/init.js'
export { parseExplainArgs, runExplain, printExplain } from './commands/explain.js'
export type { ExplainArgs, ExplainResult } from './commands/explain.js'
export { parsePatternsArgs, runPatterns, printPatterns } from './commands/patterns.js'
export type { PatternsArgs, PatternsResult } from './commands/patterns.js'
export {
  parsePatternsEvidenceArgs,
  runPatternsEvidence,
  printPatternsEvidence,
} from './commands/patterns-evidence.js'
export type { PatternsEvidenceArgs, PatternsEvidenceResult } from './commands/patterns-evidence.js'
export * from './apiClient.js'
export { parseRunsListArgs, runRunsList, printRunsList } from './commands/runs-list.js'
export type { RunsListArgs, RunsListResult } from './commands/runs-list.js'
export { parseRunsGetArgs, runRunsGet, printRunsGet } from './commands/runs-get.js'
export type { RunsGetArgs, RunsGetResult } from './commands/runs-get.js'
export { parseReplayArgs, runReplay, printReplay } from './commands/replay.js'
export type { ReplayArgs, ReplayResult } from './commands/replay.js'
export { parseTailArgs, runTail, printTailSummary } from './commands/tail.js'
export type { TailArgs, TailOptions, TailResult, TailStopReason } from './commands/tail.js'
export {
  parseTriageArgs,
  runTriage,
  printTriage,
  exitCodeForTriage,
  TRIAGE_EXIT_FINDINGS,
  TRIAGE_EXIT_INCOMPLETE,
} from './commands/triage.js'
export type { TriageArgs, TriageCommandResult } from './commands/triage.js'
export { parseExportArgs, runExport, printExport } from './commands/export.js'
export type { ExportArgs, ExportResult, ExportBundle, WriteFileLike } from './commands/export.js'
export type { CommandFailure } from './commands/shared.js'

function printHelp(log: (line: string) => void = console.log): void {
  log(`afr — Agent Flight Recorder CLI

Usage:
  afr <command> [subcommand] [args]

Commands:
  afr triage                    START HERE: what is wrong right now, and what to look at first
  afr init                      Zero-to-recorded-run onboarding: check config, write a starter file, print next steps
  afr record demo              Run a small demo agent end-to-end against your configured backend
  afr config check             Validate AFR_API_KEY / AFR_BASE_URL and ping /api/health
  afr version                  Print CLI and SDK version
  afr runs list [options]       List runs
  afr runs get <runId>          Get a single run
  afr replay <runId>            Replay a run's event sequence as a transcript
  afr tail <runId>               Tail a run's events live
  afr export <runId>             Export a run's run/events/replay bundle
  afr explain <runId>            Root-cause explanation for a run — failure class, summary, root cause, suggested fix
  afr patterns [options]         List recurring failure patterns for your organization
  afr patterns evidence <hash>   Show whether a pattern's fix actually held (exposure + confidence)
  afr compat <runId> --target <versionId>
                                 Can I ship this version? Replays a recorded run's
                                 history against another version's config and reports
                                 what it PROVABLY breaks (and, separately, what it
                                 might). --agent <id> for the fleet-wide answer.

Run 'afr <command> --help' for command-specific options.

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
 * @returns process exit code (0 ok, 1 usage, 2 auth, 3 not-found, 4 network/server)
 */
export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  if (argv.length === 0) {
    printHelp(log)
    return 1
  }

  const [command, ...afterCommand] = argv

  // `--help`/`-h`/`help` are only special-cased as the FIRST token (bare
  // `afr --help`). Anything after a real command is left in `afterCommand`
  // untouched, so e.g. `afr runs get --help` reaches parseRunsGetArgs and
  // prints THAT command's help — not the global one.
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp(log)
    return 0
  }

  switch (command) {
    case 'version':
      return runVersion(log)

    case 'config': {
      const [subcommand] = afterCommand
      if (subcommand === 'check') {
        const result = await runConfigCheck()
        printConfigCheck(result, log)
        return result.ok ? 0 : 1
      }
      log(`Unknown 'config' subcommand: ${subcommand ?? '(none)'}. Try 'afr config check'.`)
      return 1
    }

    case 'init': {
      const args = parseInitArgs(afterCommand)
      if (args.help) {
        log(INIT_HELP)
        return 0
      }
      const result = await runInit(args)
      printInit(result, log)
      return result.exitCode
    }

    case 'triage': {
      const args = parseTriageArgs(afterCommand)
      if (args.help) {
        log(TRIAGE_HELP)
        return 0
      }
      const result = await runTriage(args)
      printTriage(args, result, log)
      // Transport/usage failures keep the shared 0-4 convention; a SUCCESSFUL
      // triage maps its verdict to 0/10/11. Exit 0 is unreachable unless the
      // verdict is 'clear', which is only produced by a complete scan.
      return result.ok ? exitCodeForTriage(result) : result.exitCode
    }

    case 'compat': {
      const args = parseCompatArgs(afterCommand)
      if (args.help) {
        log(COMPAT_HELP)
        return 0
      }
      const result = await runCompat(args)
      printCompat(args, result, log)
      // Transport/usage failures keep the shared 0-4 convention; a SUCCESSFUL
      // analysis maps its own findings to 0/10/11 through the explicit
      // --fail-on threshold. Exit 0 is unreachable on an incomplete analysis
      // unless --fail-on none was passed, which is not a gate.
      return result.ok ? exitCodeForCompat(result) : result.exitCode
    }

    case 'explain': {
      const args = parseExplainArgs(afterCommand)
      if (args.help) {
        log(EXPLAIN_HELP)
        return 0
      }
      if (!args.runId) {
        log("Usage: afr explain <runId>. Run 'afr explain --help' for details.")
        return 1
      }
      const result = await runExplain(args.runId)
      printExplain(args, result, log)
      return result.ok ? 0 : result.exitCode
    }

    case 'patterns': {
      // `evidence` is the only subcommand — every other token stream is the
      // bare `afr patterns [options]` list, so flags keep working unchanged.
      if (afterCommand[0] === 'evidence') {
        const args = parsePatternsEvidenceArgs(afterCommand.slice(1))
        if (args.help) {
          log(PATTERNS_EVIDENCE_HELP)
          return 0
        }
        if (!args.fingerprintHash) {
          log("Usage: afr patterns evidence <fingerprintHash>. Run 'afr patterns evidence --help' for details.")
          return 1
        }
        const result = await runPatternsEvidence(args.fingerprintHash)
        printPatternsEvidence(args, result, log)
        return result.ok ? 0 : result.exitCode
      }

      const args = parsePatternsArgs(afterCommand)
      if (args.help) {
        log(PATTERNS_HELP)
        return 0
      }
      const result = await runPatterns(args)
      printPatterns(args, result, log)
      return result.ok ? 0 : result.exitCode
    }

    case 'record': {
      const [subcommand] = afterCommand
      if (subcommand === 'demo') {
        const result = await runRecordDemo()
        printRecordDemo(result, log)
        return result.success ? 0 : 1
      }
      log(`Unknown 'record' subcommand: ${subcommand ?? '(none)'}. Try 'afr record demo'.`)
      return 1
    }

    case 'runs': {
      const [subcommand, ...rest] = afterCommand
      if (subcommand === 'list') {
        const args = parseRunsListArgs(rest)
        if (args.help) {
          log(RUNS_LIST_HELP)
          return 0
        }
        const result = await runRunsList(args)
        printRunsList(args, result, log)
        return result.ok ? 0 : result.exitCode
      }
      if (subcommand === 'get') {
        const args = parseRunsGetArgs(rest)
        if (args.help) {
          log(RUNS_GET_HELP)
          return 0
        }
        if (!args.runId) {
          log("Usage: afr runs get <runId>. Run 'afr runs get --help' for details.")
          return 1
        }
        const result = await runRunsGet(args.runId)
        printRunsGet(args, result, log)
        return result.ok ? 0 : result.exitCode
      }
      log(`Unknown 'runs' subcommand: ${subcommand ?? '(none)'}. Try 'afr runs list' or 'afr runs get <runId>'.`)
      return 1
    }

    case 'replay': {
      const args = parseReplayArgs(afterCommand)
      if (args.help) {
        log(REPLAY_HELP)
        return 0
      }
      if (!args.runId) {
        log("Usage: afr replay <runId>. Run 'afr replay --help' for details.")
        return 1
      }
      const result = await runReplay(args.runId)
      printReplay(args, result, log)
      return result.ok ? 0 : result.exitCode
    }

    case 'tail': {
      const args = parseTailArgs(afterCommand)
      if (args.help) {
        log(TAIL_HELP)
        return 0
      }
      if (!args.runId) {
        log("Usage: afr tail <runId>. Run 'afr tail --help' for details.")
        return 1
      }

      // Wire Ctrl-C to a graceful stop rather than an abrupt process kill, so
      // the loop's own exit-code / summary printing still runs.
      let interrupted = false
      const onSigint = (): void => {
        interrupted = true
      }
      const proc = (globalThis as { process?: { on(event: string, listener: () => void): unknown; off(event: string, listener: () => void): unknown } }).process
      proc?.on('SIGINT', onSigint)
      try {
        const result = await runTail(
          args.runId,
          undefined,
          undefined,
          { ...(args.interval !== undefined && { intervalMs: args.interval }), shouldStop: () => interrupted },
          log
        )
        printTailSummary(result, log)
        return result.ok ? 0 : result.exitCode
      } finally {
        proc?.off('SIGINT', onSigint)
      }
    }

    case 'export': {
      const args = parseExportArgs(afterCommand)
      if (args.help) {
        log(EXPORT_HELP)
        return 0
      }
      if (!args.runId) {
        log("Usage: afr export <runId>. Run 'afr export --help' for details.")
        return 1
      }
      const result = await runExport(args.runId, args)
      printExport(result, log)
      return result.ok ? 0 : result.exitCode
    }

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
