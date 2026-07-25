# MCP Server — `packages/mcp`

An MCP (Model Context Protocol) server that exposes Agent Flight Recorder's **read**
API to MCP clients: Claude Desktop, Claude Code, Cursor, or an agent investigating its
own recorded runs.

The premise is narrow and worth stating first. A failed agent run can be tens of
thousands of tokens of event log. An agent that answers "why did I fail?" by pulling
the whole trace into its context spends its budget on transport and has no room left
to think. This server exists so that the *usual* question costs a few hundred tokens
and the expensive answer is something you opt into, deliberately, once you know which
run and which sequence range you care about.

> ## :warning: Verification status of this document
>
> This page documents the tool contract, the transport, and the endpoints behind
> them. It has **not** been executed end to end, and cannot be yet: no Convex
> deployment has ever existed for this project and the application has never been
> deployed to any environment (same caveat as `docs/operations_runbook.md`).
>
> **Verified by reading the code on this branch:**
> - Every `/api/v1/**` route listed in the tool table exists, is `GET`-only, is
>   authenticated with `x-api-key`, and requires the `read` scope
>   (`apps/web/app/api/v1/**`, `convex/read_api.ts`).
> - The query parameters, the response envelope, the per-key rate class
>   (300 req/min), and the error codes described below match those routes.
>
> **Unverified — treat as design intent, not measurement:**
> - The per-tool token figures. They are the budget the tool shapes were designed
>   against, not numbers measured against a live deployment. Expect drift,
>   particularly for tier 4, whose cost is a function of your own event payloads.
> - The MCP client configuration blocks. The handshake has not been run against a
>   real client, and the executable name/entry path comes from the package layout,
>   not from a successful launch.
> - Anything about live latency or real-world response sizes.
>
> The two `/api/v1/patterns**` endpoints behind tiers 1 and 2 are additionally
> **not yet documented in `docs/api_reference.md`** — that document covers runs,
> events, replay, and explanation only. This page is currently their only
> reference.

---

## What it is for

Three callers, one shape:

- **A human in an MCP client** asking "what's broken in production this week?" without
  leaving their editor.
- **An agent debugging itself** — reading its own run's explanation after a failure,
  or checking whether the failure it just hit is a known recurring pattern.
- **A triage loop** that polls for spiking patterns and checks whether last week's
  claimed fixes actually held.

All three want the same thing: the smallest amount of trace that answers the question.

## What it is *not* for

It is a **read surface only**. It exposes no tool that writes. There is no event
ingestion, no run creation, no triage or status transition, no acknowledge/resolve/
reopen, no alert or webhook configuration. Those actions are member- or admin-gated,
Clerk-authenticated, and audited (`audit_log.actorClerkUserId` exists precisely to
record *which person* made a privileged change). An API key has no human actor behind
it, and an MCP tool call has no human in the loop at all — so this surface can reflect
lifecycle state, and can never assert it.

It also does not talk to Convex directly. It holds no deploy key and no Clerk session.
It reaches the product over the public `/api/v1/**` HTTP API with an API key, exactly
like the `afr` CLI, and inherits that door's org scoping and rate limits. See
`CLAUDE.md` → System Boundaries for the binding version of these constraints.

---

## Progressive disclosure — the whole point

The five tools are not five ways to get data. They are a **ladder**, and the rungs are
priced very differently.

| Tier | Tool | Answers | Approx. tokens |
|------|------|---------|----------------|
| 1 | `afr_list_failure_patterns` | "What is broken?" | ~250 |
| 2 | `afr_get_pattern_evidence` | "Did the fix hold?" | ~300 |
| 3 | `afr_explain_run` | "Why did *this run* fail?" | ~200 |
| 4 | `afr_get_run_events` | "Show me." | ~2,000–5,000 |
| — | `afr_list_runs` | Orientation: which runs exist | ~250 |

