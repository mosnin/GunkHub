// ---------------------------------------------------------------------------
// Wire protocol versioning
// ---------------------------------------------------------------------------

/**
 * Version of the SDK ↔ backend wire protocol.
 *
 * Sent by the SDK as the `x-afr-protocol` header on every request so future
 * backends can gate or branch on the protocol a client speaks. Bump this ONLY
 * when the request/response shapes change incompatibly (new required fields,
 * renamed endpoints, changed semantics) — additive, backwards-compatible
 * changes do not bump it.
 *
 * The backend does not currently enforce this header; it exists so enforcement
 * can be introduced without a coordinated client upgrade.
 */
export const PROTOCOL_VERSION = 1;

/** HTTP header name carrying {@link PROTOCOL_VERSION} on every SDK request. */
export const PROTOCOL_VERSION_HEADER = "x-afr-protocol";
