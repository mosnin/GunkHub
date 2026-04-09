import type { RecordEventInput } from "./types.js";
import type {
  LLMPayload,
  ToolPayload,
  MemoryPayload,
  RetrievalPayload,
  ErrorPayload,
  LifecyclePayload,
  CustomPayload,
} from "@afr/contracts";

/** Builder for lifecycle events */
export function lifecycleEvent(
  kind: LifecyclePayload["kind"],
  opts?: { stepName?: string; stepIndex?: number },
): RecordEventInput {
  const payload: LifecyclePayload = {
    category: "lifecycle",
    kind,
    ...opts,
  };
  return {
    type: `lifecycle.${kind}`,
    category: "lifecycle",
    payload,
  };
}

/** Builder for LLM request events */
export function llmRequestEvent(opts: {
  model?: string;
  provider?: string;
  prompt?: string; // stored in payload for reference; large prompts externalized by server
}): RecordEventInput {
  const { prompt: _prompt, ...rest } = opts;
  const payload: LLMPayload & { prompt?: string } = {
    category: "llm",
    kind: "request",
    ...rest,
    // Include truncated prompt hint if provided — server handles externalization
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  };
  return {
    type: "llm.request",
    category: "llm",
    payload,
  };
}

/** Builder for LLM response events */
export function llmResponseEvent(opts: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  finishReason?: string;
}): RecordEventInput {
  const payload: LLMPayload = {
    category: "llm",
    kind: "response",
    ...opts,
  };
  return {
    type: "llm.response",
    category: "llm",
    payload,
  };
}

/** Builder for tool call events */
export function toolCallEvent(opts: {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
}): RecordEventInput {
  const { args: _args, toolName, toolCallId } = opts;
  const payload: ToolPayload & { args?: unknown } = {
    category: "tool",
    kind: "call",
    toolName,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    // args included directly in payload; large args externalized by server
    ...(_args !== undefined ? { args: _args } : {}),
  };
  return {
    type: "tool.call",
    category: "tool",
    payload,
  };
}

/** Builder for tool result events */
export function toolResultEvent(opts: {
  toolName: string;
  toolCallId?: string;
  latencyMs?: number;
  result?: unknown;
}): RecordEventInput {
  const { result: _result, toolName, toolCallId, latencyMs } = opts;
  const payload: ToolPayload & { result?: unknown } = {
    category: "tool",
    kind: "result",
    toolName,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(_result !== undefined ? { result: _result } : {}),
  };
  return {
    type: "tool.result",
    category: "tool",
    payload,
  };
}

/** Builder for tool error events */
export function toolErrorEvent(opts: {
  toolName: string;
  toolCallId?: string;
  errorMessage: string;
}): RecordEventInput {
  const payload: ToolPayload = {
    category: "tool",
    kind: "error",
    toolName: opts.toolName,
    ...(opts.toolCallId !== undefined ? { toolCallId: opts.toolCallId } : {}),
    errorMessage: opts.errorMessage,
  };
  return {
    type: "tool.error",
    category: "tool",
    payload,
  };
}

/** Builder for error events */
export function errorEvent(opts: {
  errorType: string;
  message: string;
  code?: string;
  recoverable?: boolean;
}): RecordEventInput {
  const payload: ErrorPayload = {
    category: "error",
    errorType: opts.errorType,
    message: opts.message,
    recoverable: opts.recoverable ?? false,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
  };
  return {
    type: "error",
    category: "error",
    payload,
  };
}

/** Builder for custom events */
export function customEvent(
  type: string,
  data: Record<string, unknown>,
): RecordEventInput {
  const payload: CustomPayload = {
    category: "custom",
    type,
    data,
  };
  return {
    type: `custom.${type}`,
    category: "custom",
    payload,
  };
}

/** Builder for memory read events */
export function memoryReadEvent(opts?: {
  namespace?: string;
  keyCount?: number;
}): RecordEventInput {
  const payload: MemoryPayload = {
    category: "memory",
    kind: "read",
    ...opts,
  };
  return {
    type: "memory.read",
    category: "memory",
    payload,
  };
}

/** Builder for memory write events */
export function memoryWriteEvent(opts?: {
  namespace?: string;
  keyCount?: number;
}): RecordEventInput {
  const payload: MemoryPayload = {
    category: "memory",
    kind: "write",
    ...opts,
  };
  return {
    type: "memory.write",
    category: "memory",
    payload,
  };
}

/** Builder for retrieval events */
export function retrievalEvent(
  kind: "query" | "result",
  opts?: {
    source?: string;
    resultCount?: number;
    latencyMs?: number;
  },
): RecordEventInput {
  const payload: RetrievalPayload = {
    category: "retrieval",
    kind,
    ...opts,
  };
  return {
    type: `retrieval.${kind}`,
    category: "retrieval",
    payload,
  };
}
