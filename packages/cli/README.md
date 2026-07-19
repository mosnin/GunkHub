# Agent Flight Recorder CLI (`afr`)

Command-line interface for Agent Flight Recorder. Authenticates against a deployment via environment variables — no config file, no flags to repeat on every invocation.

## Installation

```bash
npm install -g @agent-flight-recorder/cli
# or run without installing:
npx @agent-flight-recorder/cli version
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AFR_API_KEY` | Yes | Organization API key |
| `AFR_BASE_URL` | Yes | Base URL of your Agent Flight Recorder deployment (e.g. `https://afr.example.com`) |

Set them in your shell, or export them in CI as secrets:

```bash
export AFR_API_KEY="your_api_key"
export AFR_BASE_URL="https://your-afr-instance.example.com"
```

## Command reference

### `afr config check`

Validates that `AFR_API_KEY` / `AFR_BASE_URL` are set and pings `GET {AFR_BASE_URL}/api/health`. Exits `0` if everything checks out, `1` otherwise.

```bash
$ afr config check
[ok] AFR_API_KEY: set
[ok] AFR_BASE_URL: https://your-afr-instance.example.com
[ok] GET /api/health: HTTP 200

Configuration OK.
```

### `afr record demo`

Runs a small, representative demo agent end-to-end through the SDK against your configured backend: starts a run, records an `llm.request`/`llm.response` pair and a `tool.call`/`tool.result` pair, then ends the run. This is a real smoke test — run it right after installing to confirm your API key and base URL are wired up correctly, before instrumenting your own agent.

```bash
$ afr record demo
Run ID: run_abc123
Events recorded: 4
Demo run completed successfully.
```

### `afr version`

Prints the CLI and SDK versions.

```bash
$ afr version
afr (Agent Flight Recorder CLI) v0.1.0
sdk: v0.4.0
```

### `afr --help` / `afr help`

Prints the command tree and environment variable reference.

## Coming in cycle 2

The following commands are scaffolded (they parse correctly and exit `1` with a clear message) but not yet implemented — they depend on the read API (`GET /api/runs`, `GET /api/runs/:id`, and the replay/tail/export endpoints), which lands in cycle 2 after coordination with the data/ui teams:

```bash
afr runs list               # List runs
afr runs get <runId>        # Get a single run
afr replay <runId>          # Replay a run
afr tail <runId>            # Tail a run's events live
afr export <runId>          # Export a run
```

## Development

This package builds with `tsup` (single ESM bundle, shebang banner) and is typechecked/linted/tested the same way as `@agent-flight-recorder/sdk`:

```bash
pnpm --filter @agent-flight-recorder/cli build
pnpm --filter @agent-flight-recorder/cli typecheck
pnpm --filter @agent-flight-recorder/cli lint
pnpm --filter @agent-flight-recorder/cli test
```

Command dispatch lives in `src/index.ts` (`main(argv)`, parsed with `node:util`'s `parseArgs`) and delegates to one handler module per command family under `src/commands/`. Each handler is a plain exported function (e.g. `runConfigCheck`, `runRecordDemo`) so it can be unit-tested in-process without spawning a subprocess or making real HTTP calls — `afr record demo`'s tests inject a mock `Transport` the same way the SDK's own test suite does.
