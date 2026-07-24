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

### `afr init`

Frictionless first-run onboarding: get from zero to a recorded run in one command + one run.

1. Checks `AFR_API_KEY` / `AFR_BASE_URL` and pings `GET /api/health` (the same checks as `afr config check`).
2. Writes a small, runnable starter file (`afr-quickstart.mjs` by default) — plain ESM, no build step — that imports `@agent-flight-recorder/sdk`, records one small demo run end-to-end against your configured backend, and prints the run's web URL.
3. Prints exact next steps.

```bash
$ afr init
[ok] AFR_API_KEY: set
[ok] AFR_BASE_URL: https://your-afr-instance.example.com
[ok] GET /api/health: HTTP 200

Wrote starter file: afr-quickstart.mjs

Next steps:
  1. Run: node afr-quickstart.mjs
  2. Run: afr runs list
```

Never overwrites an existing file — re-running `afr init` after the file already exists reports a skip instead of clobbering your edits:

```bash
$ afr init
...
Skipped writing afr-quickstart.mjs — it already exists. Pass --force to overwrite it.
```

The scaffold is written even if `AFR_API_KEY`/`AFR_BASE_URL` aren't configured yet — the config-check output above it tells you what to set, and "next steps" adds a step to fix that first.

Options: `--out <file>` (default: `afr-quickstart.mjs`), `--force` (overwrite an existing file).

### `afr explain <runId>`

Fetches and renders the root-cause explanation for a run — the CLI moment for the flagship "explainability layer" feature: the failure class as a header, a plain-English summary, the root cause, a suggested fix (when the server generated one), and the event sequence numbers the explanation is grounded in, so you can jump straight to them with `afr replay <runId>` or `afr tail <runId>`.

```bash
$ afr explain run_a1b2c3d4e5f6
============================================================
  Tool Error
============================================================

Summary:
  The agent called a tool that timed out and never recovered.

Root cause:
  The `lookup_order` tool call at seq=4 exceeded its timeout.

Suggested fix:
  Add a retry with backoff around `lookup_order`.

Cited events (seq): 3, 4, 5
  -> jump to them with 'afr replay run_a1b2c3d4e5f6' or 'afr tail run_a1b2c3d4e5f6'

Generated: 2026-07-18T09:12:06.000Z
```

**Honest states** — a run that hasn't failed, or a failed run whose explanation isn't generated yet, print a plain message instead of an error:

```bash
$ afr explain run_completed_ok
This run completed successfully — nothing to explain.

$ afr explain run_failed_but_pending
An explanation hasn't been generated for this run yet.
Check back shortly, or run 'afr replay run_failed_but_pending' for the raw failure summary in the meantime.
```

Options: `--json` (prints the raw, derived `{ ok, status, ... }` result).

**How the honest states are derived:** the v1 explanation endpoint itself only ever resolves "an explanation, or null" (mirroring the already-shipped Clerk-authed `GET /api/runs/:id/explanation` — see `docs/design/explanations.md`'s "Known gap: coarse null state"; it cannot tell "not failed" apart from "not explained yet" on its own). `afr explain` disambiguates those two itself by also fetching the run (`afr runs get`'s underlying call) and checking its `status`: `'failed'`/`'timed_out'` + no explanation -> "pending"; anything else + no explanation -> "not_failed". See `packages/cli/src/commands/explain.ts` / `FlightReader.getExplanation()`'s doc in the SDK README for the full writeup.

**Backend status (as of this cycle):** `GET /api/v1/runs/:id/explanation` (the key-authed v1 counterpart of the Clerk-authed route above) does not exist server-side yet. Until it ships, `afr explain` surfaces a "not found" error for every run.

### `afr patterns`

Lists recurring failure patterns for your organization — a durable memory of fingerprinted, recurring failures derived from failed runs (PREVENTION cycle 1, ADR-005). Each row is a rollup: a class, a human label, how many times it has recurred, first/last seen timestamps, and whether the periodic spike-rollup cron currently flags it as spiking.

