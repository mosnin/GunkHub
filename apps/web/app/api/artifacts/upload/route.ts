/**
 * POST /api/artifacts/upload — externalize a large event payload to blob storage.
 *
 * Called by the SDK before shipping an event whose payload exceeds 10 KB.
 * The SDK uploads the payload here, receives an ArtifactPointer in response,
 * and then ships a compact event with the pointer in the payload instead.
 *
 * Authentication: x-api-key header (same as /api/events).
 *
 * Request body (JSON):
 *   {
 *     runId: string,
 *     eventId?: string,        // set if the artifact belongs to a specific event
 *     name: string,            // e.g. "llm.request.payload.json"
 *     mimeType: string,        // e.g. "application/json"
 *     payload: unknown,        // full payload to externalize (JSON-stringified before upload)
 *   }
 *
 * Response (201):
 *   {
 *     artifactId: string,
 *     storageKey: string,
 *     storageBucket: string,
 *     checksum: string,
 *     size: number,
 *   }
 */
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getPublicClient, hashApiKey } from '@/lib/convexServer'
import { PAYLOAD_EXTERNALIZATION_THRESHOLD, getStorageAdapter, sha256Hex } from '@/lib/storage'

export async function POST(req: NextRequest) {
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

  const runId = body['runId']
  const name = body['name']
  const mimeType = body['mimeType']
  const payload = body['payload']

  if (!runId || typeof runId !== 'string') {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'runId is required' }, { status: 422 })
  }
  if (!name || typeof name !== 'string') {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'name is required' }, { status: 422 })
  }
  if (!mimeType || typeof mimeType !== 'string') {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'mimeType is required' }, { status: 422 })
  }
  if (payload === undefined || payload === null) {
    return NextResponse.json<ApiError>({ code: 'VALIDATION_ERROR', message: 'payload is required' }, { status: 422 })
  }

  const eventId = typeof body['eventId'] === 'string' ? body['eventId'] : undefined

  const serialized = JSON.stringify(payload)

  // Only externalize genuinely large payloads — reject under-threshold uploads.
  if (serialized.length < PAYLOAD_EXTERNALIZATION_THRESHOLD) {
    return NextResponse.json<ApiError>(
      {
        code: 'VALIDATION_ERROR',
        message: `Payload is ${String(serialized.length)} bytes — below the 10 KB threshold. Ship this payload inline in the event.`,
      },
      { status: 422 }
    )
  }

  const apiKeyHash = hashApiKey(apiKey)
  const client = getPublicClient()
  const adapter = getStorageAdapter()

  // AUTHENTICATE BEFORE touching blob storage. Previously the payload was written
  // to blob storage first and the key validated only afterward (by sdkCreateArtifact),
  // so any caller sending a bogus x-api-key could write arbitrary blobs. This
  // read-only check verifies the key (existence/revocation/expiration/scope) and
  // that it owns the run, throwing before a single byte is uploaded.
  try {
    await client.query(convex.sdk_ingest.checkIngestAuth, { apiKeyHash, runId })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unauthorized'
    const status = message.includes('Run not found') ? 404 : 401
    return NextResponse.json<ApiError>(
      { code: status === 404 ? 'NOT_FOUND' : 'UNAUTHORIZED', message },
      { status },
    )
  }

  const checksum = await sha256Hex(serialized)
  // Key format: <apiKeyPrefix>/<runId>/<checksumPrefix>-<name>
  const storageKey = `${apiKeyHash.slice(0, 8)}/${runId}/${checksum.slice(0, 16)}-${name}`
  const storageBucket = 'default'

  try {
    await adapter.upload(storageKey, serialized, mimeType)

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const artifact = await client.mutation(convex.sdk_ingest.sdkCreateArtifact, {
      apiKeyHash,
      runId,
      name,
      mimeType,
      size: serialized.length,
      storageKey,
      storageBucket,
      checksum,
      ...(eventId !== undefined && { eventId }),
    })

    const doc = artifact as Record<string, unknown>
    return NextResponse.json(
      {
        artifactId: (doc['_id'] ?? doc['id']) as string,
        storageKey,
        storageBucket,
        checksum,
        size: serialized.length,
      },
      { status: 201 }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message === 'Unauthorized' || message === 'Run not found') {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Invalid API key or run not found' },
        { status: 401 }
      )
    }
    return NextResponse.json<ApiError>({ code: 'INTERNAL_ERROR', message }, { status: 500 })
  }
}
