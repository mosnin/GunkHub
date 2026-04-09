import { auth } from '@clerk/nextjs/server'
import { NextRequest, NextResponse } from 'next/server'
import type { CreateEventRequest, CreateEventResponse, ApiError } from '@agent-flight-recorder/contracts'
import { createEvent } from '@/lib/services/events'

export async function POST(req: NextRequest) {
  const { userId, orgId } = await auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
  }

  let body: CreateEventRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json<ApiError>({ code: 'INVALID_BODY', message: 'Request body must be valid JSON' }, { status: 400 })
  }

  if (!body.runId) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'runId is required' }, { status: 422 })
  }
  if (!body.type) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'type is required' }, { status: 422 })
  }
  if (body.sequenceNumber == null) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'sequenceNumber is required' }, { status: 422 })
  }
  if (body.timestamp == null) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'timestamp is required' }, { status: 422 })
  }
  if (body.payload == null) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'payload is required' }, { status: 422 })
  }

  const result = await createEvent(body)
  return NextResponse.json<CreateEventResponse>(result, { status: 201 })
}
