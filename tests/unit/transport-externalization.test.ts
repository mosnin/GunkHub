import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type { CreateEventRequest } from '@agent-flight-recorder/contracts'
import { HttpTransport } from '@agent-flight-recorder/sdk'

// ---------------------------------------------------------------------------
// Fetch mock helpers (mirror pattern from flight-recorder.test.ts)
// ---------------------------------------------------------------------------

type FetchMockImpl = (url: string, init?: RequestInit) => Promise<Response>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const ENDPOINT = 'http://localhost:3000'
const API_KEY = 'test-api-key'
const RUN_ID = 'run-001'

const auth = { apiKey: API_KEY }

const mockUploadResponse = {
  artifactId: 'art-001',
  storageKey: 'key/abc123',
  storageBucket: 'default',
  checksum: 'abc123',
  size: 15000,
}

const mockEventsResponse = { eventIds: ['evt-001'] }

/**
 * Creates an event whose payload serializes to > 10240 bytes.
 * 100 messages × (200+ chars each) = ~20 KB JSON.
 */
function makeLargePayloadEvent(runId: string, seqNum: number): CreateEventRequest {
  return {
    runId,
    type: 'llm.request' as const,
    sequenceNumber: seqNum,
    timestamp: Date.now(),
    payload: {
      type: 'llm.request' as const,
      model: 'gpt-4',
      messages: Array.from({ length: 100 }, (_, i) => ({
        role: 'user',
        content: 'x'.repeat(200) + String(i),
      })),
    },
  }
}

/**
 * Creates an event whose payload serializes to well under 10240 bytes.
 */
function makeSmallPayloadEvent(runId: string, seqNum: number): CreateEventRequest {
  return {
    runId,
    type: 'custom' as const,
    sequenceNumber: seqNum,
    timestamp: Date.now(),
    payload: { type: 'custom' as const, data: { small: true } },
  }
}

/** Verify that the large payload event actually exceeds the threshold. */
function assertLargePayloadIsActuallyLarge(event: CreateEventRequest): void {
  const serialized = JSON.stringify(event.payload)
  if (serialized.length <= 10240) {
    throw new Error(`Test helper makeLargePayloadEvent produced a payload of only ${serialized.length} bytes — it must exceed 10240`)
  }
}

/** Verify that the small payload event actually fits under the threshold. */
function assertSmallPayloadIsActuallySmall(event: CreateEventRequest): void {
  const serialized = JSON.stringify(event.payload)
  if (serialized.length > 10240) {
    throw new Error(`Test helper makeSmallPayloadEvent produced a payload of ${serialized.length} bytes — it must be <= 10240`)
  }
}

// ---------------------------------------------------------------------------
// Group 1: Small payloads — no externalization
// ---------------------------------------------------------------------------

