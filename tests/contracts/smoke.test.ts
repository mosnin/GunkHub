/**
 * contracts/smoke.test.ts
 *
 * Type-level and runtime smoke tests for @afr/contracts.
 * Validates that the contract types are correctly shaped, discriminated unions
 * narrow properly, branded IDs prevent mixing, and entity interfaces are sound.
 */

import { describe, it, expect } from "vitest";
import type {
  RunStatus,
  EventCategory,
  EventPayload,
  LifecyclePayload,
  LLMPayload,
  ToolPayload,
  MemoryPayload,
  RetrievalPayload,
  ErrorPayload,
  CustomPayload,
  Run,
  Event,
  Id,
  IngestEvent,
  IngestEventsRequest,
  CreateRunRequest,
} from "@afr/contracts";

// ---------------------------------------------------------------------------
// Helper: assert exhaustive narrowing at compile time
// ---------------------------------------------------------------------------
function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

// ---------------------------------------------------------------------------
// 1. RunStatus union members
// ---------------------------------------------------------------------------
describe("RunStatus", () => {
  it("includes all expected status values", () => {
    const statuses: RunStatus[] = [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
    ];
    expect(statuses).toHaveLength(5);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
    expect(statuses).toContain("cancelled");
  });

  it("is assignable to string", () => {
    const s: RunStatus = "completed";
    const asString: string = s;
    expect(asString).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 2. EventCategory union members
// ---------------------------------------------------------------------------
describe("EventCategory", () => {
  it("includes all expected category values", () => {
    const categories: EventCategory[] = [
      "lifecycle",
      "llm",
      "tool",
      "memory",
      "retrieval",
      "error",
      "custom",
    ];
    expect(categories).toHaveLength(7);
    for (const cat of categories) {
      expect(typeof cat).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. EventPayload discriminated union — category narrowing
// ---------------------------------------------------------------------------
describe("EventPayload discriminated union", () => {
  it("narrows correctly on category discriminant", () => {
    const processPayload = (payload: EventPayload): string => {
      switch (payload.category) {
        case "lifecycle":
          return `lifecycle:${payload.kind}`;
        case "llm":
          return `llm:${payload.kind}`;
        case "tool":
          return `tool:${payload.kind}`;
        case "memory":
          return `memory:${payload.kind}`;
        case "retrieval":
          return `retrieval:${payload.kind}`;
        case "error":
          return `error:${payload.errorType}`;
        case "custom":
          return `custom:${payload.type}`;
        default:
          return assertNever(payload);
      }
    };

    const lifecycle: LifecyclePayload = {
      category: "lifecycle",
      kind: "run_started",
    };
    expect(processPayload(lifecycle)).toBe("lifecycle:run_started");

    const llm: LLMPayload = {
      category: "llm",
      kind: "request",
      model: "gpt-4",
    };
    expect(processPayload(llm)).toBe("llm:request");

    const tool: ToolPayload = {
      category: "tool",
      kind: "call",
      toolName: "web_search",
    };
    expect(processPayload(tool)).toBe("tool:call");

    const error: ErrorPayload = {
      category: "error",
      errorType: "NetworkError",
      message: "Connection refused",
      recoverable: true,
    };
    expect(processPayload(error)).toBe("error:NetworkError");
  });

  it("LifecyclePayload accepts all valid kinds", () => {
    const kinds: LifecyclePayload["kind"][] = [
      "run_started",
      "run_completed",
      "run_failed",
      "run_cancelled",
      "step_started",
      "step_completed",
      "step_failed",
    ];
    for (const kind of kinds) {
      const payload: LifecyclePayload = { category: "lifecycle", kind };
      expect(payload.kind).toBe(kind);
    }
  });

  it("ToolPayload accepts all valid kinds", () => {
    const callPayload: ToolPayload = {
      category: "tool",
      kind: "call",
      toolName: "calculator",
      toolCallId: "tc_001",
    };
    expect(callPayload.kind).toBe("call");

    const resultPayload: ToolPayload = {
      category: "tool",
      kind: "result",
      toolName: "calculator",
      latencyMs: 12,
    };
    expect(resultPayload.kind).toBe("result");

    const errorPayload: ToolPayload = {
      category: "tool",
      kind: "error",
      toolName: "calculator",
      errorMessage: "Division by zero",
    };
    expect(errorPayload.kind).toBe("error");
  });

  it("MemoryPayload and RetrievalPayload have correct optional fields", () => {
    const mem: MemoryPayload = {
      category: "memory",
      kind: "write",
      namespace: "agent_state",
      keyCount: 5,
    };
    expect(mem.namespace).toBe("agent_state");
    expect(mem.keyCount).toBe(5);

    const retrieval: RetrievalPayload = {
      category: "retrieval",
      kind: "result",
      source: "pinecone",
      resultCount: 4,
      latencyMs: 30,
    };
    expect(retrieval.resultCount).toBe(4);
  });

  it("CustomPayload carries arbitrary data", () => {
    const custom: CustomPayload = {
      category: "custom",
      type: "agent_decision",
      data: {
        decision: "use_tool",
        confidence: 0.95,
        tools: ["web_search", "calculator"],
      },
    };
    expect(custom.data["decision"]).toBe("use_tool");
    expect(custom.data["confidence"]).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// 4. Id<T> brand prevents mixing entity IDs (compile-time)
// ---------------------------------------------------------------------------
describe("Id<T> branded type", () => {
  it("is a string at runtime", () => {
    // Id<T> is a branded string — at runtime it is just a string
    const runId = "run_abc123" as Id<"Run">;
    const agentId = "agent_xyz" as Id<"Agent">;

    expect(typeof runId).toBe("string");
    expect(typeof agentId).toBe("string");
    expect(runId).toBe("run_abc123");
    expect(agentId).toBe("agent_xyz");
  });

  it("carries the brand at the type level (compile-time guard)", () => {
    // This test documents the intent: the TypeScript compiler prevents assigning
    // an Id<"Run"> to an Id<"Agent"> parameter.
    // We verify the runtime values are plain strings.
    const runId = "run_001" as Id<"Run">;
    const asStr: string = runId; // widening to string is allowed
    expect(asStr).toBe("run_001");
  });
});

// ---------------------------------------------------------------------------
// 5. Run entity interface fields
// ---------------------------------------------------------------------------
describe("Run entity", () => {
  it("has all required fields with correct types", () => {
    const run: Run = {
      id: "run_001" as Id<"Run">,
      agentId: "agent_001" as Id<"Agent">,
      projectId: "proj_001" as Id<"Project">,
      orgId: "org_001" as Id<"Organization">,
      status: "completed",
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      durationMs: 1000,
      metadata: { key: "value" },
      tags: ["prod", "v1"],
    };

    expect(run.status).toBe("completed");
    expect(run.tags).toHaveLength(2);
    expect(run.metadata["key"]).toBe("value");
  });

  it("allows optional errorMessage and errorCode", () => {
    const failedRun: Run = {
      id: "run_002" as Id<"Run">,
      agentId: "agent_001" as Id<"Agent">,
      projectId: "proj_001" as Id<"Project">,
      orgId: "org_001" as Id<"Organization">,
      status: "failed",
      startedAt: 1_700_000_000_000,
      metadata: {},
      tags: [],
      errorMessage: "Something went wrong",
      errorCode: "ERR_TIMEOUT",
    };

    expect(failedRun.errorMessage).toBe("Something went wrong");
    expect(failedRun.errorCode).toBe("ERR_TIMEOUT");
    expect(failedRun.completedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Event entity interface fields
// ---------------------------------------------------------------------------
describe("Event entity", () => {
  it("has all required fields", () => {
    const event: Event = {
      id: "evt_001" as Id<"Event">,
      runId: "run_001" as Id<"Run">,
      orgId: "org_001" as Id<"Organization">,
      type: "llm.request",
      category: "llm",
      sequence: 1,
      timestamp: 1_700_000_000_123,
      payload: null,
      metadata: {},
    };

    expect(event.sequence).toBe(1);
    expect(event.payload).toBeNull();
  });

  it("accepts a typed EventPayload", () => {
    const payload: LifecyclePayload = { category: "lifecycle", kind: "step_started", stepName: "plan" };
    const event: Event = {
      id: "evt_002" as Id<"Event">,
      runId: "run_001" as Id<"Run">,
      orgId: "org_001" as Id<"Organization">,
      type: "lifecycle.step_started",
      category: "lifecycle",
      sequence: 2,
      timestamp: 1_700_000_000_200,
      payload,
      metadata: { stepName: "plan" },
    };

    expect(event.payload).not.toBeNull();
    if (event.payload !== null && event.payload.category === "lifecycle") {
      expect(event.payload.stepName).toBe("plan");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. IngestEvent and IngestEventsRequest shapes
// ---------------------------------------------------------------------------
describe("IngestEvent / IngestEventsRequest", () => {
  it("IngestEvent accepts all required fields and optional ones", () => {
    const event: IngestEvent = {
      type: "tool.call",
      category: "tool",
      sequence: 3,
      timestamp: Date.now(),
      payload: { category: "tool", kind: "call", toolName: "web_search" },
      parentEventId: "evt_parent",
      metadata: { source: "agent" },
    };
    expect(event.type).toBe("tool.call");
    expect(event.sequence).toBe(3);
  });

  it("IngestEventsRequest groups events under a runId", () => {
    const req: IngestEventsRequest = {
      runId: "run_001",
      events: [
        {
          type: "lifecycle.run_started",
          category: "lifecycle",
          sequence: 1,
          timestamp: Date.now(),
          payload: { category: "lifecycle", kind: "run_started" },
        },
      ],
    };
    expect(req.events).toHaveLength(1);
    expect(req.runId).toBe("run_001");
  });
});

// ---------------------------------------------------------------------------
// 8. CreateRunRequest shape
// ---------------------------------------------------------------------------
describe("CreateRunRequest", () => {
  it("requires agentId and projectId", () => {
    const req: CreateRunRequest = {
      agentId: "agent_001",
      projectId: "proj_001",
      metadata: { version: "1.0" },
      tags: ["smoke", "test"],
    };
    expect(req.agentId).toBe("agent_001");
    expect(req.tags).toContain("smoke");
  });

  it("allows optional agentVersionId", () => {
    const req: CreateRunRequest = {
      agentId: "agent_001",
      projectId: "proj_001",
      agentVersionId: "v2.1.0",
    };
    expect(req.agentVersionId).toBe("v2.1.0");
  });
});
