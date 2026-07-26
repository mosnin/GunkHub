// ---------------------------------------------------------------------------
// POST /api/v1/traces — OTLP/HTTP trace ingest.
//
// ===========================================================================
// RULING — WHY THIS PATH, AND NOT `/v1/traces`
// ===========================================================================
//
// The OTLP/HTTP spec does NOT mandate `/v1/traces` as an absolute path. It
// specifies two client configuration variables:
//
//   * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` — a FULL URL, used verbatim. Any
//     path works.
//   * `OTEL_EXPORTER_OTLP_ENDPOINT` — a BASE URL, to which the SDK appends
//     `/v1/traces`.
//
// So `https://<host>/api/v1/traces` is a fully conformant OTLP endpoint for
// the first variable, which is the one an operator pointing at a third-party
// backend sets anyway. Putting it under `/api/v1/**` is what buys the things
// that actually matter for a production ingest surface: the same `x-api-key`
// auth, the same per-key rate class, the same request-id logging, and the same
// versioned namespace as every other public API this product ships. A
// top-level `/v1/traces` would sit outside all of it and would collide with
// the app's page routing.
//
// THE COST, STATED PLAINLY: an operator who sets the BASE variable
// (`OTEL_EXPORTER_OTLP_ENDPOINT=https://host`) will have their SDK POST to
// `https://host/v1/traces` and get a 404. Fixing that is a one-line rewrite in
// `apps/web/next.config.js`:
//
//     async rewrites() {
//       return [{ source: '/v1/traces', destination: '/api/v1/traces' }]
//     }
//
// `next.config.js` is a root/web-boundary config file this team does not own,
// so the rewrite is NOT included here. It is called out in the report as a
// required change on another boundary. Until it lands, the documented endpoint
// is the full URL form.
//
// ===========================================================================
// RUNTIME
// ===========================================================================
//
// Nothing under `@/lib/otel/**` imports a `node:` builtin. Body reading and
// gzip use WHATWG `ReadableStream`/`DecompressionStream`; protobuf decoding
// uses `Uint8Array`/`DataView`/`BigInt`. The one Node-only dependency on this
// path is `hashApiKey` (`node:crypto` via `@/lib/convexServer`), which is why
// no `export const runtime = 'edge'` is declared — the route is Node-runtime
// today, and the OTLP layer is edge-clean so that changing that is a one-line
// decision later rather than a rewrite.
// ---------------------------------------------------------------------------

import type { NormalizedSpan } from '@/lib/otel/types'
import type { NextRequest } from 'next/server'

import { withApiHandler } from '@/lib/apiHandler'
import { hashApiKey , ConvexTimeoutError } from '@/lib/convexServer'
import {
  BodyDecompressionError,
  BodyTooLargeError,
  contentTypeToEncoding,
  readOtlpBody,
  UnsupportedEncodingError,
} from '@/lib/otel/body'
import { decodeJsonExportTraceServiceRequest, OtlpJsonDecodeError } from '@/lib/otel/decodeJson'
import { decodeExportTraceServiceRequest } from '@/lib/otel/decodeProtobuf'
import { ProtobufDecodeError } from '@/lib/otel/protobuf'
import {
  otlpErrorResponse,
  otlpExportResponse,
  otlpUnauthorized,
  type OtlpEncoding,
} from '@/lib/otel/response'
import { ingestOtelSpans, type OtelIngestSpansResult } from '@/lib/services/otel_ingest'

/**
 * Does this Convex error mean "your credential is not usable"?
 *
 * Deliberately BROAD. `convex/sdk_ingest.ts` `resolveApiKey` throws
 * `"Unauthorized"` for an unknown or revoked key, `"Unauthorized: API key has
 * expired"` for an expired one, and `Forbidden: API key lacks required scope
 * "ingest:write"` for a valid key with the wrong scope. All of them collapse
 * to ONE response here — see `otlpUnauthorized` for why distinguishing them is
 * a key-enumeration oracle.
 */
function isAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const m = err.message
  return (
    m.includes('Unauthorized') ||
    m.includes('Forbidden') ||
    m.includes('SCOPE_DENIED') ||
    m.includes('lacks required scope')
  )
}

/**
 * The Convex mutation's per-call span ceiling
 * (`MAX_OTEL_SPANS_PER_BATCH`, convex/helpers/pagination.ts).
 *
 * Mirrored rather than imported: `apps/web` may not import from `convex/`.
 * Pinned by `tests/unit/otlp_route_limits_drift.test.ts` so a change on the
 * Convex side fails a test here instead of turning every large trace group
 * into a `BATCH_TOO_LARGE` in production.
 */
