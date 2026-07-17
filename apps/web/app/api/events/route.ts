import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import {
  ConvexTimeoutError,
  getPublicClient,
  hashApiKey,
  withConvexTimeout,
} from '@/lib/convexServer'
import { getRequestId, logger } from '@/lib/logger'
import { PAYLOAD_EXTERNALIZATION_THRESHOLD } from '@/lib/storage'

// POST /api/events — batch append events from the SDK (x-api-key auth)
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req)
  const apiKey = req.headers.get('x-api-key')
  if (!apiKey) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'API key required' },
      { status: 401 }
    )
  }

  let body: Record<string, unknown>
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    body = await req.json()
  } catch {
    return NextResponse.json<ApiError>(
      { code: 'BAD_REQUEST', message: 'Invalid JSON body' },
      { status: 400 }
    )
  }

  const events = body['events']
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json<ApiError>(
      { code: 'VALIDATION_ERROR', message: 'events must be a non-empty array' },
      { status: 422 }
    )
  }

  // Validate required fields
  for (const evt of events as Record<string, unknown>[]) {
    if (!evt['runId']) return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'Each event must have runId' }, { status: 422 })
    if (!evt['type']) return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'Each event must have type' }, { status: 422 })
    if (evt['sequenceNumber'] == null) return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'Each event must have sequenceNumber' }, { status: 422 })
    if (evt['timestamp'] == null) return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'Each event must have timestamp' }, { status: 422 })
    if (evt['payload'] == null) return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'Each event must have payload' }, { status: 422 })
  }

  for (const evt of events as Record<string, unknown>[]) {
    const payloadJson = JSON.stringify(evt['payload'])
    if (payloadJson.length > PAYLOAD_EXTERNALIZATION_THRESHOLD) {
      return NextResponse.json<ApiError>(
        {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Event payload at sequenceNumber ${String(evt['sequenceNumber'])} exceeds the 10 KB limit (${String(payloadJson.length)} bytes). Externalize large payloads as artifacts before shipping events.`,
        },
        { status: 413 }
      )
    }
  }

  try {
    const client = getPublicClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await withConvexTimeout(client.mutation(convex.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: hashApiKey(apiKey),
      events: (events as Record<string, unknown>[]).map((evt) => ({
        runId: evt['runId'] as string,
        type: evt['type'] as string,
        sequenceNumber: evt['sequenceNumber'] as number,
        timestamp: evt['timestamp'] as number,
        payload: evt['payload'],
        ...(evt['parentEventId'] !== undefined && { parentEventId: evt['parentEventId'] as string }),
      })),
    }))

    const res = result as { eventIds: string[] }
    return NextResponse.json({ eventIds: res.eventIds }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message === 'Unauthorized') {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Invalid API key' },
        { status: 401 }
      )
    }
    logger.error('Event ingestion failed', { requestId, route: '/api/events', err })
    if (err instanceof ConvexTimeoutError) {
      return NextResponse.json<ApiError>(
        { code: 'SERVICE_UNAVAILABLE', message: `Backend unavailable (request ${requestId})` },
        { status: 503, headers: { 'x-request-id': requestId } }
      )
    }
    return NextResponse.json<ApiError>(
      { code: 'INTERNAL_ERROR', message: `${message} (request ${requestId})` },
      { status: 500, headers: { 'x-request-id': requestId } }
    )
  }
}
