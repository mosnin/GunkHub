# Domain Model — Agent Flight Recorder

**Version:** 1.0
**Date:** 2026-04-09
**Status:** Authoritative — do not change entity shapes without bumping packages/contracts version.

---

## 1. Entity Hierarchy

```
Organization
└── Project
    └── Agent
        └── AgentVersion
            └── Run
                ├── Event          (append-only log — canonical source of truth)
                ├── Artifact       (blob storage pointer, hangs off Run or Event)
                └── Comment        (human annotation on a Run or Event)
```

Additional cross-cutting entity:

```
UserMembership  (maps ClerkUserId ↔ Organization, carries role)
```

---

## 2. Entity Definitions

### Organization

The top-level tenancy and authorization boundary. Every other entity belongs to exactly one Organization. The Organization is identified in Clerk by its `clerkOrgId` — this is the join key between the Clerk JWT token and the Convex `organizations` table.

| Field       | Type                           | Description |
|-------------|--------------------------------|-------------|
| id          | string (Convex ID)             | Internal DB identifier |
| clerkOrgId  | string                         | Clerk organization ID, e.g. `org_2abc...`. Used to look up the org from the Clerk JWT. |
| name        | string                         | Display name, e.g. "Acme Corp" |
| slug        | string                         | URL-safe identifier, e.g. "acme-corp". Unique. Used in stable URLs. |
| plan        | "free" \| "pro" \| "enterprise" | Billing tier. Determines feature access. |
| createdAt   | number (epoch ms)              | |
| updatedAt   | number (epoch ms)              | |

**Indexes:** `by_clerk_org_id` (clerkOrgId), `by_slug` (slug)

---

### Project

A logical grouping of related agents within an organization. A project might represent a product area ("customer-support"), a team ("infra-agents"), or a domain ("document-processing"). Projects have no business logic — they exist to organize the agent namespace and scope the run list view.

| Field       | Type               | Description |
|-------------|-------------------|-------------|
| id          | string (Convex ID) | |
| orgId       | ID<organizations>  | Parent organization |
| name        | string             | Display name |
| slug        | string             | URL-safe, unique within the org |
| description | string?            | Optional freeform description |
| createdAt   | number             | |
| updatedAt   | number             | |

**Indexes:** `by_org` (orgId), `by_org_slug` (orgId, slug)

---

### Agent

A named agent definition within a project. An Agent is a durable registry entry — it does not change when the agent's code changes. Code changes create a new `AgentVersion` instead. An agent might be "gpt-4-customer-support-bot" or "code-review-agent".

| Field       | Type               | Description |
|-------------|-------------------|-------------|
| id          | string (Convex ID) | |
| orgId       | ID<organizations>  | For tenancy queries |
| projectId   | ID<projects>       | Parent project |
| name        | string             | Display name |
| slug        | string             | URL-safe, unique within the project |
| description | string?            | |
| createdAt   | number             | |
| updatedAt   | number             | |

**Indexes:** `by_org` (orgId), `by_project` (projectId)

---

### AgentVersion

An immutable snapshot of an agent's configuration at a point in time. Once created, an AgentVersion record is never updated — changes to the agent require creating a new version. This immutability means that a Run is always associated with the exact configuration that produced it, making historical replay accurate.

Typical reason for a new version: changed system prompt, updated tool list, new model, modified sampling parameters.

| Field       | Type               | Description |
|-------------|-------------------|-------------|
| id          | string (Convex ID) | |
| agentId     | ID<agents>         | Parent agent |
| orgId       | ID<organizations>  | For tenancy queries |
| version     | string             | Semver string, e.g. "1.2.3". Must be unique per agent. |
| changelog   | string?            | Human-written description of what changed |
| createdAt   | number             | |

**Indexes:** `by_agent` (agentId)

**Immutability rule:** There are no `updateAgentVersion` or `deleteAgentVersion` mutations. Once created, the record is frozen.

---

### Run

A single execution instance of an AgentVersion. A Run begins when the SDK calls `startRun()` and ends when the SDK calls `endRun()` or `failRun()`. The Run record itself stores status and timing metadata; the content of the execution lives in the Event log.

| Field          | Type               | Description |
|----------------|-------------------|-------------|
| id             | string (Convex ID) | |
| orgId          | ID<organizations>  | For tenancy queries |
| projectId      | ID<projects>       | For scoped list queries |
| agentId        | ID<agents>         | For scoped list queries |
| agentVersionId | ID<agent_versions>? | The specific version that ran. Optional to support unversioned agents. |
| status         | RunStatus          | Current state — see state machine below |
| startedAt      | number (epoch ms)  | Wall clock time when the run began |
| endedAt        | number?            | Wall clock time when the run reached a terminal state |
| metadata       | Record<string, unknown> | Caller-provided key/value bag. Searchable context (e.g. `{ env: "prod", customerId: "c123" }`) |
| tags           | string[]           | Free-form labels for filtering |
| triggeredBy    | string?            | What initiated this run — "cron", "webhook", "manual", user ID, etc. |
| sdkVersion     | string?            | Version of the SDK that recorded this run |

