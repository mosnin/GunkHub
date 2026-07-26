/**
 * resolutionFieldValidation.ts — pure validator for the `note`/`ref` body
 * fields on `POST /api/patterns/[fingerprint]/resolve` (Resolution lifecycle,
 * docs/adr/006-failure-resolution.md, cycle 1).
 *
 * Deliberately dependency-free (no `next/server`, no `@clerk/nextjs/server`,
 * no Convex import) so it is unit-testable without any Next.js/Clerk/Convex
 * runtime — mirrors why fingerprintValidation.ts / apiAuthGuard.ts are split
 * out the same way.
 *
 * The length ceilings here (2048 chars each) are a WEB-SIDE mirror of
 * convex/helpers/pagination.ts's `MAX_RESOLUTION_NOTE_LENGTH` /
 * `MAX_RESOLUTION_REF_LENGTH` — not an import of them, since apps/web does
 * not import from convex/** (convex/** is Team A's boundary, web only talks
 * to it over the Convex client). Keeping the same numeric ceiling here lets
 * the route reject an oversized body with a fast, clear 422 before ever
 * calling Convex; convex/failure_patterns.ts's `resolvePattern` re-validates
 * the same bound server-side regardless (defense in depth — this layer is
 * not the sole enforcement point), throwing `afrError("INVALID_ARGUMENT",
 * ...)`, which `mapApiError` maps to 422 too. If Team A ever changes the
 * Convex-side ceiling, update this constant to match.
 *
 * `ref` is deliberately treated as opaque text throughout this stack: it is
 * never parsed as a URL, never fetched/followed, even when it looks like one
 * (e.g. an https:// link). Rendering it as a link, if ever, is a UI-layer
 * decision made elsewhere — this layer only bounds its length and type.
 */

/** Mirrors convex/helpers/pagination.ts's MAX_RESOLUTION_NOTE_LENGTH. */
export const MAX_RESOLUTION_NOTE_LENGTH = 2 * 1024
/** Mirrors convex/helpers/pagination.ts's MAX_RESOLUTION_REF_LENGTH. */
export const MAX_RESOLUTION_REF_LENGTH = 2 * 1024

/**
 * Generous upper bound on a Convex `Id<"agent_versions">` string (cycle 2).
 * Convex document ids are ~32 chars in practice; this is a sanity ceiling to
 * reject obviously-junk input, NOT an attempt to pin down the id format.
 */
export const MAX_RESOLUTION_VERSION_ID_LENGTH = 128

/**
 * Permissive Convex-id shape check. Deliberately loose (same reasoning as
 * fingerprintValidation.ts's width-permissive hex pattern): the point is to
 * reject empty strings, whitespace, and path-traversal-ish junk before a
 * pointless round-trip — NOT to duplicate Convex's own id parsing, and NOT to
 * decide whether the id EXISTS or is OWNED by the caller's org. That
 * authorization question is answered server-side and only server-side, by
 * convex/failure_patterns.ts's `validateResolutionVersion`.
 */
const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export interface ResolveBodyValidationError {
  message: string
}

/**
 * The declared shape of a validated resolve body. This interface is the
 * SINGLE declaration that both `validateResolveBody` (above) and
 * `services/failurePatterns.ts`'s `resolvePattern` forwarding spread are
 * driven from, and `tests/unit/failure_patterns_resolve_args.test.ts` is
 * table-driven over `keyof ValidatedResolveFields` — so a field added here
 * but dropped from either the validator or the forwarding spread fails a test
 * loudly instead of being silently ignored at runtime (that seam has no
 * compiler check; see convexFunctions.ts's header).
 */
export interface ValidatedResolveFields {
  note?: string
  ref?: string
  /**
   * The agent version the operator believes contains the fix. Forwarded to
   * Convex as the flat optional `versionId` arg (NOT nested), where it lands
   * on the rollup's `resolvedInVersionId` field.
   */
  versionId?: string
}

/**
 * Validates a raw, parsed JSON request body for `POST .../resolve`. Returns
 * either the validated (and only the validated) `{ note?, ref? }` fields, or
 * a single human-readable error message describing the first violation
 * found. `note`/`ref`/`versionId` are all optional — an empty body is valid
 * (resolve with none of them is allowed, exactly like Team A's Convex
 * mutation, which declares all three `v.optional(...)`).
 *
 * `versionId: null` is treated as ABSENT rather than as an error, so a UI
 * form that clears its "fixed in version" select can send an explicit null
 * without a 422. It is never forwarded to Convex as `null` — the forwarding
 * spread only emits keys that are actually present.
 *
 * This validator checks SHAPE ONLY for `versionId`. Whether the id exists,
 * belongs to the caller's org, or belongs to an agent this pattern was
 * observed on is decided exclusively by convex/failure_patterns.ts's
 * `validateResolutionVersion` — deliberately NOT duplicated here, because a
 * web-side ownership check would need to read another org's data to be
 * accurate and would turn this route into an existence oracle.
 */
export function validateResolveBody(
  body: unknown,
): ValidatedResolveFields | ResolveBodyValidationError {
  if (body === null || body === undefined) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { message: 'Request body must be a JSON object' }
  }
  const b = body as Record<string, unknown>

  let note: string | undefined
  if (b['note'] !== undefined) {
    if (typeof b['note'] !== 'string') {
      return { message: 'note must be a string' }
    }
    if (b['note'].length > MAX_RESOLUTION_NOTE_LENGTH) {
      return { message: `note must be at most ${String(MAX_RESOLUTION_NOTE_LENGTH)} characters` }
    }
    note = b['note']
  }

  let ref: string | undefined
  if (b['ref'] !== undefined) {
    if (typeof b['ref'] !== 'string') {
      return { message: 'ref must be a string' }
    }
    if (b['ref'].length > MAX_RESOLUTION_REF_LENGTH) {
      return { message: `ref must be at most ${String(MAX_RESOLUTION_REF_LENGTH)} characters` }
    }
    ref = b['ref']
  }

  let versionId: string | undefined
  if (b['versionId'] !== undefined && b['versionId'] !== null) {
    if (typeof b['versionId'] !== 'string') {
      return { message: 'versionId must be a string' }
    }
    if (!VERSION_ID_PATTERN.test(b['versionId'])) {
      return {
        message: `versionId must be a non-empty id of at most ${String(
          MAX_RESOLUTION_VERSION_ID_LENGTH,
        )} characters, without whitespace`,
      }
    }
    versionId = b['versionId']
  }

  return {
    ...(note !== undefined && { note }),
    ...(ref !== undefined && { ref }),
    ...(versionId !== undefined && { versionId }),
  }
}

export function isValidationError(
  result: ValidatedResolveFields | ResolveBodyValidationError,
): result is ResolveBodyValidationError {
  return 'message' in result
}
