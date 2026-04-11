import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { listAgentVersionsPaginated } from '@/lib/services/agent_versions'

interface RouteParams {
  params: { agentId: string }
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { userId, orgId } = auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
  }

  const searchParams = req.nextUrl.searchParams
  const cursor = searchParams.get('cursor')
  const numItems = searchParams.get('limit') ? Number(searchParams.get('limit')) : 20

  try {
    const result = await listAgentVersionsPaginated(params.agentId, cursor, numItems)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message.includes('not found') || message.includes('Not found')) {
      return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'Agent not found' }, { status: 404 })
    }
    return NextResponse.json<ApiError>({ code: 'INTERNAL_ERROR', message }, { status: 500 })
  }
}
