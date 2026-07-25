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

### `afr compat`

**Can I ship this version?** Takes what a run *actually did* — its recorded event
log — and asks whether the same run would still have been possible on a different
agent version. Nothing is executed: this is a structural analysis over stored
history and the two versions' config snapshots, the same idea as a Temporal replay
test (run the new code against the old history, fail on divergence).

```bash
$ afr compat --agent ag_7f3 --target ver_2026_07_25
DO NOT SHIP — 3 distinct proven reasons across 340 runs
verdict: incompatible   gate: --fail-on proven   target: ver_2026_07_25

PROVEN REASONS — distinct root causes, most-affecting first
    211 runs  [tool_removed] called tool `search_web`; target declares no such tool
           e.g. run_9f2c1a…, run_3b8e44…
     97 runs  [model_removed] called model `claude-3-opus`; target permits neither
           e.g. run_11ade0…
     32 runs  [budget_exceeded] used 14 tool calls; target caps maxToolCalls at 8
           e.g. run_77c001…

SPECULATIVE REASONS — behaviour may differ. NOT evidence.
    512 runs  [system_prompt_changed] system prompt changed; tool selection may differ
           not provable: a prompt's effect on behaviour is not derivable from a recorded history

SCAN  512 of 512 runs analysed since 2026-07-18T00:00:00.000Z
$ echo $?
10
```

Single-run mode is `afr compat <runId> --target <versionId>`, which prints each
proven finding with the recorded event it contradicts (`seq 42 tool.call — recorded
"search_web"; target tools[].name = (absent)`) so you can go straight from a claim
to the event log.

Options: `--target <versionId>` (required), `--agent <agentId>` (fleet mode),
`--since-days <n>`, `--limit <n>`, `--fail-on <proven|any|none>`, `--json`, `--help`.

**Three kinds of finding, and they are not the same kind of thing.**

| Section | Claim | Gates a deploy? |
|---|---|---|
| **PROVEN** | "called tool `search_web` at sequence 42; target declares no such tool" — checkable against stored data, and it cites the event | Yes, by default |
| **SPECULATIVE** | "the system prompt changed, so behaviour may differ" — unfalsifiable, printed with why it cannot be proven | Only with `--fail-on any` |
| **COULD NOT ANSWER** | "the target's `tools` key is a string, not an array" — reached and left open | Never exits `0` |

The separation is enforced by the types in `@agent-flight-recorder/contracts`
(three mutually unassignable types with no shared `message` field), not by a
severity column this command chooses to render. That matters because the output
authorises fleet-wide deploys: "the consumer was supposed to check the enum" is
not a safety property.

**The fleet answer leads with distinct reasons, not affected runs.** 340 broken
runs with 12 root causes is a tractable morning; 340 individual reports is not.

**Exit codes — read this before scripting it:**

| Code | Meaning |
|---|---|
| `0` | Nothing at or above the threshold, **and** the analysis was complete |
| `10` | Findings at or above `--fail-on` |
| `11` | Nothing found, **but the analysis did not finish** — an unreadable config dimension, a truncated event history, a fleet scan that hit the row ceiling, or a question left open |

`1`/`2`/`3`/`4` keep their usual meanings (usage / auth / not-found / network).

**`10` wins over `11`** — a proof does not weaken because something else went
unchecked, so a proven divergence inside a partial analysis is still "do not ship".
**Exit `0` is unreachable on an incomplete analysis** under any real threshold;
`--fail-on none` can reach it, and is documented as not being a gate.

Exit `4` additionally covers a report the SDK refused to trust: one that came back
about a *different* version than the one requested (an older deployment silently
drops an unknown query parameter and answers about the run's own version, against
which every recorded run is trivially compatible), one with no coverage record, one
serving a speculative finding inside the proven list, or one whose verdict
contradicts its own findings. All four look exactly like a clean bill of health to
a caller that trusts them. None of them can reach exit `0`.

**Why `--fail-on` defaults to `proven` and not `any`.** Speculative findings fire
on every prompt edit, which is most deploys. A gate that is red on every deploy is
a gate that gets switched off within a fortnight, taking the proven findings with
it. `--fail-on any` exists for teams who want it, opted into explicitly, on the
record — and the threshold in force is printed on every run, so a CI log always
says what was actually being checked.

> Server support: the divergence read endpoints (`GET /api/v1/runs/:id/divergence`,
> `GET /api/v1/agents/:id/divergence`) are not wired yet. Until they are, this
> command exits `3`.