const MAX_SPANS_PER_TRACE_CALL = 1_000

/** Group a batch's spans by trace. See RULING 2 in services/otel_ingest.ts. */
function groupByTrace(spans: NormalizedSpan[]): Map<string, NormalizedSpan[]> {
  const groups = new Map<string, NormalizedSpan[]>()
  for (const span of spans) {
    const existing = groups.get(span.traceId)
    if (existing === undefined) groups.set(span.traceId, [span])
    else existing.push(span)
  }
  return groups
}

/** A trace group that could not be written, and why, in operator-readable form. */
interface GroupFailure {
  traceId: string
  spanCount: number
  /** The HTTP status this failure would justify ON ITS OWN. */
  status: number
  message: string
}

async function handleOtlpTraces(req: NextRequest): Promise<Response> {
  // ------------------------------------------------------------------
  // 1. Content type. Decided FIRST, because every subsequent response —
  //    including the auth failure — must be encoded in the client's format,
  //    and because a client we cannot answer intelligibly is not worth
  //    authenticating.
  // ------------------------------------------------------------------
  const encoding = contentTypeToEncoding(req.headers.get('content-type'))
  if (encoding === null) {
    // 415, answered in JSON: we do not know that this client can read
    // protobuf, and JSON is the format a human debugging a misconfigured
    // exporter can actually read in a curl output.
    return otlpErrorResponse(
      'json',
      415,
      `unsupported Content-Type; expected application/x-protobuf or application/json`,
    )
  }
  const enc: OtlpEncoding = encoding

  // ------------------------------------------------------------------
  // 2. Credential presence. A MISSING key and an UNKNOWN key produce the
  //    identical response — same status, same body, same headers. The check
  //    is here (cheap, local) and again inside Convex (authoritative).
  // ------------------------------------------------------------------
  const apiKey = req.headers.get('x-api-key')
  if (apiKey === null || apiKey === '') {
    return otlpUnauthorized(enc)
  }

  // ------------------------------------------------------------------
  // 2b. Which agent these traces belong to.
  //
  // REQUIRED, and NOT derivable from the spans — `convex/otel_ingest.ts`
  // RULING 5 refuses to invent an agent from `gen_ai.agent.name`. A header is
  // the only channel an OTLP exporter offers:
  //
  //   OTEL_EXPORTER_OTLP_HEADERS="x-api-key=afr_...,x-afr-agent-id=<id>"
  //
  // 400, not 401: this is a SHAPE error, and it is answered identically
  // whether the key is real or not, so it reveals nothing. Whether the agent
  // id EXISTS is answered by Convex, which collapses "no such agent" and
  // "agent in another org" into one indistinguishable outcome.
  // ------------------------------------------------------------------
  const agentId = req.headers.get('x-afr-agent-id')
  if (agentId === null || agentId === '') {
    return otlpErrorResponse(
      enc,
      400,
      'missing x-afr-agent-id header: OTLP ingest must name the agent these traces belong to',
    )
  }
  const agentVersionHeader = req.headers.get('x-afr-agent-version')
  const agentVersion =
    agentVersionHeader !== null && agentVersionHeader !== '' ? agentVersionHeader : undefined

  // ------------------------------------------------------------------
  // 3. Body. Bounded on the wire AND after decompression, before any parse.
  //    Note this runs BEFORE the key is validated against Convex: validating
  //    first would mean spending a backend round trip on every 4 GB bomb, so
  //    the cheap local bound goes first. Nothing here reveals whether the key
  //    is real.
  // ------------------------------------------------------------------
  let raw: Uint8Array
  try {
    raw = await readOtlpBody(req)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // 413 — on the OTLP spec's NON-retryable list. Correct: the identical
      // body will be identically too large forever.
      return otlpErrorResponse(enc, 413, err.message)
    }
    if (err instanceof UnsupportedEncodingError) {
      return otlpErrorResponse(enc, 415, err.message)
    }
    if (err instanceof BodyDecompressionError) {
      return otlpErrorResponse(enc, 400, err.message)
    }
    throw err
  }

  // ------------------------------------------------------------------
  // 4. Decode. Framing corruption is 400 (non-retryable). Bad individual
  //    spans are NOT errors — they come back as rejections and become part of
  //    the partial-success count.
  // ------------------------------------------------------------------
  let decoded
  try {
    decoded =
      enc === 'protobuf'
        ? decodeExportTraceServiceRequest(raw)
        : decodeJsonExportTraceServiceRequest(new TextDecoder().decode(raw))
  } catch (err) {
    if (err instanceof ProtobufDecodeError || err instanceof OtlpJsonDecodeError) {
      return otlpErrorResponse(enc, 400, `malformed OTLP request: ${err.message}`)
    }
    throw err
  }

  // An empty export is legal and is a full success. The spec is explicit that
  // a request with no spans gets 200 with an empty ExportTraceServiceResponse.
  if (decoded.spans.length === 0 && decoded.rejected.length === 0) {
    return otlpExportResponse(enc, 0, '')
  }

  // ------------------------------------------------------------------
  // 5. Forward, one call per trace.
  // ------------------------------------------------------------------
  const apiKeyHash = hashApiKey(apiKey)
  const groups = groupByTrace(decoded.spans)

  const results: OtelIngestSpansResult[] = []
  const failures: GroupFailure[] = []
  let authFailed = false

  for (const [traceId, spans] of groups) {
    // Refuse locally rather than spending a backend round trip to be told
    // BATCH_TOO_LARGE. Same outcome for the caller, one fewer transaction, and
    // the message names the fix (`OTEL_BSP_MAX_EXPORT_BATCH_SIZE`) rather than
    // restating the limit.
    if (spans.length > MAX_SPANS_PER_TRACE_CALL) {
      failures.push({
        traceId,
        spanCount: spans.length,
        status: 413,
        message:
          `trace carries ${String(spans.length)} spans, exceeding the per-call maximum of ` +
          `${String(MAX_SPANS_PER_TRACE_CALL)}; lower OTEL_BSP_MAX_EXPORT_BATCH_SIZE`,
      })
      continue
    }
    try {
      results.push(
        await ingestOtelSpans(apiKeyHash, {
          traceId,
          agentId,
          spans,
          ...(agentVersion !== undefined && { agentVersion }),
        }),
      )
    } catch (err) {
      // An auth failure is not a per-trace problem — the credential is bad for
      // the whole request. Stop; do not spend more backend calls proving it.
      if (isAuthFailure(err)) {
        authFailed = true
        break
      }
      if (err instanceof ConvexTimeoutError) {
        failures.push({
          traceId, spanCount: spans.length, status: 503,
          message: 'trace ingest backend timed out',
        })
        continue
      }
      const message = err instanceof Error ? err.message.split('\n')[0]?.slice(0, 200) ?? '' : ''
      failures.push({
        traceId,
        spanCount: spans.length,
        status: statusForBackendError(message),
        message,
      })
    }
  }

  if (authFailed) return otlpUnauthorized(enc)

  // ------------------------------------------------------------------
  // 6. Response. THE CORE OTLP RULING.
  // ------------------------------------------------------------------
  //
  // If ANYTHING was durably written, this is a 200 with partial success —
  // never an error status. The log is append-only: telling the exporter
  // "failed" makes it retry the whole batch, and the spans we already wrote
  // are re-derived into a SECOND set of events that can never be deleted. A
  // 200 that under-reports success is a bug; a 4xx/5xx that discards a
  // successful partial write is CORRUPTION.
  //
  // Only when NOTHING was written may this be an error status, and then it is
  // the failure's own status — retryable if the cause is transient (503),
  // non-retryable if the cause is permanent (409).

  const rejectedFromDecode = decoded.rejected.length
  const rejectedFromBackend = results.reduce((n, r) => n + r.rejected.length, 0)
  const rejectedFromFailedGroups = failures.reduce((n, f) => n + f.spanCount, 0)
  const totalRejected = rejectedFromDecode + rejectedFromBackend + rejectedFromFailedGroups

  const wroteSomething = results.some((r) => r.eventIds.length > 0)

  const first = failures[0]
  if (!wroteSomething && first !== undefined) {
    const allSame = failures.every((f) => f.status === first.status)
    // Mixed causes: fall back to the RETRYABLE one. When we cannot say which
    // failure the caller should act on, "try again later" loses less than
    // "give up" — see statusForBackendError for the same trade.
    const status = allSame ? first.status : 503
    return otlpErrorResponse(
      enc,
      status,
      `no spans recorded: ${first.message === '' ? 'ingest failed' : first.message}`,
    )
  }

  // ------------------------------------------------------------------
  // THE `rejected_spans: 0` TRAP.
  //
  // A 200 with an unset `partial_success` means, to every conforming OTLP
  // exporter, "everything you sent is durably recorded" — and it responds by
  // DROPPING its buffer. So that response is a promise, and it must never be
  // made on a batch that was in fact refused.
  //
  // The dangerous shape is not the one handled above (a thrown failure, which
  // we count). It is a backend that RETURNS successfully having written
  // nothing and reported no rejections — which is exactly what
  // `convex/otel_ingest.ts` can do today: Team D's defects D3/D9 found the
  // mutation refuses a batch IN FULL when any single span trips
  // `PAYLOAD_TOO_LARGE` or produces provenance that fails
  // `isProvenanceConsistent`, and `RejectedSpanReport.reason` has no member
  // for either, so the refusal can arrive as an empty `rejected` array.
  //
  // Answering 200/0 there would be us telling the exporter, on our word, that
  // data we discarded is safe. Instead: 503, retryable. Once Team A gives
  // `RejectedSpanReport.reason` the missing members, those spans arrive in
  // `rejected`, this branch stops firing, and the partial-success path below
  // reports them per-span — with no change needed here.
  // ------------------------------------------------------------------
  const forwardedSpans = [...groups.values()].reduce((n, s) => n + s.length, 0)
  if (forwardedSpans > 0 && !wroteSomething && totalRejected === 0) {
    return otlpErrorResponse(
      enc,
      503,
      'ingest returned no recorded events and no rejections; treating as not-recorded rather than reporting success',
    )
  }

  if (totalRejected === 0) {
    return otlpExportResponse(enc, 0, '')
  }

  const parts: string[] = []
  if (rejectedFromDecode > 0) {
    parts.push(`${String(rejectedFromDecode)} span(s) malformed: ${summarizeDecodeRejections(decoded.rejected)}`)
  }
  if (rejectedFromBackend > 0) {
    parts.push(`${String(rejectedFromBackend)} span(s) refused by ingest: ${summarizeBackendRejections(results)}`)
  }
  if (rejectedFromFailedGroups > 0) {
    parts.push(
      `${String(rejectedFromFailedGroups)} span(s) in ${String(failures.length)} trace(s) not recorded: ${failures[0]?.message ?? 'ingest failed'}`,
    )
  }

  // 200. Partial success. See the block comment above.
  return otlpExportResponse(enc, totalRejected, parts.join('; '))
}

