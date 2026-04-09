export type EventCategory = "lifecycle" | "llm" | "tool" | "memory" | "retrieval" | "error" | "custom";

// Each payload has a category discriminant field

export interface LifecyclePayload {
  readonly category: "lifecycle";
  readonly kind: "run_started" | "run_completed" | "run_failed" | "run_cancelled" | "step_started" | "step_completed" | "step_failed";
  readonly stepName?: string;
  readonly stepIndex?: number;
}

export interface LLMPayload {
  readonly category: "llm";
  readonly kind: "request" | "response" | "stream_start" | "stream_chunk" | "stream_end";
  readonly model?: string;
  readonly provider?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs?: number;
  readonly finishReason?: string;
  readonly contentArtifactId?: string; // externalized if large
}

export interface ToolPayload {
  readonly category: "tool";
  readonly kind: "call" | "result" | "error";
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly latencyMs?: number;
  readonly errorMessage?: string;
  readonly argsArtifactId?: string;
  readonly resultArtifactId?: string;
}

export interface MemoryPayload {
  readonly category: "memory";
  readonly kind: "read" | "write" | "delete" | "clear";
  readonly namespace?: string;
  readonly keyCount?: number;
}

export interface RetrievalPayload {
  readonly category: "retrieval";
  readonly kind: "query" | "result";
  readonly source?: string;
  readonly resultCount?: number;
  readonly latencyMs?: number;
}

export interface ErrorPayload {
  readonly category: "error";
  readonly errorType: string;
  readonly message: string;
  readonly code?: string;
  readonly recoverable: boolean;
  readonly traceArtifactId?: string;
}

export interface CustomPayload {
  readonly category: "custom";
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export type EventPayload =
  | LifecyclePayload
  | LLMPayload
  | ToolPayload
  | MemoryPayload
  | RetrievalPayload
  | ErrorPayload
  | CustomPayload;
