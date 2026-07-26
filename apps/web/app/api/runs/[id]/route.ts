import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, GetRunResponse } from '@agent-flight-recorder/contracts'

import { withApiHandler } from '@/lib/apiHandler'
import { getRun } from '@/lib/services/runs'

interface RouteParams {
  params: { id: string }
}

export const GET = withApiHandler(
  '/api/runs/[id]',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const { userId, orgId } = auth()
    if (!userId || !orgId) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      )
    }
    ctx.setOrgId(orgId)

    try {
      const result = await getRun(params.id)
      return NextResponse.json<GetRunResponse>(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (message.includes('not found') || message.includes('Not found')) {
        return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 })
      }
      throw err
    }
  }
)
