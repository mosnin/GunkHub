// ---------------------------------------------------------------------------
// Bounds for the OTLP ingest path.
//
// Every constant here exists because the endpoint accepts a COMPRESSED,
// BINARY body from an arbitrary exporter before any of it has been
// authenticated as well-formed. The ordering of the checks matters as much as
// the values: see body.ts.
// ---------------------------------------------------------------------------

/**
 * Maximum COMPRESSED (on-the-wire) request body, in bytes.
 *
 * The OTLP spec puts no ceiling on export size and leaves it to the receiver;
 * the OTel Collector's own default for `max_request_body_size` is 20 MiB. 4 MiB
 * is deliberately tighter: a batch this large is already ~10k spans, well past
 * the point where a smaller `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` is the right fix,
 * and every byte past it is a byte we buffer for an unauthenticated caller.
 *
 * Exceeding this is 413 — NON-retryable per the OTLP spec, which is the honest
 * answer: retrying the identical body will fail identically forever.
 */
export const MAX_COMPRESSED_BODY_BYTES = 4 * 1024 * 1024

/**
 * Maximum DECOMPRESSED body, in bytes.
 *
 * THIS is the decompression-bomb bound. Bounding only the wire size is the
 * classic mistake: gzip's maximum ratio is ~1032:1, so a 4 MiB compressed body
 * can legally expand to ~4 GiB. A body of `\0` repeated compresses to almost
 * nothing and would OOM the process long before any protobuf parsing happened.
 *
 * Enforced by counting bytes as they leave the decompressor and cancelling the
 * stream the moment the budget is exceeded — never by decompressing fully and
 * then measuring, which is the bug the bound exists to prevent.
 */
export const MAX_DECOMPRESSED_BODY_BYTES = 16 * 1024 * 1024

/**
 * Maximum spans accepted in one export request.
 *
 * A bound on COUNT as well as on bytes: 16 MiB of minimal spans is on the
 * order of 10^5 spans, and each one becomes at least one row in an append-only
 * table. Exceeding this is a PARTIAL SUCCESS (200 + `rejected_spans`), not an
 * error — the spans we did take are durably recorded, and telling the exporter
 * "failed" would make it retry the whole batch and duplicate them.
 */
export const MAX_SPANS_PER_REQUEST = 10_000

/**
 * Maximum nesting depth when decoding an OTLP `AnyValue`.
 *
 * `AnyValue` is mutually recursive with `ArrayValue`/`KeyValueList`, so a
 * crafted body can nest to whatever depth its byte budget allows and blow the
 * decoder's stack. Real GenAI attributes nest 2-3 deep.
 */
export const MAX_ANY_VALUE_DEPTH = 16

/** Maximum attributes read off a single span. Beyond this they are dropped. */
export const MAX_ATTRIBUTES_PER_SPAN = 256

/**
 * `Retry-After`, in seconds, on the retryable failures (429 / 503).
 *
 * Matches the hard-coded `'60'` every other route in this app emits
 * (apps/web/src/lib/apiHandler.ts). The in-memory limiter
 * (apps/web/src/lib/rateLimit.ts) exposes only a boolean — there is no
 * remaining-token or time-to-refill signal to compute a real value from, so a
 * conservative fixed value is the honest choice rather than a fabricated one.
 */
export const RETRY_AFTER_SECONDS = 60

/** Content types this endpoint accepts, per the OTLP/HTTP spec. */
export const CONTENT_TYPE_PROTOBUF = 'application/x-protobuf'
export const CONTENT_TYPE_JSON = 'application/json'