### `afr triage`

**Start here.** One call, zero required arguments, answering the question you actually arrive with: *what is wrong right now, and what should I look at first?* Ranks your organization's recurring failure patterns and prints the top few, each row carrying the exact next command to run.

```bash
$ afr triage
FINGERPRINT   SIGNAL     SCORE  CLASS       LABEL                             COUNT  LAST SEEN                 MUTED  NEXT
a1b2c3d4e5f…  REGRESSED  228    tool_error  lookup_order tool call times out  12     2026-07-25T05:00:00.000Z  -      afr patterns evidence a1b2c3d4e5f6a1b2
f6e5d4c3b2a…  SPIKING    184    tool_error  flaky_search tool call 5xx        40     2026-07-25T04:12:00.000Z  -      afr explain run_9f2c1a

Showing 2 of 50 pattern(s) scanned.
```

Options: `--agent <agentId>` (only patterns seen on this agent), `--json`, `--help`.

**The ranking is shared, not reimplemented.** This is the same ranking, the same scores and the same next-hop targets the `afr_triage` MCP tool serves — one implementation, in `@agent-flight-recorder/sdk`, imported by both. A CLI that ranked failures differently from the agent-facing tool would be two answers to one question. Signal order, highest first: `regressed`, `spiking`, `open`, `acknowledged`, `resolved`. Recency and volume order items *within* a signal class and can never promote one across a class. Muted patterns are shown, flagged, and always sorted last — muting suppresses alerting, not existence.

`--json` emits the ranking's result **verbatim**, with next-hop pointers in their MCP tool-name form (`afr_explain_run`, `afr_get_pattern_evidence`, …), so a machine diffing this against the MCP tool finds nothing. Only the human table above translates a pointer into a runnable `afr` command.

**Exit codes — read this before scripting it:**

| Code | Verdict | Meaning |
|---|---|---|
| `0` | `clear` | The scan completed and found nothing to look at |
| `10` | `issues` | Ranked items were found |
| `11` | `unknown` | Nothing was found, **but the view was incomplete** — so "nothing found" is not evidence of health |

`1`/`2`/`3`/`4` keep their usual meanings (usage / auth / not-found / network).

**Exit `0` is structurally unreachable on an incomplete scan.** The verdict is computed as `items.length > 0 ? 'issues' : complete ? 'clear' : 'unknown'`, so `clear` already implies a whole view; `exitCodeForTriage` re-checks `complete` anyway, deliberately, because that invariant now lives in a different package shared with the MCP server and must not be able to turn this gate green from a distance. `10` wins over `11` when both apply — findings are actionable, and the incompleteness is stated in the output and in `--json`'s `complete` and `caveats`.

```bash
afr triage            # non-zero on findings OR on a scan it could not finish
afr triage --json     # 'verdict', 'complete', 'caveats', 'items[].next'
```

**Why this differs from `afr patterns --state regressed`, deliberately.** That command exits `0` whether or not it matched, and relies on an external `jq -e` to turn a finding into a build failure — which is exactly how a build stays green while something is wrong, because the gate only works if someone remembered to add the jq. `afr triage` fails the build itself. Please do not "harmonise" the two: the difference is the point.

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
$ afr patterns --state confirmed   # only fixes with enough clean exposure to trust

