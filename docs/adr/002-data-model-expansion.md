# ADR 002 — Data Model Expansion (Run Hierarchy, Environments, Search, Triage, Evals, Alerting, Webhooks, Usage Metering)

Status: Accepted
Date: 2026-07-19
Relates to: ADR-0002 (event log is canonical), ADR-0003 (tenancy boundary), ADR 001 (retention/erasure)

## Context

CLAUDE.md's "Not in v1" list froze analytics dashboards, aggregate metrics, a
policy engine, and webhooks/external integrations out of the initial release.
The project owner has now directed a per-item expansion of the core data model
to support run hierarchies/sessions, per-run environment and labels, full-text
search over runs, a triage workflow for failed runs, evals (pass/fail/score
checks against a run), alert rules that watch for failure conditions, outbound
webhooks that notify external systems, and usage metering/rollups for billing
and capacity planning groundwork. This ADR lifts the freeze for exactly the
items enumerated below — other "Not in v1" items (analytics dashboards as a
UI surface, a general policy/compliance engine, billing/subscription
management, multi-region ingestion) remain out of scope; usage_counters and
daily_rollups here are groundwork tables, not a shipped billing feature.

Doing this without a plan risks two failure modes this project treats as
existential: breaking the append-only event log contract (ADR-0002), and
introducing a mutation surface that isn't org-scoped (ADR-0003). Every new
table and mutation below follows the existing patterns in `convex/schema.ts`
and `convex/auth.ts` exactly: `orgId` on every row, `requireOrgMembership` (or
API-key resolution) before any read/write, and no update/delete on any
append-only log table.

## Decision

**All schema changes are additive.** Every new field on an existing table is
`v.optional(...)`; every new table is net-new. Existing stored documents
remain valid with no migration step, per CLAUDE.md's backward-compatibility
rule.

### `runs` — hierarchy, sessions, environment, labels, triage, tokens, search

- `parentRunId?: Id<"runs">` — links a sub-run to its parent (e.g. a
  sub-agent invocation). **Validated at write time only**: the parent must
  already exist and must belong to the *same org and same project* as the
  child. Arbitrary depth is allowed (a chain of parents, not just one level).
  **Cycles are structurally impossible without extra bookkeeping**: a run's
  `parentRunId` can only ever reference a run that already exists at the
  moment the child is created, and `parentRunId` is never mutated after
  creation (there is no `updateRun` that touches it). A cycle would require a
  run to be its own ancestor, which would require the parent to exist before
  itself — impossible. This is cheaper and just as sound as a graph traversal
  check on every write.
- `sessionId?: string` — free-form correlation key an SDK caller sets to
  group multiple runs (e.g. a multi-turn conversation). Indexed
  (`by_org_session`), not validated beyond a length bound — the value is
  opaque to the backend.
- `environment?: string` — accepts the well-known set
  (`production | staging | development | preview`) or any custom string up to
  32 characters, so a team can label an ad hoc environment (e.g.
  `load-test`) without a schema change. Stamped from the API key's own
  `environment` field when the caller doesn't supply one explicitly (see
  `api_keys` below).
- `labels?: string[]` — up to 10 labels, each up to 40 characters. Distinct
  from `tags` (already on `runs`): labels are meant for triage workflows
  (e.g. `needs-review`), tags for freeform categorization. Both are simple
  string arrays with independent write ceilings; we did not unify them
  because `tags` already has its own dedicated mutation (`updateRunTags`)
  and UI surface, and splitting keeps each ceiling and audit trail legible.
- `triageState?: "open" | "investigating" | "resolved"` — settable only on
  `failed` or `timed_out` runs, via a dedicated `setRunTriage` mutation with
  an enforced linear state machine (`open → investigating → resolved`, plus
  `any → open` to reopen). Absent = untriaged; treated as `"open"` by
  convention when a triage view needs a default.
- `tokensIn? / tokensOut?: number` — denormalized running counters,
  incremented at event-insert time whenever an `llm.response` event is
  appended (tolerant parsing of both `input_tokens`/`output_tokens` and
  `prompt_tokens`/`completion_tokens` payload shapes). This is the one
  deliberate, narrow exception to "do not denormalize event data into runs":
  it is a monotonic counter that is only ever *added to*, never recomputed
  or overwritten from a full replay, so it cannot drift out of sync in a way
  a reader could mistake for authoritative — the event log remains the
  source of truth for the underlying `llm.response` payloads themselves, and
  a client that wants an exact figure can always recompute it from the log.
  This mirrors why `runs.status` itself is allowed to be denormalized from
  the terminal event: it's a monotonic write, not a recomputed aggregate.