/**
 * Map a Convex ingest failure to the HTTP status an OTLP exporter should see.
 *
 * EVERY entry here is NON-RETRYABLE, and that is the point. The four ADR-007
 * codes in `AFR_API_ERROR_CODES` are all whole-batch, permanent rejections:
 *
 *   BATCH_TOO_LARGE     — resend smaller; the identical batch always fails.
 *   PAYLOAD_TOO_LARGE   — a span payload is over the 10 KB inline limit
 *                         (Event Log Rule 3) and the mutation will not
 *                         truncate, because a truncated payload is a falsified
 *                         record of what the model was actually sent.
 *   OTEL_MAPPING_FAILED — a fatal mapper diagnostic; the same spans fail
 *                         identically.
 *   OTEL_TRACE_TOO_OLD  — the trace predates the 24h stale-run ceiling
 *                         (ADR-007 C3); no retry brings it back.
 *
 * plus RUN_NOT_ACTIVE (the run was closed out from under a slow trace) and
 * SEQUENCE_CONFLICT, which are equally permanent for this trace.
 *
 * Handing any of these back as a RETRYABLE status would put a conforming
 * exporter into a permanent retry loop against a request that can never
 * succeed, while its queue fills and it drops live spans to make room. The
 * only retryable failures on this route are backend-unavailable and timeout,
 * both handled above and both genuinely transient.
 */