**Indexes:** `by_org`, `by_project`, `by_agent`, `by_org_status`, `by_agent_started`, `by_project_started`

---

### Event

A single structured fact about what happened during a run. Events are the canonical source of truth. They are written by the SDK and may never be updated or deleted. The ordered sequence of events for a run is the complete, auditable history of that execution.

| Field          | Type               | Description |
|----------------|-------------------|-------------|
| id             | string (Convex ID) | |
| runId          | ID<runs>           | The run this event belongs to |
| orgId          | ID<organizations>  | For tenancy queries |
| type           | EventType          | Discriminant — determines the shape of `payload` |
| sequenceNumber | number             | Monotonically increasing integer starting at 1, unique per run |
| timestamp      | number (epoch ms)  | Wall clock time the event was emitted by the SDK |
| payload        | EventPayload       | Discriminated union — exact shape depends on `type` |
| parentEventId  | ID<events>?        | Optional parent event reference. Used to represent nested calls (e.g. a tool.call that triggered an http.request). |

**Indexes:** `by_run` (runId, sequenceNumber), `by_run_type` (runId, type)

**Immutability rules (non-negotiable):**
- There is no `updateEvent` mutation. There will never be one.
- There is no `deleteEvent` mutation. There will never be one.
- The event log is append-only. Period.

**Ordering:** Events in a run are always ordered by `sequenceNumber`. Do not rely on document insertion order or timestamp for ordering — use `sequenceNumber`.

**Payload size limit:** If the serialized payload exceeds 10 KB, the payload must be written to blob storage. The event record stores an `Artifact` pointer (storageKey + checksum) in the payload instead of the raw data. The `createEvent` mutation enforces this rule.

---

### Artifact

A pointer to a large binary or text payload stored in blob storage. Artifacts hang off Runs (for run-level outputs) or Events (for oversized event payloads). The Convex document stores only metadata and the storage key — the actual bytes live in the blob store.

| Field         | Type               | Description |
|---------------|-------------------|-------------|
| id            | string (Convex ID) | |
| runId         | ID<runs>           | The run this artifact belongs to |
| orgId         | ID<organizations>  | For tenancy queries |
| eventId       | ID<events>?        | The specific event that produced this artifact, if any |
| name          | string             | Human-readable filename, e.g. "llm-response-seq-42.json" |
| mimeType      | string             | e.g. "application/json", "text/plain" |
| size          | number (bytes)     | Size of the stored payload |
| storageKey    | string             | Path/key within the storage bucket |
| storageBucket | string             | Logical bucket name — allows multi-bucket configurations |
| checksum      | string             | SHA-256 hex digest of the content. Used for integrity verification. |
| createdAt     | number             | |

**Indexes:** `by_run` (runId)

---

### Comment

A human annotation on a Run or Event. Comments are used for collaborative review: engineers can flag suspicious events, leave notes for teammates, and mark investigations as resolved. Comments are mutable (content can be edited, they can be resolved).

| Field      | Type                     | Description |
|------------|--------------------------|-------------|
| id         | string (Convex ID)       | |
| orgId      | ID<organizations>        | For tenancy queries |
| targetId   | string                   | ID of the target Run or Event (stored as string for union flexibility) |
| targetType | "run" \| "event"         | Discriminant for the target entity |
| authorId   | string                   | Clerk user ID of the comment author |
| content    | string                   | Markdown-formatted comment body |
| createdAt  | number                   | |
| updatedAt  | number?                  | Set on edit |
| resolvedAt | number?                  | Set when a reviewer marks the comment resolved |
| resolvedBy | string?                  | Clerk user ID of the person who resolved it |

**Indexes:** `by_org` (orgId), `by_target` (targetId, targetType)

---

### UserMembership

Maps a Clerk user to an organization with a role. This is the authorization join table. Every Convex function that requires more than basic authentication also calls `requireOrgMembership` which queries this table.

| Field       | Type                                  | Description |
|-------------|---------------------------------------|-------------|
| id          | string (Convex ID)                    | |
| clerkUserId | string                                | Clerk user identifier |
| orgId       | ID<organizations>                     | The organization this membership is in |
| role        | "admin" \| "member" \| "viewer"       | Controls write access |
| joinedAt    | number                                | |

**Indexes:** `by_clerk_user` (clerkUserId), `by_org` (orgId)

