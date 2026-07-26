import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { withApiHandler } from '@/lib/apiHandler'
import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, withConvexTimeout } from '@/lib/convexServer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConvexArgs = Record<string, any>

async function convexMutation(
  client: Awaited<ReturnType<typeof getAuthedClient>>,
  fn: Parameters<typeof client.mutation>[0],
  args: ConvexArgs,
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return client.mutation(fn, args)
}

interface RouteParams {
  params: { id: string }
}

export const DELETE = withApiHandler(
  '/api/api-keys/[id]',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const { userId, orgId: clerkOrgId } = auth()
    if (!userId || !clerkOrgId) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    ctx.setOrgId(clerkOrgId)

    try {
      const client = await getAuthedClient()
      await withConvexTimeout(convexMutation(client, convex.api_keys.revokeApiKey, {
        keyId: params.id,
      }))

      return NextResponse.json({ revoked: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (message.toLowerCase().includes('not found')) {
        return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'API key not found' }, { status: 404 })
      }
      if (message.toLowerCase().includes('already revoked')) {
        return NextResponse.json<ApiError>({ code: 'CONFLICT', message: 'API key is already revoked' }, { status: 409 })
      }
      throw err
    }
  }
)
