/** All possible event type string literals */
export type EventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "llm.request"
  | "llm.response"
  | "llm.error"
  | "tool.call"
  | "tool.result"
  | "tool.error"
  | "memory.read"
  | "memory.write"
  | "retrieval.query"
  | "retrieval.result"
  | "http.request"
  | "http.response"
  | "custom";

export interface ErrorPayload {
  message: string;
  code?: string;
  stack?: string;
  context?: unknown;
}

// ---------------------------------------------------------------------------
// Per-type payload shapes
// ---------------------------------------------------------------------------

export interface RunStartedPayload {
  type: "run.started";
  input: unknown;
  config: Record<string, unknown>;
}

export interface RunCompletedPayload {
  type: "run.completed";
  output: unknown;
  duration_ms: number;
}

export interface RunFailedPayload {
  type: "run.failed";
  error: ErrorPayload;
  duration_ms: number;
}

export interface RunCancelledPayload {
  type: "run.cancelled";
}

export interface LlmRequestPayload {
  type: "llm.request";
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  temperature?: number;
  max_tokens?: number;
}

export interface LlmResponsePayload {
  type: "llm.response";
  model: string;
  content: unknown;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  finish_reason: string;
}

export interface LlmErrorPayload {
  type: "llm.error";
  error: ErrorPayload;
}

export interface ToolCallPayload {
  type: "tool.call";
  name: string;
  input: unknown;
  call_id: string;
}

export interface ToolResultPayload {
  type: "tool.result";
  call_id: string;
  output: unknown;
  duration_ms: number;
}

export interface ToolErrorPayload {
  type: "tool.error";
  error: ErrorPayload;
  call_id?: string;
}

export interface MemoryReadPayload {
  type: "memory.read";
  key?: string;
  result?: unknown;
}

export interface MemoryWritePayload {
  type: "memory.write";
  key?: string;
  value?: unknown;
}

export interface RetrievalQueryPayload {
  type: "retrieval.query";
  query: string;
  filters?: Record<string, unknown>;
}

export interface RetrievalResultPayload {
  type: "retrieval.result";
  results: unknown[];
  duration_ms?: number;
}

export interface HttpRequestPayload {
  type: "http.request";
  method: string;
  /** URL must never include credentials */
  url: string;
  headers_redacted: string[];
  body_size?: number;
}

export interface HttpResponsePayload {
  type: "http.response";
  status: number;
  headers_redacted: string[];
  body_size?: number;
  duration_ms: number;
}

export interface CustomPayload {
  type: "custom";
  data: unknown;
}

/**
 * ExternalizedPayload — stored in place of an oversized inline payload.
 *
 * When the SDK detects that an event payload serializes to more than
 * PAYLOAD_EXTERNALIZATION_THRESHOLD bytes, it uploads the full payload
 * as an artifact and replaces the inline payload with this pointer shape.
 *
 * The event record's `type` field is unchanged (still "llm.request", etc.).
 * The original event type is preserved in `originalType` for UI rendering.
 */
export interface ExternalizedPayload {
  type: "_externalized";
  /** The event type of the original oversized payload (e.g. "llm.request"). */
  originalType: EventType;
  _artifact: {
    artifactId: string;
    storageKey: string;
    storageBucket: string;
    checksum: string;
    size: number;
  };
}

// ---------------------------------------------------------------------------
// Discriminated union of all payload types
// ---------------------------------------------------------------------------

export type EventPayload =
  | RunStartedPayload
  | RunCompletedPayload
  | RunFailedPayload
  | RunCancelledPayload
  | LlmRequestPayload
  | LlmResponsePayload
  | LlmErrorPayload
  | ToolCallPayload
  | ToolResultPayload
  | ToolErrorPayload
  | MemoryReadPayload
  | MemoryWritePayload
  | RetrievalQueryPayload
  | RetrievalResultPayload
  | HttpRequestPayload
  | HttpResponsePayload
  | CustomPayload
  | ExternalizedPayload;