**Roles:**
- `admin` — can manage projects, agents, versions, and org members
- `member` — can create and view runs, add comments
- `viewer` — read-only access to runs and events

---

## 3. Event Taxonomy

All possible values of `EventType` and what they represent:

| EventType          | Represents | Paired With |
|--------------------|-----------|-------------|
| `run.started`      | The beginning of a run execution. Always sequenceNumber=1. Carries the run's input and config. | `run.completed` or `run.failed` |
| `run.completed`    | The run finished successfully. Carries the final output and total duration. Terminal. | `run.started` |
| `run.failed`       | The run finished with an error. Carries the error message, code, and stack trace. Terminal. | `run.started` |
| `run.cancelled`    | The run was explicitly cancelled before completion. Terminal. | `run.started` |
| `llm.request`      | An LLM API call is about to be made. Carries model, messages array, temperature, max_tokens. | `llm.response` or `llm.error` |
| `llm.response`     | An LLM API call returned successfully. Carries model, content, token usage, finish_reason. | `llm.request` |
| `llm.error`        | An LLM API call failed. Carries error message and code. | `llm.request` |
| `tool.call`        | A tool is being invoked by the agent. Carries tool name, input arguments, and a call_id for correlation. | `tool.result` or `tool.error` |
| `tool.result`      | A tool call returned successfully. Carries output and duration. Correlated by call_id. | `tool.call` |
| `tool.error`       | A tool call failed. Carries error and optionally the call_id. | `tool.call` |
| `memory.read`      | The agent read from its memory store. Carries optional key and result. | — |
| `memory.write`     | The agent wrote to its memory store. Carries optional key and value. | — |
| `retrieval.query`  | A vector/semantic retrieval query was issued. Carries query text and optional filters. | `retrieval.result` |
| `retrieval.result` | A retrieval query returned results. Carries results array and duration. | `retrieval.query` |
| `http.request`     | An outbound HTTP request was made. Carries method, URL (credential-free), redacted headers. | `http.response` |
| `http.response`    | An HTTP response was received. Carries status, redacted headers, body size, duration. | `http.request` |
| `custom`           | An application-defined event. Carries an opaque `data` field. Use for domain-specific events not covered above. | — |

**Pairing convention:** Events that represent the start of an operation (llm.request, tool.call, http.request) should be followed by their corresponding result/error event. The `parentEventId` field can be used to express explicit parent-child relationships in the event graph.

**Invariants:**
- `run.started` is always sequenceNumber=1 in a run
- `run.completed`, `run.failed`, or `run.cancelled` is always the last event (highest sequenceNumber) in a run
- A run without a terminal event is considered still-in-progress

---

## 4. Run Status State Machine

```
                  ┌───────────┐
                  │  pending  │  ← Created by SDK before execution starts
                  └─────┬─────┘
                        │ SDK calls startRun() / transport creates run
                        ▼
                  ┌───────────┐
                  │  running  │  ← Events are being appended
                  └─────┬─────┘
          ┌─────────────┼──────────────┬─────────────────┐
          ▼             ▼              ▼                  ▼
   ┌───────────┐ ┌───────────┐ ┌───────────────┐ ┌───────────────┐
   │ completed │ │  failed   │ │   cancelled   │ │   timed_out   │
   └───────────┘ └───────────┘ └───────────────┘ └───────────────┘
         ↑           ↑                ↑                  ↑
    endRun()      failRun()      cancelRun()        server-side
                                                    timeout guard
```

**Valid transitions:**

| From      | To                                        | Trigger |
|-----------|-------------------------------------------|---------|
| pending   | running                                   | First event received by ingest API |
| pending   | cancelled                                 | Explicit cancellation before first event |
| running   | completed                                 | SDK calls `endRun()` |
| running   | failed                                    | SDK calls `failRun()` or `run.failed` event received |
| running   | cancelled                                 | Explicit cancellation |
| running   | timed_out                                 | Server-side timeout guard (future v1.1 feature) |
| completed | (none)                                    | Terminal |
| failed    | (none)                                    | Terminal |
| cancelled | (none)                                    | Terminal |
| timed_out | (none)                                    | Terminal |

**Enforcement:** The `updateRunStatus` Convex mutation validates transitions at the database layer and throws on invalid transitions. Terminal runs cannot be transitioned to any other state.

---

## 5. Payload Externalization Rule

**Rule:** Any event payload whose serialized JSON size exceeds **10 KB** must be written to blob storage. The event record in Convex stores only a pointer — not the raw payload.