function statusForBackendError(message: string): number {
  if (message.includes('BATCH_TOO_LARGE') || message.includes('PAYLOAD_TOO_LARGE')) return 413
  if (message.includes('OTEL_TRACE_TOO_OLD')) return 400
  if (message.includes('OTEL_MAPPING_FAILED')) return 400
  if (message.includes('INVALID_ARGUMENT')) return 400
  if (message.includes('Agent not found')) return 400
  if (message.includes('RUN_NOT_ACTIVE') || message.includes('SEQUENCE_CONFLICT')) return 409

  // UNRECOGNIZED -> 503, RETRYABLE. This is the deliberate asymmetry.
  //
  // Every branch above is non-retryable because a NAMED code is a claim, made
  // by the backend, that the condition is permanent. Nothing makes that claim
  // about an unnamed throw — and the mutation can throw unnamed errors today:
  // Team D found `compareDuplicateCandidates` in the mapper raises an
  // unguarded `RangeError` on a deeply-nested attribute value attached to a
  // duplicated span id, reachable by any ingest-key holder, and
  // `otel_ingest.ts` does not catch it.
  //
  // Two things follow, and only the second is a judgement call:
  //
  //  1. Such a throw must NEVER escape as a bodyless 500. A 500 with no
  //     `google.rpc.Status` is the worst answer we can give an exporter — it
  //     is non-retryable AND unparseable, so the batch is dropped and the
  //     operator gets nothing to act on. Catching it per-trace here, plus
  //     `withOtlpResponseShape` below, guarantees an OTLP-shaped body on every
  //     path out of this route.
  //
  //  2. Retryable or not? A deterministic mapper crash will not resolve on
  //     retry, so 503 does buy a bounded retry storm. But an unrecognized
  //     error is equally likely to be a transient backend fault, and a
  //     conforming exporter backs off exponentially against a bounded queue —
  //     it degrades, it does not hammer. Choosing non-retryable would discard
  //     real data on every transient blip to avoid wasted retries on our own
  //     bugs. Data loss is permanent; wasted retries are not.
  //
  // When the mapper's RangeError is fixed to surface as `OTEL_MAPPING_FAILED`,
  // it lands on the 400 branch above and stops reaching this one.
  return 503
}

