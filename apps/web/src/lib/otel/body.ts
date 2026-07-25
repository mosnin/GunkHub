// ---------------------------------------------------------------------------
// Bounded request body reading and decompression.
//
// RUNTIME NOTE — why there is no `node:zlib` here.
//
// This module is imported by a Next.js route handler. Route handlers default
// to the Node runtime today, but `node:zlib`/`node:stream` would silently
// pin this route to it forever, and the same decode path is a plausible
// candidate to run in a Convex isolate later (where `node:` builtins are
// unavailable outside an explicit "use node" action). Everything below uses
// only WHATWG globals — `ReadableStream`, `DecompressionStream`, `TextDecoder`
// — which exist in Node 18+, in the Next.js edge runtime, and in a Convex
// isolate. Nothing in this directory imports a `node:` builtin.
//
// THE THREAT MODEL: the body arrives from an unauthenticated caller (the API
// key has not been checked yet — checking it requires a Convex round trip,
// which we will not spend on a 4 GB body), it is COMPRESSED, and it is BINARY.
// So the bounds are applied in this order, cheapest first:
//
//   1. `Content-Length` header, if present  — costs nothing, rejects before a
//      single body byte is read.
//   2. Actual compressed bytes, counted as they stream in — because
//      `Content-Length` is absent under chunked transfer encoding and is
//      attacker-controlled when present.
//   3. Actual DECOMPRESSED bytes, counted as they leave the decompressor, with
//      the stream CANCELLED the moment the budget is blown.
//
// Step 3 is the decompression bomb defence and it is the whole reason this
// module exists. gzip's maximum compression ratio is ~1032:1, so the 4 MiB
// allowed by step 2 can legally inflate to over 4 GiB. Bounding only the wire
// size — which is what an endpoint that calls `await req.text()` after a
// `Content-Length` check is doing — is not a bound at all.
// ---------------------------------------------------------------------------

import { MAX_COMPRESSED_BODY_BYTES, MAX_DECOMPRESSED_BODY_BYTES } from './limits'

/** The body exceeded a size bound. Maps to 413 — NON-retryable. */
export class BodyTooLargeError extends Error {
  constructor(
    /** Which bound was hit. `decompressed` means a suspected bomb. */
    readonly bound: 'compressed' | 'decompressed',
    readonly limitBytes: number,
  ) {
    super(
      bound === 'compressed'
        ? `request body exceeds ${String(limitBytes)} bytes`
        : `decompressed request body exceeds ${String(limitBytes)} bytes`,
    )
    this.name = 'BodyTooLargeError'
  }
}

/** The body could not be decompressed. Maps to 400 — NON-retryable. */
export class BodyDecompressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BodyDecompressionError'
  }
}

/** An unsupported `Content-Encoding`. Maps to 415 — NON-retryable. */
export class UnsupportedEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`unsupported Content-Encoding: ${encoding}`)
    this.name = 'UnsupportedEncodingError'
  }
}

/**
 * Drain a stream, aborting the moment `maxBytes` is exceeded.
 *
 * The counter is checked BEFORE each chunk is retained, and the stream is
 * cancelled rather than drained, so the peak allocation is bounded by
 * `maxBytes` plus one chunk — never by the attacker's chosen output size. A
 * version of this that collected everything and checked the total at the end
 * would be the bug rather than the fix.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  bound: 'compressed' | 'decompressed',
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue

      total += value.byteLength
      if (total > maxBytes) {
        // Cancel first, THEN throw: leaving the underlying source producing
        // into a decompressor nobody is reading is how a "rejected" bomb still
        // costs you the memory.
        await reader.cancel().catch(() => undefined)
        throw new BodyTooLargeError(bound, maxBytes)
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err
    // A corrupt gzip member surfaces here as a stream error.
    throw new BodyDecompressionError(
      err instanceof Error ? err.message : 'failed to read request body',
    )
  } finally {
    reader.releaseLock()
  }

  // One allocation, at a size we have already proven is within budget.
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** Normalize `Content-Encoding`. Only `gzip` and identity are supported. */
export function parseContentEncoding(header: string | null): 'gzip' | 'identity' {
  const value = (header ?? '').trim().toLowerCase()
  if (value === '' || value === 'identity') return 'identity'
  if (value === 'gzip' || value === 'x-gzip') return 'gzip'
  // `deflate` and `br` are deliberately NOT accepted. The OTLP spec requires
  // receivers to support `gzip` and `none`; anything else is optional, and
  // every additional decompressor is another bomb surface for zero real-world
  // benefit — no OTel SDK exporter defaults to br or deflate.
  throw new UnsupportedEncodingError(value)
}

/**
 * Read and (if needed) decompress a request body under both bounds.
 *
 * @throws {BodyTooLargeError} 413, {@link BodyDecompressionError} 400,
 * {@link UnsupportedEncodingError} 415.
 */
export async function readOtlpBody(req: Request): Promise<Uint8Array> {
  const encoding = parseContentEncoding(req.headers.get('content-encoding'))

  // (1) Free rejection on a declared length. An honest client that would blow
  // the budget never gets to send a byte.
  const declaredLength = req.headers.get('content-length')
  if (declaredLength !== null) {
    const n = Number(declaredLength)
    if (Number.isFinite(n) && n > MAX_COMPRESSED_BODY_BYTES) {
      throw new BodyTooLargeError('compressed', MAX_COMPRESSED_BODY_BYTES)
    }
  }

  if (req.body === null) return new Uint8Array(0)

  // (2) Bound the wire bytes regardless of what Content-Length claimed.
  const compressed = await readBounded(req.body, MAX_COMPRESSED_BODY_BYTES, 'compressed')

  if (encoding === 'identity') return compressed

  if (typeof DecompressionStream === 'undefined') {
    throw new BodyDecompressionError('gzip decompression is unavailable in this runtime')
  }

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed)
      controller.close()
    },
  })

  // (3) The bomb bound. Counted on the OUTPUT side of the decompressor.
  // `DecompressionStream`'s lib type declares `writable: WritableStream<BufferSource>`,
  // which does not unify with `ReadableStream<Uint8Array>.pipeThrough`'s
  // invariant pair type. The runtime contract is exactly what we need (bytes in,
  // bytes out); this narrows the declaration, it does not change behaviour.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >

  return await readBounded(
    source.pipeThrough(gunzip),
    MAX_DECOMPRESSED_BODY_BYTES,
    'decompressed',
  )
}

/**
 * Which OTLP encoding the `Content-Type` selects.
 *
 * Returns `null` for anything unsupported — the caller answers 415. OTLP
 * defines exactly two body encodings for HTTP, and an endpoint that guesses
 * (say, sniffing for a leading `{`) will eventually mis-parse a protobuf body
 * whose first byte happens to be 0x7b and report a decode error the operator
 * cannot act on.
 */
export function contentTypeToEncoding(header: string | null): 'protobuf' | 'json' | null {
  // Strip parameters: `application/json; charset=utf-8` is a JSON body.
  const value = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (value === 'application/x-protobuf' || value === 'application/protobuf') return 'protobuf'
  if (value === 'application/json') return 'json'
  return null
}
