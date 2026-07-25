/**
 * Request size limits and decompression (apps/web/src/lib/otel/body.ts).
 *
 * The property that matters most here is NOT "a big body is rejected". It is
 * that a body which is SMALL ON THE WIRE and ENORMOUS DECOMPRESSED is rejected
 * WITHOUT EVER BEING FULLY ALLOCATED. Bounding only the wire size is the
 * classic mistake: gzip's maximum ratio is ~1032:1, so the 4 MiB this endpoint
 * accepts can legally inflate past 4 GiB, and a receiver that calls
 * `await req.text()` after a Content-Length check has already lost.
 *
 * The bomb below is built with the real `CompressionStream`, so it is a
 * genuine gzip member, not a fixture asserting its own premise.
 */
import { describe, expect, it } from 'vitest'

import {
  BodyDecompressionError,
  BodyTooLargeError,
  contentTypeToEncoding,
  parseContentEncoding,
  readOtlpBody,
  UnsupportedEncodingError,
} from '@/lib/otel/body'
import { MAX_COMPRESSED_BODY_BYTES, MAX_DECOMPRESSED_BODY_BYTES } from '@/lib/otel/limits'

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  const compressed = src.pipeThrough(
    new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  )
  const chunks: Uint8Array[] = []
  const reader = compressed.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.byteLength
  }
  return out
}

function request(body: Uint8Array | null, headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf', ...headers },
    ...(body !== null && { body: body as unknown as BodyInit }),
  })
}

describe('decompression bombs', () => {
  it('REJECTS a gzip bomb on the DECOMPRESSED bound, not the wire bound', async () => {
    // 64 MiB of zeros. Four times the decompressed budget, and it compresses
    // to a handful of kilobytes — so every wire-size check in the world passes
    // it.
    const payload = new Uint8Array(64 * 1024 * 1024)
    const bomb = await gzip(payload)

    // Precondition: this really is a bomb. If the ratio were modest the test
    // would be asserting nothing.
    expect(bomb.byteLength).toBeLessThan(MAX_COMPRESSED_BODY_BYTES)
    expect(payload.byteLength / bomb.byteLength).toBeGreaterThan(100)

    const err = await readOtlpBody(
      request(bomb, { 'content-encoding': 'gzip' }),
    ).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(BodyTooLargeError)
    // `decompressed`, not `compressed` — proving the wire check passed it and
    // the OUTPUT-side budget is what caught it.
    expect((err as BodyTooLargeError).bound).toBe('decompressed')
    expect((err as BodyTooLargeError).limitBytes).toBe(MAX_DECOMPRESSED_BODY_BYTES)
  })

  it('accepts a legitimately compressed body of ordinary size', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ resourceSpans: [] }))
    const body = await gzip(payload)
    const out = await readOtlpBody(request(body, { 'content-encoding': 'gzip' }))
    expect([...out]).toEqual([...payload])
  })

  it('rejects a corrupt gzip member as a 400-class decompression error, not a 413', async () => {
    const notGzip = new TextEncoder().encode('this is definitely not a gzip member at all')
    await expect(
      readOtlpBody(request(notGzip, { 'content-encoding': 'gzip' })),
    ).rejects.toBeInstanceOf(BodyDecompressionError)
  })
})

describe('wire-size bounds', () => {
  it('rejects on a declared Content-Length before reading a single byte', async () => {
    // The body itself is tiny; only the header claims otherwise. The check has
    // to fire anyway — this is the free rejection that keeps an honest oversized
    // client from ever transmitting.
    const err = await readOtlpBody(
      request(new Uint8Array(8), {
        'content-length': String(MAX_COMPRESSED_BODY_BYTES + 1),
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BodyTooLargeError)
    expect((err as BodyTooLargeError).bound).toBe('compressed')
  })

  it('rejects an oversized body even when Content-Length lies or is absent', async () => {
    // Content-Length is absent under chunked transfer encoding and is
    // attacker-controlled when present, so the counted-bytes bound is the real
    // one.
    const big = new Uint8Array(MAX_COMPRESSED_BODY_BYTES + 1024)
    const err = await readOtlpBody(request(big)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BodyTooLargeError)
    expect((err as BodyTooLargeError).bound).toBe('compressed')
  })

  it('accepts a body just under the wire bound', async () => {
    const ok = new Uint8Array(1024)
    const out = await readOtlpBody(request(ok))
    expect(out.byteLength).toBe(1024)
  })

  it('treats a null body as an empty export rather than an error', async () => {
    const out = await readOtlpBody(request(null))
    expect(out.byteLength).toBe(0)
  })
})

describe('content negotiation', () => {
  it('accepts only gzip and identity as Content-Encoding', () => {
    expect(parseContentEncoding(null)).toBe('identity')
    expect(parseContentEncoding('')).toBe('identity')
    expect(parseContentEncoding('identity')).toBe('identity')
    expect(parseContentEncoding('gzip')).toBe('gzip')
    expect(parseContentEncoding('GZIP')).toBe('gzip')
    expect(parseContentEncoding('x-gzip')).toBe('gzip')
    // `deflate`/`br` are optional in OTLP and no SDK exporter defaults to them.
    // Every extra decompressor is another bomb surface for no real benefit.
    for (const bad of ['deflate', 'br', 'zstd', 'compress']) {
      expect(() => parseContentEncoding(bad)).toThrow(UnsupportedEncodingError)
    }
  })

  it('maps Content-Type to an encoding, tolerating parameters', () => {
    expect(contentTypeToEncoding('application/x-protobuf')).toBe('protobuf')
    expect(contentTypeToEncoding('application/protobuf')).toBe('protobuf')
    expect(contentTypeToEncoding('application/json')).toBe('json')
    expect(contentTypeToEncoding('application/json; charset=utf-8')).toBe('json')
    expect(contentTypeToEncoding('APPLICATION/JSON')).toBe('json')
  })

  it('refuses to GUESS an encoding from an unsupported or absent Content-Type', () => {
    // Sniffing (e.g. "starts with `{` so it is JSON") eventually mis-parses a
    // protobuf body whose first byte happens to be 0x7b, and reports a decode
    // error the operator cannot act on.
    for (const bad of [null, '', 'text/plain', 'application/octet-stream', 'application/grpc']) {
      expect(contentTypeToEncoding(bad)).toBeNull()
    }
  })
})
