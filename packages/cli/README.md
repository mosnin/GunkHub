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

Lists recurring failure patterns for your organization — a durable memory of fingerprinted, recurring failures derived from failed runs (PREVENTION cycle 1, ADR-005). Each row is a rollup: a class, a human label, how many times it has recurred, first/last seen timestamps, whether the periodic spike-rollup cron currently flags it as spiking (and, when spiking, its `recentCount`), and whether an org admin has muted it (PREVENTION cycle 3).

```bash
$ afr patterns
ID            CLASS        LABEL                                  COUNT  FIRST SEEN                LAST SEEN                 SPIKING       MUTED  STATUS
fp_a1b2c3d4e…  tool_error   lookup_order tool call times out       12     2026-07-10T09:00:00.000Z  2026-07-24T14:32:00.000Z  yes (9)       -      open
fp_f6e5d4c3b…  tool_error   flaky_search tool call 5xx             40     2026-06-01T09:00:00.000Z  2026-07-23T11:00:00.000Z  yes (6) [muted]  yes    REGRESSED

$ afr patterns --agent agent_support --limit 10 --json
{
  "ok": true,
  "patterns": [ ... ],
  "nextCursor": null
}

$ afr patterns --spiking
# only patterns whose lastSpikeAssessment.isSpiking === true (PREVENTION cycle 2 — proactive prevention)

$ afr patterns --muted     # only patterns an org admin has muted
$ afr patterns --active    # only patterns that are NOT muted

$ afr patterns --status resolved   # only patterns whose lifecycle status is exactly 'resolved'
$ afr patterns --regressed         # only patterns with regressedAt set — a resolved pattern that recurred

$ afr patterns --state regressed   # only fixes that demonstrably did NOT hold (see below)
```

Options: `--agent <agentId>` (only patterns seen on at least one version of this agent), `--spiking` (only patterns currently flagged as spiking), `--muted` / `--active` (mute-aware filter — mutually exclusive, passing both is a usage error, exit 1), `--status <open|acknowledged|resolved>` (exact lifecycle-status filter — an invalid value is a usage error, exit 1), `--regressed` (only patterns with `regressedAt` set), `--state <unproven|proving|confirmed|regressed>` (fix-confidence filter — see below), `--limit <n>`, `--json` (prints the raw API response, including `muted`/`mutedAt` and the full resolution-lifecycle and evidence fields).

**`--state` vs `--status`, and why CI should use `--state regressed`.** `--status` is what a human *asserted*; `--state` is what the *evidence supports* (ADR-006 cycle 2). Only `--state regressed` is answerable on this command — the other three states depend on per-pattern post-resolution run exposure, which cannot be measured across a whole page, so passing them is a usage error (exit 1) that points you at `afr patterns evidence`. It is deliberately not silently ignored.

Prefer `--state regressed` over `--regressed` in a build gate: `--regressed` matches any pattern with `regressedAt` set, **including one whose regression predates its current resolution** (it regressed, was genuinely re-fixed, and was re-resolved — `regressedAt` is kept as history). `--state regressed` matches only a recurrence strictly after the live `resolvedAt`, i.e. a fix that actually did not hold.

**Mute suppresses alerts, not visibility.** A muted, spiking pattern still shows `yes (N)` in the SPIKING column — it is annotated `[muted]` rather than hidden, so it stays visibly distinct from an active spiking pattern. There is deliberately no `afr patterns mute`/`unmute` command: muting a pattern is an admin-only, audited, Clerk-authed org action taken in the web app, not a key-authed read-API action — this command only ever *reflects* mute state.

**Resolution lifecycle (ADR-006, "resolution reflection").** The STATUS column shows a pattern's lifecycle: `open` (the default when no status has ever been set), `acknowledged`, or `resolved`. When a pattern is back to `open` AND carries `regressedAt` — i.e. it was resolved, then received a new occurrence after that ("your fix didn't hold") — the STATUS column shows `REGRESSED` instead of `open`, so a regression stands out from an ordinary open pattern or one a human manually reopened. There is deliberately no `afr patterns resolve`/`acknowledge`/`reopen` command: those are member-gated, audited, Clerk-authed org actions taken in the web app. A key-authed write here would bypass both the member-gate and the audit log those actions require — this command, like the mute reflection above, only ever *reflects* lifecycle state, never mutates it.

Like every other read here, this is derived, observability-grade data (CLAUDE.md) — never a substitute for a single run's own event log or `afr explain <runId>`.

### `afr patterns evidence <fingerprintHash>`

Shows whether a pattern's fix actually **held** (ADR-006 cycle 2, "prove the fix held"). Marking a pattern resolved is an unearned assertion on its own; this command shows what can be checked against that claim — the resolution, the run exposure accumulated since it, a graded confidence verdict, and the pattern's lifecycle history reconstructed from the append-only audit log (automatic reopens by the regression guard appear with actor `system`).

