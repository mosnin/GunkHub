import { auth } from '@clerk/nextjs/server'
import { NextRequest, NextResponse } from 'next/server'
import type { ListEventsResponse, ApiError, EventType } from '@agent-flight-recorder/contracts'
import { listEvents } from '@/lib/services/events'

interface RouteParams {
  params: { id: string }
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { userId, orgId } = await auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
  }

  const searchParams = req.nextUrl.searchParams
  const typesParam = searchParams.get('types')
  const types: EventType[] | undefined = typesParam
    ? (typesParam.split(',').map((t: string) => t.trim()) as EventType[])
    : undefined

  const result = await listEvents({
    runId: params.id,
    limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
    cursor: searchParams.get('cursor') ?? undefined,
    types,
  })

  return NextResponse.json<ListEventsResponse>(result)
}
