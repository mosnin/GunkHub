/**
 * basic_run.ts — Agent Flight Recorder SDK: complete working example
 *
 * Demonstrates how to instrument an agent using the AFR SDK.
 * Run with: npx tsx examples/basic_run.ts
 *
 * Note: In v1 the HttpTransport is a stub — transport calls will throw
 * NotImplementedError until the server-side API is available.
 */

import {
  FlightRecorder,
  llmRequestEvent,
  llmResponseEvent,
  toolCallEvent,
  toolResultEvent,
  toolErrorEvent,
  errorEvent,
  lifecycleEvent,
  retrievalEvent,
  memoryReadEvent,
  memoryWriteEvent,
  customEvent,
  type RunHandle,
} from "@afr/sdk";

// ---------------------------------------------------------------------------
// Configure the recorder
// ---------------------------------------------------------------------------

const recorder = new FlightRecorder({
  endpoint: process.env["AFR_ENDPOINT"] ?? "http://localhost:3000",
  apiKey: process.env["AFR_API_KEY"] ?? "",
  agentId: "agent_research_assistant",
  projectId: "proj_default",
  agentVersionId: "v1.0.0",
  batchSize: 20,
  flushIntervalMs: 1000,
});

// ---------------------------------------------------------------------------
// Simulate agent steps
// ---------------------------------------------------------------------------

async function simulateLLMCall(
  run: RunHandle,
  query: string,
): Promise<string> {
  const startMs = Date.now();

  await run.record(
    llmRequestEvent({
      model: "claude-3-5-sonnet-20241022",
      provider: "anthropic",
      prompt: query,
    }),
  );

  // Simulate network latency
  await new Promise((r) => setTimeout(r, 150));

  const latencyMs = Date.now() - startMs;
  await run.record(
    llmResponseEvent({
      model: "claude-3-5-sonnet-20241022",
      inputTokens: 512,
      outputTokens: 128,
      latencyMs,
      finishReason: "end_turn",
    }),
  );

  return `Answer to: ${query}`;
}

async function simulateWebSearch(
  run: RunHandle,
  query: string,
): Promise<string[]> {
  const toolCallId = `call_${Date.now()}`;
  const startMs = Date.now();

  await run.record(
    toolCallEvent({
      toolName: "web_search",
      toolCallId,
      args: { query, num_results: 5 },
    }),
  );

  // Simulate tool execution
  await new Promise((r) => setTimeout(r, 80));

  const results = [
    "Result 1: Agent Flight Recorder is a structured observability tool...",
    "Result 2: AFR captures LLM requests, tool calls, and memory operations...",
    "Result 3: Use the SDK to instrument your agent code...",
  ];

  await run.record(
    toolResultEvent({
      toolName: "web_search",
      toolCallId,
      latencyMs: Date.now() - startMs,
      result: { results, totalFound: results.length },
    }),
  );

  return results;
}

async function simulateFailingTool(run: RunHandle): Promise<void> {
  const toolCallId = `call_err_${Date.now()}`;

  await run.record(
    toolCallEvent({
      toolName: "fetch_url",
      toolCallId,
      args: { url: "https://example.com/flaky-endpoint" },
    }),
  );

  // Simulate tool failure
  await run.record(
    toolErrorEvent({
      toolName: "fetch_url",
      toolCallId,
      errorMessage: "Connection timeout after 5000ms",
    }),
  );
}

async function simulateRetrieval(run: RunHandle, query: string): Promise<void> {
  await run.record(retrievalEvent("query", { source: "vector_store_main" }));

  await new Promise((r) => setTimeout(r, 30));

  await run.record(
    retrievalEvent("result", {
      source: "vector_store_main",
      resultCount: 4,
      latencyMs: 30,
    }),
  );
}

// ---------------------------------------------------------------------------
// Main agent function
// ---------------------------------------------------------------------------

async function runResearchAgent(query: string): Promise<void> {
  console.log(`Starting research agent for query: "${query}"`);

  const run = await recorder.startRun({
    metadata: {
      query,
      model: "claude-3-5-sonnet-20241022",
      environment: process.env["NODE_ENV"] ?? "development",
    },
    tags: ["research", "production", "v1"],
  });

  try {
    // --- Step 1: Start ---
    await run.record(lifecycleEvent("step_started", { stepName: "plan", stepIndex: 0 }));

    // Read from memory (e.g., agent persona / instructions)
    await run.record(memoryReadEvent({ namespace: "agent_config", keyCount: 3 }));

    // Retrieve relevant context from vector store
    await simulateRetrieval(run, query);

    await run.record(lifecycleEvent("step_completed", { stepName: "plan", stepIndex: 0 }));

    // --- Step 2: Research ---
    await run.record(lifecycleEvent("step_started", { stepName: "research", stepIndex: 1 }));

    const searchResults = await simulateWebSearch(run, query);

    // Try a second tool that fails (non-fatal, agent continues)
    await simulateFailingTool(run);

    // Record a custom event with structured data
    await run.record(
      customEvent("search_summary", {
        query,
        resultCount: searchResults.length,
        sources: ["web_search"],
      }),
    );

    await run.record(lifecycleEvent("step_completed", { stepName: "research", stepIndex: 1 }));

    // --- Step 3: Synthesize ---
    await run.record(lifecycleEvent("step_started", { stepName: "synthesize", stepIndex: 2 }));

    const answer = await simulateLLMCall(run, `Synthesize these results for: ${query}`);

    // Write final answer to memory
    await run.record(
      memoryWriteEvent({ namespace: "agent_outputs", keyCount: 1 }),
    );

    await run.record(lifecycleEvent("step_completed", { stepName: "synthesize", stepIndex: 2 }));

    // --- Complete the run ---
    await run.complete({
      answer,
      stepsCompleted: 3,
      toolCallCount: 2,
    });

    console.log("Run completed successfully");
    console.log(`Answer: ${answer}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await run.record(
      errorEvent({
        errorType: "UnexpectedError",
        message,
        recoverable: false,
      }),
    );

    await run.fail({
      message,
      errorType: "UnexpectedError",
    });

    console.error("Run failed:", message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Run it
// ---------------------------------------------------------------------------

runResearchAgent("What is Agent Flight Recorder?").catch((err) => {
  console.error(
    "Note: In v1, transport calls throw NotImplementedError.",
    "This is expected until the server-side API is implemented.",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
