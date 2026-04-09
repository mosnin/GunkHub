import { auth } from '@clerk/nextjs/server'
import { NextRequest, NextResponse } from 'next/server'
import type { GetRunResponse, ApiError } from '@agent-flight-recorder/contracts'
import { getRun } from '@/lib/services/runs'

interface RouteParams {
  params: { id: string }
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { userId, orgId } = await auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
  }

  const result = await getRun(params.id)

  if (!result.run.id) {
    return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 })
  }

  return NextResponse.json<GetRunResponse>(result)
}