```bash
$ afr patterns evidence a1b2c3d4e5f6
tool_error — lookup_order tool call times out
  fingerprint: a1b2c3d4e5f6
  occurrences: 12 (first 2026-07-10T09:00:00.000Z, last 2026-07-18T02:11:00.000Z)

============================================
  CONFIRMED  (confidence 82%)
============================================

Resolution claimed:
  at:        2026-07-18T09:00:00.000Z
  by:        user_2f9a
  version:   v1.4.0
  note:      Added a retry around the flaky lookup

Exposure since the fix:
  runs:        120
  recurrences: 0
  baseline:    300 runs in the 14 days before the fix (for comparison)
  soak:        8.0d
  agents:      agent_support

Lifecycle (2 transitions, oldest first):
  2026-07-11T10:04:00.000Z  failure_pattern.acknowledged  (user_2f9a)
  2026-07-18T09:00:00.000Z  failure_pattern.resolved  (user_2f9a)
```

States: `unproven` (resolved, but nothing has exercised the path since — an untested fix, **not** a success), `proving` (clean exposure accumulating, not yet decisive), `confirmed` (enough clean exposure that a still-live pattern would very probably have fired again), `regressed` (it fired again — the fix did not hold; the only state backed by direct proof).

**Scripting it in CI:**

```bash
afr patterns evidence "$FINGERPRINT" --json | jq -e '.confidence.state != "regressed"'
```

Gate on `confidence.state`, not on `exposure.heldSoFar` — `heldSoFar` is `true` for a fix nothing has run yet, and the state already encodes that difference as `unproven`. Three more reading rules: `confidence.score` is a **0-1 fraction capped at 0.95**, never a percentage and never 1.0; `exposure.runCount` is a **floor** when `exposure.runCountTruncated` is true (rendered `2000+`); and `exposure.baselineRunCount` is a 14-day trailing baseline for comparison — never subtract it from `runCount`.

Options: `--json`, `--help`. Exit codes follow the usual convention (0 ok, 1 usage, 2 auth, 3 not-found, 4 network/server).

Like `afr patterns`, this is **read-only**. There is no `afr patterns resolve`/`acknowledge`/`reopen` — those are member-gated, audited, Clerk-authed org actions taken in the web app. An API key has no human actor, and the audit log exists to record which *person* made a privileged change. Reading proof that a fix held needs no actor; asserting that it held does.

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
afr (Agent Flight Recorder CLI) v0.5.0
sdk: v0.9.0
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

## Version

v0.8.0 — **Prove the fix held** (ADR-006 cycle 2). New command: `afr patterns evidence <fingerprintHash>` — the resolution claim, the run exposure accumulated since it, a graded fix-confidence verdict (`score` 0-0.95, `state` one of `unproven`/`proving`/`confirmed`/`regressed`, plus every driver that produced them), and the pattern's lifecycle transition history from the append-only audit log; `--json` carries the whole envelope so a CI job can gate on `confidence.state`. `afr patterns` gains `--state <unproven|proving|confirmed|regressed>`; only `--state regressed` is answerable there (the other three need per-pattern exposure and are a usage error pointing at `afr patterns evidence`, never a silently unfiltered list). New exports: `parsePatternsEvidenceArgs`, `runPatternsEvidence`, `printPatternsEvidence`, `PatternsEvidenceArgs`, `PatternsEvidenceResult`, and `getFailurePatternEvidence` from the API client. Requires `@agent-flight-recorder/sdk` >= 0.12.0. Read-only and additive — no existing command, flag, or exit code changed.

v0.7.0 — `afr patterns` gains `--status <open|acknowledged|resolved>` and `--regressed` (Resolution cycle 1, ADR-006), plus a STATUS column that renders `REGRESSED` for a pattern that was resolved and then recurred.

## Development

This package builds with `tsup` (single ESM bundle, shebang banner) and is typechecked/linted/tested the same way as `@agent-flight-recorder/sdk`:

```bash
pnpm --filter @agent-flight-recorder/cli build
pnpm --filter @agent-flight-recorder/cli typecheck
pnpm --filter @agent-flight-recorder/cli lint
pnpm --filter @agent-flight-recorder/cli test
```

Command dispatch lives in `src/index.ts` (`main(argv)`, parsed with `node:util`'s `parseArgs`) and delegates to one handler module per command family under `src/commands/`. Each handler is a plain exported function (e.g. `runConfigCheck`, `runRecordDemo`) so it can be unit-tested in-process without spawning a subprocess or making real HTTP calls — `afr record demo`'s tests inject a mock `Transport` the same way the SDK's own test suite does.
