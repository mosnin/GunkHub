import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { ConvexTimeoutError, getAuthedClient, withConvexTimeout } from '@/lib/convexServer'
import { getRequestId, logger } from '@/lib/logger'

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

export async function DELETE(req: Request, { params }: RouteParams) {
  const requestId = getRequestId(req)
  const { userId, orgId: clerkOrgId } = auth()
  if (!userId || !clerkOrgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    )
  }

  try {
    const client = await getAuthedClient()
    await withConvexTimeout(convexMutation(client, convex.api_keys.revokeApiKey, {
      keyId: params.id,
    }))

    return NextResponse.json({ revoked: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message.toLowerCase().includes('not found')) {
      return NextResponse.json<ApiError>({ code: 'NOT_FOUND', message: 'API key not found' }, { status: 404 })
    }
    if (message.toLowerCase().includes('already revoked')) {
      return NextResponse.json<ApiError>({ code: 'CONFLICT', message: 'API key is already revoked' }, { status: 409 })
    }
    logger.error('API key revocation failed', {
      requestId,
      route: '/api/api-keys/[id]',
      orgId: clerkOrgId,
      err,
    })
    if (err instanceof ConvexTimeoutError) {
      return NextResponse.json<ApiError>(
        { code: 'SERVICE_UNAVAILABLE', message: `Backend unavailable (request ${requestId})` },
        { status: 503, headers: { 'x-request-id': requestId } },
      )
    }
    return NextResponse.json<ApiError>(
      { code: 'INTERNAL_ERROR', message: `${message} (request ${requestId})` },
      { status: 500, headers: { 'x-request-id': requestId } },
    )
  }
}