**Why this rule exists:**
- Convex document size limits: a single Convex document cannot exceed 1 MB. Staying well below this limit prevents future operational issues as payload sizes grow.
- Query performance: keeping Convex documents small ensures index scans and list queries remain fast. Blob-heavy events do not slow down timeline queries.
- Cost control: Convex storage is priced per document. Blob storage is cheaper per GB for large payloads.

**What a pointer looks like:**
When an event's payload is externalized, the `payload` field in the Convex `events` table contains:
```json
{
  "type": "llm.response",
  "__externalized": true,
  "artifactId": "<artifact_convex_id>",
  "storageKey": "org_abc/runs/run_xyz/events/seq-42-llm-response.json",
  "checksum": "sha256:deadbeef..."
}
```
The full payload can be retrieved by fetching the artifact from blob storage using `storageKey`.

**Where the check happens:**
- The SDK measures payload size before shipping. If > 10 KB, it calls the artifact upload endpoint first, receives the `storageKey`, then ships the pointer event.
- The Convex `createEvent` mutation does not enforce the size limit (Convex does not have pre-insert hooks). Size enforcement is the SDK's responsibility.

**Current implementation status:** The `BlobStorageAdapter` interface exists in `convex/helpers/storage.ts` as a stub. Real implementation (Vercel Blob or R2) is planned for Prompt 2/3.

---

## 6. Derived Projections

Two derived types are defined in `packages/contracts/src/replay.ts` and `packages/contracts/src/diff.ts`. These are **never stored** in Convex — they are computed on read from the event log.

### ReplayProjection

A `ReplayProjection` takes the ordered event list for a run and produces an array of `ReplayFrame` objects, each containing the event, its index, and the elapsed milliseconds since the start of the run.

```typescript
interface ReplayFrame {
  event: Event;
  index: number;
  elapsed_ms: number;  // timestamp - run.startedAt
}

interface ReplayProjection {
  runId: string;
  frames: ReplayFrame[];
  totalEvents: number;
  duration_ms: number;
}
```

**How it is computed:** Fetch all events for a run ordered by sequenceNumber. For each event, compute `elapsed_ms = event.timestamp - run.startedAt`. Wrap into ReplayFrame. The resulting array is the ReplayProjection.

**Why not stored:** Storing replays would duplicate the event log. Any change to the event log (impossible in practice, but hypothetically) would require re-computing replays. The projection is cheap to compute on demand.

### RunDiff

A `RunDiff` compares two runs event-by-event and produces a list of `EventDiff` records describing what changed, was added, or was removed between the left (baseline) and right (comparison) run.

```typescript
interface RunDiff {
  leftRunId: string;
  rightRunId: string;
  eventDiffs: EventDiff[];
  summary: DiffSummary;  // counts of added/removed/changed/same
}
```

**How it is computed:** Fetch events for both runs. Align events by sequenceNumber. For events present in both runs, deep-compare payloads field-by-field and produce `FieldChange[]` records. Events only in one run are `added` or `removed`.

**Why not stored:** Diffs are inherently ephemeral query results. Two different engineers might want different diff strategies (align by sequence number, align by event type, align by semantic meaning). Storing diffs would lock in one strategy.

---

## 7. SDK Recording Model

The SDK's `Recorder` class maps directly onto this entity model:

| SDK Operation | Entity Created/Updated |
|---------------|------------------------|
| `new Recorder({ agentId, ... })` | No entity created. Config stored in memory. |
| `recorder.startRun(input, config)` | Calls transport to `POST /api/runs` → creates `Run` (status: pending). Transport response carries the `runId`. Emits `run.started` event. |
| `recorder.recordEvent(type, payload)` | Buffers a `CreateEventRequest`. On flush, calls `POST /api/events` → creates `Event` records in Convex. |
| `recorder.endRun(output)` | Emits `run.completed` event. Flushes buffer. Calls transport to `PATCH /api/runs/:id/status` → updates `Run` status to "completed". |
| `recorder.failRun(error)` | Emits `run.failed` event. Flushes buffer. Updates `Run` status to "failed". |
| `recorder.flush()` | Sends all buffered events to the ingest API in a single batch. Returns `FlushResult`. |

**Sequence number assignment:** The SDK increments a local counter (starting at 1) for each event. The counter is reset to 0 when a new run starts. The SDK sets `sequenceNumber` on each `CreateEventRequest`. The backend validates that numbers are monotonically increasing within the run.

**Event buffering:** Events are buffered in memory and flushed on a timer (default 1000ms) or when the buffer reaches `maxBatchSize` (default 100). `endRun` and `failRun` always flush synchronously before returning.

**Transport is injected:** `new Recorder(config, transport?)` accepts an optional `Transport` implementation. If not provided, defaults to `HttpTransport`. This injection point enables unit testing with `MockTransport` without making HTTP calls.
