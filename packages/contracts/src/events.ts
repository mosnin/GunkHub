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
  | "custom"
  /**
   * An ingested OpenTelemetry span that matched NO mapping rule.
   *
   * Recorded rather than dropped — see {@link OtelSpanUnmappedPayload}. This
   * is the only event type no first-party SDK emits; it exists solely on the
   * OTel ingest path and always carries `provenance.source === "otel"`.
   */
  | "otel.span.unmapped";

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
  /**
   * Redacted, size-capped (<=512 char) plain-text summary of the failure,
   * attached by the SDK as a sibling of `error` so the backend can index
   * error text into `runs.searchText` WITHOUT parsing/trusting the full
   * `error` object shape (which is user/agent-controlled and may be large
   * or arbitrarily nested). See ExternalizedPayload.errorSummary for the
   * externalized-envelope counterpart — a run.failed payload can carry this
   * field on either shape depending on whether it was large enough to
   * externalize.
   */
  errorSummary?: string;
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

// ---------------------------------------------------------------------------
// Unmapped OTel spans
// ---------------------------------------------------------------------------

/** OTel `SpanKind`, lowercased. `unspecified` covers a missing/unknown kind. */
export type OtelSpanKind =
  | "unspecified"
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

/**
 * Why a span produced no typed event.
 *
 * CLOSED union: "we didn't map it" is not an answer an engineer can act on.
 * Each member points at a different fix — write a rule, implement a convention
 * version, disambiguate two rules, or go fix the emitting instrumentation.
 */
export type OtelUnmappedReason =
  /** No mapping rule matched this span's name/attributes. */
  | "no-matching-rule"
  /** The span declared a semantic-convention version the mapper does not implement. */
  | "unsupported-semconv-version"
  /** More than one rule matched. The mapper refuses to guess rather than pick one. */
  | "ambiguous-match"
  /** A rule matched but the attributes it requires were absent from the span. */
  | "missing-required-attributes";

/**
 * A span that mapped to no event type, recorded AS an unmapped span.
 *
 * Dropping it would be the same failure this whole provenance design exists to
 * prevent, one level up: a trace with a silent hole reads, to a debugging
 * engineer, exactly like a trace where nothing happened. Recording it keeps
 * the gap visible, keeps it in `sequenceNumber` order next to its siblings,
 * and makes it appear in replay, export and the timeline for free — without a
 * side table nobody thinks to open.
 *
 * The span's identity (trace id, span id, parent, scope, convention version)
 * is NOT duplicated here: it lives in the event's `provenance`, which is the
 * single place any derived event carries it.
 */
export interface OtelSpanUnmappedPayload {
  type: "otel.span.unmapped";
  /** The raw span name, verbatim. */
  spanName: string;
  spanKind: OtelSpanKind;
  reason: OtelUnmappedReason;
  /**
   * The span's attributes, preserved so the span is recorded rather than
   * merely counted. Bounded at ingest — see `attributesTruncated`. Values are
   * `unknown` because OTel attribute values are a union of scalars and
   * homogeneous arrays and this layer does not narrow them.
   */
  attributes: Record<string, unknown>;
  /** True when `attributes` was capped at ingest and is an incomplete view. */
  attributesTruncated: boolean;
  /** OTel span status, when the span carried one. */
  status?: {
    code: "unset" | "ok" | "error";
    message?: string;
  };
  /** Span end minus span start, when both were present. */
  durationMs?: number;
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
  /**
   * Redacted, size-capped (<=512 char) plain-text summary of the failure,
   * set by the SDK ONLY when `originalType` is "run.failed" and the full
   * failure payload was large enough to externalize. This is the field that
   * makes an externalized run.failed searchable at all: the full `error`
   * object lives in the artifact (not read at ingest time), so without this
   * sibling summary the backend would have no error text to fold into
   * `runs.searchText`. See RunFailedPayload.errorSummary for the inline
   * (non-externalized) counterpart.
   */
  errorSummary?: string;
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
  | OtelSpanUnmappedPayload
  | ExternalizedPayload;
