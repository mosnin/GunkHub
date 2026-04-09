import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getPublicClient, hashApiKey } from '@/lib/convexServer'

interface RouteParams {
  params: { id: string }
}

// PATCH /api/runs/:id/status — update run status from the SDK (x-api-key auth)
export async function PATCH(req: NextRequest, { params }: RouteParams) {
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
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message === 'Unauthorized') {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Invalid API key' },
        { status: 401 }
      )
    }
    return NextResponse.json<ApiError>({ code: 'INTERNAL_ERROR', message }, { status: 500 })
  }
}
