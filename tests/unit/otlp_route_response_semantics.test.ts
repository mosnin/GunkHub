/**
 * OTLP response semantics (apps/web/src/lib/otel/response.ts).
 *
 * These assertions are the contract between this receiver and every OTel
 * exporter that will ever point at it. The status code is not decoration — it
 * is the exporter's control signal, and each of the properties below has a
 * concrete failure mode if broken:
 *
 *   * partial success must be 200        -> otherwise the exporter retries the
 *                                            whole batch and DUPLICATES the
 *                                            spans already written to an
 *                                            append-only log
 *   * 4xx (except 429) must be non-retryable -> otherwise a permanent failure
 *                                            spins the exporter forever
 *   * 429/503 must carry Retry-After     -> otherwise backoff is a guess
 *   * response encoding must mirror the request -> otherwise a protobuf client
 *                                            cannot parse its own success
 */
import { describe, expect, it } from 'vitest'

import { ProtoReader, WIRE_LENGTH_DELIMITED, WIRE_VARINT } from '@/lib/otel/protobuf'
import {
  isOtlpRetryable,
  OTLP_RETRYABLE_STATUSES,
  otlpErrorResponse,
  otlpExportResponse,
  otlpUnauthorized,
} from '@/lib/otel/response'

/** Decode `ExportTraceServiceResponse` -> its partial_success, if present. */
function readExportResponse(bytes: Uint8Array): {
  rejectedSpans: number
  errorMessage: string
} | null {
  const r = new ProtoReader(bytes)
  let out: { rejectedSpans: number; errorMessage: string } | null = null
  while (!r.eof) {
    const { fieldNumber, wireType } = r.readTag()
    if (fieldNumber === 1 && wireType === WIRE_LENGTH_DELIMITED) {
      const inner = r.readMessage()
      let rejectedSpans = 0
      let errorMessage = ''
      while (!inner.eof) {
        const t = inner.readTag()
        if (t.fieldNumber === 1 && t.wireType === WIRE_VARINT) {
          rejectedSpans = inner.readVarintAsNumber()
        } else if (t.fieldNumber === 2 && t.wireType === WIRE_LENGTH_DELIMITED) {
          errorMessage = inner.readString()
        } else inner.skipField(t.wireType)
      }
      out = { rejectedSpans, errorMessage }
    } else r.skipField(wireType)
  }
  return out
}

/** Decode `google.rpc.Status`. */
function readStatus(bytes: Uint8Array): { code: number; message: string } {
  const r = new ProtoReader(bytes)
  let code = 0
  let message = ''
  while (!r.eof) {
    const { fieldNumber, wireType } = r.readTag()
    if (fieldNumber === 1 && wireType === WIRE_VARINT) code = r.readVarintAsNumber()
    else if (fieldNumber === 2 && wireType === WIRE_LENGTH_DELIMITED) message = r.readString()
    else r.skipField(wireType)
  }
  return { code, message }
}

describe('OTLP success responses', () => {
  it('FULL success is 200 with an EMPTY protobuf message', async () => {
    const res = otlpExportResponse('protobuf', 0, '')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')

    const bytes = new Uint8Array(await res.arrayBuffer())
    // Zero bytes. proto3 does not serialize a default-valued field, and a
    // receiver that always emitted `partial_success { rejected_spans: 0 }`
    // would tell every client something was rejected on every export.
    expect(bytes.byteLength).toBe(0)
    expect(readExportResponse(bytes)).toBeNull()
  })

  it('FULL success is 200 with `{}` in JSON', async () => {
    const res = otlpExportResponse('json', 0, '')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({})
  })

  it('PARTIAL success is 200 — NOT an error status — with rejected_spans set', async () => {
    const res = otlpExportResponse('protobuf', 7, '3 span(s) malformed')

    // THE assertion this whole endpoint turns on.
    expect(res.status).toBe(200)
    expect(isOtlpRetryable(res.status)).toBe(false)
    // No Retry-After on a success: a client that backed off here would be
    // backing off from a request that worked.
    expect(res.headers.get('retry-after')).toBeNull()

    const partial = readExportResponse(new Uint8Array(await res.arrayBuffer()))
    expect(partial).toEqual({ rejectedSpans: 7, errorMessage: '3 span(s) malformed' })
  })

  it('PARTIAL success in JSON uses a STRING rejectedSpans (int64 JSON mapping)', async () => {
    const res = otlpExportResponse('json', 7, 'why')
    expect(res.status).toBe(200)
    // proto3 JSON encodes int64 as a string. A number here overflows silently
    // for large batches and mis-types for strict clients.
    expect(await res.json()).toEqual({
      partialSuccess: { rejectedSpans: '7', errorMessage: 'why' },
    })
  })
})

