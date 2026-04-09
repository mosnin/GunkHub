import { auth } from '@clerk/nextjs/server'
import { NextRequest, NextResponse } from 'next/server'
import type { CreateRunRequest, CreateRunResponse, ApiError } from '@agent-flight-recorder/contracts'
import { listRuns, createRun } from '@/lib/services/runs'

export async function GET(req: NextRequest) {
  const { userId, orgId } = await auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
  }
  const searchParams = req.nextUrl.searchParams
  const result = await listRuns({
    projectId: searchParams.get('projectId') ?? undefined,
    agentId: searchParams.get('agentId') ?? undefined,
    status: searchParams.get('status') as any ?? undefined,
    limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  })
  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const { userId, orgId } = await auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
  }
  let body: CreateRunRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json<ApiError>({ code: 'INVALID_BODY', message: 'Request body must be valid JSON' }, { status: 400 })
  }
  if (!body.agentId) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'agentId is required' }, { status: 422 })
  }
  const result = await createRun(body)
  return NextResponse.json<CreateRunResponse>(result, { status: 201 })
}