/** Compact, deterministic reason counts. Deterministic so tests can assert it. */
function summarizeDecodeRejections(rejections: { reason: string }[]): string {
  const counts = new Map<string, number>()
  for (const r of rejections) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, n]) => `${reason}=${String(n)}`)
    .join(',')
}

function summarizeBackendRejections(results: OtelIngestSpansResult[]): string {
  const counts = new Map<string, number>()
  for (const r of results) {
    for (const rej of r.rejected) counts.set(rej.reason, (counts.get(rej.reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, n]) => `${reason}=${String(n)}`)
    .join(',')
}

/**
 * OTLP-shape every response that leaves this route, including the ones
 * `withApiHandler` produces on its own.
 *
 * `withApiHandler` answers a rate-limit hit with a 429 carrying the app's flat
 * `ApiError` JSON, and an unexpected throw with a 500 in the same shape,
 * BEFORE/AROUND the handler — so the handler cannot format them. Both statuses
 * are meaningful to an OTLP exporter (429 is retryable, 500 is not), but the
 * BODIES are not `google.rpc.Status`, and a protobuf client will fail to parse
 * them.
 *
 * This shim rewrites any non-2xx response the wrapper produced into the
 * negotiated OTLP encoding, preserving the status and `retry-after` exactly.
 * It is a wrapper rather than a change to `apiHandler.ts` on purpose:
 * `apiHandler.ts` is shared by ~30 routes that all want the flat `ApiError`
 * shape, and OTLP's response format is this endpoint's peculiarity, not
 * theirs.
 */
function withOtlpResponseShape(
  inner: (req: NextRequest) => Promise<Response>,
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    const res = await inner(req)
    if (res.status < 400) return res

    const ct = res.headers.get('content-type') ?? ''
    // Already OTLP-shaped (produced by this route's own handler) — leave it.
    if (ct.startsWith('application/x-protobuf')) return res

    const enc = contentTypeToEncoding(req.headers.get('content-type')) ?? 'json'
    if (enc === 'json' && ct.startsWith('application/json')) {
      // A JSON client getting a JSON error body is already parseable. Rewriting
      // it would only change the field names, and the app's `{code, message}`
      // is close enough to `google.rpc.Status` to be useful in a log.
      return res
    }

    let message = `request failed with status ${String(res.status)}`
    try {
      const body = (await res.clone().json()) as { message?: unknown }
      if (typeof body.message === 'string') message = body.message
    } catch {
      // Non-JSON error body; keep the generic message.
    }

    const retryAfter = res.headers.get('retry-after')
    return otlpErrorResponse(
      enc,
      res.status,
      message,
      retryAfter !== null ? { 'retry-after': retryAfter } : {},
    )
  }
}

export const POST = withOtlpResponseShape(
  withApiHandler('/api/v1/traces', async (req: NextRequest) => handleOtlpTraces(req), {
    // Same class as `/api/events`, the other ingest-write surface: keyed off
    // the api-key HASH (never the raw secret), 600/min. OTLP exporters batch,
    // so a request here carries many spans; rate-limiting per REQUEST rather
    // than per span is deliberate and matches how the class is defined
    // elsewhere. The durable per-key limit (`api_keys.rateLimitPerMin`,
    // enforced in convex/sdk_ingest.ts) is the authoritative one; this is the
    // per-instance shock absorber in front of it.
    rateLimit: { key: 'apiKey', limitPerMin: 600 },
  }),
)
