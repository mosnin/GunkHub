import type { EventType, EventPayload, CreateEventRequest } from '@agent-flight-recorder/contracts'

// Helper to build a CreateEventRequest with defaults filled
export function buildEvent(
  runId: string,
  orgId: string,
  type: EventType,
  payload: EventPayload,
  sequenceNumber: number,
  options?: { parentEventId?: string; timestamp?: number }
): CreateEventRequest {
  return {
    runId,
    type,
    sequenceNumber,
    timestamp: options?.timestamp ?? Date.now(),
    payload,
    // exactOptionalPropertyTypes: conditionally include optional field
    ...(options?.parentEventId !== undefined && { parentEventId: options.parentEventId }),
  }
}

// Typed event builders for common event types
export const Events = {
  runStarted(runId: string, input: unknown, config: Record<string, unknown>) {
    return { type: 'run.started' as const, payload: { type: 'run.started' as const, input, config } }
  },
  runCompleted(runId: string, output: unknown, duration_ms: number) {
    return { type: 'run.completed' as const, payload: { type: 'run.completed' as const, output, duration_ms } }
  },
  runFailed(runId: string, error: { message: string; code?: string; stack?: string }, duration_ms: number) {
    return { type: 'run.failed' as const, payload: { type: 'run.failed' as const, error, duration_ms } }
  },
  llmRequest(model: string, messages: Array<{ role: string; content: string }>, options?: { temperature?: number; max_tokens?: number }) {
    return {
      type: 'llm.request' as const,
      payload: { type: 'llm.request' as const, model, messages, ...options },
    }
  },
  llmResponse(model: string, content: string, usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }, finish_reason: string) {
    return { type: 'llm.response' as const, payload: { type: 'llm.response' as const, model, content, usage, finish_reason } }
  },
  toolCall(name: string, input: unknown, call_id: string) {
    return { type: 'tool.call' as const, payload: { type: 'tool.call' as const, name, input, call_id } }
  },
  toolResult(call_id: string, output: unknown, duration_ms: number) {
    return { type: 'tool.result' as const, payload: { type: 'tool.result' as const, call_id, output, duration_ms } }
  },
  httpRequest(method: string, url: string, headers_redacted: string[], body_size?: number) {
    return { type: 'http.request' as const, payload: { type: 'http.request' as const, method, url, headers_redacted, body_size } }
  },
  httpResponse(status: number, headers_redacted: string[], body_size?: number, duration_ms?: number) {
    return { type: 'http.response' as const, payload: { type: 'http.response' as const, status, headers_redacted, body_size, duration_ms: duration_ms ?? 0 } }
  },
  custom(data: unknown) {
    return { type: 'custom' as const, payload: { type: 'custom' as const, data } }
  },
} as const
