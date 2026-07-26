/**
 * apiKeyScopes.ts — the `scopes` request-validation contract for
 * `POST /api/api-keys`. Deliberately dependency-free (no `next/server`, no
 * Clerk, no Convex client) so it is unit-testable without a Next.js runtime
 * or a live Convex deployment — same rationale as apiAuthGuard.ts's
 * hasOrgAuthContext (see tests/unit/management_route_auth.test.ts and this
 * file's own tests/unit/api_keys_scopes.test.ts).
 *
 * Mirrors convex/api_keys.ts's API_KEY_SCOPES (ADR-002) exactly. That file
 * is the actual enforcement point — createApiKey validates scopes again
 * server-side regardless of what this module allows — so this is purely a
 * fail-fast, better-error-message layer: a bad request 422s here before it
 * ever reaches Convex. Keep the two lists in sync if either changes.
 */

/** Every scope an API key may be granted, mirroring convex/api_keys.ts's API_KEY_SCOPES. */
export const ALLOWED_KEY_SCOPES = ['ingest:write', 'ingest:read', 'read'] as const
export type ApiKeyScope = (typeof ALLOWED_KEY_SCOPES)[number]

/**
 * Scopes applied when the caller omits `scopes` entirely from a create-key
 * request. Explicitly `["ingest:write"]` rather than leaving `scopes`
 * undefined (which convex/api_keys.ts treats as unrestricted back-compat
 * access, including `read`) — preserves the pre-existing behavior that a
 * key minted without any scope selection is an ingest key, and does not
 * silently also grant `read` now that it's a selectable scope.
 */
export const DEFAULT_KEY_SCOPES: readonly ApiKeyScope[] = ['ingest:write']

export type ResolveScopesResult =
  | { ok: true; scopes: ApiKeyScope[] }
  | { ok: false; error: string }

/**
 * Validate and normalize the `scopes` field of a create-key request body.
 * - `undefined`/omitted -> DEFAULT_KEY_SCOPES (`["ingest:write"]`).
 * - An array -> must be a non-empty subset of ALLOWED_KEY_SCOPES, returned as-is.
 * - Anything else (wrong type, non-string entries, unknown scope names) -> error.
 */
export function resolveRequestedScopes(rawScopes: unknown): ResolveScopesResult {
  if (rawScopes === undefined) {
    return { ok: true, scopes: [...DEFAULT_KEY_SCOPES] }
  }
  if (!Array.isArray(rawScopes)) {
    return { ok: false, error: 'scopes must be an array of strings' }
  }
  if (rawScopes.length === 0) {
    return { ok: false, error: 'scopes must not be empty (omit the field entirely for the default)' }
  }
  const invalid = rawScopes.filter(
    (s) => typeof s !== 'string' || !(ALLOWED_KEY_SCOPES as readonly string[]).includes(s),
  )
  if (invalid.length > 0) {
    return { ok: false, error: `invalid scope(s): ${invalid.join(', ')}` }
  }
  return { ok: true, scopes: rawScopes as ApiKeyScope[] }
}
