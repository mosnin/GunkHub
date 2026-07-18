import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, GetDiffResponse } from '@agent-flight-recorder/contracts'

import { withApiHandler } from '@/lib/apiHandler'
import { getRunDiff } from '@/lib/services/diff'

export const GET = withApiHandler('/api/diff', async (req: NextRequest, ctx) => {
  const { userId, orgId } = auth()
  if (!userId || !orgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 }
    )
  }
  ctx.setOrgId(orgId)

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
    const message = err instanceof Error ? err.message : ''
    if (message.includes('not found') || message.includes('Not found')) {
      return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 })
    }
    throw err
  }
})
