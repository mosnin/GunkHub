/**
 * Mapping from the SDK's v1 read-API failures onto MCP protocol errors.
 *
 * TWO RULES GOVERN THIS FILE.
 *
 * 1. NO EXISTENCE ORACLE. A `not_found` from the v1 API means one of three
 *    indistinguishable things: the id never existed, it exists in a different
 *    organization, or it was purged under a retention policy. The upstream
 *    layers are already careful about this (`convex/read_api.ts` throws one
 *    message for both the missing and the cross-org case). We do not undo that
 *    work by forwarding server-supplied text, which could drift into something
 *    distinguishing later. Every `not_found` is rewritten here to a FIXED
 *    sentence chosen by the resource kind and nothing else — the same string,
 *    byte for byte, for a typo'd id and for another org's real id.
 *
 * 2. NO RAW ERRORS ESCAPE. Every tool handler funnels through
 *    {@link toMcpError}, so a caller always gets an `McpError` with a code it
 *    can branch on, never a stray `TypeError` or a stack trace.
 */
import { V1ApiError } from '@agent-flight-recorder/sdk'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

/**
 * The kind of thing a lookup was for. Selects the fixed `not_found` sentence,
 * and is the ONLY input to that choice — never the id, never the server's
 * message.
 */
export type ResourceKind = 'run' | 'pattern'

const NOT_FOUND_MESSAGE: Record<ResourceKind, string> = {
  // Deliberately identical in shape and deliberately vague about cause. Do not
  // add the id, the org, or any server-supplied detail to these strings.
  run: 'No run is readable with that id for this API key.',
  pattern: 'No failure pattern is readable with that fingerprint hash for this API key.',
}

/**
 * Convert any thrown value from a `FlightReader` call into an `McpError`.
 *
 * Code mapping:
 * - `auth`             -> `InvalidRequest` — the key is missing, wrong, or lacks the `read` scope. Not retryable.
 * - `not_found`        -> `InvalidParams`  — with the fixed sentence above. Not retryable.
 * - `rate_limited`     -> `InternalError`  — transient; the retry hint is appended when the server sent one.
 * - `server`/`network` -> `InternalError`  — transient.
 * - `invalid_response` -> `InternalError`  — the deployment returned something we cannot parse.
 * - anything else      -> `InternalError`  — with the message only, never a stack.
 *
 * @param err - the thrown value.
 * @param kind - which resource the call was about, selecting the `not_found` sentence.
 */
export function toMcpError(err: unknown, kind: ResourceKind): McpError {
  if (err instanceof McpError) return err

  if (err instanceof V1ApiError) {
    switch (err.kind) {
      case 'not_found':
        // Fixed string. The server's own message is discarded on purpose.
        return new McpError(ErrorCode.InvalidParams, NOT_FOUND_MESSAGE[kind])
      case 'auth':
        return new McpError(
          ErrorCode.InvalidRequest,
          'Agent Flight Recorder rejected the API key. AFR_API_KEY must be valid and carry the `read` scope.',
        )
      case 'rate_limited': {
        const hint =
          err.retryAfterSeconds !== undefined ? ` Retry after ${String(err.retryAfterSeconds)}s.` : ''
        return new McpError(ErrorCode.InternalError, `Rate limited by the Agent Flight Recorder API.${hint}`)
      }
      case 'network':
        return new McpError(
          ErrorCode.InternalError,
          `Could not reach the Agent Flight Recorder API at AFR_BASE_URL: ${err.message}`,
        )
      case 'invalid_response':
        return new McpError(ErrorCode.InternalError, `Unreadable response from the Agent Flight Recorder API: ${err.message}`)
      case 'server':
      default:
        return new McpError(ErrorCode.InternalError, `Agent Flight Recorder API error: ${err.message}`)
    }
  }

  return new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err))
}
