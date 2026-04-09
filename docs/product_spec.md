# Product Specification — Agent Flight Recorder

**Version:** v1.0  
**Date:** 2026-04-09  
**Primary Outcome:** Make agent failures explainable.

---

## 1. Problem Statement

AI agents are increasingly deployed in production, yet they fail in ways that are uniquely difficult to debug.

When a GPT-4 call returns unexpected output, the engineer has no systematic record of what prompt was sent, what temperature was used, or what the preceding context was. When a tool call silently returns an empty result instead of raising an error, the downstream failure manifests several steps later with no pointer back to the root cause. When an agent loops or stalls, there is no structured trace to diff against a previously working run to identify what changed.

The current state of agent debugging is:
- **Log tailing**: Engineers `grep` through unstructured stdout/stderr, losing ordering guarantees and structured context.
- **Ad-hoc print statements**: Developers instrument their agents manually and inconsistently, producing unreproducible debug runs.
- **No reproducibility**: Even when a failure is found, there is no canonical record to replay or share with a teammate.
- **No diff capability**: When a new agent version regresses, engineers cannot compare the failing run event-by-event against a known-good run.
- **LLM opacity**: Prompt content, model parameters, and token usage are rarely persisted — making cost analysis and failure attribution impossible.

The result: debugging an agent failure often takes hours and produces no lasting artifact. The same failure pattern recurs because there is no record that it ever happened.

### Who is hurt by this?

- **ML engineers** who build and iterate on agents and need to understand why a new version regressed.
- **Platform engineers** who operate agents in production and need to diagnose live failures fast.
- **Tech leads** who need to approve agent changes and want evidence that a new version behaves correctly.

---

## 2. Solution

Agent Flight Recorder solves agent opacity by recording every execution as an immutable, structured event graph.

The SDK wraps an agent's execution and emits structured events — `llm.request`, `llm.response`, `tool.call`, `tool.result`, `http.request`, and more — into an append-only log stored durably in Convex. Each event carries a sequence number, a timestamp, a strongly-typed payload, and an optional parent event reference that reconstructs the execution graph.

Once a run is recorded, engineers can:

1. **Inspect** the run event-by-event in the web UI, seeing exact prompts, model responses, tool inputs/outputs, and error details.
2. **Replay** the execution timeline as a step-through animation, understanding the temporal sequence and duration of each operation.
3. **Diff** two runs side-by-side to identify exactly what changed between a passing and failing execution.

The key design choices:

- **Immutable event log**: Events are never updated or deleted. The log is the ground truth. Replay and diff are derived views, not stored state.
- **Payload externalization**: Large payloads (>10 KB) are stored in blob storage and referenced by pointer. The Convex document store stays lean and queryable.
- **SDK-first**: Instrumentation is a library call, not a proxy. Engineers add `recorder.recordEvent(...)` calls inside their agent code, or use the higher-level `Recorder` class to wrap execution automatically.
- **Org-scoped tenancy**: All data is scoped to a Clerk organization. Data cannot leak across tenant boundaries.

---

## 3. Core User Stories

**US-01** — As an **ML engineer**, I want to open a failed run and see every LLM request and response in sequence so that I can identify exactly which prompt caused the unexpected output.

**US-02** — As an **ML engineer**, I want to diff a failing run against a previously successful run so that I can identify what changed between agent versions and pinpoint the regression.

**US-03** — As a **platform engineer**, I want to be alerted when a run fails and navigate directly to the failure event so that I can diagnose production failures without tailing logs.

**US-04** — As a **tech lead**, I want to review a run trace before approving a new agent version so that I have evidence the agent behaves correctly before it reaches production.

**US-05** — As an **ML engineer**, I want to see the token usage for every LLM call in a run so that I can identify expensive or wasteful prompts and optimize cost.

**US-06** — As a **platform engineer**, I want to see all runs for a given agent across all versions, filtered by status and time, so that I can monitor agent health and identify patterns in failures.

**US-07** — As an **ML engineer**, I want to annotate a specific event in a run with a comment so that I can leave a note for my teammate explaining a suspicious behavior I found during review.

**US-08** — As an **ML engineer**, I want to record a run from any TypeScript codebase using a simple SDK so that I do not need to modify my infrastructure or adopt a new framework to get tracing.

**US-09** — As a **tech lead**, I want runs to be organized under Projects and Agents so that I can navigate to all runs for a specific agent without searching across the entire organization's history.

**US-10** — As a **platform engineer**, I want large payloads (like full retrieved document sets or long LLM contexts) to be stored efficiently without hitting database limits so that high-context agents can be recorded without degrading performance.

---

## 4. Feature List — v1 (In Scope)

### Core Recording
- SDK `Recorder` class: `startRun`, `recordEvent`, `endRun`, `flush`
- SDK event builders for all standard event types (`llm.request`, `llm.response`, `llm.error`, `tool.call`, `tool.result`, `tool.error`, `memory.read`, `memory.write`, `retrieval.query`, `retrieval.result`, `http.request`, `http.response`, `custom`)
- HTTP transport with batching and retry
- Payload externalization: events over 10 KB written to blob storage, pointer stored in event record
- Sequence number validation: monotonically increasing, contiguous, server-validated

