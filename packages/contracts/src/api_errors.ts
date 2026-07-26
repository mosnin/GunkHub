// Stable machine-readable API error codes emitted by the Convex backend.
//
// The backend throws Errors whose message is prefixed `"CODE: human text"`
// (see convex/helpers/errors.ts afrError). These are the codes that cross the
// system boundary: the web/API layer maps them to 4xx HTTP statuses, and the
// SDK treats them as NON-RETRYABLE (retrying a SEQUENCE_CONFLICT or
// RUN_NOT_ACTIVE can never succeed).
//
// CONTRACT: codes are append-only. Never rename or remove an existing code —
// deployed SDKs match on the exact string.

export const AFR_API_ERROR_CODES = [
  /** Event append attempted on a run in a terminal/cancelled state. */
  "RUN_NOT_ACTIVE",
  /** Duplicate or non-contiguous sequenceNumber (Event Log Rule 4/5). */
  "SEQUENCE_CONFLICT",
  /** Run has reached the maximum number of events. */
  "EVENT_LIMIT_EXCEEDED",
  /** Run has reached the maximum number of artifacts. */
  "ARTIFACT_LIMIT_EXCEEDED",
  /** Per-API-key ingest rate limit exceeded (fixed one-minute window). */
  "RATE_LIMITED",
  /** Target run/event has reached the maximum number of comments. */
  "COMMENT_LIMIT_EXCEEDED",
  // --- ADR-007 (OpenTelemetry span ingestion) ------------------------------
  // All four are WHOLE-BATCH rejections. An OTLP exporter that receives a
  // success response drops the batch, so a partial acceptance would produce a
  // permanently incomplete run that nothing in the system knows is
  // incomplete. Appended, never inserted — deployed clients match exact
  // strings and the array order is part of nothing, but the append-only rule
  // above still governs.
  /** OTLP batch exceeded the per-call span ceiling. Resend in smaller batches. */
  "BATCH_TOO_LARGE",
  /**
   * A span-derived payload exceeded the 10 KB inline limit (Event Log Rule 3).
   * NON-RETRYABLE as sent: the transport must externalize the span's Opt-In
   * content attributes to blob storage first. The Convex mutation has no blob
   * access and will not truncate, because a truncated payload is a falsified
   * record of what the model was actually sent.
   */
  "PAYLOAD_TOO_LARGE",
  /**
   * The span->event mapper returned a fatal diagnostic (a span it accepted
   * produced no event). NON-RETRYABLE: the same spans will fail identically.
   */
  "OTEL_MAPPING_FAILED",
  /**
   * The trace's earliest span predates the stale-run ceiling, so a run created
   * for it would be expired by the stale sweep before the trace finished
   * arriving. Rejected at the door rather than accepted into a doomed run.
   */
  "OTEL_TRACE_TOO_OLD",
] as const;

export type AfrApiErrorCode = (typeof AFR_API_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(AFR_API_ERROR_CODES);

/**
 * Parse the stable error code out of a backend error message of the form
 * `"CODE: human text"`. Returns undefined when the message carries no known code.
 */
export function parseAfrApiErrorCode(message: string): AfrApiErrorCode | undefined {
  const idx = message.indexOf(":");
  if (idx <= 0) return undefined;
  // Convex prefixes server errors (e.g. "Uncaught Error: CODE: ..."), so scan
  // each colon-delimited token rather than only the first.
  for (const token of message.split(":")) {
    const candidate = token.trim();
    if (CODE_SET.has(candidate)) return candidate as AfrApiErrorCode;
  }
  return undefined;
}
