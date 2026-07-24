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

export interface ResolveBodyValidationError {
  message: string
}

export interface ValidatedResolveFields {
  note?: string
  ref?: string
}

/**
 * Validates a raw, parsed JSON request body for `POST .../resolve`. Returns
 * either the validated (and only the validated) `{ note?, ref? }` fields, or
 * a single human-readable error message describing the first violation
 * found. `note`/`ref` are both optional — an empty body is valid (resolve
 * with no note/ref is allowed, exactly like Team A's Convex mutation, which
 * declares both `v.optional(v.string())`).
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

  return { ...(note !== undefined && { note }), ...(ref !== undefined && { ref }) }
}

export function isValidationError(
  result: ValidatedResolveFields | ResolveBodyValidationError,
): result is ResolveBodyValidationError {
  return 'message' in result
}
