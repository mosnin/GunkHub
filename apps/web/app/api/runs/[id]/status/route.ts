import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { mapAfrErrorResponse, withApiHandler } from '@/lib/apiHandler'
import { convex } from '@/lib/convexFunctions'
import { getPublicClient, hashApiKey } from '@/lib/convexServer'

interface RouteParams {
  params: { id: string }
}

// PATCH /api/runs/:id/status — update run status from the SDK (x-api-key auth)
export const PATCH = withApiHandler(
  '/api/runs/[id]/status',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
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

    const status = body['status']
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'status must be completed, failed, or cancelled' },
        { status: 422 }
      )
    }

    try {
      const client = getPublicClient()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      await client.mutation(convex.sdk_ingest.sdkUpdateRunStatus, {
        apiKeyHash: hashApiKey(apiKey),
        runId: params.id,
        status,
        ...(body['endedAt'] !== undefined && { endedAt: body['endedAt'] as number }),
      })

      return new NextResponse(null, { status: 204 })
    } catch (err) {
      const mapped = mapAfrErrorResponse(err, ctx.requestId)
      if (mapped) return mapped
      if (err instanceof Error && err.message === 'Unauthorized') {
        return NextResponse.json<ApiError>(
          { code: 'UNAUTHORIZED', message: 'Invalid API key' },
          { status: 401 }
        )
      }
      throw err
    }
  },
  { rateLimit: { key: 'apiKey', limitPerMin: 120 } }
)
