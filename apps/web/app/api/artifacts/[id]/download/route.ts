import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

interface RouteParams {
  params: { id: string }
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { userId } = auth()
  if (!userId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 }
    )
  }

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const artifact = await client.query(convex.artifacts.getArtifact, { artifactId: params.id })

    if (!artifact) {
      return NextResponse.json<ApiError>(
        { code: 'NOT_FOUND', message: 'Artifact not found' },
        { status: 404 }
      )
    }

    const rec = artifact as Record<string, unknown>
    const storageKey = rec['storageKey'] as string
    const mimeType = rec['mimeType'] as string
    const name = rec['name'] as string
    const size = rec['size'] as number

    const blobStoreUrl = process.env['BLOB_STORE_URL']
    if (!blobStoreUrl) {
      return NextResponse.json<ApiError>(
        { code: 'INTERNAL_ERROR', message: 'Blob storage not configured' },
        { status: 502 }
      )
    }

    const blobToken = process.env['BLOB_STORE_TOKEN']
    const blobUrl = `${blobStoreUrl}/${storageKey}`

    const blobRes = await fetch(blobUrl, {
      headers: blobToken ? { Authorization: `Bearer ${blobToken}` } : {},
    })

    if (!blobRes.ok) {
      return NextResponse.json<ApiError>(
        { code: 'BAD_GATEWAY', message: `Blob storage returned ${blobRes.status}` },
        { status: 502 }
      )
    }

    const safeFilename = name.replace(/"/g, '\\"')
    return new Response(blobRes.body, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Content-Length': String(size),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (
      message.toLowerCase().includes('not found') ||
      message.toLowerCase().includes('not a member') ||
      message.toLowerCase().includes('unauthorized')
    ) {
      return NextResponse.json<ApiError>(
        { code: 'NOT_FOUND', message: 'Artifact not found' },
        { status: 404 }
      )
    }
    return NextResponse.json<ApiError>(
      { code: 'INTERNAL_ERROR', message },
      { status: 500 }
    )
  }
}
