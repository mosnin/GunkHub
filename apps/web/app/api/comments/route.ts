import { auth } from '@clerk/nextjs/server'
import { NextRequest, NextResponse } from 'next/server'
import type { CreateCommentRequest, CreateCommentResponse, ApiError } from '@agent-flight-recorder/contracts'
import { createComment } from '@/lib/services/comments'

export async function POST(req: NextRequest) {
  const { userId, orgId } = await auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
  }

  let body: CreateCommentRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json<ApiError>({ code: 'INVALID_BODY', message: 'Request body must be valid JSON' }, { status: 400 })
  }

  if (!body.targetId) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'targetId is required' }, { status: 422 })
  }
  if (!body.targetType) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'targetType is required' }, { status: 422 })
  }
  if (!body.content) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'content is required' }, { status: 422 })
  }

  const result = await createComment(body)
  return NextResponse.json<CreateCommentResponse>(result, { status: 201 })
}
