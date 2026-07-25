// ---------------------------------------------------------------------------
// OTLP/HTTP response construction.
//
// This is the part of an OTLP receiver that is most often wrong, and being
// wrong here is not cosmetic — the status code IS the exporter's control
// signal. Get it wrong and you either lose data silently or get retried
// forever by a client that thinks you are down.
//
// THE RULES, from the OTLP/HTTP spec's "Failures" and "Partial Success"
// sections, and what each one costs if broken:
//
//  * FULL SUCCESS → 200 with an ExportTraceServiceResponse whose
//    `partial_success` is UNSET. Not 201, not 204. A 204 has no body, and the
//    spec requires a body.
//
//  * PARTIAL SUCCESS → **200**, with `partial_success.rejected_spans` and a
//    human-readable `partial_success.error_message`. NOT a 4xx.
//    This is the one people get wrong. Returning an error status for a partial
//    failure makes the exporter retry the ENTIRE batch — including the spans
//    that were accepted — which on an append-only log means duplicated events,
//    permanently. The spec is explicit that the client MUST NOT retry a 200.
//
//  * NON-RETRYABLE FAILURE → 400 (malformed body), 401/403 (auth), 404, 405,
//    413 (too large), 415 (bad content type). The client MUST NOT retry.
//    Marking a permanent failure retryable burns the exporter's retry budget
//    and its queue on a request that can never succeed.
//
//  * RETRYABLE FAILURE → 429, 502, 503, 504, and these ONLY. The client SHOULD
//    retry with backoff and MUST honour `Retry-After` when present. Marking a
//    transient failure non-retryable throws the data away.
//
//  * Failure bodies SHOULD be a `google.rpc.Status`. We always send one.
//
//  * The response encoding MUST match the request's: a protobuf request gets a
//    protobuf response. An exporter that sent x-protobuf will try to parse the
//    reply as protobuf, and a JSON body there is a parse error on a successful
//    export.
// ---------------------------------------------------------------------------

import { CONTENT_TYPE_JSON, CONTENT_TYPE_PROTOBUF, RETRY_AFTER_SECONDS } from './limits'
import { ProtoWriter } from './protobuf'

/** Which encoding the client used, and therefore which we must answer in. */
export type OtlpEncoding = 'protobuf' | 'json'

// --- ExportTraceServiceResponse ---
const F_RESP_PARTIAL_SUCCESS = 1
// --- ExportTracePartialSuccess ---
const F_PARTIAL_REJECTED_SPANS = 1
const F_PARTIAL_ERROR_MESSAGE = 2
// --- google.rpc.Status ---
const F_STATUS_CODE = 1
const F_STATUS_MESSAGE = 2

/**
 * `google.rpc.Code` values, for the `Status` returned on failures.
 *
 * These are gRPC codes, not HTTP ones — `Status.code` is a `google.rpc.Code`,
 * and putting an HTTP status in it (a common shortcut) produces a message that
 * decodes to a nonsense code name in the client's logs.
 */
const RPC_CODE = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const

/** HTTP status → the `google.rpc.Code` that means the same thing. */
function rpcCodeForHttpStatus(status: number): number {
  switch (status) {
    case 400: return RPC_CODE.INVALID_ARGUMENT
    case 401: return RPC_CODE.UNAUTHENTICATED
    case 403: return RPC_CODE.PERMISSION_DENIED
    case 404: return RPC_CODE.NOT_FOUND
    case 405: return RPC_CODE.INVALID_ARGUMENT
    case 413: return RPC_CODE.RESOURCE_EXHAUSTED
    case 415: return RPC_CODE.INVALID_ARGUMENT
    case 429: return RPC_CODE.RESOURCE_EXHAUSTED
    case 503: return RPC_CODE.UNAVAILABLE
    default: return RPC_CODE.INTERNAL
  }
}

/**
 * The status codes an OTLP client is permitted to retry.
 *
 * Exported so the route cannot invent a "retryable 500" by accident, and so
 * `tests/unit/otlp_route_response_semantics.test.ts` can assert the set
 * directly rather than restating it.
 */
export const OTLP_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

export function isOtlpRetryable(status: number): boolean {
  return OTLP_RETRYABLE_STATUSES.has(status)
}

