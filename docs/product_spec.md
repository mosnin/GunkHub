# Product Specification — Agent Flight Recorder (v1)

## Problem Statement

AI agents are increasingly deployed in production to perform complex, multi-step tasks: filing support tickets, running data pipelines, executing research workflows, orchestrating other agents. When these agents fail — and they do fail — engineers have almost no tooling to understand what happened.

Traditional observability tools (APM, logging, tracing) were designed for deterministic services. They show latency histograms and error rates, but they cannot show you: what the model was thinking, which tool it chose and why, what the exact input and output of each step was, or how this run differs from the successful run last Tuesday.

The result is that debugging agent failures today is a manual, time-consuming process of reconstructing execution from scattered logs, relying on memory, and guessing at causation. Engineers waste hours on post-mortems that should take minutes.

**Agent Flight Recorder solves this** by recording the complete execution of an AI agent as a structured, immutable event graph — and making that graph inspectable, replayable, and comparable.

---

## Target Users

### Primary: Agent Engineers

Software engineers who build, own, and operate LLM-based agents. They have strong programming skills and are comfortable with technical tooling. They debug failures regularly and are frustrated by the opacity of current agent infrastructure.

**Their jobs to be done:**
- Understand why a specific production run failed
- Verify that a bug fix actually changed agent behavior
- Compare how two versions of an agent handle the same input
- Share a run with a colleague for async review

### Secondary: ML Engineers / Prompt Engineers

Engineers who tune models, prompts, and retrieval systems. Less focused on infrastructure, more focused on model behavior and quality.

**Their jobs to be done:**
- See exactly what prompt was sent to the model in a specific run
- Compare model outputs across different configurations
- Identify patterns in failure modes across many runs

---

## Core Jobs to Be Done

1. **Make a failure explainable.** Given a failed run, an engineer can find the exact event where things went wrong, understand the model's state at that point, and explain the failure to their team.

2. **Make a fix verifiable.** After changing agent code or a prompt, an engineer can compare the new run against the old one and confirm the behavior changed in the expected way.

3. **Make behavior auditable.** A team can answer "what exactly did our agent do on this customer's request last Tuesday?" with full fidelity.

4. **Make debugging async.** An engineer can share a run link with a colleague who can inspect it independently without needing a live session or screen share.

---

## v1 Scope: Make Failures Explainable

Version 1 is focused on a single job: **making agent failures explainable**. All other jobs are addressed to a minimal degree but are not the primary focus.

### In Scope for v1

- **Event ingestion:** SDK records events from agent code and sends them to AFR via a POST endpoint.
- **Run storage:** Runs and their events are stored immutably in Convex.
- **Run list view:** Browse runs for a project, filtered by agent, status, and date.
- **Run detail view:** See the full event log for a run as a chronological timeline.
- **Event detail:** Inspect the payload of any event, including externalized blobs.
- **Replay walker (v1):** Step through a run's events in order in the UI. This is a UI-only walkthrough — not re-execution of the agent.
- **Run diff (v1):** Structural comparison of two run event sequences — which events appeared, disappeared, or had different payloads. Not execution-level diff.
- **Comments:** Leave annotations on a run or a specific event for async collaboration.
- **Multi-tenancy:** Full organization-level data isolation via Clerk + Convex.
- **Blob externalization:** Large event payloads stored in blob storage with pointer in the event record.

### Out of Scope for v1

- Real replay execution engine (re-running the agent against recorded inputs)
- Real diff computation (semantic comparison of model outputs)
- Production-grade ingestion pipeline (queue, stream, backpressure)
- Real-time collaboration (live cursors, operational transform)
- Alerting and notifications on run failure
- Analytics and usage tracking
- Marketplace or agent registry
- Policy engine or RBAC beyond owner/admin/member
- Multi-region storage
- Agent scheduling or orchestration
- Evaluation frameworks or regression testing pipelines

---

## Success Metrics (Qualitative, v1)

Since v1 is pre-revenue and pre-launch, success is measured qualitatively:

1. **An engineer can go from "we had a failure" to "I understand exactly what happened" in under 5 minutes** using the run detail view and event log.

2. **An engineer can confirm a fix worked** by opening a diff of two runs and seeing the relevant events changed.

3. **A team can hold an async post-mortem** by sharing a run link, with all context embedded — no need for a screen share or live session.

4. **Instrumentation is not painful.** An agent engineer can add AFR recording to an existing agent in under 30 minutes using the SDK.

5. **The system does not lose events.** Under normal operation, zero events are dropped between SDK and Convex storage.

---

## Key User Flows

### Flow 1: Record a Run

1. Agent engineer installs `@afr/sdk` in their agent code.
2. They wrap their agent execution with `FlightRecorder.record()`.
3. They set `AFR_INGEST_URL` in their environment.
4. On each agent execution, the SDK emits events (run.started, llm.request, llm.response, tool.call, tool.result, run.finished or run.error).
5. Events are batched and POSTed to `POST /api/ingest/events`.
6. The API route validates, authenticates (Clerk), and writes to Convex via mutation.
7. Large payloads are offloaded to Vercel Blob; the event record stores the artifact pointer.
8. The run appears in the AFR web UI within seconds.

**Success criteria:** The engineer does not have to change their agent's logic — only add the SDK wrapper.

### Flow 2: Inspect a Failure

1. Engineer receives an alert (external) that an agent run failed.
2. They open AFR web UI, navigate to the project, filter runs by status: failed.
3. They open the failed run.
4. The run detail page shows the event timeline. The final events are a `run.error` and `run.finished` with status: failed.
5. They click the `run.error` event, expand the payload, and read the error details.
6. They scroll up to the event that preceded the error — a `tool.result` — and expand its payload.
7. They can see exactly what data caused the failure.
8. They add a comment explaining the root cause.

**Success criteria:** The engineer did not need to read raw logs or ask anyone for context.

### Flow 3: Replay a Run

1. Engineer opens a run detail page.
2. They click "Replay" to enter replay mode.
3. The UI presents an event cursor at seq=1 (run.started).
4. They step forward through events one by one using keyboard (arrow keys) or click.
5. For each event, the payload panel shows the full event payload.
6. For LLM events, the messages are rendered in a chat-like format.
7. They can jump to any event by clicking it in the timeline sidebar.

**Success criteria:** The engineer can reconstruct exactly what the agent experienced at any point in the run without re-running it.

### Flow 4: Compare Two Runs

1. Engineer has two runs they want to compare — a failing run and a passing run with similar input.
2. From the run list, they select both runs and click "Compare".
3. The diff viewer shows two columns: left (run A), right (run B).
4. Events are aligned by kind and sequence. Rows that differ are highlighted.
5. The engineer can click any differing row to see a side-by-side payload diff.
6. They can see that the tool call was the same but the tool result changed between runs.

**Success criteria:** The engineer can pinpoint the divergence point between two runs without manually comparing event logs.