- `searchText?: string` — populated at run creation (agent name + tags +
  `triggeredBy`) and updated when a terminal `run.failed` event is appended
  (appends the extracted error message). Bounded to 2 KB. This is the field
  behind the new `search_runs` search index (`searchField: "searchText"`,
  `filterFields: ["orgId"]`) — Convex search indexes require a **stored**
  field to search over, so `searchText` exists purely to feed it; it is not
  itself a canonical fact about the run, and a reader should never treat
  its absence/staleness as meaningful beyond "not yet indexed."

New indexes: `by_org_session` (`[orgId, sessionId]`), `by_parent`
(`[parentRunId]`), `by_org_environment_started`
(`[orgId, environment, startedAt]`), and the search index `search_runs`.
Each backs a query shipping in this same change (`listSessionRuns`,
`listChildRuns`, an environment-filtered `listRuns` extension, `searchRuns`).

### `api_keys` — per-key environment, `read` scope

- `environment?: string` — when set, stamped onto every run the key creates
  (unless the caller explicitly passes its own `environment`), so a
  "staging key" always tags its runs correctly without every SDK call
  needing to know its own deployment tier.
- Scope vocabulary gains `"read"` alongside the existing `"ingest:write"`
  (and the web layer's already-recognized `"ingest:read"`). `createApiKey`
  now validates `scopes` against a closed set
  (`"ingest:write" | "ingest:read" | "read"`) instead of accepting any
  string — additive and backward compatible: a key with no `scopes` still
  has full ingest access, and existing valid scope strings are unaffected.
  `"read"` exists so a future read-only API-key-authenticated surface
  (dashboards, external tooling) has a scope to gate on without inventing
  ad hoc strings later; no such surface is being enabled this change.

### `evals` (new, append-only)

Records a pass/fail/score check against a run — a rule-based assertion, an
LLM-judge verdict, or a manual reviewer call. `{ orgId, runId,
agentVersionId?, name, kind, passed, score?, details?, createdAt,
createdBy }`. Indexes: `by_run`, `by_org_name`, `by_org_version`.
**Append-only**, matching the events/audit_log pattern — an eval is itself a
recorded observation about a run and should carry the same immutability
guarantee (a "the eval said X" record should not be quietly edited after the
fact). Written via a member-gated `recordEval` mutation or an API-key path
(`sdkRecordEval`, requires `ingest:write`) for automated eval pipelines.

### `alert_rules` / `alert_events` (new)

`alert_rules` is ordinary admin-gated config (CRUD, audited like
`api_keys`/`projects`). `alert_events` is the append-only record of a rule
having fired — **except** `deliveryStatus`/`deliveredAt` may be patched by an
internal delivery mutation. This is not a violation of "events are
immutable": `alert_events` is not the event log, and the patched fields are
delivery bookkeeping (did we notify successfully) *about* an
already-immutable fact (the rule fired at time T with summary S) — the fact
itself, `firedAt`/`summary`/`ruleId`/`runId`, is never touched after insert.
This is the same pattern already established for `artifacts.referencedByEventId`
(metadata patch, not a fact patch).

### `webhook_targets` / `webhook_deliveries` (new)

**Naming/ownership note:** ADR-003 (`docs/adr/003-alerting-webhooks-export.md`,
accepted the same day by the team that shipped the pure delivery engine in
`apps/web/src/lib/delivery.ts`) already fixes the constraints this schema
must satisfy — org-scoped, admin-managed, append-only delivery logs,
https-only targets, HMAC-signed payloads, SSRF-guarded delivery — and
explicitly defers the schema itself to this ADR ("Any future alert-rule or
webhook-target schema in `convex/schema.ts` is the data agent's
responsibility... this ADR documents the constraints that schema must
satisfy, not the schema itself"). The table is named `webhook_targets`
(not `outbound_webhooks`) to match ADR-003 and `docs/design/action_layer.md`,
which already reference that name for the cycle-2 wiring plan. `alert_rules`/
`alert_events` similarly fulfill ADR-003's alerting half of the same freeze
lift; ADR-002 (this document) is where the actual schema lands for both.

`webhook_targets`: `{ orgId, url (https:// only), secret, events[],
enabled, createdAt }`. The signing secret is generated server-side and
**returned exactly once**, in the `createWebhook` response — every
subsequent read (`listWebhooks`) strips it. **Tradeoff, made deliberately**:
we store the secret in plaintext, not a hash, because HMAC-signing every
outbound delivery requires the original secret at delivery time; a
one-way hash (as used for API keys, which are only ever *compared*, never
*used to sign*) would make delivery impossible. This means a Convex data
compromise exposes webhook secrets in a way it does not expose API keys —
accepted here because outbound webhook secrets authenticate *us* to a
third party (limited blast radius: forged signatures on webhook payloads),
not a third party *into* this system (unlike an API key, whose hash-only
storage protects inbound ingest).

`webhook_deliveries` (append-only, status-patchable — same rationale as
`alert_events`): `{ orgId, webhookId, event, runId?, status, attempts,
lastAttemptAt?, responseCode?, payloadHash?, error?, createdAt }`.
`payloadHash`/`error` satisfy ADR-003 constraint 3 ("payload hash, HTTP
status (or error)") without storing the delivered payload body itself again
— the event envelope is reconstructible from `runId` + `event` at query
time via the existing `Run` contract shape.

Delivery *execution* (actually POSTing to the URL, retry scheduling) is
out of scope for this change — the tables and CRUD exist so the SDK/UI/data
layers can build on a stable shape next cycle; `recordWebhookDelivery` /
`updateWebhookDeliveryStatus` are internal-only entry points for that future
worker.

### `usage_counters` (new)

`{ orgId, day, runsStarted, eventsIngested, bytesIngested, artifactBytes }`,
unique per `(orgId, day)` via `by_org_day`. Incremented from every ingest
path (`sdkCreateRun`, `sdkCreateEvents`, `sdkCreateArtifact`, and their
Clerk-authenticated equivalents `createRun`/`createEvent`/`createArtifact`).
Uses the **same contention-mitigation strategy already in
`sdk_ingest.ts`'s per-key rate limiter**: single-unit increments (one run,
one event) are flushed exactly only ~1-in-10 times (scaled up by 10x when
flushed) to avoid serializing every ingest call on one usage-counter
document; batch increments (a multi-event `sdkCreateEvents` call) always
flush exactly, since the patch is already amortized over the batch. This is
explicitly an *approximate* counter for observability and future billing
groundwork, not an exact audit trail — `events`/`audit_log` remain the
source of truth for anything that needs to be exact.

### `daily_rollups` (new)

`{ orgId, agentId, date, runsTotal, runsFailed, runsCompleted,
runsCancelled, runsTimedOut, durationMsP50?, durationMsP95?, tokensIn,
tokensOut }`, indexed `by_org_date` and `by_agent_date`. Written **only** by
an internal daily cron (`computeDailyRollups`), never by a public mutation —
this is a derived projection over yesterday's terminal runs, computed from a
bounded sample (≤ 5,000 runs per agent per day) using the existing
`by_agent_started` index. Percentiles are computed from that bounded sample,
not the true population, for any agent/day exceeding the sample size — an
explicit, documented approximation rather than an unbounded scan.

## Consequences

- Every new table and field follows the existing tenancy pattern
  (`orgId` + `requireOrgMembership`/API-key resolution before any access).
  No cross-org query is introduced.
- Migration is a no-op: all new `runs`/`api_keys` fields are optional, and
  every new table is additive. Existing documents and existing callers of
  `createRun`/`sdkCreateRun`/`createApiKey` continue to work unchanged.
- The event log's immutability is unaffected: `evals` is append-only exactly
  like `events`/`audit_log`; `alert_events`/`webhook_deliveries` allow only a
  narrow, documented metadata patch (delivery status), never a patch to the
  fact of firing/attempting; `daily_rollups` and `usage_counters` are
  observability/groundwork projections computed from the log, never fed
  back into it.
- `packages/contracts` gains four new modules (`evals.ts`, `alerts.ts`,
  `webhooks.ts`, `usage.ts`) and additive fields on `Run`; this is a minor
  version bump (0.6.5 → 0.7.0) per the contracts versioning rule in
  CLAUDE.md, not a breaking one.
- Webhook secret plaintext storage is a deliberate, narrower-blast-radius
  tradeoff than API-key hashing (see above); it must not be used as a
  precedent for storing *inbound* credentials in plaintext.
- Alerting and webhook *delivery* (the actual notification/POST logic) are
  explicitly not part of this change — only the data model and CRUD surface
  that a future delivery worker will build on.
