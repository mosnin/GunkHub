// Typed error helper for Convex functions.
//
// Convex serializes thrown Errors to strings client-side, so a structured
// `CODE: message` prefix is the most portable way to give API routes and the UI
// a machine-readable error code without a custom error transport. New error
// paths (authorization gates, write ceilings, purge) use afrError; existing
// throws are left as-is.
//
// TODO: migrate legacy `throw new Error(...)` sites in events.ts / runs.ts /
// sdk_ingest.ts to afrError codes in a follow-up pass (kept out of this change
// to avoid churning every existing test's message assertions at once).

/**
 * Closed set of machine-readable error codes.
 *
 * The API-facing subset (RUN_NOT_ACTIVE, SEQUENCE_CONFLICT, EVENT_LIMIT_EXCEEDED,
 * ARTIFACT_LIMIT_EXCEEDED, RATE_LIMITED, COMMENT_LIMIT_EXCEEDED) is mirrored in
 * packages/contracts/src/api_errors.ts (AFR_API_ERROR_CODES) — the web layer maps
 * them to 4xx statuses and the SDK treats them as non-retryable. These code
 * strings are a cross-boundary contract: NEVER rename an existing code.
 */
export type AfrErrorCode =
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "RUN_NOT_ACTIVE"
  | "SEQUENCE_CONFLICT"
  | "EVENT_LIMIT_EXCEEDED"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "COMMENT_LIMIT_EXCEEDED"
  | "INVALID_ARGUMENT"
  | "PURGE_FAILED"
  // --- ADR-007 (OTel span ingestion). All four are REJECTIONS, never partial
  // acceptances: an OTLP exporter that receives success drops the batch, so a
  // half-recorded batch is a permanently incomplete run that nothing knows is
  // incomplete. Mirrored in packages/contracts/src/api_errors.ts.
  /** OTLP batch exceeded MAX_OTEL_SPANS_PER_BATCH. Rejected whole, not truncated. */
  | "BATCH_TOO_LARGE"
  /** A derived payload exceeded the 10 KB inline limit (Event Log Rule 3). */
  | "PAYLOAD_TOO_LARGE"
  /** The span->event mapper returned a fatal diagnostic; nothing was written. */
  | "OTEL_MAPPING_FAILED"
  /** Trace's earliest span predates the stale-run ceiling; see convex/otel_ingest.ts. */
  | "OTEL_TRACE_TOO_OLD";

/**
 * Build an Error whose message is prefixed with a stable machine-readable code:
 * `"EVENT_LIMIT_EXCEEDED: ..."`. Callers (API routes, UI) can parse the code
 * with `message.split(":", 1)[0]`.
 */
export function afrError(code: AfrErrorCode, message: string): Error {
  return new Error(`${code}: ${message}`);
}