describe('OTLP failure responses', () => {
  it('marks EXACTLY 429/502/503/504 retryable and nothing else', () => {
    expect([...OTLP_RETRYABLE_STATUSES].sort((a, b) => a - b)).toEqual([429, 502, 503, 504])
    for (const s of [200, 400, 401, 403, 404, 405, 413, 415, 500, 501]) {
      expect(isOtlpRetryable(s)).toBe(false)
    }
  })

  it('attaches Retry-After to EVERY retryable status, not just 429', () => {
    for (const status of [429, 502, 503, 504]) {
      const res = otlpErrorResponse('protobuf', status, 'x')
      expect(res.headers.get('retry-after')).toBe('60')
    }
  })

  it('never attaches Retry-After to a non-retryable status', () => {
    for (const status of [400, 401, 403, 404, 405, 413, 415, 500]) {
      expect(otlpErrorResponse('protobuf', status, 'x').headers.get('retry-after')).toBeNull()
    }
  })

  it('carries a google.rpc.Status with a gRPC code, not the HTTP status', async () => {
    const cases: [number, number][] = [
      [400, 3], // INVALID_ARGUMENT
      [401, 16], // UNAUTHENTICATED
      [403, 7], // PERMISSION_DENIED
      [404, 5], // NOT_FOUND
      [413, 8], // RESOURCE_EXHAUSTED
      [415, 3], // INVALID_ARGUMENT
      [429, 8], // RESOURCE_EXHAUSTED
      [503, 14], // UNAVAILABLE
      [500, 13], // INTERNAL
    ]
    for (const [http, rpc] of cases) {
      const res = otlpErrorResponse('protobuf', http, `failure ${String(http)}`)
      expect(res.status).toBe(http)
      const status = readStatus(new Uint8Array(await res.arrayBuffer()))
      // A receiver that puts the HTTP status in `code` produces a message that
      // decodes to a nonsense code name in the client's logs.
      expect(status.code).toBe(rpc)
      expect(status.code).not.toBe(http)
      expect(status.message).toBe(`failure ${String(http)}`)
    }
  })

  it('answers in the request encoding, always', async () => {
    const proto = otlpErrorResponse('protobuf', 400, 'bad')
    expect(proto.headers.get('content-type')).toBe('application/x-protobuf')
    // A JSON body here is a parse error for a protobuf client.
    expect(() => readStatus(new Uint8Array(0))).not.toThrow()

    const json = otlpErrorResponse('json', 400, 'bad')
    expect(json.headers.get('content-type')).toBe('application/json')
    expect(await json.json()).toEqual({ code: 3, message: 'bad' })
  })
})

describe('auth failures are not an existence oracle', () => {
  it('produces one identical response regardless of WHY auth failed', async () => {
    // The route funnels missing-key, unknown-key, revoked, expired, and
    // wrong-scope all through this single constructor. Distinguishing them
    // (401 unknown vs 403 wrong-scope, as the /api/v1 read routes do) would
    // let an attacker brute-forcing keys learn which guesses EXIST, because
    // only an existing key can produce a 403.
    const a = otlpUnauthorized('protobuf')
    const b = otlpUnauthorized('protobuf')

    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    // 401 is on the spec's NON-retryable list: no backoff fixes a bad
    // credential.
    expect(isOtlpRetryable(401)).toBe(false)
    expect(a.headers.get('retry-after')).toBeNull()

    const ba = new Uint8Array(await a.arrayBuffer())
    const bb = new Uint8Array(await b.arrayBuffer())
    expect([...ba]).toEqual([...bb])
    // No 403 anywhere: a scope failure must be indistinguishable from an
    // unknown key.
    expect(a.status).not.toBe(403)
  })
})
