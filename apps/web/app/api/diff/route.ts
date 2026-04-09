import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, GetDiffResponse } from '@agent-flight-recorder/contracts'

import { getRunDiff } from '@/lib/services/diff'

export async function GET(req: NextRequest) {
  const { userId, orgId } = auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 }
    )
  }

  const left = req.nextUrl.searchParams.get('left')
  const right = req.nextUrl.searchParams.get('right')

  if (!left || !right) {
    return NextResponse.json<ApiError>(
      { code: 'VALIDATION_ERROR', message: 'Both left and right run IDs are required' },
      { status: 422 }
    )
  }

  try {
    const result = await getRunDiff(left, right)
    return NextResponse.json<GetDiffResponse>(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message.includes('not found') || message.includes('Not found')) {
      return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 })
    }
    return NextResponse.json<ApiError>({ code: 'INTERNAL_ERROR', message }, { status: 500 })
  }
}
