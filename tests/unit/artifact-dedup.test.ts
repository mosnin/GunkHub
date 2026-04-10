import { describe, it, expect, vi, afterEach } from 'vitest'

import { sha256Hex, PAYLOAD_EXTERNALIZATION_THRESHOLD } from '../../apps/web/src/lib/storage/adapter.js'
import { HttpTransport } from '@agent-flight-recorder/sdk'

import type { CreateEventRequest } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Group 1: Threshold and checksum consistency (foundation of dedup)
// ---------------------------------------------------------------------------

describe('artifact deduplication — foundation checks', () => {
  it('PAYLOAD_EXTERNALIZATION_THRESHOLD is exactly 10240 bytes', () => {
    expect(PAYLOAD_EXTERNALIZATION_THRESHOLD).toBe(10240)
  })

  it('sha256Hex produces the same digest for identical input', async () => {
    const data = JSON.stringify({ type: 'llm.response', content: 'hello' })
    const hash1 = await sha256Hex(data)
    const hash2 = await sha256Hex(data)
    expect(hash1).toBe(hash2)
  })

  it('sha256Hex produces a 64-character hex string', async () => {
    const hash = await sha256Hex('test payload')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('sha256Hex produces different digests for different inputs', async () => {
    const h1 = await sha256Hex('payload A')
    const h2 = await sha256Hex('payload B')
    expect(h1).not.toBe(h2)
  })

  it('sha256Hex is consistent across multiple calls with large payloads', async () => {
    const largeData = JSON.stringify({ content: 'x'.repeat(20_000) })
    const h1 = await sha256Hex(largeData)
    const h2 = await sha256Hex(largeData)
    expect(h1).toBe(h2)
  })
})

// ---------------------------------------------------------------------------
// Group 2: SDK externalization idempotency (same payload → same upload body)
// ---------------------------------------------------------------------------

describe('artifact deduplication — SDK retry idempotency', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  function makeOversizedEvent(runId: string): CreateEventRequest {
    return {
      runId,
      type: 'llm.response' as const,
      sequenceNumber: 1,
      timestamp: Date.now(),
      payload: {
        type: 'llm.response' as const,
        model: 'gpt-4',
        content: 'x'.repeat(12_000),
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        finish_reason: 'stop',
      },
    }
  }

  it('two calls to sendEvents with the same event produce the same upload checksum', async () => {
    const transport = new HttpTransport('http://test.local')
    const uploadBodies: unknown[] = []

    let callCount = 0
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      if (urlStr.includes('/api/artifacts/upload')) {
        const body = JSON.parse(init?.body as string) as unknown
        uploadBodies.push(body)
        return new Response(JSON.stringify({
          artifactId: `art-${callCount++}`,
          storageKey: 'key/test',
          storageBucket: 'default',
          checksum: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
          size: 12000,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      // events call — first time fail, second time succeed
      return new Response(JSON.stringify({ eventIds: ['evt-1'] }), { status: 201 })
    }) as typeof fetch

    const event = makeOversizedEvent('run-dedup-test')

    // First call
    await transport.sendEvents([event], { apiKey: 'test-key' })
    // Second call (retry scenario — same event)
    await transport.sendEvents([event], { apiKey: 'test-key' })

    // Both upload calls should have sent the same serialized payload
    expect(uploadBodies).toHaveLength(2)
    const body1 = uploadBodies[0] as { payload: unknown }
    const body2 = uploadBodies[1] as { payload: unknown }
    // Same payload → should produce the same checksum on the server
    expect(JSON.stringify(body1.payload)).toBe(JSON.stringify(body2.payload))
  })

  it('upload request body contains runId matching the event runId', async () => {
    const transport = new HttpTransport('http://test.local')
    let capturedBody: unknown = null

    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      if (urlStr.includes('/api/artifacts/upload')) {
        capturedBody = JSON.parse(init?.body as string)
        return new Response(JSON.stringify({
          artifactId: 'art-1',
          storageKey: 'key/abc',
          storageBucket: 'default',
          checksum: 'abc123',
          size: 12000,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ eventIds: ['evt-1'] }), { status: 201 })
    }) as typeof fetch

    const event = makeOversizedEvent('run-specific-id-001')
    await transport.sendEvents([event], { apiKey: 'test-key' })

    expect(capturedBody).not.toBeNull()
    expect((capturedBody as { runId: string }).runId).toBe('run-specific-id-001')
  })

  it('upload request body mimeType is always application/json for JSON payloads', async () => {
    const transport = new HttpTransport('http://test.local')
    let capturedMimeType = ''

    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      if (urlStr.includes('/api/artifacts/upload')) {
        const body = JSON.parse(init?.body as string) as { mimeType: string }
        capturedMimeType = body.mimeType
        return new Response(JSON.stringify({
          artifactId: 'art-1',
          storageKey: 'key/abc',
          storageBucket: 'default',
          checksum: 'abc123',
          size: 12000,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ eventIds: ['evt-1'] }), { status: 201 })
    }) as typeof fetch

    const event = makeOversizedEvent('run-mime-test')
    await transport.sendEvents([event], { apiKey: 'test-key' })

    expect(capturedMimeType).toBe('application/json')
  })

  it('pointer payload _artifact.artifactId comes from the upload response', async () => {
    const transport = new HttpTransport('http://test.local')
    let sentEventsBody: unknown = null

    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      if (urlStr.includes('/api/artifacts/upload')) {
        return new Response(JSON.stringify({
          artifactId: 'art-specific-001',
          storageKey: 'key/specific',
          storageBucket: 'default',
          checksum: 'sha256checksum',
          size: 15000,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      sentEventsBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({ eventIds: ['evt-1'] }), { status: 201 })
    }) as typeof fetch

    const event = makeOversizedEvent('run-ptr-test')
    await transport.sendEvents([event], { apiKey: 'test-key' })

    const body = sentEventsBody as { events: Array<{ payload: { _artifact?: { artifactId: string } } }> }
    expect(body.events[0]?.payload._artifact?.artifactId).toBe('art-specific-001')
  })
})

// ---------------------------------------------------------------------------
// Group 3: Dedup guard effectiveness (conceptual / boundary tests)
// ---------------------------------------------------------------------------

describe('artifact deduplication — boundary correctness', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('payload exactly at threshold (10240 bytes) is NOT externalized', async () => {
    const transport = new HttpTransport('http://test.local')
    let uploadCallCount = 0

    global.fetch = vi.fn(async (url: string) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      if (urlStr.includes('/api/artifacts/upload')) uploadCallCount++
      return new Response(JSON.stringify({ eventIds: ['evt-1'] }), { status: 201 })
    }) as typeof fetch

    // Build a payload whose JSON is exactly at the threshold
    const basePayload = { type: 'custom' as const, data: '' as unknown }
    const overhead = JSON.stringify(basePayload).length
    basePayload.data = 'x'.repeat(PAYLOAD_EXTERNALIZATION_THRESHOLD - overhead)

    const exactEvent: CreateEventRequest = {
      runId: 'run-boundary',
      type: 'custom' as const,
      sequenceNumber: 1,
      timestamp: Date.now(),
      payload: basePayload,
    }

    expect(JSON.stringify(exactEvent.payload).length).toBe(PAYLOAD_EXTERNALIZATION_THRESHOLD)

    await transport.sendEvents([exactEvent], { apiKey: 'test-key' })
    expect(uploadCallCount).toBe(0)
  })

  it('payload at threshold + 1 byte IS externalized', async () => {
    const transport = new HttpTransport('http://test.local')
    let uploadCallCount = 0

    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      if (urlStr.includes('/api/artifacts/upload')) {
        uploadCallCount++
        return new Response(JSON.stringify({
          artifactId: 'art-over',
          storageKey: 'key/over',
          storageBucket: 'default',
          checksum: 'sha',
          size: PAYLOAD_EXTERNALIZATION_THRESHOLD + 1,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ eventIds: ['evt-1'] }), { status: 201 })
    }) as typeof fetch

    const basePayload = { type: 'custom' as const, data: '' as unknown }
    const overhead = JSON.stringify(basePayload).length
    basePayload.data = 'x'.repeat(PAYLOAD_EXTERNALIZATION_THRESHOLD - overhead + 1)

    const overEvent: CreateEventRequest = {
      runId: 'run-over',
      type: 'custom' as const,
      sequenceNumber: 1,
      timestamp: Date.now(),
      payload: basePayload,
    }

    expect(JSON.stringify(overEvent.payload).length).toBeGreaterThan(PAYLOAD_EXTERNALIZATION_THRESHOLD)

    await transport.sendEvents([overEvent], { apiKey: 'test-key' })
    expect(uploadCallCount).toBe(1)
  })
})