```bash
$ afr patterns
ID            CLASS        LABEL                                  COUNT  FIRST SEEN                LAST SEEN                 SPIKING
fp_a1b2c3d4e…  tool_error   lookup_order tool call times out       12     2026-07-10T09:00:00.000Z  2026-07-24T14:32:00.000Z  yes

$ afr patterns --agent agent_support --limit 10 --json
{
  "ok": true,
  "patterns": [ ... ],
  "nextCursor": null
}
```

Options: `--agent <agentId>` (only patterns seen on at least one version of this agent), `--limit <n>`, `--json` (prints the raw API response).

Like every other read here, this is derived, observability-grade data (CLAUDE.md) — never a substitute for a single run's own event log or `afr explain <runId>`.

### `afr config check`

Validates that `AFR_API_KEY` / `AFR_BASE_URL` are set and pings `GET {AFR_BASE_URL}/api/health`. Exits `0` if everything checks out, `1` otherwise.

```bash
$ afr config check
[ok] AFR_API_KEY: set
[ok] AFR_BASE_URL: https://your-afr-instance.example.com
[ok] GET /api/health: HTTP 200

Configuration OK.
```

**Known gap:** this does not currently report the configured key's scope
(`read` vs `ingest:write`/`ingest:read` — see `docs/api_reference.md`'s
Scopes section). The v1 read API has no introspection/"whoami" endpoint that
returns a key's own scopes, so there is nothing for `afr` to call to learn
it client-side without guessing from a live request's success/failure. If a
future cycle adds such an endpoint, `config check` should call it and print
the scope alongside the existing checks.

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
afr (Agent Flight Recorder CLI) v0.4.0
sdk: v0.8.0
```

### `afr --help` / `afr help`

Prints the command tree and environment variable reference. Every subcommand also
accepts its own `--help` (e.g. `afr runs list --help`), printed instead of running
the command.

## Read-API commands (DONE)

The commands below talk to the public v1 read API (`GET /api/v1/runs`,
`/api/v1/runs/:id`, `/api/v1/runs/:id/events`, `/api/v1/runs/:id/replay`) —
`x-api-key` auth with `read` scope, `{ apiVersion, data }` JSON envelopes on
success and `{ apiVersion, error: { code, message } }` on failure.

`afr` is built on `@agent-flight-recorder/sdk`'s `FlightReader` — the SDK's
own typed read client. `src/apiClient.ts` is a thin wrapper over
`FlightReader` (it adds only the CLI's process exit-code convention on top
of the SDK's `V1ApiError`); the fetch call, envelope parsing, and HTTP-status
mapping live in exactly one place, `packages/sdk/src/v1-client.ts`, shared by
both. See the SDK README's "Reading runs back (FlightReader)" section if you
want the same read access from your own script instead of the CLI.

Exit codes are consistent across all commands: `0` ok, `1` usage (e.g. missing
`AFR_API_KEY`/`AFR_BASE_URL`, missing required argument), `2` auth (401/403 —
bad key or missing `read` scope), `3` not found (404), `4` network/rate-limit/
server error (429/5xx/connection failure/malformed response).

### `afr runs list`

```bash
$ afr runs list --status failed --limit 5
ID            STATUS  AGENT           STARTED                   ENDED
run_a1b2c3d…  failed  agent_support   2026-07-18T09:12:03.000Z  2026-07-18T09:12:05.500Z
run_e4f5a6b…  failed  agent_support   2026-07-18T08:55:41.000Z  2026-07-18T08:55:44.200Z

