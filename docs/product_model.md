# Domain Model — Agent Flight Recorder

## Entity Relationship Description

```
Organization
  ├── has many Users (via membership, role: owner | admin | member)
  ├── has many Projects
  └── Projects
        └── has many Agents
              └── Agents
                    ├── has many AgentVersions
                    └── has many Runs (via agentVersionId)
                          └── Runs
                                ├── has many Events (ordered by seq, append-only)
                                ├── has many Artifacts (blob pointers for large payloads)
                                └── has many Comments (human annotations)

Events
  └── optionally has one Artifact (when payloadExternalized = true)

Comments
  ├── always belong to a Run
  └── optionally reference a specific Event (eventId is nullable)
```

### Key Relationships

- An **Organization** is the root tenancy unit. All other entities belong to an organization via `orgId`.
- A **Project** groups agents for navigation. An agent belongs to exactly one project.
- An **Agent** is a named, versioned entity. Its identity is stable across versions.
- An **AgentVersion** is an immutable snapshot of an agent's configuration at a point in time (model, system prompt, tools, parameters). Once created, it is never mutated.
- A **Run** is one execution of an agent. It references the specific `AgentVersion` that was used.
- An **Event** belongs to exactly one Run and has a globally unique `id` and a per-run monotonically increasing `seq`. Events are append-only.
- An **Artifact** is a blob storage pointer. It is created when an event payload exceeds the size threshold. The `Event.artifactId` field references it.
- A **Comment** is always scoped to a Run. `eventId` is nullable — comments can annotate the run as a whole or a specific event.

---

## Lifecycle of a Run

Runs follow a linear state machine:

```
pending → running → completed
                 → failed
```

| Status | Meaning |
|---|---|
| `pending` | Run has been created but the first event has not been received yet. This state is brief — typically set by the API when a run is pre-registered. |
| `running` | `run.started` event has been received. The agent is actively executing. |
| `completed` | `run.finished` event was received with `status: "completed"`. The agent produced a final output. |
| `failed` | `run.finished` event was received with `status: "failed"`, or a `run.error` event was received with `fatal: true` followed by `run.finished`. |

### State Transition Rules

- Transitions are driven by events, not by direct status updates.
- The `runs` table status is a **projection** of the event log. It is updated by a Convex mutation that processes incoming events.
- If the status in the `runs` table ever disagrees with the final event in the log, the event log wins.
- A run in `running` state with no events received in the last N hours is considered **stale** but is not automatically failed in v1. Manual intervention or a cleanup job is needed.
- There is no `cancelled` state in v1. Cancellation is out of scope.

---

## How Events Flow Through the System

```
Agent Code (instrumented with @afr/sdk)
  │
  │  SDK batches events in memory
  │  SDK flushes on: run end, batch size limit, or timer
  │
  ▼
POST /api/ingest/events
  │
  │  1. Parse and validate request body
  │  2. Authenticate via Clerk (extract orgId, userId)
  │  3. Check payload sizes
  │  4. For large payloads: write to Vercel Blob → get URL → create Artifact record
  │  5. For each event: set payloadExternalized, artifactId if applicable
  │  6. Call Convex mutation: ingestEvents({ orgId, runId, events })
  │
  ▼
Convex Mutation: ingestEvents
  │
  │  1. Verify run belongs to orgId (tenancy check)
  │  2. Validate seq numbers are contiguous from last known seq
  │  3. Insert events into the events table (append-only)
  │  4. Update runs table projection (status, eventCount, timestamps)
  │  5. If run.finished: update run status and completedAt
  │
  ▼
Convex events table (append-only)
  +
Convex runs table (projection, mutable)
  +
Artifact records (blob pointers, immutable once created)
```

### Event Kinds

The `EventKind` union in `@afr/contracts` defines all valid event kinds. In v1:

| Kind | Meaning |
|---|---|
| `run.started` | First event. Contains the run input. |
| `run.finished` | Final event. Contains status (completed/failed), output or error, duration. |
| `run.error` | A non-fatal or fatal error occurred. If `fatal: true`, `run.finished` follows immediately. |
| `llm.request` | A request was sent to an LLM. Contains model, messages, tools. |
| `llm.response` | A response was received from an LLM. Contains tool calls, text, usage, stop reason. |
| `tool.call` | A tool was invoked. Contains tool name and args. |
| `tool.result` | A tool returned a result. Contains the result payload. |
| `agent.handoff` | One agent delegated to another. Contains the sub-agent identity. |
| `custom` | A user-defined event. The `kind` string must be prefixed with the user's namespace (e.g., `my-agent.checkpoint`). |

New kinds must be added to the `EventKind` union in `@afr/contracts` and documented in an ADR.

---

## Payload Externalization Rules

Event payloads can range from a few bytes (a run.started with a small input) to megabytes (an LLM response containing thousands of tokens, or a tool result with a large dataset).

Storing large payloads inline in Convex would hit document size limits and degrade query performance. Payloads above a threshold are externalized to blob storage.

### Rules

1. **Threshold:** The default threshold is 8,192 bytes (8 KB), configurable via `AFR_PAYLOAD_SIZE_THRESHOLD_BYTES`.
2. **When a payload exceeds the threshold:**
   - The API route serializes the full payload to JSON.
   - It writes the JSON blob to Vercel Blob at path: `afr/{orgId}/{runId}/{eventId}-payload.json`.
   - It creates an `Artifact` record in Convex with the blob URL, size, and content type.
   - The event is stored in Convex with `payloadExternalized: true`, `artifactId: <artifact._id>`, and a truncated `payloadSummary` (a small object with the most important fields, always under 512 bytes).
3. **When a payload is within threshold:**
   - The event is stored with the full payload inline in Convex.
   - `payloadExternalized: false`, `artifactId: null`.
4. **When reading an externalized event payload:**
   - The UI fetches the blob URL from the artifact record.
   - The blob URL must be a short-lived signed URL (Vercel Blob handles this automatically).
   - The blob URL is never stored in the event; it is fetched from the artifact on demand.

### What Never Gets Externalized

- `run.started` events (input size is constrained at SDK level; inputs over 8 KB must be passed by reference)
- `run.finished` events (output summary, status, duration — always small)
- `run.error` events (error metadata — always small)

### Inline Payload Summary Format

When a payload is externalized, the inline `payloadSummary` contains:

```json
{
  "_externalized": true,
  "_artifactId": "artifact_...",
  "_sizeBytes": 42880,
  "model": "claude-3-5-sonnet-20241022",
  "stopReason": "tool_use"
}
```

The summary always includes `_externalized`, `_artifactId`, `_sizeBytes`, and any top-level scalar fields from the original payload that fit within 512 bytes.

---

## Organization Membership Model

```
Organization
  ├── owner (1 per org, cannot be removed)
  ├── admins (0..n, can manage members and projects)
  └── members (0..n, can view all data in the org, cannot manage members)
```

### Membership Rules

- Every organization has exactly one owner. The owner is the Clerk user who created the organization.
- Ownership transfer is possible (via Clerk organization management) but is not surfaced in the AFR UI in v1.
- Admins can: invite members, remove members (not owner), create/edit projects and agents.
- Members can: view all runs, events, artifacts, and comments in the organization. They can add and resolve comments.
- Members cannot: manage other members, delete runs (no deletion in v1), or access other organizations' data.
- Clerk's organization membership is the source of truth for roles. AFR does not maintain a separate membership table in v1 — it reads the role from the Clerk JWT claim on each request.
- A user can be a member of multiple organizations. The Clerk `active organization` claim determines which org context the current session operates in.
