/**
 * Inline error-summary helper (M4).
 *
 * BUG THIS FIXES: when a `run.failed` payload's serialized size exceeds the
 * 10 KB externalization threshold (see `externalize.ts`) — which is exactly
 * what happens for the big-stack-trace failures most worth searching — the
 * whole payload is replaced with an artifact pointer BEFORE it reaches the
 * server. The server's `extractErrorMessage` (convex/helpers/run_fields.ts)
 * only looks at `payload.message` / `payload.error.message`, neither of which
 * exists on an externalized pointer payload, so the failed run's error text
 * never makes it into `runs.searchText`.
 *
 * FIX: compute a SHORT, bounded summary (message + top stack frame) up front
 * and carry it as a stable `errorSummary` string field on the `run.failed`
 * event payload. It is included as an ordinary payload field, so it:
 *   - flows through the existing redaction pipeline like any other string
 *     leaf (redaction always runs before externalization measures size —
 *     see recorder.ts / flight-recorder.ts), and
 *   - is carved out and copied onto the externalized-payload envelope by
 *     `externalizePayloadIfLarge` (see externalize.ts) so it survives even
 *     when the rest of the payload gets replaced with an artifact pointer.
 *
 * SERVER-SIDE WIRING NEEDED (not part of this package — flagged for the data
 * team): `extractErrorMessage` in `convex/helpers/run_fields.ts` should prefer
 * `payload.errorSummary` (a plain string, present on both the inline and the
 * `_externalized` envelope shapes) before falling back to its existing
 * `message` / `errorMessage` / `error.message` checks.
 */

/** Upper bound (characters) on a built error summary. */
export const ERROR_SUMMARY_MAX_LENGTH = 512

/** Minimal shape `buildErrorSummary` needs — a subset of `Error`. */
export interface ErrorSummaryInput {
  message: string
  stack?: string
}

/**
 * Build a short, searchable error summary: the error message plus the first
 * real stack frame (the first `stack` line starting with `at `, which skips
 * the redundant "ErrorName: message" header V8 stacks normally start with),
 * truncated to {@link ERROR_SUMMARY_MAX_LENGTH} characters.
 *
 * Never throws — a missing/empty `message` or `stack` degrades gracefully to
 * a shorter (or empty) string rather than erroring.
 *
 * @param error - `{ message, stack? }` — accepts a real `Error` or a plain object.
 * @returns the bounded summary string.
 */
export function buildErrorSummary(error: ErrorSummaryInput): string {
  const message = (error.message ?? '').trim()

  let topFrame = ''
  if (error.stack) {
    for (const rawLine of error.stack.split('\n')) {
      const line = rawLine.trim()
      if (line.startsWith('at ')) {
        topFrame = line
        break
      }
    }
  }

  const combined = topFrame ? `${message} | ${topFrame}` : message
  return combined.length > ERROR_SUMMARY_MAX_LENGTH
    ? combined.slice(0, ERROR_SUMMARY_MAX_LENGTH)
    : combined
}
