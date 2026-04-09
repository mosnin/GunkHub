import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, EventType, ListEventsResponse } from '@agent-flight-recorder/contracts'

import { listEvents } from '@/lib/services/events'

interface RouteParams {
  params: { id: string }
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { userId, orgId } = auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
  }

  const searchParams = req.nextUrl.searchParams
  const typesParam = searchParams.get('types')
  const types: EventType[] | undefined = typesParam
    ? (typesParam.split(',').map((t: string) => t.trim()) as EventType[])
    : undefined

  try {
    const result = await listEvents({
      runId: params.id,
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor') ?? undefined,
      types,
    })

    return NextResponse.json<ListEventsResponse>(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message.includes('not found') || message.includes('Not found')) {
      return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 })
    }
    return NextResponse.json<ApiError>({ code: 'INTERNAL_ERROR', message }, { status: 500 })
  }
}
