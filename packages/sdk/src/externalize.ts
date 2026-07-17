import { PAYLOAD_EXTERNALIZATION_THRESHOLD, PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '@agent-flight-recorder/contracts'

import type { EventType, ExternalizedPayload } from '@agent-flight-recorder/contracts'

/**
 * Artifact pointer returned by the upload endpoint. When an oversized payload is
 * externalized, these fields are embedded in the event's `ExternalizedPayload`
 * so the full payload can be re-fetched from blob storage later.
 */
export interface ArtifactPointer {
  artifactId: string
  storageKey: string
  storageBucket: string
  checksum: string
  size: number
}

/**
 * Minimal fetch shape shared by both the `HttpTransport` (timeout-wrapped) and
 * `RunRecorder` (plain fetch) code paths.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Uploads a single oversized event payload as an artifact.
 *
 * Both recorder paths (buffered `HttpTransport` and un-buffered `RunRecorder`)
 * MUST route large payloads through this function so the externalization
 * behavior — and the exact upload request shape the server expects — stays
 * identical regardless of which recorder the caller uses.
 *
 * Sends POST {baseUrl}/api/artifacts/upload with the raw payload JSON.
 *
 * @param doFetch - fetch implementation (may wrap a timeout)
 * @param baseUrl - API base URL (no trailing slash)
 * @param apiKey - API key sent as the x-api-key header
 * @param runId - the run this event belongs to
 * @param eventType - the original event type string (used for the artifact name)
 * @param serializedPayload - already-serialized JSON string of the event payload
 * @returns the artifact pointer fields
 * @throws Error if the upload request fails (non-2xx) or the network is unreachable
 */
export async function uploadArtifact(
  doFetch: FetchLike,
  baseUrl: string,
  apiKey: string,
  runId: string,
  eventType: string,
  serializedPayload: string,
): Promise<ArtifactPointer> {
  const url = `${baseUrl}/api/artifacts/upload`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
  }

  const response = await doFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      runId,
      name: `${eventType.replace('.', '-')}.payload.json`,
      mimeType: 'application/json',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse of our own serialized payload
      payload: JSON.parse(serializedPayload),
    }),
  })

  if (!response.ok) {
    let body = ''
    try {
      body = await response.text()
    } catch {
      // ignore parse failure
    }
    throw new Error(`HTTP ${response.status}: ${body}`)
  }

  return (await response.json()) as ArtifactPointer
}

/**
 * Measures the UTF-8 byte length of a serialized payload.
 *
 * `string.length` counts UTF-16 code units and undercounts multi-byte
 * characters, so a payload that is >10 KB on the wire (and in the Convex
 * document store, which the server rejects) could slip under the threshold and
 * never externalize. `TextEncoder` gives the true byte length.
 */
export function payloadByteLength(serialized: string): number {
  return new TextEncoder().encode(serialized).length
}

/**
 * If the serialized payload exceeds {@link PAYLOAD_EXTERNALIZATION_THRESHOLD}
 * bytes, uploads it as an artifact and returns an `ExternalizedPayload` pointer;
 * otherwise returns the original payload unchanged.
 *
 * This is the single source of truth for the "is this payload too big to ship
 * inline?" decision. Both recorder paths call it so neither can regress into
 * shipping an oversized payload that the server 413's.
 *
 * @param runId - run the event belongs to
 * @param type - the event type string
 * @param payload - the event payload (any JSON-serializable value)
 * @param upload - closure that performs the artifact upload and returns a pointer
 * @param cache - optional per-batch cache keyed by serialized payload, avoiding
 *   duplicate uploads of identical payloads within a single batch
 * @returns the original payload, or an `ExternalizedPayload` pointer if it was too large
 * @throws whatever `upload` throws (surfaced to the caller — never swallowed here)
 */
export async function externalizePayloadIfLarge<T>(
  runId: string,
  type: string,
  payload: T,
  upload: (runId: string, eventType: string, serializedPayload: string) => Promise<ArtifactPointer>,
  cache?: Map<string, ArtifactPointer>,
): Promise<T | ExternalizedPayload> {
  const serialized = JSON.stringify(payload)
  if (payloadByteLength(serialized) <= PAYLOAD_EXTERNALIZATION_THRESHOLD) {
    return payload
  }

  const cached = cache?.get(serialized)
  const pointer = cached ?? (await upload(runId, type, serialized))
  if (cache && !cached) cache.set(serialized, pointer)

  return {
    type: '_externalized',
    originalType: type as EventType,
    _artifact: pointer,
  } satisfies ExternalizedPayload
}
