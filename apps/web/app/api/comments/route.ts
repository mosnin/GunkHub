import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, CreateCommentRequest, CreateCommentResponse } from '@agent-flight-recorder/contracts'

import { mapAfrErrorResponse, withApiHandler } from '@/lib/apiHandler'
import { createComment } from '@/lib/services/comments'

export const POST = withApiHandler(
  '/api/comments',
  async (req: NextRequest, ctx) => {
    const { userId, orgId } = auth()
    if (!userId || !orgId) {
      return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
    }
    ctx.setOrgId(orgId)

    let body: CreateCommentRequest
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      body = await req.json()
    } catch {
      return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, { status: 400 })
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

    try {
      const result = await createComment(body)
      return NextResponse.json<CreateCommentResponse>(result, { status: 201 })
    } catch (err) {
      // Stable afrError codes from Convex (e.g. COMMENT_LIMIT_EXCEEDED → 422).
      const mapped = mapAfrErrorResponse(err, ctx.requestId)
      if (mapped) return mapped
      const message = err instanceof Error ? err.message : ''
      if (message === 'Not authenticated' || message.includes('Unauthorized')) {
        return NextResponse.json<ApiError>({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 })
      }
      if (message.includes('not found') || message.includes('Not found')) {
        return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'Target not found' }, { status: 404 })
      }
      throw err
    }
  }
)
