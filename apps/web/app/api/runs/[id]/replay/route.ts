import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, GetReplayResponse } from '@agent-flight-recorder/contracts'

import { getReplayProjection } from '@/lib/services/replay'

interface RouteParams {
  params: { id: string }
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { userId, orgId } = auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 }
    )
  }

  try {
    const result = await getReplayProjection(params.id)
    return NextResponse.json<GetReplayResponse>(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message.includes('not found') || message.includes('Not found')) {
      return NextResponse.json<ApiError>(
        { code: 'NOT_FOUND', message: 'Run not found' },
        { status: 404 }
      )
    }
    return NextResponse.json<ApiError>({ code: 'INTERNAL_ERROR', message }, { status: 500 })
  }
}