/**
 * `Uint8Array` -> `BodyInit`.
 *
 * TypeScript's newer `Uint8Array<ArrayBufferLike>` generic does not unify with
 * the `BodyInit` union in the DOM lib this app compiles against, so passing the
 * view directly is a type error even though it is valid at runtime. Copying out
 * a plain `ArrayBuffer` is a real member of `BodyInit` and needs no cast — and
 * these bodies are at most a few dozen bytes (an ExportTraceServiceResponse or
 * a google.rpc.Status), so the copy is free.
 */
function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function contentTypeFor(encoding: OtlpEncoding): string {
  return encoding === 'protobuf' ? CONTENT_TYPE_PROTOBUF : CONTENT_TYPE_JSON
}

/**
 * A 200 export response.
 *
 * @param rejectedSpans how many spans were NOT recorded. Zero means full
 * success and produces an EMPTY message — proto3 does not serialize a
 * default-valued field, and OTLP's own guidance is that a full success has an
 * unset `partial_success`, so a receiver that always writes
 * `partial_success { rejected_spans: 0 }` is telling every client that
 * something was rejected on every single export.
 */
export function otlpExportResponse(
  encoding: OtlpEncoding,
  rejectedSpans: number,
  errorMessage: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = { 'content-type': contentTypeFor(encoding), ...extraHeaders }

  if (encoding === 'json') {
    const body =
      rejectedSpans > 0
        ? { partialSuccess: { rejectedSpans: String(rejectedSpans), errorMessage } }
        : {}
    return new Response(JSON.stringify(body), { status: 200, headers })
  }

  const root = new ProtoWriter()
  if (rejectedSpans > 0) {
    const partial = new ProtoWriter()
    partial.writeInt64(F_PARTIAL_REJECTED_SPANS, rejectedSpans)
    if (errorMessage !== '') partial.writeString(F_PARTIAL_ERROR_MESSAGE, errorMessage)
    root.writeMessage(F_RESP_PARTIAL_SUCCESS, partial)
  }
  // Zero bytes on full success. That is a valid, complete
  // ExportTraceServiceResponse.
  return new Response(toBody(root.finish()), { status: 200, headers })
}

/**
 * A failure response carrying a `google.rpc.Status`.
 *
 * `Retry-After` is attached to EVERY retryable status, not only to 429. A 503
 * without it leaves the exporter to guess, and OTel SDK exporters default to
 * an aggressive first retry — which is exactly the wrong behaviour against a
 * receiver that is already struggling.
 */
export function otlpErrorResponse(
  encoding: OtlpEncoding,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const code = rpcCodeForHttpStatus(status)
  const headers: Record<string, string> = {
    'content-type': contentTypeFor(encoding),
    ...(isOtlpRetryable(status) && { 'retry-after': String(RETRY_AFTER_SECONDS) }),
    ...extraHeaders,
  }

  if (encoding === 'json') {
    return new Response(JSON.stringify({ code, message }), { status, headers })
  }

  const w = new ProtoWriter()
  w.writeInt64(F_STATUS_CODE, code)
  w.writeString(F_STATUS_MESSAGE, message)
  return new Response(toBody(w.finish()), { status, headers })
}

/**
 * THE canonical auth failure for this endpoint. One response, one code path,
 * for every reason authentication did not succeed.
 *
 * RULING — no existence oracle. A missing key, an unknown key, a revoked key,
 * an expired key, and a valid key that lacks `ingest:write` all produce THIS
 * response, byte for byte. The alternative — 401 for unknown and 403 for
 * wrong-scope, which is what the `/api/v1/**` read routes do — is a key
 * enumeration oracle: an attacker guessing keys learns which guesses exist,
 * because only an existing key can produce a 403.
 *
 * That distinction is affordable on the read routes, whose callers hold their
 * own key and are asking about it. It is not affordable here: this is the
 * endpoint whose URL is pasted into `OTEL_EXPORTER_OTLP_ENDPOINT` in every
 * deployment doc, so it is the one an attacker finds first.
 *
 * The cost is a legitimate operator with a `read`-only key seeing "invalid API
 * key" rather than "wrong scope". That is a documentation problem. The other
 * way round is a security defect.
 *
 * 401 (not 403) because 401 is on the OTLP spec's NON-retryable list, which is
 * the correct signal: no amount of backoff fixes a bad credential.
 */
export function otlpUnauthorized(encoding: OtlpEncoding): Response {
  return otlpErrorResponse(
    encoding,
    401,
    'invalid or missing API key (x-api-key header, requires ingest:write scope)',
  )
}
