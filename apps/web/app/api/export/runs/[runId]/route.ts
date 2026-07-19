import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { withApiHandler } from '@/lib/apiHandler'
import {
  contentTypeForFormat,
  exportContentDisposition,
  runBundleArtifactLine,
  runBundleCommentLine,
  runBundleEventLine,
  runBundleRunLine,
  runBundleVerificationLine,
} from '@/lib/exportFormat'
import { listArtifacts } from '@/lib/services/artifacts'
import { listComments } from '@/lib/services/comments'
import { listEvents } from '@/lib/services/events'
import { getRunVerificationStatus } from '@/lib/services/projection_verify'
import { getRun } from '@/lib/services/runs'

interface RouteParams {
  params: { runId: string }
}

const EVENTS_PAGE_SIZE = 500

// ---------------------------------------------------------------------------
// GET /api/export/runs/[runId] — full single-run export bundle as ndjson.
//
// One line per record, each tagged with a `record` discriminator (run,
// event, artifact, comment, verification) — see exportFormat.ts. ndjson is
// used (rather than a single JSON document) so a run with a very large
// event log can be streamed to the client as each internally-paginated
// `listEvents` page comes back, instead of buffering the whole run in
// memory. Org scoping and 404-on-cross-org behavior come from the existing
// `getRun`/`listEvents`/etc. services — identical to the regular run routes.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/export/runs/[runId]',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const { userId, orgId } = auth()
    if (!userId || !orgId) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    ctx.setOrgId(orgId)

    let runResult: Awaited<ReturnType<typeof getRun>>
    try {
      runResult = await getRun(params.runId)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (message.includes('not found') || message.includes('Not found')) {
        return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 })
      }
      throw err
    }

    const runId = params.runId
    const encoder = new TextEncoder()

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(runBundleRunLine(runResult.run)))

          // Events — paginate internally via the existing listEvents service
          // so an event log of any size is streamed page by page.
          let cursor: string | undefined
          for (;;) {
            const page = await listEvents({
              runId,
              limit: EVENTS_PAGE_SIZE,
              ...(cursor !== undefined && { cursor }),
            })
            for (const event of page.events) {
              controller.enqueue(encoder.encode(runBundleEventLine(event)))
            }
            cursor = page.nextCursor
            if (!cursor || page.events.length === 0) break
          }

          const { artifacts } = await listArtifacts(runId)
          for (const artifact of artifacts) {
            controller.enqueue(encoder.encode(runBundleArtifactLine(artifact)))
          }

          // Run-level comments only (comments on individual events are not
          // enumerated — there is no existing "all comments for a run,
          // including its events" query; adding one is out of scope for this
          // cycle, which only wires existing queries).
          const comments = await listComments(runId, 'run')
          for (const comment of comments) {
            controller.enqueue(encoder.encode(runBundleCommentLine(comment)))
          }

          const verification = await getRunVerificationStatus(runId)
          controller.enqueue(
            encoder.encode(
              runBundleVerificationLine({
                verified: verification.verified,
                isValid: verification.isValid,
                verifiedAt: verification.verifiedAt,
                summary: verification.summary,
              }),
            ),
          )

          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'content-type': contentTypeForFormat('ndjson'),
        'content-disposition': exportContentDisposition(`run-${runId}-export.ndjson`),
      },
    })
  },
  // Same heavy-export rate class as GET /api/export/runs — this route also
  // does an unbounded-ish amount of paginated Convex work per request (full
  // event log + artifacts + comments for one run), streamed but not cheap.
  // Without this override it fell back to the default GET class (300/min),
  // which does not reflect the actual cost of this endpoint.
  { rateLimit: { key: 'org', limitPerMin: 10 } },
)
