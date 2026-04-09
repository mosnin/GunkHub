/**
 * sdk/smoke.test.ts
 *
 * Smoke tests for @afr/sdk.
 * Uses a mock transport to avoid real HTTP calls.
 * Validates FlightRecorder construction, RunHandle sequencing,
 * event builder shapes, and lifecycle correctness.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import {
  FlightRecorder,
  lifecycleEvent,
  llmRequestEvent,
  llmResponseEvent,
  toolCallEvent,
  toolResultEvent,
  toolErrorEvent,
  errorEvent,
  customEvent,
  memoryReadEvent,
  memoryWriteEvent,
  retrievalEvent,
  type Transport,
  type CreateRunTransportRequest,
  type SendEventsTransportRequest,
  type UpdateRunStatusRequest,
  type FlightRecorderConfig,
} from "@afr/sdk";

// ---------------------------------------------------------------------------
// Mock transport factory
// ---------------------------------------------------------------------------

function makeMockTransport(overrides?: Partial<Transport>): Transport & {
  createRun: MockedFunction<Transport["createRun"]>;
  sendEvents: MockedFunction<Transport["sendEvents"]>;
  updateRunStatus: MockedFunction<Transport["updateRunStatus"]>;
} {
  return {
    createRun: vi.fn<[CreateRunTransportRequest], Promise<{ runId: string }>>()
      .mockResolvedValue({ runId: "run_mock_001" }),
    sendEvents: vi.fn<[SendEventsTransportRequest], Promise<{ accepted: number }>>()
      .mockResolvedValue({ accepted: 1 }),
    updateRunStatus: vi.fn<[UpdateRunStatusRequest], Promise<void>>()
      .mockResolvedValue(undefined),
    ...overrides,
  };
}

const BASE_CONFIG: FlightRecorderConfig = {
  endpoint: "http://localhost:3000",
  apiKey: "test-api-key",
  agentId: "agent_test",
  projectId: "proj_test",
  // Disable auto-flush timer in tests
  flushIntervalMs: 60_000,
  batchSize: 100,
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
};

// ---------------------------------------------------------------------------
// 1. FlightRecorder construction
// ---------------------------------------------------------------------------

describe("FlightRecorder construction", () => {
  it("can be constructed with valid config", () => {
    const recorder = new FlightRecorder(BASE_CONFIG);
    expect(recorder).toBeInstanceOf(FlightRecorder);
  });

  it("can be constructed with minimal config (only required fields)", () => {
    const minimal: FlightRecorderConfig = {
      endpoint: "http://localhost",
      apiKey: "key",
      agentId: "agent_a",
      projectId: "proj_b",
    };
    const recorder = new FlightRecorder(minimal);
    expect(recorder).toBeInstanceOf(FlightRecorder);
  });

  it("applies defaults for optional config fields", async () => {
    // FlightRecorder.withTransport exposes the recorder; we verify defaults via behavior
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(
      {
        endpoint: "http://localhost",
        apiKey: "k",
        agentId: "a",
        projectId: "p",
        // batchSize and flushIntervalMs intentionally omitted
      },
      transport,
    );
    // startRun should work — it uses the configured transport
    const run = await recorder.startRun();
    expect(run.runId).toBe("run_mock_001");
    await run.flush(); // clean up
  });
});

// ---------------------------------------------------------------------------
// 2. FlightRecorder.startRun
// ---------------------------------------------------------------------------

describe("FlightRecorder.startRun", () => {
  it("calls transport.createRun with the correct agentId and projectId", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);

    await recorder.startRun({ tags: ["smoke"], metadata: { test: true } });

    expect(transport.createRun).toHaveBeenCalledOnce();
    const req = transport.createRun.mock.calls[0]?.[0];
    expect(req?.agentId).toBe("agent_test");
    expect(req?.projectId).toBe("proj_test");
    expect(req?.tags).toContain("smoke");
    expect(req?.metadata?.["test"]).toBe(true);
  });

  it("respects agentId/projectId overrides in StartRunInput", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);

    await recorder.startRun({ agentId: "agent_override", projectId: "proj_override" });

    const req = transport.createRun.mock.calls[0]?.[0];
    expect(req?.agentId).toBe("agent_override");
    expect(req?.projectId).toBe("proj_override");
  });

  it("returns a RunHandle with the correct runId, agentId, projectId", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);

    const run = await recorder.startRun();
    expect(run.runId).toBe("run_mock_001");
    expect(run.agentId).toBe("agent_test");
    expect(run.projectId).toBe("proj_test");
  });
});

// ---------------------------------------------------------------------------
// 3. RunHandle.record — event sequencing
// ---------------------------------------------------------------------------

describe("RunHandle event sequencing", () => {
  it("assigns monotonically increasing sequence numbers", async () => {
    const transport = makeMockTransport();
    // Use a small batchSize so sendEvents is called after each event
    const recorder = FlightRecorder.withTransport(
      { ...BASE_CONFIG, batchSize: 1 },
      transport,
    );

    const run = await recorder.startRun();

    await run.record(lifecycleEvent("step_started", { stepName: "a" }));
    await run.record(lifecycleEvent("step_started", { stepName: "b" }));
    await run.record(lifecycleEvent("step_started", { stepName: "c" }));

    // 3 sendEvents calls (batchSize=1)
    expect(transport.sendEvents).toHaveBeenCalledTimes(3);

    const allSeqs = transport.sendEvents.mock.calls.map(
      ([req]) => req.events[0]?.sequence,
    );
    expect(allSeqs).toEqual([1, 2, 3]);
  });

  it("flushes buffer when batchSize is reached", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(
      { ...BASE_CONFIG, batchSize: 2 },
      transport,
    );

    const run = await recorder.startRun();
    transport.sendEvents.mockClear();

    // Record 4 events with batchSize=2 → expect 2 flushes
    await run.recordBatch([
      lifecycleEvent("step_started", { stepName: "s1" }),
      lifecycleEvent("step_started", { stepName: "s2" }),
      lifecycleEvent("step_completed", { stepName: "s1" }),
      lifecycleEvent("step_completed", { stepName: "s2" }),
    ]);

    expect(transport.sendEvents).toHaveBeenCalledTimes(2);
    expect(transport.sendEvents.mock.calls[0]?.[0].events).toHaveLength(2);
    expect(transport.sendEvents.mock.calls[1]?.[0].events).toHaveLength(2);
  });

  it("includes the runId in all sendEvents calls", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(
      { ...BASE_CONFIG, batchSize: 1 },
      transport,
    );

    const run = await recorder.startRun();
    await run.record(llmRequestEvent({ model: "gpt-4" }));

    const req = transport.sendEvents.mock.calls[0]?.[0];
    expect(req?.runId).toBe("run_mock_001");
  });
});

// ---------------------------------------------------------------------------
// 4. RunHandle lifecycle — complete, fail, cancel
// ---------------------------------------------------------------------------

describe("RunHandle lifecycle", () => {
  it("complete() flushes buffered events and calls updateRunStatus with 'completed'", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);

    const run = await recorder.startRun();
    await run.record(llmRequestEvent({ model: "gpt-4" }));
    await run.complete({ result: "ok" });

    // Should have flushed events
    expect(transport.sendEvents).toHaveBeenCalled();

    const statusCall = transport.updateRunStatus.mock.calls[0]?.[0];
    expect(statusCall?.runId).toBe("run_mock_001");
    expect(statusCall?.status).toBe("completed");
    expect(statusCall?.completedAt).toBeGreaterThan(0);
  });

  it("fail() calls updateRunStatus with 'failed' and error details", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);

    const run = await recorder.startRun();
    await run.fail({ message: "Something broke", code: "ERR_001", errorType: "RuntimeError" });

    const statusCall = transport.updateRunStatus.mock.calls[0]?.[0];
    expect(statusCall?.status).toBe("failed");
    expect(statusCall?.errorMessage).toBe("Something broke");
    expect(statusCall?.errorCode).toBe("ERR_001");
  });

  it("cancel() calls updateRunStatus with 'cancelled'", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);

    const run = await recorder.startRun();
    await run.cancel("user requested cancellation");

    const statusCall = transport.updateRunStatus.mock.calls[0]?.[0];
    expect(statusCall?.status).toBe("cancelled");
  });

  it("flush() sends buffered events without ending the run", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);

    const run = await recorder.startRun();
    await run.record(llmResponseEvent({ outputTokens: 50 }));

    // No sendEvents yet (buffer not full, no auto-flush)
    expect(transport.sendEvents).not.toHaveBeenCalled();

    await run.flush();

    // Now events should have been sent
    expect(transport.sendEvents).toHaveBeenCalledOnce();
    expect(transport.updateRunStatus).not.toHaveBeenCalled(); // run still active
  });

  it("ignores record() calls after the run has ended", async () => {
    const transport = makeMockTransport();
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);

    const run = await recorder.startRun();
    await run.complete();

    // Reset call counts
    transport.sendEvents.mockClear();

    // This should be silently ignored
    await run.record(llmRequestEvent({ model: "gpt-4" }));

    expect(transport.sendEvents).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Event builder shapes
// ---------------------------------------------------------------------------

describe("Event builders — shape validation", () => {
  it("lifecycleEvent produces correct type and category", () => {
    const evt = lifecycleEvent("step_started", { stepName: "plan", stepIndex: 0 });
    expect(evt.type).toBe("lifecycle.step_started");
    expect(evt.category).toBe("lifecycle");
    expect((evt.payload as { kind: string }).kind).toBe("step_started");
    expect((evt.payload as { stepName: string }).stepName).toBe("plan");
  });

  it("llmRequestEvent produces correct shape", () => {
    const evt = llmRequestEvent({ model: "claude-3-5-sonnet", provider: "anthropic", prompt: "hello" });
    expect(evt.type).toBe("llm.request");
    expect(evt.category).toBe("llm");
    const payload = evt.payload as { kind: string; model: string; provider: string };
    expect(payload.kind).toBe("request");
    expect(payload.model).toBe("claude-3-5-sonnet");
    expect(payload.provider).toBe("anthropic");
  });

  it("llmResponseEvent produces correct shape", () => {
    const evt = llmResponseEvent({ inputTokens: 100, outputTokens: 50, latencyMs: 300, finishReason: "stop" });
    expect(evt.type).toBe("llm.response");
    const payload = evt.payload as { kind: string; inputTokens: number; outputTokens: number };
    expect(payload.kind).toBe("response");
    expect(payload.inputTokens).toBe(100);
    expect(payload.outputTokens).toBe(50);
  });

  it("toolCallEvent includes toolName and optional args", () => {
    const evt = toolCallEvent({ toolName: "web_search", toolCallId: "tc_1", args: { query: "test" } });
    expect(evt.type).toBe("tool.call");
    expect(evt.category).toBe("tool");
    const payload = evt.payload as { toolName: string; toolCallId: string; kind: string };
    expect(payload.toolName).toBe("web_search");
    expect(payload.toolCallId).toBe("tc_1");
    expect(payload.kind).toBe("call");
  });

  it("toolResultEvent includes toolName and optional result", () => {
    const evt = toolResultEvent({ toolName: "calculator", latencyMs: 5, result: 42 });
    expect(evt.type).toBe("tool.result");
    const payload = evt.payload as { toolName: string; kind: string; latencyMs: number };
    expect(payload.kind).toBe("result");
    expect(payload.toolName).toBe("calculator");
    expect(payload.latencyMs).toBe(5);
  });

  it("toolErrorEvent includes errorMessage", () => {
    const evt = toolErrorEvent({ toolName: "fetch_url", errorMessage: "Timeout" });
    expect(evt.type).toBe("tool.error");
    const payload = evt.payload as { kind: string; errorMessage: string };
    expect(payload.kind).toBe("error");
    expect(payload.errorMessage).toBe("Timeout");
  });

  it("errorEvent produces correct shape with recoverable defaulting to false", () => {
    const evt = errorEvent({ errorType: "NetworkError", message: "Connection refused" });
    expect(evt.type).toBe("error");
    expect(evt.category).toBe("error");
    const payload = evt.payload as { errorType: string; message: string; recoverable: boolean };
    expect(payload.errorType).toBe("NetworkError");
    expect(payload.recoverable).toBe(false);

    const recoverableEvt = errorEvent({ errorType: "RateLimitError", message: "429", recoverable: true });
    const recPayload = recoverableEvt.payload as { recoverable: boolean };
    expect(recPayload.recoverable).toBe(true);
  });

  it("customEvent prefixes type with 'custom.'", () => {
    const evt = customEvent("agent_decision", { choice: "tool_call", confidence: 0.9 });
    expect(evt.type).toBe("custom.agent_decision");
    expect(evt.category).toBe("custom");
    const payload = evt.payload as { type: string; data: { choice: string } };
    expect(payload.type).toBe("agent_decision");
    expect(payload.data.choice).toBe("tool_call");
  });

  it("memoryReadEvent and memoryWriteEvent have correct kind", () => {
    const readEvt = memoryReadEvent({ namespace: "ctx", keyCount: 3 });
    expect(readEvt.type).toBe("memory.read");
    expect((readEvt.payload as { kind: string }).kind).toBe("read");

    const writeEvt = memoryWriteEvent({ namespace: "ctx", keyCount: 1 });
    expect(writeEvt.type).toBe("memory.write");
    expect((writeEvt.payload as { kind: string }).kind).toBe("write");
  });

  it("retrievalEvent supports query and result kinds", () => {
    const queryEvt = retrievalEvent("query", { source: "pinecone" });
    expect(queryEvt.type).toBe("retrieval.query");
    expect((queryEvt.payload as { kind: string }).kind).toBe("query");

    const resultEvt = retrievalEvent("result", { source: "pinecone", resultCount: 5, latencyMs: 20 });
    expect(resultEvt.type).toBe("retrieval.result");
    const payload = resultEvt.payload as { resultCount: number; latencyMs: number };
    expect(payload.resultCount).toBe(5);
    expect(payload.latencyMs).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// 6. Transport error resilience
// ---------------------------------------------------------------------------

describe("Transport error handling", () => {
  it("flush() propagates transport errors", async () => {
    const transport = makeMockTransport({
      sendEvents: vi.fn().mockRejectedValue(new Error("Network error")),
    });
    const recorder = FlightRecorder.withTransport(BASE_CONFIG, transport);
    const run = await recorder.startRun();

    await run.record(llmRequestEvent({ model: "gpt-4" }));

    await expect(run.flush()).rejects.toThrow("Network error");
  });
});
