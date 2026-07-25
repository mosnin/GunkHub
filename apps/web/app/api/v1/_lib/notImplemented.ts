/**
 * A v1-enveloped `NOT_IMPLEMENTED` for a route whose surface contract is real
 * but whose backend path does not exist in this deployment.
 *
 * ---------------------------------------------------------------------------
 * WHY A ROUTE WOULD EVER RETURN THIS RATHER THAN NOT EXISTING
 * ---------------------------------------------------------------------------
 *
 * A privileged mutation has exactly two acceptable behaviours: perform the act
 * and audit it, or fail LOUDLY. The one thing it must never do is look like it
 * worked. A route that is simply absent 404s, which a client reasonably reads
 * as "wrong URL" and a human reasonably reads as "not deployed yet" — but a
 * route that exists, authenticates, validates the body, and THEN says it cannot
 * complete has told the caller something true and specific, and has done it
 * without accepting a request it cannot honour.
 *
 * The ordering matters as much as the status. Auth and validation run FIRST, so
 * the surface a client integrates against is the real one: a missing key is
 * still a 401, a missing `reason` is still a 400, and those responses do not
 * change when the backend path lands. Only the final step changes.
 *
 * `message` must name what is missing and who owns it, so this is a work item
 * rather than a shrug.
 */
import { NextResponse } from 'next/server'

import { API_V1_VERSION } from '@/lib/apiV1Envelope'

export function v1NotImplemented(message: string, requestId: string): NextResponse {
  return NextResponse.json(
    {
      apiVersion: API_V1_VERSION,
      error: { code: 'NOT_IMPLEMENTED', message, details: { requestId } },
    },
    { status: 501, headers: { 'x-request-id': requestId } },
  )
}