### Data Model
- Entity hierarchy: Organization > Project > Agent > AgentVersion > Run > Event
- Artifacts (blob pointers) hanging off Runs and Events
- Comments on Runs and Events (human annotations)
- Immutable event log: append-only, no update/delete
- Run status state machine: `pending → running → completed | failed | cancelled | timed_out`
- AgentVersion immutability: a new version record for each config change

### Web UI
- Sign in / sign up via Clerk, organization switcher
- Dashboard: recent runs, quick stats by status
- Project list, project detail
- Agent list, agent detail with version history
- Run list with filtering by status, agent, project, time range
- Run detail: event timeline, metadata, tags, artifact links
- Event inspector: per-event payload view with syntax highlighting
- Comment thread on runs and events
- Replay: step-through timeline player with elapsed time
- Diff: side-by-side run comparison with change highlighting
- Stable, shareable URLs for every entity (org/project/agent/run/event)
- Empty state, loading state, and error state on every data-dependent view

### Auth and Tenancy
- Clerk organization as the tenancy boundary
- Role-based access: admin, member, viewer
- All Convex queries org-scoped via `getAuthContext`

### Infrastructure
- pnpm monorepo with Turborepo
- Convex backend (schema, queries, mutations, auth)
- Next.js 14 App Router frontend
- Vercel deployment
- CI: typecheck → lint → build on every PR
- `./scripts/validate.sh` for local pre-push validation

---

## 5. Feature List — v2+ (Explicitly Out of Scope for v1)

The following will not be designed for or implemented until v1 ships and these decisions are revisited:

- **Real-time streaming**: Live event stream to multiple connected viewers as a run executes.
- **Analytics dashboards**: Aggregate metrics, histograms, p95 latency, cost trends across runs.
- **Agent marketplace / registry**: Shareable agent templates or configurations.
- **Policy and compliance**: Audit log export, data retention policies, PII redaction rules.
- **Multi-region ingestion**: Distributed ingest infrastructure for high-throughput production use.
- **Billing and metering**: Usage limits, subscription tiers, per-seat pricing.
- **Webhooks and integrations**: Slack alerts, PagerDuty on failure, GitHub PR comments.
- **Mobile application**: Any native or responsive mobile view.
- **Automated alerting**: Rule-based alert configuration (e.g., "alert if error rate > 5%").
- **Snapshots for replay performance**: Materialized replay checkpoints for very long runs.
- **LLM cost estimator**: Automatic token-to-cost mapping by model and provider.
- **SSO beyond Clerk**: SAML, enterprise SSO, custom identity providers.

---

## 6. Success Criteria for v1

v1 is successful when all of the following are true:

1. An engineer can add the SDK to a TypeScript agent project in under 10 minutes and see their first run recorded in the UI.
2. A failed run surfaces the failure event first, with the error message and stack trace visible without scrolling.
3. An engineer can diff two runs and see a structured list of events that differ, with payload changes highlighted.
4. The replay timeline correctly sequences all events with accurate relative timestamps.
5. All pages have loading, empty, and error states — no blank screens or unhandled exceptions visible to users.
6. `pnpm typecheck` passes with zero errors across all packages.
7. `./scripts/validate.sh` passes in CI on every PR.
8. No Convex query returns data that belongs to a different organization.
9. Events with payloads over 10 KB are stored in blob storage — no Convex document exceeds the payload size limit.
10. The SDK ships with complete JSDoc on all public methods and a working integration test.

---

## 7. Key UX Principles

**Calm, technical, high signal.** Agent Flight Recorder is a debugging tool, not a marketing page. Every UI element must carry information. Remove anything decorative.

**Strong vertical hierarchy.** Engineers scan top-to-bottom. The most critical data — event type, status, timestamp, error message — must be immediately legible without reading prose.

**Dense but not cramped.** Debugging tools benefit from information density. Avoid large swaths of whitespace that require scrolling to find the data. Use tight padding and tabular layouts where appropriate.

**Every state is handled.** No page may show a blank screen. Loading states must indicate what is loading. Empty states must explain why there is no data and what to do next. Error states must show the error and offer a recovery action.

**Stable, shareable URLs.** Every entity has a permanent URL: org, project, agent, version, run, event. Engineers share run links in Slack and incident tickets. URLs must be stable and not contain ephemeral tokens.

**Keyboard-friendly, copyable values.** Run IDs, event IDs, and payloads must be copy-on-click. The event timeline should be navigable with arrow keys. Engineers are in flow state — reduce mouse travel.

**No surprises from auth.** If a user is not authenticated, redirect them to sign-in immediately. If a resource belongs to a different org, return 404 — not a permission error that leaks the resource's existence.