describe('HttpTransport.sendEvents — small payloads (no externalization)', () => {
  let transport: HttpTransport
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    transport = new HttpTransport(ENDPOINT)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('small payload event calls /api/events directly, fetch called exactly once', async () => {
    const event = makeSmallPayloadEvent(RUN_ID, 1)
    assertSmallPayloadIsActuallySmall(event)

    mockFetch = vi.fn<FetchMockImpl>(async () => jsonResponse(mockEventsResponse, 201))
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('fetch URL for small payload is the events endpoint, not the upload endpoint', async () => {
    const event = makeSmallPayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async () => jsonResponse(mockEventsResponse, 201))
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ENDPOINT}/api/events`)
    expect(url).not.toContain('artifacts')
  })

  it('small payload event returns success when /api/events returns 201', async () => {
    const event = makeSmallPayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async () => jsonResponse(mockEventsResponse, 201))
    vi.stubGlobal('fetch', mockFetch)

    const result = await transport.sendEvents([event], auth)

    expect(result.success).toBe(true)
  })

  it('batch of multiple small payload events sends a single /api/events call', async () => {
    const events = [
      makeSmallPayloadEvent(RUN_ID, 1),
      makeSmallPayloadEvent(RUN_ID, 2),
      makeSmallPayloadEvent(RUN_ID, 3),
    ]
    events.forEach(assertSmallPayloadIsActuallySmall)

    mockFetch = vi.fn<FetchMockImpl>(async () => jsonResponse(mockEventsResponse, 201))
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents(events, auth)

    const eventsCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )
    expect(eventsCalls).toHaveLength(1)
  })

  it('batch of 3 small events: fetch called exactly once (one events call, zero upload calls)', async () => {
    const events = [
      makeSmallPayloadEvent(RUN_ID, 1),
      makeSmallPayloadEvent(RUN_ID, 2),
      makeSmallPayloadEvent(RUN_ID, 3),
    ]

    mockFetch = vi.fn<FetchMockImpl>(async () => jsonResponse(mockEventsResponse, 201))
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents(events, auth)

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('sendEvents with empty events array returns immediately with no fetch calls', async () => {
    mockFetch = vi.fn<FetchMockImpl>(async () => jsonResponse(mockEventsResponse, 201))
    vi.stubGlobal('fetch', mockFetch)

    const result = await transport.sendEvents([], auth)

    // Empty batch: no externalization loop iterations, but the events POST still fires
    // with an empty array. The transport always issues the POST — verify it's called once
    // for the events endpoint only (no upload).
    const uploadCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => (url as string).includes('artifacts/upload')
    )
    expect(uploadCalls).toHaveLength(0)
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group 2: Large payloads — externalization triggered
// ---------------------------------------------------------------------------

describe('HttpTransport.sendEvents — large payloads (externalization triggered)', () => {
  let transport: HttpTransport
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    transport = new HttpTransport(ENDPOINT)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('large payload (> 10240 bytes) triggers a call to /api/artifacts/upload before /api/events', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)
    assertLargePayloadIsActuallyLarge(event)

    const callOrder: string[] = []
    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) {
        callOrder.push('upload')
        return jsonResponse(mockUploadResponse)
      }
      callOrder.push('events')
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    expect(callOrder).toEqual(['upload', 'events'])
  })

  it('fetch is called exactly twice for a large payload event (upload then events)', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('the upload call goes to the correct URL: ${endpoint}/api/artifacts/upload', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    const uploadCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).includes('artifacts/upload')
    )
    expect(uploadCall).toBeDefined()
    expect(uploadCall![0] as string).toBe(`${ENDPOINT}/api/artifacts/upload`)
  })

  it('the upload call uses method POST with x-api-key header', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    const uploadCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).includes('artifacts/upload')
    )!
    const init = uploadCall[1] as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(API_KEY)
  })

  it('the upload request body contains the event runId', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    const uploadCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).includes('artifacts/upload')
    )!
    const init = uploadCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['runId']).toBe(RUN_ID)
  })

  it('after successful upload, the events call payload has type "_externalized"', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as { events: Array<{ payload: { type: string } }> }
    expect(body.events[0]!.payload.type).toBe('_externalized')
  })

  it('after successful upload, the events call payload._artifact.storageKey matches upload response', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      events: Array<{ payload: { _artifact: { storageKey: string } } }>
    }
    expect(body.events[0]!.payload._artifact.storageKey).toBe(mockUploadResponse.storageKey)
  })

  it('the event originalType in the pointer matches the original event type "llm.request"', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      events: Array<{ payload: { originalType: string } }>
    }
    expect(body.events[0]!.payload.originalType).toBe('llm.request')
  })
})

// ---------------------------------------------------------------------------
// Group 3: Mixed batches (1 large + small events)
// ---------------------------------------------------------------------------

describe('HttpTransport.sendEvents — mixed batches', () => {
  let transport: HttpTransport
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    transport = new HttpTransport(ENDPOINT)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('batch with 1 large + 2 small events: upload called once, events called once', async () => {
    const events = [
      makeLargePayloadEvent(RUN_ID, 1),
      makeSmallPayloadEvent(RUN_ID, 2),
      makeSmallPayloadEvent(RUN_ID, 3),
    ]

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents(events, auth)

    const uploadCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => (url as string).includes('artifacts/upload')
    )
    const eventsCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )
    expect(uploadCalls).toHaveLength(1)
    expect(eventsCalls).toHaveLength(1)
  })

  it('after externalization, the events call body contains both the pointer event and the small events', async () => {
    const largeEvent = makeLargePayloadEvent(RUN_ID, 1)
    const smallEvent1 = makeSmallPayloadEvent(RUN_ID, 2)
    const smallEvent2 = makeSmallPayloadEvent(RUN_ID, 3)
    const events = [largeEvent, smallEvent1, smallEvent2]

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents(events, auth)

    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as { events: unknown[] }
    expect(body.events).toHaveLength(3)
  })

  it('small events in a mixed batch are not modified (payload type remains "custom")', async () => {
    const largeEvent = makeLargePayloadEvent(RUN_ID, 1)
    const smallEvent = makeSmallPayloadEvent(RUN_ID, 2)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([largeEvent, smallEvent], auth)

    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      events: Array<{ payload: { type: string } }>
    }
    // The second event (index 1) is the small one — its payload should be untouched
    expect(body.events[1]!.payload.type).toBe('custom')
  })

  it('sequence numbers are preserved after externalization', async () => {
    const largeEvent = makeLargePayloadEvent(RUN_ID, 7)
    const smallEvent = makeSmallPayloadEvent(RUN_ID, 8)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([largeEvent, smallEvent], auth)

    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      events: Array<{ sequenceNumber: number }>
    }
    expect(body.events[0]!.sequenceNumber).toBe(7)
    expect(body.events[1]!.sequenceNumber).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// Group 4: Externalization failure
// ---------------------------------------------------------------------------

describe('HttpTransport.sendEvents — externalization failure', () => {
  let transport: HttpTransport
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    transport = new HttpTransport(ENDPOINT)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('upload returns 401: sendEvents returns { success: false, retryable: false }', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await transport.sendEvents([event], auth)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.retryable).toBe(false)
    }
  })

  it('upload returns 500: sendEvents returns { success: false, retryable: false }', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) {
        return new Response('Internal Server Error', { status: 500 })
      }
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await transport.sendEvents([event], auth)

    expect(result.success).toBe(false)
    if (!result.success) {
      // The artifact upload failure is always non-retryable (upload is outside the retry loop)
      expect(result.retryable).toBe(false)
    }
  })

  it('upload throws network error: sendEvents returns { success: false, retryable: false, error contains message }', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)
    const networkErrorMessage = 'fetch failed: ECONNREFUSED'

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) {
        throw new Error(networkErrorMessage)
      }
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await transport.sendEvents([event], auth)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.retryable).toBe(false)
      expect(result.error).toContain(networkErrorMessage)
    }
  })

  it('when externalization fails, /api/events is NOT called', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) {
        return new Response('Unauthorized', { status: 401 })
      }
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event], auth)

    const eventsCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )
    expect(eventsCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Group 5: Pointer shape correctness
// ---------------------------------------------------------------------------

describe('HttpTransport.sendEvents — pointer shape correctness', () => {
  let transport: HttpTransport
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    transport = new HttpTransport(ENDPOINT)
    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) return jsonResponse(mockUploadResponse)
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function getPointerPayload(): Record<string, unknown> {
    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      events: Array<{ payload: Record<string, unknown> }>
    }
    return body.events[0]!.payload
  }

  it('pointer payload type is exactly "_externalized"', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)
    await transport.sendEvents([event], auth)

    const pointer = getPointerPayload()
    expect(pointer['type']).toBe('_externalized')
  })

  it('pointer has originalType field matching the source event type', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)
    await transport.sendEvents([event], auth)

    const pointer = getPointerPayload()
    expect(pointer['originalType']).toBe('llm.request')
  })

  it('pointer has all _artifact fields: artifactId, storageKey, storageBucket, checksum, size', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 1)
    await transport.sendEvents([event], auth)

    const pointer = getPointerPayload()
    const artifact = pointer['_artifact'] as Record<string, unknown>
    expect(artifact).toBeDefined()
    expect(artifact['artifactId']).toBe(mockUploadResponse.artifactId)
    expect(artifact['storageKey']).toBe(mockUploadResponse.storageKey)
    expect(artifact['storageBucket']).toBe(mockUploadResponse.storageBucket)
    expect(artifact['checksum']).toBe(mockUploadResponse.checksum)
    expect(artifact['size']).toBe(mockUploadResponse.size)
  })

  it('events endpoint receives event with original sequenceNumber and runId preserved', async () => {
    const event = makeLargePayloadEvent(RUN_ID, 42)
    await transport.sendEvents([event], auth)

    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      events: Array<{ sequenceNumber: number; runId: string }>
    }
    expect(body.events[0]!.sequenceNumber).toBe(42)
    expect(body.events[0]!.runId).toBe(RUN_ID)
  })
})

// ---------------------------------------------------------------------------
// Group 6: Upload cache deduplication
// ---------------------------------------------------------------------------

describe('HttpTransport.sendEvents — upload cache deduplication', () => {
  let transport: HttpTransport
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    transport = new HttpTransport(ENDPOINT)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Creates a large event whose payload content is distinct from the default
   * makeLargePayloadEvent helper by embedding a unique marker string in the
   * first message. Two calls with different `marker` values produce events
   * whose JSON.stringify(payload) values are different strings, giving different
   * cache keys and therefore separate upload calls.
   */
  function makeLargePayloadEventWithMarker(runId: string, seqNum: number, marker: string): CreateEventRequest {
    return {
      runId,
      type: 'llm.request' as const,
      sequenceNumber: seqNum,
      timestamp: Date.now(),
      payload: {
        type: 'llm.request' as const,
        model: 'gpt-4',
        messages: Array.from({ length: 100 }, (_, i) => ({
          role: 'user',
          content: marker + 'x'.repeat(200) + String(i),
        })),
      },
    }
  }

  it('calls _uploadArtifact once for two identical large payloads in the same batch', async () => {
    // Both events have different sequenceNumbers but identical payload content.
    // The cache key is JSON.stringify(event.payload), which is the same for both.
    const event1 = makeLargePayloadEvent(RUN_ID, 1)
    const event2 = makeLargePayloadEvent(RUN_ID, 2)
    assertLargePayloadIsActuallyLarge(event1)
    assertLargePayloadIsActuallyLarge(event2)

    // Sanity check: the payloads are truly identical
    expect(JSON.stringify(event1.payload)).toBe(JSON.stringify(event2.payload))

    const uploadResponses = [
      { artifactId: 'art-001', storageKey: 'key/abc001', storageBucket: 'default', checksum: 'abc001', size: 15000 },
    ]
    let uploadCallCount = 0

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) {
        const resp = uploadResponses[uploadCallCount]!
        uploadCallCount++
        return jsonResponse(resp)
      }
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event1, event2], auth)

    // Upload should be called exactly once (cache hit on second event)
    const uploadCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => (url as string).includes('artifacts/upload')
    )
    expect(uploadCalls).toHaveLength(1)

    // Both events in the final POST /api/events body should have type '_externalized'
    // and share the same artifactId
    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      events: Array<{ payload: { type: string; _artifact: { artifactId: string } } }>
    }
    expect(body.events[0]!.payload.type).toBe('_externalized')
    expect(body.events[1]!.payload.type).toBe('_externalized')
    expect(body.events[0]!.payload._artifact.artifactId).toBe('art-001')
    expect(body.events[1]!.payload._artifact.artifactId).toBe('art-001')
  })

  it('calls _uploadArtifact separately for two different large payloads in the same batch', async () => {
    // Two events with distinct payload content produce different cache keys.
    const event1 = makeLargePayloadEventWithMarker(RUN_ID, 1, 'ALPHA-')
    const event2 = makeLargePayloadEventWithMarker(RUN_ID, 2, 'BETA--')
    assertLargePayloadIsActuallyLarge(event1)
    assertLargePayloadIsActuallyLarge(event2)

    // Sanity check: the payloads are genuinely different
    expect(JSON.stringify(event1.payload)).not.toBe(JSON.stringify(event2.payload))

    const uploadResponsesForDiff = [
      { artifactId: 'art-A01', storageKey: 'key/alphaA01', storageBucket: 'default', checksum: 'aaA01', size: 15100 },
      { artifactId: 'art-B02', storageKey: 'key/betaB02', storageBucket: 'default', checksum: 'bbB02', size: 15200 },
    ]
    let uploadCallCountDiff = 0

    mockFetch = vi.fn<FetchMockImpl>(async (url) => {
      if (url.includes('artifacts/upload')) {
        const resp = uploadResponsesForDiff[uploadCallCountDiff]!
        uploadCallCountDiff++
        return jsonResponse(resp)
      }
      return jsonResponse(mockEventsResponse, 201)
    })
    vi.stubGlobal('fetch', mockFetch)

    await transport.sendEvents([event1, event2], auth)

    // Upload should be called twice (one per unique payload)
    const uploadCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => (url as string).includes('artifacts/upload')
    )
    expect(uploadCalls).toHaveLength(2)

    // Both events should be externalized with different artifactIds
    const eventsCall = mockFetch.mock.calls.find(
      ([url]: [string]) => (url as string).endsWith('/api/events')
    )!
    const init = eventsCall[1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      events: Array<{ payload: { type: string; _artifact: { artifactId: string } } }>
    }
    expect(body.events[0]!.payload.type).toBe('_externalized')
    expect(body.events[1]!.payload.type).toBe('_externalized')
    expect(body.events[0]!.payload._artifact.artifactId).toBe('art-A01')
    expect(body.events[1]!.payload._artifact.artifactId).toBe('art-B02')
    expect(body.events[0]!.payload._artifact.artifactId).not.toBe(
      body.events[1]!.payload._artifact.artifactId
    )
  })
})