# A filtered scan that hit the server's row ceiling — inconclusive, NOT clean:
$ afr patterns --state regressed
No matching patterns in the rows scanned [scan truncated 2000/2000 rows] — the scan
stopped on the server's row ceiling, not on the end of the table. This is NOT "none
exist": nothing is known about the rows beyond it.
  (page with the API's nextCursor until scanTruncated is false, or treat this run as inconclusive)
$ echo $?
11
```

Options: `--agent <agentId>` (only patterns seen on at least one version of this agent), `--spiking` (only patterns currently flagged as spiking), `--muted` / `--active` (mute-aware filter — mutually exclusive, passing both is a usage error, exit 1), `--status <open|acknowledged|resolved>` (exact lifecycle-status filter — an invalid value is a usage error, exit 1), `--regressed` (only patterns with `regressedAt` set), `--state <unproven|proving|confirmed|regressed>` (fix-confidence filter — see below), `--limit <n>`, `--json` (prints the raw API response, including `muted`/`mutedAt` and the full resolution-lifecycle and evidence fields).

**`--state` vs `--status`, and why CI should use `--state regressed`.** `--status` is what a human *asserted*; `--state` is what the *evidence supports* (ADR-006). All four values are answerable — verdicts are served from a periodically refreshed per-pattern snapshot rather than a per-request exposure scan. An invalid value is still a usage error (exit 1), never silently ignored.

**Verdicts carry their age.** The `CONFIDENCE` column renders three distinct outcomes, and they must not be read as the same thing:

| Cell | Meaning |
|---|---|
| `confirmed 82%` | a fresh verdict |
| `confirmed 82% [stale 9h]` | a real verdict that has aged past the staleness bound |
| `-` | no usable snapshot — nothing has been graded yet |

A stale verdict is *shown*, not hidden: it is the best available answer, and it can only under-report (soak and exposure only accumulate, and `regressed` is written eagerly by the regression guard rather than waiting for a refresh). But it is never shown as though it were current — the marker sits inline with the number it qualifies rather than in a footnote a reader can skip. `-` is deliberately **not** rendered as `unproven`: "we have not graded this" and "we graded this and found no evidence" are different claims.

Patterns with a live resolution but no usable snapshot cannot match any `--state` filter. They are reported in a footnote with their count and fingerprints rather than silently vanishing — "could not evaluate these" is a materially different answer from "these do not match", and conflating them lets a reader conclude that a page which could not evaluate part of its input found nothing to worry about.

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

Codes `0`-`4` all describe the **request**. Above that band sit codes describing
the **answer**, so a CI script can tell "I checked and it is clean" from "I could
not finish checking":

| Code | Meaning | Emitted by |
|---|---|---|
| `10` | Issues found — the check completed and something needs attention | `afr triage` |
| `11` | Could not evaluate — the check did not complete, so its result is inconclusive, not clean | `afr triage`; `afr patterns` when a filtered request's scan was truncated (see below) |

Both numbers mirror the MCP triage verdicts (`issues` / `clear` / `unknown`) so
one set of codes means the same thing across commands. Note that `afr patterns`
still exits `0` when it finds matching patterns — only `afr triage` treats a
finding as a build failure. That asymmetry is deliberate and is explained under
`afr triage` below.

**Why `afr patterns` can exit `11`.** A *filtered* pattern request (`--state`,
`--status`, `--regressed`, `--agent`, `--spiking`, `--muted`, `--active`) scans a
bounded window of rows on the server and filters it, so it can return a short or
empty page purely because it hit the 2,000-row scan ceiling rather than the end
of the table. The API says so via `scanTruncated`. Reporting that as `0` would
mean the documented CI gate — `afr patterns --state regressed` — could pass a
build on a scan it never completed. So the output is annotated
`[scan truncated N/M rows]` and the exit code is `11`. Page with the API's
`nextCursor` until the scan completes, or treat the run as inconclusive. An
unfiltered `afr patterns` never truncates and always exits `0`.

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

v0.17.0 — **New command: `afr cause <runId> --direction up|down|both`.** What caused this run, and what did it break — walking the RECORDED cross-run graph, never an inferred one. Suspected links (temporal adjacency, shared session, shared resource) print in their own section AS QUESTIONS, WITH NO DIRECTION, each naming the instrumentation that would turn it into a real edge; none can change the exit code, and there is no `--fail-on` value that fires on one. **Three ways a walk ends, in separate sections with separately composed sentences: ORIGIN, LOOP, TRAIL LOST — and only the last means unfinished.** A closed retry loop is a COMPLETE frontier and does not cost exit 0; reporting it as a lost trail would mean no retry chain could ever exit clean. Fan-in is shown as an explicit CONVERGENCE POINTS section rather than being a kind of ending — a run consuming three upstream outputs has three stories, and the walk continues through all of them, and `--direction` is REQUIRED with no default because "what caused this" and "what did this break" both produce well-formed traces and a script that got the other one has nothing on screen to tell it so. **Exit codes: 0 complete trace, 10 impact (`--fail-on downstream`), 11 truncated.** One lost trail anywhere makes the whole trace incomplete, however many other branches ended cleanly. **`--fail-on none` does NOT reach exit 0 on a truncated trace, a deliberate divergence from `afr fleet`**, where `none` turns off an alarm and says so: here exit 11 is not a threshold but the statement "this answer is partial", which is the primary product of a tracing command rather than a gate bolted onto it. 10 still wins over 11 (a consumer of this output consumed it whether or not another branch went unread), and the downstream count then prints as the FLOOR it is. `afr cause` also picks up the claim audit added after review: exit 4 on a traversal whose claims its own edges refute — an origin contradicted by an edge into the very run it says ended, an undeclared cycle, a fabricated cycle path, or an edge citing nothing at all. Each of those previously reported a COMPLETE trace. Requires contracts >= 0.24.0 / SDK >= 0.27.0.

v0.16.0 — **Picks up the boundary usability guard (contracts >= 0.19.0 / SDK >= 0.22.0).** `afr fleet` now exits 4 on a report whose fields are present but whose contents are not usable numbers — a base rate whose counts arrive as strings (which compared as though it were measured and promoted a hypothesis to the top of the screen), a dropped truncation flag (which read as "not truncated" and compared floors as totals), garbage correlation timestamps (which made the burst-span check silently unenforceable), or an `agentsFailing` that would have turned a failing fleet into `healthy`. The exit-code table's exit-4 section now names these grounds. No flag, output format or exit-code meaning changed.

v0.15.0 — **Picks up the contracts/SDK hardening (>= 0.18.0 / >= 0.21.0).** `afr fleet` now refuses (exit 4) a report whose numbers contradict each other — a burst declaring a span wider than the width it was computed under, a claimed breadth the listed or cited agents do not support, a citation sample confined to one agent under a multi-agent claim, or a hypothesis resting on any observation the report does not contain. Each correlation line now prints how many DISTINCT agents its evidence actually names alongside the claim, and the headline states both, so an unverifiable breadth is never presented as a bare fact. Hypothesis lines render contracts' composed `hypothesisQuestion()` — always interrogative, built from `kind` and the shared value — rather than a sentence the engine wrote, so no engine can put "model m-4 is failing" on an incident screen. No flag, output format or exit-code meaning changed.

v0.14.0 — **New: `afr fleet` — "what is wrong across everything, and what is it that is actually wrong?"** An org-wide sweep: roster health per agent, plus cross-agent correlations (the same fingerprint on N agents; N agents failing inside one `--window`). Not to be confused with `afr compat --agent`, which is ONE agent over MANY runs; this is many agents at one moment. One screen, ranked BREADTH FIRST — recency orders only within equal breadth, because during an incident the newest cluster is usually a downstream symptom and the broadest is usually nearest what changed, and the person reading has about ninety seconds. Observations and hypotheses print in separate sections, and **every hypothesis prints its denominator on the same line as its claim** — `DISCRIMINATING` / `NOT DISCRIMINATING` / `BASE RATE UNKNOWN`. Exit codes: `0` clean and complete, `10` observed cross-agent correlation, `11` cannot tell, `1/2/3/4` usage/auth/not-found/network. `10` wins over `11`, which matters more here than in `compat`: data volume spikes during an incident, so the sweep is likeliest to truncate during exactly the event this command exists to catch, and demoting the observation would silence the alarm when it is right. **A bounded sweep never buys a green exit** — the roster ceiling, skipped agents, an outstanding cursor, a page-local correlation basis and an unanswered question all exit `11`. **`--fail-on` has no setting that fires on a hypothesis, and there is no way to add one without a contract change**: paging on a guess is how the healthy dependency gets rolled back while the actual cause keeps burning. Unlike `afr compat --agent`, this command does NOT follow the roster cursor and merge — merging page-local cross-agent correlations produces a report about a fleet that does not exist; raise `--limit` instead. Requires sdk >= 0.20.0 / contracts >= 0.17.0. Server support for `GET /api/v1/fleet/health` is not wired yet; until it is, the command exits 3.

v0.13.1 — **Fix: `afr compat` could exit 0 on an analysis that examined nothing.** Picks up the contracts fix (>= 0.16.1) for vacuous completeness: an empty fleet scan (`runsAnalyzed: 0` — what you get once a version's runs age out of retention) and an empty single-run analysis (no dimension assessed, no event read) both computed `compatible`, and this command exited `0` on them. Both now compute `indeterminate`, so the gate exits `11` — "cannot tell", which is the truth. No flag, output format or exit-code meaning changed; the affected inputs are exactly the analyses that had no evidence behind them.

v0.13.0 — **A first page is no longer a fleet verdict, and a partial analysis now says what it DID establish.** `afr compat --agent` follows the scan cursor and merges pages with contracts' `mergeFleetDivergenceReports` (>= 0.16.0) instead of reporting page one: a fleet scan is a bounded batch (one paginated pass per execution, over runs whose logs run to `MAX_EVENTS_PER_RUN`), so a full, clean first page looks exactly like a finished scan while the twelfth reason sits on page four. The merge is exact — reason keys are run-independent and pages partition the run set, so counts add and causes collide correctly — and it lives in contracts so a CI gate and a dashboard cannot add the same pages up differently. New `--max-pages <n>` (default 20) bounds the loop, because an unbounded loop in a CI step is a hung build; **stopping early never buys a pass** — the outstanding `nextCursor` stays in the merged window, `isFleetScanComplete` counts it, the verdict stays `indeterminate`, and the exit code is 11. A non-advancing cursor is refused (exit 4) rather than looped on. `--limit` is now per page. New **BY DIMENSION** table in single-run output: `tools INCOMPATIBLE / model CLEAN / budgets UNDECLARED` instead of one word, so a partial analysis is actionable rather than a shrug — and an `UNDECLARED` dimension names its fix (publish a version whose `configSnapshot` declares it, via `buildAgentConfigSnapshot` in `@agent-flight-recorder/sdk` >= 0.19.0) instead of leaving operators to learn that the verdict can be ignored. Third finding section, **COULD NOT ANSWER**, is now surfaced for grouped fleet reasons too. No exit code changed meaning.

v0.12.0 — **`afr compat` — can I ship this version?** New command, two modes: `afr compat <runId> --target <versionId>` takes what one run ACTUALLY DID (its recorded event log) and reports what the target version would have broken about it; `afr compat --agent <agentId> --target <versionId>` asks the same question across the agent's recent runs. Nothing is executed — it is a structural analysis over stored history and two config snapshots, the Temporal replay-test idea. **The fleet answer leads with DISTINCT REASONS, not a run count**: 340 broken runs with 12 root causes is a tractable morning; 340 individual reports is not. `--since-days` / `--limit` bound the scan, `--json` emits the raw report.

**Findings are reported in three separate sections because they are three different kinds of claim.** PROVEN ("called tool `search_web` at sequence 42; target declares no such tool") cites the recorded event and the config path that decides it, and is the only kind that gates a deploy by default. SPECULATIVE ("the system prompt changed") is printed with why it cannot be proven, and is never counted as a failure unless asked for. COULD NOT ANSWER ("the target's `tools` key is a string, not an array") is neither: it is unchecked, and it can never exit 0. The separation is enforced by the contract's types (`@agent-flight-recorder/contracts` >= 0.15.0), not by a severity column this command chooses to render.

**New exit codes — this is a CI gate.** `0` = nothing at or above the threshold AND the analysis was complete; `10` = findings at or above `--fail-on`; `11` = nothing found but the analysis did not finish (an unreadable config dimension, a truncated event history, a fleet scan that hit the row ceiling, or a question left open). `1`/`2`/`3`/`4` keep their usual meanings. **10 wins over 11** — a proof does not weaken because something else went unchecked. **Exit 0 is unreachable on an incomplete analysis** under any real threshold. Exit 4 additionally covers a report the SDK refused to trust: one that came back about a different version than the one requested (an older deployment silently drops an unknown query parameter and answers about the run's own version, against which every recorded run is trivially compatible), one with no coverage record, one serving a speculative finding as proven, or one whose verdict contradicts its own findings — all four look exactly like a clean bill of health to a caller that trusts them, and none of them exits 0 here.

**`--fail-on proven|any|none`, default `proven`, printed on every run.** Not `any`: speculative findings fire on every prompt edit, which is most deploys, and a gate that is red on every deploy is a gate that gets switched off within a fortnight — taking the proven findings with it. A typo (`--fail-on nay`) is a usage error, never a silent fall back to the default. Server-side note: the divergence read endpoints are not wired yet, so the command currently exits 3.

v0.11.0 — **`afr triage` — the cheap first hop.** New command: `afr triage`, zero required arguments, answering "what is wrong right now, and what should I look at first?" in one call. Ranks your org's recurring failure patterns and prints the top few as a table, each row carrying the exact next `afr` command to run; `--agent <id>` narrows to one agent, `--json` emits the raw result. This is the **same ranking, the same scores and the same next-hop targets** the `afr_triage` MCP tool serves — the implementation moved into `@agent-flight-recorder/sdk` (>= 0.17.0) and both surfaces import it, because two rankings that can disagree is worse than either. `--json` is the ranking's result **verbatim**, pointers in their MCP tool-name form, so a machine diffing the CLI against the MCP tool finds nothing; only the human table translates a pointer into a runnable `afr` command. No new API endpoint and no new query parameter: triage composes the existing `GET /api/v1/patterns` with the ranking's own field selection and scan limit.

**New exit codes — this is a CI gate.** `0` = verdict `clear` (the scan completed and found nothing); `10` = verdict `issues` (ranked items found); `11` = verdict `unknown` (nothing found, but the view was incomplete, so "nothing found" is not evidence of health). `1`/`2`/`3`/`4` keep their usual meanings for usage/auth/not-found/network. **Exit `0` is structurally unreachable on an incomplete scan**: the verdict is computed as `items.length > 0 ? 'issues' : complete ? 'clear' : 'unknown'`, so `clear` already implies a whole view — and `exitCodeForTriage` re-checks `complete` anyway, deliberately, because that invariant now lives in a different package shared with the MCP server and must not be able to turn this gate green from a distance. `10` wins over `11` when both apply: findings are actionable, and the incompleteness is stated in the output and in `--json`'s `complete`/`caveats`.

**Note the deliberate difference from `afr patterns --state regressed`**, and please do not "harmonise" them: that command exits `0` whether or not it matched, leaving the build to be failed by an external `jq -e`, which is how a build stays green when someone forgets the jq. `afr triage` fails the build itself. New exports: `parseTriageArgs`, `runTriage`, `printTriage`, `exitCodeForTriage`, `TRIAGE_EXIT_FINDINGS`, `TRIAGE_EXIT_INCOMPLETE`, `TriageArgs`, `TriageCommandResult`. Additive — no existing command, flag, or exit code changed.

v0.10.0 — **A truncated scan no longer exits 0.** `afr patterns` reads the `scanTruncated`/`scannedRows`/`scanRowCeiling` fields the read API returns (newly typed in `@agent-flight-recorder/sdk` >= 0.16.0). A FILTERED request scans a bounded window of rows and filters it, so it can come back short or empty purely because it hit the server's 2,000-row ceiling. Previously that printed `No recurring failure patterns found.` and exited `0` — a whole-dataset claim, and a false one, on the exact path the CI gate uses (`afr patterns --state regressed`): a regression could exist past the ceiling and the build went green. Now the result is annotated in the existing bracket idiom — `[scan truncated 2000/2000 rows]` — the empty case says what was actually established ("No matching patterns in the rows scanned ... this is NOT \"none exist\""), a non-empty page is footnoted as PARTIAL, and the command **exits `11`** instead of `0`. **New exit code `11` — "could not evaluate"**, outside the existing 0-4 band (which describes the REQUEST; this describes the ANSWER) and aligned with the `afr triage` command in flight, which proposes `10` = issues found and `11` = could not evaluate, mirroring the MCP triage verdicts `issues`/`clear`/`unknown`. An UNFILTERED listing never truncates (the server sizes its scan to the page) and is unaffected; the exit code is withheld there in any case, since "here are some patterns" makes no whole-dataset claim. `--json` output gains `ok: false`, `scanIncomplete: true`, `exitCode`, and the three scan fields. The exported `PatternsResult` type gains a third union member, `PatternsScanIncomplete` (an `ok: false` result that still carries its `data`, because that is how a non-zero exit code reaches the shell). No other command, flag, or exit code changed.

v0.9.0 — **`--state` accepts all four values** (ADR-006 cycle 3). `afr patterns --state unproven|proving|confirmed|regressed` all work now: the backend serves verdicts from a periodically refreshed snapshot rather than a per-request exposure scan, so cycle 2's client-side rejection of the three exposure-dependent values is gone. An invalid value is still a usage error (exit 1). New `CONFIDENCE` column rendering three distinct outcomes — `confirmed 82%` (fresh), `confirmed 82% [stale 9h]` (a real verdict that has aged past the bound), and `-` (no verdict yet, deliberately NOT shown as `unproven`). Two new footnotes: how many verdicts are stale, and which patterns have a resolution but no usable snapshot and so could not be graded at all. `--json` carries the full `fixConfidence` envelope (`stalenessBoundMs`, `entries[]`, `staleCount`, `unevaluated[]`). Requires `@agent-flight-recorder/sdk` >= 0.13.0.

`--state regressed` is unchanged and still the right CI gate: it keeps an exact, snapshot-free path alongside the snapshot and matches if either says so, so it is never weaker than before snapshots existed and never depends on the refresh cron having run.

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
