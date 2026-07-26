import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, Run } from '@agent-flight-recorder/contracts'

import { withApiHandler } from '@/lib/apiHandler'
import {
  EXPORT_TRUNCATED_HEADER,
  buildCsvHeaderRow,
  contentTypeForFormat,
  exportContentDisposition,
  fileExtensionForFormat,
  isExportTruncated,
  parseRunExportFilters,
  runToCsvRow,
  toNdjsonLine,
} from '@/lib/exportFormat'
import { listRuns } from '@/lib/services/runs'

// ---------------------------------------------------------------------------
// GET /api/export/runs — bulk run export (Clerk-authed), format=json|csv|ndjson
//
// Exports are heavy (each request may page through up to EXPORT_MAX_LIMIT
// runs), so this route uses a stricter rate limit than the default read
// class — see the `rateLimit` option below.
//
// Streaming design note: to set the `x-export-truncated` response header
// correctly, truncation must be known BEFORE the streamed body begins, so
// this route pre-fetches up to `limit + 1` run summaries (bounded by
// EXPORT_MAX_LIMIT + 1 = 5001 — never unbounded) via the existing paginated
// `listRuns` service, then streams the formatted output back to the client
// chunk by chunk instead of building one giant string in memory. This never
// buffers the org's full run history — only ever the capped export window.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/export/runs',
  async (req: NextRequest, ctx) => {
    const { userId, orgId } = auth()
    if (!userId || !orgId) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    ctx.setOrgId(orgId)

    const filters = parseRunExportFilters(req.nextUrl.searchParams)
    const capPlusOne = filters.limit + 1

    const runs: Run[] = []
    let cursor: string | undefined
    for (;;) {
      const pageSize = Math.min(200, capPlusOne - runs.length)
      if (pageSize <= 0) break
      const page = await listRuns({
        ...(filters.status !== undefined && { status: filters.status }),
        ...(filters.agentId !== undefined && { agentId: filters.agentId }),
        ...(filters.projectId !== undefined && { projectId: filters.projectId }),
        limit: pageSize,
        ...(cursor !== undefined && { cursor }),
      })
      runs.push(...page.runs)
      cursor = page.nextCursor
      if (!cursor || page.runs.length === 0 || runs.length >= capPlusOne) break
    }

    const truncated = isExportTruncated(runs.length, filters.limit)
    const rows = truncated ? runs.slice(0, filters.limit) : runs

    const encoder = new TextEncoder()
    const format = filters.format
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (format === 'csv') {
          controller.enqueue(encoder.encode(`${buildCsvHeaderRow()}\n`))
          for (const run of rows) {
            controller.enqueue(encoder.encode(`${runToCsvRow(run)}\n`))
          }
        } else if (format === 'ndjson') {
          for (const run of rows) {
            controller.enqueue(encoder.encode(toNdjsonLine(run)))
          }
        } else {
          // json — a single array document. Bounded by EXPORT_MAX_LIMIT, so
          // building it in one pass is safe.
          controller.enqueue(encoder.encode(JSON.stringify(rows)))
        }
        controller.close()
      },
    })

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'content-type': contentTypeForFormat(format),
        'content-disposition': exportContentDisposition(`runs-export.${fileExtensionForFormat(format)}`),
        ...(truncated ? { [EXPORT_TRUNCATED_HEADER]: 'true' } : {}),
      },
    })
  },
  { rateLimit: { key: 'org', limitPerMin: 10 } },
)
