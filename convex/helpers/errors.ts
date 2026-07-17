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

/** Closed set of machine-readable error codes. */
export type AfrErrorCode =
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "EVENT_LIMIT_EXCEEDED"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "INVALID_ARGUMENT"
  | "PURGE_FAILED";

/**
 * Build an Error whose message is prefixed with a stable machine-readable code:
 * `"EVENT_LIMIT_EXCEEDED: ..."`. Callers (API routes, UI) can parse the code
 * with `message.split(":", 1)[0]`.
 */
export function afrError(code: AfrErrorCode, message: string): Error {
  return new Error(`${code}: ${message}`);
}
