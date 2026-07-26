/**
 * `?fields=` query-param parsing for the v1 public read API.
 *
 * Lives in a `_`-prefixed folder so Next.js excludes it from routing (it is a
 * shared helper, not a route segment). Shared by every v1 read route that
 * supports server-side field projection, so the parse/reject rules cannot
 * drift between endpoints.
 *
 * THE ONE THING THIS MODULE DOES NOT DO: decide which field names are valid.
 * The set of projectable fields lives in `convex/read_api.ts` (Team A), which
 * raises `INVALID_ARGUMENT` naming the offending field and listing the valid
 * ones. Re-stating that list here would create a second source of truth that
 * can disagree with the first — the failure mode being a field the backend
 * happily projects that this layer rejects (or worse, the reverse). So this
 * module validates SHAPE only (is it a well-formed, non-empty, non-duplicated
 * comma list?) and forwards the names verbatim.
 *
 * REJECT, NEVER COERCE. Every ambiguous input below is rejected rather than
 * normalized, for the same reason `fromSequence` is (see
 * apps/web/app/api/v1/runs/[runId]/events/route.ts): a coerced value returns a
 * DIFFERENT answer than the caller asked for, and — unlike an error — the
 * caller cannot tell. Specifically:
 *   - `?fields=` (empty) is NOT "all fields". A caller who built an empty list
 *     and serialized it asked for nothing coherent; silently handing back the
 *     full document is the wrong-but-plausible answer this codebase has
 *     shipped before (`Number()`-style leniency).
 *   - `?fields=a,,b` / `?fields=a,` — a stray comma means the caller's
 *     serializer produced something it did not intend. Dropping the empty slot
 *     hides that.
 *   - `?fields=%20status` — trimming would accept two different query strings
 *     as the same request, and would mask a client joining with ", ".
 *   - `?fields=status,status` — a duplicate means the caller's field set was
 *     built twice or merged wrong; de-duplicating hides it.
 *   - `?fields=a&fields=b` — repeating the param would otherwise silently use
 *     only the first occurrence.
 *
 * OMITTED IS UNCHANGED. No `fields` param at all returns the full document,
 * byte-identical to before projection existed. Backward compatibility for
 * existing consumers is absolute here.
 */
import { NextResponse } from 'next/server'

export type FieldsParseResult = { ok: true; fields?: string[] } | { ok: false; message: string }

/**
 * Parse `?fields=a,b,c` off a request's search params.
 *
 * Returns `{ ok: true, fields: undefined }` when the param is absent (full
 * document), `{ ok: true, fields: [...] }` for a well-formed list forwarded
 * verbatim, or `{ ok: false, message }` for a malformed one. Never throws,
 * never trims, never de-duplicates, never defaults.
 */
export function parseFieldsParam(searchParams: URLSearchParams): FieldsParseResult {
  const all = searchParams.getAll('fields')
  if (all.length === 0) {
    // Omitted -> full document, unchanged.
    return { ok: true }
  }
  if (all.length > 1) {
    return {
      ok: false,
      message:
        'fields must be supplied at most once as a comma-separated list (e.g. fields=a,b); repeating the parameter is ambiguous',
    }
  }

  const raw = all[0] as string
  if (raw === '') {
    return {
      ok: false,
      message:
        'fields must not be empty; omit the fields parameter entirely to receive the full document',
    }
  }

  const entries = raw.split(',')
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry === '') {
      return {
        ok: false,
        message: 'fields must not contain an empty entry (check for a leading, trailing, or doubled comma)',
      }
    }
    if (entry.trim() === '') {
      return { ok: false, message: 'fields must not contain a whitespace-only entry' }
    }
    if (entry !== entry.trim()) {
      return {
        ok: false,
        message: `fields entry "${entry}" has leading or trailing whitespace; send field names without surrounding spaces`,
      }
    }
    if (seen.has(entry)) {
      return { ok: false, message: `fields contains a duplicate entry "${entry}"` }
    }
    seen.add(entry)
  }

  return { ok: true, fields: entries }
}

/**
 * The v1 routes' existing inline 400 idiom for a malformed query param — the
 * same body shape `fromSequence` rejection already uses on
 * `/api/v1/runs/[runId]/events` (`{ error: { code, message }, requestId }`),
 * kept identical so a client has one shape to parse for route-level argument
 * errors.
 *
 * TENANCY: this response is built BEFORE any Convex call, from the query
 * string alone. It therefore carries nothing about whether the addressed
 * record exists or which org owns it, and is byte-identical across "exists",
 * "does not exist", and "belongs to another org".
 */
export function fieldsInvalidArgument(message: string, requestId: string): NextResponse {
  return NextResponse.json(
    { error: { code: 'INVALID_ARGUMENT', message }, requestId },
    { status: 400 },
  )
}
