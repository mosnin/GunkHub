// ---------------------------------------------------------------------------
// Minimal protobuf wire-format reader/writer.
//
// WHY HAND-WRITTEN RATHER THAN `protobufjs` / `@opentelemetry/otlp-transformer`:
//
//  1. RUNTIME. This code runs in a Next.js route handler that must stay
//     portable to the edge runtime. `protobufjs` reaches for `Buffer` and
//     `node:util` on several paths, and the OTel transformer packages pull in
//     a static-module runtime whose feature detection is not edge-clean. This
//     file uses only `Uint8Array`, `DataView`, `TextDecoder`/`TextEncoder` and
//     `BigInt` — all of which exist in Node, in the edge runtime, and in a
//     Convex isolate.
//
//  2. ATTACK SURFACE. A generic protobuf runtime will happily decode a message
//     with 10^6 nesting levels or a length-delimited field claiming 2^31 bytes.
//     We are decoding UNAUTHENTICATED-SHAPED input from an arbitrary OTLP
//     exporter, so every read here is bounds-checked against the actual buffer
//     length and recursion is explicitly capped (see `MAX_DEPTH` in
//     otlpDecode.ts). Delegating that to a library means inheriting its
//     limits rather than choosing ours.
//
//  3. SIZE. We need exactly six message types out of the OTLP trace schema.
//
// This reader is DELIBERATELY not a general protobuf implementation. It knows
// the four wire types OTLP trace actually uses (varint, 64-bit, length-
// delimited, 32-bit) and rejects the two deprecated group types outright.
//
// CONFORMANCE: `tests/unit/otlp_route_protobuf_roundtrip.test.ts` decodes
// bytes produced by `@opentelemetry/otlp-transformer`'s real
// `ProtobufTraceSerializer` — i.e. the exact bytes a production OTel exporter
// puts on the wire. This file is never tested against its own encoder alone.
// ---------------------------------------------------------------------------

/** Protobuf wire types. Groups (3, 4) are deprecated and rejected. */
export const WIRE_VARINT = 0
export const WIRE_FIXED64 = 1
export const WIRE_LENGTH_DELIMITED = 2
export const WIRE_FIXED32 = 5

/** Thrown for any malformed input. Callers map this to a 400, never a 500. */
export class ProtobufDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtobufDecodeError'
  }
}

// `apps/web/tsconfig.json` targets ES2017, where BigInt LITERALS (`0n`) are a
// syntax error even though the BigInt runtime is present via the ES2022 lib.
// These constants are the literals, hoisted. Do not inline them back.
const B0 = BigInt(0)
const B7 = BigInt(7)
const B0X7F = BigInt(0x7f)
const B64 = BigInt(64)

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false })
const TEXT_ENCODER = new TextEncoder()

/**
 * A cursor over a byte range. Sub-messages are read by constructing a reader
 * over a *slice range* of the same underlying buffer rather than copying, so
 * decoding a 4 MB payload does not allocate a second 4 MB of sub-buffers.
 */
export class ProtoReader {
  private readonly view: DataView

  constructor(
    private readonly buf: Uint8Array,
    private pos: number = 0,
    private readonly end: number = buf.length,
  ) {
    if (pos < 0 || end > buf.length || pos > end) {
      throw new ProtobufDecodeError('reader range out of bounds')
    }
    // The DataView is created over the view's OWN window, so its offset 0 is
    // `buf[0]`. Reads below therefore index by `this.pos` alone — adding
    // `buf.byteOffset` again double-counts it. That bug is invisible when the
    // buffer starts at offset 0 (every hand-built fixture) and corrupts every
    // fixed64 read when it does not (every real serializer output, which hands
    // back a subarray of a pooled buffer). Caught by
    // tests/unit/otlp_route_protobuf_roundtrip.test.ts.
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  get eof(): boolean {
    return this.pos >= this.end
  }

  private require(n: number): void {
    if (this.pos + n > this.end) {
      throw new ProtobufDecodeError(
        `truncated message: need ${String(n)} byte(s) at offset ${String(this.pos)}, ${String(this.end - this.pos)} remain`,
      )
    }
  }

  /**
   * Read a base-128 varint as a bigint.
   *
   * Capped at 10 bytes: that is the maximum a valid 64-bit varint occupies.
   * Without the cap a crafted run of 0x80 bytes is an unbounded loop — the
   * cheapest possible DoS against a protobuf endpoint.
   */
  readVarint(): bigint {
    let result = B0
    let shift = B0
    for (let i = 0; i < 10; i++) {
      this.require(1)
      // `require(1)` has already proven this index is in range; reading it
      // through a defined-check rather than a non-null assertion keeps the
      // lint rule honest without a suppression comment.
      const byte = this.buf[this.pos]
      if (byte === undefined) throw new ProtobufDecodeError('unexpected end of buffer')
      this.pos++
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += B7
    }
    throw new ProtobufDecodeError('varint longer than 10 bytes')
  }

  /** Varint narrowed to a JS number. Values above 2^53-1 are a decode error. */
  readVarintAsNumber(): number {
    const v = this.readVarint()
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProtobufDecodeError('varint exceeds safe integer range')
    }
    return Number(v)
  }