$ afr runs list --agent agent_support --json
{ "runs": [ ... ], "total": 2 }
```

Options: `--status`, `--agent`, `--env`, `--session`, `--limit`, `--json`. Prints
`No runs found.` for an empty result set instead of an empty table.

`--triage <state>` (`open|investigating|resolved`) and `--label <tag>` are
also accepted, but **filter client-side** — the v1 read API has no
server-side triage/tag filter as of this cycle (see
`docs/api_reference.md`), so these only narrow the runs already returned on
the current page. Combine with `--status`/`--agent`/`--limit` to narrow the
server-side query first if you need results beyond one page.

### `afr runs get <runId>`

```bash
$ afr runs get run_a1b2c3d4e5f6
Run:          run_a1b2c3d4e5f6
Status:       failed
Agent:        agent_support (version ver_1_2_0)
Project:      proj_demo
Started:      2026-07-18T09:12:03.000Z
Ended:        2026-07-18T09:12:05.500Z
Duration:     2.5s
Events:       14
Artifacts:    1
```

Options: `--json`.

### `afr replay <runId>`

Fetches the replay projection and renders it as a readable transcript —
`RUN_STARTED -> ... -> terminal` — the way the landing page's terminal mock
advertises, plus a failure summary when the run failed.

```bash
$ afr replay run_a1b2c3d4e5f6
Run run_a1b2c3d4e5f6 — 14 event(s), 2500ms

+0ms       run.started      (agent)  input: "Help me track my order #98765"
+120ms     llm.request      (llm)    model=gpt-4o
+980ms     llm.response     (llm)    "I'll look up order #98765..."
  +1010ms  tool.call        (tool)   lookup_order({"order_id":"98765"})
  +1120ms  tool.result      (tool)   {"status":"shipped"}
+2500ms    run.failed       (agent)  Timeout waiting for upstream [ERROR] [DONE]

Failure summary:
  Primary failure: seq=8 type=run.failed reason=run_failed — Timeout waiting for upstream
```

Options: `--json` (prints the raw `{ projection, failureSummary }`).

### `afr tail <runId>`

Polls `GET /api/v1/runs/:id/events` and prints new events as they arrive.
Stops automatically on a terminal event (`run.completed`/`run.failed`/
`run.cancelled`), after a 10-minute max duration, or on Ctrl-C.

```bash
$ afr tail run_a1b2c3d4e5f6
seq=1 type=run.started t=2026-07-18T09:12:03.000Z
seq=2 type=llm.request t=2026-07-18T09:12:03.120Z
seq=3 type=llm.response t=2026-07-18T09:12:03.980Z
seq=4 type=run.completed t=2026-07-18T09:12:05.500Z

(run reached a terminal state — 4 event(s) seen)
```

Options: `--interval <ms>` (poll interval, default 2000).

### `afr export <runId>`

Assembles a run's run record, full event log, and replay projection as an
ndjson (default) or json bundle.

**Auth note:** the web app's bundle endpoint (`GET /api/export/runs/:runId`)
is Clerk-session-authed, not key-authed — a key-authed CLI cannot call it
directly. `afr export` instead assembles the same kind of bundle
client-side from the v1 read API (`/api/v1/runs/:id`, `/events`, `/replay`),
so the CLI stays key-authed end to end. This means a CLI export is a
**subset** of the web app's: it does NOT include artifacts or comments,
since the v1 read API does not expose those (as of this cycle). Use the web
app's export for a complete bundle.

```bash
$ afr export run_a1b2c3d4e5f6 --out run.ndjson
Wrote 14 event(s) to run.ndjson

$ afr export run_a1b2c3d4e5f6 --format json | jq .run.status
"failed"
```

Options: `--out <file>` (default: print to stdout), `--format ndjson|json`
(default: `ndjson`).

## Development

This package builds with `tsup` (single ESM bundle, shebang banner) and is typechecked/linted/tested the same way as `@agent-flight-recorder/sdk`:

```bash
pnpm --filter @agent-flight-recorder/cli build
pnpm --filter @agent-flight-recorder/cli typecheck
pnpm --filter @agent-flight-recorder/cli lint
pnpm --filter @agent-flight-recorder/cli test
```

Command dispatch lives in `src/index.ts` (`main(argv)`, parsed with `node:util`'s `parseArgs`) and delegates to one handler module per command family under `src/commands/`. Each handler is a plain exported function (e.g. `runConfigCheck`, `runRecordDemo`) so it can be unit-tested in-process without spawning a subprocess or making real HTTP calls — `afr record demo`'s tests inject a mock `Transport` the same way the SDK's own test suite does.
