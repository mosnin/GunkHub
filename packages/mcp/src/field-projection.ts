/**
 * Sending `fields` WITHOUT making the tool depend on the server honoring it.
 *
 * THE PROBLEM THIS SOLVES. `FlightReader` verifies that a projection was
 * actually applied: if a response carries a field outside `requested ∪ {id}`,
 * the deployment silently dropped the unknown `?fields=` query parameter and
 * returned the full document, and the SDK throws `invalid_response` rather than
 * hand back a full document dressed as a projection. That refusal is right for
 * a generic caller — one that reads `run.status` cannot tell the two apart, and
 * would conclude a field is absent when it was merely never projected.
 *
 * IT IS NOT RIGHT HERE. This server re-projects every response client-side
 * anyway (`projections.ts`), so a full document is a CORRECT input, just an
 * expensive one. Letting the SDK's refusal propagate would mean adopting
 * server-side projection turned a working tool into a failing one on every
 * deployment that predates it — trading a real capability for an efficiency.
 *
 * So: ask for the projection, and if this deployment cannot do it, ask again
 * without it. One wasted round trip, on a deployment that was going to be the
 * expensive path regardless, and the tool's output is byte-identical either
 * way.
 */
import { V1ApiError } from '@agent-flight-recorder/sdk'

/**
 * True for the SDK's "this deployment ignored the projection" refusal.
 *
 * Discriminated by the ABSENT `status`, not by any particular code: the SDK
 * raises this one client-side after inspecting the body, so it has no HTTP
 * status at all, while every server-side rejection carries one. The server's
 * two rejections are themselves distinct, and the split is meaningful —
 *
 *   - **400** for a route-level SHAPE error (empty `?fields=`, an empty or
 *     whitespace-padded entry, a duplicate, a repeated parameter), rejected
 *     inline before the API key is even resolved: "your request was malformed";
 *   - **422** for an unknown field NAME, which Convex raises as
 *     `INVALID_ARGUMENT` and `apps/web/src/lib/apiErrorMapping.ts` maps to 422
 *     on every v1 route: "your request was well-formed and asked for something
 *     that does not exist".
 *
 * Discriminating on `status === undefined` covers both without this package
 * holding an opinion about either number — and it is what keeps the retry below
 * from papering over a genuinely bad request. A wrong field name still fails
 * loudly, as read API rule 2 requires.
 */
export function isProjectionUnsupported(err: unknown): boolean {
  return err instanceof V1ApiError && err.kind === 'invalid_response' && err.status === undefined
}

/**
 * Run a read with a field selection, retrying once without it if the deployment
 * cannot project.
 *
 * @param fields - the selection, DERIVED from the caller's column table.
 * @param call - performs the read. Receives the selection, or `undefined` on
 *   the retry, and must forward it verbatim.
 * @returns whatever `call` returns.
 * @throws whatever `call` throws, unchanged, for every error other than the
 *   one-off "projection ignored" refusal — including the 422 for an unknown
 *   field name, which is a bug in the column table and must surface.
 */
export async function withFieldProjection<T>(
  fields: readonly string[],
  call: (selection: string[] | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await call([...fields])
  } catch (err) {
    if (!isProjectionUnsupported(err)) throw err
    return await call(undefined)
  }
}