  /** `fixed64` — 8 bytes little-endian. OTLP uses this for span timestamps. */
  readFixed64(): bigint {
    this.require(8)
    const v = this.view.getBigUint64(this.pos, true)
    this.pos += 8
    return v
  }

  readFixed32(): number {
    this.require(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  readDouble(): number {
    this.require(8)
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }

  /**
   * Read a length-delimited field's byte range WITHOUT copying.
   *
   * The declared length is checked against the remaining buffer before the
   * cursor moves. A field claiming 2 GB inside a 200-byte body fails here,
   * before anything is allocated.
   */
  readLengthDelimitedRange(): { start: number; end: number } {
    const len = this.readVarint()
    if (len > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProtobufDecodeError('length-delimited field length exceeds safe integer range')
    }
    const n = Number(len)
    this.require(n)
    const start = this.pos
    this.pos += n
    return { start, end: start + n }
  }

  /** A sub-reader over a length-delimited field. Shares the parent's buffer. */
  readMessage(): ProtoReader {
    const { start, end } = this.readLengthDelimitedRange()
    return new ProtoReader(this.buf, start, end)
  }

  readBytes(): Uint8Array {
    const { start, end } = this.readLengthDelimitedRange()
    return this.buf.subarray(start, end)
  }

  /**
   * UTF-8 string. NON-fatal decoding on purpose: an exporter that emits a
   * lone surrogate in a span name should get its span recorded with U+FFFD,
   * not have the whole batch 400'd. Malformed *framing* is fatal; malformed
   * *text* is not.
   */
  readString(): string {
    const { start, end } = this.readLengthDelimitedRange()
    return TEXT_DECODER.decode(this.buf.subarray(start, end))
  }

  /** Read a tag, returning the field number and wire type. */
  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readVarintAsNumber()
    const fieldNumber = tag >>> 3
    const wireType = tag & 0x07
    if (fieldNumber === 0) throw new ProtobufDecodeError('field number 0 is invalid')
    if (wireType === 3 || wireType === 4) {
      throw new ProtobufDecodeError('group wire types (3/4) are not supported')
    }
    if (wireType !== WIRE_VARINT && wireType !== WIRE_FIXED64 &&
        wireType !== WIRE_LENGTH_DELIMITED && wireType !== WIRE_FIXED32) {
      throw new ProtobufDecodeError(`unknown wire type ${String(wireType)}`)
    }
    return { fieldNumber, wireType }
  }

  /**
   * Skip a field of the given wire type.
   *
   * Forward compatibility is a protobuf REQUIREMENT, not a nicety: OTLP adds
   * fields between minor versions, and an exporter one version ahead of us
   * must not get its whole batch rejected. Unknown fields are skipped, never
   * errors.
   */
  skipField(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT: this.readVarint(); return
      case WIRE_FIXED64: this.require(8); this.pos += 8; return
      case WIRE_LENGTH_DELIMITED: this.readLengthDelimitedRange(); return
      case WIRE_FIXED32: this.require(4); this.pos += 4; return
      default: throw new ProtobufDecodeError(`cannot skip wire type ${String(wireType)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Writer — only enough to emit ExportTraceServiceResponse.
// ---------------------------------------------------------------------------

/** Accumulates protobuf bytes. Only the field types the response message uses. */
export class ProtoWriter {
  private readonly chunks: number[] = []

  private writeVarint(value: bigint): void {
    let v = value
    if (v < B0) {
      // Two's complement over 64 bits — proto3 encodes negative int64 as a
      // 10-byte varint. Reachable only if a caller passes a negative count,
      // which would itself be a bug, but encoding it wrongly would corrupt
      // every following field rather than failing loudly.
      v = (BigInt(1) << B64) + v
    }
    do {
      let byte = Number(v & B0X7F)
      v >>= B7
      if (v > B0) byte |= 0x80
      this.chunks.push(byte)
    } while (v > B0)
  }

  private writeTag(fieldNumber: number, wireType: number): void {
    this.writeVarint(BigInt((fieldNumber << 3) | wireType))
  }

  /** proto3 `int64`. */
  writeInt64(fieldNumber: number, value: number | bigint): void {
    this.writeTag(fieldNumber, WIRE_VARINT)
    this.writeVarint(typeof value === 'bigint' ? value : BigInt(Math.trunc(value)))
  }

  writeString(fieldNumber: number, value: string): void {
    const bytes = TEXT_ENCODER.encode(value)
    this.writeTag(fieldNumber, WIRE_LENGTH_DELIMITED)
    this.writeVarint(BigInt(bytes.length))
    for (const b of bytes) this.chunks.push(b)
  }

  writeMessage(fieldNumber: number, inner: ProtoWriter): void {
    const bytes = inner.finish()
    this.writeTag(fieldNumber, WIRE_LENGTH_DELIMITED)
    this.writeVarint(BigInt(bytes.length))
    for (const b of bytes) this.chunks.push(b)
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks)
  }
}