Read that table as a cost curve. Tiers 1–3 together cost roughly what a *single*
windowed slice of raw events costs at tier 4, and an unwindowed trace of a long run
costs far more than that.

**Calling tier 4 first is the wrong way to use this server.** It is the most common
mistake and it is worth naming plainly: pulling raw events before you know which run
matters burns the context budget you needed for the actual reasoning, and buries the
one relevant event under two hundred irrelevant ones. Raw events are for
*confirmation* — you already have a hypothesis and a sequence number, and you want to
see the literal record. They are not for discovery.

### The intended path

```
afr_list_failure_patterns        → "tool_error on search_docs, 47 occurrences, spiking"
        ↓  (pick a fingerprint)
afr_get_pattern_evidence         → "resolved 6 days ago, 0 exposure since — unproven"
        ↓  (pick a representative runId)
afr_explain_run                  → narrative root cause + cited sequence numbers [12, 14, 17]
        ↓  (only now, and only around those numbers)
afr_get_run_events?from=12&limit=10   → the literal events
```

Each rung hands you the selector for the next one. Tier 1 returns representative run
IDs. Tier 3 returns *real* sequence numbers cited from the run's own event log — every
cited number is guaranteed to correspond to an event the same key can fetch at tier 4,
so there is no such thing as a citation pointing at a fabricated event. That guarantee
is what makes the windowed tier-4 call viable: you fetch ten events, not two thousand.

Stop as soon as the question is answered. Most investigations should end at tier 3.

### Why the tiers cost what they do

- **Tier 1** returns compact rollup rows — fingerprint, class, label, count, first/last
  seen, status, spike verdict. No event bodies, no narratives.
- **Tier 2** returns one pattern's resolution claim plus the evidence grading it:
  post-resolution run exposure, the fix-confidence verdict
  (`unproven` / `proving` / `confirmed` / `regressed`) with its drivers, and the
  lifecycle transition history reconstructed from the append-only audit log.
- **Tier 3** returns a summary, a root cause, an optional suggested fix, a failure
  class, and a short array of cited sequence numbers. It is a *narrative*, deliberately
  bounded — it is cheaper than tier 1 because it describes exactly one run.
- **Tier 4** returns actual event records. Its cost scales with your payloads, which is
  why it is windowed and why payloads over 10 KB were never stored inline in the first
  place (Event Log Rule 3) — those events carry an **artifact pointer** (blob URL +
  SHA-256 checksum), and this server returns the pointer, never the blob. If you need
  the bytes, fetch the artifact yourself, outside the model's context if you can.

---

## Tool contract

Every tool is read-only and org-scoped to the API key's organization. Cross-org reads
are impossible by construction — scoping is enforced in `convex/read_api.ts`, not in
this server.

### `afr_list_failure_patterns` — tier 1

Recurring failure patterns for the key's org, most-recently-seen first. Compact rows.

Backed by `GET /api/v1/patterns`. Filters: `agentId`, `spiking` (`true` only),
`muted` (`true`/`false`), `status` (`open` | `acknowledged` | `resolved`), `regressed`
(`true` only), `state` (`unproven` | `proving` | `confirmed` | `regressed`), `limit`,
`cursor`. Unrecognized filter values are ignored rather than rejected.

The response carries a `fixConfidence` envelope alongside the rows — a staleness bound,
each verdict's age, and the fingerprints that could not be graded at all. It exists so
a reader can tell a fresh verdict from a stale one, and "does not match the filter"
from "was never evaluated". Do not present a snapshot verdict as current without
checking its age.

Patterns are **observability-grade derived data**, not source of truth. They are a
rollup over explanation-derived fingerprints, regeneratable at any time. The event log
remains the only fact about what happened on any single run.

### `afr_get_pattern_evidence` — tier 2

One fingerprint's resolution evidence: the claim, the exposure measured since, the
confidence verdict and its drivers, and the transition history (including automatic
reopens by the regression guard).

