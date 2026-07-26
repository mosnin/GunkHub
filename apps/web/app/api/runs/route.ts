import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, ListRunsResponse } from '@agent-flight-recorder/contracts'

import { mapAfrErrorResponse, withApiHandler } from '@/lib/apiHandler'
import { convex } from '@/lib/convexFunctions'
import { getPublicClient, hashApiKey } from '@/lib/convexServer'
import { listRuns } from '@/lib/services/runs'

// ---------------------------------------------------------------------------
// GET /api/runs — list runs for the authenticated org (Clerk auth)
// ---------------------------------------------------------------------------
export const GET = withApiHandler('/api/runs', async (req: NextRequest, ctx) => {
  const { userId, orgId } = auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 }
    )
  }
  ctx.setOrgId(orgId)

  const searchParams = req.nextUrl.searchParams
  const result = await listRuns({
    status: (searchParams.get('status') as ListRunsResponse['runs'][0]['status']) ?? undefined,
    projectId: searchParams.get('projectId') ?? undefined,
    agentId: searchParams.get('agentId') ?? undefined,
    limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  })
  return NextResponse.json(result)
})

// ---------------------------------------------------------------------------
// POST /api/runs — create a run from the SDK (x-api-key auth)
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/runs',
  async (req: NextRequest, ctx) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'API key required' },
        { status: 401 }
      )
    }

    let body: Record<string, unknown>
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      body = await req.json()
    } catch {
      return NextResponse.json<ApiError>(
        { code: 'BAD_REQUEST', message: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    if (!body['agentId'] || typeof body['agentId'] !== 'string') {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'agentId is required' },
        { status: 422 }
      )
    }

    try {
      const client = getPublicClient()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const run = await client.mutation(convex.sdk_ingest.sdkCreateRun, {
        apiKeyHash: hashApiKey(apiKey),
        agentId: body['agentId'],
        ...(body['agentVersionId'] !== undefined && { agentVersionId: body['agentVersionId'] as string }),
        ...(body['metadata'] !== undefined && { metadata: body['metadata'] }),
        ...(body['tags'] !== undefined && { tags: body['tags'] as string[] }),
        ...(body['triggeredBy'] !== undefined && { triggeredBy: body['triggeredBy'] as string }),
        ...(body['sdkVersion'] !== undefined && { sdkVersion: body['sdkVersion'] as string }),
      })

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const runDoc = run as unknown as Record<string, unknown>
      return NextResponse.json(
        {
          run: {
            id: runDoc['id'] ?? runDoc['_id'],
            orgId: runDoc['orgId'],
            projectId: runDoc['projectId'],
            agentId: runDoc['agentId'],
            agentVersionId: runDoc['agentVersionId'],
            status: runDoc['status'],
            startedAt: runDoc['startedAt'],
            endedAt: runDoc['endedAt'],
            metadata: runDoc['metadata'] ?? {},
            tags: runDoc['tags'] ?? [],
            triggeredBy: runDoc['triggeredBy'],
            sdkVersion: runDoc['sdkVersion'],
          },
        },
        { status: 201 }
      )
    } catch (err) {
      const mapped = mapAfrErrorResponse(err, ctx.requestId)
      if (mapped) return mapped
      if (err instanceof Error && err.message === 'Unauthorized') {
        return NextResponse.json<ApiError>(
          { code: 'UNAUTHORIZED', message: 'Invalid API key' },
          { status: 401 }
        )
      }
      // Unknown error — rethrow so withApiHandler logs the detail and returns
      // a generic body (never the raw err.message).
      throw err
    }
  },
  { rateLimit: { key: 'apiKey', limitPerMin: 120 } }
)