Backed by `GET /api/v1/patterns/{fingerprintHash}/evidence`. A malformed fingerprint
is rejected with `400 INVALID_ARGUMENT` before any backend call. An unknown fingerprint
returns **404**, not `200` with a null body — "never existed" and "belongs to another
org" are deliberately indistinguishable so this endpoint cannot be used as an existence
oracle for another org's data.

A resolution on its own is an unearned assertion. This tool is what grades it: a fix
marked resolved six days ago with zero runs since is `unproven`, and saying so is the
entire value of the tier.

### `afr_explain_run` — tier 3

The "why did this fail?" root-cause explanation for one run: summary, root cause,
optional suggested fix, failure class, and cited sequence numbers.

Backed by `GET /api/v1/runs/{runId}/explanation`. The explanation is `null` (not an
error) when the run is not in an explainable status (`failed` / `timed_out` /
`cancelled`) or generation has not completed. `kind` is `"heuristic"` — always
available, deterministic, zero configuration — or `"llm"` when an LLM provider is
configured *and* its output passed the grounding gate (it must cite at least one real
sequence number from this run). Ungrounded LLM output is discarded in favor of the
heuristic result; you never receive an explanation citing an event that does not exist.

### `afr_get_run_events` — tier 4

A **windowed slice** of one run's event log, in `sequenceNumber` order.

Backed by `GET /api/v1/runs/{runId}/events` (`limit`, `cursor`). Payloads over 10 KB
are artifact pointers, never inline bytes — this tool returns the pointer.

Use it last, with a window centered on a sequence number you got from tier 3. If you
find yourself paging the whole log, the earlier tiers did not do their job or you
skipped them.

### `afr_list_runs` — orientation

Compact run rows for the key's org. Backed by `GET /api/v1/runs`. Filters: `status`,
`agentId`, `environment`, `session`, `limit`, `cursor`. Server-capped page size;
`nextCursor` pages forward.

This is not a tier — it is the "which run are we even talking about?" lookup you reach
for when you arrive with a run ID or an agent name rather than a failure pattern.

---

## Configuration

### Environment variables

The server reads the **same two variables the `afr` CLI reads**. They are already
documented in `.env.example`; nothing new is introduced.

| Variable | Required | Notes |
|----------|----------|-------|
| `AFR_API_KEY` | yes | Agent Flight Recorder API key. **Must carry the `read` scope.** |
| `AFR_BASE_URL` | yes | Base URL of the AFR deployment, e.g. `https://your-afr-host` or `http://localhost:3000`. A trailing slash is stripped. |

Note the difference in *how* they are supplied. For the CLI they live in your shell
environment. For an MCP server they are set in the MCP client's config file (`env`
block below), because the client — not your shell — launches the process.

### The key must have the `read` scope

Mint a read-only key rather than reusing an ingest key:

```bash
curl -s -X POST "https://your-afr-host/api/api-keys" \
  -H "Cookie: __session=..." -H "Content-Type: application/json" \
  -d '{ "name": "MCP server (read-only)", "scopes": ["read"] }'
# => { "id": "...", "scopes": ["read"], "key": "<raw key, shown ONCE — save it now>" }
```

- A key with `scopes: ["ingest:write"]` is rejected by every `/api/v1/**` endpoint with
  `403 FORBIDDEN` (`Forbidden: API key lacks required scope "read"`).
- Omitting `scopes` when creating a key now yields the default `["ingest:write"]` —
  i.e. **not** usable here.
- A `read`-only key is symmetrically rejected by every ingest route, which is the point:
  handing an MCP client a key that cannot possibly write is the cheapest form of the
  read-only guarantee.

Check the `scopes` field on the *response*; it reflects what was actually stored.

See `docs/api_reference.md` §0–1 for the full key-management contract.

### MCP client config

The tool surface is the same across clients; only the file differs. Claude Desktop
(`claude_desktop_config.json`) and Claude Code / Cursor (`.mcp.json` in the project
root) both take this shape:

```json
{
  "mcpServers": {
    "agent-flight-recorder": {
      "command": "node",
      "args": ["/absolute/path/to/GunkHub/packages/mcp/dist/index.js"],
      "env": {
        "AFR_API_KEY": "afr_live_xxxxxxxxxxxxxxxxxxxxxxxx",
        "AFR_BASE_URL": "https://your-afr-host"
      }
    }
  }
}
```

`packages/mcp/package.json` declares the bin `afr-mcp` → `./dist/index.js`, so once
the package is installed/linked you can use that name instead of an absolute path:

```json
{
  "mcpServers": {
    "agent-flight-recorder": {
      "command": "afr-mcp",
      "env": {
        "AFR_API_KEY": "afr_live_xxxxxxxxxxxxxxxxxxxxxxxx",
        "AFR_BASE_URL": "https://your-afr-host"
      }
    }
  }
}
```

Either form requires `pnpm --filter @agent-flight-recorder/mcp build` first — `dist/`
is a build artifact and is not checked in.

Transport is stdio: the client spawns the process and speaks MCP over stdin/stdout.
Consequences worth knowing before you debug it:

- **Never write to stdout.** Anything printed there corrupts the protocol stream. Logs
  go to stderr.
- The process inherits nothing from your interactive shell. If `AFR_API_KEY` works in
  your terminal but the server reports it missing, the `env` block above is what is
  actually in effect.
- Restart the MCP client after editing its config; these files are read at launch.

**Unverified:** `packages/mcp` is being landed alongside this document and neither
config block has been used to launch a real client. The bin name and entry path are
read from `packages/mcp/package.json`, not from a successful handshake. When
`packages/mcp/README.md` exists it is the owning team's authority on the launch
command; prefer it over this page if the two disagree.

### Local development

`AFR_BASE_URL=http://localhost:3000` points the server at `pnpm dev`. You still need a
real API key from that deployment, which means a working Convex deployment and a
seeded org — the server has no fixture or offline mode.

---

## Operational notes

- **Rate limit:** 300 requests/min per key, bucketed by a hash prefix of the key (never
  the raw secret). This is shared with every other `/api/v1/**` consumer using the same
  key — the CLI, the SDK's `FlightReader`, and this server will contend if they share
  one. Give the MCP server its own key. A `429` carries `retry-after: 60`.
- **Errors:** `UNAUTHORIZED` (401) means the key is missing, invalid, revoked, or
  expired. `FORBIDDEN` (403) means the key exists but lacks `read` — the single most
  likely first-run failure. `NOT_FOUND` (404) covers both "does not exist" and "belongs
  to another org," deliberately. `INVALID_ARGUMENT` (422, or 400 on the evidence route's
  fingerprint guard) means a malformed argument.
- **Envelope:** successful v1 responses are `{ apiVersion, data, requestId }`; errors
  are `{ apiVersion, error: { code, message, details } }`. A known platform gap means
  some failures (unrecognized backend errors, and rate-limit rejections that never reach
  the route handler) return a flat `{ code, message, details }` instead — a client must
  tolerate either. `requestId` is echoed in the `x-request-id` header; quote it in bug
  reports.
- **Secrets:** `AFR_API_KEY` is a credential. It belongs in the MCP client config, not
  in a committed file, and not in a tool response.

---

## Further reading

- `docs/api_reference.md` — the v1 read API contract (runs, events, replay, explanation;
  the pattern endpoints are not yet covered there)
- `docs/adr/005-failure-patterns.md` — why failure patterns exist and their
  observability-grade constraints
- `docs/adr/006-failure-resolution.md` — the resolution lifecycle and the fix-confidence
  verdict tier 2 returns
- `docs/adr/004-run-explanations.md`, `docs/design/explanations.md` — how tier 3's
  explanation is produced and grounded
- `CLAUDE.md` — System Boundaries; the binding constraints on this package
- `packages/mcp/README.md` — the owning team's package-level docs
